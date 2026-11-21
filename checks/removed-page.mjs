import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const pins = {
  'embedDocs.ts': '67c13c69c0e4c8c7318207107c08146ac8e79934',
  'chunking.ts': 'ae9cfdb3eb40cbdd59d9449f6a8d4965f300a70b',
};
const files = new Map();
for (const [name, hash] of Object.entries(pins)) {
  const raw = await readFile(new URL('./inputs/' + name, import.meta.url));
  assert.equal(createHash('sha1').update('blob ' + raw.length + '\0').update(raw).digest('hex'), hash);
  files.set(name, raw.toString());
}
// Only imports and command entrypoint are adapted. Upstream ingestion and
// chunking functions, write/update strategy, and identifiers execute unchanged.
const ingest = files.get('embedDocs.ts').replace(/^import .*;\s*$/gm, '');
const chunk = files.get('chunking.ts').replace('export function chunkMarkdown', 'function chunkMarkdown');
const source = stripTypeScriptTypes(chunk + '\n' + ingest.slice(0, ingest.lastIndexOf('main().catch(')) + '\nmain();');
const root = await mkdtemp(join(tmpdir(), 'wiki-index-replay-'));
const docs = join(root, 'docs');
await mkdir(docs);
const rows = new Map();
const dimensions = 1536;
class MockEmbeddings {
  embeddings = {
    create: async ({input}) => ({data: input.map(() => ({embedding: Array(dimensions).fill(0)}))}),
  };
}
const fakeStorage = {
  from(table) {
    assert.equal(table, 'docs_embeddings');
    return {
      async upsert(batch, options) {
        assert.equal(options.onConflict, 'id');
        for (const row of batch) rows.set(row.id, row);
        return {error: null};
      },
    };
  },
};
const sandbox = {
  join, relative, readdir, readFile, uuidv4: randomUUID,
  createClient: () => fakeStorage, OpenAI: MockEmbeddings, dotenv: {config() {}},
  process: {cwd: () => root, env: {OPENAI_API_KEY: 'fixture', SUPABASE_URL: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture'}},
  console: {log() {}, error: console.error},
};
const script = new vm.Script(source);
const history = [];
async function refresh(label) {
  await script.runInNewContext({...sandbox}, {timeout: 1000});
  history.push({
    label, rowCount: rows.size,
    additionalRowsSharingAPagePath: rows.size - new Set([...rows.values()].map(r => r.metadata.path)).size,
    originalRevision: [...rows.values()].some(r => r.content === 'Alpha edition of the guide.'),
    currentRevision: [...rows.values()].some(r => r.content === 'Beta edition of the guide.'),
    retiredPageCopies: [...rows.values()].filter(r => r.metadata.path === 'retired.md').length,
  });
}
try {
  await writeFile(join(docs,'guide.md'),'Alpha edition of the guide.');
  await writeFile(join(docs,'retired.md'),'This guide will be removed.');
  await refresh('initial');
  await refresh('unchanged');
  await writeFile(join(docs,'guide.md'),'Beta edition of the guide.');
  await rm(join(docs,'retired.md'));
  await refresh('edit one page, remove one page');
  assert.deepEqual(history.map(x => x.rowCount), [2,4,5]);
  const final = history.at(-1);
  assert.equal(final.originalRevision && final.currentRevision, true);
  assert.equal(final.retiredPageCopies, 2);
  console.log(JSON.stringify({
    runtime: process.version, pinnedUpstream: 'b5acf9822d4201ff4fed7011d75d76058750679c',
    fixtureResult: 'PASS reproduced old and removed rows', embeddingService:'mock', storage:'mock primary-key upsert',
    liveDatabaseQueried:false, history,
  }, null, 2));
} finally { await rm(root,{recursive:true,force:true}); }

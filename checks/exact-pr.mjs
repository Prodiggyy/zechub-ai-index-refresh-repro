import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import vm from 'node:vm';

const firstParent = '42ca5e16d157a1917bf7de73324bd4ae2c69443c';
const merge = '8a8ba57a862cb3bb5227e58ff6e951907714d2e6';
const pages = [
  {
    path: 'Start_Here/Who_Can_See_Your_Zcash_Payment.md',
    before: '947237dcd844ddae11077fa7a5f8d050ed17928d',
    after: '51e65916f2c7cf08e42daaf4375cfd425adedf4a',
    withdrawn: 'or [Ywallet](https://ywallet.app/)',
    replacement: 'or [Zingo!](https://www.zingolabs.org/)',
  },
  {
    path: 'Using_Zcash/Mobile_Top_Ups.md',
    before: '02a80226d9ddea5598b731119d84c9f796ad0855',
    after: '9edd730f58623dee893c6ab578781fc7aaae1862',
    withdrawn: 'add your YWallet address',
    replacement: 'add your own shielded address',
  },
  {
    path: 'Zcash_Social_Media/Zcash_Addresses.md',
    before: '4d33e74b6da7012651049ef2a2bf6457ff279557',
    after: '121ee429fa2d93fe5c6db0880aa3157cd097a042',
    withdrawn: 'Try the latest version of **YWallet**!',
    replacement: 'Pick a maintained wallet from the',
  },
];

async function readVerified(name, expectedBlob) {
  const data = await readFile(new URL('./inputs/' + name, import.meta.url));
  const blob = createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex');
  assert.equal(blob, expectedBlob, 'Unexpected Git blob for ' + name);
  return data.toString('utf8');
}

const importer = await readVerified('embedDocs.ts', '67c13c69c0e4c8c7318207107c08146ac8e79934');
const chunker = await readVerified('chunking.ts', 'ae9cfdb3eb40cbdd59d9449f6a8d4965f300a70b');
const mainCall = importer.lastIndexOf('main().catch(');
assert.ok(mainCall > 0);
const source = [
  chunker.replace('export function chunkMarkdown', 'function chunkMarkdown'),
  importer.slice(0, mainCall).replace(/^import .*;$/gm, ''),
  'main();',
].join('\n');
const runImporter = new vm.Script(stripTypeScriptTypes(source));
const root = await mkdtemp(join(tmpdir(), 'zechub-pr2013-'));

async function setPages(revision) {
  for (const page of pages) {
    const name = 'pr2013-' + revision + '-' + basename(page.path);
    const content = await readVerified(name, page[revision]);
    const oldVersion = revision === 'before';
    assert.equal(content.includes(page.withdrawn), oldVersion, name + ' withdrawn source text');
    assert.equal(content.includes(page.replacement), !oldVersion, name + ' replacement source text');
    const path = join(root, 'docs', 'zechub', page.path);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, content);
  }
}

async function refresh(index) {
  class LocalEmbeddings {
    embeddings = {
      async create({input, dimensions}) {
        return {data: input.map(() => ({embedding: Array(dimensions).fill(0)}))};
      },
    };
  }
  const client = {
    from(table) {
      assert.equal(table, 'docs_embeddings');
      return {
        async upsert(rows, {onConflict}) {
          assert.equal(onConflict, 'id');
          for (const row of rows) index.set(row.id, {path: row.metadata.path, text: row.content});
          return {error: null};
        },
      };
    },
  };
  await runImporter.runInNewContext({
    readdir, readFile, join, relative, uuidv4: randomUUID,
    createClient: () => client, OpenAI: LocalEmbeddings, dotenv: {config() {}},
    console: {log() {}, error: console.error},
    process: {cwd: () => root, env: {OPENAI_API_KEY: 'fixture', SUPABASE_URL: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture'}},
  });
}

function measure(index) {
  const byPage = {};
  let withdrawn = 0;
  let replacement = 0;
  for (const fixture of pages) {
    const pageRows = Array.from(index.values()).filter(row => row.path === join('zechub', fixture.path));
    const tally = {
      rows: pageRows.length,
      withdrawn: pageRows.filter(row => row.text.includes(fixture.withdrawn)).length,
      replacement: pageRows.filter(row => row.text.includes(fixture.replacement)).length,
    };
    byPage['site/' + fixture.path] = tally;
    withdrawn += tally.withdrawn;
    replacement += tally.replacement;
  }
  return {rows: index.size, withdrawn, replacement, byPage};
}

try {
  const live = new Map();
  const clean = new Map();
  await setPages('before');
  await refresh(live);
  const firstParentIndex = measure(live);
  await setPages('after');
  await refresh(live);
  const afterMergeRefresh = measure(live);
  await refresh(live);
  const afterUnchangedRepeat = measure(live);
  await refresh(clean);
  const cleanMergeIndex = measure(clean);
  for (const page of Object.keys(firstParentIndex.byPage)) {
    const values = item => [item.byPage[page].withdrawn, item.byPage[page].replacement];
    assert.deepEqual(values(firstParentIndex), [1, 0]);
    assert.deepEqual(values(afterMergeRefresh), [1, 1]);
    assert.deepEqual(values(afterUnchangedRepeat), [1, 2]);
    assert.deepEqual(values(cleanMergeIndex), [0, 1]);
    assert.equal(afterMergeRefresh.byPage[page].rows, firstParentIndex.byPage[page].rows + cleanMergeIndex.byPage[page].rows);
  }
  assert.equal(afterUnchangedRepeat.rows, afterMergeRefresh.rows + cleanMergeIndex.rows);
  console.log(JSON.stringify({
    result: 'PASS',
    meaning: 'Exact before/after source correction reproduced for three files touched by PR #2013',
    repository: 'ZecHub/zechub',
    pullRequest: 2013,
    mergeDate: '2026-09-06',
    firstParent, merge,
    changedFilesInPullRequest: 16,
    pagesTested: pages.length,
    importerRepository: 'hyperlander/zechubai',
    importerRevision: 'b5acf9822d4201ff4fed7011d75d76058750679c',
    results: {firstParentIndex, afterMergeRefresh, afterUnchangedRepeat, cleanMergeIndex},
    scope: 'Rows matched by literal text within each original page. The published importer and chunker ran locally. Embeddings were stubbed and table writes keyed by ID were simulated. No hosted index, retrieval ranking or AI response was tested.',
  }, null, 2));
} finally {
  await rm(root, {recursive: true, force: true});
}

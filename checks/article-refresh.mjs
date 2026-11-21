import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const pins = {
  'embedDocs.ts': '67c13c69c0e4c8c7318207107c08146ac8e79934',
  'chunking.ts': 'ae9cfdb3eb40cbdd59d9449f6a8d4965f300a70b',
  'old-Transactions.md': '27f2ab5eea8e82bf6cfcfcf6ef429a3dc041e8d8',
  'new-Transactions.md': '0011f64a59625d963c9575eb46d9f5e22a9b5c42',
  'old-Mobile_Top_Ups.md': '192cf269be36fcf64121e668ea5e2a2cc1730cf3',
  'new-Mobile_Top_Ups.md': '5fb72f0427c9f85b0b4703bcd5100be1fc15ec69',
};
const inputs = {};
for (const [name, expected] of Object.entries(pins)) {
  const file = await readFile(new URL('./inputs/' + name, import.meta.url));
  assert.equal(createHash('sha1').update('blob ' + file.length + '\0').update(file).digest('hex'), expected);
  inputs[name] = file.toString();
}
const chunking = inputs['chunking.ts'].replace('export function chunkMarkdown', 'function chunkMarkdown');
const ingestion = inputs['embedDocs.ts'].replace(/^import .*;\s*$/gm, '');
const script = new vm.Script(stripTypeScriptTypes(chunking + '\n' + ingestion.slice(0, ingestion.lastIndexOf('main().catch(')) + '\nmain();'));
const root = await mkdtemp(join(tmpdir(), 'wiki-corrections-'));
const docRoot = join(root, 'docs', 'zechub', 'Using_Zcash');
await mkdir(docRoot, {recursive: true});
const db = new DatabaseSync(':memory:');
const tables = ['live', 'clear_rebuild', 'staging'];
for (const t of tables) db.exec('CREATE TABLE ' + t + ' (id TEXT PRIMARY KEY, path TEXT NOT NULL, content TEXT NOT NULL)');
const assignments = {
  obsoleteAutoshield: 'you need to use YWallet and autoshield',
  obsoleteMemo: 'add your YWallet address in case there will be a refund',
  replacementAutoshield: 'a wallet that supports the current Zcash network',
  replacementMemo: 'Do not rely on the memo field for refunds',
};
function measure(table) {
  assert.ok(tables.includes(table));
  const result = {rows: db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n};
  for (const [k, marker] of Object.entries(assignments)) {
    result[k] = db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE instr(content, ?) > 0').get(marker).n;
  }
  return result;
}
async function syncSource(which) {
  for (const name of ['Transactions.md','Mobile_Top_Ups.md']) {
    await writeFile(join(docRoot, name), inputs[which + '-' + name]);
  }
}
// The upstream importer uses directory enumeration order. Fix that fixture input
// so interrupting the second batch is repeatable across operating systems.
async function fixtureReaddir(dir, options) {
  const entries = await readdir(dir, options);
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
async function index(table, failOnBatch = Infinity) {
  assert.ok(tables.includes(table));
  let calls = 0;
  class StubEmbeddings {
    embeddings = {create: async ({input, dimensions}) => {
      if (++calls === failOnBatch) throw new Error('fixture embed service outage');
      return {data: input.map(() => ({embedding: Array(dimensions).fill(0)}))};
    }};
  }
  const write = db.prepare('INSERT INTO ' + table + ' VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET path=excluded.path, content=excluded.content');
  const client = {from(name) {
    assert.equal(name, 'docs_embeddings');
    return {upsert: async (rows, options) => {
      assert.equal(options.onConflict, 'id');
      for (const row of rows) write.run(row.id, row.metadata.path, row.content);
      return {error: null};
    }};
  }};
  await script.runInNewContext({
    join, relative, readdir: fixtureReaddir, readFile, uuidv4: randomUUID,
    createClient: () => client, OpenAI: StubEmbeddings, dotenv: {config() {}},
    process: {cwd: () => root, env: {OPENAI_API_KEY: 'test', SUPABASE_URL: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test'}},
    console: {log() {}, error: console.error},
  });
  return calls;
}
const report = {};
try {
  await syncSource('old');
  await index('live');
  report.oldOnly = measure('live');
  await syncSource('new');
  await index('live');
  report.documentedRefresh = measure('live');
  // Clear in place and run the same documented ingestion again.
  await index('clear_rebuild');
  report.cleanRebuildSuccess = measure('clear_rebuild');
  db.exec('DELETE FROM clear_rebuild');
  await assert.rejects(index('clear_rebuild', 2), /fixture embed service outage/);
  report.clearInPlaceFailure = measure('clear_rebuild');
  // Provider-independent alternative: keep current snapshot live, build another
  // version out of band, and switch only on success; simulate atomic pointer.
  let pointer = 'live';
  db.exec('DELETE FROM live');
  await syncSource('old');
  await index('live');
  await syncSource('new');
  await assert.rejects(index('staging', 2), /fixture embed service outage/);
  report.stagedFailureStillServing = measure(pointer);
  db.exec('DELETE FROM staging');
  await index('staging');
  pointer = 'staging';
  report.stagedSuccessNowServing = measure(pointer);
  for (const key of ['obsoleteAutoshield','obsoleteMemo']) {
    assert.equal(report.oldOnly[key], 1);
    assert.equal(report.documentedRefresh[key], 1);
    assert.equal(report.cleanRebuildSuccess[key], 0);
    assert.equal(report.stagedSuccessNowServing[key], 0);
  }
  for (const key of ['replacementAutoshield','replacementMemo']) {
    assert.equal(report.oldOnly[key], 0);
    assert.equal(report.documentedRefresh[key], 1);
    assert.equal(report.cleanRebuildSuccess[key], 1);
    assert.equal(report.stagedSuccessNowServing[key], 1);
  }
  assert.deepEqual(report.cleanRebuildSuccess, report.stagedSuccessNowServing);
  assert.deepEqual(report.stagedFailureStillServing, report.oldOnly);
  assert.ok(report.clearInPlaceFailure.rows < report.cleanRebuildSuccess.rows);
  console.log(JSON.stringify({
    evidence: 'Full Git-verified public documents and original indexing code. SQLite emulates public ID-keyed writes, vectors are stubbed. Counts exact text-matching rows; no semantic ranking, hosted database, or model answer was tested.',
    originalRepository: 'hyperlander/zechubai@b5acf9822d4201ff4fed7011d75d76058750679c',
    correctedRepository: 'ZecHub/zechub@0e11df443300c38abc727ffd0c0133d41d99cefd',
    pins, results: report,
  }, null, 2));
} finally { db.close(); await rm(root, {recursive: true, force: true}); }

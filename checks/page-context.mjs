import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';

async function pinnedFile(name, sha) {
  const bytes = await readFile(new URL('./inputs/' + name, import.meta.url));
  const id = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(id, sha, 'Unexpected Git blob: ' + name);
  return bytes.toString();
}

const [reader, ui, route, rpc] = await Promise.all([
  pinnedFile('vectorSearch.ts', 'd3a2f32fdd2feb1904c17bbc03dcfba5bb0b03b3'),
  pinnedFile('AIAssistant.tsx', '3436fda4fffaa069b057a10c8d34e2bb2976c5a5'),
  pinnedFile('wiki-ai-route.ts', '08b94662432aed8064950f5c0f8e9c699a63c293'),
  pinnedFile('fix_ivfflat.sql', 'f3e92dd2de35343fc51cc35e80a246d5eafb858e'),
]);
assert.match(ui, /pageUrl:\s*typeof window !== "undefined" \? window.location.href : undefined/);
const readerBody = reader.slice(reader.indexOf('const DEFAULT_TOP_K')).replace(/^export /gm, '');
const readerScript = new vm.Script(stripTypeScriptTypes(readerBody) + '\nsearchDocs;');
const routeHelpers = route.slice(route.indexOf('function pathToWikiUrl'), route.indexOf('export async function'));
const sourceLinks = new vm.Script(stripTypeScriptTypes(routeHelpers) + '\nbuildSourceLinks;').runInNewContext();

// Execute the upstream page filter in SQLite. Only the PL/pgSQL parameter is
// rebound. Synthetic identical unit vectors make all similarities exactly 1.
const predicate = /FROM public\.docs_embeddings de\s+(WHERE\b[\s\S]*?)\s+ORDER BY de\.embedding/i.exec(rpc)?.[1];
assert.ok(predicate, 'Upstream SQL page predicate missing');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE docs_embeddings (id TEXT PRIMARY KEY, content TEXT, metadata TEXT)');
const matchPage = db.prepare('SELECT de.* FROM docs_embeddings de ' +
  predicate.replace(/\bmatch_path\b/g, '$page') + ' ORDER BY de.id LIMIT $max');
const insert = db.prepare('INSERT INTO docs_embeddings VALUES (?, ?, ?)');
const vector = Array(1536).fill(0);
vector[0] = 1;
const base = 'https://zechub.wiki/';
const documents = {
  tx: {slug: 'using-zcash/transactions', source: 'zechub/Using_Zcash/Transactions.md'},
  mobile: {slug: 'using-zcash/mobile-top-ups', source: 'zechub/Using_Zcash/Mobile_Top_Ups.md'},
};
function publish(generation, metadataOf) {
  db.exec('DELETE FROM docs_embeddings');
  for (const [name, doc] of Object.entries(documents)) {
    insert.run(generation + '-' + name, name + ' fixture content', JSON.stringify(metadataOf(doc)));
  }
}
let lastPath;
let usedFallback;
function decode(row) {
  return {...row, metadata: JSON.parse(row.metadata), embedding: vector, similarity: 1};
}
const service = {
  from(table) {
    assert.equal(table, 'docs_embeddings');
    return {select(columns) {
      if (columns === 'id, embedding') {
        return {range: async () => ({data: db.prepare('SELECT * FROM docs_embeddings').all().map(decode)})};
      }
      assert.equal(columns, 'id, content, metadata');
      return {in: async (column, ids) => {
        assert.equal(column, 'id');
        return {data: db.prepare('SELECT * FROM docs_embeddings').all().filter(row => ids.includes(row.id)).map(decode)};
      }};
    }};
  },
  async rpc(name, input) {
    assert.equal(name, 'match_docs_embeddings');
    usedFallback = true;
    lastPath = input.match_path;
    return {data: matchPage.all({page: lastPath, max: input.match_count}).map(decode)};
  },
};
function freshWorker() {
  return readerScript.runInNewContext({
    URL, console: {log() {}, error() {}, warn() {}},
    EMBEDDING_DIMENSIONS: 1536, EMBEDDING_MODEL: 'fixture',
    hasOpenAIApiKey: () => true, hasSupabaseEnv: () => true,
    getSupabaseAdminClient: () => service,
    getOpenAIClient: () => ({embeddings: {create: async () => ({data: [{embedding: vector}]})}}),
  });
}
async function query(worker, slug) {
  usedFallback = false;
  lastPath = null;
  const result = await worker('fixture question', base + slug);
  return {usedFallback, matchPath: lastPath, ids: Array.from(result.chunks, row => row.id),
    citations: Array.from(sourceLinks(result.chunks).matchAll(/\]\(([^)]+)\)/g), match => match[1])};
}

const legacy = doc => ({path: doc.source});
const tx = documents.tx.slug;
try {
  publish('old', legacy);
  const warm = freshWorker();
  const original = await query(warm, tx);
  assert.ok(original.ids.includes('old-tx'));
  assert.equal(original.usedFallback, false);

  publish('new', legacy);
  const oldMetadataOnArticle = await query(warm, tx);
  assert.deepEqual(oldMetadataOnArticle, {usedFallback: true, matchPath: tx, ids: [], citations: []});
  const oldMetadataOnHome = await query(warm, '');
  assert.deepEqual(oldMetadataOnHome.ids, ['new-mobile', 'new-tx']);
  assert.equal(oldMetadataOnHome.matchPath, null);
  const freshWorkerOnArticle = await query(freshWorker(), tx);
  assert.ok(freshWorkerOnArticle.ids.includes('new-tx'));
  assert.equal(freshWorkerOnArticle.usedFallback, false);

  publish('new', doc => ({path: doc.source, url: base + doc.slug}));
  const absoluteUrlAlias = await query(warm, tx);
  assert.deepEqual(absoluteUrlAlias.ids, []);
  publish('new', doc => ({path: doc.source, url: doc.slug}));
  const relativeAlias = await query(warm, tx);
  assert.deepEqual(relativeAlias.ids, ['new-tx']);
  assert.deepEqual(relativeAlias.citations, [base + 'Using_Zcash/Transactions']);
  const relativeAliasMobile = await query(warm, documents.mobile.slug);
  assert.deepEqual(relativeAliasMobile.ids, ['new-mobile']);
  assert.deepEqual(relativeAliasMobile.citations, [base + 'Using_Zcash/Mobile_Top_Ups']);
  const relativeAliasMissing = await query(warm, 'using-zcash/no-such-fixture-page');
  assert.deepEqual(relativeAliasMissing.ids, []);

  // Place the serving slug in metadata.path; retain the repository-relative
  // location separately. No hosted redirect, deployment, or backward-compatible
  // migration for other consumers is assumed by this two-English-page fixture.
  publish('new', doc => ({path: doc.slug, sourcePath: doc.source}));
  const canonicalOnArticle = await query(warm, tx);
  assert.deepEqual(canonicalOnArticle, {usedFallback: true, matchPath: tx, ids: ['new-tx'], citations: [base + tx]});
  const otherArticle = await query(warm, documents.mobile.slug);
  assert.deepEqual(otherArticle.ids, ['new-mobile']);
  assert.deepEqual(otherArticle.citations, [base + documents.mobile.slug]);
  const missingSlug = await query(warm, 'using-zcash/no-such-fixture-page');
  assert.deepEqual(missingSlug.ids, []);
  assert.deepEqual(missingSlug.citations, []);

  console.log(JSON.stringify({scope: 'Pinned reader and citation helpers, real SQL page predicate in SQLite, simulated vectors and row service. No model, live database, HTTP redirect, or localized route tested.',
    results: {original, oldMetadataOnArticle, oldMetadataOnHome, freshWorkerOnArticle, absoluteUrlAlias, relativeAlias,
      relativeAliasMobile, relativeAliasMissing,
      canonicalOnArticle, otherArticle, missingSlug}}, null, 2));
} finally {
  db.close();
}

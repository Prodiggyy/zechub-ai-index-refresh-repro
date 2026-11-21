import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

const inputs = process.env.ZCG_SQL_DIR;
assert.ok(inputs, 'Set ZCG_SQL_DIR to the verified upstream input directory');
async function pinned(file, sha) {
  const bytes = await readFile(join(inputs, file));
  const actual = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(actual, sha, 'Git blob mismatch for ' + file);
  return bytes.toString();
}
const [schema, reader, route, ui, chunker] = await Promise.all([
  pinned('schema.sql', 'a931e9daa37934d795817a82c18ba2d67a52c2a5'),
  pinned('vectorSearch.ts', 'd3a2f32fdd2feb1904c17bbc03dcfba5bb0b03b3'),
  pinned('wiki-ai-route.ts', '08b94662432aed8064950f5c0f8e9c699a63c293'),
  pinned('AIAssistant.tsx', '3436fda4fffaa069b057a10c8d34e2bb2976c5a5'),
  pinned('chunking.ts', 'ae9cfdb3eb40cbdd59d9449f6a8d4965f300a70b'),
]);
assert.match(ui, /pageUrl:\s*typeof window !== "undefined" \? window.location.href : undefined/);
const readerBody = reader.slice(reader.indexOf('const DEFAULT_TOP_K')).replace(/^export /gm, '');
const readerScript = new vm.Script(stripTypeScriptTypes(readerBody) + '\nsearchDocs;');
const routeHelpers = route.slice(route.indexOf('function pathToWikiUrl'), route.indexOf('export async function'));
const citations = new vm.Script(stripTypeScriptTypes(routeHelpers) + '\nbuildSourceLinks;').runInNewContext();
const chunk = new vm.Script(stripTypeScriptTypes(chunker.replace('export function', 'function')) + '\nchunkMarkdown;').runInNewContext();
const base = 'https://zechub.wiki/';
const articles = [
  {name: 'Transactions', slug: 'using-zcash/transactions', oldHash: '27f2ab5eea8e82bf6cfcfcf6ef429a3dc041e8d8',
    newHash: '0011f64a59625d963c9575eb46d9f5e22a9b5c42', oldMarker: 'you need to use YWallet and autoshield',
    newMarker: 'a wallet that supports the current Zcash network'},
  {name: 'Mobile_Top_Ups', slug: 'using-zcash/mobile-top-ups', oldHash: '192cf269be36fcf64121e668ea5e2a2cc1730cf3',
    newHash: '5fb72f0427c9f85b0b4703bcd5100be1fc15ec69', oldMarker: 'add your YWallet address in case there will be a refund',
    newMarker: 'Do not rely on the memo field for refunds'},
];
for (const [index, article] of articles.entries()) {
  article.vector = Array(1536).fill(0);
  article.vector[index] = 1;
  article.source = 'zechub/Using_Zcash/' + article.name + '.md';
  for (const version of ['old', 'new']) {
    const doc = await pinned(version + '-' + article.name + '.md', article[version + 'Hash']);
    const chunks = chunk(doc).filter(text => text.includes(article[version + 'Marker']));
    assert.equal(chunks.length, 1);
    article[version + 'Chunk'] = chunks[0];
  }
}
const db = new PGlite({extensions: {vector}});
let rpcCalls = 0;
const service = {
  from(table) {
    assert.equal(table, 'docs_embeddings');
    return {select(columns) {
      if (columns === 'id, embedding') {
        return {range: async (first, last) => ({data: (await db.query(
          'SELECT id, embedding::text AS embedding FROM docs_embeddings ORDER BY id OFFSET $1 LIMIT $2',
          [first, last - first + 1])).rows})};
      }
      assert.equal(columns, 'id, content, metadata');
      return {in: async (column, ids) => {
        assert.equal(column, 'id');
        return {data: (await db.query(
          'SELECT id, content, metadata FROM docs_embeddings WHERE id = ANY($1::uuid[])',
          [Array.from(ids)])).rows};
      }};
    }};
  },
  async rpc(name, {query_embedding, match_count, match_path}) {
    assert.equal(name, 'match_docs_embeddings');
    rpcCalls++;
    const rows = await db.query('SELECT * FROM public.match_docs_embeddings($1, $2, $3)',
      [query_embedding, match_count, match_path]);
    return {data: rows.rows};
  },
};
function freshWorker() {
  return readerScript.runInNewContext({
    URL, console: {log() {}, warn() {}, error() {}}, EMBEDDING_DIMENSIONS: 1536,
    EMBEDDING_MODEL: 'fixture', hasOpenAIApiKey: () => true, hasSupabaseEnv: () => true,
    getSupabaseAdminClient: () => service,
    getOpenAIClient: () => ({embeddings: {create: async ({input}) => {
      const article = articles.find(a => a.name === input);
      assert.ok(article, 'Unexpected query fixture');
      return {data: [{embedding: article.vector}]};
    }}}),
  });
}
async function publish(generation, version, canonical) {
  await db.transaction(async tx => {
    await tx.exec('TRUNCATE review_article_stage');
    for (const [i, a] of articles.entries()) {
      const id = '00000000-0000-4000-8000-' + String(generation * 10 + i).padStart(12, '0');
      const metadata = canonical ? {path: a.slug, sourcePath: a.source} : {path: a.source};
      await tx.query('INSERT INTO review_article_stage (id, content, embedding, metadata) VALUES ($1,$2,$3,$4)',
        [id, a[version + 'Chunk'], JSON.stringify(a.vector), JSON.stringify(metadata)]);
    }
    await tx.exec('DELETE FROM docs_embeddings; INSERT INTO docs_embeddings SELECT * FROM review_article_stage');
  });
}
async function query(worker, article, slug) {
  const count = rpcCalls;
  const {chunks, searchAvailable} = await worker(article.name, base + slug);
  assert.equal(searchAvailable, true, 'A local reader/SQL error must not look like a genuine empty result.');
  return {
    rpcCalls: rpcCalls - count, count: chunks.length, topOld: chunks[0]?.content === article.oldChunk,
    topCorrected: chunks[0]?.content === article.newChunk,
    links: Array.from(citations(chunks).matchAll(/\]\(([^)]+)\)/g), match => match[1]),
  };
}

try {
  await db.exec(schema);
  await db.exec('CREATE TEMP TABLE review_article_stage (LIKE docs_embeddings INCLUDING DEFAULTS)');
  await publish(1, 'old', false);
  const warm = freshWorker();
  const report = {};
  for (const a of articles) {
    const result = await query(warm, a, a.slug);
    assert.equal(result.rpcCalls, 0); assert.equal(result.topOld, true);
    report[a.name] = {original: result};
  }
  await publish(2, 'new', false);
  for (const a of articles) {
    const result = await query(warm, a, a.slug);
    assert.equal(result.rpcCalls, 1); assert.equal(result.count, 0);
    report[a.name].legacyAfterSwap = result;
  }
  const home = await query(warm, articles[0], '');
  assert.equal(home.rpcCalls, 1); assert.equal(home.topCorrected, true);
  await publish(3, 'new', true);
  for (const a of articles) {
    const result = await query(warm, a, a.slug);
    assert.equal(result.rpcCalls, 1); assert.equal(result.count, 1); assert.equal(result.topCorrected, true);
    assert.deepEqual(result.links, [base + a.slug]);
    report[a.name].canonicalAfterSwap = result;
  }
  const missing = await query(warm, articles[0], 'using-zcash/no-such-fixture-page');
  assert.equal(missing.rpcCalls, 1); assert.equal(missing.count, 0); assert.deepEqual(missing.links, []);
  const engine = (await db.query("SELECT current_setting('server_version') AS postgres, extversion AS pgvector FROM pg_extension WHERE extname='vector'")).rows[0];
  console.log(JSON.stringify({result: 'PASS', ...engine, report, homeWithLegacyMetadata: home, missingSlug: missing,
    scope: 'One hash-verified upstream chunk per real English article/version. Pinned reader and citation logic call the original SQL function against an in-memory PostgreSQL database via a local query adapter. Vectors are synthetic; hosted API and model not used.'}, null, 2));
} finally { await db.close(); }

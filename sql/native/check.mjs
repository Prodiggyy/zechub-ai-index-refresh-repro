import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const revision = 'b5acf9822d4201ff4fed7011d75d76058750679c';
const blobs = {
  'schema.sql': 'a931e9daa37934d795817a82c18ba2d67a52c2a5',
  'fix_ivfflat.sql': 'f3e92dd2de35343fc51cc35e80a246d5eafb858e',
};

async function upstreamSql(name) {
  let bytes;
  if (process.env.ZCG_SQL_DIR) {
    bytes = await readFile(join(process.env.ZCG_SQL_DIR, name));
  } else {
    const url = new URL(`https://raw.githubusercontent.com/hyperlander/zechubai/${revision}/sql/${name}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Fetching ${url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(hash, blobs[name], `Unexpected upstream SQL bytes for ${name}`);
  return bytes.toString();
}

async function nativeClient(connection) {
  const client = new pg.Client({
    host: '127.0.0.1', user: 'reviewer', database: 'zcg_review_only',
    port: connection.port, password: connection.password,
  });
  await client.connect();
  return {
    exec: (sql) => client.query(sql),
    query: (sql, args) => client.query(sql, args),
    close: () => client.end(),
  };
}

const oldVector = JSON.stringify([1, ...Array(1535).fill(0)]);
const otherVector = JSON.stringify([0, 1, ...Array(1534).fill(0)]);
const newVector = JSON.stringify([0.94, 0.06, ...Array(1534).fill(0)]);
const rawPath = 'zechub/Using_Zcash/Transactions.md';
const pageContext = 'using-zcash/transactions';
const oldId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const newId = '00000000-0000-4000-8000-000000000003';
const oldText = 'OLD transactions fixture';
const newText = 'CORRECTED transactions fixture';
const benchRows = [
  [oldId, oldText, oldVector, { path: rawPath, file: '/docs/' + rawPath, chunkIndex: 0 }],
  [otherId, 'Unaffected fixture', otherVector, { path: 'zechub/Using_Zcash/Wallets.md', chunkIndex: 0 }],
];

async function match(client, context) {
  return (await client.query(
    'SELECT id, content, similarity FROM public.match_docs_embeddings($1, 1, $2)',
    [oldVector, context],
  )).rows;
}

const parts = [];
for await (const part of process.stdin) parts.push(part);
const connection = JSON.parse(Buffer.concat(parts).toString());
const writer = await nativeClient(connection);
const reader = await nativeClient(connection);
try {
  const [schema, indexFix] = await Promise.all(Object.keys(blobs).map(upstreamSql));
  await writer.exec(schema);
  // An ANN index trained on a two-row toy corpus cannot measure recall.
  // Make this path and transaction proof use exact distances on both sessions.
  for (const session of [writer, reader]) {
    await session.exec('SET enable_indexscan = off');
  }
  for (const [id, content, embedding, metadata] of benchRows) {
    await writer.query(
      'INSERT INTO public.docs_embeddings (id, content, embedding, metadata) VALUES ($1, $2, $3, $4)',
      [id, content, embedding, JSON.stringify(metadata)],
    );
  }
  const info = (await writer.query(
    "SELECT current_setting('server_version') AS postgres, extversion AS pgvector FROM pg_extension WHERE extname = 'vector'",
  )).rows[0];
  const original = await match(reader, rawPath);
  assert.equal(original[0].content, oldText);
  assert.equal(original[0].similarity, 1);
  assert.deepEqual(await match(reader, pageContext), []);

  await writer.exec(`
    CREATE TABLE review_stage (LIKE public.docs_embeddings INCLUDING DEFAULTS);
    CREATE TABLE review_revision (id integer PRIMARY KEY, value integer NOT NULL);
    INSERT INTO review_revision VALUES (1, 1);
  `);
  await writer.query(
    'INSERT INTO review_stage (id, content, embedding, metadata) VALUES ($1, $2, $3, $4)',
    [newId, newText, newVector, JSON.stringify({ path: rawPath, url: pageContext, chunkIndex: 0 })],
  );
  assert.equal((await match(reader, null))[0].content, oldText);

  async function applyStage() {
    const state = await writer.query(`
      UPDATE review_revision SET value = 2 WHERE id = 1 AND value = 1
        AND (SELECT count(*) FROM review_stage) = 1 RETURNING value
    `);
    if (state.rows.length !== 1) throw new Error('Stale revision or incomplete stage');
    await writer.query("DELETE FROM public.docs_embeddings WHERE metadata->>'path' = $1", [rawPath]);
    await writer.exec('INSERT INTO public.docs_embeddings SELECT * FROM review_stage');
  }

  await writer.exec('BEGIN');
  try {
    await applyStage();
    await writer.exec('SELECT 1 / 0');
    throw new Error('Expected forced SQL failure');
  } catch (error) {
    await writer.exec('ROLLBACK');
    assert.equal(error.code, '22012');
  }
  assert.equal((await match(reader, null))[0].content, oldText);
  assert.deepEqual(await match(reader, pageContext), []);

  await reader.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const readPid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const writePid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  assert.notEqual(readPid, writePid);
  assert.equal((await match(reader, null))[0].content, oldText);
  await writer.exec('BEGIN');
  await applyStage();
  assert.equal((await match(reader, null))[0].content, oldText);
  assert.deepEqual(await match(reader, pageContext), []);
  await writer.exec('COMMIT');
  assert.equal((await match(reader, null))[0].content, oldText);
  await reader.exec('COMMIT');
  const current = await match(reader, pageContext);
  assert.equal(current[0].id, newId);
  assert.equal(current[0].content, newText);
  assert.ok(current[0].similarity > 0.99 && current[0].similarity < 1);

  await writer.exec('BEGIN');
  await assert.rejects(applyStage(), /Stale revision or incomplete stage/);
  await writer.exec('ROLLBACK');
  const stored = (await reader.query('SELECT id FROM docs_embeddings ORDER BY id')).rows;
  assert.deepEqual(stored.map(row => row.id), [otherId, newId]);

  // This optional upstream migration is tested separately, after the original
  // schema and function have already passed the complete publication replay.
  await writer.exec('BEGIN');
  try {
    await writer.exec(indexFix);
    throw new Error('Expected the original STABLE-function smoke test to fail');
  } catch (error) {
    await writer.exec('ROLLBACK');
    assert.equal(error.code, '0A000');
    assert.match(error.message, /SET is not allowed in a non-volatile function/);
  }
  assert.equal((await match(reader, pageContext))[0].id, newId);
  // A function-level configuration clause keeps the STABLE declaration.
  const correctedRepair = indexFix
    .replace('LANGUAGE plpgsql STABLE AS $$', () => 'LANGUAGE plpgsql STABLE SET ivfflat.probes = 10 AS $$')
    .replace('  SET LOCAL ivfflat.probes = 10;', '');
  await writer.exec(correctedRepair);
  assert.equal((await match(reader, rawPath))[0].id, newId);
  assert.equal((await match(reader, pageContext))[0].id, newId);
  console.log(JSON.stringify({
    result: 'PASS',
    engine: 'native-postgres',
    postgres: info.postgres,
    pgvector: info.pgvector,
    pinnedUpstreamSqlHashesVerified: true,
    originalIndexRepairFailedOwnSmokeTestWith: '0A000',
    functionConfigurationClauseRepairPassedSmokeTest: true,
    dimensions: 1536,
    fixtureRanking: 'exact scan, 2 stored rows',
    pageContext,
    storedSourcePath: rawPath,
    sourcePathMatchedBeforeUpdate: true,
    pageContextRowsBeforeUpdate: 0,
    unchangedReaderReturnedOldWhilstStaged: true,
    injectedFailureRolledBackPublication: true,
    twoSessionsPreservedOldSnapshotThroughCommit: true,
    postCommitPageContextReturnedCorrectedRow: true,
    stagedRefreshUsedUnmodifiedOriginalRpc: true,
    obsoleteRowRemovedAndUnrelatedRowPreserved: true,
    staleWriterReplayRejected: true,
  }, null, 2));
} finally {
  await reader.close();
  await writer.close();
}

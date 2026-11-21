import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs, promisify} from 'node:util';

const home = fileURLToPath(new URL('.', import.meta.url));
const run = promisify(execFile);
const usage = 'node review.mjs [--input-dir DIR | --cache-dir DIR] [--with-sql] [--native] [--details]';
const unavailable = reason => Object.assign(new Error(reason), {code: 'INPUT_UNAVAILABLE'});

function checkHash(bytes, pin) {
  const hash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(hash, pin.blob, 'Pinned source changed or file is corrupt: ' + pin.name);
}
async function readSource(pin, options) {
  const dir = options['input-dir'] || options['cache-dir'];
  if (dir) {
    try {
      const bytes = await readFile(join(resolve(dir), pin.name));
      checkHash(bytes, pin);
      return bytes;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (options['input-dir']) throw unavailable('Offline input missing: ' + pin.name);
    }
  }
  const url = ['https://raw.githubusercontent.com', pin.repository, pin.commit, pin.path].join('/');
  let response, bytes;
  try {
    response = await fetch(url, {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw unavailable('Cannot retrieve ' + pin.name + ': ' + error.message + '. ' + url);
  }
  checkHash(bytes, pin);
  if (options['cache-dir']) {
    const path = join(resolve(options['cache-dir']), pin.name);
    try { await writeFile(path, bytes, {flag: 'wx'}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      checkHash(await readFile(path), pin);
    }
  }
  return bytes;
}

const checks = ['article-refresh', 'removed-page', 'warm-reader', 'exact-pr', 'page-context'];
let temporary;
try {
  const {values: options} = parseArgs({options: {
    'input-dir': {type: 'string'}, 'cache-dir': {type: 'string'},
    'with-sql': {type: 'boolean'}, native: {type: 'boolean'},
    details: {type: 'boolean'}, help: {type: 'boolean'},
  }});
  if (options.help) { console.log(usage); process.exit(0); }
  if (Number(process.versions.node.split('.')[0]) < 24) throw unavailable('Use Node.js 24 or later.');
  if (options['input-dir'] && options['cache-dir']) throw new Error(usage);
  if (options['cache-dir']) await mkdir(resolve(options['cache-dir']), {recursive: true});

  const pins = JSON.parse(await readFile(join(home, 'sources.json'), 'utf8'));
  assert.equal(new Set(pins.map(p => p.name)).size, pins.length, 'Duplicate source filenames');
  temporary = await mkdtemp(join(tmpdir(), 'zcash-ai-review-'));
  const inputs = join(temporary, 'inputs');
  await mkdir(inputs);
  for (const pin of pins) await writeFile(join(inputs, pin.name), await readSource(pin, options));
  const evidence = {};
  for (const name of checks) {
    const file = name + '.mjs';
    await copyFile(join(home, 'checks', file), join(temporary, file));
    const {stdout} = await run(process.execPath, ['--disable-warning=ExperimentalWarning', file],
      {cwd: temporary, timeout: 30000});
    evidence[name] = JSON.parse(stdout);
  }
  const a = evidence['article-refresh'].results;
  const removed = evidence['removed-page'].history;
  const warm = evidence['warm-reader'].results;
  assert.deepEqual([a.oldOnly.rows, a.documentedRefresh.rows, a.clearInPlaceFailure.rows,
    a.stagedSuccessNowServing.rows], [5, 18, 3, 13]);
  assert.deepEqual(a.stagedFailureStillServing, a.oldOnly);
  assert.equal(removed.at(-1).retiredPageCopies, 2);
  assert.deepEqual(warm.partialUpdateWhileWarm.chunks, []);
  assert.equal(warm.newWorkerAfterPartialUpdate.chunks[0], 'revised');
  const exact = evidence['exact-pr'];
  assert.equal(exact.result, 'PASS');
  const pr = exact.results;
  const counts = stage => [stage.rows, stage.withdrawn, stage.replacement];
  assert.deepEqual(counts(pr.firstParentIndex), [8, 3, 0]);
  assert.deepEqual(counts(pr.afterMergeRefresh), [16, 3, 3]);
  assert.deepEqual(counts(pr.afterUnchangedRepeat), [24, 3, 6]);
  assert.deepEqual(counts(pr.cleanMergeIndex), [8, 0, 3]);
  const page = evidence['page-context'].results;
  assert.deepEqual(page.oldMetadataOnArticle.ids, []);
  assert.deepEqual(page.relativeAlias.ids, ['new-tx']);
  assert.deepEqual(page.relativeAliasMobile.ids, ['new-mobile']);
  assert.deepEqual(page.relativeAliasMissing.ids, []);
  const summary = {
    result: 'PASS',
    scope: 'Public-source defect reproduction and controlled local feasibility checks',
    source_files_verified: pins.length,
    historical_corpus: {
      rows_after_append_refresh: a.documentedRefresh.rows,
      withdrawn_passages_retained: a.documentedRefresh.obsoleteAutoshield + a.documentedRefresh.obsoleteMemo,
      replacement_passages_present: a.documentedRefresh.replacementAutoshield + a.documentedRefresh.replacementMemo,
      rows_served_after_interrupted_clear_and_rebuild: a.clearInPlaceFailure.rows,
      prior_snapshot_retained_in_staging_simulation: true,
      rows_after_successful_staged_rebuild: a.stagedSuccessNowServing.rows,
      withdrawn_passages_after_staged_rebuild: a.stagedSuccessNowServing.obsoleteAutoshield + a.stagedSuccessNowServing.obsoleteMemo,
    },
    exact_pr: {
      number: exact.pullRequest, pages_tested: exact.pagesTested,
      withdrawn_after_refresh: pr.afterMergeRefresh.withdrawn,
      replacements_after_refresh: pr.afterMergeRefresh.replacement,
      rows_after_identical_rerun: pr.afterUnchangedRepeat.rows,
      withdrawn_after_clean_rebuild: pr.cleanMergeIndex.withdrawn,
      replacements_after_clean_rebuild: pr.cleanMergeIndex.replacement,
    },
    warm_reader_on_article: {
      rows_with_importer_paths_only: page.oldMetadataOnArticle.ids.length,
      rows_with_matching_page_key: page.relativeAlias.ids.length,
      negative_control_rows: page.relativeAliasMissing.ids.length,
    },
    sql: 'SKIPPED (use --with-sql)',
    native_two_session_sql: 'SKIPPED (use --native)',
    hosted_database_queried: false, real_model_ranking_tested: false,
    grant_release_acceptance: 'PENDING',
  };
  if (options['with-sql'] || options.native) {
    const sql = join(home, 'sql');
    try {
      await access(join(sql, 'node_modules', '@electric-sql', 'pglite', 'package.json'));
    } catch {
      throw unavailable('Install the locked local SQL test packages first: npm --prefix sql ci --ignore-scripts');
    }
    const env = {...process.env, ZCG_SQL_DIR: inputs};
    const {stdout} = await run(process.execPath, ['--disable-warning=ExperimentalWarning', join(sql, 'page-reader-sql.mjs')],
      {cwd: sql, env, timeout: 90000});
    const result = JSON.parse(stdout);
    assert.equal(result.result, 'PASS');
    assert.equal(Object.keys(result.report).length, 2);
    for (const article of Object.values(result.report)) {
      assert.equal(article.legacyAfterSwap.count, 0);
      assert.equal(article.canonicalAfterSwap.count, 1);
      assert.equal(article.canonicalAfterSwap.topCorrected, true);
    }
    assert.equal(result.missingSlug.count, 0);
    evidence.sql = result;
    summary.sql = {result: result.result, engine: 'PGlite', postgres: result.postgres, pgvector: result.pgvector,
      corrected_articles_retrieved_with_expected_citation: 2, missing_page_matches: 0};
    if (options.native) {
      let native;
      try {
        const {stdout: output} = await run('uv', ['run', '--no-project', '--with-requirements',
          join(sql, 'native', 'requirements.txt'), 'python', join(sql, 'native', 'native.py')],
          {cwd: sql, env, timeout: 180000});
        native = JSON.parse(output);
      } catch (error) {
        if (error.code === 'ENOENT') throw unavailable('The optional native check requires uv. See sql/README.md.');
        throw error;
      }
      assert.equal(native.result, 'PASS');
      assert.equal(native.twoSessionsPreservedOldSnapshotThroughCommit, true);
      assert.equal(native.originalIndexRepairFailedOwnSmokeTestWith, '0A000');
      assert.equal(native.injectedFailureRolledBackPublication, true);
      assert.equal(native.postCommitPageContextReturnedCorrectedRow, true);
      evidence.native = native;
      summary.native_two_session_sql = {result: native.result, postgres: native.postgres,
        pgvector: native.pgvector, failed_publish_rolled_back: true, concurrent_read_preserved: true,
        published_optional_repair_sqlstate: native.originalIndexRepairFailedOwnSmokeTestWith};
    }
  }
  if (options.details) summary.checks = evidence;
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const blocked = error.code === 'INPUT_UNAVAILABLE';
  console.error(JSON.stringify({result: blocked ? 'BLOCKED' : 'FAIL',
    reason: (error.stderr?.trim() || error.message).slice(0,2200)}));
  process.exitCode = blocked ? 2 : 1;
} finally {
  if (temporary) await rm(temporary, {recursive: true, force: true});
}

# Publish wallet corrections to ZecHub AI search

**Reviewer evidence for a proposed $3,000 ZCG grant over three weeks. Rechecked November 20, 2026 (Toronto).** The published example importer gives each chunk a fresh ID on every run. When a wiki editor withdraws wallet guidance, refreshing the search index can retain the old text alongside the replacement. The assistant's author publicly requested automatic refreshes. [Author's request](https://forum.zcashcommunity.com/t/wiki-search-answer-with-ai-on-zechub-wiki/55277) · [Published importer](https://github.com/hyperlander/zechubai/blob/b5acf9822d4201ff4fed7011d75d76058750679c/scripts/embedDocs.ts)

## Run the evidence

Unzip the archive and open a terminal in the directory containing this README. Use **Node.js 24**. All tests run in disposable storage. No wallet, API key or hosted database access is required.

**Quick source replay.** Run `node review.mjs`. This downloads 17 commit-pinned source files, checks their Git blob hashes and exercises five checks. It takes a few seconds with cached inputs. The final JSON labels the SQL tests as skipped on this path.

**Full local replay.** With Node.js 24 and npm installed, run both commands below. The first installs locked test dependencies. The second executes the source checks and the PostgreSQL/pgvector tests using an in-process PostgreSQL build. An internet connection is required for initial dependencies and source retrieval.

```sh
npm --prefix sql ci --ignore-scripts --no-audit --no-fund
node review.mjs --with-sql --cache-dir .review-inputs
```

After that first run, `node review.mjs --with-sql --input-dir .review-inputs` replays the same checks offline. Add `--details` for the evidence behind each assertion. Exit 0 means all selected checks passed, exit 1 means a verification failed, and exit 2 means a required input or dependency was unavailable. Verified outputs from this review are in `observed/`. On a supported system with Python and uv, add `--native` to run the separate two-connection test as well. See `sql/README.md` for installation and offline use.

## 1. Replay the actual September correction

ZecHub merged [PR #2013](https://github.com/ZecHub/zechub/pull/2013/files) on September 6. The PR author described removing recommendations across 11 pages. GitHub lists 16 changed files in total. We tested three modified Markdown files at the merge's first parent and at the merge itself. The before and after revisions and each file's blob identifier are in `sources.json`.

| Published importer on these three pages | Indexed chunks | Chunks containing the withdrawn instruction | Chunks containing its replacement |
| --- | ---: | ---: | ---: |
| First parent | 8 | 3 | 0 |
| Refresh to merge | 16 | 3 | 3 |
| Refresh the same merge again | 24 | 3 | 6 |
| Clean rebuild at merge | 8 | 0 | 3 |

The three edits changed a wallet recommendation in the payment-privacy guide, the address to supply in the mobile top-up instructions, and the recommendation on the Zcash Addresses page. Each withdrawn phrase and its replacement are checked separately within the corresponding file. These counts measure indexed text. They do not measure production answer frequency. [First parent](https://github.com/ZecHub/zechub/tree/42ca5e16d157a1917bf7de73324bd4ae2c69443c) · [Merge](https://github.com/ZecHub/zechub/tree/8a8ba57a862cb3bb5227e58ff6e951907714d2e6)

**Separate historical check.** The original two-page replay compares the example corpus with a later canonical snapshot of Transactions and Mobile Top-Ups. It gave 18 rows after an ordinary refresh and 13 after a clean rebuild. Interrupting a clear-and-rebuild left 3 of 13 rows. Preparing the replacement separately kept the previous 5-row snapshot available. The Transactions page was outside PR #2013. In this check directory order is fixed and the failure is injected on the second embedding batch, so the exact partial row count is reproducible.

## 2. Test the request the wiki actually sends

The official assistant includes the browser page URL in a chat request. A worker that has already cached the old vector IDs can fall back to a database search after a full replacement. From the Transactions page that search filters for `using-zcash/transactions`. The public importer writes `zechub/Using_Zcash/Transactions.md`. With the published exact-match filter, the homepage query succeeds and the same worker's article query returns zero fixture rows. A global-only test misses this case.

Preserving the original filename and adding the matching relative page key in metadata restored page-specific retrieval. A separate fixture using the canonical page key as its path returned the intended article and canonical citation on both English pages tested. A nonexistent page matched nothing. The historical citation spellings also loaded the correct article headings in a separate public-page check. These results concern finding the right row after a refresh. They do not establish broken public hyperlinks or tell us what a visitor has been shown. [Browser request](https://github.com/ZecHub/zechub-wiki/blob/264384e3212a0cda9c0b9f773ea4d4193e03b9dd/src/components/AIAssistant.tsx) · [Retrieval](https://github.com/ZecHub/zechub-wiki/blob/264384e3212a0cda9c0b9f773ea4d4193e03b9dd/src/lib/ai/vectorSearch.ts) · [Citation helper](https://github.com/ZecHub/zechub-wiki/blob/264384e3212a0cda9c0b9f773ea4d4193e03b9dd/src/app/api/ai/route.ts)

## 3. Check the storage and reader behavior

In PostgreSQL 17.5 with pgvector 0.8.0 (PGlite), the official reader and citation helper ran against the original published SQL schema. The test uses a verified article chunk for each version of each English page. With an already-running reader and new row IDs, both article requests returned zero rows using the original filename-only metadata. Using the served page key returned exactly one replacement per page with the expected citation. The nonexistent-page control returned zero. These fixture queries isolate page matching with synthetic vectors.

A second check used two independent connections to native PostgreSQL 18.6 with pgvector 0.8.6. A failed publication rolled back. A reader that had opened its snapshot before the writer committed could still read the old row; its next transaction retrieved the replacement. This test kept the original source path and added the relative page key to the metadata. A stale repeat publication was rejected and the unrelated row survived.

We also ran the example repo’s optional index-repair SQL against the populated native test database. Its own final query failed with PostgreSQL error `0A000` because the published `STABLE` function executes `SET LOCAL` inside its body. Rolling back the optional migration left the original query function working. A local diagnostic moving the setting into the function declaration passed. The proposed adapter can use the original query function and verify it before publication. The test supplies no evidence about which SQL the hosted wiki runs. [Original schema](https://github.com/hyperlander/zechubai/blob/b5acf9822d4201ff4fed7011d75d76058750679c/sql/schema.sql) · [Optional SQL script](https://github.com/hyperlander/zechubai/blob/b5acf9822d4201ff4fed7011d75d76058750679c/sql/fix_ivfflat.sql)

The embeddings in the tests are synthetic. The tests exercise the storage, identifiers, page filters and retrieval decisions independently of provider access. No hosted AI request, answer-quality study, or production database inspection was performed.

## Proposed grant and acceptance

| Remaining milestone | Amount |
| --- | ---: |
| Weeks 1–2 · Ship the open-source updater: read a pinned wiki revision, map sources to served pages, validate a complete staged index and support rollback on the operator's database | $1,800 |
| Week 3 · Ship a scheduled job, runnable acceptance test and operator instructions covering edited and deleted pages, concurrent reads, failed updates, and repeat runs | $1,200 |

The $3,000 estimate assumes 40 hours at $75. These research checks are already complete and excluded from the ask. A clean rebuild removes obsolete rows. The remaining grant work packages that rebuild so an operator can carry it out during service, keep current citations and identify a failed publication. Independent local review requires no upstream merge. Hosted rollout requires the operator's own configuration and decision.

**Delivered-release PASS/FAIL (pending).** Start the released publisher with a local PostgreSQL/pgvector database and a running ZecHub reader. Ingest a pinned revision, edit and delete real pages, interrupt publication, and query while it is interrupted. The old complete revision must still be visible. Retry; the running reader must return both corrected passages with links to the intended articles from their normal page contexts, and no withdrawn or deleted passage may remain in the live index. An identical rerun must introduce zero duplicate chunks. Any failed condition is FAIL.

**Funding and adoption.** Two outside AI fixes were merged in October and November. An independent wallet user reported blocked transfers and confirmed recovery 12 days after reporting the problem. The source of that user's wallet choice is unknown. The hosted configuration, an operator's commitment to adopt this tool, and a second adopter remain unconfirmed. ZecHub's existing funding and $250–$400 bounty band for a large development task are the main funding objection. The committee would be evaluating the standalone release and its deployment value. [October merge](https://github.com/ZecHub/zechub-wiki/pull/956) · [November merge](https://github.com/ZecHub/zechub-wiki/pull/1045) · [Wallet report](https://github.com/hhanh00/zwallet/issues/273) · [ZecHub grant](https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues/153) · [Bounty rates](https://bounties.zechub.wiki/docs/bounty-amounts)

The prior mining calculation is retained in `mining/` as a separate research appendix. It plays no part in this proposal or its PASS result.

# Run the SQL checks

From the packet root, install Node.js 24 and run:

```sh
npm --prefix sql ci --ignore-scripts --no-audit --no-fund
node review.mjs --cache-dir .review-inputs --with-sql
```

This runs the actual search and citation helpers against a local PostgreSQL 17.5 / pgvector 0.8.0 instance (PGlite). An adapter translates the small subset of Supabase requests used by the pinned reader into local SQL. It sends the real page key to the original published search function. The fixture supplies synthetic vectors and one chunk per article/version. It never opens a hosted database.

## Optional second engine

On Linux x86_64 the native check was verified using Node.js 24, uv, and the pinned Python packages in `native/requirements.txt`. It starts an authenticated PostgreSQL 18.6/pgvector 0.8.6 instance on loopback, opens two independent sessions, runs the tests, and removes the disposable database. Initial package setup requires internet access. Run as a regular user with permission to start local processes and bind a loopback port. A system PostgreSQL install or existing database is unnecessary.

```sh
node review.mjs --cache-dir .review-inputs --native
```

This also runs the PGlite check. For an offline rerun after populating the source and dependency caches, use `UV_OFFLINE=1 node review.mjs --input-dir .review-inputs --native` from the packet root on Linux. The native script never connects to the hosted wiki and accepts no external database credentials. The two checks have different purposes: real page retrieval through the wiki's reader, and native transaction visibility through separate connections. The native fixture uses exact distance ranking on two stored rows. It cannot establish production approximate-search recall.

Expected native results include `injectedFailureRolledBackPublication: true`, `twoSessionsPreservedOldSnapshotThroughCommit: true`, and `originalIndexRepairFailedOwnSmokeTestWith: "0A000"`. That last field records an expected failure in the optional upstream SQL. The original schema succeeded without that migration.

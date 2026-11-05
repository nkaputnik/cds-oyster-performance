# CDS-Oyster performance benchmark

Compare plain CAP, native JavaScript handlers, and Oyster WASM handlers locally against SQLite. The repo contains the data and application code. You start the benchmark; the runner deploys the database, starts CAP and the HTTP load generator, stops them, and writes the report.

## Install and run

Use Node.js 22.18 or newer and npm on macOS or Linux. Run one benchmark at a time, with port 4006 free. Keep the machine plugged in and close other CPU-intensive applications.

~~~sh
git clone https://github.com/nkaputnik/cds-oyster-performance.git
cd cds-oyster-performance
npm install
npm run benchmark
~~~

For the longer version:

~~~sh
npm run benchmark:long
~~~

No global CDS CLI, separate server startup, database download, or data generation is needed. Dependencies in package.json use latest. Each result records the versions actually installed, hardware, settings, and hashes of the source and CSV files. A local npm lockfile is created by installation but is not tracked; delete it before reinstalling if you want npm to resolve latest again.

## Choose a version

| | Short: npm run benchmark | Long: npm run benchmark:long |
| --- | --- | --- |
| Time budget | 15 minutes | 90 minutes |
| Independent repetitions | 1 | 3 |
| Warmup / measurement per case | 2 / 5 seconds | 3 / 12 seconds |
| Ordinary measured runs | 68 | 249 |
| CRUD and custom actions | All baseline, empty, calculation, CQL read/write comparisons | Same, repeated |
| READ tables | 1,000 rows and 1,000,000 rows | Same |
| Large-result processing | Return and calculate over 10 / 1,000 rows; scan 10,000 rows | Also scan 50,000 rows and process the complete million-row table |
| Declared extension points | Empty, calculation, CQL read/write; unused routing control | Same, repeated |
| Concurrent load | 1, 8 and 32 clients on representative actions | Also mixed READ / INSERT / UPDATE / action traffic |
| CQL fan-out | One auxiliary query | Also five auxiliary queries |

The planned durations, including a five-second setup allowance per run, are about 14 minutes and 83 minutes plus whole-table processing. These are estimates, not completed campaign timings. The runner enforces the 15- and 90-minute budgets. A slow machine can reach the budget before every case finishes; the partial report then identifies missing comparisons. Use short for an initial comparison and long to assess repeat variability.

## Review the result

The terminal prints the path to reports/bench-<timestamp>/report.md. Open that file in GitHub or a Markdown preview that supports Mermaid charts. Each invocation produces a new directory.

| File | Purpose |
| --- | --- |
| report.md | Charts first, named comparisons, and explicit answers to the six original questions |
| details.md | Every comparison, repetition, validation result, resource metric, and failure |
| results.csv / results.json | Machine-readable observations |
| manifest.json | Actual dependency versions, data/source hashes, machine, settings and completion status |
| raw/ and logs/ | Successful response timings, generator output and CAP logs |

Positive overhead means Oyster took longer. Calculation-only handlers issue no auxiliary CQL; CRUD still performs its primary database operation. CQL variants do the same calculation plus a lookup or update in an auxiliary table. READ calculations run over returned rows; scans fetch and process pages in one action.

The report answers:

1. What custom calculation and CQL add to plain CAP CRUD and actions.
2. What changes when equivalent logic executes in Oyster instead of native JavaScript.
3. The overhead of an idle Oyster plugin and an empty Oyster handler.
4. The additional CQL callback cost compared with native service queries and direct database queries.
5. How returned-row and paged-loop processing behave as the result size grows.
6. How response latency, throughput, failures, and an unrelated lightweight request behave under concurrent load.

Callback cost uses calculation-only controls on both paths. It is an empirical difference between complete execution paths, including query handling and data transfer. It is not a measurement of one isolated internal component.

Only validated, matching runs support overhead comparisons. Failed requests remain visible and are excluded from successful latency. Short has one repetition and cannot establish repeat variability. Load uses concurrent HTTP clients with one request in flight per client; it does not establish scheduled-arrival capacity. Client and server share this machine, and SQLite serializes writes.

Regenerate Markdown from existing evidence without running measurements:

~~~sh
npm run report -- --latest
# Or select a particular directory:
npm run report -- reports/bench-<timestamp>
~~~

## Application and data setup

There are two copies of the same CAP application. The root application declares Oyster; apps/cap/package.json declares only CAP and SQLite. CAP discovers plugins normally from each application's dependencies. Native handlers run in the root app with Oyster installed but without a sandbox handler; this makes the native-versus-Oyster comparison share the same plugin environment. The separate plain-CAP app supplies the control without Oyster.

Both applications use the same database:

- Root app: db/benchmark.sqlite.
- Plain CAP copy: ../../db/benchmark.sqlite, relative to apps/cap.

Before each case, the runner stops the previous server and runs the installed CDS CLI:

~~~sh
cds deploy --to sqlite:db/benchmark.sqlite
~~~

The model lives in .base/db/schema.cds, a small local npm workspace containing the model shared by both app copies. The retained CSVs live in db/data. The large CSV contains one million rows; the other four contain 1,000 rows each. No frozen database or patched data generator is used. To change the data or model, edit these files; the next deployment picks them up.

The runner selects the handler case through a temporary benchmark.json and writes the corresponding Oyster handlers into the standard service handler directories. These files are ignored by Git and removed after the case. It does not clone applications or install dependencies during a run. The two app copies are tracked files; keep their service and library source identical when editing them.

For manual inspection of the root app:

~~~sh
npm run deploy
npm start
~~~

The service is at http://localhost:4006/benchmark. Stop the manual server before starting a benchmark.

## Verify and stop

~~~sh
npm test
npm run verify
~~~

npm test checks the runner, reporting, requests, and real native/Oyster persistence and rollback. npm run verify checks the short protocol's handler activation, checksums and side effects without load measurement. Verification also deploys the database and needs port 4006 free.

Press Ctrl-C once to stop a benchmark. The runner stops its CAP and load-generator processes, removes generated handlers, and saves completed observations. An interrupted, budget-limited, or failed run exits with a nonzero status. Its report is partial and must not be treated as a complete result. Startup logs identify port conflicts or incompatible dependencies; configuration is not silently changed to bypass them.

Reports, SQLite files, dependencies, and temporary configuration are ignored by Git. Share the complete result directory when someone needs to inspect the evidence behind a report.

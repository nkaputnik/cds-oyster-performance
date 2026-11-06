# CDS-Oyster performance benchmark

Compare plain CAP, native JavaScript handlers, and Oyster WASM handlers locally against SQLite. The repo contains the data and application code. You start the benchmark; the runner deploys the database, starts CAP and the HTTP load generator, stops them, and writes the report.

## Install and run

Use Node.js 22.18 or newer and npm on macOS or Linux. On Windows, run these commands inside WSL with Node.js and npm installed in that Linux environment. Run one benchmark at a time, with port 4006 free. Keep the machine plugged in and close other CPU-intensive applications.

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
| Target duration | Under 15 minutes | Up to 90 minutes |
| Independent repetitions | 1 | 3 |
| Warmup / measurement per case | 2 / 4 seconds | 3 / 10 seconds |
| Ordinary measured runs | 108 | 363 |
| CRUD and custom actions | Baseline, empty, business constraints, CQL read/write and selected synthetic comparisons | Same, repeated |
| Business constraints | 32 cases: fixed limit or one lookup; accepted and rejected INSERT, UPDATE, action and extension-point requests | Same, repeated |
| READ tables | 1,000 rows and 1,000,000 rows | Same |
| Large-result processing | Return and calculate over 10 / 1,000 rows; scan 10,000 rows | Also scan 50,000 rows and process the complete million-row table |
| Declared extension points | Empty, business constraints, CQL read/write; unused routing control | Same, repeated |
| Concurrent load | 1, 8 and 32 clients on representative actions | Also mixed READ / INSERT / UPDATE / action traffic |
| CQL fan-out | 1 versus 10 sequential reads and updates | Same, repeated |
| Equivalent enrichment | Ten individual indexed lookups versus one batched query for the same ten keys | Same, repeated |

The runner starts **two CAP processes for short and six for long**, one per app and independent repetition. Each process serves all of its fixed endpoint cases. The warmup and measurement windows total about 11 minutes for short and 79 minutes for long, with deployment, verification, HTTP worker startup and report writing added. Long also includes whole-table processing. These durations are targets, not enforced limits. The runner completes all planned cases and whole-table scans even if the machine needs more time. CPU speed, available resources and WSL filesystem performance can affect total duration.

The completed test runs on November 6, 2026 took **11 minutes 38 seconds for short** and **83 minutes 44 seconds for long** on an Apple M2 Pro. Short validated all 108 cases. Long validated all 363 ordinary measurements and six whole-table measurements across three independent repetitions. Both runs had zero failures. These recorded intervals exclude initial CSV deployment. Hardware and installed dependency versions can change the duration.

## Review the result

Latest examples from November 6, 2026: [short run](examples/short-run-2026-11-06/report.md) and [long run](examples/long-run-2026-11-06/report.md). Both use the current business constraint cases and report wording. Each example includes source snapshots of the linked handlers. The long run includes three independent repetitions and verified processing of the complete million-row table.

The terminal prints the path to `reports/bench-<timestamp>/report.md`. Open it in a Markdown preview with Mermaid support. Each test run creates a new directory. To view the report on GitHub, upload the result directory separately.

| File | Purpose |
| --- | --- |
| `report.md` | Application-level impact, comparison charts, measured overhead and interpretation limits |
| `details.md` | Charts for every use case, repetitions, validation, resource metrics and failures |
| `results.csv` / `results.json` | Machine-readable observations |
| `manifest.json` | Installed versions, data/source hashes, machine, settings and completion status |
| `raw/` and `logs/` | Successful response timings, load-generator output and CAP logs |

Start with `report.md` for the measured cost of adding Oyster to predefined extension points, custom-entity CRUD handlers and after-READ processing. It compares matched native and Oyster workloads using added milliseconds and latency ratios. Positive overhead means Oyster took longer. Accepted and rejected business constraints have separate comparisons. These costs describe individual handlers. Measure requests that compose several handlers in the complete application.

Charts use blue for native handlers, orange for Oyster handlers and gray for no-handler controls. Lower latency and higher throughput indicate better performance. Oyster references link to the handler implementation. Use `details.md` to inspect individual workloads, callback-cost calculations and supporting measurements.

Business constraint handlers compute quantity × unitPrice and accept amounts up to 1,000 or reject with HTTP 400 and “Amount exceeds limit.” The lookup variant reads the limit with one query. Accepted inputs use quantity 2 and unitPrice 10; rejected inputs use quantity 200 and unitPrice 10. Correctness checks verify accepted writes, exact rejection messages, and unchanged persisted rows throughout rejected warmup and measurement.

Synthetic arithmetic remains in selected calculation and large-result stress cases. CQL cases run with zero synthetic iterations and measure their actual queries. READ calculations process returned rows, while scan actions fetch and process pages. Only validated, matching runs support overhead comparisons. Short has one repetition and cannot establish repeat variability. Concurrent clients send one request at a time. Client and server share the machine, and SQLite serializes writes. These results do not establish production capacity.

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

The runner deploys the retained CSVs before starting the first app. When switching apps or starting another independent repetition, it stops CAP, redeploys with the installed CDS CLI, then starts CAP again:

~~~sh
cds deploy --to sqlite:db/benchmark.sqlite
~~~

The model lives in .base/db/schema.cds, a small local npm workspace containing the model shared by both app copies. The retained CSVs live in db/data. The large CSV contains one million rows; the other four contain 1,000 rows each. No frozen database or patched data generator is used. To change the data or model, edit these files; the next deployment picks them up.

Each test has a fixed endpoint. These projections expose the same underlying tables with different handlers:

| Work performed | Example write endpoint | Handler source |
| --- | --- | --- |
| Generic CAP CRUD | /benchmark/NoHandlerWriteRows | CAP generic provider |
| Empty native handler | /benchmark/NativeEmptyWriteRows | srv/benchmark-service.js |
| Empty Oyster handler | /benchmark/OysterEmptyWriteRows | srv/BenchmarkService/OysterEmptyWriteRows/ |
| Native calculation | /benchmark/NativeCalculationWriteRows | srv/benchmark-service.js |
| Oyster calculation | /benchmark/OysterCalculationWriteRows | srv/BenchmarkService/OysterCalculationWriteRows/ |
| Native CQL read | /benchmark/NativeCqlReadWriteRows | srv/benchmark-service.js |
| Oyster CQL read | /benchmark/OysterCqlReadWriteRows | srv/BenchmarkService/OysterCqlReadWriteRows/ |
| Native CQL update | /benchmark/NativeCqlWriteWriteRows | srv/benchmark-service.js |
| Oyster CQL update | /benchmark/OysterCqlWriteWriteRows | srv/BenchmarkService/OysterCqlWriteWriteRows/ |
| Native amount constraint | /benchmark/NativeValidationWriteRows | lib/validation.js |
| Oyster amount constraint | /benchmark/OysterValidationWriteRows | srv/BenchmarkService/OysterValidationWriteRows/ |
| Native constraint with limit lookup | /benchmark/NativeValidationReadWriteRows | lib/validation.js |
| Oyster constraint with limit lookup | /benchmark/OysterValidationReadWriteRows | srv/BenchmarkService/OysterValidationReadWriteRows/ |

Calculation and CQL prefixes also expose SmallRows and LargeRows for READ. Validation projections expose WriteRows for INSERT and UPDATE. Actions have fixed names such as nativeCalculation, oysterCalculation, nativeValidation, oysterValidationRead, nativeScan and oysterScan. Lookup patterns use nativeLookupIndividual, nativeLookupBatch, oysterLookupIndividual and oysterLookupBatch. Declared extension actions delegate to BenchmarkExtensionService. All Oyster handler files are stored in Git and loaded at startup. The runner chooses a URL; it does not rewrite application code or generate handlers.

UPDATE requests cycle through the 1,000 existing WriteRows. Concurrent clients use separate row partitions. INSERT requests allocate distinct keys per case, client and iteration. Warmup, measurement and correctness checks use separate ranges. Lookup keys and action/write auxiliary keys rotate too. This lets multiple cases share a database deployment. READ handlers with auxiliary writes select and update the first SideEffectRows row on both paths, so that comparison includes one SELECT and one UPDATE.

The two app copies are tracked files. Keep their service and library source identical when editing them. Application code, Oyster handlers, the harness and tests use CommonJS with .js filenames.

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

npm test checks the runner, reporting, requests, and real native/Oyster persistence and rollback. npm run verify checks the short protocol's handler activation, results and side effects without load measurement. Verification also deploys the database and needs port 4006 free.

Press Ctrl-C once to stop a benchmark. The runner stops its CAP and load-generator processes, and saves completed observations. An interrupted or failed run exits with a nonzero status. Its report is partial and must not be treated as a complete result. Startup logs identify port conflicts or incompatible dependencies; configuration is not silently changed to bypass them.

Reports, SQLite files, dependencies, and logs are ignored by Git. Share the complete result directory when someone needs to inspect the evidence behind a report.

# CDS-Oyster performance benchmark

Compare plain CAP, native JavaScript handlers, and Oyster WASM handlers locally against SQLite. The repo contains the data and application code. You start the benchmark; the runner deploys the database, starts CAP and the HTTP load generator, stops them, and writes the report.

The [Oyster Performance](examples/oyster-performance-2026-11-07.md) compares completed local and BTP short/long results, including scenario-specific Oyster overhead and repetition ranges. Ordinary business constraints add 0.657–1.024 ms locally and 1.679–4.362 ms in BTP in the three-repetition long tests. Large returned results, sequential queries and concurrent traffic have separate costs.

The [BTP deployment plan](docs/btp-benchmark-plan.md) describes the HANA-backed multitenant provider, separately deployed Oyster extension and CF runner. The [BTP operator guide](docs/btp-operator.md) covers deployment, task execution and report export. The local commands below remain supported without BTP authentication.

## Install and run

Use Node.js 24 and npm on macOS or Linux. On Windows, run these commands inside WSL with Node.js and npm installed in that Linux environment. Run one benchmark at a time, with port 4006 free. Keep the machine plugged in and close other CPU-intensive applications.

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

No global CDS CLI, separate server startup, database download, or data generation is needed. The generated provider and sidecar retain their CDS CLI dependency constraints; the benchmark and Oyster dependencies use latest. Each result records the versions actually installed, hardware, settings, and hashes of the source and CSV files. A local npm lockfile is created by installation but is not tracked; delete it before reinstalling if you want npm to resolve latest again.

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

Completed local examples from November 6, 2026: [short run](examples/local-short-2026-11-06.md) and [long run](examples/local-long-2026-11-06.md). BTP examples from November 7: [short run](examples/btp-short-2026-11-07.md) and [long run](examples/btp-long-2026-11-07.md). The [performance overview](examples/oyster-performance-2026-11-07.md) explains overhead across all four tests. Main example reports sit directly in `examples/`; matching subfolders contain detailed charts, exact CSV observations and metadata with source hashes. Handler links point to the repository implementation. Long includes three independent repetitions and verified processing of the complete million-row table.

The BTP short and long tests took 17 minutes 38 seconds and 107 minutes 8 seconds. All 102 short and 351 long measurements passed, including six whole-table measurements in long. Reports include the HTTPS CF router path between the separate generator and provider. Local and BTP timings have different hardware, databases and request paths, so their difference does not isolate one infrastructure cost.

The terminal prints the path to `reports/bench-<timestamp>/report.md`. Open it in a Markdown preview with Mermaid support. Each test run creates a new directory. To view the report on GitHub, upload the result directory separately.

| File | Purpose |
| --- | --- |
| `report.md` | Application-level impact, comparison charts, measured overhead and interpretation limits |
| `details.md` | Charts for every use case, repetitions, validation, resource metrics and failures |
| `results.csv` / `results.json` | Exact aggregate observations; published examples retain CSV only |
| `manifest.json` | Installed versions, data/source hashes, machine, settings and completion status |
| `raw/` and `logs/` | Failure diagnostics and local CAP lifecycle logs |

Reports are generated once after measurement. Successful cases create no worker logs or per-case JSON. Local runs keep observations in memory until finalization; graceful interruption still writes an incomplete report. CF runs persist compact batches of 20 measurements in tenant HANA, flush the final partial batch and retain diagnostics on failure. There are no cumulative report checkpoints or uploaded source copies. Original archived evidence remains available separately.

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

## Regenerate the performance overview

The overview generator is preserved in the repository. It scans the immediate run subfolders in a directory, selects the newest complete run of each of **local short, local long, BTP short and BTP long**, and generates the combined report without executing benchmarks:

~~~sh
npm run overview
# Regenerate the published overview directly from a fresh checkout:
npm run overview -- examples examples/oyster-performance-2026-11-07.md
# Use a different collection and output location:
npm run overview -- /path/to/runs /path/to/oyster-performance.md
~~~

The default input is reports/ and the default output is reports/oyster-performance.md. Put downloaded BTP run folders alongside local run folders there before generating a new overview. The command prints its four selected inputs. All four types are required; a missing type produces an error. It does not mix local reports/ with examples/ automatically.

Local folders follow bench-<timestamp>; downloaded BTP folders follow cloud-<timestamp>; published examples follow local-short-<date>, local-long-<date>, btp-short-<date> and btp-long-<date>. The folder name helps navigation. Classification uses manifest.settings.suite and manifest.environment.execution (cloud means BTP; older local manifests omit execution). Newest means the greatest manifest.startedAt timestamp, independent of copy time or filesystem modification time. Renaming an exported folder does not change its classification.

Filtered runs, rate-limited pilots, failed or interrupted runs, missing completion timestamps and inconsistent record totals are excluded. Eligible runs must have runSummary.passed=true and passed correctness checks for every observation. A full run with explicitly changed measurement settings remains eligible; the overview records those settings. Equal timestamps are resolved by folder path. Invalid evidence is skipped with a diagnostic. It reads results.json when present, otherwise the published results.csv, including both legacy flattened and current CSV formats.

Implementation: [overview-input.js](bench/overview-input.js) handles discovery and evidence loading; [overview.js](bench/overview.js) matches equivalent native/Oyster workloads using the individual report's matching rules; [overview-view.js](bench/overview-view.js) renders tables, findings and charts. Differences and percentages are calculated within each repetition pair and averaged equally. Unmatched or duplicate pairs do not support conclusions. Headline values, timings and ranges come from the selected evidence.

The output has links to all four individual reports at the top. A matching support folder contains details.md, comparisons.csv and evidence.json, including input identities and hashes. Actual benchmark runs retain their own report.md inside their run folder. Only published examples place their main reports directly in examples/ with matching support subfolders. Generating an overview does not move or rewrite any individual benchmark report.

## Run BTP benchmarks with the shared user

The shared runner is available on the existing deployment, test tenant and HANA database. Participants need Node.js, this repository and the **colleague-demo** username and password supplied privately by the owner. It reuses the earlier giveaway login. They do not need a BTP account, CF login, service binding or application redeployment. The owner setup below explains how to enable or update the same arrangement.

~~~sh
npm install
npm run btp -- start short
npm run btp -- status
# After short finishes, start long:
npm run btp -- start long
npm run btp -- status
# List the 20 newest stored runs while the runner is idle:
npm run btp -- runs
# Download the five final report/evidence files into reports/cloud-<timestamp>/:
npm run btp -- download RUN_UUID
npm run overview
~~~

Every command prompts once for the password with input hidden. The client keeps it in memory; no password is placed in source, shell arguments, environment variables or a local login file. The default endpoint is https://d034457-oyster-benchmarks.cfapps.eu12-002.hana.ondemand.com. Use --url HTTPS_ORIGIN or --user USERNAME to select another configured shared deployment. The README publishes the username and endpoint, while the password is shared privately.

Start returns immediately; measurements continue in CF after the terminal closes. Status shows the active run UUID and completed/planned counts. Run only one preset at a time. A busy runner returns HTTP 409. All participants share that one runner and test tenant. Short and long use exactly the same benchmark implementation as owner CF tasks. For a bounded deployment check, use npm run btp -- start pilot; pilots are excluded from the overview.

Downloads verify each file's SHA-256 identity and contain manifest.json, results.json, results.csv, report.md and details.md. After verification, Markdown is regenerated from those measurements with handler links into the checkout, including for historical runs whose original reports linked archived source copies. Measured evidence remains unchanged; the manifest's source hashes identify the measured implementation. The output directory must be new. An optional output root follows the UUID: npm run btp -- download RUN_UUID /path/to/runs. Downloads and history listing wait until the runner is idle to avoid adding evidence traffic to measured provider requests. Status is served from runner memory. HANA retains completed reports across runner restarts; in-memory progress belongs to the current runner process. Failed or interrupted runs remain separate from headline results.

The authenticated HTTP interface is POST /runs with {"suite":"short"}, {"suite":"long"} or {"suite":"pilot"}; GET /status; GET /runs; GET /runs/RUN_UUID/files; and GET /runs/RUN_UUID/files/FILENAME. POST requires a CSRF token fetched with X-CSRF-Token: Fetch on GET /status. The npm client handles this. Provider URLs, tenant IDs, arbitrary filters and shell commands cannot be supplied through shared access.

## Enable shared BTP access as the deployment owner

The [operator guide](docs/btp-operator.md) documents the full CAP/MTX/HANA deployment, subscription and Oyster extension lifecycle, using the installed CDS CLI and cds up. The ordinary mta.yaml retains the stopped task-only runner. The optional [mta.shared.yaml](mta.shared.yaml) enables its public authenticated route and one running instance. It adds no CF app or application dependency.

The shared runner allocates 1,024 MiB, bringing the provider, sidecar, router and runner allocation to 3,328 MiB within the existing 4,096 MiB quota. The benchmark child process shares the runner app's memory allocation. Keep this to one instance and avoid owner CF tasks while it runs. An additional 1,024 MiB CF task would exceed the quota. Successful shared runs remove their local working files after final HANA persistence; downloads use temporary files that are removed after transfer.

First target the benchmark space and create the login service. Enter the existing giveaway password to reuse it, or choose a new password and distribute it privately:

~~~sh
cf login --sso -a https://api.cf.eu12-002.hana.ondemand.com
cf target -o d034457-xtguide-eu12 -s oyster-performance
npm run btp:setup-login
~~~

The setup command creates oyster-perf-login with the username, HTTPS origin and salted scrypt verifier. The plaintext password is never stored in CF configuration or the repository. Use npm run btp:setup-login -- --update to rotate it, then restart the shared runner so it reads the new verifier. Custom --url and --user options must match the runner route and participant commands.

For an existing deployed provider, update only the runner, preserving the measured provider, tenant and extension:

~~~sh
npm run cloud:build
cf stop oyster-perf-runner
cf push oyster-perf-runner --no-manifest --no-route --no-start -p gen/runner -m 1024M -k 2048M
cf bind-service oyster-perf-runner oyster-perf-login
cf set-env oyster-perf-runner BENCHMARK_LOGIN_SERVICE oyster-perf-login
cf map-route oyster-perf-runner cfapps.eu12-002.hana.ondemand.com --hostname d034457-oyster-benchmarks
cf set-health-check oyster-perf-runner http --endpoint /health
cf start oyster-perf-runner
~~~

Wait for an active benchmark to finish before stopping or updating the runner. This targeted update avoids rebuilding the CAP provider and its CSV package. The existing runner retains its XSUAA binding and BENCHMARK_* tenant configuration.

The installed CDS CLI also supports the shared overlay directly for a full deployment: npx cds up --to cf --overlay mta.shared.yaml. The operator guide lists the ignored local module locks required by that MTA build. If using a freshly built gen/mta.tar, selective MTA deployment is cf deploy gen/mta.tar -e mta.shared.yaml -m oyster-perf-runner -r oyster-perf-login.

Validate access with npm run btp -- start pilot, poll status, download its final reports and inspect passed correctness and persistence before starting the full presets. The CF runner uses its XSUAA binding to obtain tokens for the fixed test tenant. Shared credentials grant benchmark trigger and report access, without CF platform or extension-administration access.

Verified November 7, 2026: the giveaway login started the 28-case pilot, status reported progress, all cases passed, and the five final files downloaded with verified hashes and portable source links. The pilot took about 4½ minutes. Sampled generator and provider RSS peaks were 90.8 and 699.0 MiB respectively; the shared runner and provider each retain a 1,024 MiB allocation. These are bounded setup checks, separate from the full performance results.

Owner-only task execution remains available when the shared runner is stopped:

~~~sh
cf stop oyster-perf-runner
cf run-task oyster-perf-runner --name short -m 1024M -k 2048M --command 'node task.js --suite short'
# Wait for completion before starting long.
cf run-task oyster-perf-runner --name long -m 1024M -k 2048M --command 'node task.js --suite long'
~~~

The operator guide covers owner export through cds bind and cloud:export. Resume shared access with cf start oyster-perf-runner after all owner tasks finish.

## Application and data setup

All application projects live under apps/: baseline-plain/ is the local control without Oyster, extension/ holds the Oyster extension and its pulled base model, provider/ holds the CAP/MTX provider and shared data, and runner/ holds the CF benchmark runner. The benchmark harness, local server bootstrap and report generators live in bench/. The root contains workspace configuration and commands, with no application scaffold. Generated local SQLite storage lives in apps/provider/db/benchmark.sqlite.

The local Oyster application lives in apps/extension; apps/baseline-plain/package.json declares only CAP and SQLite. Both reuse the provider model and native implementations in apps/provider. CAP discovers plugins normally from each application's dependencies. Native handlers run in the Oyster application without a sandbox handler, so native-versus-Oyster comparisons share the same plugin environment. The separate plain-CAP app supplies the control without Oyster. The repository root orchestrates these applications through npm commands.

Both applications use the same database:

- Oyster application: ../provider/db/benchmark.sqlite, relative to apps/extension.
- Plain baseline: ../provider/db/benchmark.sqlite, relative to apps/baseline-plain.

The runner deploys the retained CSVs before starting the first app. When switching apps or starting another independent repetition, it stops CAP, redeploys with the installed CDS CLI, then starts CAP again:

~~~sh
npm run deploy
~~~

The provider owns the model in apps/provider/db/schema.cds and the retained CSVs in apps/provider/db/data. The plain baseline imports that model; the Oyster extension uses the provider model pulled into apps/extension/.base by the CDS CLI. The large CSV contains one million rows; the other four contain 1,000 rows each. No frozen database or patched data generator is used. To change the data or model, edit the provider files. Deployment picks up retained CSV changes. After provider model changes, refresh the extension base with cds pull from the running local sidecar before testing the Oyster application.

Each test has a fixed endpoint. These projections expose the same underlying tables with different handlers:

| Work performed | Example write endpoint | Handler source |
| --- | --- | --- |
| Generic CAP CRUD | /benchmark/NoHandlerWriteRows | CAP generic provider |
| Empty native handler | /benchmark/NativeEmptyWriteRows | apps/provider/srv/benchmark-service.js |
| Empty Oyster handler | /benchmark/OysterEmptyWriteRows | apps/extension/srv/BenchmarkService/OysterEmptyWriteRows/ |
| Native calculation | /benchmark/NativeCalculationWriteRows | apps/provider/srv/benchmark-service.js |
| Oyster calculation | /benchmark/OysterCalculationWriteRows | apps/extension/srv/BenchmarkService/OysterCalculationWriteRows/ |
| Native CQL read | /benchmark/NativeCqlReadWriteRows | apps/provider/srv/benchmark-service.js |
| Oyster CQL read | /benchmark/OysterCqlReadWriteRows | apps/extension/srv/BenchmarkService/OysterCqlReadWriteRows/ |
| Native CQL update | /benchmark/NativeCqlWriteWriteRows | apps/provider/srv/benchmark-service.js |
| Oyster CQL update | /benchmark/OysterCqlWriteWriteRows | apps/extension/srv/BenchmarkService/OysterCqlWriteWriteRows/ |
| Native amount constraint | /benchmark/NativeValidationWriteRows | apps/provider/srv/lib/validation.js |
| Oyster amount constraint | /benchmark/OysterValidationWriteRows | apps/extension/srv/BenchmarkService/OysterValidationWriteRows/ |
| Native constraint with limit lookup | /benchmark/NativeValidationReadWriteRows | apps/provider/srv/lib/validation.js |
| Oyster constraint with limit lookup | /benchmark/OysterValidationReadWriteRows | apps/extension/srv/BenchmarkService/OysterValidationReadWriteRows/ |

Calculation and CQL prefixes also expose SmallRows and LargeRows for READ. Validation projections expose WriteRows for INSERT and UPDATE. Actions have fixed names such as nativeCalculation, oysterCalculation, nativeValidation, oysterValidationRead, nativeScan and oysterScan. Lookup patterns use nativeLookupIndividual, nativeLookupBatch, oysterLookupIndividual and oysterLookupBatch. Declared extension actions delegate to BenchmarkExtensionService. All Oyster handler files are stored in Git and loaded at startup. The runner chooses a URL; it does not rewrite application code or generate handlers.

UPDATE requests cycle through the 1,000 existing WriteRows. Concurrent clients use separate row partitions. INSERT requests allocate distinct keys per case, client and iteration. Warmup, measurement and correctness checks use separate ranges. Lookup keys and action/write auxiliary keys rotate too. This lets multiple cases share a database deployment. READ handlers with auxiliary writes select and update the first SideEffectRows row on both paths, so that comparison includes one SELECT and one UPDATE.

The two local entry points are tracked wrappers. Edit native models, services and libraries in apps/provider, and Oyster handlers in apps/extension; the wrappers reuse that source. Application code, Oyster handlers, the harness and tests use CommonJS with .js filenames.

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

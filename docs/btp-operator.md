# Run the benchmark on BTP

The cloud deployment uses one Oyster-enabled CAP provider, an MTX sidecar, an approuter and a separate CF task runner. The subscribed test tenant stores fixture data, reports and raw evidence in HANA. The runner calls the provider through its HTTPS CF route with a real tenant OAuth token; both processes run in the benchmark space. Reports include TLS and CF router traversal in their measurement boundary. Local SQLite commands remain documented in the [README](../README.md).

## Prerequisites

Use Node.js 24, npm, the CF CLI with the MultiApps plugin, and the Cloud MTA Build Tool (`mbt`). The repository installs its CDS CLI through npm. The current deployment targets the user-approved Canary org `d034457-xtguide-eu12`, space `oyster-performance`, API `https://api.cf.eu12-002.hana.ondemand.com`. The org quota is 4,096 MiB.

The provider and sidecar each allocate 1,024 MiB; the approuter allocates 256 MiB. The base MTA keeps the runner stopped without a public route. A running 1,024 MiB benchmark task brings the allocation to 3,328 MiB. The optional shared overlay instead keeps that same runner app running, with a giveaway login and asynchronous trigger/status/download endpoints. The [README](../README.md#run-btp-benchmarks-with-the-shared-user) documents participant commands and owner setup. Stop the shared runner before using owner CF tasks; running both would exceed the quota. Avoid overlapping deployment/upgrade tasks and measurements.

The replacement HANA database is `25a70e86-5e59-4a68-b3ee-d35e9272c85c`, with 32 GB memory and 160 GB storage. Its benchmark-space mapping and tenant HDI provisioning were verified. The test subscriber is `23f8432a-6464-445a-966a-415a4a0ae3f9`, subdomain `d034457-xtguide-eu12-test`. The separate demonstration control subscriber has no Oyster extension.

## Build and deploy

Install dependencies, select the CF target, and create the ignored per-module locks needed by the generated MTA npm-ci builders:

```sh
npm install
cf login --sso -a https://api.cf.eu12-002.hana.ondemand.com
cf target -o d034457-xtguide-eu12 -s oyster-performance
npm install --package-lock-only --ignore-scripts --workspaces=false --prefix apps/provider
npm install --package-lock-only --ignore-scripts --workspaces=false --prefix apps/provider/mtx/sidecar
npm install --package-lock-only --ignore-scripts --workspaces=false --prefix apps/provider/.deploy/app-router
npm install --package-lock-only --ignore-scripts --workspaces=false --prefix apps/runner
npx cds up --to cf
```

Locks remain local and ignored. Retain their hashes and the built MTA archive with deployment evidence. This preserves fixed build inputs without adding lockfiles to Git. The standard CAP build packages tenant database resources; the MTA also includes the retained CSVs for fixture restoration.

The deployed tenant subscriptions and extension were already established through BTP subscription management and `cds pull` / `cds push`. After a provider model change, refresh the extension's base model from the deployed sidecar and activate its checked-in handlers through the same CLI lifecycle. Provider and sidecar artifacts contain native handlers; the test tenant receives the Oyster handler extension.

The current MTA selects `BENCHMARK_NETWORK_PATH=cf-router` and the provider's HTTPS route. Direct container networking was unavailable to this user: policy creation was denied for missing `network.write`, and a runner task obtained `ECONNREFUSED` from the internal route despite resolving its hostname. The HTTPS connectivity check reached the protected service with HTTP 401.

If a foundation administrator later enables direct networking, the standard policy command is:

```sh
cf add-network-policy oyster-perf-runner oyster-perf-srv --protocol tcp --port 8080
```

The task inherits its XSUAA binding. Subscriber identity, traffic path and provider URL are nonsecret MTA environment settings. Tokens and client secrets are read in memory and are excluded from commands and saved evidence. The current technical binding grants runner, recorder and fixture administrator scopes, plus extension deployment authority. Setup and extension administration occur outside timed execution.

The provider uses warning-level OData and REST request logging during cloud runs. This limits request-log volume at high rates. Provider state in each manifest records the effective logging configuration.

## Run and export

Task submission and HANA export have been verified with a two-case live pilot. The representative pilot covers 28 workloads and forces OAuth renewal outside timing. Its load is capped at 3 requests per second and uses one client.

```sh
cf run-task oyster-perf-runner --name pilot -m 1024M -k 2048M --command 'node task.js --pilot --suite short --warmup 1 --duration 5 --repetitions 1'
cf tasks oyster-perf-runner
cf logs oyster-perf-runner --recent
```

Future runs upload one compact run metadata artifact and immutable batches of 20 aggregate measurements. Successful cases produce no per-case JSON, worker logs or response timing files. Source hashes replace uploaded source copies. Reports are generated once at finalization, retaining all charts, exact statistics, resource metrics and correctness outcomes. The final descriptor contains report artifact identities and hashes. Successfully uploaded staging files are removed locally; failed uploads retain recovery data. Final-upload interruption can require a second report archive to record the interrupted status.

Completion and graceful interruption flush the remaining batch. Between uploads, abrupt task loss can lose up to 19 unflushed measurements; loss during upload can affect the whole current batch of 20. The pilot uploads and verifies its first measurement early, outside timing. Historical HANA archives and their original checkpoint history remain intact.

The task logs its HANA run UUID. Measurement batches are committed between timing windows; final reports are committed before exit. Export them through the public HTTPS provider endpoint using the CDS CLI to supply the existing application binding in memory:

```sh
npx cds bind -a oyster-perf-runner
BENCHMARK_EXPORT_URL=https://d034457-oyster-perf-srv.cfapps.eu12-002.hana.ondemand.com \
BENCHMARK_SUBDOMAIN=d034457-xtguide-eu12-test \
BENCHMARK_TENANT_ID=23f8432a-6464-445a-966a-415a4a0ae3f9 \
npx cds bind --exec -- npm run cloud:export -- RUN_UUID /absolute/output/directory
```

The private binding file is ignored and stores binding references. CDS retrieves credentials dynamically from the benchmark XSUAA service key, creating that key on the first bind if needed. The installed CLI requires a service key even when selecting an app with `-a`; `--no-create-service-key` is suitable only after the key exists. Export verifies original file byte counts and SHA-256 hashes, and lists pending uploads in `export.json`. CF task containers cannot be accessed after exit; HANA is the durable source. The public export path is outside measured traffic.

After the pilot passes, run the complete presets sequentially. On November 7 the user explicitly directed proceeding without a current Canary coordination policy:

```sh
cf run-task oyster-perf-runner --name short -m 1024M -k 2048M --command 'node task.js --suite short'
# Wait for the short task to succeed and verify its export before starting long.
cf run-task oyster-perf-runner --name long -m 1024M -k 2048M --command 'node task.js --suite long'
```

Short contains 102 cases. Long contains 345 ordinary measurements plus six whole-table measurements. Full presets use closed-loop concurrency without the pilot rate cap. They finish their planned cases without an elapsed-time cutoff. Inspect errors, authentication, provider instance/extension state, rejected-write hashes and generator resource measurements before treating a result as complete.

## Verification status

Shared access was enabled with a targeted runner-only update on November 7. The earlier colleague-demo verifier was reused in oyster-perf-login. Authenticated trigger/status/download passed a live 28-case pilot, run 3aba2727-9bea-4d08-ac89-74e47d932738. All five final files passed hash verification; source links were regenerated through the canonical renderer. Two OAuth renewals occurred outside timing. The runner remains available at https://d034457-oyster-benchmarks.cfapps.eu12-002.hana.ondemand.com. See the README for participant commands and the optional CDS deployment overlay.

The complete application deployed through `cds up`. Both test and unextended demonstration tenants are subscribed. The test tenant has all 35 checked-in Oyster handlers. Native/Oyster HANA execution, exact constraint decisions and rollback passed. All five fixture tables match their CSV identities, including one million LargeRows. Fixture restoration preserves stored artifacts, extension activation and the provider instance.

The final source suite passes 160 tests. A clean installed source copy also passed all 121 local long-preset correctness cases without BTP authentication. The live representative 28-case pilot verified tenant OAuth renewal, resource recording and HANA evidence readback after task exit.

Both full tests passed with zero failed records. [Short](../examples/btp-short-2026-11-07.md) validated 102 measurements in 17 minutes 38 seconds. [Long](../examples/btp-long-2026-11-07.md) validated 345 ordinary measurements and six whole-table measurements in 107 minutes 8 seconds across three repetitions. Their original HANA run identifiers are `991d0f30-50e8-42ab-8b37-3de44e98c021` and `133b2e8f-24de-49a9-ba4c-8e76f052ca19`. Post-task export verified 1,311 short artifacts and 4,263 long artifacts, all recorded source hashes and report links. All 68 short and 86 long report diagrams rendered. The [performance overview](../examples/oyster-performance-2026-11-07.md) compares these results with both completed local tests and includes reviewable paired observations.

The long test’s recorded generator RSS peak is 409.6 MiB and provider RSS peak is 828.7 MiB, each below its 1,024 MiB allocation. Resource samples and repetition ranges remain in the saved evidence. These observations describe this fixed deployment and do not establish production capacity.

The first representative pilot failed with out-of-memory status after routine state repeated full restoration snapshots. The first long attempt stopped after 187 valid raw measurements while retaining 1.88 GB of uploaded checkpoint copies on a 2 GiB task disk. Both failed attempts were exported and finalized separately. Compact routine state and release of successfully uploaded local checkpoint copies passed regressions and live evidence-retention checks. The completed long retry uses the original memory and disk settings. Failed attempts and pilots are excluded from headline performance conclusions.

The supplied PerfSizer documents contain conflicting notification thresholds. The user explicitly directed proceeding on November 7 without a current Canary coordination policy. This execution decision does not verify either threshold. No platform-team messages were sent.

Do not delete or reprovision the test tenant or its database until retained evidence has been exported and its file hashes verified. Fixture restoration targets only the five benchmark tables and preserves report storage.

## Compact-storage validation

The November 7 storage revision passed all 164 source tests and a live 28-case rate-limited pilot after selective runner deployment. Its HANA run is `fd40b02c-baf5-4b13-b696-48f10bdddc6f`. Export verified 10 complete artifacts and no pending uploads. The three measurement batches contain 1, 20 and 7 records, byte-equivalent as parsed observations to the final results. Exact rejection messages, rollback checks, provider-instance continuity and final report hashes passed verification.

The task retained six final local files totaling 332,422 bytes, with no successful per-case files, source copies or cumulative checkpoints. Its runner-process RSS peak was 108.95 MiB at the pilot rate. Full-load resource estimates still come from the historical complete long benchmark. The four dated examples retain all 312 original charts; the compact cloud long example has four files totaling 1,290,861 bytes. Local short/long entry points remain available without BTP authentication.

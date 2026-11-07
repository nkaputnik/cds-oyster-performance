# BTP Benchmark Implementation Plan

> **For agentic workers:** Use the subagent-driven-development workflow for independent tasks and review each change against the approved design before proceeding. Git mutations require a separate explicit instruction; work on the authorized source changes without automatically branching, staging, committing or pushing.

**Goal:** Implement the approved Canary CAP/MTX benchmark with a CF runner and tenant HANA storage for reports and evidence.

**Architecture:** One Oyster-enabled provider hosts native references, no-handler controls and tenant-deployed sandbox handlers. An MTX sidecar manages subscriptions and extensions. A separate CF task generates timed traffic and persists compressed evidence to dedicated tenant tables between measurements.

**Tech stack:** CAP Node.js, CommonJS, CDS-Oyster, MTXS, HANA Cloud, XSUAA, SaaS Registry, Cloud Foundry and the existing Node/autocannon harness.

The design is [btp-benchmark-plan.md](btp-benchmark-plan.md). The user approved it and then selected the tenant HANA database for durable storage. This checklist records execution progress; code and cloud verification must meet each acceptance gate before its checkbox is completed.

## 1. Cloud protocol selection

Files: modify `bench/scenarios.js`; create `test/cloud-scenarios.test.js`. Preserve all existing local behavior.

- [x] Add a failing test for an exported `cloudSuite(name)` function.
- [x] Verify failure with `node --test test/cloud-scenarios.test.js`.
- [x] Implement cloud selection using the existing `suite` and `scenario` constructors. Convert `cap-baseline` to `oyster-idle`; deduplicate by the full scenario and normalized load, retaining mixed traffic and all accepted/rejected comparisons.

```js
function cloudSuite(name) {
  const seen = new Set();
  return suite(name).flatMap(input => {
    const { id, expectedCallbacks, benchmarkLoad, ...work } = input;
    const mapped = scenario({ ...work, mode: input.mode === 'cap-baseline' ? 'oyster-idle' : input.mode });
    const load = benchmarkLoad || { kind: 'vus', value: 1 };
    const key = JSON.stringify({ scenario: mapped, load });
    if (seen.has(key)) return [];
    seen.add(key);
    if (benchmarkLoad) mapped.benchmarkLoad = { ...benchmarkLoad };
    return [mapped];
  });
}
```

- [x] Export `cloudSuite` alongside the existing exports.
- [x] Verify 102 short and 115 long cases per repetition, no `cap-baseline`, no missing native/Oyster constraint pairs, and retained no-handler action concurrency 8/32 and mixed traffic concurrency 1/8/32. Verify local suite output remains unchanged.
- [x] Run `node --test test/cloud-scenarios.test.js test/scenarios.test.js test/constraints.test.js`; review specification compliance and code quality.

## 2. Canonical provider and extension scaffold

Files: create `apps/provider/`, `apps/extension/`; update the root workspace declarations and entry points affected by source relocation. Keep `apps/baseline-plain/` local only.

- [x] Use the installed CDS CLI to create the CommonJS provider and cloud facets. The inspected command is:

```sh
cds init provider --add cjs,multitenancy,extensibility,hana,xsuaa,approuter,mta
```

- [x] Inspect generated provider/sidecar profiles and use them directly. Add Oyster to both dependency declarations, include the sidecar in the root workspace, and resolve one CAP runtime from the hoisted installation.
- [x] Put the existing database model and retained CSVs under the provider's `db/`. Retain the `perf` namespace and service request contracts. Native service wiring and libraries belong to the provider; sandbox service folders belong to the extension.
- [x] Scaffold the extension with `cds add extension`, then pull the actual provider model. Preserve checked-in handlers and CommonJS syntax. Exclude benchmark evidence and fixture administration from extension projections.
- [x] Keep local comparison entry points working through explicit source/model references; avoid another copied provider tree.
- [x] Compile the provider, start the sidecar and main app using documented MTX profiles, and subscribe local test and control tenants.
- [x] Activate the real extension using the CDS CLI, then verify accepted/rejected constraints, CQL callbacks, rollback, source links and unextended-tenant isolation.
- [x] Run the existing suite and the new MTX integration checks. Build production artifacts and inspect provider/sidecar dependency, model and source contents before cloud deployment.

## 3. Tenant HANA evidence storage

Files: provider evidence model/service; shared runner archive/storage adapter; evidence round-trip and reset-isolation tests.

- [x] Define dedicated run, artifact and artifact-part entities outside the `perf` fixture namespace. Store metadata, paths, byte lengths, SHA-256 identities, compression and bounded binary chunks.
- [x] Expose a separately authorized evidence service. Require a tenant JWT and a recorder role; do not expose the tables to the Oyster benchmark services.
- [x] Compress files in the runner, upload completed case artifacts after timing stops, and await completion before the next warmup. Do not perform per-request database logging.
- [x] Validate ordered chunk retrieval, recombination and source hashes. A report archive is complete only after all its parts and final metadata are stored.
- [x] Ensure fixture reset targets only benchmark data tables; HANA resets preserve evidence. Interrupted-run persistence passed source tests. Live CF task-exit durability remains the pilot gate below. Reprovisioning a tenant containing evidence requires verified export first.
- [x] Exercise actual CAP HTTP writes and reads locally, then repeat the archive round trip on HANA before trusting durable storage.

## 4. CF readiness and deployment packaging

- [x] Verify the selected D034457 Canary org, internal domain, required service offerings, memory quota and new-space HANA mapping.
- [x] Record the resource budget, complete the user-authorized retirement of the old customization deployment, and verify the benchmark fits the released capacity.
- [x] Generate the deployment descriptor with CDS CLI, then add the runner task module and explicit resource settings. Keep the separate plugin-free runtime out of the MTA.
- [x] Resolve reproducible build inputs without silently committing lockfiles. Inspect and locally build the complete deployment artifact.
- [x] Deploy only the benchmark application and its resources to the new benchmark space. Subscribe the chosen test tenant, activate the recorded code extension, and verify tenant HANA and signed HTTP execution.

## 5. Remote fixture and CF runner

- [x] Introduce local/cloud fixture adapters for inspection, reference rows, checksums and lifecycle operations. Preserve existing exact rejection and rollback checks.
- [x] Use actual tenant HANA reads for cloud reference checks. Verify one-million-row import and repeat fixture restoration twice.
- [x] Add tenant OAuth with renewal outside timed windows, explicit CF traffic-path selection, remote metrics control and instance/extension-state checks.
- [x] Run the existing load worker in a separate CF task container and persist completed observations through the HANA evidence service. Interrupted-run persistence passed source regressions with real SIGTERM.
- [x] Detect unrelated HTTP 400, authentication errors, HTTP 429, transport errors, restarts and extension quarantine as failed runs.

## 6. Full execution and publication

- [x] Calibrate a small HANA pilot and confirm generator headroom, resource metrics and durable report extraction.
- [x] Resolve the execution decision: the user explicitly directed proceeding without a current Canary policy on November 7. No platform-team messages are authorized.
- [x] Run 102 short cases, followed by 345 ordinary long measurements and six whole-table measurements, with paired repetitions and recorded durations.
- [x] Render report diagrams, validate source links and preserve all evidence. Separate cloud HANA findings from existing local SQLite examples.
- [x] Write the cloud operator guide and prepare new dated BTP examples for the repository.
- [x] Produce the umbrella report comparing local/cloud and short/long results, with scenario-specific native/Oyster latency, added milliseconds, percentage overhead and repetition variation.

## Current verification

The approved deployment is complete in Canary org `d034457-xtguide-eu12`, space `oyster-performance`. The old disposable customization deployment was retired under explicit deletion approval. Replacement HANA `25a70e86-5e59-4a68-b3ee-d35e9272c85c` is ready at 32 GB / 160 GB with the verified benchmark-space mapping. Provider, sidecar and approuter are running. The staged runner stays stopped without a route and runs benchmark tasks at 1,024 MiB memory / 2,048 MiB disk. The total allocation with a task is 3,328 MiB against the 4,096 MiB org quota.

Actual `cds up --to cf` deployed the application. `cds pull` and `cds push` activated all 35 checked-in Oyster handlers for the subscribed test tenant. Authenticated native/Oyster HANA operations, accepted/rejected constraints, rollback and the unextended demonstration control passed. All five fixture CSV identities matched, including one million LargeRows. Verified resets restored fixture data while preserving evidence, extension activation and the provider instance.

Direct container networking was denied for missing foundation `network.write` authority. The runner uses the explicit HTTPS CF router path within the same space. Reports include TLS and router traversal. The user authorized full execution without a current Canary coordination policy. No platform-team message was sent.

The representative 28-case pilot and complete short/long tests passed. Short validated 102 records in 17 minutes 38 seconds. Long validated all 345 ordinary measurements and six full-table measurements across three repetitions in 107 minutes 8 seconds. Both have zero failed records and preserve the provider instance and healthy extension. Post-task HANA exports verified 1,311 short artifacts and 4,263 long artifacts. All 68 short and 86 long diagrams rendered, and the long reports resolve all 960 source/evidence links.

Earlier failed attempts remain separate from the completed performance results. An out-of-memory pilot exposed full restoration snapshots repeated in routine state. State now selects compact lifecycle metadata and preserves full snapshots through the owned reset-status endpoint. A partial long attempt exposed accumulation of uploaded checkpoint copies on the task disk. Successfully uploaded temporary copies are now released locally while all HANA checkpoint history remains. Regressions, historical-artifact readback and a live two-repetition retention pilot verified both corrections. The successful full long retry uses the original resource allocations.

The final source suite passes all 160 tests. A clean installed source copy previously passed all 121 documented local long correctness cases without BTP authentication. Local short/long entry points and SQLite fixture deployment remain supported.

Dated [BTP short](../examples/btp-short-2026-11-07.md) and [BTP long](../examples/btp-long-2026-11-07.md) examples contain exact CSV observations, complete report charts and compact metadata with source hashes. Handler links resolve to the repository implementation; original archives remain separate. The [performance overview](../examples/oyster-performance-2026-11-07.md) compares all four completed local/cloud and short/long tests. Its 396 matched observations and derived calculations passed independent evidence review. Git staging, committing and pushing remain separate from this completed file preparation.

The test tenant contains durable evidence. Export and verify that evidence before any tenant or database reprovisioning. Fixture restoration targets only the five benchmark tables and preserves report storage.

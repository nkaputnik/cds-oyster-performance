# BTP benchmark design and phased plan

Approved design, November 6, 2026. Implementation is in progress. The user subsequently selected the test tenant's HANA database for durable reports and evidence. Deployment remains subject to the resource and verification gates below.

## Goal and target

Run the native/Oyster performance comparisons in a real multitenant CAP deployment on SAP BTP, using HANA-backed subscriber data and Oyster handlers activated through the extension lifecycle. Generate the timed requests inside Cloud Foundry and retain reproducible reports and raw evidence outside disposable containers.

The user selected the existing personal eu12 organization, `d034457-xtguide-eu12`, with a new dedicated benchmark space, and confirmed that global account D034457 runs on Canary. The API currently configured in the CLI is `https://api.cf.eu12-002.hana.ondemand.com`. The space name proposed here is `oyster-performance`. The current `customization` applications, subscriptions, databases and extensions belong to earlier work.

CF and native BTP login have been restored. Live inventory confirms the internal domain and required application services. The November 6 recovery check found an effective 4,096 MB org quota and no remaining old CF apps or services. Global runtime entitlement is 4 GB. The user explicitly confirmed retiring the old apps, subscriptions and their data, and recreating their HANA database with the new benchmark space mapping. The replacement `d034457-oyster-performance-hana` (`25a70e86-5e59-4a68-b3ee-d35e9272c85c`) is ready and usable at the approved 32 GB / 160 GB size. A temporary empty HDI container provisioned successfully using the benchmark space's default HANA selection, verifying effective mapping. The target is user-confirmed Canary; apply the Canary load-coordination guidance below.

## What the current implementation establishes

- The local short preset completed 108 measurements in 698.491 seconds. The long preset completed 363 ordinary measurements and six whole-table measurements in 5024.330 seconds. Both had zero failed records. These are local SQLite observations.
- The retained fixture has 1,000 SmallRows, 1,000 WriteRows, 1,000 LookupRows, 1,000 SideEffectRows and 1,000,000 LargeRows. Its CSV files total approximately 26.9 MB.
- `bench/fixture.js` deploys and directly inspects a local SQLite file. `bench/verify.js` also reads that file for reference values and write-state checks.
- `bench/process.js` starts local child processes. Resource measurements use IPC from `bench/server.js`, and the load generator currently has no tenant OAuth lifecycle.
- The report generator names SQLite and local hardware explicitly. It needs cloud environment metadata and separate result grouping.
- The local plugin-free CAP control established negligible installation overhead. The user explicitly excluded a separate plugin-free runtime from cloud scope on November 6 because the additional deployment would not yield actionable data.

Installed local versions inspected during planning include CAP 10.2.2, CDS DK 10.2.1, MTXS 4.2.1 and CDS-Oyster 0.5.6. Cloud runs must record the versions actually deployed.

The installed Oyster implementation supports standalone development as well as multitenant execution. For this benchmark, MTX is required to exercise the real cloud extension deployment and tenant model lifecycle. Prior November 5 verification in this account demonstrated an Oyster 0.5.6 provider and sidecar, a subscribed HANA-backed test tenant and separately activated tenant code. It is evidence for the approach, not a current resource inventory or permission to alter those existing applications.

## Runner options

| Approach | Benefit | Cost or limitation | Recommendation |
| --- | --- | --- | --- |
| Dedicated CF runner application, executed as CF tasks | Reuses our request allocation, expected business rejection checks, scenarios and report evidence; generator has its own container | Requires authenticated requests, internal networking and durable artifact storage | Preferred starting point |
| PerfSizer Custom Run | Managed load orchestration, dashboards, response assertions, CF CPU/memory collection and optional external HANA metrics | Requests leave the PerfSizer cluster through public NAT; porting our complete fixture and evidence semantics remains work | Useful later for selected end-to-end and load-profile checks |
| PerfSizer BYOS with k6 | Repository-backed custom scripts, configurable load patterns, optional CF runtime metrics and downloadable output artifacts | Currently k6 only, with no third-party k6 extensions; our Node/autocannon runner cannot be used unchanged | Consider when k6-based or managed recurring tests become a goal |

The user supplied the [Canary dashboard](https://dashboard.canary.perfsizer.cloud.sap/#/home) and [quick-start documentation](https://pages.github.tools.sap/perfsizer/getting-started/quick-start/). The Pages site requires GitHub Enterprise sign-in; the documentation source was successfully read through the existing GitHub Enterprise CLI login at revision `31782ba6d31e1030a6ac0f8a321bd2e4614871da` of `perfsizer/perfsizer.github.tools.sap`. No PerfSizer project, credentials or run was created.

The verified documentation supports these conclusions:

- PerfSizer supports CF applications and obtains resource metrics from the CF stats API using separate runtime credentials. Its ordinary Custom Run can check HTTP status, JSON body values and response headers.
- Its documented traffic leaves a Kubernetes cluster through public NAT addresses. No inspected guide describes placing its generator in our CF space or accessing our CF internal route. It can reduce laptop latency, but that is a different request path from the proposed container-to-container benchmark.
- BYOS means bringing a **k6 script**, not an arbitrary Node process. Translating our runner requires matching unique key allocation, mixed operations, exact expected business rejections, token renewal, fixture checks and per-case evidence. k6 third-party extensions and browser testing are not supported in BYOS.
- BYOS preserves specified output artifacts and exposes results through its API. Its performance metrics are stored in PerfSizer's database; the docs do not establish export parity with our raw observations. External HANA/Dynatrace metrics are supported for Custom Run, not BYOS.
- Standard authentication obtains a token once and reuses it. Long-run token renewal is not established by that guide and must be demonstrated or implemented in the script.
- **Sizing Run changes the experiment:** the docs describe increasing CF memory to at least 4 GB and testing 2x/4x instance scaling. Its recommendations also tolerate some errors. Use Custom Run or BYOS with our own strict outcome criteria for fixed-resource comparisons; a separate Sizing Run would need a separate resource estimate and approval of the scaling scope.

The recommendation remains **our CF runner for the primary matched Oyster benchmark**, because it preserves the proven workload semantics and can use the internal request path. PerfSizer is a complementary option for later end-to-end, endurance or sizing questions. If our generator proves insufficient, separately evaluate k6 deployment inside CF before assuming we need to move execution to PerfSizer.

Keep the existing autocannon concurrency measurements for continuity. They are closed-loop tests. If we later ask about capacity at a fixed arrival rate, introduce a separately labeled protocol with scheduled arrivals and dropped-request accounting.

### Deployed traffic path

The initial design selected an internal CF route. Live November 7 checks found that the user's CF token lacks `network.write` and `network.admin`, and direct runner-to-provider traffic returns `ECONNREFUSED` despite successful internal DNS resolution. The [CF networking documentation](https://docs.cloudfoundry.org/devguide/deploy-apps/cf-networking.html#grant) assigns those grants to foundation administrators. No customer self-service grant was established for this account.

Execution therefore uses the provider's verified HTTPS CF route from a runner task in the same space and foundation. Real subscriber OAuth and the full tenant HANA fixture remain in use. Both native and Oyster measurements traverse TLS and the CF router; manifests and reports identify this boundary explicitly. These runs measure end-to-end BTP requests and must not claim direct container networking or handler-only precision.

### Canary load coordination

The user confirmed on November 6 that global account D034457 runs on Canary. Landscape classification is resolved for this target. The [PerfSizer landscape guide](https://pages.github.tools.sap/perfsizer/administration/landscapes/) recommends Canary for internal performance tests and describes advance load notification and coordination with routing, logging and dependent-service teams.

The same documentation is inconsistent about notification thresholds: the landscape guide says greater than **3.5 requests/second**, while the new-user FAQ says greater than **3,000 requests/second**. On November 7 the user confirmed they had no current policy and explicitly directed proceeding with the benchmarks. This resolves the user's scheduling decision; the documentation conflict remains unverified. Contacting platform or service teams remains a separate action requiring the user's explicit instruction.

## Proposed application architecture

Deploy one benchmark MTA containing these components:

1. **CAP provider:** owns the database model, fixed benchmark projections/actions, native reference handlers, extension-point wiring and tenant-scoped diagnostic operations. Uses HANA and MTX in production.
2. **MTX sidecar:** owns subscription provisioning, tenant model delivery and extension activation. Install Oyster in both this sidecar and the provider.
3. **App Router:** provides the normal subscriber entry point and routing needed for subscription and operator access.
4. **CF runner application:** stages the benchmark code and exposes a task process for bounded executions. Timed HTTP generation happens only in its task container.
5. **Tenant evidence service:** stores manifests, per-case observations, raw evidence and final report archives in dedicated tables within the test tenant's HANA container before a task exits. It shares the tenant database without exposing these tables to Oyster handlers or fixture resets.

Use XSUAA with shared tenant mode and SaaS Registry, matching the previously verified personal-account deployment. Service Manager provisions dedicated tenant HDI containers in an available HANA Cloud database. IAS/AMS is an alternative if the account requires it, rather than an additional stack to deploy alongside XSUAA.

Create a subscription to this new benchmark application in a test subscriber subaccount. Confirm its actual tenant ID and subdomain. Also use a separate unextended subscriber for the isolation check. Existing subscriber subaccounts can subscribe to the new application without changing their earlier applications, subject to inventory and the user's selection.

The primary comparisons run native and Oyster workloads on the same provider instance and the same test tenant. Authentication, tenant resolution, HANA and fixed request contracts are shared. Only Oyster-designated endpoints receive uploaded handlers.

Deploy one business runtime with Oyster installed. Native reference handlers, no-handler controls and active Oyster handlers use that same provider and tenant database. Omit the separate plugin-free CAP deployment and the cloud comparison of plugin installation overhead, following the user's November 6 scope decision.

Derive the cloud matrix from the existing workloads: replace plugin-free no-handler load controls with no-handler controls inside the Oyster-enabled provider, then remove duplicates by complete workload and load identity. This preserves no-handler concurrency and mixed-traffic references without retaining an installation-overhead comparison. A calculation against the current scenario source yields 102 short cases and 115 long cases per repetition, or 345 ordinary long measurements across three repetitions, plus the six whole-table measurements. These are planned cloud counts, not executed results. The cloud pilot uses an explicitly identified subset; extra diagnostic cases are separately identified.

Start with one provider instance and fixed memory allocation. Introduce scale-out only after the single-instance experiment is valid. CF scheduling does not guarantee dedicated physical CPU or colocated cells, so record resource limits and repetition variability.

## Extension delivery

The provider defines extensibility boundaries but ships no benchmark tenant handler files. Move the sandbox handlers into a dedicated extension project and retain native handlers in provider source.

Use the installed CLI's supported generators and lifecycle: `cds add multitenancy`, `cds add extensibility`, `cds add hana`, `cds add xsuaa`, `cds add approuter`, `cds add mta`, and `cds add extension` for the extension project. Check effective profiles after generation. Pull the deployed base model, build with `cds build --for mtx-extension`, and activate with `cds push` for the selected subscriber.

Verify the archive contains the intended handlers, the tenant model references that extension, its stored Oyster version matches, and it is not blocked. The unextended subscriber must retain the expected no-handler behavior. Use tenant-specific model inspection; the provider's global `cds.model` alone does not establish activation for a subscriber.

Preserve extension annotation checks and sandbox limits. Close fixture administration, diagnostics and reference endpoints to uploaded code where appropriate. Native business references must not accidentally become tenant extension targets.

## Network and authentication

The primary timed path is **runner task → internal CF route → CAP provider → tenant HANA container**. Discover the foundation's internal domain and configure only the runner-to-provider network policy needed for that route. Verify that task containers receive the intended connectivity.

Container-to-container networking avoids the public HTTP routing path and the laptop round trip. It still includes intra-cloud network latency and CAP authentication. It does not prove the absence of platform resource limits. Record the actual transport and TLS settings. If internal networking is unavailable, a CF runner calling the ordinary HTTPS route is a separately identified alternative requiring agreement on its measurement scope.

Use real tenant-scoped OAuth, preferably a technical client with only benchmark execution scopes. Validate token audience, tenant ID and service access. Renew tokens outside timed case windows; never obtain one token per request. Test renewal before relying on a long run. Setup/deployment credentials remain separate from the measured execution identity.

The runner does not need CF administrative credentials. Local operator scripts may start tasks and manage deployment lifecycle through the CF API; those control-plane calls are outside measured traffic. Do not synthesize a privileged tenant context to substitute for real HTTP authentication in measured cases.

Run a small separately labeled HTTPS/App Router verification to establish the normal subscriber path. Browser sessions and their CSRF handling need their own treatment; do not assume a bearer token sent to the App Router exercises the same path as a browser.

## Cloud fixture and measurement integrity

Keep the same logical rows and CSV identities. Build the base fixture through the standard CAP HANA/HDI deployment rather than sending one million INSERT requests from the laptop. Validate table counts, unique keys, ordered samples and canonical hashes against the retained inputs.

Check HANA serialization and ordering for every workload. Preserve the signed 32-bit key limits, unique INSERT allocation and disjoint UPDATE rows. Verify persistence and rejection rollback in the tenant database. Do not substitute SQLite reference reads for HANA state verification.

Separate local and cloud fixture adapters behind a small shared interface for fixture inspection, reference rows, write-state checks and lifecycle operations. Cloud inspection runs in an authorized tenant-scoped setup task or service; it does not hand HANA credentials to the HTTP load generator.

Reset and warm up outside measurement. Establish a supported restoration procedure that resets only the five `perf` fixture tables from retained CSVs and preserves evidence tables. Quiesce measured traffic during restoration and verify baseline counts and state hashes explicitly; an unchanged HDI deployment does not prove mutated rows were restored. Do not reprovision a tenant containing evidence until its complete archive has been exported and its hashes verified. Confirm extension activation after restoration. This lifecycle must pass twice in the pilot, including evidence readback after each reset.

Pair native/Oyster cases within each independent repetition, counterbalance order, keep returned rows and work equivalent, and record warmup separately. Establish a one-client baseline before concurrency levels 8 and 32. Calibrate duration on HANA; the local 15/90-minute targets are starting estimates. Report actual cloud duration and do not truncate a preset to meet a target.

Record provider and runner CPU, memory, event-loop delay, allocated resources and instance identity separately. Replace local IPC with scoped control operations outside timed requests. Missing HANA diagnostics stay explicitly unavailable. Correlate any available database signals without requiring DBADMIN or granting broader administration privileges.

Classify authentication errors, HTTP 429, transport failures and unrelated HTTP 400 responses as failures. Preserve exact expected business rejections as successful validation outcomes. Recheck extension activation and quarantine before and after each case; if it becomes blocked, stop the run and reject subsequent measurements rather than counting silently skipped handlers as fast results. Detect provider restarts, overlapping benchmark runs and generator saturation.

## Results and durability

CF tasks lose their containers at completion and cannot be accessed through SSH. Upload completed case evidence between measurement windows and flush the final archive before exiting. Interrupted runs must retain completed observations and be clearly partial.

Use dedicated run, artifact and artifact-part tables outside the `perf` namespace in the test tenant's HANA database. A separately authorized evidence service requires a real tenant JWT and recorder role. The benchmark services expose none of these entities to uploaded code. HANA HDI provisioning and a separate storage binding are unnecessary for evidence beyond the already required tenant container.

The runner compresses artifacts with gzip and uploads bounded binary chunks after a case's timed window. Await committed upload and completion metadata before the next warmup. Store paths, original and compressed byte lengths, SHA-256 identities, compression, part order and expected part counts. Mark an artifact complete only after every part is present and recombination verifies its identity. A run is complete only after its final report archive is committed. Record partial status for interrupted runs and retain all previously committed artifacts.

Do not write evidence per request. The pilot must verify ordered download, decompression and original-file hashes through the real CAP HTTP service on HANA, both after CF task exit and after fixture restoration. Artifact storage can affect HANA caches and background work even outside timed windows, so flush uploads and leave the same settling/warmup interval before each case. Keep diagnostic timings separate from benchmark results.

Add region, foundation, provider/runner resource limits, instance counts, tenant identity, HANA details available to us, deployed source/archive hashes, versions, token-renewal events and request path to the manifest. Exclude credentials and tokens.

Adapt reports to HANA and CF. Keep local SQLite and cloud HANA findings separate. An HTTP latency difference is a difference between matched cloud workloads, not a direct timer for the sandbox alone. Keep the existing presentation preferences: conclusions, absolute latency and added milliseconds, load mean/p95 deltas, named source links and detailed evidence without a main-table Paired runs column.

Publish new dated BTP examples after verification. Preserve the existing local example reports as historical evidence.

## Repository organization

Local execution remains supported throughout the cloud refactor. A fresh checkout must support installing dependencies, deploying the retained SQLite fixture, starting the local Oyster app, running correctness verification, and executing both complete local presets through the documented npm commands. The CLI-pulled provider snapshot and checked-in handlers must be sufficient for ordinary local benchmarking without a BTP login. Cloud configuration stays in the generated provider/sidecar profiles and the cloud runner entry point. Verify local commands after every change to shared models, source paths or adapters.

Proposed responsibilities, to finalize during plan review:

| Location | Responsibility |
| --- | --- |
| `apps/provider/` | Canonical CAP base application: `db`, native `srv` handlers, libraries, MTX sidecar and router assets |
| `apps/extension/` | CLI-scaffolded extension with pulled base metadata and checked-in Oyster handler source |
| `apps/runner/` | CF task entry point, authentication and HANA evidence-service client |
| `bench/` | Shared scenarios, request contracts, result validation, reporting and explicit local/cloud adapters |
| `apps/baseline-plain/` | Existing local plugin-free reference, excluded from cloud deployment |
| `mta.yaml` | Deployment of the cloud components and their service bindings |
| `examples/` | Existing local reports and separately named future BTP examples |
| `docs/` | Reviewed architecture, phased execution instructions and operator guide |

Use npm workspaces and supported CAP build packaging for shared dependencies. Preserve CommonJS and `.js` consistently. Generated deployment artifacts must contain the intended provider/runner dependencies; do not rely on development-time hoisting or install a second source runtime in the sidecar.

The current lockfile exclusion preference still applies. MBT templates may use `npm ci`; settle the deployment's reproducible build inputs explicitly before using that template. Do not silently commit lockfiles or quietly replace deterministic installation with unrecorded floating dependencies.

## Phases and exit criteria

1. **Resolve resources and tooling.** Reauthenticate CF, confirm the personal-account/subaccount mapping, inventory org memory and services, and check HANA availability in the new space, subscriber prerequisites, internal networking and durable storage. Use the user-confirmed Canary target, resolve the documented notification-threshold conflict and prepare the concrete load-window information. Exit: selected stack, explicit resource estimate, confirmed provisioning prerequisites and the applicable Canary load coordination.
2. **Agree on repository and protocol design.** Choose the cloud control cases, package layout, execution identity, artifact sink and reset lifecycle. Exit: reviewed design and a detailed implementation checklist.
3. **Build and validate local MTX shape.** Scaffold provider, sidecar and extension with CDS CLI; move source; adapt existing tests; subscribe local tenants and activate the real extension. Validate cloud matrix selection and no-handler load controls within the provider. Exit: local tests and tenant isolation pass, retained standalone comparisons still work, production build archives have the intended contents.
4. **Deploy a minimal cloud slice.** Deploy the benchmark MTA, create test subscription and activate a tiny extension. Verify authenticated internal HTTP, native/Oyster actions, one HANA lookup, an intentional rejection and an unextended-tenant control. Exit: actual tenant-backed execution and artifact upload succeed.
5. **Complete the cloud fixture and runner.** Import and inspect the one-million-row fixture, verify reset twice, and add cloud reference checks, resource collection, token renewal and cancellation behavior. Exit: a short pilot is correct and repeatable, with reports surviving task completion and all full-preset comparison paths ready.
6. **Run the agreed cloud presets.** Start with one provider instance and calibrated durations; run short then long sequentially. Exit: all planned cases, rollback checks and extension-state checks pass, the generator is not the unresolved bottleneck, and all evidence is retained.
7. **Review and publish.** Check source links and render report diagrams, assess variability and HANA/routing effects, write BTP operator instructions and publish dated cloud examples. Consider multi-instance or arrival-rate tests only after this baseline is trustworthy.

For initial quota planning, a single 1 GB provider, 512 MB sidecar, 256 MB router and 512 MB runner task would consume approximately 2.25 GB concurrently, plus staging/deployment headroom and any runner web process. This is a sizing assumption, not a guarantee that 512 MB suffices for raw samples. Higher runner memory or an overlapping upgrade task adds to that total. A new CF space shares the organization's quota. HANA memory/storage is separate.

The new space also needs an effective HANA instance mapping. Earlier personal-account work found restricted access to HANA administration tools. Verify the current mapping and the supported way to add this space without replacing an in-use database. If rights are insufficient, resolve that prerequisite explicitly before deployment.

## Sources and evidence limits

- [CAP multitenant deployment](https://cap.cloud.sap/docs/guides/multitenancy/): current public architecture and tenant deployment guidance.
- [CF container-to-container networking](https://docs.cloudfoundry.org/devguide/deploy-apps/cf-networking.html): internal routes, network policies and transport options. Foundation-specific availability remains to be checked.
- [CF task lifecycle](https://docs.cloudfoundry.org/devguide/using-tasks.html): separate task containers, inherited bindings, destruction at exit and no task SSH.
- [PerfSizer quick start](https://pages.github.tools.sap/perfsizer/getting-started/quick-start/), [test run modes](https://pages.github.tools.sap/perfsizer/concepts/testruns/), [BYOS](https://pages.github.tools.sap/perfsizer/concepts/byos/) and [BYOS setup](https://pages.github.tools.sap/perfsizer/advanced/byos-run/): supported workflows and script restrictions.
- [PerfSizer network origin](https://pages.github.tools.sap/perfsizer/administration/ip-addresses/), [CF resource metrics](https://pages.github.tools.sap/perfsizer/reference/resource-metrics/), [authentication](https://pages.github.tools.sap/perfsizer/creating-tests/authentication/) and [custom assertions](https://pages.github.tools.sap/perfsizer/creating-tests/custom-assertions/): inspected integration capabilities.
- [PerfSizer landscape guidance](https://pages.github.tools.sap/perfsizer/administration/landscapes/) and [new-user FAQ](https://pages.github.tools.sap/perfsizer/help/faq-new-users/): Canary coordination and conflicting notification thresholds. The user confirmed D034457's Canary classification. All PerfSizer source observations above are from documentation revision `31782ba6d31e1030a6ac0f8a321bd2e4614871da`; they are not live test results or proof of project access.
- Installed CDS CLI help inspected for `add`, `deploy`, `subscribe`, `login` and `push`; installed Oyster `lib/profile.js`, `lib/index.js` and `lib/services/extService.js` inspected for production activation and tenant code lifecycle.
- Current local benchmark manifests and source inspected at repository revision `39c13f8`.
- Central workspace notes record the November 5 eu12 Oyster deployment and earlier HANA mapping, subscription and OAuth checks. Those are dated observations, not live entitlements.
- The local internal CAP performance draft explicitly uses a CF-hosted client to reduce external network influence, but contains incomplete sections. Its historical throughput numbers are not adopted as targets here.

Implementation has started following design approval. The provider, sidecar and separate extension project have passed local MTX activation and tenant-isolation checks. After correcting the local verification entry point, the documented long-preset correctness command passed all 121 cases. These are local checks, not cloud performance measurements. Resource retirement and replacement HANA provisioning are complete; cloud runner and durable-evidence verification remain execution gates.

The first cloud slice deployed successfully with `cds up --to cf`. Provider, sidecar and approuter are running; the MTX upgrade task succeeded. Both existing demonstration subscriber subaccounts subscribed to the new benchmark app. `cds pull` retrieved the deployed base model and `cds push` activated the checked-in Oyster handlers only for the test tenant. Real tenant OAuth, native/Oyster HANA lookups, predefined extension execution, accepted/rejected constraints and the unextended control passed. A 2 MiB binary artifact and a text report round-tripped through the tenant evidence service with matching original hashes.

November 7 fixture verification passed all 134 tests and 121 local long-preset correctness cases. An isolated installed source copy also passed all 121 cases without BTP authentication. The reviewed fixture controls deployed with `cds up`. All five HANA table identities matched retained CSVs, including one million LargeRows. Two fixture resets restored mutations and preserved existing binary/report hashes, Oyster activation and the provider instance. A local polling timeout during the second cycle was retained in the evidence. Authenticated readback verified that HANA had completed the reset successfully.

The final source suite passes all 160 tests. Live CF pilots verified token renewal and HANA evidence survival after task exit. Complete short and long tests passed all 102 and 351 measurements in 17 minutes 38 seconds and 107 minutes 8 seconds. Post-task exports verified 1,311 short artifacts and 4,263 long artifacts. The [performance overview](../examples/oyster-performance-2026-11-07.md) compares both cloud tests with the completed local short/long tests and retains matched observations and repetition ranges.

## Efficient evidence storage

The November 7 storage revision replaces cumulative report checkpoints and successful per-case files with compact measurement batches of 20 and one final report archive. Source identities remain hashes; no source copies are uploaded. Failed cases retain diagnostics. Exact observations, all report charts, rollback outcomes and separate generator/provider resources remain available. Graceful interruption flushes pending measurements; abrupt task loss can lose the current batch, normally fewer than 20 records between uploads and up to 20 during upload. Published examples retain two reports, one exact CSV and compact metadata. Original local and HANA archives are preserved.

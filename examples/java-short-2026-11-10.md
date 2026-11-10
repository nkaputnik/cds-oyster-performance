# Java Short Benchmark

CDS-Oyster provides the isolated WebAssembly (WASM) runtime required for business logic from untrusted sources in SAP Cloud Application Programming Model (CAP). This report compares response time and throughput for equivalent native Java and JavaScript Oyster handlers. Native execution is the measurement reference. Untrusted logic runs in Oyster. A handler is custom code invoked for a data request or service action.

**Blue: native. Orange: Oyster. Gray: no-handler controls.** Vertical bars show absolute measurements. Lower latency means shorter response time. Higher throughput means more requests completed per second. p95 is the response time within which 95% of successful requests completed. Throughput is successful requests per second.

## Application-level impact

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(3) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(4) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Predefined extension point: request time"
    x-axis ["Native constraint", "Oyster constraint", "Native constraint + lookup", "Oyster constraint + lookup"]
    y-axis "Mean request time (ms)" 0 --> 1.2809558
    bar [0.16653981264418827, 0.9304258635505209, 0.2750332877456214, 1.1645052738270896]
```

| Extension-point work | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [constraint](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidation.js) | 0.167 | 0.93 | +0.764 |
| [constraint + lookup](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidationRead.js) | 0.275 | 1.165 | +0.889 |

Small, bounded extension points keep the isolation premium predictable. Reusing data already held by the application avoids additional database round trips.

Oyster handlers: [Oyster constraint](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidation.js), [Oyster constraint + lookup](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidationRead.js).

### Business constraint: accepted and rejected requests

Ordinary business constraints need little arithmetic. Their cost mainly comes from invoking the isolated handler and, when needed, retrieving additional data. These handlers check quantity × unitPrice against a fixed or queried limit.

Rejection is a normal business outcome and needs its own latency budget. Expected business rejections remain successful outcomes of this test. Accepted and rejected requests are compared separately, with persistence checks confirming the decision.

| Workload | Decision | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- | --- |
| [Action](../apps/extension/srv/BenchmarkService/on-oysterValidation.js) | accepted | 0.159 | 1.049 | +0.89 |
| [Action](../apps/extension/srv/BenchmarkService/on-oysterValidation.js) | rejected | 0.418 | 1.366 | +0.948 |
| [Action through extension point](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidation.js) | accepted | 0.167 | 0.93 | +0.764 |
| [Action through extension point](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidation.js) | rejected | 0.425 | 1.337 | +0.912 |
| [Action with lookup](../apps/extension/srv/BenchmarkService/on-oysterValidationRead.js) | accepted | 0.246 | 1.159 | +0.913 |
| [Action with lookup](../apps/extension/srv/BenchmarkService/on-oysterValidationRead.js) | rejected | 0.659 | 1.678 | +1.018 |
| [Action through extension point with lookup](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidationRead.js) | accepted | 0.275 | 1.165 | +0.889 |
| [Action through extension point with lookup](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidationRead.js) | rejected | 0.689 | 1.729 | +1.041 |
| [INSERT](../apps/extension/srv/BenchmarkService/OysterValidationWriteRows/before-CREATE.js) | accepted | 0.248 | 1.191 | +0.944 |
| [INSERT](../apps/extension/srv/BenchmarkService/OysterValidationWriteRows/before-CREATE.js) | rejected | 0.401 | 1.3 | +0.899 |
| [INSERT with lookup](../apps/extension/srv/BenchmarkService/OysterValidationReadWriteRows/before-CREATE.js) | accepted | 0.383 | 1.248 | +0.865 |
| [INSERT with lookup](../apps/extension/srv/BenchmarkService/OysterValidationReadWriteRows/before-CREATE.js) | rejected | 0.532 | 1.847 | +1.315 |
| [UPDATE](../apps/extension/srv/BenchmarkService/OysterValidationWriteRows/before-UPDATE.js) | accepted | 0.369 | 1.316 | +0.947 |
| [UPDATE](../apps/extension/srv/BenchmarkService/OysterValidationWriteRows/before-UPDATE.js) | rejected | 0.396 | 1.506 | +1.11 |
| [UPDATE with lookup](../apps/extension/srv/BenchmarkService/OysterValidationReadWriteRows/before-UPDATE.js) | accepted | 0.424 | 1.859 | +1.435 |
| [UPDATE with lookup](../apps/extension/srv/BenchmarkService/OysterValidationReadWriteRows/before-UPDATE.js) | rejected | 0.499 | 1.945 | +1.446 |

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Action: accepted constraint"
    x-axis ["Native", "Oyster"]
    y-axis "Mean request time (ms)" 0 --> 1.153852
    bar [0.15927624854657338, 1.0489563583244395]
```

Oyster handlers: [Oyster constraint](../apps/extension/srv/BenchmarkService/on-oysterValidation.js).

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Action: accepted constraint with lookup"
    x-axis ["Native", "Oyster"]
    y-axis "Mean request time (ms)" 0 --> 1.275171
    bar [0.24586024435676893, 1.1592463491923641]
```

Oyster handlers: [Oyster constraint + lookup](../apps/extension/srv/BenchmarkService/on-oysterValidationRead.js).

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Action: rejected constraint"
    x-axis ["Native", "Oyster"]
    y-axis "Mean request time (ms)" 0 --> 1.5026567
    bar [0.41813486163875446, 1.366051533919156]
```

Oyster handlers: [Oyster constraint](../apps/extension/srv/BenchmarkService/on-oysterValidation.js).

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Action: rejected constraint with lookup"
    x-axis ["Native", "Oyster"]
    y-axis "Mean request time (ms)" 0 --> 1.8455405
    bar [0.6592673658241032, 1.6777641151358327]
```

Oyster handlers: [Oyster constraint + lookup](../apps/extension/srv/BenchmarkService/on-oysterValidationRead.js).

The added milliseconds describe these actual constraint handlers. Use accepted-request costs for normal request budgets and rejected-request costs when estimating rejected traffic. One paired run; repeat needed.

| Application design | Added mean request time | Comparison |
| --- | --- | --- |
| Predefined extension points | +0.764 ms (5.587× native time) per accepted call, [amount constraint](../apps/extension/srv/BenchmarkExtensionService/on-oysterValidation.js) | Equivalent native constraint handler |
| CRUD constraints on custom entities | [INSERT](../apps/extension/srv/BenchmarkService/OysterValidationWriteRows/before-CREATE.js): +0.95 ms, [UPDATE](../apps/extension/srv/BenchmarkService/OysterValidationWriteRows/before-UPDATE.js): +0.757 ms | Oyster enabled, generic CRUD without a handler |
| after-READ calculation on a large collection | [READ 1,000 rows from million-row table](../apps/extension/srv/BenchmarkService/OysterCalculationLargeRows/after-READ.js): +17.353 ms (10.746× native time) | Equivalent native calculation handler |

The custom-entity comparison measures adding an accepted fixed-limit constraint to generic CRUD. It includes the additional quantity and unitPrice request fields. The native/Oyster constraint comparisons above use identical inputs.

These are individual SQLite constraint invocations. Measure the complete application to budget requests that invoke several handlers. Synthetic calculations below are stress workloads.

This is one independent short test run. Many requests within each case do not establish variability across test runs. Repeat the test run to determine whether the measured differences persist.

## 1. What is the typical overhead?

| Workload | Native empty ms | Oyster empty ms | Extra ms | Ratio |
| --- | --- | --- | --- | --- |
| [INSERT](../apps/extension/srv/BenchmarkService/OysterEmptyWriteRows/before-CREATE.js) | 0.241 | 1.813 | +1.572 | 7.527× |
| [UPDATE](../apps/extension/srv/BenchmarkService/OysterEmptyWriteRows/before-UPDATE.js) | 0.484 | 1.231 | +0.748 | 2.545× |
| [READ 10 rows from 1,000-row table](../apps/extension/srv/BenchmarkService/OysterEmptySmallRows/after-READ.js) | 0.284 | 1.249 | +0.965 | 4.391× |
| [Action](../apps/extension/srv/BenchmarkService/on-oysterNoop.js) | 0.134 | 0.983 | +0.849 | 7.337× |

An empty handler measures the recurring cost of invoking Oyster without business calculation or auxiliary queries. It still crosses the sandbox boundary and carries request context. READ handlers also carry returned rows. Budget this starting cost for the data each extension receives.

Budget the added milliseconds against the application’s response-time target. Ratios alone exaggerate the impact when the native reference is very fast.

## 2. How does overhead change across scenarios?

The following comparisons add calculation, auxiliary database queries and invocation through a predefined extension point. Native and Oyster perform the same work in each comparison.

| Synthetic arithmetic workload | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [Calculation action](../apps/extension/srv/BenchmarkService/on-oysterCalculation.js) | 0.152 | 0.906 | +0.754 |

Repeated arithmetic amplifies the execution cost. Treat these as stress cases when assessing ordinary business constraints.

| Auxiliary query workload | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [Action: CQL read](../apps/extension/srv/BenchmarkService/on-oysterCqlRead.js) | 0.81 | 2.439 | +1.629 |
| [Action: CQL update](../apps/extension/srv/BenchmarkService/on-oysterCqlWrite.js) | 0.932 | 2.21 | +1.277 |

All request-time differences include dispatch, handler work, query handling, response processing and transaction completion. They measure the overhead of the complete Oyster execution path.

| Small calculation workload | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [INSERT](../apps/extension/srv/BenchmarkService/OysterCalculationWriteRows/before-CREATE.js) | 0.284 | 1.07 | +0.787 |
| [UPDATE](../apps/extension/srv/BenchmarkService/OysterCalculationWriteRows/before-UPDATE.js) | 0.356 | 1.417 | +1.061 |
| [READ 10 rows from million-row table](../apps/extension/srv/BenchmarkService/OysterCalculationLargeRows/after-READ.js) | 0.281 | 1.371 | +1.091 |

| Predefined extension-point work | Extra Oyster ms |
| --- | --- |
| [empty handler](../apps/extension/srv/BenchmarkExtensionService/on-oysterEmpty.js) | +0.74 |
| [CQL read](../apps/extension/srv/BenchmarkExtensionService/on-oysterCqlRead.js) | +0.97 |
| [CQL write](../apps/extension/srv/BenchmarkExtensionService/on-oysterCqlWrite.js) | +0.819 |

Keep predefined extension points narrow and reuse the caller’s data. Extra service calls and queries add work to the same request budget.

## 3. Which patterns increase overhead?

These comparisons examine result volume, repeated database callbacks and increasing concurrent demand.

### Repeated database callbacks

Each database callback requires query validation, CAP dispatch and data exchange. Comparing individual lookups with one query for the same records tests whether reducing these repeated steps lowers request time.

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#ea580c"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(3) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(4) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Equivalent lookup enrichment inside Oyster"
    x-axis ["Native individual lookups", "Native batched lookup", "Oyster individual lookups", "Oyster batched lookup"]
    y-axis "Mean request time (ms)" 0 --> 3.314293
    bar [0.8341959316783357, 0.2993986658891222, 3.012993591151791, 1.6078668370008142]
```

| Equivalent lookup work | Oyster ms |
| --- | --- |
| [Individual queries](../apps/extension/srv/BenchmarkService/on-oysterLookupIndividual.js) | 3.013 |
| [One batch](../apps/extension/srv/BenchmarkService/on-oysterLookupBatch.js) | 1.608 |

The same 10 distinct keys, columns, arithmetic and scalar result are preserved. -1.405 ms (-46.636%) is the matched difference.

The handlers reduce the query count from 10 query callbacks to one for equivalent work. Batching reduced time in this comparison. Allowing an extension to fetch the required records in one query reduces callbacks in this workload.

### What does an additional CQL callback cost?

CQL is CAP’s query language. A CQL callback asks CAP to execute an Oyster query and return its result. The 1-versus-10 action comparison keeps calculation and lookup shape fixed and adds nine sequential statements within one invocation.

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(3) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(4) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Action: 1 versus 10 sequential CQL reads"
    x-axis ["Native: 1 query", "Native: 10 queries", "Oyster: 1 callback", "Oyster: 10 callbacks"]
    y-axis "Mean request time (ms)" 0 --> 2.6826398
    bar [0.22317618266017836, 0.8101095473640869, 1.1757414182305654, 2.438763462814994]
```

Oyster handlers: [Oyster CQL read](../apps/extension/srv/BenchmarkService/on-oysterCqlRead.js).

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(3) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(4) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Action: 1 versus 10 sequential CQL updates"
    x-axis ["Native: 1 query", "Native: 10 queries", "Oyster: 1 callback", "Oyster: 10 callbacks"]
    y-axis "Mean request time (ms)" 0 --> 2.4305229
    bar [0.2765548801209587, 0.9321622090261277, 1.3829064778636688, 2.2095662601671315]
```

Oyster handlers: [Oyster CQL write](../apps/extension/srv/BenchmarkService/on-oysterCqlWrite.js).

| Query work | Native ms per added query | Oyster ms per added callback | Extra Oyster ms per callback |
| --- | --- | --- | --- |
| [CQL read](../apps/extension/srv/BenchmarkService/on-oysterCqlRead.js) | 0.065 | 0.14 | +0.075 |
| [CQL update](../apps/extension/srv/BenchmarkService/on-oysterCqlWrite.js) | 0.073 | 0.092 | +0.019 |

Increment per statement = (10-statement time minus 1-statement time) / 9. Extra Oyster cost subtracts the native increment. This estimates the average cost of the **nine additional queries**, including database work and data transfer. It does not establish a constant internal callback timer.

### Large result sets and loops

Large results combine more row handling, more data transfer and potentially more calculation. Total stored table size and rows processed by an extension are different quantities. A ten-row indexed page can stay small even when its table contains one million rows.

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(3) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(4) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "READ 1,000 rows from million-row table"
    x-axis ["Native empty handler", "Oyster empty handler", "Native calculation", "Oyster calculation"]
    y-axis "Mean request time (ms)" 0 --> 21.046727
    bar [1.4603001499079165, 7.603359662835252, 1.7805842169811283, 19.133388038461533]
```

| Large-result work | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| Empty READ handler | 1.46 | 7.603 | +6.143 |
| READ with per-row arithmetic | 1.781 | 19.133 | +17.353 |

Oyster handlers: [Oyster empty handler](../apps/extension/srv/BenchmarkService/OysterEmptyLargeRows/after-READ.js), [Oyster calculation](../apps/extension/srv/BenchmarkService/OysterCalculationLargeRows/after-READ.js).

Transferring and handling 1,000 rows through an [empty Oyster handler](../apps/extension/srv/BenchmarkService/OysterEmptyLargeRows/after-READ.js) costs about 6 ms extra in this run. Per-row arithmetic adds further overhead. Bound both the result size and the work per row.

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "READ loop over 10,000 rows"
    x-axis ["Native", "Oyster"]
    y-axis "Mean request time (ms)" 0 --> 168.47994
    bar [6.409786316720258, 153.16358492307694]
```

| Large-result work | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [READ loop over 10,000 rows](../apps/extension/srv/BenchmarkService/on-oysterScan.js) | 6.41 | 153.164 | +146.754 |

Oyster handlers: [Oyster calculation](../apps/extension/srv/BenchmarkService/on-oysterScan.js).

Paging bounds each invocation’s payload, but a scan still processes the complete dataset. Use bounded pages and a separate latency budget for bulk work.

### Concurrent load and capacity

Oyster handlers: [Oyster CQL read](../apps/extension/srv/BenchmarkService/on-oysterCqlRead.js).

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(3) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(4) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(5) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(6) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Action: CQL read: Throughput"
    x-axis ["Native at 1 concurrent client", "Oyster at 1 concurrent client", "Native at 8 concurrent clients", "Oyster at 8 concurrent clients", "Native at 32 concurrent clients", "Oyster at 32 concurrent clients"]
    y-axis "Successful requests/s" 0 --> 26171.568
    bar [4253.561980339799, 836.8292794660322, 23792.33426203648, 5098.754943861475, 23701.625140088454, 4178.014591955068]
```

```mermaid
---
config:
  xyChart:
    width: 1400
    height: 480
    xAxis:
      labelFontSize: 13
  themeVariables:
    xyChart:
      plotColorPalette: "#64748b"
  themeCSS: ".bar-plot-0 rect:nth-child(1) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(2) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(3) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(4) { fill: #ea580c; stroke: #ea580c; } .bar-plot-0 rect:nth-child(5) { fill: #2563eb; stroke: #2563eb; } .bar-plot-0 rect:nth-child(6) { fill: #ea580c; stroke: #ea580c; }"
---
xychart-beta
    title "Action: CQL read: Round-trip latency"
    x-axis ["Native at 1 concurrent client", "Oyster at 1 concurrent client", "Native at 8 concurrent clients", "Oyster at 8 concurrent clients", "Native at 32 concurrent clients", "Oyster at 32 concurrent clients"]
    y-axis "Mean request time (ms)" 0 --> 8.3295113
    bar [0.22317618266017836, 1.1757414182305654, 0.3242389152857612, 1.5396576351766142, 1.3317137224162097, 7.572283015834337]
```

| Load | Native requests/s | Oyster requests/s | Native mean ms | Oyster mean ms | Extra mean ms | Native p95 ms | Oyster p95 ms | Extra p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 concurrent client | 4253.562 | 836.829 | 0.223 | 1.176 | +0.953 | 0.257 | 1.328 | +1.071 |
| 8 concurrent clients | 23792.334 | 5098.755 | 0.324 | 1.54 | +1.215 | 0.438 | 1.941 | +1.502 |
| 32 concurrent clients | 23701.625 | 4178.015 | 1.332 | 7.572 | +6.241 | 2.92 | 20.257 | +17.336 |

Higher concurrency reduces throughput as well as increasing contention. Restrict in-flight work and investigate the bottleneck before increasing load.

The per-request delta shows how Oyster’s added latency changes with load. Use it with the complete round-trip time and throughput to choose a concurrency limit.

Recorded higher-load failures: 0. Successful response latency excludes failed or unsuitable runs. The load generator sends the next request after a response; these are closed-loop concurrency measurements on one machine with local SQLite. They do not establish independently scheduled arrival-rate capacity or horizontal scaling across servers.

## 4. How do measured costs relate to Oyster’s runtime work?

During an Oyster invocation, a request crosses an isolation boundary, the handler executes as JavaScript inside WebAssembly, and its result must be reintegrated into CAP. Database callbacks additionally validate service-scoped queries, preserve the CAP request context, execute through the service and return encoded results. The runtime also applies configured resource limits and propagates handler errors back to CAP.

The native reference executes in the JVM. Oyster evaluates the handler JavaScript inside its prebuilt WASM framework. The runtime reuses the framework and supports concurrent execution. These measurements do not identify sandbox pool size or utilization. The measured warm phase covers repeated invocations and CAP integration. Startup, initial framework loading and warmup precede it.

```mermaid
flowchart LR
    CAP[CAP request context] --> Encode[Encode and cross boundary]
    Encode --> Sandbox[Isolated JavaScript in WASM]
    Sandbox --> Validate[Validate and apply result]
    Validate --> Response[CAP completes request]
    Sandbox -->|Optional CQL callback| Query[Query checks and CAP service execution]
    Query -->|Encoded query result| Sandbox
```

The recurring premium covers isolation and CAP integration. Keep extension boundaries small, reuse available data, and reduce service round trips before optimizing short arithmetic expressions.

Large-result and scan measurements cover row handling and calculation as well as invocation. Restricting rows and fields passed to an extension reduces the data it must handle. Bulk processing needs a separate latency budget because the empty-handler increment does not describe that workload.

### Application design choices

| Application design choice | Reason from this benchmark |
| --- | --- |
| Define extension points with limits on input and result size. | The empty-handler and large-result controls measure the cost of an invocation and the additional work of handling returned rows. |
| Pass data already available to the application and allow bounded queries for additional records. | The individual-versus-batch comparison tests the cost of fetching equivalent data with fewer callbacks. The custom logic still runs in Oyster. |
| Measure per-record invocation and whole-dataset processing before exposing those interfaces. | Large-result and scan costs are measured. Repeated per-record invocation is a separate workload that this test run does not quantify. |
| Set latency and concurrency budgets for representative extension workloads. | Use throughput to identify the capacity knee and added request time to assess its latency cost. |

These measurements describe the tested CAP and Oyster versions on one host with SQLite. They do not compare alternative isolation runtimes or establish production HANA performance.

## Evidence quality and remaining measurements

| Question | Evidence status |
| --- | --- |
| Marginal CQL callback cost | Matched 1-versus-10 query observations are present. Repeat before generalizing the increment. |
| Equivalent lookup batching | One paired run; repeat needed |
| Bulk result handling versus added calculation | Matching empty and calculation handlers compare the result-handling path with per-row arithmetic. Internal components are not individually timed. |
| Independent variability | One independent repetition. Variability across test runs is not measured. |
| Other workloads and horizontal scaling | Heavy-load conclusions apply to the named workloads. Multi-server scaling is not measured. |

## Run setup and reproduction

| Recorded setting | Value |
| --- | --- |
| Run | java-2026-11-10T09-38-24-937Z |
| Hardware / OS | Apple M2 Pro / darwin / arm64 |
| Java / CAP Java / code extensions | 21.0.13.0.3 / 5.2.0 / 5.2.0 |
| Oyster runtime / framework | 2.1.0 / 0.5.5 |
| SQLite JDBC / Node.js sidecar | 3.53.2.1 / v24.15.0 |
| Protocol / repetitions | short / 1 |
| Warmup / measured seconds per case | 2 / 4 |
| Validation | Passed |

One CAP Java provider serves native Java and JavaScript Oyster handlers in the subscribed SQLite tenant. The Node.js MTX sidecar provisions the tenant and provides its extended model. Both runtimes share the retained provider model, CSVs and Oyster handler sources. Java is stopped before the CDS CLI restores application data between repetitions, preserving the activated extension. Build, subscription, activation, startup and warmup precede measurement. No separate plain-CAP control is deployed.

Run npm install and npm run benchmark:java for short, or npm run benchmark:java:long for repeated/larger workloads. Java 21, Maven 3.9.14 or newer and access to the SAP Maven repository are required. The [README](../README.md) gives complete operator instructions. The runner owns the Java provider, MTX sidecar and load generator.

[Detailed results](java-short-2026-11-10/details.md) retain the full named use-case chart catalog, comparisons, resource metrics, correctness checks and failures. [CSV](java-short-2026-11-10/results.csv) and [manifest](java-short-2026-11-10/manifest.json) retain aggregate observations and source hashes. Failed cases retain diagnostic files. Report regeneration does not run new measurements.

Matching native Java code: [request handlers](../apps/provider-java/srv/src/main/java/org/capire/benchmark/BenchmarkHandler.java), [extension-point handlers](../apps/provider-java/srv/src/main/java/org/capire/benchmark/ExtensionHandler.java) and [workload helpers](../apps/provider-java/srv/src/main/java/org/capire/benchmark/Workload.java). Oyster handlers remain JavaScript.

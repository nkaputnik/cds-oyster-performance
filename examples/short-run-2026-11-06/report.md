# CDS-Oyster performance results

CDS-Oyster provides the isolated WebAssembly (WASM) runtime required for business logic from untrusted sources in SAP Cloud Application Programming Model (CAP). This report compares response time and throughput for equivalent native JavaScript and Oyster handlers. Native execution is the measurement reference. Untrusted logic runs in Oyster. A handler is custom code invoked for a data request or service action.

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
    y-axis "Mean request time (ms)" 0 --> 1.1881054
    bar [0.21850233342966197, 0.8564239356392284, 0.34299412686234365, 1.0800958428886427]
```

| Extension-point work | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [constraint](source/srv/BenchmarkExtensionService/on-oysterValidation.js) | 0.219 | 0.856 | +0.638 |
| [constraint + lookup](source/srv/BenchmarkExtensionService/on-oysterValidationRead.js) | 0.343 | 1.08 | +0.737 |

Small, bounded extension points keep the isolation premium predictable. Reusing data already held by the application avoids additional database round trips.

Oyster handlers: [Oyster constraint](source/srv/BenchmarkExtensionService/on-oysterValidation.js), [Oyster constraint + lookup](source/srv/BenchmarkExtensionService/on-oysterValidationRead.js).

### Business constraint: accepted and rejected requests

Ordinary business constraints need little arithmetic. Their cost mainly comes from invoking the isolated handler and, when needed, retrieving additional data. These handlers check quantity × unitPrice against a fixed or queried limit.

Rejection is a normal business outcome and needs its own latency budget. Expected business rejections remain successful outcomes of this test. Accepted and rejected requests are compared separately, with persistence checks confirming the decision.

| Workload | Decision | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- | --- |
| [Action through extension point](source/srv/BenchmarkExtensionService/on-oysterValidation.js) | rejected | 0.275 | 1.064 | +0.789 |
| [INSERT](source/srv/BenchmarkService/OysterValidationWriteRows/before-CREATE.js) | accepted | 0.633 | 1.245 | +0.612 |
| [INSERT](source/srv/BenchmarkService/OysterValidationWriteRows/before-CREATE.js) | rejected | 0.276 | 0.996 | +0.72 |
| [UPDATE](source/srv/BenchmarkService/OysterValidationWriteRows/before-UPDATE.js) | rejected | 0.279 | 1.074 | +0.795 |
| [Action](source/srv/BenchmarkService/on-oysterValidation.js) | rejected | 0.31 | 0.986 | +0.676 |
| [UPDATE](source/srv/BenchmarkService/OysterValidationWriteRows/before-UPDATE.js) | accepted | 0.503 | 1.411 | +0.908 |
| [Action through extension point](source/srv/BenchmarkExtensionService/on-oysterValidation.js) | accepted | 0.219 | 0.856 | +0.638 |
| [Action](source/srv/BenchmarkService/on-oysterValidation.js) | accepted | 0.175 | 0.958 | +0.783 |
| [Action through extension point with lookup](source/srv/BenchmarkExtensionService/on-oysterValidationRead.js) | rejected | 0.406 | 1.313 | +0.907 |
| [INSERT with lookup](source/srv/BenchmarkService/OysterValidationReadWriteRows/before-CREATE.js) | accepted | 0.638 | 1.563 | +0.926 |
| [INSERT with lookup](source/srv/BenchmarkService/OysterValidationReadWriteRows/before-CREATE.js) | rejected | 0.452 | 1.291 | +0.839 |
| [UPDATE with lookup](source/srv/BenchmarkService/OysterValidationReadWriteRows/before-UPDATE.js) | rejected | 0.449 | 1.349 | +0.901 |
| [Action with lookup](source/srv/BenchmarkService/on-oysterValidationRead.js) | rejected | 0.41 | 1.258 | +0.848 |
| [UPDATE with lookup](source/srv/BenchmarkService/OysterValidationReadWriteRows/before-UPDATE.js) | accepted | 0.603 | 1.452 | +0.849 |
| [Action through extension point with lookup](source/srv/BenchmarkExtensionService/on-oysterValidationRead.js) | accepted | 0.343 | 1.08 | +0.737 |
| [Action with lookup](source/srv/BenchmarkService/on-oysterValidationRead.js) | accepted | 0.333 | 1.354 | +1.021 |

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
    y-axis "Mean request time (ms)" 0 --> 1.0541106
    bar [0.17502778291765306, 0.9582823890793344]
```

Oyster handlers: [Oyster constraint](source/srv/BenchmarkService/on-oysterValidation.js).

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
    y-axis "Mean request time (ms)" 0 --> 1.489145
    bar [0.33321334422960297, 1.353768204915196]
```

Oyster handlers: [Oyster constraint + lookup](source/srv/BenchmarkService/on-oysterValidationRead.js).

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
    y-axis "Mean request time (ms)" 0 --> 1.0848973
    bar [0.30991764419323287, 0.986270264283917]
```

Oyster handlers: [Oyster constraint](source/srv/BenchmarkService/on-oysterValidation.js).

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
    y-axis "Mean request time (ms)" 0 --> 1.3834279
    bar [0.40989836189967943, 1.2576617495992288]
```

Oyster handlers: [Oyster constraint + lookup](source/srv/BenchmarkService/on-oysterValidationRead.js).

The added milliseconds describe these actual constraint handlers. Use accepted-request costs for normal request budgets and rejected-request costs when estimating rejected traffic. One paired run; repeat needed.

| Application design | Added mean request time | Comparison |
| --- | --- | --- |
| Predefined extension points | +0.638 ms (3.92× native time) per accepted call, [amount constraint](source/srv/BenchmarkExtensionService/on-oysterValidation.js) | Equivalent native constraint handler |
| CRUD constraints on custom entities | [UPDATE](source/srv/BenchmarkService/OysterValidationWriteRows/before-UPDATE.js): +0.84 ms, [INSERT](source/srv/BenchmarkService/OysterValidationWriteRows/before-CREATE.js): +0.701 ms | Oyster enabled, generic CRUD without a handler |
| after-READ calculation on a large collection | [READ 1,000 rows from million-row table](source/srv/BenchmarkService/OysterCalculationLargeRows/after-READ.js): +17.188 ms (9.7× native time) | Equivalent native calculation handler |

The custom-entity comparison measures adding an accepted fixed-limit constraint to generic CRUD. It includes the additional quantity and unitPrice request fields. The native/Oyster constraint comparisons above use identical inputs.

These are individual SQLite constraint invocations. Measure the complete application to budget requests that invoke several handlers. Synthetic calculations below are stress workloads.

This is one independent short test run. Many requests within each case do not establish variability across test runs. Repeat the test run to determine whether the measured differences persist.

## 1. What is the typical overhead?

| Workload | Native empty ms | Oyster empty ms | Extra ms | Ratio |
| --- | --- | --- | --- | --- |
| [INSERT](source/srv/BenchmarkService/OysterEmptyWriteRows/before-CREATE.js) | 0.603 | 1.423 | +0.82 | 2.359× |
| [UPDATE](source/srv/BenchmarkService/OysterEmptyWriteRows/before-UPDATE.js) | 0.565 | 1.269 | +0.704 | 2.246× |
| [READ 10 rows from 1,000-row table](source/srv/BenchmarkService/OysterEmptySmallRows/after-READ.js) | 0.389 | 1.12 | +0.731 | 2.879× |
| [Action](source/srv/BenchmarkService/on-oysterNoop.js) | 0.242 | 0.894 | +0.652 | 3.691× |

Plugin installation and handler invocation are separate costs. Use the no-handler controls to assess the former and the empty-handler controls to budget the latter.

An empty handler measures the recurring cost of invoking Oyster without business calculation or auxiliary queries. It still crosses the sandbox boundary and carries request context. READ handlers also carry returned rows. Budget this starting cost for the data each extension receives.

Budget the added milliseconds against the application’s response-time target. Ratios alone exaggerate the impact when the native reference is very fast.

## 2. How does overhead change across scenarios?

The following comparisons add calculation, auxiliary database queries and invocation through a predefined extension point. Native and Oyster perform the same work in each comparison.

| Synthetic arithmetic workload | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [Calculation action](source/srv/BenchmarkService/on-oysterCalculation.js) | 0.171 | 0.97 | +0.799 |

Repeated arithmetic amplifies the execution cost. Treat these as stress cases when assessing ordinary business constraints.

| Auxiliary query workload | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [Action: CQL read](source/srv/BenchmarkService/on-oysterCqlRead.js) | 0.89 | 2.653 | +1.763 |
| [Action: CQL update](source/srv/BenchmarkService/on-oysterCqlWrite.js) | 0.882 | 2.334 | +1.452 |

All request-time differences include dispatch, handler work, query handling, response processing and transaction completion. They measure the overhead of the complete Oyster execution path.

| Small calculation workload | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [INSERT](source/srv/BenchmarkService/OysterCalculationWriteRows/before-CREATE.js) | 0.545 | 1.304 | +0.759 |
| [UPDATE](source/srv/BenchmarkService/OysterCalculationWriteRows/before-UPDATE.js) | 0.535 | 1.316 | +0.781 |
| [READ 10 rows from million-row table](source/srv/BenchmarkService/OysterCalculationLargeRows/after-READ.js) | 0.402 | 1.344 | +0.942 |

| Predefined extension-point work | Extra Oyster ms |
| --- | --- |
| [empty handler](source/srv/BenchmarkExtensionService/on-oysterEmpty.js) | +0.724 |
| [CQL read](source/srv/BenchmarkExtensionService/on-oysterCqlRead.js) | +0.765 |
| [CQL write](source/srv/BenchmarkExtensionService/on-oysterCqlWrite.js) | +0.904 |

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
    y-axis "Mean request time (ms)" 0 --> 3.0244237
    bar [1.0048944226327954, 0.45981111781574885, 2.7494760584551154, 1.4322291205389643]
```

| Equivalent lookup work | Oyster ms |
| --- | --- |
| [Individual queries](source/srv/BenchmarkService/on-oysterLookupIndividual.js) | 2.749 |
| [One batch](source/srv/BenchmarkService/on-oysterLookupBatch.js) | 1.432 |

The same 10 distinct keys, columns, arithmetic and scalar result are preserved. -1.317 ms (-47.909%) is the matched difference.

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
    y-axis "Mean request time (ms)" 0 --> 2.9186703
    bar [0.3503323798322393, 0.8902897182810356, 1.1355881761808162, 2.6533366259234366]
```

Oyster handlers: [Oyster CQL read](source/srv/BenchmarkService/on-oysterCqlRead.js).

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
    y-axis "Mean request time (ms)" 0 --> 2.5674629
    bar [0.3274491808338294, 0.8818198361136153, 1.1280284470655941, 2.3340571446280967]
```

Oyster handlers: [Oyster CQL write](source/srv/BenchmarkService/on-oysterCqlWrite.js).

| Query work | Native ms per added query | Oyster ms per added callback | Extra Oyster ms per callback |
| --- | --- | --- | --- |
| [CQL read](source/srv/BenchmarkService/on-oysterCqlRead.js) | 0.06 | 0.169 | +0.109 |
| [CQL update](source/srv/BenchmarkService/on-oysterCqlWrite.js) | 0.062 | 0.134 | +0.072 |

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
    y-axis "Mean request time (ms)" 0 --> 21.079817
    bar [1.8418580074453224, 6.381056753205128, 1.9757049885572115, 19.16347035576923]
```

| Large-result work | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| Empty READ handler | 1.842 | 6.381 | +4.539 |
| READ with per-row arithmetic | 1.976 | 19.163 | +17.188 |

Oyster handlers: [Oyster empty handler](source/srv/BenchmarkService/OysterEmptyLargeRows/after-READ.js), [Oyster calculation](source/srv/BenchmarkService/OysterCalculationLargeRows/after-READ.js).

Transferring and handling 1,000 rows through an [empty Oyster handler](source/srv/BenchmarkService/OysterEmptyLargeRows/after-READ.js) costs about 5 ms extra in this run. Per-row arithmetic adds further overhead. Bound both the result size and the work per row.

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
    y-axis "Mean request time (ms)" 0 --> 172.33944
    bar [11.04586078116344, 156.67221500000002]
```

| Large-result work | Native ms | Oyster ms | Extra ms |
| --- | --- | --- | --- |
| [READ loop over 10,000 rows](source/srv/BenchmarkService/on-oysterScan.js) | 11.046 | 156.672 | +145.626 |

Oyster handlers: [Oyster calculation](source/srv/BenchmarkService/on-oysterScan.js).

Paging bounds each invocation’s payload, but a scan still processes the complete dataset. Use bounded pages and a separate latency budget for bulk work.

### Concurrent load and capacity

Oyster handlers: [Oyster CQL read](source/srv/BenchmarkService/on-oysterCqlRead.js).

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
    y-axis "Successful requests/s" 0 --> 4021.7682
    bar [2736.870363247406, 861.2304127635796, 3656.1529291925895, 2455.961883772213, 3633.7316544453865, 2455.473404540736]
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
    y-axis "Mean request time (ms)" 0 --> 14.225379
    bar [0.3503323798322393, 1.1355881761808162, 2.16594365029256, 3.226719393088762, 8.742479947847507, 12.93216252101695]
```

| Load | Native requests/s | Oyster requests/s | Native mean ms | Oyster mean ms | Extra mean ms | Native p95 ms | Oyster p95 ms | Extra p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 concurrent client | 2736.87 | 861.23 | 0.35 | 1.136 | +0.785 | 0.461 | 1.244 | +0.783 |
| 8 concurrent clients | 3656.153 | 2455.962 | 2.166 | 3.227 | +1.061 | 3.669 | 4.321 | +0.652 |
| 32 concurrent clients | 3633.732 | 2455.473 | 8.742 | 12.932 | +4.19 | 11.37 | 15.045 | +3.675 |

Oyster benefits from concurrent requests and sustains near-peak throughput at 32 concurrent clients.

The throughput plateau means that additional clients mainly increase request latency. Limit in-flight work around the throughput knee instead of raising concurrency to chase more capacity.

The per-request delta shows how Oyster’s added latency changes with load. Use it with the complete round-trip time and throughput to choose a concurrency limit.

Recorded higher-load failures: 0. Successful response latency excludes failed or unsuitable runs. The load generator sends the next request after a response; these are closed-loop concurrency measurements on one machine with local SQLite. They do not establish independently scheduled arrival-rate capacity or horizontal scaling across servers.

## 4. How do measured costs relate to Oyster’s runtime work?

During an Oyster invocation, a request crosses an isolation boundary, the handler executes as JavaScript inside WebAssembly, and its result must be reintegrated into CAP. Database callbacks additionally validate service-scoped queries, preserve the CAP request context, execute through the service and return encoded results. The runtime also applies configured resource limits and propagates handler errors back to CAP.

The native reference executes in Node.js. Oyster evaluates the handler JavaScript inside its prebuilt WASM framework. The runtime reuses the framework and supports concurrent execution. These measurements do not identify sandbox pool size or utilization. The measured warm phase covers repeated invocations and CAP integration. Startup, initial framework loading and warmup precede it.

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
| Run | bench-2026-11-06T14-09-44-925Z |
| Hardware / OS | Apple M2 Pro / darwin / arm64 |
| Node / CAP / Oyster / SQLite adapter | v22.18.0 / 10.2.2 / 0.5.6 / 3.1.2 |
| Protocol / repetitions | short / 1 |
| Warmup / measured seconds per case | 2 / 4 |
| Validation | Passed |

Both app copies use the same model and retained CSVs. The CDS CLI deploys SQLite while CAP is stopped. Fixed projections and stored handlers are reused across cases; writes rotate seeded rows and allocate distinct keys. Native and Oyster handlers share the app with Oyster installed; the plain CAP control omits the plugin. Server startup and warmup are outside measured request time.

Run npm install and npm run benchmark for short, or npm run benchmark:long for repeated/larger workloads. The [README](../../README.md) gives complete operator instructions. The runner starts and stops CAP and the load generator.

This example contains the main report and source snapshots of its linked Oyster handlers. [Native handlers](source/srv/benchmark-service.js), [extension-point delegation](source/srv/extension-service.js), [constraint checks](source/lib/validation.js) and [calculation helpers](source/lib/workload.js) show the matching application code. These results use the recorded local working tree. Complete per-case details, measurements and raw timings remain in the local result directory `reports/bench-2026-11-06T14-09-44-925Z/`.

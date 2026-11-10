# Changelog

## Unreleased

- Publish corrected Java short/long examples and refresh existing local/BTP examples with the current report format and workload ordering, preserving recorded measurements.
- Order workload tables by operation and scenario, grouping native/Oyster comparisons and repetitions without changing measurements or execution order.
- Fix HTTP latency tracking across server-initiated connection closure and reserve separate INSERT keys for correctness checks, warmup and measurement.
- Add local CAP Java/SQLite benchmarks with a Node.js MTX sidecar, shared CDS models and JavaScript Oyster handlers, native Java handlers, runtime selection, JVM metrics and documented short/long commands. Preserve Node.js local and BTP workflows and exclude Java runs from the existing four-report overview.

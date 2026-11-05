using { perf } from 'oyster-benchmark-base';

@path: '/benchmark'
service BenchmarkService {
  @extensible.code
  entity SmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity LargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity WriteRows as projection on perf.WriteRows;
  entity LookupRows as projection on perf.LookupRows;
  entity SideEffectRows as projection on perf.SideEffectRows;

  @extensible.code
  action noop();
  @extensible.code
  action compute(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  @extensible.code
  action scan(cursor: Integer, count: Integer, pageSize: Integer) returns Integer;
  action rollbackProbe(ID: Integer, effectID: Integer, value: Integer);
  action probe() returns Integer;
}

using { perf } from 'oyster-benchmark-base';

@path: '/benchmark'
service BenchmarkService {
  @extensible.code
  entity NoHandlerWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity NoHandlerSmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NoHandlerLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NativeEmptyWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity NativeEmptySmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NativeEmptyLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity OysterEmptyWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity OysterEmptySmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity OysterEmptyLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NativeCalculationWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity NativeCalculationSmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NativeCalculationLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity OysterCalculationWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity OysterCalculationSmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity OysterCalculationLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NativeCqlReadWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity NativeCqlReadSmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NativeCqlReadLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity OysterCqlReadWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity OysterCqlReadSmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity OysterCqlReadLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NativeCqlWriteWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity NativeCqlWriteSmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity NativeCqlWriteLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity OysterCqlWriteWriteRows as projection on perf.WriteRows;
  @extensible.code
  entity OysterCqlWriteSmallRows as projection on perf.SmallRows { *, virtual null as checksum : Integer };
  @extensible.code
  entity OysterCqlWriteLargeRows as projection on perf.LargeRows { *, virtual null as checksum : Integer };
  entity LookupRows as projection on perf.LookupRows;
  entity SideEffectRows as projection on perf.SideEffectRows;

  action noop();
  action nativeNoop();
  @extensible.code
  action oysterNoop();
  action nativeCalculation(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCqlRead(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCqlWrite(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeDirectRead(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeDirectWrite(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  @extensible.code
  action oysterCalculation(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  @extensible.code
  action oysterCqlRead(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  @extensible.code
  action oysterCqlWrite(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeEmptyExtension(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCalculationExtension(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCqlReadExtension(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCqlWriteExtension(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action oysterEmptyExtension(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action oysterCalculationExtension(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action oysterCqlReadExtension(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action oysterCqlWriteExtension(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action extensionBypass(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action extensionUnimplemented(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeScan(cursor: Integer, count: Integer, pageSize: Integer, iterations: Integer) returns Integer;
  @extensible.code
  action oysterScan(cursor: Integer, count: Integer, pageSize: Integer, iterations: Integer) returns Integer;
  action rollbackProbe(ID: Integer, effectID: Integer, value: Integer, entity: String);
  action probe() returns Integer;
}

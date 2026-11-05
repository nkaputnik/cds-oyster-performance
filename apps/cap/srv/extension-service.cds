using { perf } from 'oyster-benchmark-base';

@path: '/benchmark-extension'
@extensible.code
service BenchmarkExtensionService {
  entity LookupRows as projection on perf.LookupRows;
  entity SideEffectRows as projection on perf.SideEffectRows;
  action nativeEmpty(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCalculation(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCqlRead(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCqlWrite(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action oysterEmpty(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action oysterCalculation(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action oysterCqlRead(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action oysterCqlWrite(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action unimplemented(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
}

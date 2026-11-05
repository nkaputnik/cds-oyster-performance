using { perf } from 'oyster-benchmark-base';

@path: '/benchmark-extension'
@extensible.code
service BenchmarkExtensionService {
  entity LookupRows as projection on perf.LookupRows;
  entity SideEffectRows as projection on perf.SideEffectRows;
  action evaluate(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
}

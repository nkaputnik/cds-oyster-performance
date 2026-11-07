using { perf } from '../db/schema';

@path: '/benchmark-extension'
service BenchmarkExtensionService {
  entity LookupRows as projection on perf.LookupRows;
  entity SideEffectRows as projection on perf.SideEffectRows;
  action nativeValidation(quantity: Integer, unitPrice: Integer, lookupID: Integer) returns Integer;
  action nativeValidationRead(quantity: Integer, unitPrice: Integer, lookupID: Integer) returns Integer;
  @extensible.code
  action oysterValidation(quantity: Integer, unitPrice: Integer, lookupID: Integer) returns Integer;
  @extensible.code
  action oysterValidationRead(quantity: Integer, unitPrice: Integer, lookupID: Integer) returns Integer;
  action nativeEmpty(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCalculation(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCqlRead(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action nativeCqlWrite(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  @extensible.code
  action oysterEmpty(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  @extensible.code
  action oysterCalculation(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  @extensible.code
  action oysterCqlRead(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  @extensible.code
  action oysterCqlWrite(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
  action unimplemented(seed: Integer, iterations: Integer, calls: Integer, lookupID: Integer, effectID: Integer) returns Integer;
}

namespace perf;

aspect TechnicalRow {
  key ID : Integer;
  groupNo : Integer;
  value : Integer;
  text : String(32);
}

entity SmallRows : TechnicalRow {};
entity LargeRows : TechnicalRow {};
entity WriteRows : TechnicalRow { lookupID : Integer; effectID : Integer; };
entity LookupRows : TechnicalRow {};
entity SideEffectRows : TechnicalRow {};

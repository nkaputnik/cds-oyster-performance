namespace perf;

aspect TechnicalRow {
  key ID : Integer;
  groupNo : Integer;
  value : Integer;
  text : String(32);
}

entity SmallRows : TechnicalRow {};
entity LargeRows : TechnicalRow {};
entity WriteRows : TechnicalRow { lookupID : Integer; effectID : Integer; quantity : Integer default 1; unitPrice : Integer default 1; };
entity LookupRows : TechnicalRow { limit : Integer default 1000; };
entity SideEffectRows : TechnicalRow {};

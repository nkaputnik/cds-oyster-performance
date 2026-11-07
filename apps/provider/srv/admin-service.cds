using { perf } from '../db/schema';

context benchmark.control {

entity CampaignLease {
  key ID : Integer;
  token : UUID;
  owner : String(128);
  userID : String(255);
  expiresAt : Timestamp;
  instanceID : String(128);
  resetJobID : UUID;
  resetStatus : String(16);
}

entity RestoreJobs {
  key ID : UUID;
  token : UUID;
  status : String(16);
  instanceID : String(128);
  startedAt : Timestamp;
  completedAt : Timestamp;
  before : LargeString;
  after : LargeString;
  error : LargeString;
}
}

@path: '/benchmark-admin'
@requires: 'BenchmarkAdministrator'
service BenchmarkAdminService {
  action inspectFixture() returns LargeString;
  action readReference(specification : LargeString) returns LargeString;
  action scanReference(specification : LargeString) returns LargeString;
  action writeStateHash() returns LargeString;
  action state() returns LargeString;
  action acquireLease(owner : String(128), ttlMs : Integer) returns LargeString;
  action renewLease(leaseToken : UUID, ttlMs : Integer) returns LargeString;
  action releaseLease(leaseToken : UUID) returns LargeString;
  action metricsStart(leaseToken : UUID) returns LargeString;
  action metricsStop(leaseToken : UUID) returns LargeString;
  action reset(leaseToken : UUID) returns LargeString;
  action resetStatus(leaseToken : UUID, jobID : UUID) returns LargeString;
}

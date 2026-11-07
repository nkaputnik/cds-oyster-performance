const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { resolve } = require('node:path');
const { ResourceSampler } = require('./resources.js');
const fixture = require('./fixture-data.js');
const { integer } = require('./fixture-reference.js');
const { instance } = require('./provider-state.js');

const LEASES = 'benchmark.control.CampaignLease', JOBS = 'benchmark.control.RestoreJobs';
const LEASE_COLUMNS = ['ID', 'token', 'owner', 'userID', 'expiresAt', 'instanceID', 'resetJobID', 'resetStatus'];
const JOB_COLUMNS = ['ID', 'token', 'status', 'instanceID', 'startedAt', 'completedAt', 'before', 'after', 'error'];
const JOB_STATE_COLUMNS = ['ID', 'status', 'instanceID', 'startedAt', 'completedAt', 'error'];
const guards = new Map();
let metrics;

function enterBenchmarkRequest(req) {
  if (!req.tenant) return;
  let guard = guards.get(req.tenant);
  if (!guard) { guard = { reset: false, active: 0 }; guards.set(req.tenant, guard); }
  if (guard.reset) req.reject(503, 'Fixture restoration is active');
  guard.active++;
  req.once('done', () => { guard.active--; });
}
function decodeJob(row) {
  if (!row) return null;
  const { token, ...job } = row;
  for (const name of ['before', 'after']) job[name] = job[name] ? JSON.parse(job[name]) : null;
  return job;
}
async function leaseRow(req, lock = false) {
  const query = cds.ql.SELECT.one.from(LEASES).columns(...LEASE_COLUMNS).where({ ID: 1 });
  if (lock) query.forUpdate();
  return cds.db.tx(req).run(query);
}
async function ownedLease(req, { lock = true, expired = false } = {}) {
  const row = await leaseRow(req, lock);
  if (!row?.token || row.token !== req.data.leaseToken || row.userID !== req.user.id || row.instanceID !== instance.ID ||
    (!expired && Date.parse(row.expiresAt) <= Date.now())) req.reject(409, 'Active owned benchmark lease required');
  return row;
}
const ttl = req => integer(req, req.data.ttlMs ?? 300000, 1000, 3600000, 'lease duration');
const dataRoot = () => cds.env.benchmark?.dataRoot || resolve(cds.root, 'db/data');

async function acquireLease(req) {
  const duration = ttl(req), row = await leaseRow(req, true);
  if (typeof req.data.owner !== 'string' || !req.data.owner.trim() || req.data.owner.length > 128) req.reject(400, 'Benchmark lease owner required');
  if (row?.resetStatus === 'running' || guards.get(req.tenant)?.reset || metrics?.tenant === req.tenant ||
    (row?.token && Date.parse(row.expiresAt) > Date.now())) req.reject(409, 'Benchmark lease or restoration is already active');
  const lease = { ID: 1, token: randomUUID(), owner: req.data.owner, userID: req.user.id,
    expiresAt: new Date(Date.now() + duration).toISOString(), instanceID: instance.ID, resetJobID: row?.resetJobID || null, resetStatus: row?.resetStatus || null };
  if (row) await cds.db.tx(req).run(cds.ql.UPDATE(LEASES).set(lease).where({ ID: 1 }));
  else {
    try { await cds.db.tx(req).run(cds.ql.INSERT.into(LEASES).entries(lease)); }
    catch (error) { if (error.code === 'ENTITY_ALREADY_EXISTS' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 301) req.reject(409, 'Benchmark lease was acquired concurrently'); throw error; }
  }
  req.once('succeeded', () => { if (!guards.has(req.tenant)) guards.set(req.tenant, { reset: false, active: 0 }); });
  return lease;
}
async function renewLease(req) {
  const row = await ownedLease(req, { expired: true });
  if (Date.parse(row.expiresAt) <= Date.now() && row.resetStatus !== 'running' && metrics?.token !== row.token)
    req.reject(409, 'Benchmark lease has expired');
  row.expiresAt = new Date(Date.now() + ttl(req)).toISOString();
  await cds.db.tx(req).run(cds.ql.UPDATE(LEASES).set({ expiresAt: row.expiresAt }).where({ ID: 1, token: row.token }));
  return row;
}
async function releaseLease(req) {
  const row = await ownedLease(req, { expired: true });
  if (row.resetStatus === 'running' || metrics?.token === row.token) req.reject(409, 'Restoration or metrics still owned by this lease');
  await cds.db.tx(req).run(cds.ql.UPDATE(LEASES).set({ token: null, owner: null, userID: null, expiresAt: null }).where({ ID: 1, token: row.token }));
  return { released: true };
}
async function metricsStart(req) {
  const row = await ownedLease(req);
  if (metrics || row.resetStatus === 'running' || [...guards.values()].some(guard => guard.reset)) req.reject(409, 'Provider metrics or restoration is already active');
  const sampler = new ResourceSampler();
  metrics = { tenant: req.tenant, token: row.token, sampler };
  sampler.start();
  req.once('failed', () => { if (metrics?.sampler === sampler) { sampler.stop(); metrics = null; } });
  return { started: true, instance };
}
async function metricsStop(req) {
  const row = await ownedLease(req, { expired: true });
  if (!metrics || metrics.token !== row.token || metrics.tenant !== req.tenant) req.reject(409, 'Owned provider metrics are not running');
  const result = metrics.sampler.stop(); metrics = null;
  return { ...result, instance };
}
async function drain(tenant) {
  const deadline = Date.now() + 120000;
  while (guards.get(tenant)?.active) {
    if (Date.now() > deadline) throw new Error('Benchmark requests did not finish before restoration');
    await delay(10);
  }
}
async function reset(req) {
  const lease = await ownedLease(req);
  if (lease.resetStatus === 'running' || guards.get(req.tenant)?.reset || metrics) req.reject(409, 'Restoration or provider metrics is already active');
  const guard = guards.get(req.tenant) || { reset: false, active: 0 };
  guard.reset = true; guards.set(req.tenant, guard);
  req.once('failed', () => { guard.reset = false; });
  const job = { ID: randomUUID(), token: lease.token, status: 'running', instanceID: instance.ID,
    startedAt: new Date().toISOString(), completedAt: null, before: null, after: null, error: null };
  await cds.db.tx(req).run(cds.ql.INSERT.into(JOBS).entries(job));
  await cds.db.tx(req).run(cds.ql.UPDATE(LEASES).set({ resetJobID: job.ID, resetStatus: 'running' }).where({ ID: 1, token: lease.token }));
  const tenant = req.tenant, user = req.user;
  req.once('succeeded', () => {
    const background = cds.spawn({ tenant, user }, async tx => {
      await drain(tenant);
      const sources = await fixture.sourceIdentities(dataRoot());
      job.before = JSON.stringify(await fixture.inspectDatabase(tx, sources));
      for (const name of fixture.TABLES) {
        await tx.run(cds.ql.DELETE.from(fixture.table(name)));
        for await (const batch of fixture.csvBatches(fixture.sourcePath(dataRoot(), name), name))
          await tx.run(cds.ql.INSERT.into(fixture.table(name)).entries(batch));
      }
      const after = await fixture.inspectDatabase(tx, sources);
      if (!after.valid) throw new Error('Restored database canonical identity differs from retained CSV input');
      job.after = JSON.stringify(after); job.status = 'succeeded'; job.completedAt = new Date().toISOString();
      await tx.run(cds.ql.UPDATE(JOBS).set(job).where({ ID: job.ID }));
      await tx.run(cds.ql.UPDATE(LEASES).set({ resetStatus: job.status }).where({ ID: 1, token: lease.token }));
    });
    background.on('succeeded', () => { guard.reset = false; });
    background.on('failed', async error => {
      job.status = 'failed'; job.error = String(error.message).slice(0, 4096); job.after = null; job.completedAt = new Date().toISOString();
      try {
        await cds.db.tx({ tenant, user }, async tx => {
          await tx.run(cds.ql.UPDATE(JOBS).set(job).where({ ID: job.ID }));
          await tx.run(cds.ql.UPDATE(LEASES).set({ resetStatus: 'failed' }).where({ ID: 1, token: lease.token }));
        });
        guard.reset = false;
      } catch (failure) { cds.log('benchmark-admin').error('Unable to persist failed restoration status', failure); }
    });
  });
  return decodeJob(job);
}
async function resetStatus(req) {
  await ownedLease(req, { lock: false, expired: true });
  const job = await cds.db.tx(req).run(cds.ql.SELECT.one.from(JOBS).columns(...JOB_COLUMNS).where({ ID: req.data.jobID, token: req.data.leaseToken }));
  if (!job) req.reject(404, 'Owned restoration job not found');
  return decodeJob(job);
}
async function controlState(req) {
  const lease = await leaseRow(req), reset = lease?.resetJobID ? await cds.db.tx(req).run(cds.ql.SELECT.one.from(JOBS).columns(...JOB_STATE_COLUMNS).where({ ID: lease.resetJobID })) : null;
  return { lease: lease ? { owner: lease.owner, expiresAt: lease.expiresAt, instanceID: lease.instanceID, active: Boolean(lease.token && Date.parse(lease.expiresAt) > Date.now()) } : null,
    reset: reset || null, resetting: lease?.resetStatus === 'running',
    metrics: metrics ? { tenant: metrics.tenant, running: true, instance } : { running: false } };
}
module.exports = { enterBenchmarkRequest, acquireLease, renewLease, releaseLease, metricsStart, metricsStop, reset, resetStatus, controlState };

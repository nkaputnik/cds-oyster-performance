const cds = require('@sap/cds');
const { createHash } = require('node:crypto');
const { Readable, Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const { SELECT, INSERT, UPDATE } = cds.ql;

const PART_BYTES = 48 * 1024;
const MAX_BYTES = 1024 * 1024 * 1024;
const RUN_COLUMNS = ['ID', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy', 'manifest', 'status', 'finishedAt', 'finalArtifact_ID'];
const ARTIFACT_COLUMNS = ['ID', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy', 'run_ID', 'path', 'originalBytes', 'compressedBytes',
  'originalSha256', 'compressedSha256', 'partCount', 'compression', 'status', 'completedAt'];
class IntegrityError extends Error {}

function logicalPath(req, path) {
  if (typeof path !== 'string' || !path.length || path.length > 1024 || path.split('/').some(segment =>
    !/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..' || segment.length > 255))
    req.reject(400, 'Unsafe logical artifact path');
}

function integer(req, value, min, max, name) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) req.reject(400, 'Invalid ' + name);
  return number;
}

function identity(req, value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    req.reject(400, 'UUID identity required');
  return value;
}

async function partBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === 'string') return Buffer.from(content, 'base64');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of content) {
    bytes += chunk.length;
    if (bytes > PART_BYTES) { content.destroy(); throw new IntegrityError('Evidence part exceeds byte bound'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function meter(limit) {
  const state = { bytes: 0, hash: createHash('sha256') };
  state.stream = new Transform({ transform(chunk, encoding, done) {
    state.bytes += chunk.length;
    if (state.bytes > limit) return done(new IntegrityError('Evidence content exceeds declared byte bound'));
    state.hash.update(chunk);
    done(null, chunk);
  } });
  return state;
}

module.exports = class BenchmarkEvidenceService extends cds.ApplicationService {
  init() {
    const { Runs, Artifacts, ArtifactParts } = this.model.entities('benchmark.evidence');
    const runByID = ID => SELECT.one.from(Runs).columns(RUN_COLUMNS).where({ ID });
    const artifactByID = ID => SELECT.one.from(Artifacts).columns(ARTIFACT_COLUMNS).where({ ID });
    const openRun = async (req, ID) => {
      const run = await runByID(identity(req, ID)).forUpdate();
      if (!run) req.reject(404, 'Evidence run not found');
      if (run.status !== 'open') req.reject(409, 'Evidence run is finished');
      return run;
    };
    // Lock the run first for every mutation, including completion, to serialize its artifact lifecycle.
    const pendingArtifact = async (req, ID) => {
      let artifact = await artifactByID(identity(req, ID));
      if (!artifact) req.reject(404, 'Evidence artifact not found');
      await openRun(req, artifact.run_ID);
      artifact = await artifactByID(ID);
      if (artifact.status !== 'pending') req.reject(409, 'Completed evidence artifacts are immutable');
      return artifact;
    };
    this.before('*', req => {
      if (!req.user.is('authenticated-user') || !req.tenant) req.reject(403, 'Authenticated tenant context required');
    });
    this.on('beginRun', async req => {
      const { manifest } = req.data;
      let parsed;
      try { parsed = JSON.parse(manifest); } catch { req.reject(400, 'Run manifest must be a JSON object'); }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Buffer.byteLength(manifest) > 32 * 1024)
        req.reject(400, 'Run manifest must be a JSON object of at most 32 KiB');
      const run = { ID: cds.utils.uuid(), manifest: req.data.manifest, status: 'open' };
      await INSERT.into(Runs).entries(run);
      return runByID(run.ID);
    });
    this.on('beginArtifact', async req => {
      const { runID, path, originalSha256, compressedSha256 } = req.data;
      logicalPath(req, path);
      const originalBytes = integer(req, req.data.originalBytes, 0, MAX_BYTES, 'original byte count');
      const compressedBytes = integer(req, req.data.compressedBytes, 1, MAX_BYTES, 'compressed byte count');
      const partCount = integer(req, req.data.partCount, 1, Math.ceil(MAX_BYTES / PART_BYTES), 'part count');
      if (partCount !== Math.ceil(compressedBytes / PART_BYTES)) req.reject(400, 'Part count does not match compressed byte count');
      for (const hash of [originalSha256, compressedSha256])
        if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) req.reject(400, 'SHA-256 identity must contain 64 lowercase hexadecimal characters');
      await openRun(req, runID);
      if (await SELECT.one.from(Artifacts).columns('ID').where({ run_ID: runID, path })) req.reject(409, 'Artifact path already exists in run');
      const artifact = { ID: cds.utils.uuid(), run_ID: runID, path, originalBytes, compressedBytes, originalSha256, compressedSha256,
        partCount, compression: 'gzip', status: 'pending' };
      await INSERT.into(Artifacts).entries(artifact);
      return artifactByID(artifact.ID);
    });
    this.on('putPart', async req => {
      const artifact = await pendingArtifact(req, req.data.artifactID);
      const ordinal = integer(req, req.data.ordinal, 0, artifact.partCount - 1, 'part ordinal');
      const supplied = req.data.content;
      if (!Buffer.isBuffer(supplied) && typeof supplied !== 'string') req.reject(400, 'Binary part content required');
      const content = await partBuffer(supplied);
      const expectedBytes = ordinal === artifact.partCount - 1 ? Number(artifact.compressedBytes) - ordinal * PART_BYTES : PART_BYTES;
      if (content.length > PART_BYTES || content.length !== expectedBytes) req.reject(400, 'Part content has an invalid byte count');
      if (await SELECT.one.from(ArtifactParts).columns('ID').where({ artifact_ID: artifact.ID, ordinal })) req.reject(409, 'Part ordinal already uploaded');
      await INSERT.into(ArtifactParts).entries({ ID: cds.utils.uuid(), artifact_ID: artifact.ID, ordinal, bytes: content.length, content });
    });
    this.on('completeArtifact', async req => {
      const artifact = await pendingArtifact(req, req.data.artifactID);
      const parts = await SELECT.from(ArtifactParts).columns('ordinal', 'bytes').where({ artifact_ID: artifact.ID }).orderBy('ordinal');
      if (parts.length !== artifact.partCount || parts.some((part, ordinal) => part.ordinal !== ordinal || part.bytes !==
        (ordinal === artifact.partCount - 1 ? Number(artifact.compressedBytes) - ordinal * PART_BYTES : PART_BYTES)))
        req.reject(409, 'Artifact does not contain all expected ordered parts');
      const compressed = meter(Number(artifact.compressedBytes)), original = meter(Number(artifact.originalBytes));
      async function* content() {
        for (const part of parts) {
          const row = await SELECT.one.from(ArtifactParts).columns('content').where({ artifact_ID: artifact.ID, ordinal: part.ordinal });
          const bytes = await partBuffer(row.content);
          if (bytes.length !== part.bytes) throw new IntegrityError('Evidence part byte count mismatch');
          yield bytes;
        }
      }
      try {
        await pipeline(Readable.from(content()), compressed.stream, createGunzip(), original.stream,
          new Writable({ write(chunk, encoding, done) { done(); } }));
      } catch (error) {
        if (error instanceof IntegrityError || /^Z_/.test(error.code)) req.reject(422, 'Evidence artifact gzip or content validation failed');
        throw error;
      }
      if (compressed.bytes !== Number(artifact.compressedBytes) || original.bytes !== Number(artifact.originalBytes) ||
        compressed.hash.digest('hex') !== artifact.compressedSha256 || original.hash.digest('hex') !== artifact.originalSha256)
        req.reject(422, 'Evidence artifact byte counts or SHA-256 identities do not match');
      await UPDATE(Artifacts).set({ status: 'complete', completedAt: new Date().toISOString() }).where({ ID: artifact.ID });
      return artifactByID(artifact.ID);
    });
    this.on('getPart', async req => {
      const artifact = await artifactByID(identity(req, req.data.artifactID));
      if (!artifact) req.reject(404, 'Evidence artifact not found');
      if (artifact.status !== 'complete') req.reject(409, 'Evidence artifact is incomplete');
      const ordinal = integer(req, req.data.ordinal, 0, artifact.partCount - 1, 'part ordinal');
      const row = await SELECT.one.from(ArtifactParts).columns('content').where({ artifact_ID: artifact.ID, ordinal });
      if (!row) req.reject(404, 'Evidence part not found');
      return (await partBuffer(row.content)).toString('base64');
    });
    this.on('finishRun', async req => {
      const { runID, status, finalArtifactID } = req.data;
      if (!['passed', 'failed', 'interrupted'].includes(status)) req.reject(400, 'Invalid final run status');
      await openRun(req, runID);
      const final = await artifactByID(identity(req, finalArtifactID));
      if (!final || final.run_ID !== runID || final.status !== 'complete') req.reject(409, 'Final report must be a completed artifact in this run');
      if (status === 'passed' && await SELECT.one.from(Artifacts).columns('ID').where({ run_ID: runID, status: 'pending' }))
        req.reject(409, 'Run has incomplete artifacts');
      await UPDATE(Runs).set({ status, finishedAt: new Date().toISOString(), finalArtifact_ID: finalArtifactID }).where({ ID: runID });
      return runByID(runID);
    });
    return super.init();
  }
};

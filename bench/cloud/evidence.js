const { createHash } = require('node:crypto');
const { constants, createWriteStream } = require('node:fs');
const { lstat, mkdir, mkdtemp, open, realpath, rename, rm } = require('node:fs/promises');
const { dirname, join, resolve } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGzip, createGunzip } = require('node:zlib');

const PART_BYTES = 48 * 1024;
const MAX_BYTES = 1024 * 1024 * 1024;

function logicalPath(path) {
  if (typeof path !== 'string' || !path.length || path.length > 1024 || path.split('/').some(segment =>
    !/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..' || segment.length > 255))
    throw new Error('Unsafe logical artifact path');
  return path;
}

function identity(ID) {
  if (typeof ID !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ID))
    throw new Error('Artifact or run UUID required');
  return ID;
}

async function safeRoot(root) {
  if (typeof root !== 'string' || !root) throw new Error('Artifact root path required');
  const path = resolve(root);
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory())
    throw new Error('Symlink traversal or invalid artifact root path');
  return path;
}

async function safePath(root, path, createDirectories = false) {
  let target = await safeRoot(root);
  const segments = logicalPath(path).split('/');
  for (const [index, segment] of segments.entries()) {
    target = join(target, segment);
    const isDirectory = index < segments.length - 1;
    let stat;
    try { stat = await lstat(target); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (isDirectory && createDirectories) { await mkdir(target); stat = await lstat(target); }
      else if (isDirectory) throw error;
    }
    if (stat?.isSymbolicLink()) throw new Error('Symlink traversal in artifact path');
    if (stat && (isDirectory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Invalid artifact file path');
  }
  return target;
}

function meter(limit) {
  const state = { bytes: 0, hash: createHash('sha256') };
  state.stream = new Transform({ transform(chunk, encoding, done) {
    state.bytes += chunk.length;
    if (state.bytes > limit) return done(new Error('Evidence content exceeds byte bound'));
    state.hash.update(chunk);
    done(null, chunk);
  } });
  return state;
}

function checkedMetadata(artifact) {
  identity(artifact.ID);
  logicalPath(artifact.path);
  for (const [field, min] of [['originalBytes', 0], ['compressedBytes', 1]]) {
    const value = Number(artifact[field]);
    if (!Number.isSafeInteger(value) || value < min || value > MAX_BYTES) throw new Error('Invalid artifact byte count');
  }
  if (!Number.isSafeInteger(artifact.partCount) || artifact.partCount !== Math.ceil(Number(artifact.compressedBytes) / PART_BYTES) ||
    artifact.compression !== 'gzip' || artifact.status !== 'complete') throw new Error('Artifact is incomplete or has invalid compression metadata');
  for (const field of ['originalSha256', 'compressedSha256'])
    if (!/^[0-9a-f]{64}$/.test(artifact[field])) throw new Error('Invalid artifact SHA-256 metadata');
  return artifact;
}

// The caller awaits these operations between timed windows and supplies already cached auth headers.
function createEvidenceClient({ url, headers, scratch, signal, timeoutMs = 120000 }) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.search || endpoint.hash || endpoint.username || endpoint.password)
    throw new Error('Evidence service URL must be an HTTP endpoint without embedded credentials');
  if (!headers || !['object', 'function'].includes(typeof headers)) throw new Error('Cached evidence authentication headers required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Bounded evidence timeout required');
  const base = endpoint.href.replace(/\/+$/, '');
  const cachedHeaders = typeof headers === 'function' ? headers : () => ({ ...headers });

  async function api(path, data, method = 'POST') {
    const response = await fetch(base + '/' + path, {
      method, headers: { ...await cachedHeaders(), 'content-type': 'application/json' }, redirect: 'error',
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const error = new Error('Evidence request failed with HTTP ' + response.status);
      error.status = response.status;
      await response.body?.cancel();
      throw error;
    }
    return response.status === 204 ? undefined : response.json();
  }

  const getArtifact = artifactID => api('Artifacts(' + identity(artifactID) + ')', undefined, 'GET');
  const getRun = runID => api('Runs(' + identity(runID) + ')', undefined, 'GET');
  async function listArtifacts(runID) {
    identity(runID);
    const artifacts = [];
    for (let offset = 0;; offset += 100) {
      const page = await api('Artifacts?$filter=' + encodeURIComponent('run_ID eq ' + runID) + '&$top=100&$skip=' + offset, undefined, 'GET');
      if (!Array.isArray(page.value)) throw new Error('Invalid artifact listing');
      artifacts.push(...page.value);
      if (page.value.length < 100) return artifacts;
    }
  }

  async function uploadArtifact({ runID, path, root }) {
    identity(runID);
    const source = await safePath(root, path);
    const temporary = await mkdtemp(join(await safeRoot(scratch), '.evidence-upload-'));
    let sourceFile, archive;
    try {
      sourceFile = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await sourceFile.stat()).isFile()) throw new Error('Artifact source must be a regular file');
      const gzipFile = join(temporary, 'artifact.gz'), original = meter(MAX_BYTES), compressed = meter(MAX_BYTES);
      await pipeline(sourceFile.createReadStream({ autoClose: false }), original.stream, createGzip(), compressed.stream,
        createWriteStream(gzipFile, { flags: 'wx', mode: 0o600 }), ...(signal ? [{ signal }] : []));
      await sourceFile.close(); sourceFile = null;
      const partCount = Math.ceil(compressed.bytes / PART_BYTES);
      const artifact = await api('beginArtifact', { runID, path, originalBytes: original.bytes, compressedBytes: compressed.bytes,
        originalSha256: original.hash.digest('hex'), compressedSha256: compressed.hash.digest('hex'), partCount });
      archive = await open(gzipFile, 'r');
      for (let ordinal = 0; ordinal < partCount; ordinal++) {
        signal?.throwIfAborted();
        const size = Math.min(PART_BYTES, compressed.bytes - ordinal * PART_BYTES);
        const buffer = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await archive.read(buffer, offset, size - offset, ordinal * PART_BYTES + offset);
          if (!bytesRead) throw new Error('Unexpected end of compressed evidence file');
          offset += bytesRead;
        }
        await api('putPart', { artifactID: artifact.ID, ordinal, content: buffer.toString('base64') });
      }
      return await api('completeArtifact', { artifactID: artifact.ID });
    } finally {
      await sourceFile?.close();
      await archive?.close();
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function downloadArtifact({ artifactID, root, restorePath }) {
    const artifact = checkedMetadata(await getArtifact(artifactID));
    const path = restorePath === undefined ? artifact.path : logicalPath(restorePath);
    const target = await safePath(root, path, true);
    const temporary = await mkdtemp(join(dirname(target), '.evidence-download-'));
    const destination = join(temporary, 'artifact');
    const compressed = meter(Number(artifact.compressedBytes)), original = meter(Number(artifact.originalBytes));
    async function* parts() {
      for (let ordinal = 0; ordinal < artifact.partCount; ordinal++) {
        const result = await api('getPart', { artifactID, ordinal });
        if (typeof result.value !== 'string' || result.value.length > 4 * Math.ceil(PART_BYTES / 3))
          throw new Error('Invalid evidence part encoding or size: ' + typeof result.value + ', ' + result.value?.length);
        const part = Buffer.from(result.value, 'base64');
        const expected = Math.min(PART_BYTES, Number(artifact.compressedBytes) - ordinal * PART_BYTES);
        if (part.length !== expected) throw new Error('Evidence part byte count mismatch');
        yield part;
      }
    }
    try {
      await pipeline(Readable.from(parts()), compressed.stream, createGunzip(), original.stream,
        createWriteStream(destination, { flags: 'wx', mode: 0o600 }), ...(signal ? [{ signal }] : []));
      if (compressed.bytes !== Number(artifact.compressedBytes) || original.bytes !== Number(artifact.originalBytes) ||
        compressed.hash.digest('hex') !== artifact.compressedSha256 || original.hash.digest('hex') !== artifact.originalSha256)
        throw new Error('Evidence byte counts or SHA-256 identities do not match');
      await safePath(root, path);
      await rename(destination, target);
      return target;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  return { beginRun: manifest => api('beginRun', { manifest: typeof manifest === 'string' ? manifest : JSON.stringify(manifest) }),
    getRun, getArtifact, listArtifacts, uploadArtifact, downloadArtifact,
    listRuns: async () => (await api('Runs?$orderby=createdAt%20desc&$top=20', undefined, 'GET')).value,
    finishRun: data => api('finishRun', data) };
}

module.exports = { createEvidenceClient, PART_BYTES, MAX_BYTES };

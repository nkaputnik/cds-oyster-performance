const { readFile, readdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { eligible } = require('./report.js');
const types = ['btp-long', 'btp-short', 'local-long', 'local-short'];

function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += c; i++; } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV field');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift();
  if (!headers?.includes('scenario.mode') || !headers.includes('stats.meanMs')) throw new Error('Benchmark CSV columns missing');
  const value = text => {
    if (text === '' || text === 'unavailable') return undefined;
    if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
    if (text === 'null') return null;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return Number(text);
    if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
    return text;
  };
  return rows.map(row => {
    if (row.length !== headers.length) throw new Error('CSV row column count differs');
    const record = {};
    headers.forEach((header, index) => {
      const parsed = value(row[index]); if (parsed === undefined) return;
      const path = header.split('.');
      if (path.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Unsafe CSV column');
      let target = record; for (const part of path.slice(0, -1)) target = target[part] ||= {};
      target[path.at(-1)] = parsed;
    });
    return record;
  });
}
async function loadResults(directory) {
  try { return JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return parseCsv(await readFile(resolve(directory, 'results.csv'), 'utf8'));
}
function complete(manifest, results) {
  return ['short', 'long'].includes(manifest.settings?.suite) && !manifest.settings.filter && !manifest.settings.pilot
    && !manifest.error && !manifest.persistenceError && manifest.runSummary?.passed === true
    && Number.isFinite(Date.parse(manifest.startedAt)) && Date.parse(manifest.finishedAt) >= Date.parse(manifest.startedAt)
    && Array.isArray(results) && results.length > 0 && manifest.runSummary.records === results.length
    && results.every(record => eligible(record) && record.validation?.passed === true && record.stats?.errors === 0);
}
async function discoverRuns(root, { requireFour = true, onSkip = () => {} } = {}) {
  const runs = {}, candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(root, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
      if (manifest.settings?.filter || manifest.settings?.pilot || !manifest.runSummary?.passed) continue;
    } catch (error) { if (error.code !== 'ENOENT') onSkip(directory, error.message); continue; }
    const execution = manifest.environment?.execution;
    if (manifest.settings?.runtime === 'java' || manifest.environment?.hostRuntime === 'java') continue;
    if (execution && !['cloud', 'local'].includes(execution)) continue;
    if (!['short', 'long'].includes(manifest.settings?.suite) || !Number.isFinite(Date.parse(manifest.startedAt))) continue;
    const type = (execution === 'cloud' ? 'btp' : 'local') + '-' + manifest.settings.suite;
    candidates.push({ type, directory, manifest });
  }
  candidates.sort((a, b) => Date.parse(b.manifest.startedAt) - Date.parse(a.manifest.startedAt) || b.directory.localeCompare(a.directory));
  for (const { type, directory, manifest } of candidates) {
    if (runs[type]) continue;
    let results;
    try { results = await loadResults(directory); }
    catch (error) { onSkip(directory, error.message); continue; }
    if (complete(manifest, results)) runs[type] = { directory, manifest, results };
  }
  const missing = types.filter(type => !runs[type]);
  if (requireFour && missing.length) throw new Error('Missing complete benchmark types: ' + missing.join(', '));
  return runs;
}
module.exports = { types, parseCsv, loadResults, discoverRuns };

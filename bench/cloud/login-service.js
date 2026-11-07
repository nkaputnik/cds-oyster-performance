const { randomBytes, scryptSync } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { password, defaultUrl } = require('./shared.js');
function loginCredentials({ username, publicOrigin, password }) {
  if (!username || username.includes(':') || new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith('https://')) throw new Error('Username and HTTPS public origin required');
  if (typeof password !== 'string' || !password || password.length > 256) throw new Error('Password must contain 1 to 256 characters');
  const salt = randomBytes(16).toString('hex');
  return { username, publicOrigin, salt, hash: scryptSync(password, salt, 32).toString('hex') };
}
async function main(args) {
  let username = 'colleague-demo', publicOrigin = defaultUrl, update = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') username = args[++i];
    else if (args[i] === '--url') publicOrigin = args[++i];
    else if (args[i] === '--update') update = true;
    else if (args[i] === '--help') { console.log('npm run btp:setup-login -- [--user USER] [--url HTTPS_ORIGIN] [--update]. Creates or updates oyster-perf-login in the current CF space; prompts for the shared password.'); return; }
    else throw new Error('Unknown argument');
  }
  const credentials = loginCredentials({ username, publicOrigin, password: await password() });
  const root = await mkdtemp(join(tmpdir(), 'oyster-login-'));
  try {
    const path = join(root, 'verifier.json'); await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
    execFileSync('cf', [update ? 'update-user-provided-service' : 'create-user-provided-service', 'oyster-perf-login', '-p', path], { stdio: 'inherit' });
  } finally { await rm(root, { recursive: true, force: true }); }
}
module.exports = { loginCredentials };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message.startsWith('Password') ? error.message : 'Shared login setup failed; check arguments, CF target and login.'); process.exitCode = 1; });

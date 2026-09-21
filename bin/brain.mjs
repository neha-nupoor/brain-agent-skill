#!/usr/bin/env node
import { stateHome, readConfig, versions } from '../brain/config.mjs';
import { Journal } from '../brain/journal.mjs';
import { BrainAdapter, connect, serve } from '../brain/adapter.mjs';
import { defaultSkillPath, plan, install, uninstall } from '../brain/install.mjs';

const expectedMissingTools = () => (process.env.BRAIN_EXPECTED_MISSING_TOOLS || '')
  .split(/[\s,]+/u).map(value => value.trim()).filter(Boolean);

async function main() {
  const [command = 'preview', ...args] = process.argv.slice(2);
  if (args.length) throw new Error('Commands accept no CLI options or credentials. Use BRAIN_* environment variables for setup.');
  const home = stateHome();
  if (['preview', 'install'].includes(command)) {
    const mcpUrl = process.env.BRAIN_MCP_URL || 'https://brain.example.invalid/mcp';
    const oauthEnabled = Boolean(process.env.BRAIN_OAUTH_CLIENT_ID || process.env.BRAIN_OAUTH_TOKEN_URL || process.env.BRAIN_OAUTH_ISSUER_URL);
    const options = { home, skillPath: process.env.BRAIN_SKILL_PATH || defaultSkillPath(), config: {
      mcpUrl,
      ...(process.env.BRAIN_JOURNAL_REMOTE ? { journalRemote: process.env.BRAIN_JOURNAL_REMOTE } : {}),
      journalBranch: process.env.BRAIN_JOURNAL_BRANCH || 'main',
      credentialEnv: process.env.BRAIN_CREDENTIAL_ENV || 'BRAIN_TOKEN',
      expectedMissingTools: expectedMissingTools(),
      ...(process.env.BRAIN_KEYCHAIN_SERVICE ? { keychainService: process.env.BRAIN_KEYCHAIN_SERVICE } : {}),
      ...(oauthEnabled ? { oauth: {
        clientId: process.env.BRAIN_OAUTH_CLIENT_ID,
        ...(process.env.BRAIN_OAUTH_TOKEN_URL ? { tokenUrl: process.env.BRAIN_OAUTH_TOKEN_URL } : {}),
        ...(process.env.BRAIN_OAUTH_ISSUER_URL ? { issuerUrl: process.env.BRAIN_OAUTH_ISSUER_URL } : {}),
        audience: process.env.BRAIN_OAUTH_AUDIENCE || mcpUrl,
        scopes: process.env.BRAIN_OAUTH_SCOPES || 'memory:read memory:write relationship:read relationship:write',
        clientSecretEnv: process.env.BRAIN_OAUTH_CLIENT_SECRET_ENV || 'BRAIN_OAUTH_CLIENT_SECRET',
        ...(process.env.BRAIN_OAUTH_CLIENT_SECRET_KEYCHAIN_SERVICE ? { clientSecretKeychainService: process.env.BRAIN_OAUTH_CLIENT_SECRET_KEYCHAIN_SERVICE } : {}),
      } } : {}),
    } };
    if (command === 'install' && !process.env.BRAIN_MCP_URL) throw new Error('Set BRAIN_MCP_URL to the supplied Brain endpoint before install. Preview needs no credentials.');
    console.log(JSON.stringify(await (command === 'install' ? install(options) : plan(options)), null, 2));
    return;
  }
  if (command === 'uninstall') { console.log(JSON.stringify(await uninstall(home), null, 2)); return; }
  if (!['serve', 'bootstrap', 'doctor', 'refresh', 'recover-lock'].includes(command)) throw new Error('Use preview, install, serve, bootstrap, doctor, refresh, recover-lock, or uninstall.');
  const config = await readConfig(home);
  const journal = new Journal({ home, remote: config.journalRemote, branch: config.journalBranch });
  if (command === 'recover-lock') { console.log(JSON.stringify(await journal.recoverLock())); return; }
  if (command === 'refresh') { console.log(JSON.stringify(await journal.refresh({ force: true }))); return; }
  let upstream;
  try { upstream = await connect(config); }
  catch {
    if (command !== 'doctor') throw new Error('Brain connection unavailable. Run doctor and check credential/network configuration.');
    console.log(JSON.stringify({ ok: false, health: 'unavailable', auth: 'unverified', journal: await journal.refresh(), guide: { expected: versions.guideVersion, actual: null, agrees: false }, contractVersion: versions.contractVersion, next: 'Check the configured endpoint and credential environment or Keychain.' }));
    process.exitCode = 1; return;
  }
  const adapter = new BrainAdapter({ upstream, journal, expectedMissingTools: config.expectedMissingTools });
  if (command === 'serve') { await serve(adapter); return; }
  try {
    const value = await (command === 'doctor' ? adapter.doctor() : adapter.start());
    console.log(JSON.stringify(value, null, 2));
    if (command === 'doctor' && !value.ok) process.exitCode = 1;
  } finally { await upstream.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

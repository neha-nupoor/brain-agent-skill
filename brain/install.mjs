import { cp, mkdir, readFile, writeFile, lstat, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { versions, validateConfig } from './config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const defaultSkillPath = () => join(homedir(), '.agents', 'skills', 'brain');
const digest = text => createHash('sha256').update(text).digest('hex');
const quote = value => JSON.stringify(value);
export function clientConfigs(home, node = process.execPath, config = {}) {
  const args = [join(root, 'bin', 'brain.mjs'), 'serve'];
  const envVars = [config.credentialEnv || 'BRAIN_TOKEN'];
  if (config.oauth) envVars.push(config.oauth.clientSecretEnv || 'BRAIN_OAUTH_CLIENT_SECRET');
  return {
    codex: `[mcp_servers.brain]\ncommand = ${quote(node)}\nargs = ${JSON.stringify(args)}\nenv_vars = ${JSON.stringify([...new Set(envVars)])}\n[mcp_servers.brain.env]\nBRAIN_HOME = ${quote(resolve(home))}\n`,
    generic: { mcpServers: { brain: { command: node, args, env: { BRAIN_HOME: resolve(home) } } } },
  };
}
export async function plan({ home, skillPath, config }) {
  validateConfig(config);
  return { versions, home: resolve(home), skillPath: resolve(skillPath),
    files: ['config.json', 'codex.toml', 'mcp.json', 'AGENTS.md', 'manifest.json'].map(file => join(resolve(home), file)),
    clients: clientConfigs(home, process.execPath, config),
    capabilities: { expectedMissingTools: config.expectedMissingTools || [] },
    credential: 'Inherited bearer/OAuth secret environment variable or macOS Keychain. No credential is persisted.' };
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function install(options) {
  const output = await plan(options);
  if (await exists(options.home) || await exists(options.skillPath)) throw new Error('Install target exists. Use a new target or uninstall/recover the existing bundle; no existing skill/config is overwritten.');
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const files = {
    'config.json': JSON.stringify(options.config, null, 2) + '\n',
    'codex.toml': output.clients.codex,
    'mcp.json': JSON.stringify(output.clients.generic, null, 2) + '\n',
    'AGENTS.md': await readFile(join(root, 'brain', 'AGENTS.md'), 'utf8'),
  };
  const checksums = {};
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(options.home, name), text, { flag: 'wx', mode: 0o600 });
    checksums[name] = digest(text);
  }
  await mkdir(resolve(options.skillPath, '..'), { recursive: true });
  await cp(join(root, 'skills', 'brain'), options.skillPath, { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(options.home, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...versions, skillPath: resolve(options.skillPath), checksums, root }, null, 2), { flag: 'wx', mode: 0o600 });
  return { ...output, installed: true, next: `Merge ${join(options.home, 'codex.toml')} into Codex config, or the brain entry from mcp.json into your MCP client. Restart the client.` };
}
export async function uninstall(home) {
  const manifest = JSON.parse(await readFile(join(home, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.root !== root) throw new Error('Installation ownership mismatch.');
  const suffix = `.uninstalled-${Date.now()}`;
  const skillBackup = `${manifest.skillPath}${suffix}`;
  const homeBackup = `${resolve(home)}${suffix}`;
  if (await exists(manifest.skillPath)) {
    const skill = await readFile(join(manifest.skillPath, 'SKILL.md'), 'utf8');
    const expected = await readFile(join(root, 'skills', 'brain', 'SKILL.md'), 'utf8');
    if (skill !== expected) throw new Error('Installed skill was edited; move it aside explicitly before uninstall.');
    await rename(manifest.skillPath, skillBackup);
  }
  await rename(home, homeBackup);
  return { uninstalled: true, homeBackup, skillBackup, next: 'Remove only the brain MCP entry you merged into your client configuration, then restart it. Credentials are untouched.' };
}

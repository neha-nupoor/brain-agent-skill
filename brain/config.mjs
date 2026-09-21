import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const versions = JSON.parse(await readFile(new URL('./versions.json', import.meta.url), 'utf8'));
export const stateHome = () => process.env.BRAIN_HOME || join(homedir(), '.local', 'share', 'brain-onboarding');
const envName = value => /^[A-Z][A-Z0-9_]*$/.test(value);
function secureUrl(value, label) {
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !loopback)) throw new Error(`${label} must use HTTPS (HTTP only on loopback) without embedded credentials, query or fragment.`);
  return url;
}
export function validateConfig(config) {
  const allowed = ['mcpUrl', 'journalRemote', 'journalBranch', 'credentialEnv', 'keychainService', 'oauth', 'expectedMissingTools'];
  if (!config || Object.keys(config).some(key => !allowed.includes(key))) throw new Error('Unsupported configuration field; credentials belong in environment or Keychain.');
  secureUrl(config.mcpUrl, 'MCP URL');
  if (config.journalRemote && !/^(?:https:\/\/[^/@?#\s]+\/[^?#\s]+|git@[^:\s]+:[^\s]+)$/.test(config.journalRemote)) throw new Error('Journal remote must use credential-free HTTPS or SSH; use your Git credential helper.');
  if (config.journalBranch && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(config.journalBranch)) throw new Error('Invalid journal branch.');
  if (config.credentialEnv && !envName(config.credentialEnv)) throw new Error('Invalid credential environment variable name.');
  if (config.keychainService && (typeof config.keychainService !== 'string' || !config.keychainService.trim() || /[\r\n]/.test(config.keychainService))) throw new Error('Invalid credential Keychain service name.');
  if (config.expectedMissingTools !== undefined) {
    const allowedMissing = new Set(['memory.ingest', 'brain.capture', 'brain.update', 'person.contact.get', 'person.contact.update']);
    if (!Array.isArray(config.expectedMissingTools)
      || config.expectedMissingTools.some(name => typeof name !== 'string' || !allowedMissing.has(name))
      || new Set(config.expectedMissingTools).size !== config.expectedMissingTools.length) {
      throw new Error('Expected-missing tools must be a unique list of supported restricted capabilities.');
    }
  }
  if (config.oauth) {
    const oauthAllowed = ['tokenUrl', 'issuerUrl', 'clientId', 'audience', 'scopes', 'clientSecretEnv', 'clientSecretKeychainService'];
    if (typeof config.oauth !== 'object' || Object.keys(config.oauth).some(key => !oauthAllowed.includes(key))) throw new Error('Unsupported OAuth configuration field; client secrets belong in environment or Keychain.');
    if (!config.oauth.clientId || typeof config.oauth.clientId !== 'string' || /[\r\n]/.test(config.oauth.clientId)) throw new Error('OAuth client ID is required.');
    if (!config.oauth.tokenUrl && !config.oauth.issuerUrl) throw new Error('OAuth token URL or issuer URL is required.');
    if (config.oauth.tokenUrl) secureUrl(config.oauth.tokenUrl, 'OAuth token URL');
    if (config.oauth.issuerUrl) secureUrl(config.oauth.issuerUrl, 'OAuth issuer URL');
    secureUrl(config.oauth.audience, 'OAuth audience');
    if (config.oauth.scopes && (typeof config.oauth.scopes !== 'string' || /[^A-Za-z0-9:._ -]/.test(config.oauth.scopes))) throw new Error('Invalid OAuth scopes.');
    if (config.oauth.clientSecretEnv && !envName(config.oauth.clientSecretEnv)) throw new Error('Invalid OAuth client-secret environment variable name.');
    if (config.oauth.clientSecretKeychainService && (typeof config.oauth.clientSecretKeychainService !== 'string' || !config.oauth.clientSecretKeychainService.trim() || /[\r\n]/.test(config.oauth.clientSecretKeychainService))) throw new Error('Invalid OAuth client-secret Keychain service name.');
  }
  return config;
}
export async function readConfig(home = stateHome()) {
  return validateConfig(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')));
}
async function keychain(service) {
  if (service && process.platform === 'darwin') {
    try {
      const result = await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 });
      return result.stdout.trim();
    } catch { /* Report only absence, never credential helper stderr. */ }
  }
  return '';
}
export async function credential(config) {
  validateConfig(config);
  const token = process.env[config.credentialEnv || 'BRAIN_TOKEN'] || await keychain(config.keychainService);
  if (token) return token;
  if (config.oauth) {
    const secret = process.env[config.oauth.clientSecretEnv || 'BRAIN_OAUTH_CLIENT_SECRET'] || await keychain(config.oauth.clientSecretKeychainService);
    if (!secret) throw new Error('Brain OAuth client secret unavailable. Set the configured environment variable or unlock its Keychain item.');
    const tokenUrl = config.oauth.tokenUrl || `${config.oauth.issuerUrl.replace(/\/$/u, '')}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials', client_id: config.oauth.clientId,
      client_secret: secret, audience: config.oauth.audience,
      ...(config.oauth.scopes ? { scope: config.oauth.scopes } : {}),
    });
    let response;
    try {
      response = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
    } catch { throw new Error('Brain OAuth token exchange unavailable.'); }
    if (!response.ok) throw new Error(`Brain OAuth token exchange failed (${response.status}).`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error('Brain OAuth token exchange returned invalid JSON.'); }
    if (typeof payload.access_token !== 'string' || !payload.access_token) throw new Error('Brain OAuth token exchange returned no access token.');
    return payload.access_token;
  }
  throw new Error('Brain credential unavailable. Set the configured environment variable or unlock its Keychain item.');
}

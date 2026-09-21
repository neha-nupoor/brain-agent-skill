import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { credential, versions } from './config.mjs';
import { validateBrainV2Contract } from './contracts/brain-v2-contracts.mjs';

export const FORWARDED = Object.freeze([
  'brain.guide', 'brain.bootstrap', 'brain.search', 'memory.ingest',
  'brain.capture', 'brain.update', 'brain.get', 'brain.list',
  'person.contact.get', 'person.contact.update',
]);
export const required = ['brain.guide', 'brain.bootstrap', 'brain.search', 'memory.ingest', 'brain.capture', 'brain.update', 'brain.get', 'brain.list'];
const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
export const LOCAL_TOOLS = [
  { name: 'journal.read', description: 'Read one committed daily/weekly journal projection. Read only; includes revision and freshness.', inputSchema: { ...objectSchema({ path: { type: 'string' } }), required: ['path'] } },
  { name: 'journal.search', description: 'Search the shared local journal projection. Read only; stale data is explicitly marked. Use brain.search for canonical memory.', inputSchema: { ...objectSchema({ query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }), required: ['query'] } },
  { name: 'journal.refresh', description: 'Refresh the read-only journal cache from its publisher with fast-forward only synchronization.', inputSchema: objectSchema({}) },
  { name: 'brain.doctor', description: 'Check Brain health/authentication, journal freshness, required capabilities and Brain Guide version.', inputSchema: objectSchema({}) },
];
export const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export function unpack(value) {
  if (value.isError) throw new Error('Upstream Brain operation failed.');
  return value.structuredContent || JSON.parse(value.content.find(item => item.type === 'text').text);
}
export async function connect(config) {
  const token = await credential(config);
  const client = new Client({ name: 'brain-onboarding-adapter', version: versions.bundleVersion });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
  } catch { await client.close().catch(() => {}); throw new Error('Brain connection failed; check URL, network, and credential.'); }
  return client;
}
export class BrainAdapter {
  constructor({ upstream, journal, expectedMissingTools = [] }) {
    this.upstream = upstream;
    this.journal = journal;
    this.expectedMissingTools = expectedMissingTools;
    this.started = null;
  }
  async tools() {
    const all = [];
    let cursor;
    do { const page = await this.upstream.listTools(cursor ? { cursor } : {}); all.push(...page.tools); cursor = page.nextCursor; } while (cursor);
    return all.filter(tool => FORWARDED.includes(tool.name)).map(tool => {
      if (!tool.outputSchema || !['brain.bootstrap', 'brain.search'].includes(tool.name)) return tool;
      const key = tool.name === 'brain.bootstrap' ? 'bootstrap' : 'search';
      // Preserve advertised validation when adding local metadata outside the canonical envelope.
      return { ...tool, outputSchema: { type: 'object', properties: {
        [key]: tool.outputSchema, journal: { type: 'object' },
        ...(key === 'bootstrap' ? { guide: { type: 'object' }, versions: { type: 'object' } } : {}),
      }, required: [key, 'journal', ...(key === 'bootstrap' ? ['guide', 'versions'] : [])] } };
    });
  }
  async guide() {
    const guide = unpack(await this.upstream.callTool({ name: 'brain.guide', arguments: {} }));
    if (guide.version !== versions.guideVersion || typeof guide.text !== 'string' || !guide.text.trim()) throw new Error('Brain Guide version mismatch; update the onboarding bundle before Brain writes.');
    return guide;
  }
  async bootstrap(args = {}) {
    const guide = await this.guide();
    const journal = await this.journal.refresh();
    const response = unpack(await this.upstream.callTool({ name: 'brain.bootstrap', arguments: {
      schemaVersion: 'brain.bootstrap.request.v2', asOf: new Date().toISOString(), includeJournal: true,
      includeReconciliation: true, includeForgetting: true, maxHotItems: 10, ...args,
    } }));
    this.validateResponse('brain.bootstrap.response.v2', response);
    return { guide, bootstrap: response, journal, versions };
  }
  validateResponse(schema, response) {
    try { return validateBrainV2Contract(schema, response); }
    catch { throw new Error('Brain response contract mismatch.'); }
  }
  // Safe to call from both the lifecycle hook and the explicit MCP-only fallback.
  start() { return this.started ||= this.bootstrap().catch(error => { this.started = null; throw error; }); }
  async doctor() {
    const report = { health: 'unavailable', auth: 'unverified', journal: await this.journal.refresh(), guide: { expected: versions.guideVersion, actual: null, agrees: false }, contract: { expected: versions.contractVersion, actual: null, valid: false }, expectedMissingTools: this.expectedMissingTools, missingTools: [], unexpectedMissingTools: [] };
    try {
      const tools = await this.tools();
      const guide = unpack(await this.upstream.callTool({ name: 'brain.guide', arguments: {} }));
      report.health = 'reachable'; report.auth = 'authenticated';
      report.guide.actual = guide.version;
      report.guide.agrees = guide.version === versions.guideVersion;
      report.missingTools = required.filter(name => !tools.some(tool => tool.name === name));
      report.unexpectedMissingTools = report.missingTools.filter(name => !this.expectedMissingTools.includes(name));
      const bootstrap = unpack(await this.upstream.callTool({ name: 'brain.bootstrap', arguments: {
        schemaVersion: 'brain.bootstrap.request.v2', asOf: new Date().toISOString(), includeJournal: true,
        includeReconciliation: true, includeForgetting: true, maxHotItems: 10,
      } }));
      report.contract.actual = bootstrap.contractVersion ?? null;
      try { this.validateResponse('brain.bootstrap.response.v2', bootstrap); report.contract.valid = true; }
      catch { report.reason = 'bootstrap_contract_mismatch'; }
    } catch { report.reason = 'brain_connection_or_authorization_failed'; }
    report.ok = report.health === 'reachable' && report.guide.agrees && report.contract.valid && report.unexpectedMissingTools.length === 0 && report.journal.freshness === 'fresh';
    return report;
  }
  async call(name, args = {}) {
    if (name === 'brain.doctor') return result(await this.doctor());
    if (name === 'journal.refresh') return result(await this.journal.refresh({ force: true }));
    if (name === 'journal.read') return result(await this.journal.read(args.path));
    if (name === 'journal.search') return result(await this.journal.search(args.query, args.limit));
    if (!FORWARDED.includes(name)) throw new Error('Tool is not exposed by this adapter. Journal writes are prohibited.');
    if (name === 'brain.bootstrap') return result(await this.bootstrap(args));
    if (name === 'brain.guide') return result(await this.guide());
    if (['memory.ingest', 'brain.capture', 'brain.update', 'person.contact.update'].includes(name)) {
      await this.bootstrap(); // Check current Guide and full contract agreement before every write.
    }
    if (name === 'brain.search') {
      // Journal failure must never suppress canonical search or alter its server-owned strategy.
      const journal = await this.journal.refresh();
      const response = unpack(await this.upstream.callTool({ name, arguments: args }));
      this.validateResponse('brain.search.response.v2', response);
      return result({ search: response, journal });
    }
    return this.upstream.callTool({ name, arguments: args });
  }
}
export async function serve(adapter, transport = new StdioServerTransport()) {
  const server = new Server({ name: 'brain-onboarding', version: versions.bundleVersion }, {
    capabilities: { tools: {}, resources: {} },
    instructions: 'Before Brain work call brain.bootstrap or read brain://session/bootstrap. Follow its centrally served Guide. Journal is read only. Ignore Brain for unrelated work.',
  });
  let startup = null;
  // MCP lifecycle hook performs automatic read-only bootstrap, even without client-specific hooks.
  server.oninitialized = () => { startup = adapter.start().then(value => result(value), () => result({ status: 'degraded', nextAction: 'Call brain.doctor, then retry brain.bootstrap.' })); };
  server.setRequestHandler('tools/list', async () => ({ tools: [...await adapter.tools(), ...LOCAL_TOOLS] }));
  server.setRequestHandler('tools/call', async request => {
    try { return await adapter.call(request.params.name, request.params.arguments); }
    catch { return { isError: true, content: [{ type: 'text', text: 'Brain operation failed. Run brain.doctor; do not claim a write succeeded. Journal writes are never supported.' }] }; }
  });
  server.setRequestHandler('resources/list', async () => ({ resources: [
    { uri: 'brain://session/bootstrap', name: 'session-bootstrap', mimeType: 'application/json' },
    { uri: `brain://guide/${versions.guideVersion}`, name: 'brain-guide', mimeType: 'text/markdown' },
  ] }));
  server.setRequestHandler('resources/read', async request => {
    if (request.params.uri === 'brain://session/bootstrap') {
      const value = await (startup || adapter.start().then(result));
      return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: value.content[0].text }] };
    }
    if (request.params.uri !== `brain://guide/${versions.guideVersion}`) throw new Error('Unknown Brain resource.');
    const guide = await adapter.guide();
    return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: guide.text }] };
  });
  await server.connect(transport);
  return server;
}

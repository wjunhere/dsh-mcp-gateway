/**
 * Real-server smoke test for lib/manager.js.
 *
 * Reads the live DSH config ($DSH_HOME/mcp.json, read-only) and only
 * touches cheap local servers: archivum, papergate, picgo-uploader.
 * Nothing is downloaded, uploaded, or otherwise mutated.
 *
 * Run: node test/manager.smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpManager } from '../lib/manager.js';
import { defaultConfigFile } from '../lib/config.js';

const CONFIG_PATH = process.env.DSH_MCP_GATEWAY_CONFIG ?? defaultConfigFile();
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const allServers = config.mcpServers;
assert.ok(allServers && typeof allServers === 'object', 'config has mcpServers');

// Server output may quote config values; keep them out of the transcript.
const envValues = new Set();
for (const server of Object.values(allServers)) {
  for (const value of Object.values(server.env ?? {})) {
    if (typeof value === 'string' && value.length >= 6) envValues.add(value);
  }
}
function redact(text) {
  let out = String(text);
  for (const value of envValues) out = out.split(value).join('***');
  return out;
}

const connectedLogs = [];
const logger = {
  info(message) {
    const text = redact(message);
    if (text.includes('": connected')) connectedLogs.push(text);
    console.log(`[info] ${text}`);
  },
  warn(message) {
    console.log(`[warn] ${redact(message)}`);
  },
  error(message) {
    console.log(`[error] ${redact(message)}`);
  },
};
const connectCount = (name) =>
  connectedLogs.filter((line) => line.includes(`mcp server "${name}": connected`)).length;
const firstLine = (text) => String(text ?? '').split('\n')[0].trim();
const textOf = (result) =>
  (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logStep = (title) => console.log(`\n=== ${title} ===`);

const manager = new McpManager({ servers: allServers, logger });

// ---------------------------------------------------------------- 1. discover
logStep('1. discover("archivum") — two concurrent calls must share one spawn');
const [first, second] = await Promise.all([
  manager.discover('archivum'),
  manager.discover('archivum'),
]);
assert.ok(first.tools.length > 0, 'archivum exposes tools');
assert.deepEqual(
  first.tools.map((tool) => tool.name),
  second.tools.map((tool) => tool.name),
  'concurrent discovers agree',
);
assert.equal(connectCount('archivum'), 1, 'concurrent discovers must connect exactly once');
for (const tool of first.tools) {
  assert.equal(typeof tool.name, 'string');
  assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `${tool.name} has inputSchema`);
}
console.log(`archivum tools (${first.tools.length}): ${first.tools.map((t) => t.name).join(', ')}`);
console.log(`archivum instructions: ${first.instructions ? `${first.instructions.length} chars` : '(none)'}`);
assert.equal(manager.status('archivum').state, 'connected', 'discover keeps the connection open');
assert.equal(await manager.ensureInstructions('archivum'), first.instructions);

// ------------------------------------------------------------ 2. call a tool
logStep('2. call("archivum", "server_info", {})');
const info = await manager.call('archivum', 'server_info', {});
const infoText = textOf(info);
assert.equal(info.isError, undefined, 'server_info succeeds');
assert.ok(infoText.length > 0, 'server_info returns text');
console.log(`isError=${info.isError === true}; first text block:\n${redact(infoText.slice(0, 700))}`);

// ------------------------------------------------------- 3. papergate doctor
logStep('3. discover("papergate") + call doctor');
const papergate = await manager.discover('papergate');
const papergateNames = papergate.tools.map((tool) => tool.name);
assert.ok(papergateNames.includes('doctor'), 'papergate exposes doctor');
console.log(`papergate tools (${papergate.tools.length}): ${papergateNames.join(', ')}`);
const doctor = await manager.call('papergate', 'doctor', {});
const doctorText = textOf(doctor);
assert.ok(doctorText.length > 0, 'doctor returns text');
console.log(`doctor isError=${doctor.isError === true}; output:\n${redact(doctorText.slice(0, 700))}`);
assert.equal(connectCount('papergate'), 1, 'call reuses the discover connection');

// ---------------------------------------------------- 4. picgo: listTools only
logStep('4. discover("picgo-uploader") — list only, no upload');
const picgo = await manager.discover('picgo-uploader');
const picgoNames = picgo.tools.map((tool) => tool.name);
assert.ok(picgoNames.includes('upload_image_via_picgo'), 'picgo exposes its upload tool');
console.log(`picgo tools (${picgo.tools.length}): ${picgoNames.join(', ')} (tool NOT called)`);

// ------------------------------------------------------------------ 5. status
logStep('5. status()');
const statuses = manager.status();
assert.equal(statuses.length, Object.keys(allServers).length);
for (const status of statuses) {
  const detail = status.toolCount > 0 ? ` (${status.toolCount} tools)` : '';
  const error = status.lastError ? ` lastError=${status.lastError}` : '';
  console.log(`  ${status.name}: ${status.state}${detail}${error}`);
}
const archivumStatus = manager.status('archivum');
assert.equal(archivumStatus.state, 'connected');
assert.equal(archivumStatus.toolCount, first.tools.length);
assert.equal(typeof archivumStatus.lastUsedAt, 'number');
assert.equal(manager.status('papergate').state, 'connected');
assert.equal(manager.status('picgo-uploader').state, 'connected');
for (const status of statuses) {
  if (['archivum', 'papergate', 'picgo-uploader'].includes(status.name)) continue;
  assert.equal(status.state, 'idle', `${status.name} must not be spawned`);
}

// ------------------------------------------------------------- 6. error paths
logStep('6. fail-fast errors');
const badManager = new McpManager({
  servers: { bogus: { command: 'definitely-not-a-real-mcp-binary-xyz' } },
  connectTimeoutMs: 5000,
  logger,
});
await assert.rejects(
  badManager.discover('bogus'),
  /mcp server "bogus": connect failed: /,
  'spawn failure is reported with server and operation',
);
assert.equal(badManager.status('bogus').state, 'failed');
assert.throws(() => manager.status('nope'), /mcp server "nope": not configured/);
await assert.rejects(manager.discover('nope'), /mcp server "nope": not configured/);
const unknownTool = await manager.call('archivum', 'no_such_tool_xyz', {});
console.log(
  `unknown tool -> isError=${unknownTool.isError === true}, text="${firstLine(textOf(unknownTool))}" (server-dependent: no throw)`,
);
await badManager.closeAll();
console.log('spawn failure, unknown server, unknown tool and closeAll-noop behave as specified');

logStep('6b. ensureInstructions on a never-connected server');
const freshManager = new McpManager({ servers: { 'picgo-uploader': allServers['picgo-uploader'] }, logger });
const freshInstructions = await freshManager.ensureInstructions('picgo-uploader');
assert.equal(typeof freshInstructions, 'string');
assert.equal(freshManager.status('picgo-uploader').state, 'connected');
console.log(`ensureInstructions connected lazily (${freshInstructions.length} chars)`);
await freshManager.closeAll();

// ------------------------------------------------------- 7. idle close/reuse
logStep('7. idle timeout (1500ms) closes the connection; next use reconnects');
const idleManager = new McpManager({
  servers: { archivum: allServers.archivum },
  idleTimeoutMs: 1500,
  logger,
});
const idleTools = await idleManager.discover('archivum');
assert.ok(idleTools.tools.length > 0);
assert.equal(idleManager.status('archivum').state, 'connected');
await sleep(3000);
assert.equal(idleManager.status('archivum').state, 'idle', 'idle close closes the client');
console.log('after idle timeout: state=idle');
await idleManager.discover('archivum');
assert.equal(idleManager.status('archivum').state, 'connected');
console.log('reuse after idle close reconnects');
await idleManager.disconnect('archivum');
assert.equal(idleManager.status('archivum').state, 'idle');
await idleManager.disconnect('archivum'); // never-connected / already-closed: resolves
assert.equal(idleManager.status('archivum').state, 'idle');
await idleManager.discover('archivum'); // explicit disconnect, next use reconnects
assert.equal(idleManager.status('archivum').state, 'connected');
console.log('reuse after explicit disconnect reconnects');
await idleManager.closeAll();

// -------------------------------------------------------------- 8. closeAll
logStep('8. closeAll()');
await manager.closeAll();
const afterClose = manager.status();
for (const status of afterClose) {
  assert.equal(status.state, 'idle', `${status.name} is idle after closeAll`);
  assert.equal(status.lastError, undefined, `${status.name} has no lingering error`);
}
console.log(`all ${afterClose.length} servers idle after closeAll`);
console.log('\nSMOKE OK');

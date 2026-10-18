// Config resolution against the real Pi server file (read-only).
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { defaultCacheFile, expandHome, readServerFile, resolveServers } from '../lib/config.js'

const CONFIG_FILE = process.env.DSH_MCP_GATEWAY_CONFIG ?? join(homedir(), '.pi', 'agent', 'mcp-adapter.json')

test('expandHome expands a leading tilde only', () => {
  assert.equal(expandHome('~/.pi/agent/mcp-adapter.json'), join(homedir(), '.pi', 'agent', 'mcp-adapter.json'))
  assert.equal(expandHome('~/x'), join(homedir(), 'x'))
  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('C:/x/~y'), 'C:/x/~y')
})

test('resolves the real Pi file and honours disabled', () => {
  const file = readServerFile('~/.pi/agent/mcp-adapter.json')
  assert.ok(Object.keys(file.servers).length >= 19)
  const servers = resolveServers(file, { includeServers: [], excludeServers: [], servers: {} })
  assert.equal(servers.serial, undefined, 'serial is disabled in the Pi file')
  assert.equal(servers['picgo-uploader'].command, 'cmd')
  assert.deepEqual(servers['picgo-uploader'].args.slice(0, 2), ['/c', 'node'])
})

test('include/exclude and per-server overrides win over the shared file', () => {
  const file = readServerFile(CONFIG_FILE)
  const servers = resolveServers(file, {
    includeServers: ['jupyter', 'zotero', 'picgo-uploader'],
    excludeServers: ['picgo-uploader'],
    servers: {
      jupyter: { command: 'C:/Users/example/.local/bin/uvx.exe' },
      zotero: { command: 'C:/Users/example/.local/bin/zotero-mcp.exe', env: { ZOTERO_LOCAL: 'true' } },
    },
  })
  assert.deepEqual(Object.keys(servers), ['jupyter', 'zotero'])
  assert.equal(servers.jupyter.command, 'C:/Users/example/.local/bin/uvx.exe')
  assert.match(servers.jupyter.args.join(' '), /mcp-jupyter/)
  assert.equal(servers.zotero.command, 'C:/Users/example/.local/bin/zotero-mcp.exe')
  assert.deepEqual(servers.zotero.env, { ZOTERO_LOCAL: 'true' })
})

test('unknown include names and invalid entries fail fast', () => {
  const file = readServerFile(CONFIG_FILE)
  assert.throws(() => resolveServers(file, { includeServers: ['nope'], excludeServers: [], servers: {} }), /unknown server "nope"/)
  assert.throws(
    () => resolveServers({ absolute: 'x', servers: { bad: { args: [] } } }, { includeServers: [], excludeServers: [], servers: {} }),
    /needs either "command".*or "url"/,
  )
  assert.throws(
    () => resolveServers({ absolute: 'x', servers: { both: { command: 'x', url: 'http://x' } } }, { includeServers: [], excludeServers: [], servers: {} }),
    /sets both "command" and "url"/,
  )
})

test('a partial override keeps the shared file args/env', async () => {
  // The real plugin receives config already normalized by its schemastery
  // schema; an absent collection field must not turn into []/{}, or it shadows
  // the shared file's args/env for every server it overrides.
  const { Config } = await import('../lib/index.js')
  const parsed = Config({
    configFile: CONFIG_FILE,
    servers: {
      jupyter: { command: 'C:/Users/example/.local/bin/uvx.exe' },
      zotero: { command: 'C:/Users/example/.local/bin/zotero-mcp.exe' },
    },
  })
  const file = readServerFile(CONFIG_FILE)
  const servers = resolveServers(file, parsed)
  assert.match(servers.jupyter.args.join(' '), /mcp-jupyter/)
  assert.equal(servers.jupyter.env.JUPYTER_BASE_URL, 'http://localhost:8888')
  assert.equal(servers.zotero.env.ZOTERO_LOCAL, 'true')
  assert.equal(servers.zotero.env.ZOTERO_LIBRARY_ID, '19694284')
})

test('cache file defaults to the config directory', () => {
  const expected = join(resolve('C:/Users/example/.pi/agent'), '.dsh-mcp-gateway-cache.json')
  assert.equal(defaultCacheFile('C:/Users/example/.pi/agent/mcp-adapter.json'), expected)
})

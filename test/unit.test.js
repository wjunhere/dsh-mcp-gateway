// Unit tests with no external processes: pure helpers, config merging, cache and
// search formatting. The server-dependent suites stay in config.test.js,
// search.test.js, manager.smoke.mjs and integration.mjs and run locally.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { defaultCacheFile, expandHome, readServerFile, resolveServers } from '../lib/config.js'
import { cacheEntryValid, loadCache, saveCache, serverConfigHash } from '../lib/cache.js'
import { compactShape, describeTool, formatSearchResults, rankTools, suggestNames } from '../lib/search.js'

const scratch = mkdtempSync(join(tmpdir(), 'mcp-gateway-unit-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const SAMPLE_CONFIG = {
  mcpServers: {
    alpha: {
      command: 'alpha-mcp',
      args: ['--stdio'],
      env: { ALPHA_TOKEN: 'secret' },
      searchKeywords: { '*': ['greek'] },
    },
    beta: {
      command: 'cmd',
      args: ['/c', 'beta-mcp'],
      disabled: true,
    },
    gamma: {
      command: 'cmd',
      args: ['/c', 'gamma-mcp'],
    },
  },
}

test('expandHome only expands a leading tilde', () => {
  assert.equal(expandHome('~/.pi/agent/mcp-adapter.json'), join(homedir(), '.pi', 'agent', 'mcp-adapter.json'))
  assert.equal(expandHome('~/x'), join(homedir(), 'x'))
  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('C:/x/~y'), 'C:/x/~y')
})

test('readServerFile rejects missing, invalid and non-object files', () => {
  assert.throws(() => readServerFile(join(scratch, 'missing.json')), /config file not found/)
  const bad = join(scratch, 'bad.json')
  writeFileSync(bad, '{not json')
  assert.throws(() => readServerFile(bad), /not valid JSON/)
  const list = join(scratch, 'list.json')
  writeFileSync(list, '[]')
  assert.throws(() => readServerFile(list), /must contain a JSON object/)
})

test('resolveServers honours disabled, include/exclude and overrides', () => {
  const file = { absolute: join(scratch, 'mcp.json'), servers: SAMPLE_CONFIG.mcpServers }
  const servers = resolveServers(file, {
    servers: { gamma: { command: 'C:/tools/gamma.exe' } },
  })
  assert.deepEqual(Object.keys(servers).sort(), ['alpha', 'gamma'])
  assert.deepEqual(servers.alpha.args, ['--stdio'])
  assert.deepEqual(servers.alpha.env, { ALPHA_TOKEN: 'secret' })
  assert.equal(servers.gamma.command, 'C:/tools/gamma.exe')
  assert.deepEqual(servers.gamma.args, ['/c', 'gamma-mcp'], 'partial override keeps the shared args')

  const only = resolveServers(file, { includeServers: ['alpha'], excludeServers: [] })
  assert.deepEqual(Object.keys(only), ['alpha'])
  assert.throws(() => resolveServers(file, { includeServers: ['nope'] }), /unknown server "nope"/)
})

test('schemastery normalization does not shadow shared args/env', async () => {
  const { Config } = await import('../lib/index.js')
  const file = join(scratch, 'schema.json')
  writeFileSync(file, JSON.stringify(SAMPLE_CONFIG))
  const parsed = Config({ configFile: file, servers: { gamma: { command: 'C:/tools/gamma.exe' } } })
  const servers = resolveServers(readServerFile(file), parsed)
  assert.equal(servers.gamma.command, 'C:/tools/gamma.exe')
  assert.deepEqual(servers.gamma.args, ['/c', 'gamma-mcp'])
})

test('invalid server entries fail fast', () => {
  const base = { absolute: 'x', servers: {} }
  assert.throws(() => resolveServers({ ...base, servers: { bad: { args: [] } } }, {}), /needs either "command".*or "url"/)
  assert.throws(() => resolveServers({ ...base, servers: { both: { command: 'x', url: 'http://x' } } }, {}), /sets both/)
  assert.throws(() => resolveServers({ ...base, servers: { bad: { command: 'x', args: 'nope' } } }, {}), /args must be an array/)
  assert.throws(() => resolveServers({ ...base, servers: { bad: { command: 'x', env: { A: 1 } } } }, {}), /env must be an object of strings/)
})

test('serverConfigHash covers the transport identity only', () => {
  const server = { name: 'alpha', command: 'alpha-mcp', args: ['--stdio'], env: { A: '1' } }
  assert.equal(serverConfigHash(server), serverConfigHash({ ...server }))
  assert.notEqual(serverConfigHash(server), serverConfigHash({ ...server, args: ['--other'] }))
  assert.notEqual(serverConfigHash(server), serverConfigHash({ ...server, env: { A: '2' } }))
  assert.equal(serverConfigHash(server), serverConfigHash({ ...server, description: 'changed' }), 'display fields do not invalidate metadata')
})

test('cache round-trips and validates against the config hash', () => {
  const file = join(scratch, 'cache.json')
  const server = { name: 'alpha', command: 'alpha-mcp' }
  const hash = serverConfigHash(server)
  saveCache(file, { version: 1, servers: { alpha: { configHash: hash, tools: [{ name: 'alpha_search' }], instructions: '', discoveredAt: 1 } } })
  const loaded = loadCache(file)
  assert.equal(loaded.servers.alpha.tools[0].name, 'alpha_search')
  assert.equal(cacheEntryValid(loaded.servers.alpha, server), true)
  assert.equal(cacheEntryValid(loaded.servers.alpha, { ...server, command: 'other' }), false)
  assert.equal(loadCache(join(scratch, 'absent.json')).servers.alpha, undefined)
  assert.equal(defaultCacheFile(join(scratch, 'mcp.json')).endsWith('.dsh-mcp-gateway-cache.json'), true)
})

const SAMPLE_SERVERS = {
  alpha: {
    description: 'Greek library server',
    searchKeywords: { '*': ['greek'], search_books: ['tome'] },
    tools: [
      {
        name: 'search_books',
        description: 'Search books by title',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'integer' } },
          required: ['query'],
        },
      },
      { name: 'get_book', description: 'Fetch one book', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    ],
  },
  beta: {
    description: 'Duplicate server',
    tools: [
      { name: 'search_books', description: 'Search books the other way', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ],
  },
}

test('rankTools ranks name/description matches and honours keywords', () => {
  const ranked = rankTools('book search', SAMPLE_SERVERS, { limit: 5 })
  assert.equal(ranked.results[0].tool.name, 'search_books')
  assert.equal(ranked.total >= 1, true)
  const keyword = rankTools('tome', SAMPLE_SERVERS)
  assert.equal(keyword.results[0].tool.name, 'search_books', 'configured searchKeywords match a different vocabulary')
  assert.equal(rankTools('zzzzz', SAMPLE_SERVERS).total, 0)
  const regex = rankTools('^get_', SAMPLE_SERVERS, { regex: true })
  assert.deepEqual(regex.results.map((hit) => hit.tool.name), ['get_book'])
})

test('formatSearchResults qualifies duplicate tool names and pages', () => {
  const ranked = rankTools('book', SAMPLE_SERVERS, { limit: 10 })
  const ambiguous = new Set(['search_books'])
  const text = formatSearchResults({ ...ranked, offset: 0, limit: 10 }, { ambiguousNames: ambiguous })
  assert.match(text, /- alpha\/search_books/)
  assert.match(text, /- beta\/search_books/)
})

test('compactShape renders required/optional/enum/array/nested types', () => {
  assert.equal(compactShape(SAMPLE_SERVERS.alpha.tools[0].inputSchema), '{ query: string; limit?: number }')
  assert.equal(
    compactShape({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow'] },
        tags: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { depth: { type: 'integer' } }, required: ['depth'] },
      },
      required: ['mode'],
    }),
    '{ mode: "fast" | "slow"; tags?: string[]; nested?: { depth: number } }',
  )
  assert.equal(compactShape({ type: 'object', properties: {}, required: [] }), '{}')
  assert.equal(compactShape({ type: 'object', properties: { x: { $ref: '#/$defs/x' } } }), '')
})

test('describeTool renders server, description, hints and parameters', () => {
  const text = describeTool('alpha', {
    name: 'search_books',
    description: 'Search books by title',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: SAMPLE_SERVERS.alpha.tools[0].inputSchema,
  })
  assert.match(text, /^search_books \(server: alpha\)/)
  assert.match(text, /Hints: read-only, idempotent/)
  assert.match(text, /Params: \{ query: string; limit\?: number \}/)
})

test('suggestNames recovers a server-prefixed tool name', () => {
  assert.deepEqual(suggestNames('alpha_search_books', SAMPLE_SERVERS), ['search_books'])
  assert.equal(suggestNames('alpha_search', SAMPLE_SERVERS).includes('search_books'), true)
  assert.equal(suggestNames('alpha_get_book', SAMPLE_SERVERS).includes('get_book'), true)
})

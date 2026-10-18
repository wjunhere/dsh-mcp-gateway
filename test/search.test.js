import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import { cacheEntryValid, loadCache, saveCache, serverConfigHash } from '../lib/cache.js'
import { compactShape, describeTool, formatSearchResults, rankTools, suggestNames } from '../lib/search.js'

// Real config and real servers only: every schema/tool below comes from
// listTools() on the local archivum and picgo-uploader processes.
const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'mcp-adapter.json')
const SERVER_NAMES = ['archivum', 'picgo-uploader']
const TMP_DIR = fileURLToPath(new URL('../tmp/', import.meta.url))

/** @type {Record<string, { description?: string, searchKeywords?: object, tools: object[] }>} */
const servers = {}
/** @type {Record<string, any>} */
const rawConfigs = {}
const clients = []

before(async () => {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  mkdirSync(TMP_DIR, { recursive: true })
  for (const name of SERVER_NAMES) {
    const definition = config.mcpServers?.[name]
    assert.ok(definition, `server "${name}" is missing from ${CONFIG_PATH}`)
    rawConfigs[name] = definition
    const transport = new StdioClientTransport({
      command: definition.command,
      args: definition.args,
      env: { ...process.env, ...(definition.env ?? {}) },
      ...(definition.cwd === undefined ? {} : { cwd: definition.cwd }),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'dsh-mcp-gateway-search-test', version: '0.1.0' }, { capabilities: {} })
    await client.connect(transport)
    clients.push(client)
    const { tools } = await client.listTools(undefined, { cacheMode: 'refresh' })
    servers[name] = {
      description: definition.description,
      searchKeywords: definition.searchKeywords,
      tools,
    }
  }
})

after(async () => {
  for (const client of clients) await client.close()
})

test('real tool lists were discovered', () => {
  assert.ok(servers.archivum.tools.length > 0)
  assert.ok(servers['picgo-uploader'].tools.length > 0)
  assert.equal(servers['picgo-uploader'].tools[0].name, 'upload_image_via_picgo')
})

test('rankTools("book download") puts the download tool first', () => {
  const { results, total } = rankTools('book download', { archivum: servers.archivum })
  assert.ok(total > 0)
  assert.equal(results[0].server, 'archivum')
  assert.equal(results[0].tool.name, 'download_book')
  assert.ok(results.every((hit) => hit.server === 'archivum'))
})

test('rankTools("upload image") finds the picgo upload tool', () => {
  const { results, total } = rankTools('upload image', servers)
  assert.ok(total > 0)
  assert.equal(results[0].server, 'picgo-uploader')
  assert.equal(results[0].tool.name, 'upload_image_via_picgo')
})

test('rankTools uses configured searchKeywords (real config vocabularies)', () => {
  // Per-tool vocabulary: only search_papers carries "论文检索".
  assert.deepEqual(
    rankTools('论文检索', { archivum: servers.archivum }).results.map((hit) => hit.tool.name),
    ['search_papers'],
  )
  // '*' vocabulary applies to every tool of the server.
  assert.equal(rankTools('电子书', { archivum: servers.archivum }).total, 9)
})

test('rankTools server filter and no-match behavior', () => {
  assert.deepEqual(rankTools('upload image', servers, { server: 'archivum' }), { results: [], total: 0 })
  assert.deepEqual(rankTools('zzzznonsense', servers), { results: [], total: 0 })
})

test('paging is consistent: same total, disjoint pages, no overflow', () => {
  const first = rankTools('book', { archivum: servers.archivum }, { limit: 2 })
  const second = rankTools('book', { archivum: servers.archivum }, { limit: 2, offset: 2 })
  assert.ok(first.total >= 3, `expected at least 3 book hits, got ${first.total}`)
  assert.equal(first.results.length, 2)
  assert.equal(second.total, first.total)
  const firstNames = new Set(first.results.map((hit) => hit.tool.name))
  for (const hit of second.results) assert.ok(!firstNames.has(hit.tool.name), `${hit.tool.name} repeated`)
  assert.equal(rankTools('book', { archivum: servers.archivum }, { offset: first.total }).results.length, 0)
})

test('regex search matches names, descriptions and keywords', () => {
  const byName = rankTools('^download_', { archivum: servers.archivum }, { regex: true })
  assert.deepEqual(
    byName.results.map((hit) => hit.tool.name),
    ['download_book'],
  )
  const byKeyword = rankTools('下载电子书', { archivum: servers.archivum }, { regex: true })
  assert.deepEqual(
    byKeyword.results.map((hit) => hit.tool.name),
    ['search_books'],
  )
  const caseInsensitive = rankTools('UPLOAD_IMAGE', servers, { regex: true })
  assert.equal(caseInsensitive.total, 1)
  assert.throws(() => rankTools('([', servers, { regex: true }), /invalid regex/)
  assert.throws(() => rankTools('(a+)+$', servers, { regex: true }), /unsafe/)
})

test('suggestNames strips server prefixes for typo recovery', () => {
  const archival = suggestNames('archivum_download_boo', { archivum: servers.archivum })
  assert.ok(archival.includes('download_book'), `got ${archival.join(', ')}`)
  const picgo = suggestNames('picgo-uploader_upload', servers)
  assert.ok(picgo.includes('upload_image_via_picgo'), `got ${picgo.join(', ')}`)
  assert.deepEqual(suggestNames('zzzznonsense', servers), [])
})

test('compactShape renders real MCP input schemas', () => {
  const picgoTool = servers['picgo-uploader'].tools[0]
  assert.equal(compactShape(picgoTool.inputSchema), '{ image_paths: string[] }')

  const byName = (name) => servers.archivum.tools.find((tool) => tool.name === name)
  assert.equal(
    compactShape(byName('search_books').inputSchema),
    '{ query: string; sources?: ("anna" | "libgen" | "zlibrary")[]; limit?: number; ext?: string }',
  )
  assert.equal(compactShape(byName('book_details').inputSchema), '{ md5: string }')
  assert.equal(compactShape(byName('get_download_links').inputSchema), '{ md5?: string; zlib_book_id?: string; zlib_hash?: string }')
  assert.equal(compactShape(byName('zlib_limits').inputSchema), '{}')
})

test('compactShape returns "" for unsafe constructs and never throws', () => {
  assert.equal(compactShape({ type: 'object', properties: { q: { anyOf: [{ type: 'string' }] } } }), '')
  assert.equal(compactShape({ $ref: '#/$defs/x' }), '')
  assert.equal(compactShape({ type: 'object', properties: { x: { allOf: [{ type: 'string' }] } } }), '')
  assert.equal(compactShape(undefined), '')
  assert.equal(compactShape(null), '')
  assert.equal(compactShape('not a schema'), '')
})

test('describeTool renders header, description, hints and shape', () => {
  const searchBooks = servers.archivum.tools.find((tool) => tool.name === 'search_books')
  const described = describeTool('archivum', searchBooks)
  assert.ok(described.startsWith('search_books (server: archivum)\nSearch books across'))
  assert.ok(described.includes('\nParams: { query: string; sources?: ("anna" | "libgen" | "zlibrary")[]; limit?: number; ext?: string }'))
  assert.ok(!described.includes('Hints:'))

  const annotated = describeTool('archivum', { ...searchBooks, annotations: { readOnlyHint: true, idempotentHint: true } })
  assert.ok(annotated.includes('\nHints: read-only, idempotent\n'))

  const fallback = describeTool('archivum', { name: 'opaque', description: 'x', inputSchema: { anyOf: [{ type: 'string' }] } })
  assert.ok(fallback.includes('\nInput schema:\n{\n  "anyOf": ['))
})

test('formatSearchResults batches lines, shapes and the next-offset footer', () => {
  const picgoHit = rankTools('upload image', servers)
  assert.equal(
    formatSearchResults(picgoHit, { includeSchemas: false }),
    '- upload_image_via_picgo - Uploads one or more images using the running PicGo server application.',
  )
  assert.equal(
    formatSearchResults(picgoHit),
    '- upload_image_via_picgo - Uploads one or more images using the running PicGo server application.\n  { image_paths: string[] }',
  )
  const page = rankTools('book', { archivum: servers.archivum }, { limit: 2 })
  const rendered = formatSearchResults(page)
  const lines = rendered.split('\n')
  assert.ok(lines[0].startsWith('- '))
  assert.ok(rendered.includes(`\n\n2 of ${page.total} — next offset: 2`))
  assert.equal(formatSearchResults({ results: [], total: 0 }), 'No matching tools.')
})

test('serverConfigHash is stable and tracks transport fields', () => {
  const base = rawConfigs.archivum
  const hash = serverConfigHash(base)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(serverConfigHash({ ...base }), hash)
  const reorderedEnv = Object.fromEntries(Object.entries(base.env).reverse())
  assert.equal(serverConfigHash({ ...base, env: reorderedEnv }), hash)
  assert.notEqual(serverConfigHash({ ...base, env: { ...base.env, ARCHIVUM_TIMEOUT_MS: '1' } }), hash)
  assert.notEqual(serverConfigHash({ ...base, command: `${base.command}-other` }), hash)
  assert.notEqual(serverConfigHash({ ...base, url: 'http://127.0.0.1:1/mcp' }), hash)
})

test('cache round-trip and cacheEntryValid against the real config', () => {
  const cachePath = join(TMP_DIR, 'search-test-cache.json')
  const cache = {
    version: 1,
    servers: {
      archivum: {
        configHash: serverConfigHash(rawConfigs.archivum),
        tools: servers.archivum.tools,
        instructions: '',
        discoveredAt: new Date().toISOString(),
      },
    },
  }
  try {
    saveCache(cachePath, cache)
    const loaded = loadCache(cachePath)
    assert.deepEqual(loaded, cache)
    const entry = loaded.servers.archivum
    assert.equal(cacheEntryValid(entry, rawConfigs.archivum), true)
    assert.equal(cacheEntryValid(entry, { ...rawConfigs.archivum, command: 'node2' }), false)
    assert.equal(cacheEntryValid({ ...entry, failure: { at: Date.now(), message: 'boom' } }, rawConfigs.archivum), false)
    assert.equal(cacheEntryValid(undefined, rawConfigs.archivum), false)
  } finally {
    rmSync(cachePath, { force: true })
  }
})

test('loadCache: missing and corrupt files yield an empty cache, other errors throw', () => {
  assert.deepEqual(loadCache(join(TMP_DIR, 'search-test-missing.json')), { version: 1, servers: {} })
  const corruptPath = join(TMP_DIR, 'search-test-corrupt.json')
  try {
    writeFileSync(corruptPath, '{"version": 1, "servers": ', 'utf8')
    assert.deepEqual(loadCache(corruptPath), { version: 1, servers: {} })
    writeFileSync(corruptPath, '{"version": 2, "servers": {}}', 'utf8')
    assert.deepEqual(loadCache(corruptPath), { version: 1, servers: {} })
    assert.throws(() => loadCache(TMP_DIR))
  } finally {
    rmSync(corruptPath, { force: true })
  }
})

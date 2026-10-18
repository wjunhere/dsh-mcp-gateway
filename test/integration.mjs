// End-to-end integration: real cordis context, real DSH tool registry, real MCP
// servers, real gateway plugin. No stubs of the system under test.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { apply } from '../lib/index.js'

const CONFIG_FILE = process.env.DSH_MCP_GATEWAY_CONFIG ?? join(homedir(), '.pi', 'agent', 'mcp-adapter.json')
const cacheDir = mkdtempSync(join(tmpdir(), 'mcp-gateway-integration-'))
const cacheFile = join(cacheDir, 'cache.json')

const ctx = new Context()
await ctx.plugin(SystemPrompt, { personaPrefix: '' })
await ctx.plugin(ToolRuntime, {})

apply(ctx, {
  configFile: CONFIG_FILE,
  cacheFile,
  discoverOnStart: 'off',
  discoverConcurrency: 2,
  idleTimeoutMs: 60000,
  toolCallTimeoutMs: 60000,
  maxSearchResults: 12,
  includeServers: ['archivum', 'papergate', 'picgo-uploader'],
  excludeServers: [],
  servers: {},
})

const raw = (args) => ctx.tools.execute({
  callId: `call-${Math.random().toString(36).slice(2)}`,
  name: 'mcp',
  arguments: args,
  signal: new AbortController().signal,
})

const textOf = (result) => (result.content ?? [])
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n')

const call = async (args) => {
  const result = await raw(args)
  assert.equal(result.isError, false, `tool call failed: ${JSON.stringify(result, null, 2)}`)
  return textOf(result)
}

try {
  const schemas = ctx.tools.schemas()
  const names = schemas.map((schema) => schema.name)
  assert.deepEqual(names, ['mcp'], `expected exactly the gateway tool, got ${names.join(', ')}`)
  const params = schemas[0].parameters
  assert.equal(params.type, 'object')
  assert.ok(Object.keys(params.properties).includes('search'))
  console.log('1. tool surface is exactly one tool "mcp"')

  const assembly = await ctx.systemPrompt.assemble({})
  const wireTools = assembly.tools.filter((tool) => tool.name === 'mcp')
  assert.equal(wireTools.length, 1)
  const wireChars = JSON.stringify(wireTools[0]).length
  assert.ok(wireChars < 4000, `gateway tool schema is ${wireChars} chars, expected under 4000`)
  console.log(`1b. model-facing gateway schema: ${wireChars} chars (~${Math.round(wireChars / 4)} tokens)`)

  const status = await call({ action: 'status' })
  assert.match(status, /0\/3 servers discovered, 0 tools cached/)
  console.log('2. status before discovery ok')

  const connected = await call({ connect: 'archivum' })
  assert.match(connected, /connected archivum: 9 tools/)
  console.log('3. connect/discover ok:', connected.split('\n')[0])

  const search = await call({ search: 'book download' })
  assert.match(search, /search_books|download_book/)
  console.log('4. search ok:', search.split('\n')[1])

  const described = await call({ describe: 'search_books' })
  assert.match(described, /search_books/)
  assert.match(described, /\{/)
  console.log('5. describe ok')

  const called = await call({ tool: 'server_info' })
  assert.ok(called.length > 0)
  console.log('6. call ok:', called.split('\n')[0])

  const qualified = await call({ tool: 'archivum/server_info' })
  assert.ok(qualified.length > 0)
  console.log('7. server-qualified call ok')

  const failed = await raw({ tool: 'definitely_not_a_tool' })
  assert.equal(failed.isError, true)
  const message = textOf(failed)
  assert.match(message, /not found/)
  assert.match(message, /Did you mean|Use mcp/)
  console.log('8. unknown tool error ok:', message.split('\n')[0])
} finally {
  rmSync(cacheDir, { recursive: true, force: true })
}
console.log('INTEGRATION OK')

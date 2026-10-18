import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'

import { defaultCacheFile, readServerFile, resolveServers } from './config.js'
import { loadCache, saveCache, serverConfigHash } from './cache.js'
import { McpManager } from './manager.js'
import {
  describeTool,
  formatSearchResults,
  rankTools,
  suggestNames,
} from './search.js'

/**
 * `mcp` gateway plugin: one proxy tool instead of every MCP tool schema.
 *
 * The model searches a cached tool catalog, describes one tool when it needs
 * the full schema, and calls tools through this single tool. Servers are
 * started on demand and closed when idle. Context cost is one fixed tool
 * description plus the tool results the model actually asks for.
 *
 * @module dsh-mcp-gateway
 */

export const name = 'mcp-gateway'
export const inject = ['tools']

export const Config = z.object({
  configFile: z.string().required(),
  cacheFile: z.string().required(false),
  discoverOnStart: z.union([z.const('background'), z.const('off')]).default('background'),
  discoverConcurrency: z.natural().default(2),
  connectTimeoutMs: z.natural().default(60000),
  idleTimeoutMs: z.natural().default(600000),
  toolCallTimeoutMs: z.natural().default(60000),
  maxSearchResults: z.natural().default(12),
  includeServers: z.array(z.string()).default([]),
  excludeServers: z.array(z.string()).default([]),
  servers: z.dict(z.object({
    disabled: z.boolean().required(false),
    command: z.string().required(false),
    // Collections use z.any(): schemastery otherwise fills an absent array
    // with [] and an absent map with {}, which would shadow the shared file's
    // args/env instead of leaving them alone. config.js validates them.
    args: z.any().required(false),
    env: z.any().required(false),
    cwd: z.string().required(false),
    url: z.string().required(false),
    headers: z.any().required(false),
    description: z.string().required(false),
    requestTimeoutMs: z.natural().required(false),
  })).default({}),
})

/** Parameter schema for the single `mcp` tool. */
const PARAMETERS = {
  type: 'object',
  properties: {
    search: { type: 'string', description: 'Words to search MCP tool names, descriptions and configured keywords' },
    regex: { type: 'boolean', description: 'Treat search as a regular expression (default false: ranked word search)' },
    includeSchemas: { type: 'boolean', description: 'Include compact parameter shapes in search results (default true)' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum search results (default 12)' },
    offset: { type: 'integer', minimum: 0, description: 'Search result offset for paging' },
    describe: { type: 'string', description: 'Tool name to describe, with its full input schema' },
    tool: { type: 'string', description: 'Tool name to call' },
    args: { type: 'object', additionalProperties: true, description: 'Arguments passed to the tool' },
    server: { type: 'string', description: 'Restrict to one server, or select the server for a tool name' },
    connect: { type: 'string', description: 'Discover one server and refresh its cached tool list' },
    action: {
      type: 'string',
      enum: ['status', 'discover', 'instructions'],
      description: 'status: gateway and server state; discover: refresh missing/new servers; instructions: one server\'s usage instructions',
    },
  },
  additionalProperties: false,
}

/** Canonical output schema: MCP content blocks plus optional structured content. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    structuredContent: {},
  },
  required: ['content'],
  additionalProperties: false,
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const MAX_RESULT_BYTES = 51200
const MAX_RESULT_LINES = 2000
const MAX_DESCRIBE_BYTES = 20000
const MAX_DESCRIBE_LINES = 400
const MAX_SEARCH_BYTES = 16000

/** Whether a value is a plain JSON object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether one MCP content block is a declared image. */
function isImageBlock(block) {
  return isRecord(block) && block.type === 'image'
}

/** Human-readable text for one MCP content block. */
function blockText(block, toolName) {
  if (!isRecord(block)) return '[unsupported MCP content block: expected an object]'
  switch (block.type) {
    case 'text': return typeof block.text === 'string' ? block.text : ''
    case 'image': return `[image: ${block.mimeType ?? 'unknown media type'}]`
    case 'audio': return `[audio: ${block.mimeType ?? 'unknown media type'}]`
    case 'resource_link':
      return block.name === undefined || block.uri === undefined
        ? '[resource link unavailable: the MCP block is missing its name or URI]'
        : `Resource link: ${block.name} (${block.uri})`
    case 'resource':
      return isRecord(block.resource)
        ? `Resource: ${block.resource.uri ?? '(no uri)'}${typeof block.resource.mimeType === 'string' ? ` (${block.resource.mimeType})` : ''}`
        : '[resource unavailable: the MCP block is missing its resource]'
    default: return `[unsupported MCP content block: ${String(block.type ?? 'missing type')}]`
  }
}

/** Join MCP content blocks into the text the model reads. */
function contentText(content, toolName) {
  if (!Array.isArray(content)) return ''
  const lines = content.map((block) => blockText(block, toolName)).filter((line) => line.length > 0)
  return lines.join('\n')
}

/** Model-facing text for one canonical value (shared by render and image fallback). */
function renderText(value) {
  const text = contentText(value?.content, 'mcp')
  return text.length > 0 ? text : '(no output)'
}

/** Write oversized model text to a temp file and return the path. */
function spill(text) {
  const file = join(tmpdir(), `dsh-mcp-gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  writeFileSync(file, text, 'utf8')
  return file
}

/**
 * Bound one text for the model, spilling the full text when it is too large.
 * @param text - the full text.
 * @param options - byte/line caps and the label used in the notice.
 * @returns the bounded text and whether it was truncated.
 */
function guardText(text, { maxBytes, maxLines, label }) {
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = text.length === 0 ? 0 : text.split('\n').length
  if (bytes <= maxBytes && lines <= maxLines) return { text, truncated: false }
  const file = spill(text)
  const head = text.split('\n').slice(0, maxLines).join('\n').slice(0, maxBytes)
  return {
    text: `${head}\n[${label} truncated: ${bytes} bytes / ${lines} lines; full text: ${file}]`,
    truncated: true,
  }
}

/**
 * Bound MCP content blocks for the model, keeping image blocks.
 * @param content - raw MCP content blocks.
 * @param toolName - tool name used in diagnostics.
 * @returns bounded content blocks.
 */
function guardContent(content, toolName) {
  const text = contentText(content, toolName)
  const guarded = guardText(text, { maxBytes: MAX_RESULT_BYTES, maxLines: MAX_RESULT_LINES, label: 'MCP result' })
  if (!guarded.truncated) return content
  return [
    { type: 'text', text: guarded.text },
    ...content.filter(isImageBlock),
  ]
}

/** Decode one canonical base64 image block, rejecting anything non-canonical. */
function decodeImage(block) {
  if (!IMAGE_TYPES.includes(block.mimeType)) throw new Error('the image media type is not PNG, JPEG, WebP, or GIF')
  if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) throw new Error('the image data is not canonical base64')
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) throw new Error('the image data is not canonical base64')
  return { data, mediaType: block.mimeType }
}

/** One text diagnostic replacing an image the deployment refused. */
function imageDiagnostic(block, reason) {
  return `[image unavailable: ${block.mimeType ?? 'unknown media type'}; ${reason}]`
}

/**
 * Resolve the durable attachment store only when the current route accepts images.
 * @param ctx - plugin context carrying the optional services.
 * @param exec - the tool execution whose agent names the route.
 * @returns the attachment store.
 */
async function resolveImageAdmission(ctx, exec) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) throw new Error('the current model route could not be resolved')
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (exec.signal.aborted) throw new Error('the tool call was canceled before image storage')
  return attachments
}

/**
 * Project an image-bearing MCP result into ordered model content.
 * @param ctx - plugin context.
 * @param exec - the tool execution.
 * @param content - raw MCP content blocks.
 * @param toolName - tool name used in diagnostics.
 * @returns projected content blocks.
 */
async function projectImages(ctx, exec, content, toolName) {
  const decoded = []
  const errors = new Map()
  const imageIndexes = []
  for (const [index, block] of content.entries()) {
    if (!isImageBlock(block)) continue
    imageIndexes.push(index)
    try {
      decoded.push(decodeImage(block))
    } catch (error) {
      errors.set(index, error.message)
    }
  }
  if (errors.size > 0) {
    return content.map((block, index) => (isImageBlock(block)
      ? { type: 'text', text: imageDiagnostic(block, errors.get(index) ?? 'another image in the same result was invalid') }
      : block.type === 'text' ? { type: 'text', text: block.text ?? '' } : { type: 'text', text: blockText(block, toolName) }))
  }
  let refs
  try {
    const attachments = await resolveImageAdmission(ctx, exec)
    refs = await attachments.saveImages(decoded)
  } catch (error) {
    const reason = error.message
    return content.map((block) => (isImageBlock(block)
      ? { type: 'text', text: imageDiagnostic(block, reason) }
      : block.type === 'text' ? { type: 'text', text: block.text ?? '' } : { type: 'text', text: blockText(block, toolName) }))
  }
  const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]))
  const projected = []
  let textRun = []
  const flush = () => {
    if (textRun.length === 0) return
    projected.push({ type: 'text', text: textRun.splice(0).join('\n') })
  }
  for (const [index, block] of content.entries()) {
    if (isImageBlock(block)) {
      flush()
      projected.push({ type: 'image', attachment: byIndex.get(index) })
    } else if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) textRun.push(block.text)
    } else {
      textRun.push(blockText(block, toolName))
    }
  }
  flush()
  return projected
}

/** Render one cached entry's tool count for status text. */
function discoveryStamp(entry) {
  if (entry?.discoveredAt === undefined) return 'never'
  return new Date(entry.discoveredAt).toLocaleString('sv-SE').slice(0, 16)
}

/** Build the model-facing gateway description. Config-pure by design. */
function buildDescription(servers) {
  const names = Object.keys(servers)
  const lines = [
    'MCP gateway — search, describe and call tools from configured MCP servers through one tool. Call a tool only after finding it with search or describe; do not use mcp for built-in tools.',
    '',
    names.length === 0 ? 'Servers: (none configured)' : `Servers: ${names.join(', ')}`,
    '',
    'Usage:',
    '  mcp({ search: "query" })                      → ranked tool matches with compact parameter shapes',
    '  mcp({ search: "query", server: "name" })      → search one server',
    '  mcp({ describe: "tool_name" })                → full description and input schema',
    '  mcp({ tool: "tool_name", args: { ... } })     → call a tool',
    '  mcp({ connect: "server_name" })               → discover or refresh one server',
    '  mcp({ action: "status" })                     → server state, tool counts, discovery status',
    '  mcp({ action: "discover" })                   → discover every server without metadata',
    '  mcp({ action: "instructions", server: "name" }) → that server\'s usage instructions',
    '',
    'Tool names may be qualified as "server/tool" when the same name exists on several servers. Servers start on first use and stop when idle.',
    'Mode precedence when several fields are set: action > tool > connect > describe > search > status.',
  ]
  return lines.join('\n')
}

/**
 * Register the gateway plugin.
 * @param ctx - cordis context with `tools`.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config = {}) {
  const file = readServerFile(config.configFile)
  const servers = resolveServers(file, config)
  // Debug artifact: the exact servers this instance resolved, with env values
  // replaced by their key names. Read it when a server behaves differently than
  // expected; it is overwritten on every load and never contains secrets.
  writeFileSync(
    join(tmpdir(), 'dsh-mcp-gateway-resolved.json'),
    JSON.stringify({ configFile: file.absolute, config: { ...config, servers: undefined }, servers }, (key, value) => (
      key === 'env' && value !== null && typeof value === 'object' ? Object.keys(value) : value
    ), 1),
  )
  const cachePath = config.cacheFile ?? defaultCacheFile(file.absolute)
  const logger = ctx.logger ?? console
  let cache = loadCache(cachePath)

  const manager = new McpManager({
    servers,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    logger,
  })

  /** Ordered cache writes, so two discoveries cannot interleave a rename. */
  let saveChain = Promise.resolve()
  const persist = () => {
    saveChain = saveChain.then(() => saveCache(cachePath, cache)).catch((error) => {
      logger.warn?.(`mcp-gateway: cache write failed: ${error.message}`)
    })
    return saveChain
  }

  /** In-flight discovery per server, so search/connect/startup share one attempt. */
  const discovering = new Map()
  const discoverOne = (serverName, { force = false, persistNow = true } = {}) => {
    const server = servers[serverName]
    if (server === undefined) throw new Error(`mcp-gateway: unknown server "${serverName}"`)
    const current = cache.servers[serverName]
    const hash = serverConfigHash(server)
    if (!force && current !== undefined && current.configHash === hash && current.failure === undefined && Array.isArray(current.tools)) {
      return Promise.resolve(current)
    }
    if (discovering.has(serverName)) return discovering.get(serverName)
    const attempt = (async () => {
      try {
        const discovered = await manager.discover(serverName)
        cache.servers[serverName] = {
          configHash: hash,
          tools: discovered.tools,
          instructions: discovered.instructions ?? '',
          discoveredAt: Date.now(),
        }
      } catch (error) {
        const previous = cache.servers[serverName]
        cache.servers[serverName] = {
          ...(previous !== undefined && previous.configHash === hash
            ? { ...previous }
            : { configHash: hash, tools: [], instructions: '' }),
          failure: { at: Date.now(), message: error.message },
        }
        if (persistNow) await persist()
        throw error
      }
      if (persistNow) await persist()
      return cache.servers[serverName]
    })().finally(() => discovering.delete(serverName))
    discovering.set(serverName, attempt)
    return attempt
  }

  /** Servers without usable cached metadata for the current config. */
  const pendingServers = () => Object.keys(servers).filter((serverName) => {
    const entry = cache.servers[serverName]
    return entry === undefined || entry.configHash !== serverConfigHash(servers[serverName])
  })

  /** Search view: every cached server whose config still matches. */
  const catalog = () => {
    const view = {}
    for (const [serverName, server] of Object.entries(servers)) {
      const entry = cache.servers[serverName]
      if (entry === undefined || entry.configHash !== serverConfigHash(server)) continue
      view[serverName] = {
        description: server.description,
        searchKeywords: server.searchKeywords,
        tools: Array.isArray(entry.tools) ? entry.tools : [],
      }
    }
    return view
  }

  /** Tool names published by more than one server, which search renders as `server/name`. */
  const ambiguousToolNames = (view) => {
    const owners = new Map()
    for (const [serverName, server] of Object.entries(view)) {
      for (const tool of server.tools) {
        const entry = owners.get(tool.name) ?? new Set()
        entry.add(serverName)
        owners.set(tool.name, entry)
      }
    }
    return new Set([...owners].filter(([, names]) => names.size > 1).map(([name]) => name))
  }

  /** Resolve one tool name to its server and tool record. */
  const resolveTool = (rawName, serverFilter) => {
    const view = catalog()
    const requested = String(rawName)
    const normalized = requested.replace(/-/g, '_').toLowerCase()
    const candidates = []
    let explicitServer
    let bareName = requested
    const qualified = requested.match(/^mcp__(.+?)__(.+)$/) ?? requested.match(/^([^/]+)\/(.+)$/)
    if (qualified !== null) {
      explicitServer = qualified[1]
      bareName = qualified[2]
    }
    for (const [serverName, server] of Object.entries(view)) {
      if (serverFilter !== undefined && serverName !== serverFilter) continue
      if (explicitServer !== undefined && serverName !== explicitServer) continue
      for (const tool of server.tools) {
        const direct = tool.name === bareName
        const squashed = String(tool.name).replace(/-/g, '_').toLowerCase() === bareName.replace(/-/g, '_').toLowerCase()
        const normalizedMatch = String(tool.name).replace(/-/g, '_').toLowerCase() === normalized
        if (direct || squashed || normalizedMatch) candidates.push({ server: serverName, tool })
      }
    }
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) {
      throw new Error(`mcp-gateway: tool "${requested}" exists on ${candidates.map((candidate) => candidate.server).join(', ')}; pass server or use "server/tool"`)
    }
    const suggestions = suggestNames(requested, view)
    const scope = serverFilter === undefined ? '' : ` on server "${serverFilter}"`
    throw new Error(`mcp-gateway: tool "${requested}" not found${scope}.${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use mcp({ search: "..." }) to find tools.`)
  }

  /** Per-execution image projections, keyed by the execution token. */
  const projections = new WeakMap()

  /** Build the tool definition. */
  const definition = {
    name: 'mcp',
    description: buildDescription(servers),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: renderText(value) }]
      },
    },
    projectContent(exec, result) {
      const projection = projections.get(exec)
      if (projection === undefined) return undefined
      projections.delete(exec)
      if (result.isError === true) return undefined
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined
      return projection.content
    },
    async execute(args, exec) {
      if (args.action !== undefined && !['status', 'discover', 'instructions'].includes(args.action)) {
        throw new Error(`mcp-gateway: unknown action "${args.action}"; expected status, discover or instructions`)
      }
      const gatewayMode = args.action !== undefined
        ? args.action
        : args.tool !== undefined
          ? 'tool'
          : args.connect !== undefined
            ? 'connect'
            : args.describe !== undefined
              ? 'describe'
              : args.search !== undefined
                ? 'search'
                : 'status'
      if (gatewayMode === 'tool' && args.args !== undefined && !isRecord(args.args)) {
        throw new Error('mcp-gateway: "args" must be a JSON object')
      }
      if (gatewayMode !== 'search' && (args.regex !== undefined || args.limit !== undefined || args.offset !== undefined || args.includeSchemas !== undefined)) {
        throw new Error('mcp-gateway: regex/limit/offset/includeSchemas only apply to search')
      }

      if (gatewayMode === 'status') {
        const ready = Object.keys(servers).filter((serverName) => {
          const entry = cache.servers[serverName]
          return entry !== undefined
            && entry.configHash === serverConfigHash(servers[serverName])
            && entry.failure === undefined
        })
        const lines = [
          `mcp-gateway: ${ready.length}/${Object.keys(servers).length} servers discovered, ${ready.reduce((sum, name) => sum + (cache.servers[name]?.tools?.length ?? 0), 0)} tools cached`,
          `config: ${file.absolute}`,
          `cache: ${cachePath}`,
        ]
        for (const serverName of Object.keys(servers)) {
          const entry = cache.servers[serverName]
          const state = manager.status(serverName)
          const tools = entry?.configHash === serverConfigHash(servers[serverName]) && Array.isArray(entry?.tools)
            ? `${entry.tools.length} tools`
            : 'no metadata'
          const parts = [state?.state ?? 'idle', tools, `discovered ${discoveryStamp(entry)}`]
          if (entry?.failure !== undefined) parts.push(`last error: ${entry.failure.message}`)
          if (state?.lastError !== undefined && state.lastError !== entry?.failure?.message) parts.push(`runtime error: ${state.lastError}`)
          lines.push(`- ${serverName}: ${parts.join(', ')}`)
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      if (gatewayMode === 'discover') {
        const targets = args.server !== undefined ? [args.server] : Object.keys(servers)
        const failures = []
        let done = 0
        const queue = [...targets]
        const worker = async () => {
          while (queue.length > 0) {
            const serverName = queue.shift()
            try {
              await discoverOne(serverName, { force: true })
              done += 1
            } catch (error) {
              failures.push(`${serverName}: ${error.message}`)
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(config.discoverConcurrency, targets.length) }, () => worker()))
        const summary = [`discovered ${done}/${targets.length} servers`]
        if (failures.length > 0) summary.push(`failures:\n${failures.map((line) => `- ${line}`).join('\n')}`)
        return { content: [{ type: 'text', text: summary.join('\n') }] }
      }

      if (gatewayMode === 'connect') {
        const serverName = String(args.connect)
        if (servers[serverName] === undefined) throw new Error(`mcp-gateway: unknown server "${serverName}". Known: ${Object.keys(servers).join(', ')}`)
        const entry = await discoverOne(serverName, { force: true })
        const names = entry.tools.map((tool) => tool.name)
        const text = `connected ${serverName}: ${names.length} tools${names.length > 0 ? `\n${names.join(', ')}` : ''}`
        return { content: [{ type: 'text', text }] }
      }

      if (gatewayMode === 'instructions') {
        const serverName = args.server
        if (serverName === undefined) throw new Error('mcp-gateway: action "instructions" needs "server"')
        const entry = cache.servers[serverName]
        if (entry === undefined) throw new Error(`mcp-gateway: server "${serverName}" has no cached metadata; call mcp({ connect: "${serverName}" }) first`)
        const text = typeof entry.instructions === 'string' && entry.instructions.length > 0
          ? entry.instructions
          : `(server "${serverName}" published no instructions)`
        return { content: [{ type: 'text', text }] }
      }

      if (gatewayMode === 'describe') {
        const resolved = resolveTool(args.describe, args.server)
        const described = guardText(describeTool(resolved.server, resolved.tool), {
          maxBytes: MAX_DESCRIBE_BYTES,
          maxLines: MAX_DESCRIBE_LINES,
          label: 'tool description',
        })
        return { content: [{ type: 'text', text: described.text }] }
      }

      if (gatewayMode === 'search') {
        const view = catalog()
        if (Object.keys(view).length === 0) {
          const pending = pendingServers()
          throw new Error(`mcp-gateway: no server metadata yet.${pending.length > 0 ? ` Discover first: ${pending.join(', ')}.` : ''} Call mcp({ action: "discover" }) or mcp({ connect: "server" }).`)
        }
        const limit = Math.min(args.limit ?? config.maxSearchResults, 50)
        const offset = args.offset ?? 0
        const ranked = rankTools(String(args.search), view, {
          limit,
          offset,
          ...(args.server === undefined ? {} : { server: args.server }),
          ...(args.regex === true ? { regex: true } : {}),
        })
        if (ranked.total === 0) {
          const hints = suggestNames(String(args.search), view)
          const pending = pendingServers()
          const lines = [`no tools matched "${args.search}".`]
          if (hints.length > 0) lines.push(`Closest names: ${hints.join(', ')}`)
          if (pending.length > 0) lines.push(`Servers without metadata (not searched): ${pending.join(', ')} — mcp({ action: "discover" }) to include them.`)
          lines.push('Try mcp({ action: "status" }) to see server state.')
          return { content: [{ type: 'text', text: lines.join('\n') }] }
        }
        const listing = formatSearchResults(
          { ...ranked, offset, limit },
          { includeSchemas: args.includeSchemas !== false, ambiguousNames: ambiguousToolNames(view) },
        )
        const bounded = guardText(listing, { maxBytes: MAX_SEARCH_BYTES, maxLines: 400, label: 'search results' })
        const pending = pendingServers()
        return {
          content: [{
            type: 'text',
            text: pending.length === 0
              ? bounded.text
              : `${bounded.text}\n\nNot yet discovered: ${pending.join(', ')} — mcp({ connect: "name" }) to load.`,
          }],
        }
      }

      // gatewayMode === 'tool'
      const resolved = resolveTool(args.tool, args.server)
      const toolArgs = args.args ?? {}
      let result
      try {
        result = await manager.call(resolved.server, resolved.tool.name, toolArgs, { signal: exec.signal })
      } catch (error) {
        throw new Error(`mcp-gateway: call ${resolved.server}/${resolved.tool.name} failed: ${error.message}`)
      }
      const rawContent = Array.isArray(result?.content) ? result.content : []
      const rawText = contentText(rawContent, resolved.tool.name)
      if (result?.isError === true) {
        throw new Error(rawText.length > 0 ? rawText : `mcp-gateway: ${resolved.server}/${resolved.tool.name} returned an error result`)
      }
      const content = guardContent(rawContent, resolved.tool.name)
      const value = {
        content,
        ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      }
      if (content.some(isImageBlock)) {
        const fallback = [{ type: 'text', text: renderText(value) }]
        const projected = await projectImages(ctx, exec, content, resolved.tool.name)
        projections.set(exec, { value, fallback, content: projected })
      }
      return value
    },
  }

  ctx.effect(() => {
    const disposeTool = ctx.tools.register(definition)
    let cancelled = false
    if (config.discoverOnStart !== 'off') {
      const timer = setTimeout(() => {
        if (cancelled) return
        const targets = pendingServers()
        const queue = [...targets]
        const worker = async () => {
          while (queue.length > 0 && !cancelled) {
            const serverName = queue.shift()
            try {
              await discoverOne(serverName, { persistNow: false })
              await manager.disconnect(serverName)
            } catch (error) {
              logger.warn?.(`mcp-gateway: background discovery of "${serverName}" failed: ${error.message}`)
            }
          }
        }
        void Promise.all(Array.from({ length: Math.min(config.discoverConcurrency, targets.length) }, () => worker()))
          .then(() => persist())
          .catch((error) => logger.error?.(`mcp-gateway: background discovery failed: ${error.message}`))
      }, 0)
      timer.unref?.()
      return () => {
        cancelled = true
        clearTimeout(timer)
        disposeTool()
        void manager.closeAll()
      }
    }
    return () => {
      cancelled = true
      disposeTool()
      void manager.closeAll()
    }
  })
}

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Load the shared MCP server list (the same JSON file Pi uses) and apply the
 * gateway's include/exclude and per-server overrides.
 *
 * The file is the single source of truth on purpose: one JSON file configures
 * both agents, so a server added in either place works everywhere.
 */

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(path) {
  const text = String(path)
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/**
 * Read the configured JSON file.
 * @param path - path to the MCP server config; a leading `~` is expanded.
 * @returns the parsed `mcpServers` map.
 */
export function readServerFile(path) {
  const absolute = resolve(expandHome(path))
  if (!existsSync(absolute)) throw new Error(`mcp-gateway: config file not found: ${absolute}`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch (error) {
    throw new Error(`mcp-gateway: config file is not valid JSON (${absolute}): ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`mcp-gateway: config file must contain a JSON object: ${absolute}`)
  }
  const servers = parsed.mcpServers
  if (servers === undefined) return { absolute, servers: {} }
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`mcp-gateway: "mcpServers" must be an object: ${absolute}`)
  }
  return { absolute, servers }
}

/**
 * Merge one raw entry with the gateway override and normalize it.
 * @param name - server name from the config map.
 * @param raw - the entry as written in the JSON file.
 * @param override - optional gateway-side override.
 * @returns a normalized server config, or undefined when disabled.
 */
function normalizeServer(name, raw, override = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`mcp-gateway: server "${name}" must be an object`)
  }
  if (raw.disabled === true || override.disabled === true) return undefined

  const url = raw.url ?? override.url
  const command = raw.command ?? override.command
  if (url === undefined && command === undefined) {
    throw new Error(`mcp-gateway: server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`)
  }
  if (url !== undefined && command !== undefined) {
    throw new Error(`mcp-gateway: server "${name}" sets both "command" and "url"; exactly one transport is allowed`)
  }

  const args = raw.args ?? override.args
  if (args !== undefined && (!Array.isArray(args) || args.some((value) => typeof value !== 'string'))) {
    throw new Error(`mcp-gateway: server "${name}" args must be an array of strings`)
  }

  return {
    name,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(raw.env === undefined ? {} : { env: raw.env }),
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
    ...(url === undefined ? {} : { url }),
    ...(raw.headers === undefined ? {} : { headers: raw.headers }),
    ...(raw.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: raw.requestTimeoutMs }),
    ...(raw.lifecycle === undefined ? {} : { lifecycle: raw.lifecycle }),
    ...(raw.description === undefined && override.description === undefined
      ? {}
      : { description: raw.description ?? override.description }),
    ...(raw.searchKeywords === undefined ? {} : { searchKeywords: raw.searchKeywords }),
  }
}

/**
 * Resolve the effective server map for this gateway instance.
 * @param fileConfig - result of {@link readServerFile}.
 * @param gatewayConfig - the plugin's own config (include/exclude/overrides).
 * @returns the normalized servers keyed by name.
 */
export function resolveServers(fileConfig, gatewayConfig) {
  const include = new Set(gatewayConfig.includeServers ?? [])
  const exclude = new Set(gatewayConfig.excludeServers ?? [])
  const overrides = gatewayConfig.servers ?? {}
  const servers = {}
  for (const [name, raw] of Object.entries(fileConfig.servers)) {
    if (include.size > 0 && !include.has(name)) continue
    if (exclude.has(name)) continue
    const normalized = normalizeServer(name, raw, overrides[name] ?? {})
    if (normalized !== undefined) servers[name] = normalized
  }
  for (const name of include) {
    if (servers[name] === undefined && fileConfig.servers[name] === undefined) {
      throw new Error(`mcp-gateway: includeServers names unknown server "${name}" (config: ${fileConfig.absolute})`)
    }
  }
  return servers
}

/**
 * Default cache location: next to the shared config file, so the cache follows
 * the server list.
 * @param configFile - absolute path to the server config file.
 * @returns the cache path.
 */
export function defaultCacheFile(configFile) {
  return join(dirname(resolve(configFile)), '.dsh-mcp-gateway-cache.json')
}

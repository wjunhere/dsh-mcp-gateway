import { createHash } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Metadata cache: tool lists + server instructions persisted next to the
 * shared MCP config, so search works before (or without) reconnecting.
 *
 * A cache entry is only reused when the server's transport identity hash still
 * matches, and never after a recorded connection failure.
 */

/** Transport-relevant fields that identify one server's configuration. */
const IDENTITY_FIELDS = ['command', 'args', 'env', 'cwd', 'url', 'headers']

const CACHE_VERSION = 1

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function emptyCache() {
  return { version: CACHE_VERSION, servers: {} }
}

/** Sort object keys so that two equal maps produce identical JSON. */
function sortedObject(value) {
  if (!isPlainObject(value)) return value
  const sorted = {}
  for (const key of Object.keys(value).sort()) sorted[key] = value[key]
  return sorted
}

/**
 * sha256 of the server's transport identity: command, args, env, cwd, url and
 * headers (env/headers key-sorted). Non-identity fields such as description,
 * searchKeywords or lifecycle are deliberately ignored.
 */
export function serverConfigHash(config) {
  const identity = {}
  for (const field of IDENTITY_FIELDS) {
    const value = config?.[field]
    if (value === undefined) continue
    identity[field] = field === 'env' || field === 'headers' ? sortedObject(value) : value
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/**
 * Read the cache file. Missing or corrupt files yield an empty cache; any
 * other read error (permissions, I/O) is thrown.
 */
export function loadCache(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyCache()
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyCache()
  }
  if (!isPlainObject(parsed) || parsed.version !== CACHE_VERSION || !isPlainObject(parsed.servers)) {
    return emptyCache()
  }
  return { version: CACHE_VERSION, servers: parsed.servers }
}

/** Atomically replace the cache file: write a temp sibling, then rename. */
export function saveCache(path, cache) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  try {
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // best effort cleanup; the original rename error is what matters
    }
    throw error
  }
}

/**
 * A cached entry is reusable when it belongs to the current config and its last
 * discovery did not fail. Empty `tools`/`instructions` are valid entries.
 */
export function cacheEntryValid(entry, config) {
  if (!isPlainObject(entry)) return false
  if (entry.failure !== undefined && entry.failure !== null) return false
  return entry.configHash === serverConfigHash(config)
}

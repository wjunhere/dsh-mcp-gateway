/**
 * Tool search + compact parameter summaries for the mcp gateway.
 * Ranking follows pi-mcp-adapter's lexical model: weighted token overlap over
 * name/server/description/searchKeywords with a coverage gate that drops weak
 * matches. The regex path is an unranked filter over the same fields.
 */

const FIELD_WEIGHTS = { name: 12, originalName: 10, server: 8, description: 5, serverDescription: 5, keywords: 5 }
const MIN_STEM_LENGTH = 4
const MAX_UNICODE_BIGRAMS_PER_RUN = 64
const SEARCH_RUN = /[a-z0-9]+|(?:(?![a-z0-9])[\p{L}\p{N}\p{M}])+/gu
const ASCII_RUN = /^[a-z0-9]+$/
const MAX_REGEX_QUERY_LENGTH = 256
const BACKREFERENCE = /\\(?:[1-9]|k[<{])/
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,?\d*\})/
const QUANTIFIED_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,?\d*\})/
const MAX_SHAPE_DEPTH = 2
const PROPERTY_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const MAX_RESULT_DESCRIPTION = 100
/** A compact shape longer than this is cut with a describe hint (some MCP schemas are tens of KB). */
const MAX_RESULT_SHAPE = 320
const UNSAFE_SCHEMA_KEYS = new Set(
  ('$ref $defs definitions allOf anyOf oneOf not if then else patternProperties dependencies ' +
    'dependentSchemas unevaluatedProperties unevaluatedItems prefixItems propertyNames').split(' '),
)

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// --- tokenization ----------------------------------------------------------

/** Split camelCase and `_ . / : -` separators, then lowercase. */
export function normalizeSearchText(value) {
  return String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_./:-]+/g, ' ').toLowerCase()
}

/** ASCII runs stay whole; non-ASCII runs become bigrams so Chinese keywords match. */
export function tokenize(value) {
  const tokens = []
  for (const run of normalizeSearchText(value).match(SEARCH_RUN) ?? []) {
    if (ASCII_RUN.test(run)) {
      tokens.push(run)
      continue
    }
    const characters = [...run]
    if (characters.length === 1 || characters.length > MAX_UNICODE_BIGRAMS_PER_RUN + 1) {
      tokens.push(run)
      continue
    }
    for (let index = 1; index < characters.length; index += 1) tokens.push(characters[index - 1] + characters[index])
  }
  return [...new Set(tokens)]
}

function matchesAsciiStem(fieldToken, queryToken) {
  if (!ASCII_RUN.test(fieldToken) || !ASCII_RUN.test(queryToken)) return false
  return fieldToken.startsWith(queryToken) || (fieldToken.length >= MIN_STEM_LENGTH && queryToken.startsWith(fieldToken))
}

// --- searchKeywords (config maps tool name or '*' to vocab arrays) ---------

function globToRegExp(pattern) {
  let source = ''
  for (const character of pattern) {
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

function matchesToolPattern(pattern, candidates) {
  if (pattern === '*') return true
  if (!pattern.includes('*') && !pattern.includes('?')) return candidates.includes(pattern)
  const patternRegExp = globToRegExp(pattern)
  return candidates.some((candidate) => patternRegExp.test(candidate))
}

function resolveSearchKeywords(definition, serverName, tool) {
  const map = definition?.searchKeywords
  if (!isPlainObject(map)) return []
  const originalName = typeof tool.originalName === 'string' ? tool.originalName : tool.name
  const candidates = [tool.name, originalName, `${serverName}_${tool.name}`, `${serverName}_${originalName}`]
  const keywords = []
  const seen = new Set()
  for (const [pattern, values] of Object.entries(map)) {
    if (!Array.isArray(values) || !matchesToolPattern(pattern, candidates)) continue
    for (const value of values) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      keywords.push(trimmed)
    }
  }
  return keywords
}

// --- lexical ranking -------------------------------------------------------

function prepareToolSearch(tool, serverName, definition, includeKeywords) {
  const originalName = typeof tool.originalName === 'string' ? tool.originalName : tool.name
  const fields = [
    ['name', normalizeSearchText(tool.name)],
    ['originalName', normalizeSearchText(originalName)],
    ['server', normalizeSearchText(serverName)],
    ['description', normalizeSearchText(tool.description)],
    ['serverDescription', normalizeSearchText(definition?.description)],
  ].map(([field, value]) => [field, value, tokenize(value)])
  const keywordPhrases = includeKeywords
    ? resolveSearchKeywords(definition, serverName, tool).map((keyword) => normalizeSearchText(keyword).trim()).filter(Boolean)
    : []
  return { tool, fields, nameTokens: fields[0][2], keywordPhrases, keywordTokens: keywordPhrases.flatMap(tokenize) }
}

/** Returns a score, or null when the tool fails the coverage gate. */
function scorePreparedToolMatch(prepared, normalizedQuery, queryTokens) {
  let score = 0
  let phraseMatched = false
  let wholeFieldExact = false
  const matchedTokens = new Set()
  const addTokenScore = (weight, fieldTokens, value) => {
    for (const token of queryTokens) {
      if (fieldTokens.includes(token)) score += weight * 4
      else if (fieldTokens.some((fieldToken) => matchesAsciiStem(fieldToken, token))) score += weight * 2
      else if (value.includes(token)) score += weight
      else continue
      matchedTokens.add(token)
    }
  }
  for (const [field, value, fieldTokens] of prepared.fields) {
    const weight = FIELD_WEIGHTS[field]
    if (value === normalizedQuery) {
      score += weight * 14
      phraseMatched = true
      wholeFieldExact = true
    } else if (value.startsWith(normalizedQuery)) {
      score += weight * 9
      phraseMatched = true
    } else if (value.includes(normalizedQuery)) {
      score += weight * 6
      phraseMatched = true
    }
    addTokenScore(weight, fieldTokens, value)
  }
  // Keywords are discrete phrases: best phrase per tool, then token overlap.
  if (prepared.keywordPhrases.length > 0) {
    const weight = FIELD_WEIGHTS.keywords
    let phraseScore = 0
    for (const phrase of prepared.keywordPhrases) {
      if (phrase === normalizedQuery) {
        phraseScore = Math.max(phraseScore, weight * 14)
        phraseMatched = true
        wholeFieldExact = true
      } else if (phrase.startsWith(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 9)
        phraseMatched = true
      } else if (phrase.includes(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 6)
        phraseMatched = true
      }
    }
    score += phraseScore
    addTokenScore(weight, prepared.keywordTokens, prepared.keywordPhrases.join(' '))
  }
  const coverage = matchedTokens.size / queryTokens.length
  if (!phraseMatched && (queryTokens.length <= 2 ? coverage !== 1 : coverage < 0.6)) return null
  score += coverage === 1 ? 25 : Math.round(coverage * 10)
  if (prepared.nameTokens.includes(queryTokens[0])) score += 8
  if (wholeFieldExact) score += 20
  return score
}

function rankMatches(query, servers, serverFilter, includeKeywords) {
  const matches = []
  const normalizedQuery = normalizeSearchText(query).trim()
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return matches
  for (const [serverName, definition] of Object.entries(servers ?? {})) {
    if (serverFilter !== undefined && serverName !== serverFilter) continue
    const tools = Array.isArray(definition?.tools) ? definition.tools : []
    for (const tool of tools) {
      const score = scorePreparedToolMatch(prepareToolSearch(tool, serverName, definition, includeKeywords), normalizedQuery, queryTokens)
      if (score !== null) matches.push({ server: serverName, tool, score })
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
}

// --- regex path ------------------------------------------------------------

function patternError(message, code = 'invalid_pattern') {
  const error = new Error(`mcp-gateway search: ${message}`)
  error.code = code
  return error
}

/** Compile with basic ReDoS guards: length cap, no backrefs, no nested quantifiers. */
function compileSearchRegex(query) {
  if (typeof query !== 'string') throw patternError('regex search needs a string pattern')
  if (query.length > MAX_REGEX_QUERY_LENGTH) throw patternError(`regex is longer than ${MAX_REGEX_QUERY_LENGTH} characters`)
  if (BACKREFERENCE.test(query) || NESTED_QUANTIFIER.test(query) || QUANTIFIED_ALTERNATION.test(query)) {
    throw patternError('regex rejected as unsafe (backreference or nested quantifier)', 'unsafe_pattern')
  }
  try {
    return new RegExp(query, 'i')
  } catch (error) {
    throw patternError(`invalid regex: ${error.message}`)
  }
}

function filterMatchesByRegex(query, servers, serverFilter) {
  const pattern = compileSearchRegex(query)
  const matches = []
  for (const [serverName, definition] of Object.entries(servers ?? {})) {
    if (serverFilter !== undefined && serverName !== serverFilter) continue
    const tools = Array.isArray(definition?.tools) ? definition.tools : []
    for (const tool of tools) {
      const keywords = resolveSearchKeywords(definition, serverName, tool)
      const matched =
        pattern.test(tool.name) ||
        pattern.test(tool.description ?? '') ||
        keywords.some((keyword) => pattern.test(keyword))
      if (matched) matches.push({ server: serverName, tool })
    }
  }
  return matches
}

// --- public search API -----------------------------------------------------

function paginate(items, offset, limit) {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 12
  return { results: items.slice(safeOffset, safeOffset + safeLimit), total: items.length }
}

/**
 * Search the configured servers.
 * @param query - space separated words, or a regex source when `regex` is set.
 * @param servers - normalized server map from config.js, with discovered tools.
 * @param options - { limit = 12, offset = 0, server?, regex? }.
 * @returns one page of `{ server, tool }` hits plus the unpaged total.
 */
export function rankTools(query, servers, options = {}) {
  const { limit = 12, offset = 0, server, regex = false } = options
  const matches = regex ? filterMatchesByRegex(query, servers, server) : rankMatches(query, servers, server, true)
  return paginate(matches, offset, limit)
}

/** Typo recovery: strip a server-name prefix, re-rank without keywords, return names. */
export function suggestNames(query, servers, limit = 5) {
  let text = String(query ?? '')
  for (const name of Object.keys(servers ?? {}).sort((a, b) => b.length - a.length)) {
    if (!text.startsWith(`${name}_`)) continue
    text = text.slice(name.length + 1)
    break
  }
  const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 5
  const seen = new Set()
  const suggestions = []
  for (const match of rankMatches(text, servers, undefined, false)) {
    if (seen.has(match.tool.name)) continue
    seen.add(match.tool.name)
    suggestions.push(match.tool.name)
    if (suggestions.length >= max) break
  }
  return suggestions
}

// --- compact schema rendering ----------------------------------------------

function jsonLiteral(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return value === null ? 'null' : null
}

function renderLiteral(schema) {
  const values = Array.isArray(schema.enum) ? schema.enum : schema.const === undefined ? undefined : [schema.const]
  if (values === undefined) return undefined
  const rendered = []
  for (const value of values) {
    const text = jsonLiteral(value)
    if (text === null) return null
    if (!rendered.includes(text)) rendered.push(text)
  }
  return rendered.length > 0 ? rendered.join(' | ') : undefined
}

function renderArray(schema, depth, stack) {
  if (Array.isArray(schema.items)) return null
  const rendered = renderType(schema.items, depth + 1, stack)
  if (rendered === null) return null
  return rendered.includes(' | ') ? `(${rendered})[]` : `${rendered}[]`
}

function renderObject(schema, depth, stack) {
  if (depth > MAX_SHAPE_DEPTH) return 'unknown'
  const properties = isPlainObject(schema.properties) ? schema.properties : {}
  const names = Object.keys(properties)
  if (names.length === 0) {
    if (!isPlainObject(schema.additionalProperties)) return '{}'
    const rendered = renderType(schema.additionalProperties, depth + 1, stack)
    return rendered === null ? null : `{ [key: string]: ${rendered} }`
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value) => typeof value === 'string') : [])
  stack.add(schema)
  try {
    const members = []
    for (const name of names) {
      const rendered = renderType(properties[name], depth + 1, stack)
      if (rendered === null) return null
      members.push(`${PROPERTY_NAME.test(name) ? name : JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${rendered}`)
    }
    return `{ ${members.join('; ')} }`
  } finally {
    stack.delete(schema)
  }
}

function renderType(schema, depth, stack) {
  if (schema === true || schema === undefined) return 'unknown'
  if (schema === false) return 'never'
  if (!isPlainObject(schema) || stack.has(schema)) return null
  for (const key of Object.keys(schema)) if (UNSAFE_SCHEMA_KEYS.has(key)) return null
  const literal = renderLiteral(schema)
  if (literal === null) return null
  if (literal !== undefined) return literal
  const variants = []
  for (const type of Array.isArray(schema.type) ? schema.type : [schema.type]) {
    let rendered
    switch (type) {
      case 'string': rendered = 'string'; break
      case 'number':
      case 'integer': rendered = 'number'; break
      case 'boolean': rendered = 'boolean'; break
      case 'null': rendered = 'null'; break
      case 'array': rendered = renderArray(schema, depth, stack); break
      case 'object': rendered = renderObject(schema, depth, stack); break
      default: rendered = type === undefined && isPlainObject(schema.properties) ? renderObject(schema, depth, stack) : 'unknown'
    }
    if (rendered === null) return null
    if (!variants.includes(rendered)) variants.push(rendered)
  }
  return variants.join(' | ')
}

/**
 * Summarize an MCP input schema as a compact TypeScript-ish shape, or '' when
 * the schema is not safely summarizable (caller can point at describe). Never throws.
 */
export function compactShape(inputSchema) {
  try {
    return isPlainObject(inputSchema) ? renderType(inputSchema, 0, new Set()) ?? '' : ''
  } catch {
    return ''
  }
}

// --- describe + result formatting -----------------------------------------

/** Multi-line description: header, description, annotation hints, then schema. */
export function describeTool(serverName, tool) {
  const lines = [`${tool.name} (server: ${serverName})`]
  const description = String(tool.description ?? '').trim()
  if (description) lines.push(description)
  const hints = []
  if (tool.annotations?.readOnlyHint === true) hints.push('read-only')
  if (tool.annotations?.idempotentHint === true) hints.push('idempotent')
  if (hints.length > 0) lines.push(`Hints: ${hints.join(', ')}`)
  const shape = compactShape(tool.inputSchema)
  if (shape) lines.push(`Params: ${shape}`)
  else if (tool.inputSchema !== undefined) lines.push(`Input schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`)
  return lines.join('\n')
}

function shortDescription(description) {
  const line = String(description ?? '').split('\n')[0].trim()
  if (line.length <= MAX_RESULT_DESCRIPTION) return line
  const cut = line.slice(0, MAX_RESULT_DESCRIPTION - 1)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > MAX_RESULT_DESCRIPTION / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}

/**
 * Render one page: `- name - description`, indented shapes, next-offset footer.
 * Names that exist on several servers are rendered as `server/name` so the
 * model can call them unambiguously.
 */
export function formatSearchResults({ results, total, offset = 0 }, { includeSchemas = true, ambiguousNames = new Set() } = {}) {
  const items = Array.isArray(results) ? results : []
  if (items.length === 0) return 'No matching tools.'
  const lines = []
  for (const { server, tool } of items) {
    const label = ambiguousNames.has(tool.name) ? `${server}/${tool.name}` : tool.name
    const summary = shortDescription(tool.description)
    lines.push(`- ${label}${summary ? ` - ${summary}` : ''}`)
    if (includeSchemas) {
      const shape = compactShape(tool.inputSchema)
      if (shape) {
        lines.push(shape.length <= MAX_RESULT_SHAPE
          ? `  ${shape}`
          : `  ${shape.slice(0, MAX_RESULT_SHAPE)}… (truncated; full schema: mcp({ describe: "${label}" }))`)
      }
    }
  }
  const nextOffset = offset + items.length
  if (nextOffset < total) lines.push('', `${nextOffset} of ${total} — next offset: ${nextOffset}`)
  return lines.join('\n')
}

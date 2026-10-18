// Release gate: validates the manifest and bundle patch, syntax-checks the
// shipped modules and (when given a tag) proves the tag matches the version.
// Runs in `npm pack` via prepack and in the release workflow.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const requiredFiles = [
  'lib/index.js',
  'lib/config.js',
  'lib/cache.js',
  'lib/search.js',
  'lib/manager.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
]

const fail = (message) => problems.push(message)
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))

const pkg = readJson('package.json')
if (typeof pkg.name !== 'string' || pkg.name.length === 0) fail('package.json: missing name')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(pkg.version))) fail(`package.json: version "${pkg.version}" is not semver`)
if (pkg.type !== 'module') fail('package.json: expected "type": "module"')
if (pkg.publishConfig?.access !== 'public') fail('package.json: publishConfig.access must be "public"')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json: dsh.bundle.patch must point at ./cordis.patch.yml')
if (typeof pkg.engines?.dsh !== 'string') fail('package.json: engines.dsh is required for the DSH compatibility check')
if (pkg.license !== 'MIT') fail('package.json: license must be MIT')
if (!Array.isArray(pkg.files) || !pkg.files.includes('lib') || !pkg.files.includes('cordis.patch.yml')) fail('package.json: "files" must ship lib and cordis.patch.yml')

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) fail(`missing required file: ${file}`)
}

const patchPath = join(root, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  let patch
  try {
    patch = parse(readFileSync(patchPath, 'utf8'))
  } catch (error) {
    fail(`cordis.patch.yml is not valid YAML: ${error.message}`)
  }
  if (patch !== undefined) {
    if (!Array.isArray(patch)) fail('cordis.patch.yml must be a top-level YAML array')
    else {
      const rows = patch.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
      const own = rows.find((row) => row?.name === pkg.name)
      if (own === undefined) fail(`cordis.patch.yml must insert a row named "${pkg.name}"`)
      else if (typeof own.id !== 'string' || own.id.length === 0) fail('cordis.patch.yml: inserted row needs an id')
    }
  }
}

const shipped = join(root, 'lib')
if (existsSync(shipped)) {
  for (const file of readdirSync(shipped).filter((name) => name.endsWith('.js'))) {
    try {
      execFileSync(process.execPath, ['--check', join(shipped, file)], { stdio: 'pipe' })
    } catch (error) {
      fail(`lib/${file} does not parse: ${error.stderr?.toString().trim() ?? error.message}`)
    }
  }
}

const requestedTag = process.argv[2]?.replace(/^refs\/tags\//, '').replace(/^v/, '')
if (requestedTag !== undefined && requestedTag !== '' && requestedTag !== pkg.version) {
  fail(`tag "${requestedTag}" does not match package version "${pkg.version}"`)
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`release check: ${problem}\n`)
  process.exit(1)
}
process.stdout.write(`release check ok: ${pkg.name}@${pkg.version}\n`)

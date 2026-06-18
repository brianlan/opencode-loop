#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

function findProjectRoot(cwd) {
  let dir = resolve(cwd)
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".opencode")) || existsSync(join(dir, "opencode.json"))) {
      return dir
    }
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return null
}

function getOwnPluginPath() {
  try {
    const binDir = dirname(fileURLToPath(import.meta.url))
    const candidate = join(binDir, "..", "dist", "index.js")
    if (existsSync(candidate)) return candidate
  } catch {
    // ignore
  }
  return null
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0] ?? "help"

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`opencode-loop installer

Usage:
  bunx @brianlan/opencode-loop install   Install plugin into current project
  bunx @brianlan/opencode-loop help      Show this help

The install command creates .opencode/plugins/opencode-loop.js
so OpenCode can load the plugin automatically.
`)
    return
  }

  if (cmd === "install" || cmd === "init") {
    const root = findProjectRoot(process.cwd())
    if (!root) {
      console.error("Could not find an OpenCode project root (looking for .opencode/ or opencode.json).")
      console.error("Run this from inside your project.")
      process.exit(1)
    }

    const pluginsDir = join(root, ".opencode", "plugins")
    if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true })

    const dest = join(pluginsDir, "opencode-loop.js")

    const pluginPath = getOwnPluginPath()
    if (!pluginPath) {
      console.error("Could not find the bundled plugin in this package.")
      process.exit(1)
    }

    const source = readFileSync(pluginPath, "utf-8")
    writeFileSync(dest, source, "utf-8")
    console.log(`Installed opencode-loop plugin to:\n  ${dest}`)
    console.log(`Restart OpenCode to load the new plugin.`)
    return
  }

  console.error(`Unknown command: ${cmd}`)
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

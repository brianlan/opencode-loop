#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

function findProjectRoot(cwd: string): string | null {
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

function getOwnSrcPath(): string | null {
  try {
    // ESM: import.meta.url points to this file (bin/install.js)
    const binDir = dirname(new URL(import.meta.url).pathname)
    const candidate = join(binDir, "..", "src", "index.ts")
    if (existsSync(candidate)) return candidate
  } catch {
    // ignore
  }
  return null
}

async function fetchSrc(): Promise<string | null> {
  try {
    const res = await fetch("https://raw.githubusercontent.com/brianlan/opencode-loop/main/src/index.ts")
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0] ?? "help"

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`opencode-loop installer

Usage:
  bunx opencode-loop install         Install plugin into current project
  bunx opencode-loop help            Show this help

The install command creates .opencode/plugins/opencode-loop.ts
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

    const dest = join(pluginsDir, "opencode-loop.ts")

    let source: string | null = null
    const ownSrc = getOwnSrcPath()
    if (ownSrc) {
      try {
        source = readFileSync(ownSrc, "utf-8")
      } catch {
        // fall through
      }
    }
    if (!source) {
      source = await fetchSrc()
    }
    if (!source) {
      console.error("Could not find plugin source. Please install manually from:")
      console.error("  https://github.com/brianlan/opencode-loop")
      process.exit(1)
    }

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

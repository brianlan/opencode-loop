import { expect, test } from "bun:test"
import * as plugin from "../src/index"

test("plugin entry exports a V2 plugin definition", () => {
  expect(Object.keys(plugin)).toEqual(["default"])
  expect(plugin.default.id).toBe("opencode-loop")
  expect(typeof plugin.default.setup).toBe("function")
})

test("setup registers the cron tools and cleanup disposes", async () => {
  const tools: Array<{
    name: string
    execute: (input: unknown, context: unknown) => Promise<{ content: string }>
  }> = []
  const ctx = {
    session: {
      async switchAgent() {
        return {}
      },
      async prompt() {
        return {}
      },
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
    tool: {
      async transform(callback: (editor: unknown) => void) {
        callback({ add: (tool: (typeof tools)[number]) => tools.push(tool) })
        return { dispose: async () => {} }
      },
    },
  }

  const cleanup = await plugin.default.setup(ctx as never)

  expect(tools.map((tool) => tool.name)).toEqual(["cron_create", "cron_list", "cron_delete"])
  const listed = await tools[1]!.execute({}, { sessionID: "session-1", agent: "build" })
  expect(listed.content).toBe("No loops in this session.")
  await cleanup?.()
})

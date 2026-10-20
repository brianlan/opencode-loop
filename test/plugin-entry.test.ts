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
    input: { properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean }
    execute: (input: unknown, context: unknown) => Promise<{ content: string }>
  }> = []
  const calls: Array<[string, unknown]> = []
  const ctx = {
    session: {
      async wait() {},
      async switchAgent(input: unknown) {
        calls.push(["switchAgent", input])
        return {}
      },
      async prompt(input: unknown) {
        calls.push(["prompt", input])
        return {}
      },
      async compact(input: unknown) {
        calls.push(["compact", input])
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
  const list = tools.find((tool) => tool.name === "cron_list")!

  try {
    expect(tools.map((tool) => tool.name)).toEqual(["cron_create", "cron_compact_create", "cron_list", "cron_delete"])
    const create = tools.find((tool) => tool.name === "cron_create")!
    const compact = tools.find((tool) => tool.name === "cron_compact_create")!
    const remove = tools.find((tool) => tool.name === "cron_delete")!
    const context = { sessionID: "session-1", agent: "build" }

    expect((await list.execute({}, context)).content).toBe("No loops in this session.")
    for (const tool of [create, compact]) {
      expect(tool.input.properties.runImmediately).toEqual({ type: "boolean", default: false })
      expect(tool.input.required).not.toContain("runImmediately")
      expect(tool.input.additionalProperties).toBe(false)
    }
    expect(compact.input.required).toEqual(["name", "schedule"])
    expect(compact.input.properties).not.toHaveProperty("command")

    await create.execute({ name: "check", schedule: "46 * * * *", command: "Check status", runImmediately: true }, context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.map(([method]) => method)).toEqual(["switchAgent", "prompt"])

    const created = await compact.execute({ name: "hourly-compact", schedule: "46 * * * *", runImmediately: false }, context)
    expect(created.content).toContain("Action: Compact session")
    expect(calls).toHaveLength(2)
    expect((await list.execute({}, context)).content).toContain("hourly-compact")
    expect((await remove.execute({ name: "hourly-compact" }, context)).content).toContain("Deleted session loop")

    await compact.execute({ name: "compact-now", schedule: "46 * * * *", runImmediately: true }, context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls[2]).toEqual(["compact", { sessionID: "session-1", delivery: "queue" }])
    expect(calls).toHaveLength(3)
  } finally {
    await cleanup?.()
  }
  expect((await list.execute({}, { sessionID: "session-1" })).content).toBe("No loops in this session.")
})

import type { Plugin } from "@opencode/plugin"
import { LoopScheduler } from "./scheduler"

const CronPlugin: Plugin.Plugin = {
  id: "opencode-loop",
  async setup(ctx) {
    const scheduler = new LoopScheduler(ctx.session)
    const controller = new AbortController()

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.deleted") scheduler.deleteSession(event.data.sessionID)
      }
    })()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "cron_create",
        description:
          "Create a session-scoped recurring loop. `schedule` uses standard five-field cron syntax (minute hour day month weekday), evaluated in the OpenCode server's local timezone. `command` is sent only when the session is idle. Repeated triggers while busy are coalesced into one pending run per loop. `runImmediately` makes the loop due on creation but still waits for idle; defaults to false.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            schedule: { type: "string", minLength: 1 },
            command: { type: "string", minLength: 1 },
            runImmediately: { type: "boolean", default: false },
          },
          required: ["name", "schedule", "command"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as { name: string; schedule: string; command: string; runImmediately?: boolean }
          return {
            content: scheduler.create({
              sessionID: context.sessionID,
              name: args.name,
              schedule: args.schedule,
              action: { type: "prompt", command: args.command, agent: context.agent },
              runImmediately: args.runImmediately,
            }),
          }
        },
      })

      editor.add({
        name: "cron_compact_create",
        description:
          "Create a session-scoped recurring compaction loop. `schedule` uses standard five-field cron syntax (minute hour day month weekday), evaluated in the OpenCode server's local timezone. Requests compaction only when the session is idle, without sending a prompt or switching agents. Repeated triggers while busy are coalesced into one pending run per loop. `runImmediately` makes the loop due on creation but still waits for idle; defaults to false. An accepted request does not mean compaction has finished.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            schedule: { type: "string", minLength: 1 },
            runImmediately: { type: "boolean", default: false },
          },
          required: ["name", "schedule"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as { name: string; schedule: string; runImmediately?: boolean }
          return {
            content: scheduler.create({
              sessionID: context.sessionID,
              name: args.name,
              schedule: args.schedule,
              action: { type: "compact" },
              runImmediately: args.runImmediately,
            }),
          }
        },
      })

      editor.add({
        name: "cron_list",
        description:
          "List all recurring prompt and compaction loops in the current session, including next run, pending idle waits, and request status. A successful compaction request does not mean compaction has finished.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_input, context) {
          return { content: scheduler.list(context.sessionID) }
        },
      })

      editor.add({
        name: "cron_delete",
        description: "Delete a recurring loop in the current session by name.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
          },
          required: ["name"],
          additionalProperties: false,
        },
        async execute(input, context) {
          return { content: scheduler.delete(context.sessionID, (input as { name: string }).name) }
        },
      })
    })

    return () => {
      controller.abort()
      scheduler.dispose()
    }
  },
}

export default CronPlugin

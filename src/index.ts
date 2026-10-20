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
          "Create a session-scoped recurring loop. `schedule` uses standard five-field cron syntax (minute hour day month weekday), evaluated in the OpenCode server's local timezone. `command` is sent to the same session when the schedule triggers.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            schedule: { type: "string", minLength: 1 },
            command: { type: "string", minLength: 1 },
          },
          required: ["name", "schedule", "command"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as { name: string; schedule: string; command: string }
          return {
            content: scheduler.create({
              sessionID: context.sessionID,
              agent: context.agent,
              name: args.name,
              schedule: args.schedule,
              command: args.command,
            }),
          }
        },
      })

      editor.add({
        name: "cron_list",
        description: "List all recurring loops in the current session, including next run and delivery status.",
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

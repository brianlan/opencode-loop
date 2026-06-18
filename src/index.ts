import { type Plugin, tool } from "@opencode-ai/plugin"
import { LoopScheduler } from "./scheduler"

const CronPlugin: Plugin = async ({ client }) => {
  const scheduler = new LoopScheduler(client)

  return {
    dispose: async () => {
      scheduler.dispose()
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        scheduler.deleteSession(event.properties.info.id)
      }
    },

    tool: {
      cron_create: tool({
        description:
          "Create a session-scoped recurring loop. `schedule` uses standard five-field cron syntax (minute hour day month weekday), evaluated in the OpenCode server's local timezone. `command` is sent to the same session when the schedule triggers.",
        args: {
          name: tool.schema.string().trim().min(1).max(100),
          schedule: tool.schema.string().trim().min(1),
          command: tool.schema.string().trim().min(1),
        },
        async execute(args, ctx) {
          return scheduler.create({
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            name: args.name,
            schedule: args.schedule,
            command: args.command,
          })
        },
      }),

      cron_list: tool({
        description: "List all recurring loops in the current session, including next run and delivery status.",
        args: {},
        async execute(_args, ctx) {
          return scheduler.list(ctx.sessionID)
        },
      }),

      cron_delete: tool({
        description: "Delete a recurring loop in the current session by name.",
        args: {
          name: tool.schema.string().trim().min(1),
        },
        async execute(args, ctx) {
          return scheduler.delete(ctx.sessionID, args.name)
        },
      }),
    },
  }
}

export default CronPlugin

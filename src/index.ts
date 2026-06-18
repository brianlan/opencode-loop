import { type Plugin, tool } from "@opencode-ai/plugin"

interface CronJob {
  name: string
  schedule: string
  command: string
  timer: ReturnType<typeof setTimeout> | null
  nextRun: Date | null
}

const jobsBySession = new Map<string, Map<string, CronJob>>()

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>()
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) result.add(i)
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/")
      const step = parseNumber(stepStr, 1, max - min + 1, `step in "${part}"`)
      const start = range === "*" ? min : parseNumber(range, min, max, `start in "${part}"`)
      for (let i = start; i <= max; i += step) result.add(i)
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-")
      const start = parseNumber(startStr, min, max, `range start in "${part}"`)
      const end = parseNumber(endStr, min, max, `range end in "${part}"`)
      if (start > end) throw new Error(`Invalid descending cron range "${part}"`)
      for (let i = start; i <= end; i++) result.add(i)
    } else {
      result.add(parseNumber(part, min, max, `"${part}"`))
    }
  }
  return result
}

function parseNumber(value: string, min: number, max: number, label: string) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid cron value ${label}`)
  const number = Number(value)
  if (number < min || number > max) {
    throw new Error(`Cron value ${label} must be between ${min} and ${max}`)
  }
  return number
}

function getNextCronDate(schedule: string, from = new Date()): Date {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error("Schedule must have exactly 5 fields: minute hour day month weekday")
  const [minStr, hrStr, domStr, monStr, dowStr] = parts
  const mins = parseField(minStr, 0, 59)
  const hrs = parseField(hrStr, 0, 23)
  const doms = parseField(domStr, 1, 31)
  const mons = parseField(monStr, 1, 12)
  const dows = parseField(dowStr, 0, 6)

  const d = new Date(from)
  d.setMilliseconds(0)
  d.setSeconds(0)
  d.setMinutes(d.getMinutes() + 1)

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      mins.has(d.getMinutes()) &&
      hrs.has(d.getHours()) &&
      doms.has(d.getDate()) &&
      mons.has(d.getMonth() + 1) &&
      dows.has(d.getDay())
    ) {
      return new Date(d)
    }
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new Error("No next execution time found within 1 year")
}

function scheduleTick(
  client: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>,
  sessionID: string,
  job: CronJob,
) {
  if (job.timer) {
    clearTimeout(job.timer)
    job.timer = null
  }

  try {
    const next = getNextCronDate(job.schedule)
    job.nextRun = next
    const delay = next.getTime() - Date.now()

    job.timer = setTimeout(() => {
      client.session
        .prompt({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: `[Scheduled loop triggered] "${job.name}": ${job.command}`,
              },
            ],
          },
        })
        .catch(() => {})

      scheduleTick(client, sessionID, job)
    }, Math.max(0, delay))
  } catch {
    job.nextRun = null
  }
}

function getSessionJobs(sessionID: string): Map<string, CronJob> {
  if (!jobsBySession.has(sessionID)) {
    jobsBySession.set(sessionID, new Map())
  }
  return jobsBySession.get(sessionID)!
}

const CronPlugin: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        const sessionJobs = jobsBySession.get(sessionID)
        if (sessionJobs) {
          for (const job of sessionJobs.values()) {
            if (job.timer) clearTimeout(job.timer)
          }
          jobsBySession.delete(sessionID)
        }
      }
    },

    tool: {
      cron_create: tool({
        description:
          "Create a session-scoped recurring loop (cron job). It runs only while this OpenCode session / TUI is alive. `schedule` uses standard 5-field cron syntax (minute hour day month weekday). `command` is the instruction sent to the AI when the loop triggers. Wrap complex instructions in single quotes.",
        args: {
          name: tool.schema.string(),
          schedule: tool.schema.string(),
          command: tool.schema.string(),
        },
        async execute(args, ctx) {
          const sessionJobs = getSessionJobs(ctx.sessionID)
          if (sessionJobs.has(args.name)) {
            throw new Error(`Loop "${args.name}" already exists in this session. Use cron_delete first.`)
          }

          getNextCronDate(args.schedule)

          const job: CronJob = {
            name: args.name,
            schedule: args.schedule,
            command: args.command,
            timer: null,
            nextRun: null,
          }

          sessionJobs.set(args.name, job)
          scheduleTick(client, ctx.sessionID, job)

          const next = job.nextRun ? job.nextRun.toISOString() : "unknown"
          return `Created session loop "${args.name}".\nSchedule: ${args.schedule}\nCommand: ${args.command}\nNext run: ${next}`
        },
      }),

      cron_list: tool({
        description: "List all recurring loops in the current session.",
        args: {},
        async execute(_args, ctx) {
          const sessionJobs = getSessionJobs(ctx.sessionID)
          if (sessionJobs.size === 0) return "No loops in this session."
          return Array.from(sessionJobs.values())
            .map((j) => {
              const next = j.nextRun ? j.nextRun.toLocaleString() : "calculating..."
              return `- ${j.name}: "${j.schedule}" → ${j.command} (next: ${next})`
            })
            .join("\n")
        },
      }),

      cron_delete: tool({
        description: "Delete a recurring loop in the current session by name.",
        args: {
          name: tool.schema.string(),
        },
        async execute(args, ctx) {
          const sessionJobs = getSessionJobs(ctx.sessionID)
          const job = sessionJobs.get(args.name)
          if (!job) {
            throw new Error(`Loop "${args.name}" not found in this session.`)
          }
          if (job.timer) clearTimeout(job.timer)
          sessionJobs.delete(args.name)
          return `Deleted session loop "${args.name}".`
        },
      }),
    },
  }
}

export default CronPlugin

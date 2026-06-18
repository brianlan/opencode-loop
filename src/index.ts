import { type Plugin, tool } from "@opencode-ai/plugin"

const TAG_PREFIX = "@opencode-cron:"

function tagFor(name: string): string {
  return `# ${TAG_PREFIX}${name}`
}

async function readCrontab(): Promise<string> {
  try {
    const proc = Bun.spawn(["crontab", "-l"], { stdout: "pipe", stderr: "pipe" })
    const text = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) return ""
    return text
  } catch {
    return ""
  }
}

async function writeCrontab(content: string): Promise<void> {
  const proc = Bun.spawn(["crontab", "-"], { stdin: "pipe" })
  const writer = proc.stdin.getWriter()
  await writer.write(new TextEncoder().encode(content))
  await writer.close()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Failed to update crontab (exit code ${exitCode}).`)
  }
}

interface CronJob {
  name: string
  schedule: string
  command: string
}

function parseCrontab(content: string): CronJob[] {
  const jobs: CronJob[] = []
  const marker = `# ${TAG_PREFIX}`
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith("#")) continue
    const idx = line.lastIndexOf(marker)
    if (idx === -1) continue
    const suffix = line.slice(idx).trim()
    const match = suffix.match(/^# @opencode-cron:(.+)$/)
    if (!match) continue
    const name = match[1]
    const before = line.slice(0, idx).trim()
    const parts = before.split(/\s+/)
    if (parts.length < 6) continue
    const schedule = parts.slice(0, 5).join(" ")
    const command = parts.slice(5).join(" ")
    jobs.push({ name, schedule, command })
  }
  return jobs
}

function formatLine(job: CronJob): string {
  return `${job.schedule} ${job.command} ${tagFor(job.name)}`
}

const CronPlugin: Plugin = async () => {
  return {
    tool: {
      cron_create: tool({
        description:
          "Create a new system cron job. `schedule` uses standard 5-field cron syntax (minute hour day month weekday). `command` is a shell command executed by /bin/sh -c. Wrap complex commands in single quotes.",
        args: {
          name: tool.schema.string(),
          schedule: tool.schema.string(),
          command: tool.schema.string(),
        },
        async execute(args) {
          const crontab = await readCrontab()
          const jobs = parseCrontab(crontab)
          if (jobs.some((j) => j.name === args.name)) {
            throw new Error(`Cron job "${args.name}" already exists. Use cron_delete first or pick a different name.`)
          }

          const job: CronJob = {
            name: args.name,
            schedule: args.schedule,
            command: args.command,
          }

          const newLine = formatLine(job)
          const separator = crontab.endsWith("\n") || crontab.length === 0 ? "" : "\n"
          const newCrontab = crontab + separator + newLine + "\n"
          await writeCrontab(newCrontab)

          return `Created cron job "${args.name}".\nSchedule: ${args.schedule}\nCommand: ${args.command}`
        },
      }),

      cron_list: tool({
        description: "List all cron jobs managed by this plugin.",
        args: {},
        async execute() {
          const crontab = await readCrontab()
          const jobs = parseCrontab(crontab)
          if (jobs.length === 0) return "No managed cron jobs found."
          return jobs.map((j) => `- ${j.name}: "${j.schedule}" → ${j.command}`).join("\n")
        },
      }),

      cron_delete: tool({
        description: "Delete a managed cron job by name.",
        args: {
          name: tool.schema.string(),
        },
        async execute(args) {
          const crontab = await readCrontab()
          const lines = crontab.split("\n")
          const targetTag = tagFor(args.name)
          let found = false
          const filtered = lines.filter((rawLine) => {
            const line = rawLine.trimEnd()
            if (line.endsWith(targetTag)) {
              found = true
              return false
            }
            return true
          })

          if (!found) {
            throw new Error(`Cron job "${args.name}" not found.`)
          }

          const newCrontab = filtered.join("\n")
          await writeCrontab(newCrontab.endsWith("\n") ? newCrontab : newCrontab + "\n")
          return `Deleted cron job "${args.name}".`
        },
      }),
    },
  }
}

export default CronPlugin

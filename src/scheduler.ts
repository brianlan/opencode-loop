import { Cron } from "croner"

export const MAX_TIMER_DELAY = 2_147_000_000

type Timer = ReturnType<typeof setTimeout>

type PromptClient = {
  session: {
    promptAsync(input: {
      path: { id: string }
      body: {
        agent: string
        parts: Array<{ type: "text"; text: string }>
      }
    }): Promise<{ error?: unknown }>
  }
}

type Runtime = {
  now(): Date
  setTimer(callback: () => void, delay: number): Timer
  clearTimer(timer: Timer): void
}

type LoopJob = {
  name: string
  schedule: string
  command: string
  agent: string
  cron: Cron
  timer: Timer | null
  nextRun: Date
  lastAttempt: Date | null
  lastSuccess: Date | null
  lastError: string | null
  consecutiveFailures: number
  cancelled: boolean
}

export type CreateLoopInput = {
  sessionID: string
  agent: string
  name: string
  schedule: string
  command: string
}

const defaultRuntime: Runtime = {
  now: () => new Date(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
}

export class LoopScheduler {
  private readonly jobsBySession = new Map<string, Map<string, LoopJob>>()

  constructor(
    private readonly client: PromptClient,
    private readonly runtime: Runtime = defaultRuntime,
  ) {}

  create(input: CreateLoopInput) {
    const jobs = this.jobsBySession.get(input.sessionID) ?? new Map<string, LoopJob>()
    if (jobs.has(input.name)) {
      throw new Error(`Loop "${input.name}" already exists in this session. Use cron_delete first.`)
    }

    const cron = createCron(input.schedule)
    const nextRun = cron.nextRun(this.runtime.now())
    if (!nextRun) throw new Error(`Schedule "${input.schedule}" has no future execution time.`)

    const job: LoopJob = {
      name: input.name,
      schedule: input.schedule,
      command: input.command,
      agent: input.agent,
      cron,
      timer: null,
      nextRun,
      lastAttempt: null,
      lastSuccess: null,
      lastError: null,
      consecutiveFailures: 0,
      cancelled: false,
    }

    jobs.set(input.name, job)
    this.jobsBySession.set(input.sessionID, jobs)
    this.arm(input.sessionID, job)

    return [
      `Created session loop "${input.name}".`,
      `Schedule: ${input.schedule}`,
      `Command: ${input.command}`,
      `Agent: ${input.agent}`,
      `Next run: ${nextRun.toISOString()}`,
    ].join("\n")
  }

  list(sessionID: string) {
    const jobs = this.jobsBySession.get(sessionID)
    if (!jobs?.size) return "No loops in this session."

    return Array.from(jobs.values())
      .map((job) => {
        const status = job.lastError
          ? `last error: ${job.lastError}; consecutive failures: ${job.consecutiveFailures}`
          : job.lastSuccess
            ? `last delivered: ${job.lastSuccess.toISOString()}`
            : "not triggered yet"
        return [
          `- ${job.name}: "${job.schedule}" → ${job.command}`,
          `  agent: ${job.agent}; next: ${job.nextRun.toISOString()}; ${status}`,
        ].join("\n")
      })
      .join("\n")
  }

  delete(sessionID: string, name: string) {
    const jobs = this.jobsBySession.get(sessionID)
    const job = jobs?.get(name)
    if (!jobs || !job) throw new Error(`Loop "${name}" not found in this session.`)

    this.cancel(job)
    jobs.delete(name)
    if (jobs.size === 0) this.jobsBySession.delete(sessionID)
    return `Deleted session loop "${name}".`
  }

  deleteSession(sessionID: string) {
    const jobs = this.jobsBySession.get(sessionID)
    if (!jobs) return
    for (const job of jobs.values()) this.cancel(job)
    this.jobsBySession.delete(sessionID)
  }

  dispose() {
    for (const jobs of this.jobsBySession.values()) {
      for (const job of jobs.values()) this.cancel(job)
    }
    this.jobsBySession.clear()
  }

  private cancel(job: LoopJob) {
    job.cancelled = true
    if (job.timer) this.runtime.clearTimer(job.timer)
    job.timer = null
  }

  private arm(sessionID: string, job: LoopJob) {
    if (job.cancelled) return
    if (job.timer) this.runtime.clearTimer(job.timer)

    const delay = Math.max(0, job.nextRun.getTime() - this.runtime.now().getTime())
    job.timer = this.runtime.setTimer(
      () => {
        job.timer = null
        this.wake(sessionID, job)
      },
      Math.min(delay, MAX_TIMER_DELAY),
    )
    ;(job.timer as unknown as { unref?: () => void })?.unref?.()
  }

  private wake(sessionID: string, job: LoopJob) {
    if (job.cancelled) return

    const now = this.runtime.now()
    if (now.getTime() < job.nextRun.getTime()) {
      this.arm(sessionID, job)
      return
    }

    const scheduledRun = job.nextRun
    const nextRun = job.cron.nextRun(now)
    if (!nextRun) {
      job.lastError = "Schedule has no future execution time."
      job.consecutiveFailures++
      this.cancel(job)
      return
    }

    job.nextRun = nextRun
    this.arm(sessionID, job)
    void this.deliver(sessionID, job, scheduledRun)
  }

  private async deliver(sessionID: string, job: LoopJob, scheduledRun: Date) {
    if (job.cancelled) return
    job.lastAttempt = this.runtime.now()

    try {
      const result = await this.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: job.agent,
          parts: [
            {
              type: "text",
              text: `[Scheduled loop triggered at ${scheduledRun.toISOString()}] "${job.name}": ${job.command}`,
            },
          ],
        },
      })
      if (result.error) throw new Error(formatError(result.error))
      job.lastSuccess = this.runtime.now()
      job.lastError = null
      job.consecutiveFailures = 0
    } catch (error) {
      job.lastError = formatError(error)
      job.consecutiveFailures++
    }
  }
}

function createCron(schedule: string) {
  try {
    return new Cron(schedule, {
      mode: "5-part",
      paused: true,
      domAndDow: false,
    })
  } catch (error) {
    throw new Error(`Invalid cron schedule "${schedule}": ${formatError(error)}`)
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

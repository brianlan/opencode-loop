import { Cron } from "croner"

export const MAX_TIMER_DELAY = 2_147_000_000

type Timer = ReturnType<typeof setTimeout>

type SessionClient = {
  wait(input: { sessionID: string }, options: { signal: AbortSignal }): Promise<void>
  switchAgent(input: { sessionID: string; agent: string }): Promise<unknown>
  prompt(input: {
    sessionID: string
    text: string
    delivery: "queue"
  }): Promise<unknown>
  compact(input: { sessionID: string; delivery: "queue" }): Promise<unknown>
}

type Runtime = {
  now(): Date
  setTimer(callback: () => void, delay: number): Timer
  clearTimer(timer: Timer): void
}

type LoopAction = { type: "prompt"; command: string; agent: string } | { type: "compact" }

type LoopJob = {
  name: string
  schedule: string
  action: LoopAction
  cron: Cron
  timer: Timer | null
  nextRun: Date
  lastAttempt: Date | null
  lastSuccess: Date | null
  lastError: string | null
  consecutiveFailures: number
  cancelled: boolean
}

type LoopSession = {
  jobs: Map<string, LoopJob>
  pending: Map<LoopJob, Date>
  controller: AbortController
  draining: boolean
}

export type CreateLoopInput = {
  sessionID: string
  name: string
  schedule: string
  action: LoopAction
  runImmediately?: boolean
}

const defaultRuntime: Runtime = {
  now: () => new Date(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
}

export class LoopScheduler {
  private readonly sessions = new Map<string, LoopSession>()

  constructor(
    private readonly client: SessionClient,
    private readonly runtime: Runtime = defaultRuntime,
  ) {}

  create(input: CreateLoopInput) {
    const session = this.sessions.get(input.sessionID) ?? {
      jobs: new Map<string, LoopJob>(),
      pending: new Map<LoopJob, Date>(),
      controller: new AbortController(),
      draining: false,
    }
    if (session.jobs.has(input.name)) {
      throw new Error(`Loop "${input.name}" already exists in this session. Use cron_delete first.`)
    }

    const cron = createCron(input.schedule)
    const now = this.runtime.now()
    const nextRun = cron.nextRun(now)
    if (!nextRun) throw new Error(`Schedule "${input.schedule}" has no future execution time.`)

    const job: LoopJob = {
      name: input.name,
      schedule: input.schedule,
      action: { ...input.action },
      cron,
      timer: null,
      nextRun,
      lastAttempt: null,
      lastSuccess: null,
      lastError: null,
      consecutiveFailures: 0,
      cancelled: false,
    }

    session.jobs.set(input.name, job)
    this.sessions.set(input.sessionID, session)
    this.arm(input.sessionID, job)
    if (input.runImmediately) this.request(input.sessionID, job, now)

    return [
      `Created session loop "${input.name}".`,
      `Schedule: ${input.schedule}`,
      ...(job.action.type === "prompt"
        ? [`Command: ${job.action.command}`, `Agent: ${job.action.agent}`]
        : ["Action: Compact session"]),
      ...(input.runImmediately ? ["Immediate run requested."] : []),
      `Next run: ${nextRun.toISOString()}`,
    ].join("\n")
  }

  list(sessionID: string) {
    const session = this.sessions.get(sessionID)
    if (!session?.jobs.size) return "No loops in this session."

    return Array.from(session.jobs.values())
      .map((job) => {
        const pending = session.pending.get(job)
        const waiting = pending ? `waiting for session idle since ${pending.toISOString()}; ` : ""
        const status = job.lastError
          ? `last error: ${job.lastError}; consecutive failures: ${job.consecutiveFailures}`
          : job.lastSuccess
            ? `${job.action.type === "compact" ? "last compaction requested" : "last delivered"}: ${job.lastSuccess.toISOString()}`
            : "not triggered yet"
        return [
          `- ${job.name}: "${job.schedule}" → ${job.action.type === "prompt" ? job.action.command : "Compact session"}`,
          `  ${job.action.type === "prompt" ? `agent: ${job.action.agent}; ` : ""}next: ${job.nextRun.toISOString()}; ${waiting}${status}`,
        ].join("\n")
      })
      .join("\n")
  }

  delete(sessionID: string, name: string) {
    const session = this.sessions.get(sessionID)
    const job = session?.jobs.get(name)
    if (!session || !job) throw new Error(`Loop "${name}" not found in this session.`)

    this.cancel(job)
    session.pending.delete(job)
    session.jobs.delete(name)
    if (session.jobs.size === 0) this.deleteSession(sessionID)
    return `Deleted session loop "${name}".`
  }

  deleteSession(sessionID: string) {
    const session = this.sessions.get(sessionID)
    if (!session) return
    for (const job of session.jobs.values()) this.cancel(job)
    session.pending.clear()
    session.controller.abort()
    this.sessions.delete(sessionID)
  }

  dispose() {
    for (const sessionID of this.sessions.keys()) this.deleteSession(sessionID)
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
    this.request(sessionID, job, scheduledRun)
  }

  private request(sessionID: string, job: LoopJob, scheduledRun: Date) {
    if (job.cancelled) return
    const session = this.sessions.get(sessionID)!
    if (!session.pending.has(job)) session.pending.set(job, scheduledRun)
    void this.drain(sessionID, session)
  }

  private async drain(sessionID: string, session: LoopSession) {
    if (session.draining) return
    session.draining = true
    try {
      while (session.pending.size && !session.controller.signal.aborted) {
        const [job, scheduledRun] = session.pending.entries().next().value!
        await this.deliver(sessionID, session, job, scheduledRun)
      }
    } finally {
      session.draining = false
    }
  }

  private async deliver(sessionID: string, session: LoopSession, job: LoopJob, scheduledRun: Date) {
    if (job.cancelled) return
    job.lastAttempt = this.runtime.now()

    try {
      const options = { signal: session.controller.signal }
      await this.client.wait({ sessionID }, options)
      if (job.cancelled || options.signal.aborted) return
      if (job.action.type === "prompt") {
        await this.client.switchAgent({ sessionID, agent: job.action.agent })
        if (job.cancelled || options.signal.aborted) return
        // User work may start while the agent switch is in flight.
        await this.client.wait({ sessionID }, options)
        if (job.cancelled || options.signal.aborted) return
      }
      session.pending.delete(job)
      if (job.action.type === "compact") {
        await this.client.compact({ sessionID, delivery: "queue" })
      } else {
        await this.client.prompt({
          sessionID,
          text: `[Scheduled loop triggered at ${scheduledRun.toISOString()}] "${job.name}": ${job.action.command}`,
          delivery: "queue",
        })
      }
      job.lastSuccess = this.runtime.now()
      job.lastError = null
      job.consecutiveFailures = 0
    } catch (error) {
      if (job.cancelled || session.controller.signal.aborted) return
      job.lastError = formatError(error)
      job.consecutiveFailures++
    } finally {
      // A newer trigger may have arrived while the previous request was being submitted.
      if (session.pending.get(job) === scheduledRun) session.pending.delete(job)
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

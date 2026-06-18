import { describe, expect, test } from "bun:test"
import { LoopScheduler, MAX_TIMER_DELAY } from "../src/scheduler"

class FakeRuntime {
  current: Date
  timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = []

  constructor(now: string) {
    this.current = new Date(now)
  }

  now = () => new Date(this.current)

  setTimer = (callback: () => void, delay: number) => {
    const timer = { callback, delay, cleared: false, unref() {} }
    this.timers.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  }

  clearTimer = (timer: ReturnType<typeof setTimeout>) => {
    ;(timer as unknown as { cleared: boolean }).cleared = true
  }

  nextTimer() {
    const timer = this.timers.find((item) => !item.cleared)
    if (!timer) throw new Error("No active timer")
    timer.cleared = true
    return timer
  }
}

function client() {
  const calls: unknown[] = []
  return {
    calls,
    value: {
      session: {
        async promptAsync(input: unknown) {
          calls.push(input)
          return {}
        },
      },
    },
  }
}

describe("LoopScheduler", () => {
  test("creates, lists, triggers, and deletes a one-minute loop", async () => {
    const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
    const prompt = client()
    const scheduler = new LoopScheduler(prompt.value, runtime)

    const created = scheduler.create({
      sessionID: "session-1",
      agent: "build",
      name: "echo",
      schedule: "* * * * *",
      command: "Echo LOOP_OK",
    })

    expect(created).toContain("2026-06-18T12:01:00.000Z")
    expect(runtime.nextTimer().delay).toBe(30_000)

    runtime.current = new Date("2026-06-18T12:01:00.000Z")
    runtime.timers.at(-1)!.cleared = false
    runtime.nextTimer().callback()
    await Promise.resolve()

    expect(prompt.calls).toEqual([
      {
        path: { id: "session-1" },
        body: {
          agent: "build",
          parts: [
            {
              type: "text",
              text: '[Scheduled loop triggered at 2026-06-18T12:01:00.000Z] "echo": Echo LOOP_OK',
            },
          ],
        },
      },
    ])
    expect(scheduler.list("session-1")).toContain("last delivered: 2026-06-18T12:01:00.000Z")
    expect(scheduler.delete("session-1", "echo")).toBe('Deleted session loop "echo".')
    expect(scheduler.list("session-1")).toBe("No loops in this session.")
  })

  test("chunks delays that exceed the runtime timeout limit", () => {
    const runtime = new FakeRuntime("2026-01-01T00:00:00.000Z")
    const prompt = client()
    const scheduler = new LoopScheduler(prompt.value, runtime)

    scheduler.create({
      sessionID: "session-1",
      agent: "build",
      name: "monthly",
      schedule: "0 0 1 * *",
      command: "Monthly task",
    })

    const first = runtime.nextTimer()
    expect(first.delay).toBe(MAX_TIMER_DELAY)
    runtime.current = new Date(runtime.current.getTime() + MAX_TIMER_DELAY)
    first.callback()

    const second = runtime.nextTimer()
    expect(second.delay).toBeGreaterThan(0)
    expect(second.delay).toBeLessThan(MAX_TIMER_DELAY)
    expect(prompt.calls).toHaveLength(0)
  })

  test("uses standard cron OR semantics and accepts Sunday 7", () => {
    const runtime = new FakeRuntime("2026-06-02T00:00:00.000Z")
    const prompt = client()
    const scheduler = new LoopScheduler(prompt.value, runtime)

    const result = scheduler.create({
      sessionID: "session-1",
      agent: "build",
      name: "standard",
      schedule: "0 0 1 * MON",
      command: "Standard cron",
    })
    expect(result).toContain("2026-06-08T00:00:00.000Z")

    const sunday = scheduler.create({
      sessionID: "session-1",
      agent: "build",
      name: "sunday",
      schedule: "0 0 * * 7",
      command: "Sunday task",
    })
    expect(sunday).toContain("2026-06-07T00:00:00.000Z")
  })

  test("supports range steps and leap-day schedules beyond one year", () => {
    const runtime = new FakeRuntime("2025-03-01T00:00:00.000Z")
    const scheduler = new LoopScheduler(client().value, runtime)

    const leapDay = scheduler.create({
      sessionID: "session-1",
      agent: "build",
      name: "leap-day",
      schedule: "0 0 29 2 *",
      command: "Leap day task",
    })
    expect(leapDay).toContain("2028-02-29T00:00:00.000Z")

    const rangeStep = scheduler.create({
      sessionID: "session-1",
      agent: "build",
      name: "range-step",
      schedule: "1-10/2 * * * *",
      command: "Range step task",
    })
    expect(rangeStep).toContain("2025-03-01T00:01:00.000Z")
  })

  test("reports delivery failures and preserves the creating agent", async () => {
    const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
    const calls: unknown[] = []
    const scheduler = new LoopScheduler(
      {
        session: {
          async promptAsync(input) {
            calls.push(input)
            return { error: { message: "unavailable" } }
          },
        },
      },
      runtime,
    )

    scheduler.create({
      sessionID: "session-1",
      agent: "review",
      name: "failure",
      schedule: "* * * * *",
      command: "Try task",
    })
    runtime.current = new Date("2026-06-18T12:01:00.000Z")
    runtime.nextTimer().callback()
    await Promise.resolve()

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ body: { agent: "review" } })
    expect(scheduler.list("session-1")).toContain("consecutive failures: 1")
  })

  test("clears timers on session deletion and plugin disposal", () => {
    const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
    const scheduler = new LoopScheduler(client().value, runtime)

    scheduler.create({
      sessionID: "session-1",
      agent: "build",
      name: "one",
      schedule: "* * * * *",
      command: "One",
    })
    scheduler.create({
      sessionID: "session-2",
      agent: "build",
      name: "two",
      schedule: "* * * * *",
      command: "Two",
    })

    scheduler.deleteSession("session-1")
    expect(scheduler.list("session-1")).toBe("No loops in this session.")
    expect(runtime.timers[0].cleared).toBe(true)

    scheduler.dispose()
    expect(scheduler.list("session-2")).toBe("No loops in this session.")
    expect(runtime.timers[1].cleared).toBe(true)
  })

  test("rejects invalid cron expressions", () => {
    const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
    const scheduler = new LoopScheduler(client().value, runtime)

    expect(() =>
      scheduler.create({
        sessionID: "session-1",
        agent: "build",
        name: "bad",
        schedule: "*/0 * * * *",
        command: "Bad",
      }),
    ).toThrow("Invalid cron schedule")
  })
})

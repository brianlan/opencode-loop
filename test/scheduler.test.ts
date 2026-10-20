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
  const calls: Array<[string, unknown]> = []
  const waitSignals: AbortSignal[] = []
  const idleBySession = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  const busy = (sessionID: string) => {
    if (!idleBySession.has(sessionID)) idleBySession.set(sessionID, Promise.withResolvers<void>())
  }
  return {
    calls,
    waitSignals,
    busy,
    idle(sessionID: string) {
      const pending = idleBySession.get(sessionID)
      idleBySession.delete(sessionID)
      pending?.resolve()
    },
    value: {
      async wait(input: { sessionID: string }, { signal }: { signal: AbortSignal }) {
        waitSignals.push(signal)
        signal.throwIfAborted()
        const idle = idleBySession.get(input.sessionID)
        if (!idle) return
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener("abort", abort, { once: true })
          void idle.promise.then(() => {
            signal.removeEventListener("abort", abort)
            resolve()
          })
        })
      },
      async switchAgent(input: unknown) {
        calls.push(["switchAgent", input])
        return {}
      },
      async prompt(input: { sessionID: string }) {
        calls.push(["prompt", input])
        busy(input.sessionID)
        return {}
      },
      async compact(input: { sessionID: string }) {
        calls.push(["compact", input])
        busy(input.sessionID)
        return {}
      },
    },
  }
}

describe("LoopScheduler", () => {
  test.each([undefined, false, true])("prompt loop lifecycle (runImmediately=%s)", async (runImmediately) => {
    const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
    const prompt = client()
    const scheduler = new LoopScheduler(prompt.value, runtime)

    const created = scheduler.create({
      sessionID: "session-1",
      name: "echo",
      schedule: "* * * * *",
      action: { type: "prompt", agent: "build", command: "Echo LOOP_OK" },
      runImmediately,
    })

    expect(created).toContain("2026-06-18T12:01:00.000Z")
    expect(runtime.nextTimer().delay).toBe(30_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(prompt.calls).toHaveLength(runImmediately ? 2 : 0)
    if (runImmediately) {
      expect(prompt.calls[1]).toEqual([
        "prompt",
        {
          sessionID: "session-1",
          text: '[Scheduled loop triggered at 2026-06-18T12:00:30.000Z] "echo": Echo LOOP_OK',
          delivery: "queue",
        },
      ])
    }
    prompt.calls.length = 0
    prompt.idle("session-1")

    runtime.current = new Date("2026-06-18T12:01:00.000Z")
    runtime.timers.at(-1)!.cleared = false
    runtime.nextTimer().callback()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(prompt.calls).toEqual([
      ["switchAgent", { sessionID: "session-1", agent: "build" }],
      [
        "prompt",
        {
          sessionID: "session-1",
          text: '[Scheduled loop triggered at 2026-06-18T12:01:00.000Z] "echo": Echo LOOP_OK',
          delivery: "queue",
        },
      ],
    ])
    expect(scheduler.list("session-1")).toContain("last delivered: 2026-06-18T12:01:00.000Z")
    expect(scheduler.delete("session-1", "echo")).toBe('Deleted session loop "echo".')
    expect(scheduler.list("session-1")).toBe("No loops in this session.")
  })

  test.each([undefined, false, true])("compaction loop lifecycle (runImmediately=%s)", async (runImmediately) => {
    const runtime = new FakeRuntime("2026-06-18T12:45:30.000Z")
    const session = client()
    const scheduler = new LoopScheduler(session.value, runtime)

    const created = scheduler.create({
      sessionID: "session-1",
      name: "hourly-compact",
      schedule: "46 * * * *",
      action: { type: "compact" },
      runImmediately,
    })

    expect(created).toContain("Action: Compact session")
    expect(created).toContain("2026-06-18T12:46:00.000Z")
    expect(runtime.timers[0]!.delay).toBe(30_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session.calls).toEqual(runImmediately ? [["compact", { sessionID: "session-1", delivery: "queue" }]] : [])
    expect(scheduler.list("session-1")).toContain(runImmediately ? "last compaction requested" : "not triggered yet")
    expect(scheduler.list("session-1")).not.toContain("agent:")
    session.calls.length = 0
    session.idle("session-1")

    runtime.current = new Date("2026-06-18T12:46:00.000Z")
    runtime.nextTimer().callback()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(session.calls).toEqual([["compact", { sessionID: "session-1", delivery: "queue" }]])
    expect(scheduler.list("session-1")).toContain("last compaction requested: 2026-06-18T12:46:00.000Z")
    expect(scheduler.list("session-1")).toContain("next: 2026-06-18T13:46:00.000Z")
    expect(scheduler.list("session-1")).not.toContain("last delivered")

    const pending = runtime.timers.at(-1)!
    expect(scheduler.delete("session-1", "hourly-compact")).toBe('Deleted session loop "hourly-compact".')
    expect(scheduler.list("session-1")).toBe("No loops in this session.")
    expect(pending.cleared).toBe(true)
    pending.callback()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session.calls).toHaveLength(1)
  })

  test("chunks delays that exceed the runtime timeout limit", () => {
    const runtime = new FakeRuntime("2026-01-01T00:00:00.000Z")
    const prompt = client()
    const scheduler = new LoopScheduler(prompt.value, runtime)

    scheduler.create({
      sessionID: "session-1",
      name: "monthly",
      schedule: "0 0 1 * *",
      action: { type: "prompt", agent: "build", command: "Monthly task" },
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
      name: "standard",
      schedule: "0 0 1 * MON",
      action: { type: "prompt", agent: "build", command: "Standard cron" },
    })
    expect(result).toContain("2026-06-08T00:00:00.000Z")

    const sunday = scheduler.create({
      sessionID: "session-1",
      name: "sunday",
      schedule: "0 0 * * 7",
      action: { type: "prompt", agent: "build", command: "Sunday task" },
    })
    expect(sunday).toContain("2026-06-07T00:00:00.000Z")
  })

  test("supports range steps and leap-day schedules beyond one year", () => {
    const runtime = new FakeRuntime("2025-03-01T00:00:00.000Z")
    const scheduler = new LoopScheduler(client().value, runtime)

    const leapDay = scheduler.create({
      sessionID: "session-1",
      name: "leap-day",
      schedule: "0 0 29 2 *",
      action: { type: "prompt", agent: "build", command: "Leap day task" },
    })
    expect(leapDay).toContain("2028-02-29T00:00:00.000Z")

    const rangeStep = scheduler.create({
      sessionID: "session-1",
      name: "range-step",
      schedule: "1-10/2 * * * *",
      action: { type: "prompt", agent: "build", command: "Range step task" },
    })
    expect(rangeStep).toContain("2025-03-01T00:01:00.000Z")
  })

  test("reports delivery failures and preserves the creating agent", async () => {
    const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
    const calls: Array<[string, unknown]> = []
    const scheduler = new LoopScheduler(
      {
        async wait() {},
        async switchAgent(input: unknown) {
          calls.push(["switchAgent", input])
          return {}
        },
        async prompt(input: unknown) {
          calls.push(["prompt", input])
          throw new Error("unavailable")
        },
        async compact() {
          return {}
        },
      },
      runtime,
    )

    scheduler.create({
      sessionID: "session-1",
      name: "failure",
      schedule: "* * * * *",
      action: { type: "prompt", agent: "review", command: "Try task" },
    })
    runtime.current = new Date("2026-06-18T12:01:00.000Z")
    runtime.nextTimer().callback()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(["switchAgent", { sessionID: "session-1", agent: "review" }])
    expect(scheduler.list("session-1")).toContain("last error: unavailable")
    expect(scheduler.list("session-1")).toContain("consecutive failures: 1")
  })

  test("reports an immediate compaction failure and recovers on the next scheduled run", async () => {
    const runtime = new FakeRuntime("2026-06-18T12:45:30.000Z")
    const session = client()
    const compact = session.value.compact
    session.value.compact = async (input: unknown) => {
      session.calls.push(["compact", input])
      throw new Error("compaction unavailable")
    }
    const scheduler = new LoopScheduler(session.value, runtime)

    scheduler.create({
      sessionID: "session-1",
      name: "hourly-compact",
      schedule: "46 * * * *",
      action: { type: "compact" },
      runImmediately: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(scheduler.list("session-1")).toContain("last error: compaction unavailable; consecutive failures: 1")
    expect(scheduler.list("session-1")).not.toContain("last compaction requested")
    expect(runtime.timers[0]!.cleared).toBe(false)

    session.value.compact = compact
    runtime.current = new Date("2026-06-18T12:46:00.000Z")
    runtime.nextTimer().callback()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(session.calls).toEqual([
      ["compact", { sessionID: "session-1", delivery: "queue" }],
      ["compact", { sessionID: "session-1", delivery: "queue" }],
    ])
    expect(scheduler.list("session-1")).toContain("last compaction requested: 2026-06-18T12:46:00.000Z")
    expect(scheduler.list("session-1")).not.toContain("last error")
    scheduler.dispose()
  })

  test("shares names across loop kinds but isolates sessions", () => {
    const runtime = new FakeRuntime("2026-06-18T12:45:30.000Z")
    const session = client()
    const scheduler = new LoopScheduler(session.value, runtime)

    scheduler.create({
      sessionID: "session-1",
      name: "shared",
      schedule: "46 * * * *",
      action: { type: "prompt", agent: "build", command: "Check status" },
    })
    expect(() =>
      scheduler.create({
        sessionID: "session-1",
        name: "shared",
        schedule: "46 * * * *",
        action: { type: "compact" },
        runImmediately: true,
      }),
    ).toThrow("already exists in this session")
    scheduler.create({
      sessionID: "session-2",
      name: "shared",
      schedule: "46 * * * *",
      action: { type: "compact" },
    })

    expect(scheduler.list("session-1")).toContain("Check status")
    expect(scheduler.list("session-2")).toContain("Compact session")
    expect(runtime.timers).toHaveLength(2)
    expect(session.calls).toHaveLength(0)
    scheduler.dispose()
  })

  test("does not send an immediate prompt after deletion during agent switching", async () => {
    const runtime = new FakeRuntime("2026-06-18T12:45:30.000Z")
    const session = client()
    let switched!: () => void
    session.value.switchAgent = async (input: unknown) => {
      session.calls.push(["switchAgent", input])
      await new Promise<void>((resolve) => {
        switched = resolve
      })
      return {}
    }
    const scheduler = new LoopScheduler(session.value, runtime)

    scheduler.create({
      sessionID: "session-1",
      name: "immediate",
      schedule: "46 * * * *",
      action: { type: "prompt", agent: "build", command: "Check status" },
      runImmediately: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    scheduler.delete("session-1", "immediate")
    switched()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(session.calls).toEqual([["switchAgent", { sessionID: "session-1", agent: "build" }]])
    expect(runtime.timers[0]!.cleared).toBe(true)
  })

  test("clears timers on session deletion and plugin disposal", () => {
    const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
    const session = client()
    const scheduler = new LoopScheduler(session.value, runtime)

    scheduler.create({
      sessionID: "session-1",
      name: "one",
      schedule: "* * * * *",
      action: { type: "prompt", agent: "build", command: "One" },
    })
    scheduler.create({
      sessionID: "session-1",
      name: "compact",
      schedule: "* * * * *",
      action: { type: "compact" },
    })
    scheduler.create({
      sessionID: "session-2",
      name: "two",
      schedule: "* * * * *",
      action: { type: "compact" },
    })

    scheduler.deleteSession("session-1")
    expect(scheduler.list("session-1")).toBe("No loops in this session.")
    expect(runtime.timers[0].cleared).toBe(true)
    expect(runtime.timers[1].cleared).toBe(true)
    expect(runtime.timers[2].cleared).toBe(false)

    scheduler.dispose()
    expect(scheduler.list("session-2")).toBe("No loops in this session.")
    expect(runtime.timers[2].cleared).toBe(true)
    for (const timer of runtime.timers) timer.callback()
    expect(session.calls).toHaveLength(0)
  })

  test.each(["prompt", "compact"] as const)("rejects invalid %s schedules before an immediate run", (type) => {
    const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
    const session = client()
    const scheduler = new LoopScheduler(session.value, runtime)

    expect(() =>
      scheduler.create({
        sessionID: "session-1",
        name: "bad",
        schedule: "*/0 * * * *",
        action: type === "prompt" ? { type, agent: "build", command: "Bad" } : { type },
        runImmediately: true,
      }),
    ).toThrow("Invalid cron schedule")
    expect(session.calls).toHaveLength(0)
    expect(runtime.timers).toHaveLength(0)
    expect(scheduler.list("session-1")).toBe("No loops in this session.")
  })

  describe("idle delivery", () => {
    test.each([
      ["prompt", false],
      ["prompt", true],
      ["compact", false],
      ["compact", true],
    ] as const)("coalesces busy %s triggers (runImmediately=%s)", async (type, runImmediately) => {
      const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
      const session = client()
      session.busy("session-1")
      const scheduler = new LoopScheduler(session.value, runtime)
      scheduler.create({
        sessionID: "session-1",
        name: "loop",
        schedule: "* * * * *",
        action: type === "prompt" ? { type, agent: "build", command: "Check status" } : { type },
        runImmediately,
      })

      for (const minute of [1, 2, 3]) {
        runtime.current = new Date(`2026-06-18T12:0${minute}:00.000Z`)
        runtime.nextTimer().callback()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(session.calls).toEqual([])
      expect(session.waitSignals).toHaveLength(1)
      const firstTrigger = runImmediately ? "2026-06-18T12:00:30.000Z" : "2026-06-18T12:01:00.000Z"
      expect(scheduler.list("session-1")).toContain(`waiting for session idle since ${firstTrigger}`)

      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls.map(([method]) => method)).toEqual(type === "prompt" ? ["switchAgent", "prompt"] : ["compact"])
      expect(scheduler.list("session-1")).not.toContain("waiting for session idle")

      for (const minute of [4, 5]) {
        runtime.current = new Date(`2026-06-18T12:0${minute}:00.000Z`)
        runtime.nextTimer().callback()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(session.calls.filter(([method]) => method === type)).toHaveLength(1)
      expect(scheduler.list("session-1")).toContain("waiting for session idle since 2026-06-18T12:04:00.000Z")

      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls.filter(([method]) => method === type)).toHaveLength(2)
      expect(scheduler.list("session-1")).toContain("next: 2026-06-18T12:06:00.000Z")
      scheduler.dispose()
    })

    test("serializes different loops in first-triggered order without starving older pending work", async () => {
      const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
      const session = client()
      session.busy("session-1")
      const scheduler = new LoopScheduler(session.value, runtime)
      for (const name of ["first", "second", "third"]) {
        scheduler.create({
          sessionID: "session-1",
          name,
          schedule: "* * * * *",
          action: name === "second" ? { type: "compact" } : { type: "prompt", agent: "build", command: name },
          runImmediately: true,
        })
      }
      expect(session.calls).toEqual([])

      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls.map(([method]) => method)).toEqual(["switchAgent", "prompt"])
      expect(session.calls[1]).toEqual(["prompt", expect.objectContaining({ text: expect.stringContaining('"first": first') })])

      runtime.current = new Date("2026-06-18T12:01:00.000Z")
      runtime.nextTimer().callback()
      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls.map(([method]) => method)).toEqual(["switchAgent", "prompt", "compact"])

      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls.map(([method]) => method)).toEqual(["switchAgent", "prompt", "compact", "switchAgent", "prompt"])
      expect(session.calls[4]).toEqual(["prompt", expect.objectContaining({ text: expect.stringContaining('"third": third') })])

      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls[6]).toEqual(["prompt", expect.objectContaining({ text: expect.stringContaining('"first": first') })])
      scheduler.dispose()
    })

    test.each(["delete", "deleteSession", "dispose"] as const)("%s discards pending runs and aborts idle waits", async (operation) => {
      const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
      const session = client()
      session.busy("session-1")
      const scheduler = new LoopScheduler(session.value, runtime)
      for (const type of ["prompt", "compact"] as const) {
        scheduler.create({
          sessionID: "session-1",
          name: type,
          schedule: "* * * * *",
          action: type === "prompt" ? { type, agent: "build", command: "Check status" } : { type },
          runImmediately: true,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      const signal = session.waitSignals[0]!
      if (operation === "delete") {
        scheduler.delete("session-1", "prompt")
        expect(signal.aborted).toBe(false)
        scheduler.delete("session-1", "compact")
      } else if (operation === "deleteSession") {
        scheduler.deleteSession("session-1")
      } else {
        scheduler.dispose()
      }

      expect(signal.aborted).toBe(true)
      session.idle("session-1")
      for (const timer of runtime.timers) timer.callback()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls).toEqual([])
      expect(scheduler.list("session-1")).toBe("No loops in this session.")
      expect(runtime.timers.every((timer) => timer.cleared)).toBe(true)
    })

    test("deleting the first waiting loop preserves other pending loops", async () => {
      const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
      const session = client()
      session.busy("session-1")
      const scheduler = new LoopScheduler(session.value, runtime)
      for (const name of ["removed", "kept"]) {
        scheduler.create({
          sessionID: "session-1",
          name,
          schedule: "* * * * *",
          action: { type: "compact" },
          runImmediately: true,
        })
      }
      scheduler.delete("session-1", "removed")
      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(session.calls).toEqual([["compact", { sessionID: "session-1", delivery: "queue" }]])
      expect(scheduler.list("session-1")).toContain("kept")
      expect(scheduler.list("session-1")).not.toContain("removed")
      scheduler.dispose()
    })

    test("a busy session does not block idle sessions", async () => {
      const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
      const session = client()
      session.busy("session-1")
      const scheduler = new LoopScheduler(session.value, runtime)
      for (const sessionID of ["session-1", "session-2"]) {
        scheduler.create({
          sessionID,
          name: "compact",
          schedule: "* * * * *",
          action: { type: "compact" },
          runImmediately: true,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls).toEqual([["compact", { sessionID: "session-2", delivery: "queue" }]])

      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls[1]).toEqual(["compact", { sessionID: "session-1", delivery: "queue" }])
      scheduler.dispose()
    })

    test("records idle-wait failures without submitting or retrying in a tight loop", async () => {
      const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
      const session = client()
      const wait = session.value.wait
      session.value.wait = async () => {
        throw new Error("idle state unavailable")
      }
      const scheduler = new LoopScheduler(session.value, runtime)
      scheduler.create({
        sessionID: "session-1",
        name: "compact",
        schedule: "* * * * *",
        action: { type: "compact" },
        runImmediately: true,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls).toEqual([])
      expect(scheduler.list("session-1")).toContain("last error: idle state unavailable; consecutive failures: 1")
      expect(scheduler.list("session-1")).not.toContain("waiting for session idle")

      session.value.wait = wait
      runtime.current = new Date("2026-06-18T12:01:00.000Z")
      runtime.nextTimer().callback()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls).toEqual([["compact", { sessionID: "session-1", delivery: "queue" }]])
      expect(scheduler.list("session-1")).not.toContain("last error")
      scheduler.dispose()
    })

    test("rechecks idle after an agent switch before sending a prompt", async () => {
      const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
      const session = client()
      const switchAgent = session.value.switchAgent
      session.value.switchAgent = async (input: unknown) => {
        await switchAgent(input)
        session.busy("session-1")
        return {}
      }
      const scheduler = new LoopScheduler(session.value, runtime)
      scheduler.create({
        sessionID: "session-1",
        name: "prompt",
        schedule: "* * * * *",
        action: { type: "prompt", agent: "build", command: "Check status" },
        runImmediately: true,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls.map(([method]) => method)).toEqual(["switchAgent"])
      expect(scheduler.list("session-1")).toContain("waiting for session idle")

      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls.map(([method]) => method)).toEqual(["switchAgent", "prompt"])
      scheduler.dispose()
    })

    test("retains a new trigger received while the previous request is in flight", async () => {
      const runtime = new FakeRuntime("2026-06-18T12:00:30.000Z")
      const session = client()
      const compact = session.value.compact
      const submitted = Promise.withResolvers<void>()
      session.value.compact = async (input: { sessionID: string }) => {
        await compact(input)
        await submitted.promise
        return {}
      }
      const scheduler = new LoopScheduler(session.value, runtime)
      scheduler.create({
        sessionID: "session-1",
        name: "compact",
        schedule: "* * * * *",
        action: { type: "compact" },
        runImmediately: true,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      runtime.current = new Date("2026-06-18T12:01:00.000Z")
      runtime.nextTimer().callback()
      submitted.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls).toHaveLength(1)
      expect(scheduler.list("session-1")).toContain("waiting for session idle since 2026-06-18T12:01:00.000Z")

      session.idle("session-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(session.calls).toHaveLength(2)
      scheduler.dispose()
    })
  })
})

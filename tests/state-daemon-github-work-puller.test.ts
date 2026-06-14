import { describe, expect, test } from 'bun:test'
import { StateDaemon } from '../core/state-daemon'
import type { DBClient, GithubWorkPuller } from '../core/state-daemon/types'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
} from './contract/state-daemon/fakes'

class EmptyDb implements DBClient {
  async query<T = any>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [] as T[], rowCount: 0 }
  }
}

class FakeGithubWorkPuller implements GithubWorkPuller {
  calls = 0
  release: (() => void) | null = null
  started: Promise<void>
  private startedResolve!: () => void

  constructor(private readonly hold = false) {
    this.started = new Promise((resolve) => {
      this.startedResolve = resolve
    })
  }

  async pollOnce() {
    this.calls += 1
    this.startedResolve()
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    return {
      scanned: 1,
      matched: 1,
      queued: 1,
      duplicateSuppressed: 0,
      blocked: 0,
      dispatchFailed: 0,
    }
  }
}

function daemonWith(puller: GithubWorkPuller, enabled: boolean, metrics = new FakeMetrics()) {
  return {
    daemon: new StateDaemon({
      db: new EmptyDb(),
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock: new FakeClock(),
      metrics,
      alert: new FakeAlertSink(),
      githubWorkPuller: puller,
      config: {
        githubWorkPullerEnabled: enabled,
        githubWorkPullerIntervalMs: 60_000,
      },
    }),
    metrics,
  }
}

describe('state_daemon GitHub work puller supervision', () => {
  test('feature flag default off means the puller is not called at startup', async () => {
    const puller = new FakeGithubWorkPuller()
    const { daemon } = daemonWith(puller, false)

    await daemon.start()
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(puller.calls).toBe(0)
  })

  test('enabled puller runs once at startup and records summary metrics', async () => {
    const puller = new FakeGithubWorkPuller()
    const { daemon, metrics } = daemonWith(puller, true)

    await daemon.start()
    try {
      await puller.started
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(puller.calls).toBe(1)
    expect(metrics.countInc('state_daemon_github_work_puller_actions_total', {
      result: 'poll_completed',
      trigger: 'startup',
    })).toBe(1)
    expect(metrics.calls.some((call) => {
      return call.kind === 'gaugeSet'
        && call.name === 'state_daemon_github_work_puller_queued'
        && call.value === 1
    })).toBe(true)
  })

  test('overlapping interval attempts are suppressed while a poll is in flight', async () => {
    const puller = new FakeGithubWorkPuller(true)
    const { daemon, metrics } = daemonWith(puller, true)

    await daemon.start()
    try {
      await puller.started
      await daemon.__testRunGithubWorkPuller('interval')
      expect(metrics.countInc('state_daemon_github_work_puller_actions_total', {
        result: 'dedup_skipped',
        trigger: 'interval',
      })).toBe(1)
    } finally {
      puller.release?.()
      await daemon.stop()
    }

    expect(puller.calls).toBe(1)
  })
})

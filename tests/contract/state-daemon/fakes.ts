/**
 * Test fakes for StateDaemon contract tests (#323 spec §11 / fixtures).
 *
 * These satisfy the DI interfaces in `core/state-daemon/types.ts` without
 * touching real Postgres / tmux / pg-listen. Tests use a real ephemeral
 * postgres connection (the dev DB or a per-test schema) for SQL behaviour
 * pinning, and the fakes here for everything else.
 */
import type {
  AlertSink,
  Clock,
  CodexRunnerInvocation,
  CodexRunnerInvoker,
  CodexRunnerResult,
  DBClient,
  Metrics,
  PgListenClient,
  TmuxClient,
} from '../../../core/state-daemon/types'

export class FakeClock implements Clock {
  private current: Date
  constructor(start: Date | string = '2026-05-08T00:00:00.000Z') {
    this.current = new Date(start)
  }
  now(): Date {
    return new Date(this.current)
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
  set(at: Date | string): void {
    this.current = new Date(at)
  }
}

export interface MetricCall {
  kind: 'inc' | 'observe' | 'gaugeSet'
  name: string
  value?: number
  labels?: Record<string, string | number>
}

export class FakeMetrics implements Metrics {
  calls: MetricCall[] = []
  inc(name: string, labels?: Record<string, string | number>, by = 1): void {
    this.calls.push({ kind: 'inc', name, value: by, labels })
  }
  observe(name: string, value: number, labels?: Record<string, string | number>): void {
    this.calls.push({ kind: 'observe', name, value, labels })
  }
  gaugeSet(name: string, value: number, labels?: Record<string, string | number>): void {
    this.calls.push({ kind: 'gaugeSet', name, value, labels })
  }
  countInc(name: string, labelMatch?: Partial<Record<string, string | number>>): number {
    return this.calls
      .filter((c) => c.kind === 'inc' && c.name === name)
      .filter((c) => {
        if (!labelMatch) return true
        if (!c.labels) return false
        return Object.entries(labelMatch).every(([k, v]) => c.labels?.[k] === v)
      })
      .reduce((s, c) => s + (c.value ?? 1), 0)
  }
  observed(name: string): number[] {
    return this.calls.filter((c) => c.kind === 'observe' && c.name === name).map((c) => c.value!)
  }
  reset(): void {
    this.calls = []
  }
}

export class FakeAlertSink implements AlertSink {
  alerts: string[] = []
  async alert(content: string): Promise<void> {
    this.alerts.push(content)
  }
  reset(): void {
    this.alerts = []
  }
  contains(substr: string): boolean {
    return this.alerts.some((a) => a.includes(substr))
  }
}

export class FakeTmux implements TmuxClient {
  sentKeys: Array<{ session: string; payload: string }> = []
  restarts: string[] = []
  /** Sessions reported as existing. Defaults to "all exist". */
  existingSessions: Set<string> | null = null

  async sessionExists(session: string): Promise<boolean> {
    if (this.existingSessions === null) return true
    return this.existingSessions.has(session)
  }
  async restartSession(agentId: string): Promise<void> {
    this.restarts.push(agentId)
  }
  async sendPrompt(session: string, prompt: string): Promise<void> {
    this.sentKeys.push({ session, payload: prompt })
  }
  reset(): void {
    this.sentKeys = []
    this.restarts = []
    this.existingSessions = null
  }
}

export class FakeCodexRunner implements CodexRunnerInvoker {
  invocations: CodexRunnerInvocation[] = []
  result: CodexRunnerResult = { ok: true, code: 0, stdout: '{"ok":true}\n', stderr: '' }

  async invoke(input: CodexRunnerInvocation): Promise<CodexRunnerResult> {
    this.invocations.push(input)
    return this.result
  }

  reset(): void {
    this.invocations = []
    this.result = { ok: true, code: 0, stdout: '{"ok":true}\n', stderr: '' }
  }
}

export class FakePgListen implements PgListenClient {
  private cb?: (payload: string) => void
  listening = false
  async listen(_channel: string, onPayload: (payload: string) => void): Promise<void> {
    this.cb = onPayload
    this.listening = true
  }
  async unlisten(): Promise<void> {
    this.listening = false
    this.cb = undefined
  }
  /** Test trigger: invoke the registered subscriber as if from the DB. */
  emit(payload: string): void {
    this.cb?.(payload)
  }
}

/**
 * Wraps a real `pg.Client` (or any pg.Pool client) for the contract tests
 * that need real SQL semantics. Tests truncate / seed the affected tables
 * before each fixture run — see `seed.ts`.
 */
export class PgDBClient implements DBClient {
  constructor(private client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }) {}
  async query<T = any>(sql: string, params?: unknown[]) {
    const r = await this.client.query(sql, params)
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 }
  }
}

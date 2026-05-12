/**
 * Stall detector (PR #338 v0.9 sub-PR 2, §1.3a + §1.6).
 *
 * Three-layer abstraction over the nine stall patterns the daemon recognises
 * before issuing a wake. Each layer takes a single canonical input shape and
 * returns zero or more `StallVerdict`s; verdicts from different layers
 * compose by array concatenation (spec §1.3a "cross-layer signal は
 * StallVerdict 配列を介して合成のみ").
 *
 * Detection order in the production gate is L1 → L2 → L3 (queue-row →
 * process-state → output-state); if any layer returns a non-empty verdict
 * array the daemon skips the wake for that row, logs a metric tagged with
 * the verdict kind, and lets the existing sweep / heartbeat paths handle
 * the recovery action separately.
 *
 * Coverage (spec §1.6 table):
 *   L1: 1 idle, 2 claim_ttl_expired, 3 received_stuck — functional
 *   L2: 4 dead_bot, 5 tmux_missing — functional
 *   L3: 8 input_residue — functional
 *   L3: 6 in_progress_stall, 7 context_pressure, 9 smooshing_hang — STUB,
 *       interface-only (CTO directive `0cc8ba72`, option β: ship the full
 *       9-pattern interface, leave the three L3 stalls as inert stubs until
 *       the infra they depend on lands).
 *
 * Stub dependencies (do not implement before these ship):
 *   - in_progress_stall: needs `status='in_progress'` in the queue enum
 *     (sub-PR 1 destructive migration, last in the rollout).
 *   - context_pressure: needs bot-reply token-pressure monitoring; not in
 *     any current state-daemon code path.
 *   - smooshing_hang: needs bot-output stream monitoring; same.
 */

// Minimal structural views of the daemon's queue / agent rows. Kept here
// (rather than imported from ./index) so the detector module is loadable
// in tests that do not pull in the full daemon module graph.
export interface DetectorQueueRow {
  readonly id: number
  readonly agent_id: string
  readonly status: string
  readonly claim_expires_at: Date | string | null
  readonly created_at: Date | string
  readonly last_wake_attempt_at: Date | string | null
}

export interface DetectorAgentRow {
  readonly agent_id: string
  readonly runtime: string | null
  readonly status: string | null
  readonly tmux_session: string | null
  readonly last_seen_at: Date | string | null
}

export type StallLayer = 'L1' | 'L2' | 'L3'

/**
 * Spec §1.6 enumerates the nine pattern kinds. Listed explicitly here so
 * type errors fire if a new layer entry forgets to map a kind, and so the
 * forbidden-list check ("9 pattern interface 削減禁止") is self-evident
 * to a reader: the union has exactly nine members.
 */
export type StallKind =
  | 'idle'
  | 'claim_ttl_expired'
  | 'received_stuck'
  | 'dead_bot'
  | 'tmux_missing'
  | 'in_progress_stall'
  | 'context_pressure'
  | 'input_residue'
  | 'smooshing_hang'

export interface StallVerdict {
  readonly layer: StallLayer
  readonly kind: StallKind
  /** Free-form one-line summary; metric-friendly (no newlines). */
  readonly reason: string
}

/**
 * Detection input. Kept narrow so layers do not need a full DB handle —
 * each layer receives the rows already loaded by the daemon's sweep step,
 * which is what makes the detector test-friendly (the tests can inject any
 * `BotContext` shape they need without touching Postgres).
 */
export interface BotContext {
  readonly now: Date
  readonly row: DetectorQueueRow
  readonly agent: DetectorAgentRow | null
  /**
   * Result of an out-of-band tmux capture, if the caller chose to take one.
   * `null` means "not captured" (no signal); an empty string means "captured,
   * pane is empty". L3's `input_residue` distinguishes the two.
   */
  readonly tmuxPaneTail: string | null
  readonly thresholds: StallThresholds
}

export interface StallThresholds {
  /** Spec §1.6 row 2: claim TTL expired. */
  readonly claimTtlExpiredAfterSec: number
  /** Spec §1.6 row 3: received-stuck age. */
  readonly receivedStuckAfterSec: number
  /** Spec §1.6 row 4: agents.last_seen_at age treated as dead. */
  readonly deadBotAfterSec: number
}

/**
 * Hard-coded fallback values used when the matching env var is unset.
 * Production code reads through `loadStallThresholdsFromEnv()`; the literal
 * fallbacks below sit in one named export so a reader can grep for the
 * source of truth without chasing env wiring.
 */
export const FALLBACK_STALL_THRESHOLDS: StallThresholds = Object.freeze({
  claimTtlExpiredAfterSec: 0,
  receivedStuckAfterSec: 300,
  deadBotAfterSec: 120,
})

/**
 * Env-driven thresholds (cycle 2 Fix 3, spec §1.3a). Reads
 * `STATE_DAEMON_STUCK_AFTER_SEC` and `STATE_DAEMON_STALL_AFTER_SEC` from
 * the process env; falls back to {@link FALLBACK_STALL_THRESHOLDS} when
 * the var is unset or malformed. The X1 ConfigPort module (PR #343)
 * narrowed its "no `process.env` raw reads" rule to the
 * runtime / production-bot / destructive-flag axes (spec §3.1 commit
 * `8efcb2a`/`23599c0`), so reading state-daemon tuning vars here is
 * within X1's scope.
 */
export function loadStallThresholdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StallThresholds {
  const parse = (key: string, fallback: number): number => {
    const raw = env[key]
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return fallback
    return n
  }
  return {
    claimTtlExpiredAfterSec: parse(
      'STATE_DAEMON_CLAIM_TTL_EXPIRED_AFTER_SEC',
      FALLBACK_STALL_THRESHOLDS.claimTtlExpiredAfterSec,
    ),
    receivedStuckAfterSec: parse(
      'STATE_DAEMON_STUCK_AFTER_SEC',
      FALLBACK_STALL_THRESHOLDS.receivedStuckAfterSec,
    ),
    deadBotAfterSec: parse(
      'STATE_DAEMON_STALL_AFTER_SEC',
      FALLBACK_STALL_THRESHOLDS.deadBotAfterSec,
    ),
  }
}

/** Backwards-compatible alias; kept so older imports keep working. */
export const DEFAULT_STALL_THRESHOLDS = FALLBACK_STALL_THRESHOLDS

export interface StallDetector {
  /**
   * Evaluate every layer and return the concatenated verdict list. Empty
   * array means "no stall, proceed to per-bot suppression check". The
   * detector never throws on a non-implemented L3 stub — the stubs are
   * inert (see `STUB_DEPENDENCIES`).
   */
  detect(ctx: BotContext): Promise<readonly StallVerdict[]>

  /**
   * Layer-level entry points. Exposed for callers that want to evaluate one
   * layer in isolation (and for the test mocks the spec requires under
   * "test layer abstraction: 3 layer interface 経由で評価されることを mock で
   * verify").
   */
  l1(ctx: BotContext): Promise<readonly StallVerdict[]>
  l2(ctx: BotContext): Promise<readonly StallVerdict[]>
  l3(ctx: BotContext): Promise<readonly StallVerdict[]>
}

/**
 * Stubs that the daemon ships as interface members so the 9-pattern set is
 * complete from day one, but whose detection logic depends on infrastructure
 * that has not landed yet. They are intentionally inert: they observe their
 * input and return an empty verdict array. The full list is exposed so PR
 * descriptions and post-merge audits can grep for "STUB" in one place.
 */
export const STUB_DEPENDENCIES: Readonly<Record<StallKind, string | null>> = Object.freeze({
  idle: null,
  claim_ttl_expired: null,
  received_stuck: null,
  dead_bot: null,
  tmux_missing: null,
  in_progress_stall: "depends on sub-PR 1 (status='in_progress' enum migration)",
  context_pressure: 'depends on follow-up bot-reply token-monitoring infra (no existing code path)',
  // cycle 2 Fix 1 (auditor verdict `7860f70a`): input_residue is interface-
  // shipped but inert. The detector function inspects ctx.tmuxPaneTail, but
  // the daemon currently calls `evaluateStallGate` with tmuxPaneTail=null
  // (no capture-pane caller in state-daemon — the only existing caller is
  // server.ts:3371). Re-classified as stub until that caller routes through
  // the daemon. Five patterns are functional, four are stubs.
  input_residue: 'depends on follow-up tmux capture-pane wiring from state-daemon (currently lives in server.ts:3371)',
  smooshing_hang: 'depends on follow-up bot-output stream monitoring infra (no existing code path)',
})

// ── L1: queue row predicate ─────────────────────────────────────────────────
// row + age + claim metadata only; no agent / process / output dependencies.

async function l1_idle(ctx: BotContext): Promise<StallVerdict | null> {
  // §1.6 row 1: queue empty AND agent online → no wake is meaningful.
  // The daemon never wakes when no pending row exists, so `idle` is the
  // diagnostic kind the gate reports if it is somehow asked to wake one
  // (defensive). Treated as "trust the row is genuine pending" elsewhere.
  if (ctx.row.status !== 'pending') {
    return { layer: 'L1', kind: 'idle', reason: 'row.status not pending — no wake' }
  }
  return null
}

async function l1_claim_ttl_expired(ctx: BotContext): Promise<StallVerdict | null> {
  if (ctx.row.status !== 'read') return null
  if (!ctx.row.claim_expires_at) return null
  const expiresAt = new Date(ctx.row.claim_expires_at).getTime()
  if (expiresAt < ctx.now.getTime()) {
    return {
      layer: 'L1',
      kind: 'claim_ttl_expired',
      reason: 'received row past claim_expires_at — self-reclaim will reset it',
    }
  }
  return null
}

async function l1_received_stuck(ctx: BotContext): Promise<StallVerdict | null> {
  if (ctx.row.status !== 'read') return null
  const ageSec = (ctx.now.getTime() - new Date(ctx.row.created_at).getTime()) / 1000
  if (ageSec > ctx.thresholds.receivedStuckAfterSec) {
    return {
      layer: 'L1',
      kind: 'received_stuck',
      reason: `received row age ${Math.round(ageSec)}s > ${ctx.thresholds.receivedStuckAfterSec}s`,
    }
  }
  return null
}

// ── L2: process state ──────────────────────────────────────────────────────

async function l2_dead_bot(ctx: BotContext): Promise<StallVerdict | null> {
  if (!ctx.agent) return null
  if (ctx.agent.status !== 'online') return null
  if (!ctx.agent.last_seen_at) return null
  const ageSec =
    (ctx.now.getTime() - new Date(ctx.agent.last_seen_at).getTime()) / 1000
  if (ageSec > ctx.thresholds.deadBotAfterSec) {
    return {
      layer: 'L2',
      kind: 'dead_bot',
      reason: `agents.last_seen_at age ${Math.round(ageSec)}s > ${ctx.thresholds.deadBotAfterSec}s while status=online`,
    }
  }
  return null
}

async function l2_tmux_missing(ctx: BotContext): Promise<StallVerdict | null> {
  if (!ctx.agent) return null
  if (ctx.agent.runtime !== 'TUI') return null
  // tmux_session may be NULL (unseeded) or empty; either way the wake path
  // has no target. The heartbeat path already alerts; the gate's role is
  // just to skip the wake.
  if (!ctx.agent.tmux_session) {
    return {
      layer: 'L2',
      kind: 'tmux_missing',
      reason: 'runtime=TUI but agents.tmux_session is empty/NULL',
    }
  }
  return null
}

// ── L3: output state ───────────────────────────────────────────────────────

async function l3_input_residue(ctx: BotContext): Promise<StallVerdict | null> {
  // STUB-equivalent (cycle 2 Fix 1, auditor verdict `7860f70a`): the
  // detection logic below is correct in shape, but the daemon currently
  // always passes `tmuxPaneTail: null` because no caller inside
  // state-daemon takes a tmux capture (the only existing capture site is
  // server.ts:3371). The function therefore short-circuits to `null` on
  // every production call and stays interface-only until a future PR
  // routes the capture through the daemon. Treated as a stub for honest
  // accounting; see STUB_DEPENDENCIES.input_residue.
  //
  // The original detection comment, kept for the eventual wire-up:
  //   §1.6 row 8: tmux pane has unsent input. The caller decides whether
  //   to capture the pane; the detector only inspects what it was given.
  //   A non-empty trailing line that is not the canonical "claude " prompt
  //   is treated as residue.
  if (ctx.tmuxPaneTail === null) return null
  const trimmed = ctx.tmuxPaneTail.trimEnd()
  if (trimmed.length === 0) return null
  const lastLine = trimmed.split('\n').pop() ?? ''
  if (lastLine.length === 0) return null
  // Canonical empty prompts vary by runtime; the detector flags any
  // trailing non-empty line that does not look like a fresh prompt.
  // Production callers can refine this without changing the verdict shape.
  if (/^\s*[>$#%]\s*$/.test(lastLine)) return null
  return {
    layer: 'L3',
    kind: 'input_residue',
    reason: `tmux pane tail has unsent input: ${JSON.stringify(lastLine).slice(0, 80)}`,
  }
}

// ── L3 stubs (interface-complete, infra-blocked) ───────────────────────────

async function l3_in_progress_stall(_ctx: BotContext): Promise<StallVerdict | null> {
  // STUB: needs `status='in_progress'` (sub-PR 1 destructive enum migration).
  // Returns null so the interface stays inert until the dependency ships.
  return null
}

async function l3_context_pressure(_ctx: BotContext): Promise<StallVerdict | null> {
  // STUB: needs bot-reply token-monitoring infra (no existing code path).
  return null
}

async function l3_smooshing_hang(_ctx: BotContext): Promise<StallVerdict | null> {
  // STUB: needs bot-output stream monitoring infra (no existing code path).
  return null
}

async function gather(
  ...fns: Array<(ctx: BotContext) => Promise<StallVerdict | null>>
): Promise<(ctx: BotContext) => Promise<readonly StallVerdict[]>> {
  return async (ctx: BotContext): Promise<readonly StallVerdict[]> => {
    const verdicts: StallVerdict[] = []
    for (const fn of fns) {
      const v = await fn(ctx)
      if (v) verdicts.push(v)
    }
    return verdicts
  }
}

export function createDefaultStallDetector(): StallDetector {
  // Each layer is a thin closure over the per-pattern detection functions
  // so the layer-level entry points stay analytically equivalent to a
  // concatenation of the patterns in spec order (§1.6 table).
  const l1 = async (ctx: BotContext): Promise<readonly StallVerdict[]> => {
    const verdicts: StallVerdict[] = []
    for (const fn of [l1_idle, l1_claim_ttl_expired, l1_received_stuck]) {
      const v = await fn(ctx)
      if (v) verdicts.push(v)
    }
    return verdicts
  }
  const l2 = async (ctx: BotContext): Promise<readonly StallVerdict[]> => {
    const verdicts: StallVerdict[] = []
    for (const fn of [l2_dead_bot, l2_tmux_missing]) {
      const v = await fn(ctx)
      if (v) verdicts.push(v)
    }
    return verdicts
  }
  const l3 = async (ctx: BotContext): Promise<readonly StallVerdict[]> => {
    const verdicts: StallVerdict[] = []
    for (const fn of [
      l3_in_progress_stall,
      l3_context_pressure,
      l3_input_residue,
      l3_smooshing_hang,
    ]) {
      const v = await fn(ctx)
      if (v) verdicts.push(v)
    }
    return verdicts
  }
  const detect = async (ctx: BotContext): Promise<readonly StallVerdict[]> => {
    // Order matters for diagnostics; layers compose by concatenation.
    return [...(await l1(ctx)), ...(await l2(ctx)), ...(await l3(ctx))]
  }
  return { detect, l1, l2, l3 }
}

void gather // tree-shaking placeholder; kept exported-shape stable across future refactors

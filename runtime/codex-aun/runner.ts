import { codexAunAdapter } from './adapter'

export interface CodexAunRunnerPlan {
  readonly adapter: typeof codexAunAdapter
  readonly stateDaemonOwned: false
  readonly lifecycle: readonly ['inbox', 'processing', 'send-or-done']
}

export function describeCodexAunRunnerPlan(): CodexAunRunnerPlan {
  return {
    adapter: codexAunAdapter,
    stateDaemonOwned: false,
    lifecycle: ['inbox', 'processing', 'send-or-done'],
  }
}


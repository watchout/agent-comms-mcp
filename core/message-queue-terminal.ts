export const AUTO_SKIP_REASON_PREFIX = 'AUTO_SKIP_PATTERN'
export const BULK_CLEANUP_REASON_PREFIX = 'BULK_CLEANUP'
export const STALE_DISPATCH_REASON = 'STALE_DISPATCH'

export type MessageQueueTerminalStatus = 'replied' | 'skipped' | 'failed'

export function autoSkipReason(reason: string): string {
  return `${AUTO_SKIP_REASON_PREFIX}:${reason}`
}

export function staleDispatchReason(detail: string): string {
  return `${STALE_DISPATCH_REASON}:${detail}`
}

import { expect } from 'bun:test'

export function expectWithinBudget(
  actualMs: number,
  budgetMs: number,
  label: string,
  options: { inclusive?: boolean; unit?: 'ms' | 's' } = {},
): void {
  const unit = options.unit ?? 'ms'
  console.log(`[timing] ${label} actual=${actualMs}${unit} budget=${budgetMs}${unit}`)
  if (process.env.AUN_TIMING_ASSERTS !== '1') return
  if (options.inclusive) expect(actualMs).toBeLessThanOrEqual(budgetMs)
  else expect(actualMs).toBeLessThan(budgetMs)
}

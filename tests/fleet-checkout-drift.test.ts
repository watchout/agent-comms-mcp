import { describe, expect, test } from 'bun:test'
import { evaluateFleetCheckoutDrift } from '../core/fleet-checkout-drift'

const COMMIT = '540764dbc78bcd1bd9e12b11915f9b63d08de23b'
const OTHER_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('fleet checkout drift evidence integrity', () => {
  test('preserves aligned clean and dirty checkout behavior', () => {
    const clean = evaluateFleetCheckoutDrift({
      checkout_path: '/fleet/checkouts/./runtime',
      commit_sha: COMMIT,
      metadata: {
        git_checkout_path: '/fleet/checkouts/runtime',
        git_commit_sha: COMMIT.toUpperCase(),
        git_dirty: false,
      },
    })
    expect(clean.ok).toBe(true)
    expect(clean.reasons).toEqual([])

    const dirty = evaluateFleetCheckoutDrift({
      checkout_path: '/fleet/checkouts/runtime',
      commit_sha: COMMIT,
      metadata: {
        git_checkout_path: '/fleet/checkouts/runtime',
        git_commit_sha: COMMIT,
        git_dirty: true,
      },
    })
    expect(dirty.reasons).toEqual(['runtime_dirty_checkout'])

    const allowedDirty = evaluateFleetCheckoutDrift({
      checkout_path: '/fleet/checkouts/runtime',
      commit_sha: COMMIT,
      metadata: {
        git_checkout_path: '/fleet/checkouts/runtime',
        git_commit_sha: COMMIT,
        git_dirty: true,
      },
    }, { allowDirtyCheckout: true })
    expect(allowedDirty.ok).toBe(true)
  })

  test('rejects row and metadata path disagreement even when dirty checkouts are allowed', () => {
    const result = evaluateFleetCheckoutDrift({
      checkout_path: '/fleet/checkouts/runtime-a',
      commit_sha: COMMIT,
      metadata: {
        git_checkout_path: '/fleet/checkouts/runtime-b',
        git_commit_sha: COMMIT,
        git_dirty: true,
      },
    }, { allowDirtyCheckout: true })

    expect(result.ok).toBe(false)
    expect(result.reasons).toEqual(['runtime_checkout_evidence_mismatch'])
  })

  test('rejects row and metadata commit disagreement without an active drift policy', () => {
    const result = evaluateFleetCheckoutDrift({
      checkout_path: '/fleet/checkouts/runtime',
      commit_sha: COMMIT,
      metadata: {
        git_checkout_path: '/fleet/checkouts/runtime',
        git_commit_sha: OTHER_COMMIT,
        git_dirty: false,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.reasons).toEqual(['runtime_checkout_evidence_mismatch'])
  })

  test('keeps legacy single-projection evidence compatible', () => {
    const result = evaluateFleetCheckoutDrift({
      checkout_path: '/fleet/checkouts/runtime',
      commit_sha: COMMIT,
      metadata: { git_dirty: false },
    })

    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })
})

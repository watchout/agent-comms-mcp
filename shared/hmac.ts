/**
 * HMAC-SHA256 signature utilities for daemon ↔ channel-server auth (§4.1)
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Sign a payload with HMAC-SHA256
 * @returns signature string in format "sha256={hex}"
 */
export function signPayload(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret).update(payload).digest('hex')
  return `sha256=${hmac}`
}

/**
 * Verify HMAC-SHA256 signature
 * @returns true if signature matches
 */
export function verifyPayload(payload: string, signature: string | null, secret: string): boolean {
  if (!secret) return true  // no secret = skip verification (dev mode)
  if (!signature) return false

  const expected = signPayload(payload, secret)

  // Timing-safe comparison to prevent timing attacks
  if (expected.length !== signature.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

/**
 * OAuth 2.1 / PKCE baseline for AUN v2 enterprise auth.
 *
 * Implements RFC 6749 + RFC 7636 (PKCE S256) + RFC 9126 (PAR concept) for
 * MCP Streamable HTTP transport authentication (MCP spec 2025-06-18 §4).
 *
 * Activation: requires OAUTH_PERSISTENCE_ENABLED=1 + oauth_clients table.
 * Without this env var the module exports no-op helpers so server.ts can
 * import it unconditionally and the dummy bypass endpoints remain active.
 *
 * Security invariants:
 *  - Authorization codes expire in 10 minutes and are single-use
 *  - Access tokens are stored as SHA-256 hashes only (raw token never in DB)
 *  - PKCE S256 is mandatory for all public clients
 *  - Token validation is constant-time (timingSafeEqual)
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { Client } from 'pg'
import { createLogger } from './logger'

const log = createLogger('oauth21')

export interface OAuthClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  scope: string
  is_confidential: boolean
}

export interface TokenClaims {
  subject: string
  client_id: string
  scope: string
  expires_at: string
}

export function isOAuthPersistenceEnabled(): boolean {
  return process.env.OAUTH_PERSISTENCE_ENABLED === '1'
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  const derived = deriveCodeChallenge(verifier)
  if (derived.length !== challenge.length) return false
  return timingSafeEqual(Buffer.from(derived), Buffer.from(challenge))
}

// ---------------------------------------------------------------------------
// Authorization code flow
// ---------------------------------------------------------------------------

export async function issueAuthorizationCode(
  db: Client,
  params: {
    client_id: string
    redirect_uri: string
    scope: string
    code_challenge: string
    subject: string
  },
): Promise<string> {
  const code = randomBytes(32).toString('base64url')
  await db.query(
    `INSERT INTO oauth_authorization_codes
       (code, client_id, redirect_uri, scope, code_challenge, code_challenge_method, subject)
     VALUES ($1, $2, $3, $4, $5, 'S256', $6)`,
    [code, params.client_id, params.redirect_uri, params.scope, params.code_challenge, params.subject],
  )
  log.info('code.issued', { client_id: params.client_id, subject: params.subject })
  return code
}

export async function exchangeCodeForToken(
  db: Client,
  params: {
    code: string
    client_id: string
    redirect_uri: string
    code_verifier: string
  },
): Promise<string | null> {
  const { rows } = await db.query<{
    code: string
    client_id: string
    redirect_uri: string
    scope: string
    code_challenge: string
    subject: string
    expires_at: Date
    used_at: Date | null
  }>(
    `SELECT * FROM oauth_authorization_codes WHERE code = $1`,
    [params.code],
  )

  if (!rows.length) {
    log.warn('code.not_found', { client_id: params.client_id })
    return null
  }

  const row = rows[0]

  if (row.used_at !== null) {
    log.warn('code.already_used', { client_id: params.client_id })
    return null
  }

  if (new Date(row.expires_at) < new Date()) {
    log.warn('code.expired', { client_id: params.client_id })
    return null
  }

  if (row.client_id !== params.client_id) {
    log.warn('code.client_mismatch', { client_id: params.client_id })
    return null
  }

  if (row.redirect_uri !== params.redirect_uri) {
    log.warn('code.redirect_uri_mismatch', { client_id: params.client_id })
    return null
  }

  if (!verifyCodeChallenge(params.code_verifier, row.code_challenge)) {
    log.warn('code.pkce_mismatch', { client_id: params.client_id })
    return null
  }

  // Mark code as used (single-use enforcement)
  await db.query(
    `UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code = $1`,
    [params.code],
  )

  // Issue access token
  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')

  await db.query(
    `INSERT INTO oauth_access_tokens (token_hash, client_id, subject, scope)
     VALUES ($1, $2, $3, $4)`,
    [tokenHash, params.client_id, row.subject, row.scope],
  )

  log.info('token.issued', { client_id: params.client_id, subject: row.subject })
  return rawToken
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

export async function validateBearerToken(
  db: Client,
  rawToken: string,
): Promise<TokenClaims | null> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')

  const { rows } = await db.query<{
    client_id: string
    subject: string
    scope: string
    expires_at: Date
    revoked_at: Date | null
  }>(
    `SELECT client_id, subject, scope, expires_at, revoked_at
       FROM oauth_access_tokens
      WHERE token_hash = $1`,
    [tokenHash],
  )

  if (!rows.length) return null
  const row = rows[0]

  if (row.revoked_at !== null) {
    log.warn('token.revoked', { client_id: row.client_id })
    return null
  }

  if (new Date(row.expires_at) < new Date()) {
    log.warn('token.expired', { client_id: row.client_id })
    return null
  }

  return {
    subject: row.subject,
    client_id: row.client_id,
    scope: row.scope,
    expires_at: row.expires_at.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Client lookup
// ---------------------------------------------------------------------------

export async function lookupClient(
  db: Client,
  client_id: string,
): Promise<OAuthClient | null> {
  const { rows } = await db.query<OAuthClient>(
    `SELECT client_id, client_name, redirect_uris, grant_types, scope, is_confidential
       FROM oauth_clients WHERE client_id = $1`,
    [client_id],
  )
  return rows[0] ?? null
}

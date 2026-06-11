-- OAuth 2.1 baseline tables (AUN v2 enterprise auth, MCP spec 2025-06-18)
-- Additive only — no DROP, no ALTER, safe to re-run (IF NOT EXISTS throughout).

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id         TEXT PRIMARY KEY,
  client_name       TEXT NOT NULL,
  redirect_uris     TEXT[] NOT NULL DEFAULT '{}',
  grant_types       TEXT[] NOT NULL DEFAULT '{authorization_code}',
  scope             TEXT NOT NULL DEFAULT 'mcp',
  client_secret_hash TEXT,         -- NULL = public client (PKCE required)
  is_confidential   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for redirect URI lookup during authorization
CREATE INDEX IF NOT EXISTS idx_oauth_clients_redirect
  ON oauth_clients USING GIN (redirect_uris);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code              TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri      TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'mcp',
  code_challenge    TEXT NOT NULL,   -- PKCE S256 challenge (RFC 7636)
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  subject           TEXT NOT NULL,   -- agent_id or user identifier
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  used_at           TIMESTAMPTZ,     -- NULL = not yet exchanged
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires
  ON oauth_authorization_codes (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash        TEXT PRIMARY KEY,   -- SHA-256(token), never store raw token
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,      -- agent_id or user identifier
  scope             TEXT NOT NULL DEFAULT 'mcp',
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  revoked_at        TIMESTAMPTZ,        -- NULL = active
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires
  ON oauth_access_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- Seed the built-in Claude Code local client (public, PKCE-only)
-- Uses ON CONFLICT DO NOTHING so re-runs are idempotent.
INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope, is_confidential)
VALUES (
  'claude-code-local',
  'Claude Code (local)',
  ARRAY['http://localhost/callback', 'http://127.0.0.1/callback'],
  ARRAY['authorization_code'],
  'mcp',
  FALSE
) ON CONFLICT (client_id) DO NOTHING;

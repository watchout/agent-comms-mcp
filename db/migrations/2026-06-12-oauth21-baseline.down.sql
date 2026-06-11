-- Revert OAuth 2.1 baseline tables
-- Safe: drops only tables introduced in the corresponding .up.sql

DROP TABLE IF EXISTS oauth_access_tokens CASCADE;
DROP TABLE IF EXISTS oauth_authorization_codes CASCADE;
DROP TABLE IF EXISTS oauth_clients CASCADE;

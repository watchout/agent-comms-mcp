#!/usr/bin/env bun
import { Client } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'

async function migrate() {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()

  // Core message table
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_bot BOOLEAN DEFAULT true,
      content TEXT NOT NULL,
      message_type TEXT,
      reply_to UUID REFERENCES agent_messages(id),
      attachments JSONB,
      metadata JSONB,
      depth INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_channel
      ON agent_messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_author
      ON agent_messages(author_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_type
      ON agent_messages(message_type, created_at);
  `)

  // Channel settings (retention policy, etc.)
  await client.query(`
    CREATE TABLE IF NOT EXISTS channel_settings (
      channel_id TEXT PRIMARY KEY,
      retention_days INTEGER,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `)

  // Default channel settings
  await client.query(`
    INSERT INTO channel_settings (channel_id, retention_days, description)
    VALUES
      ('approvals', NULL, '承認フロー（永続保存）'),
      ('audit-log', NULL, '監査ログ（永続保存）'),
      ('hotel-kanri', 30, 'Hotel Dev通信'),
      ('haishin-puls-hub', 30, 'Haishin Dev通信'),
      ('wbs', 30, 'WBS Dev通信'),
      ('nyusatsu', 30, 'Nyusatsu Dev通信'),
      ('ai-dev-framework', 30, 'ADF Dev通信'),
      ('x-marketing-engine', 30, 'XMarketing Dev通信'),
      ('upwork-automation', 30, 'Upwork Dev通信'),
      ('org-build', NULL, '組織構築（永続保存）'),
      ('ceo-cto', NULL, 'CEO-CTO戦略（永続保存）')
    ON CONFLICT (channel_id) DO NOTHING;
  `)

  console.log('Migration complete.')
  await client.end()
}

migrate().catch(e => { console.error(e); process.exit(1) })

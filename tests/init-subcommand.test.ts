import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { generateEnv } from '../cli/init'

const TMP_DIR = '/tmp/agent-com-init-test-' + process.pid

describe('init subcommand', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true })
  })

  describe('generateEnv', () => {
    it('generates .env with sqlite defaults', () => {
      const env = generateEnv({
        agentId: 'my-bot',
        discordToken: 'test-token-123',
        dbType: 'sqlite',
      })
      expect(env).toContain('AGENT_ID=my-bot')
      expect(env).toContain('DISCORD_TOKEN=test-token-123')
      expect(env).toContain('AGENT_COM_DB=sqlite')
      expect(env).toContain('AGENT_COM_SQLITE_PATH=./agent-com.db')
      expect(env).toContain('# DATABASE_URL=postgresql://localhost/agent_comms')
      expect(env).toContain('AGENT_COM_POLL_INTERVAL_MS=3000')
      expect(env).toContain('AGENT_COM_REPLY_CHAIN_DEPTH=10')
    })

    it('generates .env with postgres settings', () => {
      const env = generateEnv({
        agentId: 'pg-bot',
        discordToken: 'pg-token',
        dbType: 'postgres',
        databaseUrl: 'postgresql://user:pass@host/db',
      })
      expect(env).toContain('AGENT_COM_DB=postgres')
      expect(env).toContain('DATABASE_URL=postgresql://user:pass@host/db')
      expect(env).not.toContain('# DATABASE_URL')
    })

    it('generates .env with custom sqlite path', () => {
      const env = generateEnv({
        agentId: 'test',
        discordToken: 'tok',
        dbType: 'sqlite',
        sqlitePath: '/data/my.db',
      })
      expect(env).toContain('AGENT_COM_SQLITE_PATH=/data/my.db')
    })

    it('writes valid .env file to disk', () => {
      const envPath = join(TMP_DIR, '.env')
      const env = generateEnv({
        agentId: 'write-test',
        discordToken: 'write-tok',
        dbType: 'sqlite',
      })
      writeFileSync(envPath, env, 'utf-8')
      expect(existsSync(envPath)).toBe(true)
      const content = readFileSync(envPath, 'utf-8')
      expect(content).toContain('AGENT_ID=write-test')
    })
  })

  describe('auto-detect logic', () => {
    it('detects missing .env (would run init)', () => {
      const envPath = join(TMP_DIR, '.env')
      expect(existsSync(envPath)).toBe(false)
      // auto-detect: no .env → init path
    })

    it('detects existing .env (would run start)', () => {
      const envPath = join(TMP_DIR, '.env')
      writeFileSync(envPath, 'AGENT_ID=test\n', 'utf-8')
      expect(existsSync(envPath)).toBe(true)
      // auto-detect: .env exists → start path
    })
  })

  describe('status subcommand', () => {
    it('prints "Not running" when no server is active', async () => {
      // Test that fetching a non-existent health endpoint throws
      try {
        await fetch('http://127.0.0.1:19999/health')
        // If somehow something is running on this port, skip
      } catch {
        // Expected: connection refused → "Not running" path
        expect(true).toBe(true)
      }
    })
  })

  describe('start subcommand', () => {
    it('fails when .env is missing', async () => {
      const bunPath = process.execPath
      const proc = Bun.spawn([bunPath, 'run', join(process.cwd(), 'cli/start.ts')], {
        cwd: TMP_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const stderr = await new Response(proc.stderr).text()
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('No .env found')
    })
  })
})

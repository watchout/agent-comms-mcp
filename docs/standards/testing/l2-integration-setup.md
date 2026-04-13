# L2 Integration Test Setup Guide

> ADR-010: テスト3層化 — L2統合テストの環境構築・実装ガイド

---

## 概要

L2テストは実際のデータベースに接続してAPIの動作を検証する統合テストです。
モックでは検出できないDB制約・マイグレーション・認証フローの問題を発見します。

## 環境構築

### 1. テスト用DBの準備

#### Docker Compose（推奨）

```yaml
# docker-compose.test.yml
services:
  test-db:
    image: postgres:16
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: test
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data  # RAMディスクで高速化
```

```bash
docker compose -f docker-compose.test.yml up -d
```

#### CI環境（GitHub Actions）

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: test
    ports: ['5432:5432']
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

### 2. テスト設定ファイル

```typescript
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

### 3. グローバルセットアップ

```typescript
// tests/integration/global-setup.ts
export async function setup() {
  // マイグレーション実行
  // シードデータ投入
}

export async function teardown() {
  // DB接続クローズ
}
```

### 4. テストごとのセットアップ

```typescript
// tests/integration/setup.ts
import { beforeEach, afterEach } from 'vitest';

beforeEach(async () => {
  // トランザクション開始 or テーブルクリーン
});

afterEach(async () => {
  // ロールバック
});
```

## テスト作成パターン

### APIエンドポイントテスト

```typescript
describe('POST /api/users', () => {
  it('creates a user with valid data', async () => {
    const res = await fetch('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', email: 'test@example.com' }),
    });
    expect(res.status).toBe(201);

    // DBで実際に作成されたことを確認
    const user = await db.query('SELECT * FROM users WHERE email = $1', ['test@example.com']);
    expect(user.rows).toHaveLength(1);
  });
});
```

### 認証フローテスト

```typescript
describe('Authentication flow', () => {
  it('login → session → authenticated request', async () => {
    // 1. ログイン
    const loginRes = await fetch('/api/auth/login', { ... });
    const { token } = await loginRes.json();

    // 2. 認証済みリクエスト
    const protectedRes = await fetch('/api/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(protectedRes.status).toBe(200);
  });
});
```

## 実行コマンド

```bash
# ローカル実行
DATABASE_URL=postgresql://test:test@localhost:5433/test npx vitest run --config vitest.integration.config.ts

# CI実行（GitHub Actions）
npx vitest run --config vitest.integration.config.ts
```

## カバレッジ計測

L2カバレッジ = テスト対象エンドポイント数 / 全エンドポイント数 × 100%

全エンドポイントの正常系テストを最低限とし、異常系（400/401/403/404/500）も可能な限り追加する。

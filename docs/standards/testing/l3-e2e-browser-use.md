# L3 E2E/Browser Test Guide

> ADR-010: テスト3層化 — L3 E2E/ブラウザテストの実装ガイド

---

## 概要

L3テストはstaging環境でブラウザ操作を自動化し、ユーザー視点での動作を検証します。
「テストは全PASS だが画面が動かない」問題を根本的に解消します。

## ツール選定

| ツール | 用途 | 設定場所 |
|---|---|---|
| browser-use | Claude Code統合ブラウザ自動化 | .claude/rules/browser-use-policy.md |
| Playwright | CI/CD向けヘッドレスブラウザテスト | playwright.config.ts |
| detox | React Native E2Eテスト | .detoxrc.js |

project.jsonのtesting.l3.toolに設定されたツールを使用する。

## browser-use パターン

### 基本フロー

```
1. browser-use open <staging-url>
2. browser-use state（要素確認）
3. browser-use screenshot <filename>（確認用）
4. browser-use click/input（操作）
5. browser-use close
```

### テストシナリオ例

#### ログインフロー

```
open https://staging.example.com/login
state  → メールフィールド、パスワードフィールド、ログインボタンを確認
input email "test@example.com"
input password "testpass"
screenshot login-before.png
click "ログイン"
state  → ダッシュボードのナビゲーションを確認
screenshot login-after.png
```

#### CRUD操作

```
# Create
open https://staging.example.com/items/new
input name "テストアイテム"
click "保存"
screenshot create-result.png
state  → 「テストアイテム」が一覧に表示されることを確認

# Read
open https://staging.example.com/items
state  → テーブルにアイテムが表示されることを確認

# Update
click "テストアイテム"
input name "更新アイテム"
click "更新"
screenshot update-result.png

# Delete
click "削除"
click "確認"
screenshot delete-result.png
```

## Playwright パターン（CI用）

### 設定ファイル

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: process.env.STAGING_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
```

### Page Object Model

```typescript
// tests/e2e/pages/login.page.ts
import { type Page } from '@playwright/test';

export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/login');
  }

  async login(email: string, password: string) {
    await this.page.fill('[name="email"]', email);
    await this.page.fill('[name="password"]', password);
    await this.page.click('button[type="submit"]');
  }
}
```

### テスト実装

```typescript
// tests/e2e/auth.test.ts
import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/login.page';

test('login flow', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('test@example.com', 'testpass');
  await expect(page).toHaveURL('/dashboard');
});
```

## 実行タイミング

1. staging環境へのデプロイ完了後
2. デプロイフック or CI/CDパイプラインから自動実行
3. 失敗時はスクリーンショット + trace を保存して報告

## カバレッジ計測

L3カバレッジ = テスト済み主要フロー数 / 全主要フロー数 × 100%

主要フロー = ログイン、全ページ表示、主要CRUD操作、エラーページ表示

# TESTING_STANDARDS.md - テスト規約

> テスト戦略、カバレッジ目標、テストの書き方

---

## 基本情報

| 項目 | 内容 |
|------|------|
| プロジェクト名 | |
| テストフレームワーク | Vitest / Jest |
| E2Eフレームワーク | Playwright / Cypress |
| 最終更新日 | YYYY-MM-DD |

---

## 1. テスト戦略

### 1.1 テストピラミッド

```
                    /\
                   /  \
                  / E2E \          少ない（重要フローのみ）
                 /──────\
                /        \
               / Integration\      中程度（API・DB連携）
              /──────────────\
             /                \
            /    Unit Tests    \   多い（ロジック・コンポーネント）
           /────────────────────\
```

### 1.2 テスト種別と目的

| 種別 | 対象 | 実行速度 | 割合目安 |
|------|------|---------|---------|
| Unit | 関数、コンポーネント | 高速 | 70% |
| Integration | API、DB連携 | 中程度 | 20% |
| E2E | ユーザーフロー | 低速 | 10% |

---

## 2. カバレッジ目標

### 2.1 全体目標

| メトリクス | 目標 | 必須 |
|-----------|------|------|
| Line Coverage | 80% | 70% |
| Branch Coverage | 75% | 65% |
| Function Coverage | 85% | 75% |

### 2.2 カテゴリ別目標

| カテゴリ | 目標 | 理由 |
|---------|------|------|
| ビジネスロジック | 90%+ | 重要なロジック |
| APIハンドラ | 80%+ | エラーケース含む |
| UIコンポーネント | 70%+ | 主要な状態をカバー |
| ユーティリティ | 95%+ | 単純で網羅しやすい |

### 2.3 カバレッジ除外

```javascript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'src/types/**',
        'src/constants/**',
        '**/*.config.*',
        '**/*.d.ts',
      ]
    }
  }
});
```

---

## 3. テストファイル配置

### 3.1 配置パターン

**パターン A: 同階層配置（推奨）**

```
src/
├── components/
│   ├── Button.tsx
│   └── Button.test.tsx    ← 同階層
├── lib/
│   ├── utils.ts
│   └── utils.test.ts      ← 同階層
```

**パターン B: __tests__ディレクトリ**

```
src/
├── components/
│   ├── __tests__/
│   │   └── Button.test.tsx
│   └── Button.tsx
```

### 3.2 命名規則

| 種別 | パターン | 例 |
|------|---------|-----|
| Unit | `{name}.test.ts(x)` | `utils.test.ts` |
| Integration | `{name}.integration.test.ts` | `api.integration.test.ts` |
| E2E | `{flow}.e2e.ts` | `login.e2e.ts` |

---

## 4. テストの書き方

### 4.1 基本構造（AAA パターン）

```typescript
describe('UserService', () => {
  describe('getUser', () => {
    it('should return user when valid id is provided', async () => {
      // Arrange（準備）
      const userId = 'user-123';
      const mockUser = { id: userId, name: 'John' };
      mockDb.users.findUnique.mockResolvedValue(mockUser);

      // Act（実行）
      const result = await userService.getUser(userId);

      // Assert（検証）
      expect(result).toEqual(mockUser);
      expect(mockDb.users.findUnique).toHaveBeenCalledWith({
        where: { id: userId }
      });
    });
  });
});
```

### 4.2 テスト命名規則

```typescript
// ✅ Good: should + 期待動作 + 条件
it('should return null when user is not found', () => {});
it('should throw error when email is invalid', () => {});
it('should update user when valid data is provided', () => {});

// ❌ Bad: 曖昧、条件がない
it('works correctly', () => {});
it('handles user', () => {});
```

### 4.3 describeのネスト

```typescript
describe('AuthService', () => {
  describe('login', () => {
    describe('when credentials are valid', () => {
      it('should return access token', () => {});
      it('should create session', () => {});
    });

    describe('when password is incorrect', () => {
      it('should throw AuthenticationError', () => {});
      it('should increment failed attempts', () => {});
    });

    describe('when account is locked', () => {
      it('should throw AccountLockedError', () => {});
    });
  });
});
```

---

## 5. モック

### 5.1 モック方針

| 対象 | モック | 理由 |
|------|-------|------|
| 外部API | ✅ する | 不安定、コスト |
| データベース | ✅ する（Unit） | 速度 |
| ファイルシステム | ✅ する | 副作用 |
| 日時 | ✅ する | 再現性 |
| 他のサービスクラス | 場合による | 依存関係 |

### 5.2 モックの書き方

```typescript
// 関数のモック
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// モジュールのモック
vi.mock('@/lib/db', () => ({
  db: {
    users: {
      findUnique: vi.fn(),
      create: vi.fn(),
    }
  }
}));

// 日時のモック
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-01-15'));
});

afterEach(() => {
  vi.useRealTimers();
});
```

### 5.3 モックのリセット

```typescript
beforeEach(() => {
  vi.clearAllMocks();  // 呼び出し履歴をクリア
});

afterEach(() => {
  vi.resetAllMocks();  // 実装もリセット
});
```

---

## 6. Reactコンポーネントテスト

### 6.1 Testing Library

```typescript
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from './LoginForm';

describe('LoginForm', () => {
  it('should submit form with email and password', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    
    render(<LoginForm onSubmit={onSubmit} />);

    // 入力
    await user.type(screen.getByLabelText('メールアドレス'), 'test@example.com');
    await user.type(screen.getByLabelText('パスワード'), 'password123');
    
    // 送信
    await user.click(screen.getByRole('button', { name: 'ログイン' }));

    // 検証
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123'
      });
    });
  });

  it('should show error when email is invalid', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText('メールアドレス'), 'invalid');
    await user.click(screen.getByRole('button', { name: 'ログイン' }));

    expect(screen.getByText('有効なメールアドレスを入力してください')).toBeInTheDocument();
  });
});
```

### 6.2 クエリ優先順位

| 優先度 | クエリ | 用途 |
|-------|-------|------|
| 1 | `getByRole` | アクセシビリティ |
| 2 | `getByLabelText` | フォーム要素 |
| 3 | `getByPlaceholderText` | 入力フィールド |
| 4 | `getByText` | テキスト |
| 5 | `getByTestId` | 最終手段 |

---

## 7. APIテスト

### 7.1 ハンドラテスト

```typescript
import { createMocks } from 'node-mocks-http';
import { POST } from '@/app/api/auth/login/route';

describe('POST /api/auth/login', () => {
  it('should return 200 with token when credentials are valid', async () => {
    const { req } = createMocks({
      method: 'POST',
      body: {
        email: 'test@example.com',
        password: 'password123'
      }
    });

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('access_token');
  });

  it('should return 401 when password is incorrect', async () => {
    const { req } = createMocks({
      method: 'POST',
      body: {
        email: 'test@example.com',
        password: 'wrong-password'
      }
    });

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe('AUTH_001');
  });
});
```

---

## 8. E2Eテスト

### 8.1 Playwright設定

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
});
```

### 8.2 E2Eテスト例

```typescript
// e2e/login.e2e.ts
import { test, expect } from '@playwright/test';

test.describe('Login Flow', () => {
  test('should login successfully with valid credentials', async ({ page }) => {
    await page.goto('/login');

    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'password123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('/app');
    await expect(page.locator('text=ダッシュボード')).toBeVisible();
  });

  test('should show error with invalid credentials', async ({ page }) => {
    await page.goto('/login');

    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'wrong-password');
    await page.click('button[type="submit"]');

    await expect(page.locator('text=メールアドレスまたはパスワードが正しくありません')).toBeVisible();
  });
});
```

---

## 9. テストデータ

### 9.1 Factory パターン

```typescript
// tests/factories/user.factory.ts
import { faker } from '@faker-js/faker';
import type { User } from '@/types';

export function createUser(overrides?: Partial<User>): User {
  return {
    id: faker.string.uuid(),
    email: faker.internet.email(),
    name: faker.person.fullName(),
    createdAt: faker.date.past(),
    ...overrides
  };
}

// 使用例
const user = createUser({ name: 'Test User' });
```

### 9.2 Fixture

```typescript
// tests/fixtures/users.ts
export const testUsers = {
  admin: {
    id: 'user-admin',
    email: 'admin@example.com',
    role: 'admin'
  },
  user: {
    id: 'user-normal',
    email: 'user@example.com',
    role: 'user'
  }
};
```

---

## 10. CI設定

### 10.1 GitHub Actions

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      
      - run: pnpm install
      - run: pnpm test:coverage
      
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
      
      - run: pnpm install
      - run: pnpm exec playwright install --with-deps
      - run: pnpm test:e2e
      
      - uses: actions/upload-artifact@v3
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
```

---

## 11. チェックリスト

### 11.1 テスト作成時

- [ ] 正常系をテストした
- [ ] 異常系（エラーケース）をテストした
- [ ] 境界値をテストした
- [ ] モックを適切に使用した
- [ ] テスト名が明確

### 11.2 PRレビュー時

- [ ] テストが追加/更新されている
- [ ] カバレッジが下がっていない
- [ ] テストが実際に動作を検証している
- [ ] フレイキー（不安定）なテストがない

---

## 変更履歴

| 日付 | 変更内容 | 変更者 |
|------|---------|-------|
| | 初版作成 | |

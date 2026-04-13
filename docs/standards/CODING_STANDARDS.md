# CODING_STANDARDS.md - コーディング規約

> プロジェクト全体で統一するコーディングルール

---

## 基本情報

| 項目 | 内容 |
|------|------|
| プロジェクト名 | |
| 言語 | TypeScript |
| 最終更新日 | YYYY-MM-DD |

---

## 1. 命名規則

### 1.1 ファイル・ディレクトリ

| 種類 | 規則 | 例 |
|------|------|-----|
| ディレクトリ | kebab-case | `user-settings/` |
| Reactコンポーネント | PascalCase | `UserProfile.tsx` |
| その他のファイル | kebab-case | `api-client.ts` |
| テストファイル | 同名 + `.test` | `api-client.test.ts` |
| 型定義ファイル | 同名 + `.types` | `user.types.ts` |

### 1.2 変数・関数

| 種類 | 規則 | 例 |
|------|------|-----|
| 変数 | camelCase | `userName` |
| 定数 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| 関数 | camelCase | `getUserById()` |
| クラス | PascalCase | `UserService` |
| 型/インターフェース | PascalCase | `UserProfile` |
| Enum | PascalCase + UPPER_SNAKE_CASE | `enum Status { ACTIVE, INACTIVE }` |
| 真偽値変数 | is/has/can + 名詞 | `isLoading`, `hasError`, `canEdit` |
| イベントハンドラ | handle + イベント名 | `handleClick`, `handleSubmit` |

### 1.3 コンポーネント

| 種類 | 規則 | 例 |
|------|------|-----|
| コンポーネント | PascalCase | `UserProfile` |
| Props型 | コンポーネント名 + Props | `UserProfileProps` |
| カスタムフック | use + 名詞 | `useUserProfile` |
| Context | 名詞 + Context | `AuthContext` |

### 1.4 API・DB

| 種類 | 規則 | 例 |
|------|------|-----|
| APIエンドポイント | kebab-case, 複数形 | `/api/v1/user-profiles` |
| テーブル名 | snake_case, 複数形 | `user_profiles` |
| カラム名 | snake_case | `created_at` |

---

## 2. ディレクトリ構造

### 2.1 プロジェクト構造

```
src/
├── app/                    # Next.js App Router
│   ├── (auth)/             # 認証グループ
│   │   ├── login/
│   │   └── signup/
│   ├── (dashboard)/        # ダッシュボードグループ
│   │   └── ...
│   ├── api/                # API Routes
│   │   └── v1/
│   ├── layout.tsx
│   └── page.tsx
│
├── components/             # 共有コンポーネント
│   ├── ui/                 # UIプリミティブ（Button, Input等）
│   ├── forms/              # フォーム関連
│   ├── layouts/            # レイアウト（Header, Footer等）
│   └── features/           # 機能別コンポーネント
│       ├── auth/
│       └── user/
│
├── hooks/                  # カスタムフック
│   ├── use-auth.ts
│   └── use-user.ts
│
├── lib/                    # ユーティリティ・設定
│   ├── api/                # APIクライアント
│   ├── db/                 # DB接続・クエリ
│   ├── auth/               # 認証ロジック
│   └── utils/              # 汎用ユーティリティ
│
├── types/                  # 型定義
│   ├── api.types.ts
│   └── user.types.ts
│
└── constants/              # 定数
    └── index.ts
```

### 2.2 コンポーネント構造

```
components/features/user/
├── UserProfile.tsx         # メインコンポーネント
├── UserProfile.test.tsx    # テスト
├── UserAvatar.tsx          # サブコンポーネント
├── user-profile.types.ts   # 型定義
└── index.ts                # エクスポート
```

---

## 3. TypeScript

### 3.1 型定義

```typescript
// ✅ Good: インターフェースで型定義
interface User {
  id: string;
  name: string;
  email: string;
}

// ✅ Good: 型エイリアスは Union/Intersection に使用
type Status = 'active' | 'inactive' | 'pending';
type UserWithStatus = User & { status: Status };

// ❌ Bad: any は使用しない
const data: any = fetchData();

// ✅ Good: unknown を使用し、型ガードで絞り込む
const data: unknown = fetchData();
if (isUser(data)) {
  console.log(data.name);
}
```

### 3.2 Null/Undefined

```typescript
// ✅ Good: オプショナルチェーン
const name = user?.profile?.name;

// ✅ Good: Nullish Coalescing
const displayName = user.name ?? 'Anonymous';

// ❌ Bad: 非nullアサーション（極力避ける）
const name = user!.name;
```

### 3.3 型のエクスポート

```typescript
// types/user.types.ts
export interface User {
  id: string;
  name: string;
}

export type UserStatus = 'active' | 'inactive';

// 使用側
import type { User, UserStatus } from '@/types/user.types';
```

---

## 4. React

### 4.1 コンポーネント定義

```typescript
// ✅ Good: 関数コンポーネント + Props型
interface UserProfileProps {
  user: User;
  onEdit?: () => void;
}

export function UserProfile({ user, onEdit }: UserProfileProps) {
  return (
    <div>
      <h1>{user.name}</h1>
      {onEdit && <button onClick={onEdit}>Edit</button>}
    </div>
  );
}

// ❌ Bad: デフォルトエクスポート（名前付きエクスポートを推奨）
export default function UserProfile() {}
```

### 4.2 Hooks

```typescript
// ✅ Good: カスタムフックの命名と構造
export function useUser(userId: string) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // fetch logic
  }, [userId]);

  return { user, isLoading, error };
}

// ✅ Good: 早期リターン
if (isLoading) return <Spinner />;
if (error) return <ErrorMessage error={error} />;
return <UserProfile user={user} />;
```

### 4.3 イベントハンドラ

```typescript
// ✅ Good: handle + イベント名
const handleSubmit = async (e: FormEvent) => {
  e.preventDefault();
  // ...
};

const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
  setValue(e.target.value);
};

// ✅ Good: useCallbackは必要な場合のみ
const handleClick = useCallback(() => {
  // 重い処理 or 子コンポーネントに渡す場合
}, [dependency]);
```

---

## 5. インポート

### 5.1 インポート順序

```typescript
// 1. React
import { useState, useEffect } from 'react';

// 2. 外部ライブラリ
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

// 3. 内部モジュール（絶対パス）
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { api } from '@/lib/api';

// 4. 型（type import）
import type { User } from '@/types/user.types';

// 5. 相対パス（同階層・下位）
import { UserAvatar } from './UserAvatar';
import styles from './styles.module.css';
```

### 5.2 パスエイリアス

```typescript
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}

// 使用例
import { Button } from '@/components/ui/button';
```

---

## 6. コメント

### 6.1 基本ルール

```typescript
// ✅ Good: WHY（なぜ）を説明
// レート制限により、リクエスト間に100ms待機が必要
await sleep(100);

// ❌ Bad: WHAT（何を）は自明なので不要
// userIdでユーザーを取得
const user = await getUser(userId);
```

### 6.2 JSDoc

```typescript
/**
 * ユーザーのプロフィールを更新する
 * 
 * @param userId - 更新対象のユーザーID
 * @param data - 更新データ
 * @returns 更新後のユーザー
 * @throws {NotFoundError} ユーザーが存在しない場合
 */
export async function updateUser(
  userId: string,
  data: UpdateUserInput
): Promise<User> {
  // ...
}
```

### 6.3 TODO/FIXME

```typescript
// TODO: パフォーマンス改善 - キャッシュ導入を検討
// FIXME: エッジケースでnullが返る可能性あり
// HACK: 一時的な回避策、Issue #123 で修正予定
```

---

## 7. エラーハンドリング

### 7.1 基本パターン

```typescript
// ✅ Good: 明示的なエラーハンドリング
try {
  const user = await getUser(userId);
  return user;
} catch (error) {
  if (error instanceof NotFoundError) {
    return null;
  }
  throw error; // 予期しないエラーは再スロー
}

// ✅ Good: Result型パターン（任意）
type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };
```

### 7.2 API エラー

```typescript
// lib/api/errors.ts
export class ApiError extends Error {
  constructor(
    public code: string,
    public message: string,
    public status: number
  ) {
    super(message);
  }
}

// 使用例
if (!response.ok) {
  const error = await response.json();
  throw new ApiError(error.code, error.message, response.status);
}
```

---

## 8. フォーマット設定

### 8.1 Prettier

```json
// .prettierrc
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 80,
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

### 8.2 ESLint

```javascript
// .eslintrc.js
module.exports = {
  extends: [
    'next/core-web-vitals',
    'plugin:@typescript-eslint/recommended',
    'prettier'
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    'prefer-const': 'error',
    'no-console': ['warn', { allow: ['warn', 'error'] }]
  }
};
```

---

## 9. Git コミット前チェック

### 9.1 lint-staged

```json
// package.json
{
  "lint-staged": {
    "*.{ts,tsx}": [
      "eslint --fix",
      "prettier --write"
    ]
  }
}
```

### 9.2 husky

```bash
# .husky/pre-commit
pnpm lint-staged
pnpm type-check
```

---

## 10. 禁止事項

| 禁止事項 | 理由 | 代替案 |
|---------|------|-------|
| `any` 型の使用 | 型安全性が失われる | `unknown` + 型ガード |
| `// @ts-ignore` | 型エラーを隠蔽 | 適切な型定義 |
| `console.log` (本番) | デバッグコードの残留 | ロガーを使用 |
| マジックナンバー | 意味が不明 | 定数として定義 |
| ネストの深いコード | 可読性低下 | 早期リターン、関数分割 |

---

## 変更履歴

| 日付 | 変更内容 | 変更者 |
|------|---------|-------|
| | 初版作成 | |

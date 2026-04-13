# GIT_WORKFLOW.md - Git運用規約

> ブランチ戦略、コミット規約、PR運用ルール

---

## 基本情報

| 項目 | 内容 |
|------|------|
| プロジェクト名 | |
| ブランチ戦略 | GitHub Flow / Git Flow / Trunk-Based |
| 最終更新日 | YYYY-MM-DD |

---

## 1. ブランチ戦略

### 1.1 GitHub Flow（推奨：小〜中規模）

```
main ─────●─────●─────●─────●─────●─────→
           \         /       \         /
            feature/xxx      feature/yyy
```

| ブランチ | 用途 | 保護 |
|---------|------|------|
| `main` | 本番環境 | ✅ 保護 |
| `feature/*` | 機能開発 | - |
| `fix/*` | バグ修正 | - |
| `hotfix/*` | 緊急修正 | - |

### 1.2 Git Flow（中〜大規模）

```
main ─────●───────────────────────●─────→
           \                     /
develop ────●─────●─────●─────●─────────→
             \   /       \   /
              feature     feature
```

| ブランチ | 用途 | 保護 |
|---------|------|------|
| `main` | 本番環境 | ✅ 保護 |
| `develop` | 開発統合 | ✅ 保護 |
| `feature/*` | 機能開発 | - |
| `release/*` | リリース準備 | - |
| `hotfix/*` | 緊急修正 | - |

---

## 2. ブランチ命名規則

### 2.1 フォーマット

```
{type}/{issue-number}-{short-description}
```

### 2.2 タイプ一覧

| タイプ | 用途 | 例 |
|-------|------|-----|
| `feature` | 新機能 | `feature/123-user-login` |
| `fix` | バグ修正 | `fix/456-login-validation` |
| `hotfix` | 緊急修正 | `hotfix/789-security-patch` |
| `refactor` | リファクタリング | `refactor/101-api-client` |
| `docs` | ドキュメント | `docs/102-readme-update` |
| `chore` | 雑務（依存更新等） | `chore/103-upgrade-deps` |

### 2.3 命名ルール

- 英小文字のみ
- 単語はハイフン区切り
- 50文字以内
- Issue番号を含める（あれば）

```bash
# ✅ Good
feature/123-user-authentication
fix/456-email-validation-error

# ❌ Bad
Feature/UserAuth           # 大文字
feature/user_auth          # アンダースコア
feature/implementUserAuthenticationFeature  # 長すぎる
```

---

## 3. コミットメッセージ

### 3.1 Conventional Commits

```
{type}({scope}): {subject}

{body}

{footer}
```

### 3.2 タイプ一覧

| タイプ | 用途 | 例 |
|-------|------|-----|
| `feat` | 新機能 | `feat(auth): add login endpoint` |
| `fix` | バグ修正 | `fix(auth): validate email format` |
| `docs` | ドキュメント | `docs(readme): add setup guide` |
| `style` | フォーマット | `style: format with prettier` |
| `refactor` | リファクタリング | `refactor(api): extract validation` |
| `test` | テスト | `test(auth): add login tests` |
| `chore` | 雑務 | `chore(deps): upgrade next to 14` |
| `perf` | パフォーマンス | `perf(db): add index to users` |
| `ci` | CI/CD | `ci: add lint workflow` |
| `revert` | リバート | `revert: feat(auth): add login` |

### 3.3 ルール

| ルール | 説明 |
|-------|------|
| 現在形 | `add` not `added` |
| 小文字開始 | `add feature` not `Add feature` |
| 末尾ピリオドなし | `add feature` not `add feature.` |
| 50文字以内（subject） | 簡潔に |
| 命令形 | `add` not `adds` / `adding` |

### 3.4 例

```bash
# ✅ Good
feat(auth): add JWT token refresh endpoint

Implement token refresh logic with the following:
- Check refresh token validity
- Generate new access token
- Update session in database

Closes #123

# ❌ Bad
updated login stuff    # タイプなし、曖昧
feat: Add New Feature  # 大文字、曖昧
```

---

## 4. プルリクエスト

### 4.1 PRテンプレート

```markdown
## 概要
<!-- このPRで何を実現するか -->

## 関連Issue
<!-- Closes #123 -->

## 変更内容
- 
- 
- 

## 確認項目
- [ ] ローカルで動作確認済み
- [ ] テストを追加/更新した
- [ ] lint/型チェックが通る
- [ ] ドキュメントを更新した（必要な場合）

## スクリーンショット（UI変更がある場合）
<!-- 変更前後のスクリーンショット -->

## レビュー観点
<!-- レビュアーに特に見てほしい点 -->
```

### 4.2 PRルール

| ルール | 設定 |
|-------|------|
| タイトル形式 | Conventional Commits形式 |
| 最小レビュアー数 | 1人以上 |
| マージ方式 | Squash and merge |
| マージ後のブランチ | 自動削除 |
| CI必須 | lint, test, type-check |

### 4.3 PRサイズ

| サイズ | 行数目安 | 推奨 |
|-------|---------|------|
| XS | < 50行 | ✅ 理想的 |
| S | 50-200行 | ✅ 良い |
| M | 200-500行 | ⚠️ 分割を検討 |
| L | 500行以上 | ❌ 分割必須 |

---

## 5. マージ戦略

### 5.1 Squash and Merge（推奨）

```bash
# 複数コミットを1つにまとめてマージ
feature/xxx: a → b → c → d
            ↓
main: ●─────────────────●
                        └── feat(auth): add login (#123)
```

**メリット**:
- 履歴がクリーン
- コミットメッセージを整理できる
- revertが容易

### 5.2 Rebase and Merge

```bash
# コミットを維持してリベース
feature/xxx: a → b → c
            ↓
main: ●─────────────────a'─b'─c'
```

**用途**: コミット履歴を残したい場合

### 5.3 Merge Commit

```bash
# マージコミットを作成
main: ●─────────────────●
       \               /
        a → b → c ────┘
```

**用途**: Git Flowでdevelop→mainの場合

---

## 6. 保護ブランチ設定

### 6.1 mainブランチ

| 設定 | 値 |
|------|-----|
| 直接プッシュ | ❌ 禁止 |
| 必須レビュー数 | 1 |
| ステータスチェック必須 | lint, test, type-check |
| 最新コミット必須 | ✅ |
| 管理者も対象 | ✅ |

### 6.2 developブランチ（Git Flow使用時）

| 設定 | 値 |
|------|-----|
| 直接プッシュ | ❌ 禁止 |
| 必須レビュー数 | 1 |
| ステータスチェック必須 | lint, test |

---

## 7. 運用フロー

### 7.1 機能開発

```bash
# 1. 最新のmainから分岐
git checkout main
git pull origin main
git checkout -b feature/123-user-login

# 2. 開発・コミット
git add .
git commit -m "feat(auth): add login form"

# 3. プッシュ
git push origin feature/123-user-login

# 4. PRを作成（GitHub/GitLabで）

# 5. レビュー・修正

# 6. マージ（Squash and merge）

# 7. ローカルブランチ削除
git checkout main
git pull origin main
git branch -d feature/123-user-login
```

### 7.2 緊急修正（Hotfix）

```bash
# 1. mainから分岐
git checkout main
git pull origin main
git checkout -b hotfix/999-critical-fix

# 2. 修正・コミット
git add .
git commit -m "fix(auth): patch security vulnerability"

# 3. PRを作成（優先レビュー）

# 4. マージ後、即座にデプロイ
```

---

## 8. コンフリクト解消

### 8.1 基本手順

```bash
# 1. 最新のmainを取得
git checkout main
git pull origin main

# 2. 作業ブランチに戻る
git checkout feature/xxx

# 3. mainをマージ（またはリベース）
git merge main
# または
git rebase main

# 4. コンフリクトを解消
# エディタでコンフリクトマーカーを削除
# <<<<<<< HEAD
# =======
# >>>>>>> main

# 5. 解消後
git add .
git commit -m "resolve conflicts with main"
# または（リベースの場合）
git rebase --continue

# 6. プッシュ
git push origin feature/xxx --force-with-lease  # リベースの場合
```

---

## 9. Git Hooks

### 9.1 pre-commit

```bash
#!/bin/sh
# .husky/pre-commit

pnpm lint-staged
```

### 9.2 commit-msg

```bash
#!/bin/sh
# .husky/commit-msg

npx --no -- commitlint --edit $1
```

### 9.3 commitlint設定

```javascript
// commitlint.config.js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'revert']
    ],
    'subject-max-length': [2, 'always', 72]
  }
};
```

---

## 10. 禁止事項

| 禁止事項 | 理由 |
|---------|------|
| mainへの直接プッシュ | レビューを経由しない |
| `--force` プッシュ（共有ブランチ） | 他の人の作業を消す可能性 |
| 巨大なPR（500行以上） | レビュー品質低下 |
| WIPコミットのまま放置 | 履歴が汚れる |
| 機密情報のコミット | セキュリティリスク |

---

## 変更履歴

| 日付 | 変更内容 | 変更者 |
|------|---------|-------|
| | 初版作成 | |

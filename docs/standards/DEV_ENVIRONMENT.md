# DEV_ENVIRONMENT.md - 開発環境定義書

> 開発環境の構築手順と必要なツールを定義

---

## 基本情報

| 項目 | 内容 |
|------|------|
| プロジェクト名 | |
| 最終更新日 | YYYY-MM-DD |
| 対象OS | macOS / Windows / Linux |

---

## 1. 必要なツール

### 1.1 必須ツール

| ツール | バージョン | 用途 | インストール方法 |
|-------|-----------|------|----------------|
| Node.js | v20.x LTS | ランタイム | `nvm install 20` |
| pnpm | 8.x | パッケージ管理 | `npm install -g pnpm` |
| Git | 2.40+ | バージョン管理 | OS標準 or Homebrew |
| Docker | 24.x | コンテナ | Docker Desktop |

### 1.2 推奨ツール

| ツール | 用途 | インストール方法 |
|-------|------|----------------|
| VS Code | エディタ | 公式サイト |
| TablePlus / DBeaver | DBクライアント | 公式サイト |
| Postman / Insomnia | API テスト | 公式サイト |

---

## 2. 環境構築手順

### 2.1 リポジトリのクローン

```bash
git clone {REPOSITORY_URL}
cd {PROJECT_NAME}
```

### 2.2 依存パッケージのインストール

```bash
pnpm install
```

### 2.3 環境変数の設定

```bash
# .env.example をコピー
cp .env.example .env.local

# 必要な値を設定（下記「環境変数一覧」参照）
```

### 2.4 データベースのセットアップ

**オプション A: Docker（推奨）**

```bash
# コンテナ起動
docker-compose up -d

# マイグレーション実行
pnpm db:migrate

# シードデータ投入（任意）
pnpm db:seed
```

**オプション B: ローカルインストール**

```bash
# PostgreSQLをインストール後
createdb {DATABASE_NAME}

# マイグレーション実行
pnpm db:migrate
```

### 2.5 開発サーバーの起動

```bash
pnpm dev
```

アクセス: http://localhost:3000

---

## 3. 環境変数一覧

### 3.1 必須

| 変数名 | 説明 | 例 | 取得方法 |
|--------|------|-----|---------|
| `DATABASE_URL` | DB接続文字列 | `postgresql://user:pass@localhost:5432/db` | ローカル設定 |
| `NEXTAUTH_SECRET` | 認証シークレット | ランダム文字列 | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | 認証コールバックURL | `http://localhost:3000` | 固定値 |

### 3.2 任意（機能別）

| 変数名 | 説明 | 必要な機能 | 取得方法 |
|--------|------|-----------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth | OAuth認証 | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Google OAuth | OAuth認証 | Google Cloud Console |
| `OPENAI_API_KEY` | OpenAI API | AI機能 | OpenAI ダッシュボード |
| `RESEND_API_KEY` | メール送信 | メール通知 | Resend ダッシュボード |
| `STRIPE_SECRET_KEY` | 決済 | 課金機能 | Stripe ダッシュボード |

### 3.3 環境変数テンプレート（.env.example）

```bash
# ===================
# Database
# ===================
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/{project_name}"

# ===================
# Authentication
# ===================
NEXTAUTH_SECRET=""
NEXTAUTH_URL="http://localhost:3000"

# Google OAuth（任意）
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

# ===================
# External Services（任意）
# ===================
# OPENAI_API_KEY=""
# RESEND_API_KEY=""
# STRIPE_SECRET_KEY=""
```

---

## 4. Docker構成

### 4.1 docker-compose.yml

```yaml
version: '3.8'

services:
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: {project_name}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### 4.2 Dockerコマンド

| コマンド | 説明 |
|---------|------|
| `docker-compose up -d` | コンテナ起動 |
| `docker-compose down` | コンテナ停止 |
| `docker-compose logs -f` | ログ確認 |
| `docker-compose down -v` | コンテナ + ボリューム削除 |

---

## 5. よく使うコマンド

### 5.1 開発

| コマンド | 説明 |
|---------|------|
| `pnpm dev` | 開発サーバー起動 |
| `pnpm build` | ビルド |
| `pnpm start` | 本番モードで起動 |
| `pnpm lint` | リント実行 |
| `pnpm format` | フォーマット実行 |
| `pnpm type-check` | 型チェック |

### 5.2 データベース

| コマンド | 説明 |
|---------|------|
| `pnpm db:migrate` | マイグレーション実行 |
| `pnpm db:migrate:create` | マイグレーションファイル作成 |
| `pnpm db:seed` | シードデータ投入 |
| `pnpm db:reset` | DB初期化（データ全削除） |
| `pnpm db:studio` | DB GUI起動（Prisma Studio等） |

### 5.3 テスト

| コマンド | 説明 |
|---------|------|
| `pnpm test` | テスト実行 |
| `pnpm test:watch` | ウォッチモード |
| `pnpm test:coverage` | カバレッジ付き |
| `pnpm test:e2e` | E2Eテスト |

---

## 6. IDE設定

### 6.1 VS Code 推奨拡張機能

```json
// .vscode/extensions.json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "prisma.prisma",
    "bradlc.vscode-tailwindcss",
    "formulahendry.auto-rename-tag",
    "streetsidesoftware.code-spell-checker"
  ]
}
```

### 6.2 VS Code 設定

```json
// .vscode/settings.json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

---

## 7. トラブルシューティング

### 7.1 よくある問題

| 問題 | 原因 | 解決策 |
|------|------|-------|
| `pnpm install` が失敗する | Node.jsバージョン不一致 | `nvm use` でバージョン切り替え |
| DBに接続できない | コンテナ未起動 | `docker-compose up -d` |
| ポートが使用中 | 他プロセスが使用中 | `lsof -i :3000` で確認・終了 |
| 環境変数が読み込まれない | .env.localがない | `.env.example`からコピー |
| マイグレーションエラー | DBスキーマ不整合 | `pnpm db:reset`（開発環境のみ） |

### 7.2 キャッシュクリア

```bash
# Node modules再インストール
rm -rf node_modules
pnpm install

# Next.jsキャッシュクリア
rm -rf .next

# Prismaクライアント再生成
pnpm prisma generate
```

---

## 8. 初回セットアップチェックリスト

| # | 項目 | 完了 |
|---|------|------|
| 1 | Node.js v20.x がインストールされている | ☐ |
| 2 | pnpm がインストールされている | ☐ |
| 3 | Docker Desktop が起動している | ☐ |
| 4 | リポジトリをクローンした | ☐ |
| 5 | `pnpm install` が成功した | ☐ |
| 6 | `.env.local` を作成した | ☐ |
| 7 | 必須の環境変数を設定した | ☐ |
| 8 | `docker-compose up -d` が成功した | ☐ |
| 9 | `pnpm db:migrate` が成功した | ☐ |
| 10 | `pnpm dev` で起動し、ブラウザで確認できた | ☐ |

**全てチェックできたら環境構築完了！**

---

## 変更履歴

| 日付 | 変更内容 | 変更者 |
|------|---------|-------|
| | 初版作成 | |

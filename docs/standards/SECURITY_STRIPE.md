# SECURITY_STRIPE.md - Stripe 決済セキュリティ基準

> Stripe 本番運用および日本の割賦販売法に対応するためのセキュリティ基準。
> 開発チーム全員が遵守すべき最低限の要件を定義する。

---

## 基本情報

| 項目 | 内容 |
|------|------|
| プロジェクト | {{PROJECT_NAME}} |
| Stripe 統合方式 | {{STRIPE_INTEGRATION}} <!-- Stripe Checkout（リダイレクト型）/ Stripe Elements（埋込型）--> |
| PCI DSS 対応レベル | {{PCI_LEVEL}} <!-- SAQ A（非保持・非通過）/ SAQ A-EP（Elements利用時）--> |
| 適用法令 | 割賦販売法、クレジットカード・セキュリティガイドライン 6.0 |
| 最終更新日 | {{DATE}} |

---

## 1. PCI DSS コンプライアンス

### 1.1 共有責任モデル

Stripe を利用する場合でも、PCI DSS 準拠は **加盟店（当プロジェクト）の責任** である。

| 責任範囲 | Stripe | 加盟店 |
|----------|--------|--------|
| カードデータの処理・保存 | ✅ Stripe が担当 | ❌ 触れない |
| TLS/HTTPS の確保 | ✅ Stripe API 側 | ✅ 自社サイト側 |
| API キーの管理 | ✅ 生成・ローテーション提供 | ✅ 安全な保管・運用 |
| Webhook 署名検証 | ✅ 署名生成 | ✅ 検証実装 |
| PCI 準拠の年次検証 | - | ✅ SAQ A の提出 |

### 1.2 SAQ A 適格条件

Stripe Checkout（リダイレクト型）を使用する場合、最も軽量な **SAQ A** で準拠可能。
以下の条件を**すべて**満たすこと:

- [ ] カード情報が自社サーバーを通過しない
- [ ] 決済ページは Stripe がホスト（Checkout Session でリダイレクト）
- [ ] 自社ページに直接カード入力フォームを実装しない
- [ ] Stripe.js / Elements を使う場合は iframe 内でのみカードデータを扱う

### 1.3 保存可能なデータ / 保存禁止データ

| データ | 保存可否 | 備考 |
|--------|----------|------|
| カード番号（PAN） | ❌ 禁止 | Stripe が管理 |
| CVV / CVC | ❌ 禁止 | 一時的にも保存不可 |
| カード種別（Visa等） | ✅ 可能 | API レスポンスから取得 |
| 下4桁 | ✅ 可能 | 表示用 |
| 有効期限 | ✅ 可能 | API レスポンスから取得 |
| Stripe Customer ID | ✅ 可能 | DB に保存 |
| Subscription ID | ✅ 可能 | DB に保存 |

---

## 2. TLS / HTTPS 要件

### 2.1 必須要件

- [ ] 本番環境で **TLS 1.2 以上** を使用
- [ ] 有効な SSL 証明書を使用（Let's Encrypt 等）
- [ ] 全ページを HTTPS で配信（混合コンテンツ禁止）
- [ ] JavaScript / CSS / 画像を含むすべてのリソースを HTTPS 経由で配信
- [ ] Webhook エンドポイントは HTTPS 必須（本番モード）

### 2.2 検証方法

```bash
# SSL Labs でサーバー設定を検証（A 評価以上を目標）
# https://www.ssllabs.com/ssltest/
curl -I https://{{DOMAIN}}
# Strict-Transport-Security ヘッダーの確認
```

### 2.3 実装状況

<!-- プロジェクト固有: 実際の対応状況を記入 -->

| 項目 | 状態 | 備考 |
|------|------|------|
| HTTPS（Let's Encrypt） | 🔲 | |
| TLS 1.2+ | 🔲 | |
| HSTS ヘッダー | 🔲 | |
| 混合コンテンツなし | 🔲 | |

---

## 3. API キー管理

### 3.1 キーの種類と用途

| キー種別 | プレフィックス | 用途 | 公開範囲 |
|----------|--------------|------|----------|
| Publishable Key | `pk_live_` / `pk_test_` | クライアント側 Stripe.js | フロントエンドに公開可 |
| Secret Key | `sk_live_` / `sk_test_` | サーバー側 API 呼び出し | サーバーのみ、絶対に公開禁止 |
| Webhook Secret | `whsec_` | Webhook 署名検証 | サーバーのみ |
| Restricted Key | `rk_live_` / `rk_test_` | 限定的 API アクセス | 用途に応じて |

### 3.2 必須ルール

- [ ] Secret Key を**ソースコードにハードコードしない**
- [ ] Secret Key を **Git リポジトリにコミットしない**（`.env` は `.gitignore` に含める）
- [ ] Secret Key を **メール・チャット・チケットで共有しない**
- [ ] 環境変数（`.env.production`）で管理し、アクセス権を制限
- [ ] テスト環境では `sk_test_` / `pk_test_` を使用（本番キーを開発に使わない）
- [ ] 漏洩の疑いがある場合は **即座に Stripe Dashboard でローテーション**

### 3.3 環境変数の設定

```
# .env.production（本番サーバー、権限を制限）
STRIPE_SECRET_KEY=sk_live_xxxxx      # サーバー側のみ使用
STRIPE_PUBLISHABLE_KEY=pk_live_xxxxx # クライアントに公開
STRIPE_WEBHOOK_SECRET=whsec_xxxxx    # Webhook 検証用
```

### 3.4 推奨追加対策

- [ ] IP アドレス制限（本番サーバーの固定 IP のみ許可）— Stripe Dashboard で設定可能
- [ ] Restricted Key の活用（必要最小限の権限のみ付与）
- [ ] API リクエストログの定期監査

---

## 4. Webhook セキュリティ

### 4.1 必須要件

- [ ] **署名検証を必ず実装**（`stripe.webhooks.constructEvent()` を使用）
- [ ] Webhook Secret（`whsec_`）で HMAC 署名を検証
- [ ] リプレイ攻撃防止のためタイムスタンプを検証（Stripe SDK が自動で実施）
- [ ] HTTPS エンドポイントのみ使用
- [ ] Webhook イベントの冪等性を保証（同一イベントの重複処理を防止）

### 4.2 実装パターン

```typescript
// Webhook エンドポイントの実装例
// ✅ stripe.webhooks.constructEvent() で署名検証
// ✅ event.type でイベント種別を判定
// ✅ 冪等性: subscriptionId ベースで重複更新を防止
```

### 4.3 監視対象イベント

<!-- プロジェクト固有: 利用するイベントを選択 -->

| イベント | 用途 |
|----------|------|
| `checkout.session.completed` | サブスクリプション開始 |
| `customer.subscription.updated` | プラン変更 |
| `customer.subscription.deleted` | 解約 |
| `invoice.paid` | 支払い成功 |
| `invoice.payment_failed` | 支払い失敗 |

---

## 5. Content Security Policy（CSP）

### 5.1 Stripe Checkout 用 CSP ディレクティブ

```
connect-src https://checkout.stripe.com;
frame-src https://checkout.stripe.com;
script-src https://checkout.stripe.com;
img-src https://*.stripe.com;
```

### 5.2 Stripe.js（Elements）用 CSP ディレクティブ

```
connect-src https://api.stripe.com https://maps.googleapis.com;
frame-src https://*.js.stripe.com https://js.stripe.com https://hooks.stripe.com;
script-src https://*.js.stripe.com https://js.stripe.com https://maps.googleapis.com;
```

### 5.3 実装状況

<!-- プロジェクト固有: CSP ヘッダーの設定状況を記入 -->

| 項目 | 状態 | 備考 |
|------|------|------|
| CSP ヘッダー | 🔲 | Nginx / フレームワーク設定で対応 |

---

## 6. 認証・アクセス制御（2FA / MFA）

### 6.1 Stripe が求める管理者保護

Stripe は、ダッシュボードへのアクセスおよび課金操作に対して **2FA（二要素認証）** を推奨している。

### 6.2 当プロジェクトの対応

<!-- プロジェクト固有: 2FA の実装方式を記入 -->

| 要件 | 実装状況 | 詳細 |
|------|----------|------|
| 管理者の課金操作に 2FA | 🔲 | |
| OTP コード形式 | — | 6桁数字推奨 |
| OTP 有効期限 | — | 5分間推奨 |
| 最大試行回数 | — | 3回推奨 |
| OTP ハッシュ化 | — | SHA-256 or bcrypt |
| 検証済みフラグ | — | 30分間有効推奨 |

### 6.3 保護対象 API

<!-- プロジェクト固有: 2FA を要求する API エンドポイントを列挙 -->

```
POST /api/billing/checkout       → requireOtpVerified()
POST /api/billing/portal         → requireOtpVerified()
POST /api/billing/credits/purchase → requireOtpVerified()
```

---

## 7. 日本固有の法令・ガイドライン

### 7.1 割賦販売法

日本で EC 決済を行う場合、**割賦販売法** に基づくセキュリティ対策義務がある。

| 義務 | 対応方法 |
|------|----------|
| クレジットカード番号の適切な管理 | 非保持化（Stripe Checkout 利用） |
| 不正利用防止措置 | EMV 3-D セキュア（Stripe が提供） |

### 7.2 クレジットカード・セキュリティガイドライン 6.0（2025年3月改訂）

経産省が所管するセキュリティガイドライン。法的拘束力はないが、割賦販売法上の「必要かつ適切な措置」の実務指針。

#### EC 加盟店に求められる対策

| カテゴリ | 要件 | 対応状況 |
|----------|------|----------|
| **非保持化** | カード情報を自社で保持しない | 🔲 |
| **EMV 3-D セキュア** | 本人認証（OTP/生体認証） | 🔲 |
| **脆弱性対策** | 管理画面のアクセス制限・権限管理 | 🔲 |
| **脆弱性対策** | Web アプリの定期的脆弱性診断 | 🔲 |
| **不正ログイン対策** | 多要素認証の導入 | 🔲 |
| **不正ログイン対策** | ログイン試行回数制限 | 🔲 |
| **不正ログイン対策** | 不審 IP からのアクセス制限 | 🔲 |
| **クレジットマスター対策** | 大量カード試行の検知・遮断 | 🔲 |

---

## 8. サードパーティスクリプトの管理

### 8.1 リスク

外部 JavaScript が改竄された場合、決済ページ上で任意コードが実行される（サプライチェーン攻撃）。

### 8.2 対策

- [ ] 決済フロー関連ページの外部スクリプトを最小限にする
- [ ] CDN 経由のスクリプトには `integrity`（SRI）属性を付与
- [ ] Stripe.js は公式 CDN（`https://js.stripe.com`）からのみ読み込む
- [ ] `npm` パッケージの定期的な脆弱性スキャン（`npm audit`）

---

## 9. エラーハンドリング・ログ

### 9.1 決済関連のエラーレスポンス

- [ ] エラーメッセージに**カード情報や内部システム情報を含めない**
- [ ] ユーザー向けメッセージは汎用的な表現を使用
- [ ] 詳細なエラー情報は**サーバーログにのみ**記録

### 9.2 ログに含めてはいけない情報

| データ | ログ出力 |
|--------|----------|
| カード番号 | ❌ 絶対禁止 |
| CVV / CVC | ❌ 絶対禁止 |
| Stripe Secret Key | ❌ 絶対禁止 |
| Webhook Secret | ❌ 絶対禁止 |
| ユーザーのメールアドレス | ⚠️ 最小限（マスキング推奨） |
| Stripe Customer ID | ✅ 可（トラブルシュート用） |
| Subscription ID | ✅ 可（トラブルシュート用） |
| Invoice ID | ✅ 可（トラブルシュート用） |

---

## 10. インシデント対応

### 10.1 API キー漏洩時

1. **即座に** Stripe Dashboard で対象キーをローテーション
2. 新しいキーを `.env.production` に反映
3. アプリケーションを再起動
4. 漏洩経路を特定し、再発防止策を実施
5. 影響範囲を調査（不正な API 呼び出しの有無）

### 10.2 不正決済検知時

1. Stripe Dashboard で該当トランザクションを確認
2. 必要に応じて返金処理
3. Stripe Radar のルールを見直し
4. ユーザーに通知

---

## 11. 定期チェックリスト

### 月次

- [ ] Stripe Dashboard の API リクエストログを確認
- [ ] 不審なトランザクションがないか確認
- [ ] `npm audit` でパッケージの脆弱性を確認

### 四半期

- [ ] SSL 証明書の有効期限を確認
- [ ] API キーのアクセスログを監査
- [ ] Webhook の配信成功率を確認
- [ ] セキュリティガイドライン更新の有無を確認

### 年次

- [ ] PCI DSS SAQ A の自己評価を実施
- [ ] Stripe の PCI 準拠証明書をダッシュボードで更新
- [ ] セキュリティポリシーの見直し

---

## 12. 対応状況サマリ

<!-- プロジェクト固有: 実装の進捗に応じて更新 -->

| 要件 | 重要度 | 状態 | 備考 |
|------|--------|------|------|
| TLS 1.2+ / HTTPS | 必須 | 🔲 | |
| カード情報非保持 | 必須 | 🔲 | |
| API キー環境変数管理 | 必須 | 🔲 | |
| Webhook 署名検証 | 必須 | 🔲 | |
| 管理者 2FA | 推奨→必須 | 🔲 | |
| RBAC（権限管理） | 必須 | 🔲 | |
| CSP ヘッダー設定 | 推奨 | 🔲 | |
| HSTS ヘッダー | 推奨 | 🔲 | |
| IP アドレス制限（API キー） | 推奨 | 🔲 | |
| Web アプリ脆弱性診断 | ガイドライン要件 | 🔲 | |
| 不審 IP アクセス制限 | ガイドライン要件 | 🔲 | |

---

## 参考資料

- [Stripe Integration Security Guide](https://docs.stripe.com/security/guide)
- [Stripe API Key Best Practices](https://docs.stripe.com/keys-best-practices)
- [Stripe Webhook Documentation](https://docs.stripe.com/webhooks)
- [Stripe PCI Compliance Guide](https://stripe.com/guides/pci-compliance)
- [経産省 - クレジットカード・セキュリティガイドライン改訂](https://www.meti.go.jp/press/2024/03/20250305002/20250305002.html)
- [クレジットカード・セキュリティガイドライン 6.0 解説（KOMOJU）](https://ja.komoju.com/blog/credit-card-settlements/security-guidelines/)
- [日本クレジット協会 - 加盟店向けセキュリティ情報](https://www.j-credit.or.jp/security/understanding/member-store.html)

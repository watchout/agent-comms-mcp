# AUN / Kusabi: 種類付き記号化・暗号化保存・権限付き復号 v1

Status: DESIGN_REVIEW — ユーザーが方向性と設計改訂を指示済み。詳細は本PRのレビュー対象。
Control source: [AUN #966](https://github.com/watchout/agent-comms-mcp/issues/966)
Consumer design: [Kusabi #322](https://github.com/watchout/agent-memory/issues/322)
Author: Work / design-source author
Date: 2026-09-20
Runtime implementation / migration / activation: 未実施

## 1. 目的と変更する判断

氏名・住所・電話番号・メールアドレスを必要時に利用できる記憶として保持し、
通常の検索・復旧・AI入力には、種類と根拠のある関係性を保持した記号を返す。
保護を過剰に適用しても原文を失わないことで、秘匿判定の偽陽性を修復可能にする。
見落として通常出力した情報は暗号化だけでは守れないため、偽陰性の検査は維持する。

| 区別する判断 | 出力 | 決定者 |
| --- | --- | --- |
| 保存してよいか | exclude / eligible | 既存の保存対象・シークレット除外規則 |
| 保護するか | ordinary / protected / pending | スクリプトのポリシー、分類器は判断材料 |
| 何の情報か | name / address / phone / email / unknown と確定度 | スクリプト・Jev・LLMの分類記録 |
| 誰に属するか | 根拠付きentityリンク、又はnull | 構造化入力・出典に基づくリンク処理 |
| 誰に何を開示するか | permit / deny | 認証済み主体と用途を検証するサーバー |

ユーザー方針の記録はAUN #966 / Kusabi #322。以下のデータ構造、暗号プロファイル、実装分割はその方向を
具体化する技術設計案であり、実装済み・監査済み・実環境承認済みという主張ではない。
既存#296の正規表現修正だけでは本要件の完了にならない。

## 2. AUNを先に保護する順序とシステム責任

AUN自身がメッセージと配送payloadを永続化する。Kusabiで保護するだけでは、
最初のAUN DBへの原文保存を防げない。最初の永続化地点から保護する。

1. AUN #940 / PR963、Shirube #604 / #623 / PR626の現修理・正式受入を継続する。
2. 本設計を両製品へ反映する。現修理PRへ混載して既存品質証拠を無効化しない。
3. 新機能の実装はAUNの保存前処理→全保存先→読取/配送を先行する。
4. Shirubeは合成データの受入検証と独立確認へ接続する。runtime依存を追加しない。
5. Kusabiへ同じ契約を適用し、AUNからの参照と独自取込を保護する。
6. Kodamaは後続consumer。PR73に本設計を追加のmerge条件として課さない。

これは作業順とデータ保護の変更であり、既存の非個人情報の許可済み作業を止めない。
個人情報を使う新機能の有効化には本設計の実装・受入が必要であり、現PRの受入と区別する。
AUN/Shirubeの既存完了条件を全Jev導入・UAMP全面実装待ちへ広げない。
AUN/Kusabiはそれぞれ自分の保存境界で保護し、一方の起動を他方の保護処理の必須条件にしない。

| system | 責任 |
| --- | --- |
| AUN | 受信/送信本文・queue/outbox/eventlogの保存前保護、認可付き読取/配送、queue/lease/lifecycle |
| Kusabi | 独自取込と記憶DBの保存前保護、受領参照、検索/復旧、認可付き復号 |
| Shirube | 設計/受入条件・レビュー・原文を含まない証拠。開示権限を付与しない |
| Kodama | source permission / allowed-use / omission制約を保持するconsumer |
| Jev / LLM | 内容分類の判断材料。権限/queue進行/復号許可を決めない |

共有するのは契約・暗号/分類interface・合成conformance例であり、全DB統合や共通鍵ではない。
初回はAUNのcore/protected-dataに契約実装とDB adapterを分けて置き、Kusabi接続時に
同じ受入fixtureで実装版を固定する。未作成の共通package/repositoryを新たな着手条件にしない。

## 3. 現行実装と保存先の差分

観測基準:
- AUN main 0f772883db6f3b50772d3e4b82ce47795091f0a9。
- Kusabi main 3399a931aac48462106202b4bb5ded1ab9bdb60e。

AUNはserver.tsでagent_messages.contentにmsg.contentを渡し、
core/inbound-delivery.tsでmessage_queue.payloadにmqPayloadJsonを保存する。
server.tsにoutbound_queue.contentのINSERTがあり、core/eventlog/store.tsはpayloadをJSON化して保存する。
これらはアプリケーション保存経路の確認である。実DB/ディスク暗号化の配備状態は未確認。

| 保存/出力面 | 新モードで必要な処理 |
| --- | --- |
| agent_messages.content / metadata | 保護済みprojectionと参照。metadataの自由文/添付名/URL queryも対象 |
| message_queue.payload | 本文の再コピーを含め型付き記号か保護参照。平文埋込を禁止 |
| outbound_queue.content / diagnostics | 配送待ちも保護したまま保存。許可された宛先へ送る直前にだけ必要値を解決 |
| event_log.payload / conversation派生記録 | versioned保護参照を含むcanonical payload。旧形式への平文dual-writeなし |
| next / inbox / expand_msg / reply chain | full=trueも保護解除の意味にしない。previewと祖先本文にも同じ規則 |
| fetch_messages / platform履歴 | ローカルDBを通らない読取も出力前に同じprojection規則を適用 |
| log / exception / retry / dedup診断 | 原文/無鍵の原文hashを出さない。失敗したpayloadも平文dumpしない |
| attachment / 通知先の複製 | 全経路を棚卸し、未対応を明示。未対応原本を通常領域へコピーしない |

AUNの取込では、routing/mention等の検証済みcontrol metadataとデータ本文を分離する。
保護処理でqueue宛先/priority/claim/lease/statusを再推論しない。
利用者が本文へ書いた指示や人物ラベルをsystemのrouting権限へ昇格させない。

Kusabiではsrc/redact.tsとClaude ingestが保存前に不可逆置換し、置換済みcontentを
raw_eventsとconversation_eventsへ渡す。新モードでは通常本文は記号、
必要な個人情報原文は暗号化した保護値とする。既存raw_eventsに原文があると仮定しない。
保存対象外の秘密、非公開推論、base/developer instructionをvaultへ迂回保存しない。

## 4. 記号と文脈

表示例（P01等は説明用の短縮別名）:

> [氏名:P01:N01]さんに[電話番号:P01:T01]へ連絡する。送付先は[住所:P01:A01]。

機械参照の正本は表示文字列ではなく、issuer_id + scope_id + opaque value_id。
issuer_idは配備された保護値保管主体のIDであり、aun/kusabiという製品名だけでは一意にならない。
実IDは暗号学的乱数で生成し、氏名・電話番号・原文hashから導出しない。
表示ラベル、entity別名、分類状態が変わってもvalue_idを変更しない。

- type: name / address / phone / email / unknown。追加型は版付き登録で拡張。
- classification_status: confirmed / inferred / unknown。
- confirmedは構造化項目等の根拠付き分類。モデルの高confidenceだけで確定へ上げない。
- inferredは「電話番号候補」、unknownは「保護情報」と表示する。
- entity_idは任意。根拠不明ならnull。名称や値の一致だけで人物を統合しない。
- 同一人物の複数の電話/住所は別value_id。関係はproperty=phone等で保持。
- 型・関係も機微なメタデータになり得るため、同じ読取範囲/出力制約で制御する。
- 入力文中に記号に似た文字列があっても参照として解釈しない。信頼済みsegment構造だけを解決。
- 型、関係、confidence、記号の所持はアクセス権の根拠にしない。

文書の内部表現はtext segmentとprotected_ref segmentの配列にする。
平文の置換パターンを後から再走査して復号する実装は禁止する。
テキスト表示はこの構造から生成し、旧consumerは記号付きの通常テキストとして読める。
新モードの機械参照は版付きsidecarで保持し、既存recovery-pack/v1に未定義必須項目を入れない。

## 5. データモデル案

以下は追加テーブル/論理オブジェクト案であり、現行DDLへの変更ではない。

| オブジェクト | 主な項目 | 制約 |
| --- | --- | --- |
| protected_values | issuer_id, scope_id, value_id, ciphertext, nonce, auth_tag, key_id, crypto_version, created_at, retention_policy_ref | (scope_id,value_id)主キー。平文列なし |
| protected_value_metadata | scope_id, value_id, type, classification_status, revision, classifier_ref, policy_version | 値参照を維持して型を訂正。旧revisionと理由を保持 |
| protected_entity_links | scope_id, value_id, entity_id, property, source_ref, relation_status | 出典必須。同じscopeの値のみ。推定関係を確定表示しない |
| protected_documents | scope_id, event_id, segments, source_ref, protection_version, protection_status | raw/conversationの本文と結合。永続参照はFK相当で検査 |
| protection_operations | scope_id, ingest_operation_id, state, result_refs | unique。再試行で同じ操作結果へ戻る |
| reveal_audit | actor_ref, request_id, scope_id, value_refs, purpose, destination_ref, result, policy_version, timestamp | 平文、鍵、認証トークンを含めない |

scope_idはサーバー管理の保護範囲。AUNでは認証済みchannel/conversationの許可設定、
Kusabiでは現在のagent_id + projectとtrusted host bindingへ対応付ける。
channel_idやagent_idを知ること自体は認可にならない。新tenant実装を存在するものとしない。
projectなしも明示的な1scopeに固定する。issuerの異なる同名value_idを混同しない。
別scopeを横断する共通人物ID、原文hash、global dedupは導入しない。
同じ値の繰返しは既存の信頼済み参照または同一取込内の根拠で再利用する。
別イベント間の自動同一人物統合、電話番号による照合検索は初回範囲外。

保存処理:
1. 現行の保存対象外データ/既知シークレットを除外する。
2. 構造・文脈から保護候補を抽出し、重なりは和集合にして取りこぼしを防ぐ。
3. 判定済み範囲と未判定範囲を分け、後者はunknownで保護する。
4. 原文の必要部分だけを暗号化する。表記の正規化は原文を上書きしない。
5. 値、参照、本文projection、operation結果を同じtransactionでcommitする。
   AUNではmessage/queue/outbox/eventlogへの対象書込も既存transaction境界と整合させる。
   二重書込を避けられないadapterは未対応とし、片方の成功で完了にしない。
6. commit後だけ取込成功を返す。秘密を含まないidempotency keyで再試行を識別する。

自由文の未判定部分に個人情報がないとは推定しない。初回は自由文段落単位の保護を
許容し、検証済みの分類器で安全に細分化する。安全な自動細分化が未検証の入力形式は
過剰保護として可視化し、検索品質の制約を報告する。隠れて平文公開するfallbackは設けない。

AUNのevent-logは同じevent_idのcanonical payload一致を要求するため、再試行で
新しい乱数token/ciphertextを生成して再appendしない。operation結果の保護参照を再使用する。
ciphertextはcanonical payloadへ埋めず、rotationでevent payloadの同一性を変えない。
既存のmessage/content window dedupが必要な経路は、scope分離した専用鍵のHMACを
制限付き内部索引だけに使う案とし、暗号鍵と分離し、ログへdigestを出さない。
鍵rotation時の比較期間/旧索引を明記する。保護した表示文字列だけの比較へ変えて
dedupを無効化したり、既存claim/unique/CAS規則を除去したりしない。

## 6. 暗号化・鍵・信頼境界

暗号プロファイル案: 標準ライブラリのAES-256-GCM、96-bit nonce、128-bit tag。
鍵ごとのnonce再利用を防ぎ、crypto providerが生成/重複検査を担当する。
AADはimmutableなissuer_id/scope_id/value_id/crypto_versionへ束縛し、暗号文の行差替えを検出する。
訂正可能なtypeや表示名はAADに固定しない。自作暗号は使わない。

鍵は参照IDから導出しない。DBにはkey_idと必要なwrapped-key metadataだけを置き、
復号に必要な鍵の正本を同じDB・通常バックアップ・Git・ログに同梱しない。
KeyProviderのresolve/encrypt/decrypt/rotate契約を定義し、配備時に承認済みの
OS秘密保管/鍵管理サービスと実主体への束縛を選ぶ。特定サービスの新規利用は本PRで有効化しない。
開発試験は一時鍵と合成データのみ。実鍵の作成や移行は行わない。

同じDBの別テーブルというだけではアクセス境界にならない。通常読取経路はvaultを
直接返さず、復号サービスだけが認可後にKeyProviderへ到達する。
現在のローカル単一OSユーザー構成は、同じユーザー権限を持つ侵害されたprocessからの
完全隔離を保証しない。複数の不信頼主体へ開く前には鍵サービス/実行主体の隔離を実証する。

## 7. 認可とAPI案

現在のMCP/CLIツールの名前、引数、queue制御、既存recovery artifactを無断で変更しない。
初回は内部service interfaceとして次を実装し、公開MCP露出はconsumer接続工程で検討する。

| interface | 入力 | 結果 |
| --- | --- | --- |
| protect_ingest | trusted ingest context, source ref, operation id, eligible content | 記号化本文、scope内value refs、保護/欠測metadata |
| render_context | trusted read context, message/event/pack refs | 認可範囲の型付き記号と必要なprovenance |
| resolve_protected_values | trusted actor context, value refs, registered purpose, destination ref | 認可された値だけ/typed error |
| revise_classification | trusted maintenance context, value ref, evidence ref, expected revision | revision更新。値IDと原文は維持 |

trusted actor contextは認証済みtransportまたは起動時に固定された信頼済みhost bindingから
サーバーが注入する。tool引数のagent_id、role=admin、LLM本文、AUN task labelを信用しない。
実行時principalを安全に束縛できないadapterは復号を公開しない。

各復号requestでactor × scope × value × operation × purpose × destinationを検証する。
purpose/destinationはモデルの自由記述をそのまま許可根拠にせず、登録済みの許可設定と照合する。
元sourceの許可・失効・allowed-use・出力制限も再確認する。保存時の許可だけで開示しない。
値ID不明と読取拒否は外側では同じNOT_AVAILABLEとし、他人の値の存在を漏らさない。
batchは全件を検証してから全件成功/全件拒否を返し、混在scopeの部分漏えいを防ぐ。
1回の最大件数・総byte数・期限はserver-side profileで有限に固定する。

通常の復旧文/検索結果は型付き記号のまま。人の許可済み表示、又は許可済み業務serviceで
必要な項目だけ解決する。既存権限で許可される読取に都度の人間承認を要求しない。
一般LLMへの生値の自動展開は既定で行わない。必要なAI利用は宛先の情報区分許可も検証する。
復号成功は電話発信/メール送信/外部共有の実行承認を兼ねない。

## 8. スクリプト → Jev → LLM

各段階が結果を確定できれば後段は省略する。API timeout/未承認/無効化は取込全体を止めず、
対象をprotected/pendingとして保持する。復号・通常公開の権限をモデルへ委譲しない。

| 段階 | 対象と処理 | 不明時 |
| --- | --- | --- |
| 0 保存規則 | 既知秘密、非公開推論等の除外。入力scopeと出典を検証 | 不正入力は拒否 |
| 1 スクリプト | 構造化項目、既知の公開ID/URL形式、正規表現。自由文の未検査段落も候補化 | unknownで保護 |
| 2 Jev | 許可された文脈を使ったtype/protection候補の構造化分類 | pendingを保持 |
| 3 LLM | 追加判断に価値がある残件のみ。必要最小限の許可済み文脈 | pendingを保持 |
| 4 出力ポリシー | 分類の根拠・版・検証済み閾値をコードで適用 | 不明は記号のまま |

各判定にmodel/version、question-or-prompt version、policy version、結果と所要時間を記録する。
confidenceを実測正解率とみなさず、日本語/氏名/住所/番号/公開ID別の検証で閾値を決める。
LLMに回せば正しいとの前提や、未測定の速度/コスト優位を置かない。
範囲抽出は元文字列のoffsetと一致を検証し、モデルが生成した別文字列を原文として保存しない。

低確信で保護を追加する処理と、既存保護を解除して通常出力へ戻す処理を分ける。
後者はrevision、出典、対象入力形式の検証済みpolicyが必要。モデルの自由文だけで解除しない。
Jev/LLMの不使用は基本的な記号化/保存/権限付き復号を使えなくする理由にしない。

外部APIへ原文を送る前に[IYASAKAサービス台帳](https://github.com/watchout/iyasaka/blob/main/docs/ops/security/SERVICE_REGISTER.md)
の用途/情報区分/契約/保持条件を確認する。観測時点ではJevのP2利用承認を確認できていない。
未承認なら送らず保護を継続。原文を送ってから暗号化しても外部送信の保護にはならない。

## 9. 検索・復旧・consumer

- 通常全文検索/embeddingは型付き記号を含むprojectionを対象にする。
- plaintext、原文由来の無鍵hash、ciphertextをembedding inputや公開索引へ入れない。
- 検索結果に候補型と同じentityの関係を残し、分類不明を確定事実に見せない。
- 氏名/電話番号の原値による全文検索、部分一致、global同一人物検索は初回非対応。
  それらが必要な業務には別の認可付き検索設計が必要であり、記号検索で同等とは主張しない。
- AUN自身のDBも保護対象。配送/再開成功を復号許可にしない。外部platform宛の出力は宛先許可を再検証する。
- 既存業務で原値の送信が許可される宛先には送信直前だけ復号する。送信許可なしなら記号表示又は拒否。
  元データがDiscord等に既に存在する場合、その既存コピーを本設計で消去済みと扱わない。
- Shirubeの証拠には元値や暗号鍵を入れず、合成fixture、版、拒否/成功件数と結果を記録する。
- Kodamaへの受渡しでsource/allowed-use/失効情報を落とさず、revealを集約検索の副作用にしない。
- stale packは最新の型表示とsource権限を再評価。旧labelが残るsnapshotは版と時点を明示する。
- AUN→Kusabiは発行元付き参照と出典を引き継ぐ。記号を再暗号化したり生値を通常DBへ戻したりしない。
- 原文保管の責任は発行元に残す。受領した参照は復号の委任にならず、発行元の許可確認が必要。
- 発行元が停止していれば元値はsource_unavailableとして扱う。独立した復旧を保証するための
  保護値コピーは、別途許可されたimport/re-encrypt契約が必要であり、初回は暗黙に行わない。
- 参照欠落/鍵不在は復旧pack全体を壊さず、該当項目の欠測を明示する。
  ただし必要な値が得られない業務を成功扱いしない。

## 10. 失敗・訂正・保持

| 事象 | 動作 |
| --- | --- |
| 分類器が停止/timeout | 暗号化済みunknownを保持。再分類は有限jobで行う |
| 鍵が取得できない | 新規保護取込はcommitせずtyped failure。元source/cursorを維持し再試行可能にする |
| vault書込/transaction失敗 | 全体rollback、成功ACKしない。dangling参照や平文fallbackを作らない |
| 取込応答喪失/二重配送 | operation idでcommit済み結果を読戻し、値を増殖させない |
| 復号拒否/失効 | 記号を維持。通常表示へ自動緩和しない |
| 暗号文/tag/AAD不一致 | 復号拒否、平文なしの異常記録 |
| 誤分類/誤った人物リンク | revision付き訂正。entity誤結合は分離可能にする |
| 過剰保護 | 元値を復元可能に保持し、検証済み規則で再分類。回復不能な伏せ字へ変換しない |
| バックアップ復元 | encrypted values/参照/本文/版の対応と別管理鍵の利用を検証 |
| 鍵の消失 | 復号不能として明示。暗号化だけで可用性を保証しない |
| 削除/期限 | 出典保持規則に従いvault、参照、検索索引、cache、backup保持を一緒に設計 |

通常ログ/metrics/traces/exceptionへ原文を出さない。分類用cacheもscopeとpolicy/model版へ束縛し、
原文を平文cacheしない。原文hashをログへ残す方式は番号の総当たりを可能にするため使わない。
復号auditが記録できなければ値を返さない。auditにはopaque refsと判断結果だけを入れる。

## 11. 互換性・移行・rollback

新モードは明示的な配備選択とし、AUNの既存wire/event形式とKusabiの旧am031-redaction-v1の意味を変更しない。
AUNの旧readerへ暗号文を通常本文として渡さず、旧writerを新形式の配備へ混在させない。
AUNの既存DBには平文が残り得るため、新規書込の保護と履歴移行の完了を別表示する。
履歴、queue、outbox、eventlog、backupの既存コピーは範囲を棚卸し、preview/backup/readbackを伴う別移行で扱う。
保護版、分類版、crypto版を別々に持つ。#298の版来歴工程へ接続する。
AUNは現在の対象環境の採用DBを事前確認し、実際のPG/SQLite書込経路で同じ契約を検証する。
Kusabi単体の最初の検証対象はSQLite。各backendは実装・試験された範囲だけを対応と表示する。
未対応backendで新モードが指定された場合、起動/取込を明示拒否し旧方式へsilent fallbackしない。

初回は新規取込から追加。既存データの一括書換えや原文の推測再構成を行わない。
既存REDACTEDはlegacy_irreversibleとして扱い、原文不存在なら復元不能のまま残す。
許可された原資料が現存する再取込は、元eventとの対応・重複・差分preview・rollbackを別作業で扱う。
新形式を理解しないbinaryへの単純downgradeはrollbackにしない。
rollbackは新規書込停止＋新形式を読めるversion維持、又は検証済みbackup/key復元とする。
鍵rotation時もvalue_idを維持し、途中失敗と旧鍵参照を追跡する。鍵削除でrollback不能にしない。

本設計を既存PR318へ無検証で追記し、既存独立PASSを流用してはならない。
#307のamendmentとしてA1の設計差分を接続し、A2以降・A5b・復旧採点・対象席分母を保持する。
新設計の受入証拠が揃うまで、既存A1が閉鎖済みとも新機能が実用済みとも扱わない。

## 12. AUN先行の実装単位

現AUN/Shirube修理の後続として別PRで着手する。通常修正・試験は既存指示内で続行する。
鍵の実配備、実DB移行、実データ外部送信、merge/deployは対象版と影響を揃えて既存の権限経路で扱う。

| 単位 | 対象module案 | 到達点 |
| --- | --- | --- |
| A1 共通core・保存 | core/protected-data/*（新規）、core/db/*、server.ts | 合成値のbyte完全復元、型/関係、原子保存、鍵不在/改ざん拒否 |
| A2 全書込・再試行 | core/inbound-delivery.ts、core/eventlog/store.ts、server.tsのqueue/outbox | 原文コピーの残存0、再配送で参照不変、canonical collision/claim/dedupを維持 |
| A3 読取・配送 | next/inbox/expand_msg、reply-chain、platform adapter、log | full/preview/履歴も保護、許可された用途/宛先だけ復号 |
| S1 受入接続 | 既存Shirube review経路、合成fixture/証拠 | PM試験と独立確認。鍵/個人情報を監査本文へ載せない |
| K1 Kusabi保存/取込 | src/stores/*、各conversation-ingest、src/redact.ts責務分離 | 独自入力を保護。AUN参照の発行元を維持、旧形式読取 |
| K2 Kusabi検索/復旧 | search/recover/restart、trusted host binding | 通常記号、許可項目だけ復号、未取得値を成功扱いしない |
| C1 分類改善 | 各classifier adapter、再分類job | スクリプトで稼働、許可されたJev/LLMを任意追加し実測 |
| M1 配備/履歴移行 | 採用backend、backup、旧履歴、rollback | 新旧reader/writer整合、履歴残存範囲と復元を実証 |

A1の次作業は、全永続化callsiteとtransaction境界、DB adapter、認証済み主体の実経路を
現sourceへ対応付け、採用環境の有限な実装PRへ切り出すこと。
未実証の境界をモデルが渡すactor引数、別テーブルだけ、無条件の復号で埋めない。
独立レビューは既存の担当経路へ渡し、本設計者は自分の設計の独立PASSを発行しない。

## 13. 受入試験（未実施のコミットメント）

| ID | 入力/状況 | 必須結果 |
| --- | --- | --- |
| PM-01 | 氏名/住所/電話/emailの構造化入力 | 型・同一人物の根拠・複数値の区別を保持 |
| PM-02 | 型unknown、後にphone推定へ訂正 | value_idと復号原文不変、revision更新 |
| PM-03 | 名称一致だけの2人/共有電話 | 根拠なく人物統合しない |
| PM-04 | 同じsourceの重複取込/応答喪失 | 同じoperationのvalue refsを読戻す |
| PM-05 | 数字や全角を含む合成値 | 暗号化前のeligible bytesを完全復元 |
| PM-06 | APIキー/hidden instruction | vault含め保存・出力しない |
| PM-07 | 任意のagent_id/admin宣言 | 復号権限が変わらない |
| PM-08 | 別scopeのvalue_id/混在batch | 全件拒否、値の存在漏えいなし |
| PM-09 | 許可済み主体・用途・宛先 | 必要項目だけ復号、都度承認なし |
| PM-10 | source失効/用途不一致 | 既存packからも復号拒否 |
| PM-11 | 鍵不在/DB書込失敗 | 平文fallbackなし、commit/ACKなし |
| PM-12 | ciphertext/tag/行入替 | 復号拒否 |
| PM-13 | 原文中に偽の記号 | trusted refとして解決しない |
| PM-14 | Jev/LLM停止・外部利用未承認 | 原文送信0、unknown保護で進行 |
| PM-15 | 正規表現に合わない氏名/住所の自由文 | 未検査文を非PII扱いしない |
| PM-16 | confidence高だが誤判定 | モデル値だけで保護解除/権限付与しない |
| PM-17 | #296のGitHub ID/URL/epoch/backup値 | 構造上公開と確認できる値を破壊しない |
| PM-18 | queue 162026 (5432) / 2026 08 16 1234 / 12345 6789 / 5304928252 4567 | 既知の非電話fixtureを連結して電話と断定しない |
| PM-19 | hotel 5304928252 / phone number is 5551234567 | 前者をtel接尾辞で誤分類せず、後者の既存秘匿coverageを保持 |
| PM-20 | 旧REDACTEDと新参照の混在 | 旧復号不能を明示。新参照は認可付き復元 |
| PM-21 | search/recovery/log/embedding/trace | 通常経路に生値・鍵・推測可能な原文hashなし |
| PM-22 | backup復元/rotation/rollback | 参照と値の整合、旧鍵依存/失敗を観測 |
| PM-23 | AUN/Shirube/Kodama間の引渡し | lifecycle/レビュー結果で読取権限が増えない |
| PM-24 | audit障害/不正offset/過大request | 値を返さず有限に拒否。成功を偽装しない |
| PM-25 | AUN message/queue/outbox/eventlog全保存先 | 同じ合成機微値の平文コピー0、metadata/diagnosticsも含む |
| PM-26 | AUN event再append/再配送/暗号鍵rotation | canonical payload一致、claim/lease/dedup保持、平文dual-writeなし |
| PM-27 | full/preview/祖先/外部履歴/添付 | DBを迂回した読取も保護。未対応添付を勝手に平文保存しない |
| PM-28 | AUN→Kusabiの同名ID/発行元停止 | issuer区別、二重置換なし、未取得値を欠測表示 |

元#296の成功fixtureを削除しない。旧モードのREDACTED期待と新モードの
「通常出力は記号・認可後に原文一致」を別suiteへ対応し、混同しない。
PM-17〜19は公開/合成fixture上の期待であり、数字の形式だけで一般入力を公開情報と確定しない。

品質計測は分類精度だけに限定しない:
- 種類別の偽陰性/偽陽性、未知分類率、正規表現非該当から拾えた件数。
- 不要な記号化率、検索課題成功率、復旧課題成功率、誤った人物リンク件数。
- Jev/LLM呼出率、timeout率、p50/p95 latency、1,000件あたり費用。
- 許可復号のbyte一致率、拒否対象の平文露出件数、再試行重複/欠落件数。
固定の合成/許可済み評価集合と版を記録し、実測前に改善率を主張しない。
security fixturesは漏えい/越境/改ざん受入0、許可round-tripは全件一致を要求する。
品質/性能の合否値は初回baselineから提示し、既存の復旧合格基準を緩めない。

## 14. 参照・設計判断の根拠

- [IYASAKAセキュリティ正本](https://github.com/watchout/iyasaka/blob/main/docs/ssot/IYASAKA_SECURITY_BASELINE.md)
  §4/10/12: 情報区分、秘密の非記録、server-side認可、AI送信条件。
- [OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html):
  標準暗号、認証付き暗号、乱数、鍵とデータの分離を設計判断の根拠とする。
- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html):
  requestごとの認可とdefault deny。opaque IDだけをアクセス制御にしない。
- [Google Sensitive Data Protection: Pseudonymization](https://docs.cloud.google.com/sensitive-data-protection/docs/pseudonymization):
  復元可能な記号化と関係維持の概念。本設計のvault方式や実測性能の証明ではない。
- [TypeSafe Jev公式docs](https://docs.typesafe.ai/introduction):
  構造化した判断用途の製品説明。Kusabiの日本語PII精度/速度の実測証拠ではない。

現時点の証拠: 設計文書のみ。PM-01〜28の製品試験、独立監査、実環境移行は未実施。

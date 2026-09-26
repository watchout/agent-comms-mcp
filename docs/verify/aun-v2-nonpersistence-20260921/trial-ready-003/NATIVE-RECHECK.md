## 返却後のnative再検証

同cellの再提示を受け、契約待ちから独立してnativeの一過性拒否を再検証した。判定は **再現せず / 原因未同定を維持**。製品・test sourceの追加変更は0。`c36a815512b92425b5020021f1b20347fd5ced4f`で単独5回と、以前失敗した16-file統合commandを3回実行した。全runのsource manifestは、最終source `592d00654145d0c3db1295c82dacd6ecb5841655`の721 filesと一致する。

| run | 実行HEAD | PASS | FAIL | filtered | assertions | raw |
|---|---|---:|---:|---:|---:|---|
| native-recheck-1（同じ1 testを5回） | `c36a8155` | 5 | 0 | 0 | 80 | [native-recheck-1.log](native-recheck-1.log) |
| integrated-recheck-1 | `c36a8155` | 95 | 0 | 0 | 618 | [integrated-recheck-1.log](integrated-recheck-1.log) |
| integrated-recheck-2 | `c36a8155` | 95 | 0 | 0 | 618 | [integrated-recheck-2.log](integrated-recheck-2.log) |
| integrated-recheck-3 | `c36a8155` | 95 | 0 | 0 | 618 | [integrated-recheck-3.log](integrated-recheck-3.log) |

native schedulerの各回は原本read 2、正常dispatch 1、負例拒否3、observer calls 18、実provider呼出し0。重複実行をユニークtest数に加算しない。統合も毎回同じ95件・16 filesであり、分母の縮小やtest filterは0。

識別対象は、OS候補の途中消滅、3秒の観測deadline、native原本・時刻・authority照合の拒否。既存の診断はdispatch 0時にobserver理由・gate metrics・原本read数・論理proof/lease時刻を取得する。今回は拒否自体が発生せず、仮説の識別には至らなかった。原本失敗log `integrated-b4-failure`にはこの診断がないため、その1件の原因を現在のPASSから断定しない。guard・deadline・assertを緩める根拠は得ておらず、変更していない。

**TRIAL_READY=falseを維持**。configuration論理deploymentとprovider-free S0 authority proofの契約、NP11のB3からの全行程、native過去拒否の原因同定、独立cycle2は未完。契約掲載後のNP11実測でも既存診断を使用する。同一条件の反復のみでは識別できなかったため、追加の反復実行は停止した。

private PostgreSQLのみを再起動・停止。各testの専用DBを破棄し、依存moduleへの一時symlinkを除去済み。[fixture-recheck-stopped.json](fixture-recheck-stopped.json)に停止のreadbackを保持。live DB/runtime/queue、他席、認証、NP12への変更は0。

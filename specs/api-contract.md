# API Contract

## 1. 入力検証とServer所有属性の保護

APIは不正・不整合な入力を厳格に検証し、即座に拒絶する。

最低限検証する項目：
- type / required / enum / date 形式
- ownership（申請者本人または正規代理起案者）
- permission（エンドポイント・操作権限）
- state transition（現在のステータスからの遷移妥当性）
- policy consistency（条例・制度ポリシー制約）
- **server_owned_fields**: `applicationType`, `targetEmployeeId`, `policyVersion`, `approvalRoute` 等の変更不可属性がリクエストボディに含まれ、既存確定値と乖離している場合は改ざんとして拒絶（400/403/422）。

## 2. HTTP レスポンスステータス規約

業務ルール違反やエラーを200 OKで返してはならない。

- **400 Bad Request**: フォーマットエラー、必須項目欠落、不正なClient指定値
- **401 Unauthorized**: 未認証
- **403 Forbidden**: 権限不足、自己承認試行、他者データへの不正アクセス
- **404 Not Found**: 対象リソース不在
- **409 Conflict**: 楽観的ロック競合（Version不一致）、重複送信、承認サイクルの競合
- **422 Unprocessable Entity**: 制度・条例ポリシー違反、残日数不足、不正な状態遷移
- **500 Internal Server Error**: 予期せぬシステム例外、整合性境界違反（自動ロールバック）

## 3. 冪等性とリトライ契約（Idempotent API Contract）

1. **二重処理防止**: 申請提出・承認・再提出等の更新APIにおいて、同一リクエストの連続送信やネットワークリトライが発生した場合でも、残日数や承認ステップの二重登録を起こしてはならない。
2. **競合時の振る舞い**: 他者による先行更新やバージョン不一致を検知した場合は、安全に `409 Conflict` を返し、クライアントに最新状態の再取得を促す。

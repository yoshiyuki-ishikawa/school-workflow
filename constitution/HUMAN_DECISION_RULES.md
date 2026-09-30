# Human Decision Rules

以下の場合、AIは自律実装・自動適用を停止し、人間のプロダクトオーナー（PO）/ QAへ判断および明示的承認を要求する。

- 一次資料と現行運用が異なる
- 複数の法令解釈が成立する
- 既存データの意味が不明
- 新しい服務区分を追加する必要がある
- 帳票の正式表記が不明
- Policyの変更が必要
- DBの既存データを変換する必要がある
- P0修正に仕様変更が必要
- セキュリティ上の設計変更が必要
- **Quality Baselineの緩和・削除・意味変更（Baseline Change Control: RELAXED / SEMANTIC_CHANGE）**
  - Constitutionの原則変更・緩和
  - Invariantの緩和・削除・再定義
  - Golden Caseの期待値変更・削除
  - Severity Rulesの格下げ（P0→P1/P2等）
  - Release Gate / Definition of Doneの緩和
  - Fail-ClosedのFail-Open化
  - 監査ルールの削除・緩和
- 独立ドメインライフサイクルの結合・例外措置
- **Core Semantic Change (Layer A3)**: 状態遷移、トランザクション境界、認可境界、履歴モデル等のコア意味変更
- **Core Impact = UNKNOWN**: 影響範囲・影響半径が特定できない状態
- **学校現場実務・法令正解の確定不能**: 一次資料等から客観的に正解を確定できない状態

## 変更提案時の提示要件

判断・承認要求時は以下を必ず提示する。

- 現在確認できている事実・背景
- 変更理由（PROPOSED QUALITY BASELINE CHANGE 等）
- 変更前と変更後（差分）
- 品質・既存Invariant・Golden/Regression Test・Severityへの影響分析
- 後方互換性（Backward Compatibility）および代替案
- 推奨案

AIによる推測や自己都合の解釈で補完・確定してはならない。

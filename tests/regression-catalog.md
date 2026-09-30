# Regression Catalog

発見したすべての重要バグおよび学校現場実務との乖離（School Reality Gap）の解消事例を記録する。

Regression Testは原則として永続保存し、削除・無効化してはならない（INV-027, INV-030）。
学校現場UATや監査で発見されたReality Gapは、修正完了後に本台帳へREG/GAP番号を付与して恒久登録し、再発防止テスト（`server/src/tests/regression/`）と紐付ける。

---

## REG-2026-003: 再提出時の履歴破壊および出張・復命状態混在事故

### Bug
差戻し（RETURNED）された申請の再提出時に過去の承認・差戻しステップや理由・印影が物理削除または上書きされ、監査証跡が失われる脆弱性。また出張復命書の差戻しが出張命令承認（TRIP_APPROVED）まで破壊する問題。

### Root Cause
`application_approval_steps` の管理において承認サイクル（`approval_cycle`）の概念がなく、`DELETE FROM application_approval_steps` が実行されていたこと、および出張命令と復命書の状態遷移が同一カラムに混在していたこと。

### Fix
Migration 016 による `approval_cycle` カラム追加、過去ステップの immutable 保持、出張命令と復命書の状態・承認サイクルの完全分離、共通Authoritative Domain Logic / バリデーションパイプラインの実装。

### Regression Test
`server/src/tests/resubmitWorkflow.test.ts`

### Related Invariants
- `INV-016` [INV-HISTORY-IMMUTABLE]
- `INV-017` [INV-BUSINESS-ATOMIC]
- `INV-018` [INV-DOMAIN-LIFECYCLE]
- `INV-019` [INV-VALIDATOR-SSOT]
- `INV-020` [INV-WORKFLOW-CYCLE]

### Date
2026-09-03

### Status
RESOLVED

---

## REG-2026-004: Server-Authoritative 服務重複申請・決裁競合（FINDING-P1-CONFLICT-001）

### Bug
複数日出張、終日休暇（年休・病休・特休・職専免等）、時間単位休暇において、Server側での期間重複・時間帯重複判定が不十分であり、競合する排他申請が並行して提出・最終決裁（`FINAL_APPROVED` / `TRIP_APPROVED`）され、二重の年休残数控除や不当な副作用が発生し得る脆弱性。

### Root Cause
1. 申請提出（Submit / Resubmit）時の重複チェックが単日同士のみを対象としており、複数日範囲 (`startDate <= existingEnd && endDate >= existingStart`) や終日 vs 時間単位の排他クロスチェックが欠落していた。
2. 最終決裁トランザクション内での直前競合再検証（Final Approval Conflict Revalidation）が存在せず、並行提出された申請が両方とも決裁可能となっていた。

### Fix
1. `ConflictService.validate` に期間重複アルゴリズム (`startDate <= existingEnd && endDate >= existingStart`)、終日排他服務種別セット (`EXCLUSIVE_DAILY_SERVICE_TYPES`)、終日 vs 時間単位、時間帯重複 (`existStart < newEnd && newStart < existEnd`) の総合判定を実装。
2. `ApplicationValidationPipeline` の最上流に `ConflictService.validate` を統合し、新規提出（Submit）および再提出（Resubmit）時に 422 Unprocessable Entity（`SERVICE_PERIOD_CONFLICT` / `TIME_CONFLICT`）で Fail-Closed 遮断。
3. `WorkflowEngine.executeApprovalStep` の同一トランザクション境界内で、最終決裁（`FINAL_APPROVED` / `TRIP_APPROVED`）の直前再検証を導入し、先行して確定した申請と競合する場合は 409 Conflict で確実にロールバック。年休残数控除（`AnnualLeaveService.finalizeUsage`）を 0 件に完全防衛。

### Regression Test
- `server/src/tests/conflictEngine.test.ts` (`REG-CONFLICT-001` 〜 `REG-CONFLICT-015`)

### Related Invariants
- `INV-001` [INV-AUTH-SSOT]
- `INV-008` [INV-LEAVE-LOT-FIFO]
- `INV-017` [INV-BUSINESS-ATOMIC]
- `INV-019` [INV-VALIDATOR-SSOT]
- `INV-022` [INV-SERVER-AUTHORITATIVE-CONFLICT]

### Date
2026-09-05

### Status
RESOLVED

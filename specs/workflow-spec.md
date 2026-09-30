# Workflow Specification

## 1. 状態遷移検証（State Transition Validation）

すべてのワークフロー状態遷移はServer側で厳格に検証する。

状態変更時の必須検証項目：
- **actor**: 操作者権限（本人、正規代理起案者、割当承認者）の認可
- **role**: 承認ステップに要求される役職・ロール保持
- **target**: 申請対象教職員の有効性
- **current_status**: 現在状態からの遷移妥当性（例: `RETURNED` からのみ再提出可能、`FINAL_APPROVED` / `REJECTED` からの直接再提出は拒絶）
- **requested_status**: 遷移先状態の妥当性
- **self_approval**: 本人および代理起案者による自己承認防止
- **policy**: 制度・法令・自治体ポリシーおよび出勤簿月次確定ロック状態
- **server_owned_fields**: `applicationType`, `targetEmployeeId`, `policyVersion`, `approvalRoute` の不変性（改ざん検知時は400/403/422で拒絶）

## 2. ワークフローサイクル仕様（Workflow Cycle Specification）

1. **サイクルインクリメント**: 再申請（RESUBMIT）時、システムは `approval_cycle` をインクリメント（1 → 2 → ...）し、新しい承認ルートステップ群を生成する。
2. **過去ステップの不変保持**: 過去の `approval_cycle` に属するステップレコードは `UPDATE` / `DELETE` せず、`APPROVED` / `RETURNED` / `REJECTED` の事実、コメント、印影、タイムスタンプを恒久保持する。
3. **アクティブステップの限定**: 承認操作は現在アクティブな最新サイクルの `PENDING` ステップのみを対象とする。

## 3. 永続化整合性境界（Persistent State Consistency Boundary）

1. **不可分トランザクション**: 申請・再申請・承認・差戻し・却下・取消の各操作は、以下の永続化処理を単一DBトランザクション（All-or-Nothing）で実行する。
   - 申請本体ステータス更新
   - 承認ステップ追加・更新
   - 残日数/残時間テーブルの更新（該当する場合）
   - AuditLog レコードの永続化
2. **ロールバック保証**: 上記いずれかの処理で例外または不整合が発生した場合、DB状態は処理開始前の状態へと完全にロールバックされ、部分成功状態を残さない。

## 4. ドメインライフサイクル分離（Domain Lifecycle Isolation）

1. **出張命令と復命書**:
   - 出張命令（Travel Order）と復命書（Travel Report）は独立した状態フィールドおよび承認サイクルで管理する。
   - 復命書の差戻し（`REPORT_RETURNED`）や再提出は出張命令の承認（`TRIP_APPROVED`）状態を維持し、出張命令自体の再承認を要求しない。
2. **申請と月次確定**: 月次確定ドメインがロックされた後でも、過去の承認履歴自体は破壊されず、確定フラグと過去履歴が整合的に共存する。

## 5. Policy-Driven Workflow Engine 仕様（Policy-Driven Architecture）

1. **三層分離アーキテクチャ**:
   - `Application Type`（申請種別）: 業務データの入力スキーマと意味を定義。
   - `Workflow Policy / Policy Version`（承認ポリシー）: 承認経路・ステップ・優先度・有効期間・条件判定を定義。
   - `Position / Role`（組織役職と権限ロール）: 組織階層における単一担当制の役職（Position: 教頭、校長等）と、複数保持可能な認可ロール（Role: 教職員、教頭、校長等）を明確に分離。
2. **決定論的 Policy Resolution**:
   - 申請提出時または再提出時の基準日において、該当申請種別に紐づく `ACTIVE` かつ有効期間内の Policy Version 群を抽出。
   - 最高 `priority`（整数値）を持つバージョンを決定論的に 1 件選択。
   - 合致するポリシーが 0 件の場合は `WORKFLOW_POLICY_UNRESOLVED` (400) で Fail-Closed。
   - 同一最高優先度の候補が 2 件以上重複する場合は `WORKFLOW_POLICY_AMBIGUOUS` (400) で Fail-Closed。
3. **Step 担当者解決とスナップショット保存**:
   - `POSITION` セレクター: `holder_type = 'SINGLE_HOLDER'` の役職マスタおよび `user_positions` から基準日時点の担当者を一意に解決。
   - `ROLE` セレクター: `user_roles` から該当ロール保持者を抽出（申請者本人および起案者を除く）。
   - 各ステップの定義・担当者情報・役職名等は `workflow_cycle_steps` および `application_approval_steps` へ完全スナップショット保存され、後からの組織改編やポリシー変更の影響を受けない。
4. **最終決裁ステップ Multiplicity**:
   - 各 Policy Version において、`is_final_decision_step = 1` を持つステップは **Exactly One（厳密に1件）** でなければならず、0 件または 2 件以上のポリシー定義は保存・有効化・解決時に 422 で拒絶される。
5. **Policy Version ライフサイクルと完全不変性**:
   - `DRAFT` → `ACTIVE` → `INACTIVE` / `ARCHIVED` の明示的状態遷移を持つ。
   - `ACTIVE` 状態となったバージョンの業務定義（steps, priority, effective_from/to, conditions_json 等）は **完全 Immutable** であり UPDATE / DELETE を禁止する。
   - 新バージョンへの切替は `PolicyActivationService` により単一トランザクションで Atomic に実行され、旧バージョンの退役日（`retired_at`）が正確に記録される。
6. **条件付き Workflow Cycle Invariant**:
   - **NEW_POLICY_ENGINE Cycle**:
     - `workflow_source = 'NEW_POLICY_ENGINE'`
     - `workflow_policy_version_id IS NOT NULL`
     - `policy_evaluation_at IS NOT NULL`
     - `started_by_user_id IS NOT NULL`
     - Exactly 1 つの Policy Version と紐づく。
   - **LEGACY_SNAPSHOT Cycle**:
     - `workflow_source = 'LEGACY_SNAPSHOT'`
     - `workflow_policy_version_id IS NULL` を許容
     - `policy_evaluation_at IS NULL` を許容
     - 過去データの完全保全を保証。


# Audit Protocol

監査は以下の厳格な10フェーズで行う。

### Phase 1: READ-ONLY Repository Inspection
コード・Migration・設定ファイルを変更せずに精査する。

### Phase 2: Constitution / Policy / Spec 比較
- 8大原則（Immutability, Consistency Boundary, SSOT Domain Logic, Server Identity, Cycle Separation, Lifecycle Isolation, Idempotency, Baseline Protection）および Core Protection & Controlled Evolution Policy（Layer A/B/C 分類、Smallest Safe Change、Scope Creep なきこと）との整合性を確認。

### Phase 3: Invariant 検証
- `INV-001`〜`INV-030` の全不変条件に対する抵触の有無を静的・動的に検証。

### Phase 4: Adversarial & Boundary Test
- 権限突破、自己承認試行、Client値改ざん、並行重複リクエスト、トランザクション途中失敗（Rollback）、差戻し後の過去履歴破壊を探索。

### Phase 5: P0 / P1 / P2 / P3 分類
- `severity-rules.md` に基づき客観的に分類（自己都合での格下げ禁止）。

### Phase 6: Root Cause Analysis
- 表面的な対症療法ではなく、根本原因（Architecture/Policy/Spec欠陥）を特定。

### Phase 7: Fix（実装修正）
- 実装コードを品質基準へ適合させる（品質基準を実装へ合わせない。Smallest Safe Change 厳守）。

### Phase 8: Regression / Golden Test 追加
- 再発防止および新確定した学校実務（School Reality）の知識化のため、最小1件以上の Regression / Golden / Boundary Test を記録・実装。

### Phase 9: Full Regression & Golden Test 実行
- Core Regression Shield（全テストスイートおよび Golden Cases）を実行し 100% PASS および Quality Coverage Baseline の維持を確認。

### Phase 10: Quality Baseline Change Control & Re-Audit
- 品質基盤の変更が Baseline Change Control の5類型（UNCHANGED / STRENGTHENED / SEMANTIC_CHANGE / RELAXED / UNKNOWN）に準拠していることを確認（RELAXED / SEMANTIC_CHANGE は PO/QA 承認ログの存在を確認）し、最終監査を完了する。

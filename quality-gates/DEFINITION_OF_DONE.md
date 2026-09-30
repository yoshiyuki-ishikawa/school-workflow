# Definition of Done

機能完成（DoD）判定条件：

- [ ] Acceptance Criteria 充足
- [ ] Change Classification 明示（Layer A/B/C, Core Impact: NO/INDIRECT/DIRECT）
- [ ] Unit / Integration / API Tests PASS
- [ ] Golden Cases PASS（GOLDEN-001〜006等）
- [ ] Boundary Tests PASS
- [ ] Regression Tests PASS（REG-2026-003等）
- [ ] TypeScript typecheck PASS
- [ ] Build PASS
- [ ] P0 = 0 かつ P1 = 0
- [ ] Invariant 違反 = 0（INV-001〜030）
- [ ] Core Regression Shield PASS
- [ ] Quality Coverage Baseline 維持（8大カバレッジ維持・未承認スキップゼロ）
- [ ] 永続化整合性境界・Rollback 検証 PASS
- [ ] 履歴不変性（Immutable History）検証 PASS
- [ ] Authoritative Domain Logic の重複なき利用検証 PASS
- [ ] Server-Owned Identity 改ざん耐性検証 PASS
- [ ] Migration 検証 PASS
- [ ] RBAC / 自己承認遮断 検証 PASS
- [ ] Smallest Safe Change 遵守（不要なコア改変ゼロ）
- [ ] Baseline Change Control 遵守（無承認の緩和ゼロ）
- [ ] 未解決事項・仕様変更の PO / QA への明示
- [ ] Documentation（Spec / Policy / Invariants）更新済み

実行していないテストをPASSと報告してはならない。

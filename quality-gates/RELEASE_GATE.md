# Release Gate

本番投入（リリース）条件：

## Gate 1 — Specification & Architecture
- Constitution & Core Protection Policy 整合（8大原則・統治規範適合）
- Change Classification 明示（Layer A/B/C、Core Impact: NO/INDIRECT/DIRECT、UNKNOWN遮断）
- Smallest Safe Change 検証（不要なコア改変ゼロ）
- Policy / Spec 整合
- Authoritative Domain Logic の一元化（重複再実装ゼロ）
- Server-Owned Identity 保護（Client改ざん耐性 PASS）

## Gate 2 — Security & Authorization
- Authentication PASS
- Authorization / RBAC PASS
- Self-Approval Prevention PASS（自己承認遮断）

## Gate 3 — Data & State Consistency
- Migration Fresh / Upgrade PASS
- Historical Record Immutability PASS（過去ステップ・監査ログの不変保持）
- Persistent State Consistency PASS（Rollback検証・部分Commitゼロ）
- Idempotency PASS（二重計上・二重減算ゼロ）

## Gate 4 — Business & Domain Integrity
- Workflow Cycle Separation PASS（再処理の独立サイクル化）
- Domain Lifecycle Isolation PASS（出張・復命等の独立性保持）
- Attendance Resolution PASS（Canonical Facts整合）
- Reporting / PDF DTO PASS（UI依存なし、Document Fidelity分離）
- Golden Cases PASS（GOLDEN-001〜006等）

## Gate 5 — Regression & Boundaries
- Boundary Tests PASS
- Full Regression Suite PASS（REG-2026-003等）
- Core Regression Shield PASS（回帰防護スイート100%成功）
- Quality Coverage Baseline PASS（8大品質カバレッジ維持・スキップゼロ）

## Gate 6 — Risk & Quality Baseline Integrity
- P0 = 0
- P1 = 0
- Invariant 違反 = 0（INV-001〜032）
- Baseline Change Control PASS（無承認の基準緩和ゼロ、RELAXED/SEMANTIC_CHANGE は PO/QA 承認済み）
- 未解決の Human Decision（AI Mandatory Stop 事項）= 0
- Evidence Architecture & Stage Boundary Integrity PASS（Stage 1 PILOT READY ≠ PRODUCTION READY, TIME ≠ QUALITY, VOLUME ≠ COVERAGE, No Arbitrary Threshold 遵守）

---

### 最終判定区分

- **GO**: Gate 1〜6 全項目が PASS
- **CONDITIONAL GO**: P0=0, P1=0 であり、軽微なP2/P3のフォローアップ計画がPOにより承認されている場合
- **NO-GO**: P0 >= 1 または P1 >= 1、あるいは Gate 1〜6 のいずれかに不合格項目が存在する場合


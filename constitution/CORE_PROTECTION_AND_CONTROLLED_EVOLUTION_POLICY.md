# School Workflow Core Protection & Controlled Evolution Policy

## 1. Purpose & Core Philosophy

本Policyは、School Workflowシステムにおける**Protected Core（保護対象コア）の堅牢性を防護しつつ、学校実務の現場適合（School Reality）を安全かつ継続的に実現するControlled Evolution（制御された進化）**の統治規範を定義する。

### 1-1. Core Extension ≠ Core Violation
Protected Coreは「一切の変更を禁止（Freeze）する領域」ではない。
本Policyが禁止するのは、**無承認・無証拠・偶発的・意味論不明（Unknown）なコアの破壊や改変**である。
システムの成熟や制度改定に伴う正当なコアの拡張・改善・進化（Controlled Core Evolution）は正式な手続き（CCR / PO・QA承認）を経て安全に実行される。

---

## 2. Three-Tier Architecture & Change Classification

すべての変更要求（Change Request）および実装作業は、以下の三層（Layer A / B / C）に分類される。

### Layer A — PROTECTED CORE（防護コア）
* **対象領域**:
  - ワークフロー実行エンジン（`WorkflowEngine`, `PolicyResolutionEngine`）
  - トランザクション境界および永続化整合性（`TransactionBoundary`）
  - 認可・サーバー所有アイデンティティ（`ServerAuthoritativeValidator`, RBAC）
  - 服務競合判定エンジン（`ConflictEngine`）
  - 監査証跡・履歴不変モデル（`HistoricalAuditRepository`, `application_approval_steps`）
  - Canonical Invariants（`tests/invariants.md`: `INV-001`〜`INV-032`）
  - Evidence Architecture & Stage Boundary Governance（Stage 1 / Stage 2 / Stage 3）
* **変更区分**:
  - **A1: Non-Semantic Core Change**: 型定義の強化、コメント補足、挙動不変のリファクタリング（回帰テスト通過で実施可能）
  - **A2: Compatible Core Extension**: 新規拡張ポイントの追加、Policy Engineの後方互換拡張、Canonical Factsへのオプショナル属性追加、新Invariantの追加（Core Impact Analysis・回帰テスト通過で実施可能）
  - **A3: Core Semantic Change**: 状態遷移の意味変更、トランザクション境界変更、Server Authority境界変更、履歴モデル変更、既存Invariant再定義、Stage境界再定義（**Core Change Request (CCR) 作成および PO/QA 事前承認が必須**）

  - **A4: Unknown Core Change**: 影響範囲が未確定な変更（**AI Mandatory Stop / Fail-Closed**）

### Layer B — EVOLVABLE DOMAIN（適応ドメイン）
* **対象領域**: 自治体条例・独自休暇ルール、勤務形態パターン、新様式用メタデータ、Domain Policy YAML/Markdown
* **規約**: CoreのAPI・拡張ポイント（Policy-Driven Engine）を通じて追加・変更。Golden / Boundary / Regression テストの追加を必須とする。

### Layer C — PRESENTATION / SCHOOL EXPERIENCE（表現・体験）
* **対象領域**: 画面文言、入力アシスタントUI、PDF座標・フォント・罫線・改ページ調整、CSVフォーマッタ
* **規約**: Canonical Facts（Domain DTO）の描画責務のみを担い、制度判定ロジックを持たない。UIスナップショットや表示確認テストで検証。

---

## 3. Policy Requirements & Traceability

本Policyにおける重要要件（`CP-REQ-*`）と、単一SSOTである `/tests/invariants.md` の Canonical Invariants（`INV-*`）への対応関係は以下の通りである。

### CP-REQ-001: Core Regression Protection
- **概要**: 過去に確立されたコアの振る舞い・不具合再発防止テスト（Core Regression Shield）を破壊してはならない。
- **Canonical Invariant**: `INV-027` [INV-CORE-REGRESSION-PROTECTION]

### CP-REQ-002: No Incidental Core Refactoring
- **概要**: ドメイン改修（Layer B）や画面修正（Layer C）に付随して、要求仕様外の不要なコアリファクタリングを混入させてはならない。
- **Canonical Invariant**: `INV-028` [INV-NO-INCIDENTAL-CORE-REFACTORING]

### CP-REQ-003: Smallest Safe Change
- **概要**: すべての変更は、要求仕様を満たす必要最小限の差分（Scope-Constrained Diff）で実装しなければならない。
- **Canonical Invariant**: `INV-029` [INV-SMALLEST-SAFE-CHANGE]

### CP-REQ-004: Canonical Fact Preservation
- **概要**: 申請検証・出勤簿解決・帳票描画は、独自の再実装を行わず共通Authoritative Domain Logicから導出された正規事実（Canonical Facts）を根拠としなければならない。
- **Canonical Invariant**: `INV-019` [INV-VALIDATOR-SSOT]

### CP-REQ-005: Historical Record Immutability
- **概要**: 成立済みの承認・差戻し・コメント・印影・日時の監査履歴は、後続操作によって削除・上書き・意味変更してはならない。
- **Canonical Invariant**: `INV-016` [INV-HISTORY-IMMUTABLE], `INV-020` [INV-WORKFLOW-CYCLE]

### CP-REQ-006: Quality Coverage Baseline Preservation
- **概要**: テスト件数の増減にかかわらず、8大品質カバレッジ（Invariant, Golden, Boundary, Regression, Workflow, Security, Migration, Parity）を無承認で低下させてはならない。
- **Canonical Invariant**: `INV-030` [INV-QUALITY-COVERAGE-BASELINE]

### CP-REQ-007: Fail-Closed Preservation
- **概要**: 未知の状態・競合・Policy未解決時は、推測で正常処理せず即座に処理を遮断（Fail-Closed）しなければならない。
- **Canonical Invariant**: `INV-007`, `INV-008`, `INV-022`

### CP-REQ-008: Server Authority Preservation
- **概要**: 業務判定・申請種別・対象者・承認ルート・残数等の本質的属性はServerが所有し、Client送信値のみによる変更・改ざんを遮断しなければならない。
- **Canonical Invariant**: `INV-001`, `INV-006` [INV-SERVER-OWNED-IDENTITY]

### CP-REQ-009: Evidence Before Acceptance
- **概要**: 未実行のテストや客観的証跡のない申告を合格（PASS）として扱ってはならない。
- **Canonical Invariant**: `INV-021` [INV-BASELINE-PROTECTION]

### CP-REQ-010: PO/QA Authority & Human Decision Gate
- **概要**: 法令解釈・Core Semantic Change・Quality Baselineの変更は、AI単独で決定できずPO/QAの明示的承認を必須とする。
- **Canonical Invariant**: `INV-021` [INV-BASELINE-PROTECTION], `constitution/HUMAN_DECISION_RULES.md`

---

## 4. Baseline Change Control

品質基準ファイル（憲法、Invariants、Golden Cases、Severity Rules、Release Gates、DoD、YAML等）の変更は以下の5類型に分類され、統治される。

1. **`UNCHANGED`**: 意味変更なし（文言整形等） → **PASS**
2. **`STRENGTHENED`**: 基準強化（新Invariant/Gate追加等） → **PASS（証跡記録）**
3. **`SEMANTIC_CHANGE`**: 正当な仕様・条例変更に伴う期待値等の再定義 → **PO/QA Human Decision Gate 必須**
4. **`RELAXED`**: 基準緩和（テスト通過目的のInvariant削除・アサーション弱体化等） → **原則 BLOCK（例外時のみPO/QA事前承認・代替防護策の記録必須）**
5. **`UNKNOWN`**: 影響特定不能 → **Fail-Closed（AI Mandatory Stop）**

---

## 5. Domain Correctness & Document Fidelity Separation

* **Domain Correctness（制度計算の正しさ）**:
  - 法令・条例に基づく休暇時間数・残日数等の計算は純粋関数的な Authoritative Domain Logic が担当する。
  - 計算結果は純粋なデータ構造である Canonical Facts (Domain DTO) として導出される。
* **Document Fidelity（帳票の表現忠実度）**:
  - PDF/CSV/画面レンダラーは Canonical Facts を受け取って描画・文字列フォーマット（例: 「特休（2時間）」）を行う。
  - レンダラー内部で条件分岐して制度計算を行ってはならず、フォント・罫線・改ページ等の視覚調整は Domain Invariant に影響を与えない。

---

## 6. Golden Knowledge Accumulation Principle

> **Every confirmed school reality becomes regression knowledge.**  
> （確定した学校実務の正解は、永続的な回帰知識として固定される）

学校現場UATやヒアリングで確定した正解は、その性質に応じて以下のテスト資産へ昇格・蓄積する。
* **制度・条例の標準的正解**: `tests/golden-cases.md` へ **Golden Case** として追加。
* **制度境界・端数処理・極限状態**: `tests/boundary-cases.md` へ **Boundary Case** として追加。
* **現場乖離（Reality Gap）・不具合の修正**: `tests/regression-catalog.md` へ **Regression Case** として追加。

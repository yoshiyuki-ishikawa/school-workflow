# System Invariants

以下は常時成立しなければならない。

### INV-001
本人は自分の申請を承認できない（自己承認禁止）。

### INV-002
未承認申請は正式出勤簿へ反映されない。

### INV-003
却下申請は正式出勤簿へ反映されない。

### INV-004
削除・取消済み申請は正式集計へ入らない。

### INV-005 [INV-IDEMPOTENT-ACCOUNTING]
同一業務イベントの再送信、API再試行、再申請、再実行によって、年休・残日数・残時間・件数・旅費・出勤簿集計等を二重計上・二重減算しない（Financial / Leave Balance Idempotency）。

### INV-006 [INV-SERVER-OWNED-IDENTITY]
Client値だけで既存業務オブジェクトの本質的属性（申請種別、対象者、組織、制度バージョン、承認ルート等）を変更できず、Server判定を変更できない（Server-Owned Immutable Identity）。

### INV-007
UNKNOWN_PATTERNは正式状態へ自動変換されない。

### INV-008
Policy不明状態はFail-Closedする。

### INV-009
休憩時間を二重控除しない。

### INV-010
勤務時間外を休暇時間として計上しない。

### INV-011
年度と休暇付与期間を混同しない。

### INV-012
短時間勤務者を通常勤務として計算しない。

### INV-013
権限のないユーザーは承認できない。

### INV-014
Migrationで既存データを黙って消失させない。

### INV-015
同一入力＋同一Policyから常に同一結果を返す（Deterministic Calculation）。

### INV-016 [INV-HISTORY-IMMUTABLE]
一度成立した承認、確認、差戻し、却下、申請、再申請、取消、復命、帳票確定、ステータス遷移、actor、comment、timestamp等の業務・承認・監査履歴は、後続操作によって削除・上書き・意味変更してはならない（Historical Record Immutability）。

### INV-017 [INV-BUSINESS-ATOMIC]
1つの業務操作に含まれる永続化処理は単一の整合性境界（All-or-Nothing）で実行され、中間失敗時に部分成功状態をDBへ残してはならない（Persistent State Consistency）。

### INV-018 [INV-DOMAIN-LIFECYCLE]
法的・業務的な成立時点や承認サイクルが異なる業務ドメイン（出張命令と復命書、申請と報告、承認と月次確定等）は相互の成立済み状態を破壊・巻き戻ししない（Domain Lifecycle Isolation）。

### INV-019 [INV-VALIDATOR-SSOT]
同一の制度的事実・条例ルール・計算ロジックを複数箇所へ重複実装せず、共通のAuthoritative Domain Logic / Canonical Factsを一元的な根拠とする（Shared Authoritative Domain Logic / SSOT）。

### INV-020 [INV-WORKFLOW-CYCLE]
再申請・再承認等の再処理は過去Workflowを巻き戻さず、新Revision / 新Cycleとして独立記録する（Workflow Cycle Separation）。

### INV-021 [INV-BASELINE-PROTECTION]
テスト通過やGO判定を得る目的で、Constitution, Invariants, Golden Cases, Severity Rules, Release Gates, Definition of Done, Audit Rules を自己都合で緩和・削除・改ざんしてはならない（Quality Baseline Protection）。

### INV-022 [INV-WORKFLOW-POLICY-RESOLUTION]
申請種別および評価基準日に対し、決定論的に合致する最高優先度の ACTIVE Policy Version を 1 件解決し、0件合致時（WORKFLOW_POLICY_UNRESOLVED）および同優先度重複時（WORKFLOW_POLICY_AMBIGUOUS）は即座に Fail-Closed 遮断する（Deterministic Policy Resolution）。

### INV-023 [INV-FINAL-DECISION-EXACTLY-ONE]
各 Policy Version に含まれる最終決裁ステップ（is_final_decision_step = 1）は厳密に 1 件（Exactly One）でなければならず、0件または2件以上のステップ定義はバリデーションおよび実行時に拒絶される（Final Decision Step Multiplicity）。

### INV-024 [INV-POLICY-VERSION-IMMUTABLE]
ACTIVE 状態となった Policy Version の業務定義（steps, priority, effective_from/to, conditions_json 等）は完全 Immutable であり、更新時は新規ドラフト作成と Atomic な世代交代（PolicyActivationService）を経て退役日を記録する（Active Policy Version Immutability）。

### INV-025 [INV-CANONICAL-WORKFLOW-CYCLE]
新ポリシーエンジン下で開始された各承認サイクル（NEW_POLICY_ENGINE）は、Exactly 1 つの Policy Version と紐づき、評価日時・起案者・ステップスナップショットを不変に保持する。旧スナップショットサイクル（LEGACY_SNAPSHOT）の過去データも完全保全される（Canonical Workflow Cycle Integrity）。

### INV-026 [INV-CANONICAL-ATTENDANCE-NAME]
School Workflowにおける出勤簿のCanonical Domain NameおよびCanonical Keyは、それぞれ「出勤簿」および既存の `ATTENDANCE_BOOK` とする。
自治体・任命権者固有の「第○号様式」「別記様式第○号」「第○条関係」等を、ドメイン識別子、Canonical Key、DB識別キー、API契約、固定UI文言、固定帳票文言として使用してはならない。
学校組織情報からは自治体固有の規程名称設定を撤去し、将来必要な場合はPolicy/Jurisdictionメタデータ層で管理する。
ただし、Historical Migration、Legacy Fixture、過去データ識別、互換性維持等のため旧値を識別する必要がある場合は例外とし、その用途を明示する。

### INV-027 [INV-CORE-REGRESSION-PROTECTION]
過去に確立されたProtected Coreの振る舞い・不具合再発防止テスト（Core Regression Shield）を破壊・無効化してはならない（Core Regression Protection）。

### INV-028 [INV-NO-INCIDENTAL-CORE-REFACTORING]
ドメイン改修（Layer B）や画面修正（Layer C）に付随して、要求仕様外の不要なコアリファクタリングを混入させてはならない（No Incidental Core Refactoring）。

### INV-029 [INV-SMALLEST-SAFE-CHANGE]
すべての変更は要求仕様を満たす必要最小限の差分（Scope-Constrained Diff）で実装されなければならず、広範囲な巻き込み修正を行ってはならない（Smallest Safe Change）。

### INV-030 [INV-QUALITY-COVERAGE-BASELINE]
テスト件数の増減にかかわらず、8大品質カバレッジ（Invariant, Golden, Boundary, Regression, Workflow, Security, Migration, Parity）をPO/QAの明示的承認なく低下・スキップさせてはならない（Quality Coverage Baseline Preservation）。

### INV-031 [INV-EVIDENCE-ARCHITECTURE-INTEGRITY]
品質保証において、時間の長さ（Time）を品質（Quality）の代理指標としてはならず、件数（Volume）を網羅性（Coverage）の代理指標としてはならない（TIME ≠ QUALITY, VOLUME ≠ COVERAGE）。仕様テスト合格（Test Pass）は実務適合性（Real-World Fitness）と等価ではなく（TEST PASS ≠ REAL-WORLD FITNESS）、パイロット可能（Pilot Ready）は本番投入可能（Production Ready）を意味しない（PILOT READY ≠ PRODUCTION READY）。測定プロトコルパラメータは品質合否判定基準ではなく、両者を混同・すり替えてはならない（MEASUREMENT PARAMETER ≠ QUALITY THRESHOLD）。

### INV-032 [INV-CUTOVER-AUTHORITY-GOVERNANCE]
Stage 1（Pre-Production Technical Readiness）の完了は本番権威（Production Authority）への昇格を意味せず（STAGE 1 PASS ≠ PRODUCTION AUTHORITY）、本番権威への昇格後も未知の将来障害・長期劣化・将来の法令改定に対する絶対的安全性が証明されたわけではない（PRODUCTION AUTHORITY ≠ ABSOLUTE SAFETY）。本番権威切替の承認は切替時点の適格性承認であり、将来にわたる恒久的な信頼性証明と同一視してはならず、切替後の継続的保証（Post-Cutover Continuous Assurance）を要する（CUTOVER AUTHORIZATION ≠ PERMANENT RELIABILITY PROOF）。




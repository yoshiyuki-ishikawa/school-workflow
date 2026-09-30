# Golden Cases

Golden Testは業務上「これが絶対に正解」という代表ケースを固定する。

各ケースに以下を保存する。
- Case ID
- Input
- Policy
- Expected Result
- 根拠
- 承認者
- 承認日

Golden Caseの期待値変更にはプロダクトオーナーの明示的承認（Human Approval / Baseline Change Control: SEMANTIC_CHANGE）を必要とする。

## 知識蓄積原則（Golden Knowledge Accumulation）
- **School Reality 正解の恒久化**: 条例・服務規程・学校実務上「これが絶対に正解」と確定した標準事例は、新規 Golden Case として本台帳および `server/src/tests/golden/` へ順次蓄積・昇格する。
- **過剰品質化の防止**: UIレイアウトや文言の変更には適用せず、制度・計算・状態遷移の標準正解に限定する。境界値は `boundary-cases.md`、不具合再発防止は `regression-catalog.md` へ分離する。

---

## 恒久 Golden Cases

### GOLDEN-001: 履歴保持（Historical Record Preservation）
- **概要**: 申請 → 第1承認 → 差戻し → 再申請（Cycle 2） → 最終承認 の全工程完了後、Cycle 1 および Cycle 2 の全ステップ（actor, comment, stamp, timestamp）が改変・欠損なく保持されていること。
- **検証Invariant**: `INV-016` (INV-HISTORY-IMMUTABLE), `INV-020` (INV-WORKFLOW-CYCLE)

### GOLDEN-002: トランザクションロールバック（Transaction Rollback）
- **概要**: 複数テーブル更新（申請更新、ステップ追加、残数減算、AuditLog記録）の途中で意図的なエラーを発生させた際、全DBテーブルが処理開始前の状態と完全一致すること（部分成功の禁止）。
- **検証Invariant**: `INV-017` (INV-BUSINESS-ATOMIC)

### GOLDEN-003: ドメインロジックパリティ（Domain Logic Parity）
- **概要**: 同一教職員・同一期間の休暇データについて、申請時検証（Submit Validation）、出勤簿解決（Attendance Resolution）、帳票描画（Reporting DTO）が共通Authoritative Domain Logicに基づき、制度的事実・計算結果において矛盾なく整合すること。
- **検証Invariant**: `INV-019` (INV-VALIDATOR-SSOT), `INV-015`

### GOLDEN-004: クライアント改ざん耐性（Client Tampering Resistance）
- **概要**: Clientがリクエストボディ内で `typeId`、`targetEmployeeId`、`approvalRoute` などのServer所有属性を改ざんして送信した場合、Serverが確実に検知して拒絶（400/403/422）すること。
- **検証Invariant**: `INV-006` (INV-SERVER-OWNED-IDENTITY)

### GOLDEN-005: 残数・集計の冪等性（Balance Idempotency）
- **概要**: 通信エラー等による同一APIリクエストの再送信、および差戻し後の再申請・決裁において、年休残日数・残時間の二重減算や出勤簿集計の二重計上が一切発生しないこと。
- **検証Invariant**: `INV-005` (INV-IDEMPOTENT-ACCOUNTING)

### GOLDEN-006: ドメインライフサイクル分離（Domain Lifecycle Isolation）
- **概要**: 出張命令が承認済（`TRIP_APPROVED`）となった後の復命書が差戻し・再提出された場合でも、成立済みの出張命令の承認状態および出勤簿上の出張服務反映が保護され、巻き戻されないこと。
- **検証Invariant**: `INV-018` (INV-DOMAIN-LIFECYCLE)

---

## 25項目服務状態 Canonical Golden Truth 台帳 (GT-01 〜 GT-25)

本台帳は、Canonical Service Fact Architecture における 25 服務状態の独立 Ground Truth 仕様を定義する。
Legacy AttendanceEngine の出力は正解源（Ground Truth）ではなく、比較診断対象（Diagnostic Reference）として扱う（INV-031, INV-032）。

### [GT-01] 通常勤務日 (Standard Workday)
- **服務種別**: 通常勤務 (`WORKED`)
- **Source ID**: LEGAL-ATT-WORKDAY-01
- **Source Type**: ORDINANCE / REGULATION
- **Document / SSOT**: 自治体職員の勤務時間、休暇等に関する条例および学校職員服務取扱規程
- **Article / Section**: 勤務時間及び勤務割振規定（週38時間45分、1日7時間45分）
- **Verification Status**: VERIFIED
- **前提条件**: 勤務パターン=標準（8:15〜16:45）、祝日・週休なし
- **Input Fact**: 該当なし (通常勤務割)
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `dutyStatus`: `'WORK_REQUIRED'`
  - `scheduledWorkMinutes`: `465`
  - `countedWorkMinutes`: `465`
  - `deductionMinutes`: `0`
  - `effectiveWorkMinutes`: `465`
  - `primaryCanonicalStatus`: `'WORKED'`
  - `displaySymbol`: `'出'`
- **Relevant Invariants**: `INV-009`, `INV-010`, `INV-015`
- **Legacy Diagnostic Behavior**: MATCH_EXACT (`AttendanceEngine` も 465分・「出」を返却)

### [GT-02] 定例週休日 (Weekly Off)
- **服務種別**: 定例週休日 (`WEEKLY_OFF`)
- **Source ID**: LEGAL-ATT-WEEKLY-OFF-01
- **Source Type**: ORDINANCE / REGULATION
- **Document / SSOT**: 自治体職員の勤務時間、休暇等に関する条例（土曜日及び日曜日を週休日とする規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `dutyStatus`: `'NO_WORK_REQUIRED'`
  - `scheduledWorkMinutes`: `0`
  - `effectiveWorkMinutes`: `0`
  - `primaryCanonicalStatus`: `'WEEKLY_OFF'`
  - `displaySymbol`: `'休'` または `'週休'`
- **Relevant Invariants**: `INV-010`, `INV-015`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-03] 国民の祝日 (National Holiday)
- **服務種別**: 国民の祝日 (`HOLIDAY`)
- **Source ID**: LEGAL-ATT-HOLIDAY-01
- **Source Type**: LAW
- **Document / SSOT**: 国民の祝日に関する法律 / 自治体勤務時間条例（休日の規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `dutyStatus`: `'NO_WORK_REQUIRED'`
  - `scheduledWorkMinutes`: `0`
  - `primaryCanonicalStatus`: `'HOLIDAY'`
  - `displaySymbol`: `'祝'`
- **Relevant Invariants**: `INV-010`, `INV-015`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-04] 学校独自休日 (School Custom Holiday)
- **服務種別**: 学校独自休日 (`HOLIDAY`)
- **Source ID**: POLICY-ATT-CUSTOM-HOLIDAY-01
- **Source Type**: REGULATION
- **Document / SSOT**: 学校管理規則（開校記念日等）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `scheduledWorkMinutes`: `0`
  - `primaryCanonicalStatus`: `'HOLIDAY'`
- **Relevant Invariants**: `INV-010`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-05] 週休振替 (Week-off Transfer)
- **服務種別**: 振替勤務日 / 振替週休日 (`WORKED` / `WEEKLY_OFF`)
- **Source ID**: LEGAL-ATT-TRANSFER-01
- **Source Type**: ORDINANCE / REGULATION
- **Document / SSOT**: 自治体職員勤務時間条例（週休日の振替及び半日勤務時間の割振り変更規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - 振替元日曜: `isScheduledWorkDay: true`, `scheduledWorkMinutes: 465`, `displaySymbol: '勤務日'`
  - 振替先月曜: `isScheduledWorkDay: false`, `scheduledWorkMinutes: 0`, `displaySymbol: '週休'`
- **Relevant Invariants**: `INV-005`, `INV-015`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-06] 休日代休 (Substitute Holiday)
- **服務種別**: 代休指定日 (`SUBSTITUTE_HOLIDAY`)
- **Source ID**: LEGAL-ATT-SUBSTITUTE-01
- **Source Type**: ORDINANCE / REGULATION
- **Document / SSOT**: 自治体職員勤務時間条例（休日の代休日の指定規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `scheduledWorkMinutes`: `0`
  - `primaryCanonicalStatus`: `'SUBSTITUTE_HOLIDAY'`
  - `displaySymbol`: `'代休'`
- **Relevant Invariants**: `INV-010`, `INV-015`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-07] 単日勤務日化 (Single Workday Override)
- **服務種別**: 行事等による勤務日指定 (`WORKED`)
- **Source ID**: POLICY-ATT-OVERRIDE-01
- **Source Type**: REGULATION
- **Document / SSOT**: 学校行事計画・年間勤務計画規程
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `scheduledWorkMinutes`: `465`
  - `primaryCanonicalStatus`: `'WORKED'`
  - `displaySymbol`: `'出'` または `'土曜授業'`
- **Relevant Invariants**: `INV-015`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-08] 単日非勤務日化 (Single Off-day Override)
- **服務種別**: 行事等による非勤務日指定 (`HOLIDAY`)
- **Source ID**: POLICY-ATT-OVERRIDE-02
- **Source Type**: REGULATION
- **Document / SSOT**: 学校行事計画・年間勤務計画規程
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `scheduledWorkMinutes`: `0`
  - `primaryCanonicalStatus`: `'HOLIDAY'`
  - `displaySymbol`: `'休'`
- **Relevant Invariants**: `INV-010`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-09] 研修 (Training)
- **服務種別**: 教育公務員特例法第22条研修 (`TRAINING`)
- **Source ID**: LEGAL-ATT-TRAINING-01
- **Source Type**: LAW
- **Document / SSOT**: 教育公務員特例法 第22条第2項（教育公務員の研修）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `scheduledWorkMinutes`: `465`
  - `countedWorkMinutes`: `465`
  - `deductionMinutes`: `0`
  - `primaryCanonicalStatus`: `'TRAINING'`
  - `displaySymbol`: `'研'`
- **Relevant Invariants**: `INV-015`, `INV-019`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-10] 公務旅行・出張 (Official Business Trip)
- **服務種別**: 公務旅行 (`OFFICIAL_BUSINESS_TRIP`)
- **Source ID**: LEGAL-ATT-TRIP-01
- **Source Type**: ORDINANCE
- **Document / SSOT**: 職員等の旅費に関する条例及び学校服務規程
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `scheduledWorkMinutes`: `465`
  - `countedWorkMinutes`: `465`
  - `deductionMinutes`: `0`
  - `primaryCanonicalStatus`: `'OFFICIAL_BUSINESS_TRIP'`
  - `displaySymbol`: `'張'`
- **Relevant Invariants**: `INV-018`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-11] 終日年次有給休暇 (Full-day Annual Leave)
- **服務種別**: 年次有給休暇 (`ANNUAL_LEAVE`)
- **Source ID**: LEGAL-ATT-LEAVE-ANNUAL-01
- **Source Type**: ORDINANCE
- **Document / SSOT**: 自治体職員勤務時間条例（年次有給休暇規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `scheduledWorkMinutes`: `465`
  - `countedWorkMinutes`: `0`
  - `deductionMinutes`: `465`
  - `effectiveWorkMinutes`: `0`
  - `primaryCanonicalStatus`: `'ANNUAL_LEAVE'`
  - `displaySymbol`: `'年'`
- **Relevant Invariants**: `INV-005`, `INV-010`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-12] 半日年次有給休暇 (Half-day Annual Leave)
- **服務種別**: 半日年次有給休暇 (`ANNUAL_LEAVE`)
- **Source ID**: LEGAL-ATT-LEAVE-ANNUAL-02
- **Source Type**: ORDINANCE
- **Document / SSOT**: 自治体職員勤務時間条例（半日単位休暇規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `scheduledWorkMinutes`: `465`
  - `deductionMinutes`: `240` (午前半日) または `225` (午後半日)
  - `displaySymbol`: `'前年'` または `'後半'`
- **Relevant Invariants**: `INV-005`, `INV-009`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-13] 時間単位年次有給休暇 (Hourly Annual Leave)
- **服務種別**: 時間年休 (`ANNUAL_LEAVE`)
- **Source ID**: LEGAL-ATT-LEAVE-ANNUAL-03
- **Source Type**: ORDINANCE
- **Document / SSOT**: 自治体職員勤務時間条例（時間単位休暇規定: 60分単位厳守）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `deductionMinutes`: `60` (1時間取得時)
  - `effectiveWorkMinutes`: `405`
  - `displaySymbol`: `'年1'`
- **Relevant Invariants**: `INV-005`, `INV-009`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-14] 病気休暇 (Sick Leave)
- **服務種別**: 病気休暇 (`SICK_LEAVE`)
- **Source ID**: LEGAL-ATT-LEAVE-SICK-01
- **Source Type**: ORDINANCE
- **Document / SSOT**: 自治体職員勤務時間条例 第13条（病気休暇規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `deductionMinutes`: `465`
  - `primaryCanonicalStatus`: `'SICK_LEAVE'`
  - `displaySymbol`: `'病'`
- **Relevant Invariants**: `INV-005`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-15] 育児短時間勤務 (Childcare Short Time)
- **服務種別**: 育児短時間勤務 (`CHILDCARE_SHORT_TIME`)
- **Source ID**: LEGAL-ATT-CHILDCARE-SHORT-01
- **Source Type**: LAW / ORDINANCE
- **Document / SSOT**: 地方公務員の育児休業等に関する法律 第10条 / 自治体条例
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `scheduledWorkMinutes`: `240` (短縮後所定時間)
  - `countedWorkMinutes`: `240`
  - `deductionMinutes`: `0`
  - `effectiveWorkMinutes`: `240`
  - `primaryCanonicalStatus`: `'CHILDCARE_SHORT_TIME'`
  - `displaySymbol`: `'育短'`
- **Relevant Invariants**: `INV-012`
- **Legacy Diagnostic Behavior**: LEGACY_DEFECT (`AttendanceEngine` が旧固定値 465 分を算出する既知不備)

### [GT-16] 介護休暇 (Care Leave)
- **服務種別**: 介護休暇 (`CARE_LEAVE`)
- **Source ID**: LEGAL-ATT-LEAVE-CARE-01
- **Source Type**: ORDINANCE
- **Document / SSOT**: 自治体職員勤務時間条例 第15条（介護休暇規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `deductionMinutes`: `465`
  - `primaryCanonicalStatus`: `'CARE_LEAVE'`
  - `displaySymbol`: `'介'`
- **Relevant Invariants**: `INV-005`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-17] 育児部分休業 (Childcare Partial Leave)
- **服務種別**: 育児部分休業 (`CHILDCARE_PARTIAL_LEAVE`)
- **Source ID**: LEGAL-ATT-CHILDCARE-PARTIAL-01
- **Source Type**: LAW / ORDINANCE
- **Document / SSOT**: 地方公務員の育児休業等に関する法律 第19条
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `deductionMinutes`: `60` (1時間部分休業)
  - `effectiveWorkMinutes`: `405`
  - `primaryCanonicalStatus`: `'CHILDCARE_PARTIAL_LEAVE'`
  - `displaySymbol`: `'部'`
- **Relevant Invariants**: `INV-005`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-18] 育児休業 (Childcare Leave)
- **服務種別**: 育児休業 (`CHILDCARE_LEAVE`)
- **Source ID**: LEGAL-ATT-CHILDCARE-LEAVE-01
- **Source Type**: LAW / ORDINANCE
- **Document / SSOT**: 地方公務員の育児休業等に関する法律 第2条
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `scheduledWorkMinutes`: `0`
  - `primaryCanonicalStatus`: `'CHILDCARE_LEAVE'`
  - `isPersonnelStatusOverridden`: `true`
  - `displaySymbol`: `'育'`
- **Relevant Invariants**: `INV-010`, `INV-015`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-19] 分限休職 (Administrative Suspension)
- **服務種別**: 分限休職 (`ADMINISTRATIVE_LEAVE_SUSPENSION`)
- **Source ID**: LEGAL-ATT-SUSPENSION-ADMIN-01
- **Source Type**: LAW / ORDINANCE
- **Document / SSOT**: 地方公務員法 第28条第2項（休職の事由）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `primaryCanonicalStatus`: `'ADMINISTRATIVE_LEAVE_SUSPENSION'`
  - `displaySymbol`: `'休'`
- **Relevant Invariants**: `INV-010`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-20] 専従休職 (Union Full-time Suspension)
- **服務種別**: 専従休職 (`UNION_FULL_TIME_SUSPENSION`)
- **Source ID**: LEGAL-ATT-SUSPENSION-UNION-01
- **Source Type**: LAW
- **Document / SSOT**: 地方公務員法 第55条の2（職員団体の業務に専従する職員）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `primaryCanonicalStatus`: `'UNION_FULL_TIME_SUSPENSION'`
  - `displaySymbol`: `'専'`
- **Relevant Invariants**: `INV-010`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-21] 懲戒停職 (Disciplinary Suspension)
- **服務種別**: 懲戒停職 (`DISCIPLINARY_SUSPENSION`)
- **Source ID**: LEGAL-ATT-SUSPENSION-DISCIPLINARY-01
- **Source Type**: LAW
- **Document / SSOT**: 地方公務員法 第29条（懲戒）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `false`
  - `primaryCanonicalStatus`: `'DISCIPLINARY_SUSPENSION'`
  - 管理職閲覧時: `displaySymbol: '停'`
  - 一般教職員閲覧時: `displaySymbol: '専'` (プライバシーマスキング)
- **Relevant Invariants**: `INV-010`, `INV-015`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-22] 全日欠勤 (Full-day Absence)
- **服務種別**: 欠勤 (`ABSENCE`)
- **Source ID**: LEGAL-ATT-ABSENCE-FULL-01
- **Source Type**: ORDINANCE / REGULATION
- **Document / SSOT**: 自治体職員給与条例（勤務1時間当たりの給与額減額規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `deductionMinutes`: `465`
  - `effectiveWorkMinutes`: `0`
  - `primaryCanonicalStatus`: `'ABSENCE'`
  - `displaySymbol`: `'欠'`
- **Relevant Invariants**: `INV-005`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-23] 時間欠勤 (Hourly Absence)
- **服務種別**: 時間欠勤 (`ABSENCE`)
- **Source ID**: LEGAL-ATT-ABSENCE-HOURLY-01
- **Source Type**: ORDINANCE / REGULATION
- **Document / SSOT**: 自治体職員給与条例（欠勤減額計算規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `isScheduledWorkDay`: `true`
  - `deductionMinutes`: `120` (2時間欠勤)
  - `effectiveWorkMinutes`: `345`
  - `primaryCanonicalStatus`: `'ABSENCE'`
  - `displaySymbol`: `'欠'`
- **Relevant Invariants**: `INV-005`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-24] 欠勤の事後訂正 (Absence Correction to Leave)
- **服務種別**: 事後振替 (`ANNUAL_LEAVE`)
- **Source ID**: POLICY-ATT-CORRECTION-01
- **Source Type**: REGULATION
- **Document / SSOT**: 学校職員服務取扱規程（欠勤の事後訂正・年休振替規定）
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - 訂正後出勤簿: `primaryCanonicalStatus: 'ANNUAL_LEAVE'`, `displaySymbol: '年'`
- **Relevant Invariants**: `INV-016`, `INV-020`
- **Legacy Diagnostic Behavior**: MATCH_EXACT

### [GT-25] 勤務パターン未設定 (Unknown Pattern Fail-Closed)
- **服務種別**: 未知パターン (`FAIL_CLOSED`)
- **Source ID**: PO-DECISION-UNKNOWN-PATTERN-01
- **Source Type**: PO_HUMAN_DECISION
- **Document / SSOT**: Project Constitution / System Invariant INV-007, INV-008
- **Verification Status**: VERIFIED
- **Expected Canonical Domain Result**:
  - `displaySymbol`: `'不明'`
  - `hasUnknownPattern`: `true`
  - 月次確定試行時: `UNKNOWN_PATTERN` により Fail-Closed 拒絶（Exception 発生）
- **Relevant Invariants**: `INV-007`, `INV-008`
- **Legacy Diagnostic Behavior**: MATCH_EXACT


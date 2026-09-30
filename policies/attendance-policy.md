# Attendance Policy

## Purpose

出勤簿の日別服務状態および表示内容を決定する。

## 基本原則

1. **確定事実の反映**: 勤務日ごとに、正式に承認・確定した服務情報（Canonical Facts）のみから出勤簿状態を決定する。
2. **未承認データの排除**: 未承認申請、差戻し中（RETURNED）の申請、却下された申請を正式な出勤簿状態として扱わない。
3. **共通Domain Logicの利用**: 出勤簿解決（Attendance Resolution）は、独自の推測や重複判定を行わず、共通Authoritative Domain Logicに基づいて決定論的（Deterministic）に行う。
4. **ドメインライフサイクル分離**: 出張命令が承認済（`TRIP_APPROVED`）である場合、復命書が差戻し・未承認であっても出張服務としての出勤簿反映は保護される。

## 判定入力

- employee
- date
- employment_type
- work_schedule
- approved_applications
- approved_business_trips
- leave_status
- holiday
- weekly_off
- substitute_holiday
- employment_status

## 出力

- attendance_status
- display_code
- display_annotation
- aggregation_category
- legal_basis
- policy_id

## Fail-Closed

複数の互いに排他的な服務状態が競合し、Policyで解決不能な場合、`UNKNOWN_PATTERN` として正式出勤簿生成を停止する。

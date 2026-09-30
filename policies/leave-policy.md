# Leave Policy

## 1. 休暇制度のPolicy定義項目

休暇制度ごとに以下をPolicy化する。

- leave_type
- legal_basis
- acquisition_unit
- minimum_unit
- maximum_unit
- rounding_rule
- break_handling
- eligibility
- balance_management
- carry_over_rule
- expiration_rule
- attendance_display
- aggregation_rule

AIは明示されていない休暇ルールを類似制度から推測して流用してはならない。

## 2. 共通Authoritative Domain Logicの適用（Single Source of Truth）

1. **計算ロジックのSSOT**: 休暇取得可能日数、必要控除時間、残日数・残時間の計算は、共通のAuthoritative Domain Logic（制度計算エンジン）を一元的な根拠とする。
2. **処理別の独自再実装禁止**: 申請時バリデーション、再申請時チェック、出勤簿集計、帳票PDF出力において、それぞれ独自に条例計算ロジックを再実装してはならない。

## 3. 残日数・残時間の冪等性保証（Balance Idempotency）

1. **二重控除・二重付与の禁止**: 同一申請の再送信、APIリトライ、差戻し後の再申請・決裁において、残日数・残時間が二重に減算・加算されてはならない。
2. **確定時消費モデル**: 休暇の残数消費は、正式な承認確定時点（または承認サイクルに応じた確定タイミング）において厳格に管理され、途中失敗時はロールバックまたは補償されなければならない。

# Domain Model

## 1. 主要Entity & Value Object

主要Entity：
- **Employee**: 教職員マスター
- **User / Role**: 認証・認可ロール
- **Application**: 服務申請本体（Server-Owned属性を含む）
- **ApprovalStep**: 承認ステップ（`approval_cycle`, `step_order`, `actor_id`, `status`, `comment`, `stamp_type`, `action_timestamp` を保持するImmutableな履歴）
- **Leave**: 休暇明細（種別、取得単位、時間/日数）
- **BusinessTrip (Travel Order)**: 出張命令ドメイン（成立時点・承認サイクルを独立保持）
- **BusinessTripReport (Travel Report)**: 出張復命書ドメイン（出張命令と独立した承認サイクルを保持）
- **WorkSchedule**: 勤務パターン・カレンダー
- **AttendanceRecord**: 出勤簿日別レコード（確定済みCanonical Factsから解決）
- **Holiday / SubstituteHoliday**: 祝日・振替休日・代休日
- **Policy**: 制度・条例ルール定義
- **AuditLog**: 操作・変更監査証跡（Immutable）
- **CanonicalFacts / CanonicalDomainResult**: Authoritative Domain Logicから導出された正規ドメイン判定結果

## 2. 識別子とデータ整合性規約

1. 重要なエンティティおよび業務イベントには一意な内部ID（UUIDまたは連番ID）を使用する。
2. 表示名称やUI表記テキストを内部識別子として使用してはならない。
3. 異なるドメインライフサイクルを持つエンティティ（例：出張命令と復命書）は、同一レコードの単一ステータスカラムに混在させず、独立したモデル構造で表現する。

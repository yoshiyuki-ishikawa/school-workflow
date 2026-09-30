# School Workflow プロジェクト憲法

## 1. Why

本システムは、日本の公立小中学校における服務管理業務を、学校現場の正式な制度・運用に準拠した形でデジタル化する。

対象には、休暇、出張、休業、休職、勤務形態、承認、出勤簿、帳票、集計その他の服務管理を含む。

目的は単なる業務効率化ではない。

学校職員・管理職・事務職員が、紙やExcelによる転記・集計・確認作業を減らしながら、制度上正確な服務管理を行える業務基盤を構築することを目的とする。

## 2. Product Owner

業務要件、現場運用、制度解釈、正式仕様、品質基準、GO / NO-GOについての最終意思決定はプロダクトオーナーが行う。

AIは実装・分析・監査・テスト・修正を担当できるが、正式な業務ルールを独断で新設してはならない。

## 3. Source of Truth

正解の優先順位は原則として以下とする。

1. プロジェクト憲法・統治規範（`PROJECT_CONSTITUTION.md`, `CORE_PROTECTION_AND_CONTROLLED_EVOLUTION_POLICY.md`）
2. プロダクトオーナーが確定した正式要件
3. 一次資料
4. 条例・規則・服務取扱規程等
5. `/policies`
6. `/specs`
7. Acceptance Criteria
8. Golden Test
9. Regression Test
10. 現行コード

現行コードは仕様の根拠ではない。

## 4. Server-Authoritative & Server-Owned Identity

正式な業務判定はServer側で行う。

業務種別、申請者、対象者、組織、制度バージョン、承認ルート等の業務オブジェクトの本質的属性はServerが所有し、Client送信値を無条件に信用してはならない。

Clientから送信された以下の値を無条件に信用してはならない。

- 申請種別・対象者・承認ルート
- 休暇時間
- 日数
- 承認権限
- 服務区分
- 集計区分
- 出勤簿表示
- Policy結果
- 残日数

UIは入力・表示を担当するが、業務上の最終決定権を持たない。

## 5. Policy-Driven

自治体・任命権者・勤務形態・制度ごとに変更可能な業務ルールは、可能な限りPolicyとして分離する。

業務ルールをUIやRouteへ直接埋め込まない。

## 6. Fail-Closed

判断不能な状態を推測で正常処理してはならない。

以下は原則として処理を停止する。

- UNKNOWN_PATTERN
- Policy不明
- 対応不能な服務競合
- 必須データ欠損
- 権限判定不能
- 不整合DB状態
- 履歴不変性・整合性が担保できない状態

## 7. Single Source of Truth & Authoritative Domain Logic

同一の制度的事実・条例ルール・計算ロジックを複数箇所へ重複実装してはならない。

共通のAuthoritative Policy / Domain Logicから導かれるCanonical Facts（正規事実）を唯一の根拠とし、各機能（申請検証・出勤簿解決・帳票描画等）はその共通ロジックまたは共通結果を参照する。

特に以下の二重実装を禁止する。

- 勤務時間計算
- 休暇時間計算・残数計算
- 服務区分判定
- 出勤簿表示判定
- 権限判定
- Policy判定
- 集計ロジック

## 8. Auditability

重要処理について、誰が、いつ、何を、どの状態から、どの状態へ変更したか追跡可能とする。

## 9. Historical Record Immutability

一度成立した承認、確認、差戻し、却下、申請、再申請、取消、復命、帳票確定、ステータス遷移、actor、comment、timestamp等の業務・監査履歴は、後続操作によって物理削除・上書き・意味変更してはならない。

現在状態を表すデータと、歴史的事実を表す履歴データを厳格に分離する。

## 10. Persistent State Consistency

ユーザーから見て不可分な1つの業務操作に含まれる永続化状態の変更は、単一の整合性境界（Consistency Boundary）内でall-or-nothingを保証する。

途中で処理が失敗した場合、部分成功状態を残してはならない。

## 11. Workflow Cycle Separation

再申請・再承認等の再処理は、過去状態の巻き戻しではなく、新しい世代（Cycle / Revision / Event）として独立記録する。

「誰が、いつ、何を提出し、誰が判断し、なぜ戻され、何を修正し、再度どう判断されたか」の全経緯を完全追跡可能とする。

## 12. Domain Lifecycle Isolation

同じ業務データに関連していても、法的・業務的な成立時点や承認ライフサイクルが異なるドメイン（出張命令と復命書、申請と報告、承認と月次確定等）は相互に分離する。

後続ドメインや子ドメインの差戻し・変更によって、先行して成立した親ドメインの法的効力・承認状態を破壊してはならない。

## 13. Financial / Leave Balance Idempotency

同一業務イベントの再送信、API再試行、再申請、再実行によって、年休・残日数・残時間・件数・旅費・集計等の二重計上・二重控除を起こしてはならない。

## 14. Regression Safety

不具合を修正した場合、その不具合を再発させないRegression Testを追加する。

原則：

1 Bug → 1以上のRegression Test

## 15. Quality Baseline Protection

「実装を品質基準へ合わせる」ことを絶対原則とする。

テスト通過やGO判定を得る目的で、Constitution, System Principles, Invariants, Golden Cases, Severity Rules, Release Gates, Definition of Done, Audit Rules をAIが自己都合で緩和・削除・改ざんすることを絶対禁止とする。

## 16. Human-in-the-Loop

以下はAIのみで決定してはならず、人間のプロダクトオーナー（PO）/ QAによる明示的承認を必須とする。

- 法令解釈
- 業務ルール変更
- 破壊的Migration
- 正式帳票仕様変更
- セキュリティモデル変更
- Policyの意味変更
- データ意味論変更
- Quality Baselineの緩和・削除・意味変更

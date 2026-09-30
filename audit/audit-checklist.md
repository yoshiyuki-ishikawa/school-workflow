# Audit Checklist

AI自己監査および人間による品質監査時に必ず全項目を検証する。

## 1. Architecture & SSOT
- [ ] **Server-Authoritative**: 制度・認可・集計判定がすべてServer側で行われているか
- [ ] **Single Source of Truth**: 同一制度判定・条例計算ロジックが複数箇所に重複実装されていないか
- [ ] **Canonical Facts根拠**: Submit / Attendance / Report が、同一制度について独自の計算ロジックを再実装せず、共通Authoritative Domain Logic / Canonical Factsを根拠としているか
- [ ] **Server-Owned Identity**: Client送信値（リクエストボディ）のみで `typeId`, `subject`, `policyVersion`, `approvalRoute` 等の本質属性を変更・改ざんできない構造になっているか

## 2. Authorization & Security
- [ ] **RBAC**: 各操作・ステップが適切なロールに制限されているか
- [ ] **自己承認禁止**: 本人申請および代理起案者が自身を含む承認ステップを決裁できないようServerで遮断されているか（INV-001）
- [ ] **API直接アクセス対策**: UI非表示に頼らずServer側エンドポイントで認可検証されているか

## 3. Workflow & History Immutability
- [ ] **過去履歴保持**: 過去の承認ステップ・コメント・印影・日時のレコードを `UPDATE` していないか
- [ ] **物理削除禁止**: 過去の承認・監査履歴を `DELETE` していないか
- [ ] **サイクル世代管理**: 再申請・再承認等の再処理時に過去Workflowを巻き戻さず、新 `approval_cycle` を発行して独立記録しているか
- [ ] **ドメインライフサイクル分離**: 出張命令と復命書など、成立時点の異なる業務を単一ステータスに混在させていないか（子ドメインの差戻しが親ドメインを巻き戻さないか）

## 4. Persistent State Consistency & Idempotency
- [ ] **トランザクション境界**: 複数テーブル更新（申請+ステップ+残数+AuditLog等）が単一Atomic Transaction内にあるか
- [ ] **DB外副作用分離**: PDF生成・ファイル出力・通知等のDB外副作用がSQLite Transaction内に抱え込まれていないか
- [ ] **ロールバック検証**: 中間失敗時にDBが完全ロールバックされるテストが存在するか
- [ ] **二重計上防止**: APIリトライや再申請によって残日数・残時間・集計が二重計上・二重減算されないか（INV-005）

## 5. Attendance & Reporting
- [ ] **確定データのみ反映**: 未承認・差戻し中・却下の申請が出勤簿や集計に反映されていないか
- [ ] **服務競合検出**: 排他服務の競合が検出され、未解決時にFail-Closedするか
- [ ] **帳票SSOT**: UI画面の表示文字列をそのままPDFへ転記せず、Server正規DTOから描画しているか

## 6. Database & Migration
- [ ] **Migration整合性**: Schema変更がMigrationで管理され、Fresh/UpgradeテストがPASSしているか
- [ ] **制約**: 適切なFKおよび二重処理防止のUNIQUE制約が設定されているか
- [ ] **既存データ保持**: 既存データが破壊・消失していないか

## 7. Testing Assets
- [ ] **Unit / Integration / API / Authorization Tests PASS**
- [ ] **Boundary Tests PASS** (世代境界・並行競合・ロールバック境界等)
- [ ] **Golden Cases PASS** (GOLDEN-001〜006)
- [ ] **Regression Tests PASS** (REG-2026-003等)

## 8. Quality Baseline Protection & Change Control（品質基盤防護・変更統治）
- [ ] **自己都合緩和の禁止**: テスト通過のためにInvariant, Golden Case, Severity, Gateを緩和・削除・改ざんしていないか
- [ ] **Baseline Change Control遵守**: 品質基盤の変更が5類型（UNCHANGED/STRENGTHENED/SEMANTIC_CHANGE/RELAXED/UNKNOWN）に分類され、RELAXED/SEMANTIC_CHANGEにPO/QAの明示的承認（Human Approval）があるか
- [ ] **Quality Coverage Baseline維持**: 8大品質カバレッジが維持・向上され、無承認のテストスキップがないか

## 9. Core Protection & Controlled Evolution（コア防護と制御された進化）
- [ ] **Change Classification明示**: Layer A (A1/A2/A3) / B / C および Core Impact が明記されているか
- [ ] **Smallest Safe Change**: 要求仕様外の不要なコアリファクタリングが混入していないか（INV-028, INV-029）
- [ ] **Controlled Core Evolution**: Layer A3（Core Semantic Change）に該当する場合、CCRが作成されPO/QA承認が得られているか
- [ ] **Document Fidelity分離**: 帳票レンダラー（PDF/CSV）が制度計算を内包せず、Canonical Facts（DTO）の描画に専念しているか
- [ ] **Golden Knowledge蓄積**: 確定した学校実務（School Reality）が Golden / Boundary / Regression Test へ適切に固定されているか

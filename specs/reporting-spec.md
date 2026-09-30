# Reporting Specification

## 1. 帳票生成パイプライン

正式帳票（PDF、CSV、印刷プレビュー等）は、Server側の確定済みデータおよび共通Authoritative Domain Logicから導出された正規ドメイン結果（Canonical Facts / DTO）から生成する。

生成順序：
`Policy / Master → Authoritative Domain Logic → Canonical Facts / DTO → Renderer (PDF/CSV/View)`

## 2. 厳格な規約

1. **独自再実装の禁止**: 帳票生成処理において、休暇日数や残数、集計等の制度ロジックを独自に再実装してはならない。
2. **UI値の直接転記禁止**: Client画面に表示されている文字列や計算結果をそのままPDF等の正式帳票へ流用してはならない。必ずServer側で正規生成したDTOを描画する。
3. **副作用の分離**: 帳票生成・PDFレンダリング処理はDBトランザクション外で実行し、生成失敗時もDBトランザクションの整合性を破壊しない。
4. **Document Fidelityと制度ロジックの分離**: 帳票レンダラー（PDF/CSV）は Canonical Facts（Domain DTO）を受け取って視覚的描画・文字列フォーマット（例: 「特休（2時間）」）を行う描画責務（Layer C: Presentation）に専念し、内部で条件分岐して制度計算を行ってはならない。フォント、罫線、改ページ、印影位置等のレイアウト調整は Domain Correctness に影響を与えない。

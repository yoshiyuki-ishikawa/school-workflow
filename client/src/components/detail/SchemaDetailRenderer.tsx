import React from 'react';
import { ApplicationFormSchema, FormFieldCondition } from '../../types/formSchema';
import { GenericFieldView } from './GenericFieldView';
import { HistoricalResidualFactView } from './HistoricalResidualFactView';
import { DEDICATED_DETAIL_REGISTRY } from './DedicatedDetailRegistry';
import { computeResidualFacts } from '../../utils/computeResidualFacts';
import { FileText, AlertCircle, Layers, Clock } from 'lucide-react';

export interface SchemaDetailRendererProps {
  schema: ApplicationFormSchema | null;
  formData: Record<string, any> | null | undefined;
  isSchemaLoading?: boolean;
  schemaError?: string | null;
  canResolveCoverage?: boolean;
  onOpenCoverageModal?: () => void;
  careCases?: any[];
  carePeriods?: any[];
}

/**
 * 動的条件評価関数 (Pure Helper for Read-Only Presentation)
 */
export function evaluateDetailVisibleCondition(
  condition: FormFieldCondition | undefined,
  values: Record<string, any>
): boolean {
  if (!condition) return true;

  const currentVal = values[condition.field];

  switch (condition.operator) {
    case 'EQUALS':
      return String(currentVal) === String(condition.value);
    case 'NOT_EQUALS':
      return String(currentVal) !== String(condition.value);
    case 'IN':
      return Array.isArray(condition.value) && condition.value.map(String).includes(String(currentVal));
    case 'IS_TRUE':
      return Boolean(currentVal) === true;
    case 'IS_FALSE':
      return Boolean(currentVal) === false;
    default:
      return true; // Read-Only Presentation では非表示にせず表示を優先
  }
}

/**
 * SchemaDetailRenderer
 * 
 * Schema-Driven Architecture に基づき、保存済み Fact を型安全に Read-Only レンダリングする。
 * Generic セクションは GenericFieldView で描画し、Dedicated セクションは DedicatedDetailRegistry へ委譲する。
 * 
 * 【Architecture Invariant】
 * 1. Read-Only Pure Presentation: 入力・バリデーション・状態更新を完全に排除。
 * 2. SILENT DROP = 0: computeResidualFacts により、Schema 外の残存キーを HistoricalResidualFactView で全件表示。
 * 3. Dedicated Resolution: Dedicated Section ID にマッチする登録済み View へ決定論的に委譲。
 * 4. Unknown Dedicated Section Fallback: 未知の Dedicated Section でも Fact Loss を起こさず安全に描画。
 * 5. Derived Business Fact Projection: calculatedMinutes 等の業務派生値を人間可読な形式で正規描画。
 * 6. Technical Metadata Exclusion: schemaSnapshot / schemaVersion 等の技術内部情報を一般UIから除外。
 */
export const SchemaDetailRenderer: React.FC<SchemaDetailRendererProps> = ({
  schema,
  formData,
  isSchemaLoading = false,
  schemaError = null,
  canResolveCoverage = false,
  onOpenCoverageModal,
  careCases = [],
  carePeriods = [],
}) => {
  const data = formData && typeof formData === 'object' && !Array.isArray(formData) ? formData : {};

  // Schema（Generic + Dedicated）と Fact の照合 & 残存 Fact の算出
  const { consumedFieldMap, derivedFacts, residuals } = React.useMemo(() => {
    return computeResidualFacts(data, schema);
  }, [data, schema]);

  if (isSchemaLoading) {
    return (
      <div className="p-6 bg-slate-50 border border-slate-200 rounded-xl text-center text-xs text-slate-500 animate-pulse">
        表示スキーマを読み込み中...
      </div>
    );
  }

  // Schema が存在しない場合の Fail-Safe フォールバック
  if (!schema || schemaError) {
    return (
      <div className="space-y-4">
        {schemaError && (
          <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>表示定義の取得に失敗したため、保存された生データを表示しています（{schemaError}）</span>
          </div>
        )}
        {/* CLASS B: 業務派生ファクト */}
        {derivedFacts.length > 0 && (
          <div className="border border-blue-200 bg-blue-50/40 rounded-xl overflow-hidden shadow-xs">
            <div className="bg-blue-100/60 border-b border-blue-200 px-4 py-2 font-bold text-blue-900 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-blue-600" />
                <span>業務算出・控除時間情報 (Server Authoritative)</span>
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-blue-200/60 text-blue-800 font-medium">
                服務計算確定値
              </span>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {derivedFacts.map((fact) => (
                <div key={fact.key} className="bg-white p-3 rounded-lg border border-blue-100 shadow-2xs">
                  <div className="text-[11px] font-semibold text-slate-500 mb-1">{fact.label}</div>
                  <div className="text-sm font-bold text-slate-900 font-mono">{fact.formatted}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* CLASS D: 真の残存ファクトのみ (技術メタデータは除外) */}
        {residuals.length > 0 && (
          <HistoricalResidualFactView residuals={residuals} isSchemaMissing={true} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* スキーマ定義セクションの描画 */}
      {schema.sections.map((section) => {
        const dedicatedRegistration = DEDICATED_DETAIL_REGISTRY[section.id];

        // 1. Dedicated Section がレジストリに登録されている場合 -> 専用ビューへ委譲
        if (dedicatedRegistration) {
          return (
            <React.Fragment key={section.id}>
              {React.createElement(dedicatedRegistration.renderer, {
                section,
                formData: data,
                canResolveCoverage,
                onOpenCoverageModal,
                careCases,
                carePeriods,
              })}
            </React.Fragment>
          );
        }

        // 2. isDedicated: true だがレジストリ未登録（Unknown Dedicated Section）の安全フォールバック
        if ((section as any).isDedicated) {
          return (
            <div key={section.id} className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-xs">
              <div className="bg-slate-50/80 border-b border-slate-200 px-4 py-2.5 font-bold text-slate-800 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-slate-500" />
                  <span>{section.title}</span>
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 font-medium">
                  未登録ドメインセクション
                </span>
              </div>
              <div className="p-4 space-y-4">
                {section.fields && section.fields.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {section.fields.map((field) => {
                      const consumption = consumedFieldMap.get(field.name);
                      return (
                        <GenericFieldView
                          key={field.name}
                          field={field}
                          value={consumption ? consumption.value : data[field.name]}
                          isAlias={consumption?.isAlias}
                          sourceKey={consumption?.sourceKey}
                          hasConflict={consumption?.hasConflict}
                          conflictingKeys={consumption?.conflictingKeys}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 italic">
                    セクション定義に従って項目が表示されます。
                  </p>
                )}
              </div>
            </div>
          );
        }

        // 3. Generic Section の描画
        const visibleFields = (section.fields || []).filter((field) =>
          evaluateDetailVisibleCondition(field.visibleCondition, data)
        );

        if (visibleFields.length === 0) {
          return null;
        }

        return (
          <div key={section.id} className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-xs">
            <div className="bg-slate-50/80 border-b border-slate-200 px-4 py-2.5 font-bold text-slate-800 flex items-center gap-1.5 text-xs">
              <FileText className="w-4 h-4 text-slate-500" />
              <span>{section.title}</span>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {visibleFields.map((field) => {
                const consumption = consumedFieldMap.get(field.name);
                return (
                  <GenericFieldView
                    key={field.name}
                    field={field}
                    value={consumption ? consumption.value : data[field.name]}
                    isAlias={consumption?.isAlias}
                    sourceKey={consumption?.sourceKey}
                    hasConflict={consumption?.hasConflict}
                    conflictingKeys={consumption?.conflictingKeys}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {/* 業務算出ファクトの正規表示 (CLASS B — Derived Business Facts) */}
      {derivedFacts.length > 0 && (
        <div className="border border-blue-200 bg-blue-50/40 rounded-xl overflow-hidden shadow-xs">
          <div className="bg-blue-100/60 border-b border-blue-200 px-4 py-2.5 font-bold text-blue-900 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-blue-600" />
              <span>業務算出・控除時間情報 (Server Authoritative)</span>
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-blue-200/60 text-blue-800 font-medium">
              服務計算確定値
            </span>
          </div>
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {derivedFacts.map((fact) => (
              <div key={fact.key} className="bg-white p-3 rounded-lg border border-blue-100 shadow-2xs">
                <div className="text-[11px] font-semibold text-slate-500 mb-1">{fact.label}</div>
                <div className="text-sm font-bold text-slate-900 font-mono">{fact.formatted}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* スキーマ未消費 Fact の安全表示 (CLASS D — Genuine Historical Residuals: SILENT DROP = 0) */}
      {residuals.length > 0 && (
        <HistoricalResidualFactView residuals={residuals} isSchemaMissing={false} />
      )}
    </div>
  );
};

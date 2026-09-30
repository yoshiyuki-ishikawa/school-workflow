import { ApplicationFormSchema } from '../types/formSchema';
import { DEDICATED_DETAIL_REGISTRY } from '../components/detail/DedicatedDetailRegistry';

export interface FieldConsumptionResult {
  value: any;
  sourceKey: string;
  isAlias: boolean;
  hasConflict?: boolean;
  conflictingKeys?: { key: string; value: any }[];
}

export interface DerivedFactResult {
  key: string;
  value: any;
  label: string;
  formatted: string;
}

export interface ResidualDetectionResult {
  consumedKeys: Set<string>;
  consumedFieldMap: Map<string, FieldConsumptionResult>; // field.name -> consumption info
  derivedFacts: DerivedFactResult[];
  technicalMetadata: { key: string; value: any }[];
  residualKeys: string[];
  residuals: { key: string; value: any }[];
}

/**
 * 既知の算出業務ファクト (CLASS B — Derived Business Facts)
 * ユーザー入力ではなくServer-Authoritativeに算出・確定された業務属性値。
 */
export const KNOWN_DERIVED_BUSINESS_FACTS = new Set<string>([
  'calculatedMinutes',
  'chargedHours',
  'deductionUnits',
]);

/**
 * 既知のシステム技術メタデータ・エビデンス (CLASS C — System Technical Metadata / Evidence)
 * 内部整合性・Point-in-timeスナップショット・外部キー参照。日常業務UIからは除外しDB保存を維持。
 * ※ 厳格な完全一致判定のみ。接頭辞・型推測・あいまい検索は禁止。
 */
export const KNOWN_TECHNICAL_METADATA_KEYS = new Set<string>([
  'schemaVersion',
  'schemaSnapshot',
  'organizationSnapshot',
  'tripEventId',
  'batchGroupId',
  'values',
]);

/**
 * calculatedMinutes を人間可読な業務形式へ決定論的に変換する Pure Formatter。
 * 
 * 【Canonical Invariant】
 * 1. Non-Recalculation: Server-Authoritativeな分数を一切再計算・補正・丸め・fallback（|| 232等）しない。
 * 2. HALF_DAY Non-Guessing: 1日の半分（465/2）や固定分数へ推測補正しない。
 * 3. Fail-Safe Non-Masking: 不正値（null, 文字列, 負数等）を正常値へ偽装せず安全に文字列化。
 */
export function formatCalculatedMinutes(val: any): { label: string; formatted: string } {
  const label = '業務算出時間 (正味控除時間)';
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    const hours = Math.floor(val / 60);
    const mins = val % 60;
    return {
      label,
      formatted: `${hours}時間${mins}分 (${val}分)`,
    };
  }
  return {
    label: '業務算出時間 (未加工データ)',
    formatted: val === null ? 'null' : val === undefined ? '未設定' : String(val),
  };
}

/**
 * computeResidualFacts
 * 
 * 保存済み formData と Schema 定義（Generic + Dedicated）を照合し、
 * 以下の4分類（CLASS A〜D）へ決定論的に分離する Pure Engine：
 * 
 * - CLASS A: Schema の各フィールド（Generic / Dedicated）によって消費されたキー
 * - CLASS B: 既知の派生業務ファクト（KNOWN_DERIVED_BUSINESS_FACTS）
 * - CLASS C: 既知のシステム技術メタデータ（KNOWN_TECHNICAL_METADATA_KEYS）
 * - CLASS D: 真の過去・拡張項目（Genuine Historical Residuals）
 * 
 * 【Extended Set Invariant】
 * 1. SavedKeys = ConsumedKeys(CLASS A) ∪ DerivedFacts(CLASS B) ∪ TechnicalMetadata(CLASS C) ∪ Residuals(CLASS D)
 * 2. 各クラスは排他（互いに素）
 * 3. Unknown = Visible: 未知キーは必ず CLASS D (residuals) へ分類
 * 4. SILENT DROP = 0
 */
export function computeResidualFacts(
  formData: Record<string, any> | null | undefined,
  schema: ApplicationFormSchema | null | undefined,
  dedicatedRegistry: typeof DEDICATED_DETAIL_REGISTRY = DEDICATED_DETAIL_REGISTRY
): ResidualDetectionResult {
  const savedData = formData && typeof formData === 'object' && !Array.isArray(formData) ? formData : {};
  const savedKeys = Object.keys(savedData);

  const consumedKeys = new Set<string>();
  const consumedFieldMap = new Map<string, FieldConsumptionResult>();

  if (schema && Array.isArray(schema.sections)) {
    for (const section of schema.sections) {
      // A. Dedicated Section の判定とキー消費
      const dedicatedReg = (section as any).isDedicated || dedicatedRegistry[section.id]
        ? dedicatedRegistry[section.id]
        : undefined;

      if (dedicatedReg) {
        // Dedicated レジストリが登録されている場合、宣言されたキーのうち実際に savedData に存在するものを消費
        for (const k of dedicatedReg.consumedKeys) {
          if (Object.prototype.hasOwnProperty.call(savedData, k)) {
            consumedKeys.add(k);
          }
        }
      }

      // B. Standard Fields の照合とキー消費（Generic または Dedicated 内の明示的 Field 定義）
      for (const field of section.fields || []) {
        const canonicalName = field.name;
        const aliases = field.aliases || [];

        const hasCanonical = Object.prototype.hasOwnProperty.call(savedData, canonicalName);
        const matchingAliases = aliases.filter((a) => Object.prototype.hasOwnProperty.call(savedData, a));

        if (hasCanonical && matchingAliases.length === 0) {
          // Case 1: Canonical キーのみ存在
          consumedKeys.add(canonicalName);
          consumedFieldMap.set(canonicalName, {
            value: savedData[canonicalName],
            sourceKey: canonicalName,
            isAlias: false,
          });
        } else if (!hasCanonical && matchingAliases.length > 0) {
          // Case 2: Alias キーのみ存在 (先頭マッチを消費、他も同一値なら消費)
          const primaryAlias = matchingAliases[0];
          const primaryVal = savedData[primaryAlias];
          consumedKeys.add(primaryAlias);

          let hasConflict = false;
          const conflictingKeys: { key: string; value: any }[] = [{ key: primaryAlias, value: primaryVal }];

          for (let i = 1; i < matchingAliases.length; i++) {
            const otherAlias = matchingAliases[i];
            const otherVal = savedData[otherAlias];
            consumedKeys.add(otherAlias);
            conflictingKeys.push({ key: otherAlias, value: otherVal });
            if (JSON.stringify(otherVal) !== JSON.stringify(primaryVal)) {
              hasConflict = true;
            }
          }

          consumedFieldMap.set(canonicalName, {
            value: primaryVal,
            sourceKey: primaryAlias,
            isAlias: true,
            hasConflict,
            conflictingKeys: hasConflict ? conflictingKeys : undefined,
          });
        } else if (hasCanonical && matchingAliases.length > 0) {
          // Case 3: Canonical と Alias が共存
          const canonicalVal = savedData[canonicalName];
          consumedKeys.add(canonicalName);

          let hasConflict = false;
          const conflictingKeys: { key: string; value: any }[] = [{ key: canonicalName, value: canonicalVal }];

          for (const alias of matchingAliases) {
            const aliasVal = savedData[alias];
            consumedKeys.add(alias);
            conflictingKeys.push({ key: alias, value: aliasVal });
            if (JSON.stringify(aliasVal) !== JSON.stringify(canonicalVal)) {
              hasConflict = true;
            }
          }

          consumedFieldMap.set(canonicalName, {
            value: canonicalVal,
            sourceKey: canonicalName,
            isAlias: false,
            hasConflict,
            conflictingKeys: hasConflict ? conflictingKeys : undefined,
          });
        }
      }
    }
  }

  // 残存キーの決定論的分離 (CLASS B, C, D)
  const derivedFacts: DerivedFactResult[] = [];
  const technicalMetadata: { key: string; value: any }[] = [];
  const residualKeys: string[] = [];
  const residuals: { key: string; value: any }[] = [];

  for (const k of savedKeys) {
    if (consumedKeys.has(k)) {
      // CLASS A: Schema または Dedicated Section で消費済み
      continue;
    }

    if (KNOWN_DERIVED_BUSINESS_FACTS.has(k)) {
      // CLASS B: 既知の派生業務ファクト (Presentation Layer で正規消費)
      const val = savedData[k];
      let label = k;
      let formatted = String(val);

      if (k === 'calculatedMinutes') {
        const res = formatCalculatedMinutes(val);
        label = res.label;
        formatted = res.formatted;
      } else if (k === 'chargedHours') {
        label = '控除時間数';
        formatted = `${val}時間`;
      } else if (k === 'deductionUnits') {
        label = '控除単位';
        formatted = String(val);
      }

      derivedFacts.push({
        key: k,
        value: val,
        label,
        formatted,
      });
      continue;
    }

    if (KNOWN_TECHNICAL_METADATA_KEYS.has(k)) {
      // CLASS C: 既知のシステム技術メタデータ (通常UIから除外・DB保持)
      technicalMetadata.push({
        key: k,
        value: savedData[k],
      });
      continue;
    }

    // CLASS D: 真の過去・拡張項目 (Genuine Historical Residuals — Silent Drop = 0)
    residualKeys.push(k);
    residuals.push({
      key: k,
      value: savedData[k],
    });
  }

  return {
    consumedKeys,
    consumedFieldMap,
    derivedFacts,
    technicalMetadata,
    residualKeys,
    residuals,
  };
}

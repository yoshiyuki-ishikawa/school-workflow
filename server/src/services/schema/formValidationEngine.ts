import {
  FormSchemaSnapshot,
  FormFieldDefinition,
  FormFieldCondition,
  FormValidationResult,
  SchemaValidationIssue
} from '../../types/formSchema';
import { FormSchemaRegistry } from './formSchemaRegistry';

/**
 * Server-Authoritative Form Validation Engine (SSOT)
 * 
 * 厳格な検証ルール:
 * 1. Whitelist Validation: スキーマに定義されていない未知フィールドは即時拒絶 (Fail-Closed)
 * 2. 型検査 (Type Validation): TEXT, NUMBER, DATE, TIME, BOOLEAN, SELECT等の型とフォーマット検証
 * 3. 条件付き必須 (Conditional Required): FieldCondition に基づく動的必須検証
 * 4. 範囲・桁数・正規表現検証: min, max, minLength, maxLength, pattern
 * 5. Historical Schema Snapshot: 渡された snapshot（またはActive Schema）に厳密準拠
 */
export class FormValidationEngine {
  /**
   * FieldCondition の評価
   */
  public static evaluateCondition(
    condition: FormFieldCondition | undefined,
    values: Record<string, any>
  ): boolean {
    if (!condition || !condition.field) return true;

    let targetVal = values[condition.field];
    if (condition.field === 'unitType') {
      if (targetVal === 'FULL_DAY') targetVal = 'DAY';
      if (targetVal === 'HOURLY') targetVal = 'TIME';
    }

    switch (condition.operator) {
      case 'EQUALS':
        return targetVal === condition.value;
      case 'NOT_EQUALS':
        return targetVal !== condition.value;
      case 'IN':
        if (Array.isArray(condition.value)) {
          return condition.value.includes(targetVal);
        }
        return false;
      case 'IS_TRUE':
        return targetVal === true || targetVal === 'true' || targetVal === 1;
      case 'IS_FALSE':
        return targetVal === false || targetVal === 'false' || targetVal === 0 || targetVal === undefined || targetVal === null || targetVal === '';
      default:
        return true;
    }
  }

  /**
   * フォーム値の完全バリデーション (Whitelist & Type & Conditions)
   */
  public static validate(params: {
    typeId: string;
    rawValues: Record<string, any>;
    schemaSnapshot?: FormSchemaSnapshot;
    targetDate?: string;
    isDraft?: boolean; // 下書き保存時は一部必須検証をスキップ
  }): FormValidationResult {
    const { typeId, rawValues = {}, isDraft = false, targetDate } = params;

    // 1. スキーマの確定 (スナップショット優先、無ければActive解決、未登録の場合はDBのapplication_types存在確認またはFail-Closed)
    let snapshot = params.schemaSnapshot;
    if (!snapshot) {
      const activeSchema = FormSchemaRegistry.resolveActiveSchema(typeId, targetDate);
      if (!activeSchema) {
        // DB上の application_types に登録されている動的種別か確認
        let isDbRegisteredType = false;
        try {
          const { getDb } = require('../../db/database');
          const db = getDb();
          const row = db.prepare('SELECT id FROM application_types WHERE id = ?').get(typeId);
          if (row) {
            isDbRegisteredType = true;
          }
        } catch {}

        if (isDbRegisteredType) {
          // DB登録済みの動的申請種別に対するフォールバック
          snapshot = {
            typeId,
            version: '2026.1',
            sections: [
              {
                id: 'generic_details',
                title: '申請内容',
                fields: [
                  { name: 'startDate', label: '開始日', type: 'DATE', required: false },
                  { name: 'endDate', label: '終了日', type: 'DATE', required: false },
                  { name: 'targetDate', label: '対象日', type: 'DATE', required: false, aliases: ['startDate'] },
                  { name: 'unitType', label: '単位', type: 'SELECT', required: false, defaultValue: 'DAY' },
                  { name: 'startTime', label: '開始時刻', type: 'TIME', required: false },
                  { name: 'endTime', label: '終了時刻', type: 'TIME', required: false },
                  { name: 'calculatedDays', label: '日数', type: 'NUMBER', required: false },
                  { name: 'reason', label: '事由', type: 'TEXT', required: false }
                ]
              }
            ]
          };
        } else {
          // レジストリにもDBマスタにも存在しない未知の種別は Fail-Closed 拒絶 (GT-W1-09)
          return {
            valid: false,
            status: 400,
            errorCode: 'UNKNOWN_SCHEMA',
            message: `申請種別（${typeId}）に対応する入力スキーマが登録されていません`
          };
        }
      } else {
        snapshot = FormSchemaRegistry.createSnapshot(activeSchema);
      }
    }

    if (!snapshot.sections || !Array.isArray(snapshot.sections)) {
      return {
        valid: false,
        status: 500,
        errorCode: 'INVALID_SCHEMA',
        message: `スキーマ（${typeId} v${snapshot.version}）の定義が不正です`
      };
    }

    const fieldMap = FormSchemaRegistry.extractFlatFields(snapshot.sections);
    const issues: SchemaValidationIssue[] = [];
    const sanitizedValues: Record<string, any> = {};

    // 2. Whitelist Validation: 未知フィールドの拒絶 (AC-W1-02)
    // システム予約フィールド (tripEventId, batchGroupId, proxyReason, proxySubmitterName 等) は除外
    const systemAllowedFields = new Set([
      'tripEventId',
      'batchGroupId',
      'proxyReason',
      'proxySubmitterName',
      'schemaVersion',
      'schemaSnapshot',
      'values',
      'substituteTeacher',
      'organizationSnapshot',
      'calculatedMinutes',
      'calculatedDays',
      'chargedHours',
      'deductionUnits'
    ]);

    // 全フィールド名およびエイリアスを収集
    const recognizedFieldNames = new Set<string>();
    for (const [name, def] of fieldMap.entries()) {
      recognizedFieldNames.add(name);
      if (def.aliases) {
        for (const alias of def.aliases) {
          recognizedFieldNames.add(alias);
        }
      }
    }

    for (const key of Object.keys(rawValues)) {
      if (!recognizedFieldNames.has(key) && !systemAllowedFields.has(key)) {
        return {
          valid: false,
          status: 400,
          errorCode: 'UNRECOGNIZED_FIELD_REJECTED',
          message: `スキーマに定義されていない不正な項目が送信されました: ${key}`,
          issues: [{ field: key, code: 'UNRECOGNIZED_FIELD', message: `未定義フィールド: ${key}` }]
        };
      }
    }

    // 3. 各フィールドのバリデーション用値コンテキスト（デフォルト値・エイリアス適用後）
    const effectiveValues: Record<string, any> = { ...rawValues };
    for (const [name, def] of fieldMap.entries()) {
      let val = effectiveValues[name];
      if ((val === undefined || val === null || val === '') && def.aliases && def.aliases.length > 0) {
        for (const alias of def.aliases) {
          if (effectiveValues[alias] !== undefined && effectiveValues[alias] !== null && effectiveValues[alias] !== '') {
            val = effectiveValues[alias];
            break;
          }
        }
      }
      if (val === undefined && def.defaultValue !== undefined) {
        val = def.defaultValue;
      }
      if (val !== undefined) {
        effectiveValues[name] = val;
      }
    }

    for (const [name, def] of fieldMap.entries()) {
      let val = effectiveValues[name];

      // 表示条件・必須条件の評価
      const isVisible = this.evaluateCondition(def.visibleCondition, effectiveValues);
      const isConditionallyRequired = def.requiredCondition
        ? this.evaluateCondition(def.requiredCondition, effectiveValues)
        : false;
      const isEffectiveRequired = def.required || isConditionallyRequired;

      // 表示条件に合致しないフィールドはバリデーション・保存対象から除外
      if (!isVisible) {
        continue;
      }

      // 下書き時でない場合、必須チェック
      if (!isDraft && isEffectiveRequired) {
        if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
          issues.push({
            field: name,
            code: 'MISSING_REQUIRED_FIELD',
            message: `${def.label} は必須項目です`
          });
          continue;
        }
      }

      // 値が存在する場合の型・制約チェック
      if (val !== undefined && val !== null && val !== '') {
        // 型バリデーション
        switch (def.type) {
          case 'NUMBER': {
            const num = Number(val);
            if (isNaN(num)) {
              issues.push({ field: name, code: 'INVALID_NUMBER', message: `${def.label} には有効な数値を入力してください` });
            } else {
              if (def.validation?.min !== undefined && num < def.validation.min) {
                issues.push({ field: name, code: 'MIN_VALUE_EXCEEDED', message: `${def.label} は ${def.validation.min} 以上である必要があります` });
              }
              if (def.validation?.max !== undefined && num > def.validation.max) {
                issues.push({ field: name, code: 'MAX_VALUE_EXCEEDED', message: `${def.label} は ${def.validation.max} 以下である必要があります` });
              }
              val = num;
            }
            break;
          }
          case 'DATE': {
            if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val) || isNaN(Date.parse(val))) {
              issues.push({ field: name, code: 'INVALID_DATE', message: `${def.label} には有効な日付 (YYYY-MM-DD) を指定してください` });
            }
            break;
          }
          case 'TIME': {
            if (typeof val !== 'string' || !/^\d{2}:\d{2}$/.test(val)) {
              issues.push({ field: name, code: 'INVALID_TIME', message: `${def.label} には有効な時刻 (HH:MM) を指定してください` });
            }
            break;
          }
          case 'DATETIME': {
            if (typeof val !== 'string' || isNaN(Date.parse(val))) {
              issues.push({ field: name, code: 'INVALID_DATETIME', message: `${def.label} には有効な日時を指定してください` });
            }
            break;
          }
          case 'SELECT':
          case 'RADIO': {
            if (name === 'unitType') {
              if (val === 'FULL_DAY') val = 'DAY';
              if (val === 'HOURLY') val = 'TIME';
            }
            if (def.options && Array.isArray(def.options) && def.options.length > 0) {
              const allowedValues = def.options.map(o => String(o.value));
              if (!allowedValues.includes(String(val))) {
                issues.push({ field: name, code: 'INVALID_OPTION', message: `${def.label} に指定された値（${val}）は選択肢に含まれていません` });
              }
            }
            break;
          }
          case 'BOOLEAN': {
            if (typeof val === 'string') {
              val = val === 'true';
            } else {
              val = Boolean(val);
            }
            break;
          }
          case 'ARRAY': {
            if (!Array.isArray(val)) {
              issues.push({ field: name, code: 'INVALID_ARRAY', message: `${def.label} には有効な配列データを指定してください` });
            }
            break;
          }
          case 'TEXT':
          case 'TEXTAREA': {
            if (typeof val !== 'string') {
              val = String(val);
            }
            // 文字列長制限
            if (def.validation?.minLength !== undefined && val.length < def.validation.minLength) {
              issues.push({ field: name, code: 'MIN_LENGTH', message: `${def.label} は ${def.validation.minLength} 文字以上入力してください` });
            }
            if (def.validation?.maxLength !== undefined && val.length > def.validation.maxLength) {
              issues.push({ field: name, code: 'MAX_LENGTH', message: `${def.label} は ${def.validation.maxLength} 文字以内で入力してください` });
            }
            if (def.validation?.pattern) {
              try {
                const regex = new RegExp(def.validation.pattern);
                if (!regex.test(val)) {
                  issues.push({ field: name, code: 'PATTERN_MISMATCH', message: `${def.label} の形式が正しくありません` });
                }
              } catch {}
            }
            break;
          }
        }
      }

      sanitizedValues[name] = val;
    }

    // 4. GAP-09: Class Coverage Specific Deep Validation & Personnel Snapshot Generation
    if (snapshot.capabilities?.classCoverageApplicable === true) {
      const coverageStatus = sanitizedValues.coverageStatus;

      // coverageStatus 必須チェック (下書き保存時以外)
      if (!isDraft) {
        if (!coverageStatus || (coverageStatus !== 'REQUIRED' && coverageStatus !== 'NOT_REQUIRED' && coverageStatus !== 'UNSURE')) {
          issues.push({
            field: 'coverageStatus',
            code: 'MISSING_REQUIRED_FIELD',
            message: '授業措置の要否（coverageStatus）の選択は必須です'
          });
        }
      }

      if (coverageStatus === 'REQUIRED') {
        const coverageItems = sanitizedValues.coverageItems;
        if (!isDraft) {
          if (!coverageItems || !Array.isArray(coverageItems) || coverageItems.length === 0) {
            issues.push({
              field: 'coverageItems',
              code: 'COVERAGE_ITEMS_REQUIRED',
              message: '授業措置が必要な場合は、1件以上の授業代替明細（coverageItems）を入力してください'
            });
          }
        }

        if (coverageItems && Array.isArray(coverageItems)) {
          const validatedItems: any[] = [];
          for (let i = 0; i < coverageItems.length; i++) {
            const item = coverageItems[i];
            if (!item || typeof item !== 'object') {
              issues.push({ field: `coverageItems[${i}]`, code: 'INVALID_ITEM', message: `明細行 ${i + 1} の形式が不正です` });
              continue;
            }

            // period 検証 (柔軟な文字列: 1〜6, 7, 朝学習, 放課後, 短縮4, その他等)
            if (!item.period || typeof item.period !== 'string' || item.period.trim() === '') {
              issues.push({ field: `coverageItems[${i}].period`, code: 'PERIOD_REQUIRED', message: `明細行 ${i + 1} の校時（period）を入力してください` });
            }

            // coverageType 検証
            const validTypes = ['SUBSTITUTE_LESSON', 'SELF_STUDY_SUPERVISION', 'TIMETABLE_EXCHANGE', 'COMBINED_CLASS', 'OTHER'];
            if (!item.coverageType || !validTypes.includes(item.coverageType)) {
              issues.push({ field: `coverageItems[${i}].coverageType`, code: 'INVALID_COVERAGE_TYPE', message: `明細行 ${i + 1} の措置種別（coverageType）が不正です` });
            }

            // targetDate 検証
            if (!item.targetDate || typeof item.targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.targetDate) || isNaN(Date.parse(item.targetDate))) {
              issues.push({ field: `coverageItems[${i}].targetDate`, code: 'INVALID_TARGET_DATE', message: `明細行 ${i + 1} の対象日（YYYY-MM-DD）を入力してください` });
            }

            // substituteUserId Personnel Resolution & Snapshot Generation (Write-Time Snapshot)
            let substituteUserNameSnapshot = item.substituteUserNameSnapshot;
            let substituteUserDeptSnapshot = item.substituteUserDeptSnapshot;

            if (item.substituteUserId !== undefined && item.substituteUserId !== null && item.substituteUserId !== '') {
              const subUserId = Number(item.substituteUserId);
              if (isNaN(subUserId)) {
                issues.push({ field: `coverageItems[${i}].substituteUserId`, code: 'INVALID_SUBSTITUTE_USER', message: `明細行 ${i + 1} の代替教員IDが不正です` });
              } else {
                try {
                  const { getDb } = require('../../db/database');
                  const db = getDb();
                  const userRow = db.prepare('SELECT id, display_name, department, is_active FROM users WHERE id = ?').get(subUserId) as any;
                  if (!userRow || userRow.is_active !== 1) {
                    issues.push({ field: `coverageItems[${i}].substituteUserId`, code: 'INACTIVE_OR_NONEXISTENT_USER', message: `明細行 ${i + 1} に指定された代替教員（ID: ${subUserId}）は無効または存在しません` });
                  } else {
                    substituteUserNameSnapshot = userRow.display_name;
                    substituteUserDeptSnapshot = userRow.department || '';
                  }
                } catch {
                  // DB未初期化テスト環境等でのフォールバック
                }
              }
            }

            validatedItems.push({
              id: item.id || `cov_${i + 1}`,
              targetDate: item.targetDate,
              period: String(item.period || '').trim(),
              coverageType: item.coverageType,
              substituteUserId: item.substituteUserId ? Number(item.substituteUserId) : undefined,
              substituteUserNameSnapshot,
              substituteUserDeptSnapshot,
              subjectName: item.subjectName ? String(item.subjectName) : undefined,
              contentNotes: item.contentNotes ? String(item.contentNotes) : undefined,
            });
          }
          sanitizedValues.coverageItems = validatedItems;
        }
      } else if (coverageStatus === 'NOT_REQUIRED') {
        // NOT_REQUIRED の場合は coverageItems をクリア
        sanitizedValues.coverageItems = [];
      } else if (coverageStatus === 'UNSURE') {
        // UNSURE の場合も任意で入力された coverageItems があれば正規化
        if (sanitizedValues.coverageItems && Array.isArray(sanitizedValues.coverageItems)) {
          // 保留時に入力された明細も保持
        } else {
          sanitizedValues.coverageItems = [];
        }
      }
    }

    if (issues.length > 0) {
      return {
        valid: false,
        status: 422,
        errorCode: 'FORM_VALIDATION_FAILED',
        message: issues.map(i => i.message).join(' / '),
        issues,
        schemaVersion: snapshot.version,
        schemaSnapshot: snapshot
      };
    }

    // システム許可フィールドも保持
    for (const key of systemAllowedFields) {
      if (rawValues[key] !== undefined) {
        sanitizedValues[key] = rawValues[key];
      }
    }

    return {
      valid: true,
      status: 200,
      sanitizedValues,
      schemaVersion: snapshot.version,
      schemaSnapshot: snapshot
    };
  }
}

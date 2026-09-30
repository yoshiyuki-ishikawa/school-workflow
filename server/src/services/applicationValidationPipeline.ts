import { Database } from 'better-sqlite3';
import { AnnualLeaveService } from './annualLeaveService';
import { CareLeaveService } from './careLeaveService';
import { WorkingObligationResolver } from './attendance/workingObligationResolver';
import { FormValidationEngine } from './schema/formValidationEngine';
import { FormSchemaSnapshot } from '../types/formSchema';

export interface ValidationPipelineResult {
  valid: boolean;
  status: number;
  message?: string;
  errorCode?: string;
  sanitizedValues?: Record<string, any>;
  schemaVersion?: string;
  schemaSnapshot?: FormSchemaSnapshot;
}

/**
 * 申請提出（新規提出 & 差戻し後再提出）共通制度バリデーションパイプライン (Single Source of Truth)
 * 
 * Wave 1 統合:
 * 1. Form Schema Validation (Whitelist, Type, Conditional Required)
 * 2. Canonical Conflict Validation (身分・期間・時間帯排他)
 * 3. Domain Policy Validation (各制度固有の条例・上限日数等)
 */
export class ApplicationValidationPipeline {
  static validate(params: {
    typeId: string;
    subjectUserId: number;
    formData: Record<string, any>;
    db: Database;
    applicationId?: number;
    schemaSnapshot?: FormSchemaSnapshot;
    isDraft?: boolean;
  }): ValidationPipelineResult {
    const { typeId, subjectUserId, formData = {}, db, schemaSnapshot, isDraft = false } = params;

    // 1. Authoritative Form Schema Validation (Whitelist & Field Rules)
    const targetDate = formData?.targetDate || formData?.startDate || formData?.startAt?.split('T')?.[0];
    const schemaValidation = FormValidationEngine.validate({
      typeId,
      rawValues: formData,
      schemaSnapshot,
      targetDate,
      isDraft
    });

    if (!schemaValidation.valid) {
      return {
        valid: false,
        status: schemaValidation.status,
        errorCode: schemaValidation.errorCode,
        message: schemaValidation.message
      };
    }

    const validatedValues = schemaValidation.sanitizedValues || formData;

    // 下書き保存時は制度排他・上限チェックを緩和
    if (isDraft) {
      return {
        valid: true,
        status: 200,
        sanitizedValues: validatedValues,
        schemaVersion: schemaValidation.schemaVersion,
        schemaSnapshot: schemaValidation.schemaSnapshot
      };
    }

    // 2. 共通期間・時間帯・身分重複検証 (Canonical Conflict Validation SSOT)
    const startDate = validatedValues?.startDate || validatedValues?.targetDate || validatedValues?.startAt?.split('T')?.[0];
    const endDate = validatedValues?.endDate || validatedValues?.targetDate || validatedValues?.endAt?.split('T')?.[0] || startDate;

    if (startDate && endDate) {
      const rawStartTime = validatedValues?.startTime || (validatedValues?.startAt ? validatedValues.startAt.split('T')?.[1]?.substring(0, 5) : undefined);
      const rawEndTime = validatedValues?.endTime || (validatedValues?.endAt ? validatedValues.endAt.split('T')?.[1]?.substring(0, 5) : undefined);

      const { ConflictService } = require('./conflictService');
      const conflictCheck = ConflictService.validate({
        userId: subjectUserId,
        startDate,
        endDate,
        applicationTypeId: typeId,
        unitType: validatedValues?.unitType || (rawStartTime && rawEndTime ? 'TIME' : 'DAY'),
        startTime: rawStartTime,
        endTime: rawEndTime,
        halfDayType: (validatedValues as any)?.halfDayType,
        excludeApplicationId: params.applicationId || undefined,
      });

      if (conflictCheck.hasConflict) {
        return {
          valid: false,
          status: 422,
          message: conflictCheck.reason || '指定された期間・時間帯には既に別の服務申請または身分状態が存在します',
          errorCode: conflictCheck.conflictType || 'SERVICE_PERIOD_CONFLICT',
        };
      }
    }

    // 3. 各制度固有の Statutory Policy Validation
    if (typeId === 'LEAVE_ANNUAL') {
      const validation = AnnualLeaveService.validateAnnualLeaveRequest(validatedValues, subjectUserId);
      if (!validation.valid) {
        return { valid: false, status: validation.status, message: validation.message, errorCode: 'ANNUAL_LEAVE_VALIDATION_FAILED' };
      }
      return {
        valid: true,
        status: 200,
        sanitizedValues: validatedValues,
        schemaVersion: schemaValidation.schemaVersion,
        schemaSnapshot: schemaValidation.schemaSnapshot
      };
    }

    if (typeId === 'LEAVE_CARE' || typeId === 'LEAVE_CARE_TIME') {
      const validation = typeId === 'LEAVE_CARE_TIME'
        ? CareLeaveService.validateCareTime(validatedValues, subjectUserId)
        : CareLeaveService.validateCareLeave(validatedValues, subjectUserId);
      if (!validation.valid) {
        return { valid: false, status: validation.status, message: validation.message, errorCode: 'CARE_LEAVE_VALIDATION_FAILED' };
      }
      return {
        valid: true,
        status: 200,
        sanitizedValues: validatedValues,
        schemaVersion: schemaValidation.schemaVersion,
        schemaSnapshot: schemaValidation.schemaSnapshot
      };
    }

    if (typeId === 'LEAVE_SPECIAL') {
      const res = this.validateSpecialLeave(validatedValues, subjectUserId, db);
      if (!res.valid) return res;
      return {
        valid: true,
        status: 200,
        sanitizedValues: validatedValues,
        schemaVersion: schemaValidation.schemaVersion,
        schemaSnapshot: schemaValidation.schemaSnapshot
      };
    }

    if (typeId === 'TRAINING_SPECIAL_ACT_22_2' || typeId === 'TRAINING_SPECIAL_ACT_22_3') {
      const res = this.validateTraining(typeId, validatedValues, subjectUserId, db);
      if (!res.valid) return res;
      return {
        valid: true,
        status: 200,
        sanitizedValues: validatedValues,
        schemaVersion: schemaValidation.schemaVersion,
        schemaSnapshot: schemaValidation.schemaSnapshot
      };
    }

    if (['LEAVE_SICK', 'LEAVE_DUTY_EXEMPT'].includes(typeId)) {
      const tDate = validatedValues?.targetDate || validatedValues?.startDate;
      if (tDate) {
        const oblResult = WorkingObligationResolver.resolve(subjectUserId, tDate);
        if (oblResult.isFailClosed || oblResult.status === 'UNRESOLVED') {
          return {
            valid: false,
            status: 400,
            message: `対象日の勤務義務を判定できません（勤務パターン未設定またはカレンダーエラー: ${oblResult.failReason || 'UNRESOLVED'}）`,
            errorCode: 'WORKING_OBLIGATION_UNRESOLVED'
          };
        }
        if (!oblResult.isWorkDay || oblResult.status === 'NON_WORKING') {
          return {
            valid: false,
            status: 400,
            message: `対象日（${tDate}）は勤務義務のない日（${oblResult.sourceDetails || '週休日・休日'}）のため、休暇を申請・消化することはできません`,
            errorCode: 'NON_WORKDAY_LEAVE_PROHIBITED',
          };
        }
      }
    }

    return {
      valid: true,
      status: 200,
      sanitizedValues: validatedValues,
      schemaVersion: schemaValidation.schemaVersion,
      schemaSnapshot: schemaValidation.schemaSnapshot
    };
  }

  private static validateSpecialLeave(formData: any, subjectUserId: number, db: Database): ValidationPipelineResult {
    const targetDate = formData?.targetDate || formData?.startDate;
    if (!targetDate) {
      return { valid: false, status: 400, message: '対象日を指定してください', errorCode: 'TARGET_DATE_REQUIRED' };
    }

    const reasonCode = formData.reasonCode || 'SPECIAL_BEREAVEMENT';
    const rule = db.prepare('SELECT * FROM policy_rules WHERE policy_code = ? AND is_active = 1 ORDER BY version DESC LIMIT 1').get(reasonCode) as any;

    if (!rule) {
      return { valid: false, status: 400, message: `該当する特別休暇ポリシーが存在しません（POLICY_NOT_FOUND: ${reasonCode}）`, errorCode: 'POLICY_NOT_FOUND' };
    }

    let def: any = {};
    try {
      def = JSON.parse(rule.rule_definition_json || '{}');
    } catch {
      return { valid: false, status: 400, message: '特別休暇ポリシー定義が不正です（INVALID）', errorCode: 'INVALID_POLICY_DEF' };
    }

    if (def.status === 'UNVERIFIED' || def.status === 'UNCONFIRMED') {
      return { valid: false, status: 400, message: '当該特別休暇制度のポリシーが未確認のため申請できません（UNVERIFIED）', errorCode: 'UNCONFIRMED_POLICY' };
    }

    if (targetDate < rule.effective_from || (rule.effective_to && targetDate > rule.effective_to)) {
      return { valid: false, status: 400, message: `対象日（${targetDate}）はポリシーの有効期間外です（有効期間: ${rule.effective_from} 〜 ${rule.effective_to}）`, errorCode: 'POLICY_PERIOD_OUT_OF_RANGE' };
    }

    const unitType = formData.unitType || 'DAY';
    const allowedUnits = def.allowedDurationUnits || ['DAY'];
    if (!allowedUnits.includes(unitType)) {
      return { valid: false, status: 400, message: `当該特別休暇（${rule.official_name}）では指定された単位（${unitType}）は許可されていません（許可単位: ${allowedUnits.join(', ')}）`, errorCode: 'UNIT_NOT_ALLOWED' };
    }

    if (unitType === 'TIME') {
      if (!formData.startTime || !formData.endTime || formData.startTime >= formData.endTime) {
        return { valid: false, status: 400, message: '有効な開始時間と終了時間を指定してください', errorCode: 'INVALID_TIME_RANGE' };
      }
    }

    const oblResult = WorkingObligationResolver.resolve(subjectUserId, targetDate);
    if (oblResult.isFailClosed || oblResult.status === 'UNRESOLVED') {
      return {
        valid: false,
        status: 400,
        message: `対象日の勤務義務を判定できません（勤務パターン未設定またはカレンダーエラー: ${oblResult.failReason || 'UNRESOLVED'}）`,
        errorCode: 'WORKING_OBLIGATION_UNRESOLVED'
      };
    }
    if (!oblResult.isWorkDay || oblResult.status === 'NON_WORKING') {
      return {
        valid: false,
        status: 400,
        message: `対象日（${targetDate}）は勤務義務のない日（${oblResult.sourceDetails || '週休日・休日'}）のため、特別休暇を申請することはできません`,
        errorCode: 'NON_WORKDAY_LEAVE_PROHIBITED',
      };
    }

    return { valid: true, status: 200 };
  }

  private static validateTraining(typeId: string, formData: any, subjectUserId: number, db: Database): ValidationPipelineResult {
    const targetDate = formData?.targetDate || formData?.startDate;
    if (!targetDate) {
      return { valid: false, status: 400, message: '対象日を指定してください', errorCode: 'TARGET_DATE_REQUIRED' };
    }

    const policyCode = typeId === 'TRAINING_SPECIAL_ACT_22_2' ? 'SPECIAL_ACT_22_2' : 'SPECIAL_ACT_22_3';
    const rule = db.prepare('SELECT * FROM policy_rules WHERE policy_code = ? AND is_active = 1 ORDER BY id DESC LIMIT 1').get(policyCode) as any;

    if (!rule) {
      return { valid: false, status: 400, message: '該当する研修ポリシーがシステムに存在しません（MISSING）', errorCode: 'POLICY_NOT_FOUND' };
    }

    let def: any = {};
    try {
      def = JSON.parse(rule.rule_definition_json || '{}');
    } catch {
      return { valid: false, status: 400, message: '研修ポリシーの定義形式が不正です（INVALID）', errorCode: 'INVALID_POLICY_DEF' };
    }

    if (def.status === 'UNCONFIRMED' || rule.display_code === 'UNCONFIRMED') {
      return { valid: false, status: 400, message: '当該自治体の研修制度ポリシーが未確定のため、申請を受け付けることができません（UNCONFIRMED）', errorCode: 'UNCONFIRMED_POLICY' };
    }

    if (formData.unitType === 'TIME') {
      if (def.hourlyAllowed !== 'CONFIRMED' && def.hourlyAllowed !== true) {
        return { valid: false, status: 400, message: '時間単位の研修は自治体ポリシーで許可されていないか未確定です', errorCode: 'HOURLY_TRAINING_NOT_ALLOWED' };
      }
      if (!formData.startTime || !formData.endTime || formData.startTime >= formData.endTime) {
        return { valid: false, status: 400, message: '開始時刻は終了時刻より前の有効な時間を指定してください', errorCode: 'INVALID_TIME_RANGE' };
      }
    } else if (formData.unitType === 'HALF_DAY') {
      if (def.halfDayAllowed !== 'CONFIRMED' && def.halfDayAllowed !== true) {
        return { valid: false, status: 400, message: '半日単位の研修は自治体ポリシーで許可されていないか未確定です', errorCode: 'HALFDAY_TRAINING_NOT_ALLOWED' };
      }
    }

    const oblResult = WorkingObligationResolver.resolve(subjectUserId, targetDate);
    if (oblResult.isFailClosed || oblResult.status === 'UNRESOLVED') {
      return {
        valid: false,
        status: 400,
        message: `対象日の勤務義務を判定できません（勤務パターン未設定またはカレンダーエラー: ${oblResult.failReason || 'UNRESOLVED'}）`,
        errorCode: 'WORKING_OBLIGATION_UNRESOLVED'
      };
    }
    if (!oblResult.isWorkDay || oblResult.status === 'NON_WORKING') {
      return {
        valid: false,
        status: 400,
        message: `対象日（${targetDate}）は勤務義務のない日（${oblResult.sourceDetails || '週休日・休日'}）のため、研修を申請することはできません`,
        errorCode: 'NON_WORKDAY_TRAINING_PROHIBITED',
      };
    }

    return { valid: true, status: 200 };
  }
}

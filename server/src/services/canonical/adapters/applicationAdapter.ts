import { CanonicalServiceFact, CanonicalServiceStatus, ServiceFactType } from '../types';
import { generateCanonicalFactIdentity } from '../identity';
import { minutesToTime } from '../../attendance/workPatternResolver';

export interface ApplicationRecord {
  id: number;
  type_id: string;
  subject_user_id: number;
  form_data: string;
  final_calculation_snapshot?: string | null;
  current_status: string;
  version: number;
  approval_cycle?: number;
}

export class InvalidCanonicalFactError extends Error {
  public readonly applicationId: number;
  public readonly typeId: string;
  public readonly reason: string;

  constructor(applicationId: number, typeId: string, reason: string) {
    super(
      `[INVALID_CANONICAL_FACT_ERROR] 承認済み時間単位申請のAuthoritative Fact解決に失敗しました (Fail-Closed)。` +
      ` ApplicationId: ${applicationId}, Type: ${typeId}, Reason: ${reason}`
    );
    this.name = 'InvalidCanonicalFactError';
    this.applicationId = applicationId;
    this.typeId = typeId;
    this.reason = reason;
  }
}

/**
 * 申請種別 (application_types) から CanonicalServiceStatus への決定論的マッピング
 */
export function mapApplicationTypeToCanonicalStatus(typeId: string, formReasonCode?: string): CanonicalServiceStatus {
  switch (typeId) {
    case 'LEAVE_ANNUAL':
    case 'ANNUAL_LEAVE':
      return 'ANNUAL_LEAVE';
    case 'LEAVE_SICK':
    case 'SICK_LEAVE':
    case 'SICK_LEAVE_ART13':
      return 'SICK_LEAVE';
    case 'LEAVE_SPECIAL':
    case 'SPECIAL_LEAVE':
    case 'SPECIAL_LEAVE_ART14':
      if (formReasonCode?.includes('MATERNITY') || formReasonCode === 'SPECIAL_MATERNITY_PRE' || formReasonCode === 'SPECIAL_MATERNITY_POST') {
        return 'SPECIAL_MATERNITY_LEAVE';
      }
      return 'SPECIAL_LEAVE_GENERAL';
    case 'LEAVE_DUTY_EXEMPT':
    case 'DUTY_EXEMPTION':
      if (formReasonCode === 'CONCURRENT' || formReasonCode === 'CONCURRENT_APPOINTMENT') {
        return 'CONCURRENT_APPOINTMENT';
      }
      return 'DUTY_EXEMPTION';
    case 'BUSINESS_TRIP':
    case 'OFFICIAL_BUSINESS_TRIP':
      return 'OFFICIAL_BUSINESS_TRIP';
    case 'LEAVE_CARE':
    case 'CARE_LEAVE':
      return 'CARE_LEAVE';
    case 'LEAVE_CARE_TIME':
    case 'CARE_TIME':
    case 'CARE_TIME_ART16':
      return 'CARE_TIME';
    case 'CHILDCARE_SUPPORT':
    case 'CHILDCARE_SUPPORT_PARTIAL_LEAVE':
      return 'CHILDCARE_SUPPORT_PARTIAL_LEAVE';
    case 'LEAVE_CHILDCARE':
    case 'CHILDCARE_LEAVE':
      return 'CHILDCARE_LEAVE';
    case 'WORK_PATTERN_CHILDCARE':
    case 'CHILDCARE_SHORT_TIME':
      return 'CHILDCARE_SHORT_TIME';
    case 'LEAVE_CHILDCARE_PARTIAL':
    case 'CHILDCARE_PARTIAL_LEAVE':
      return 'CHILDCARE_PARTIAL_LEAVE';
    case 'STUDY_PARTIAL_LEAVE':
      return 'STUDY_PARTIAL_LEAVE';
    case 'TRAINING_SPECIAL_ACT_22_2':
    case 'TRAINING_SPECIAL_ACT_22_3':
    case 'TRAINING_APPLICATION':
    case 'TRAINING':
      return 'TRAINING';
    case 'CONCURRENT_APPOINTMENT':
      return 'CONCURRENT_APPOINTMENT';
    case 'FOREIGN_DISPATCH':
      return 'FOREIGN_DISPATCH';
    default:
      return 'SPECIAL_LEAVE_GENERAL';
  }
}

/**
 * 日付範囲を展開して日付文字列配列 (YYYY-MM-DD) を生成
 */
function expandDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return [startDate];
  }

  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/**
 * Application Pure Normalizer
 * 単一の申請レコードから CanonicalServiceFact[] を決定論的生成
 */
export function normalizeApplicationToFacts(app: ApplicationRecord): CanonicalServiceFact[] {
  // 決裁済み申請 ('APPROVED', 'FINAL_APPROVED', 'TRIP_APPROVED') のみ対象 (INV-002, INV-003)
  if (!['APPROVED', 'FINAL_APPROVED', 'TRIP_APPROVED'].includes(app.current_status)) {
    return [];
  }

  let form: any = {};
  try {
    form = JSON.parse(app.form_data || '{}');
  } catch {
    return [];
  }

  const startDate = form.startDate || form.targetDate || form.date || form.startAt?.split('T')?.[0];
  const endDate = form.endDate || form.targetDate || form.date || form.endAt?.split('T')?.[0] || startDate;

  if (!startDate) {
    return [];
  }

  const isHalfDay = form.unitType === 'HALF_DAY';
  const isHourly = form.unitType === 'TIME' || (!form.unitType && !!form.startTime && !!form.endTime) || isHalfDay;
  const factType: ServiceFactType = isHourly ? 'TIME_EVENT' : 'DAY_EVENT';
  const canonicalStatus = mapApplicationTypeToCanonicalStatus(app.type_id, form.reasonCode || form.specialLeaveType || form.specialLeaveReason || form.exemptionReason);

  // 時間単位・半日単位服務の Authoritative Fact 解決 (Fail-Closed)
  let hourlyQuantityUnits: number | undefined;
  let halfDayStartTime: string | undefined;
  let halfDayEndTime: string | undefined;

  if (isHourly) {
    if (app.type_id === 'BUSINESS_TRIP') {
      hourlyQuantityUnits = form.durationMinutes;
    } else if (isHalfDay) {
      if (!app.final_calculation_snapshot) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          '承認済み半日単位申請に final_calculation_snapshot が存在しません'
        );
      }

      let snapshot: any;
      try {
        snapshot = JSON.parse(app.final_calculation_snapshot);
      } catch (err: any) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          `final_calculation_snapshot の JSON パースに失敗しました: ${err.message}`
        );
      }

      const deduction = snapshot?.attendanceDeductionMinutes;
      if (typeof deduction !== 'number' || isNaN(deduction) || deduction <= 0) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          `attendanceDeductionMinutes が不正な値です: ${deduction}`
        );
      }

      const intervals = snapshot?.workIntervalsSnapshot;
      if (!Array.isArray(intervals) || intervals.length < 2) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          `workIntervalsSnapshot が不正または2区間未満です: ${JSON.stringify(intervals)}`
        );
      }

      const halfDayType = snapshot?.halfDayType || form.halfDayType;
      if (halfDayType !== 'MORNING' && halfDayType !== 'AFTERNOON') {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          `halfDayType が不正または未設定です: ${halfDayType}`
        );
      }

      const targetInterval = halfDayType === 'MORNING' ? intervals[0] : intervals[intervals.length - 1];
      if (!targetInterval || typeof targetInterval.start !== 'number' || typeof targetInterval.end !== 'number' || targetInterval.start >= targetInterval.end) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          `対象半日区間が不正です: ${JSON.stringify(targetInterval)}`
        );
      }

      const intervalMinutes = targetInterval.end - targetInterval.start;
      if (intervalMinutes !== deduction) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          `区間分数 (${intervalMinutes}分) と控除分数 (${deduction}分) が不一致です`
        );
      }

      halfDayStartTime = minutesToTime(targetInterval.start);
      halfDayEndTime = minutesToTime(targetInterval.end);
      hourlyQuantityUnits = deduction;
    } else {
      // 休暇・免除等の時間単位申請: final_calculation_snapshot.attendanceDeductionMinutes が最優先 Authoritative SSOT
      if (!app.final_calculation_snapshot) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          '承認済み時間単位申請に final_calculation_snapshot が存在しません'
        );
      }

      let snapshot: any;
      try {
        snapshot = JSON.parse(app.final_calculation_snapshot);
      } catch (err: any) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          `final_calculation_snapshot の JSON パースに失敗しました: ${err.message}`
        );
      }

      const deduction = snapshot?.attendanceDeductionMinutes;
      if (typeof deduction !== 'number' || isNaN(deduction) || deduction <= 0) {
        throw new InvalidCanonicalFactError(
          app.id,
          app.type_id,
          `attendanceDeductionMinutes が不正な値です: ${deduction}`
        );
      }

      hourlyQuantityUnits = deduction;
    }
  }

  const dates = expandDateRange(startDate, endDate);
  const facts: CanonicalServiceFact[] = [];

  for (const d of dates) {
    const startTime = isHalfDay ? halfDayStartTime : (isHourly ? form.startTime : undefined);
    const endTime = isHalfDay ? halfDayEndTime : (isHourly ? form.endTime : undefined);

    const factId = generateCanonicalFactIdentity({
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: app.id,
      sourceVersion: app.version,
      workflowCycleId: app.approval_cycle ?? null,
      targetDate: d,
      startTime,
      endTime,
      canonicalStatus
    });

    facts.push({
      factId,
      userId: app.subject_user_id,
      canonicalStatus,
      factType,
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: app.id,
      sourceVersion: app.version,
      workflowCycleId: app.approval_cycle ?? null,
      targetDate: d,
      effectiveFrom: startDate,
      effectiveTo: endDate,
      startTime,
      endTime,
      quantityUnits: isHourly ? hourlyQuantityUnits : 1,
      isRestricted: false,
      supportingReferenceId: app.type_id === 'BUSINESS_TRIP' ? form.tripEventId : undefined,
      details: {
        applicationId: app.id,
        typeId: app.type_id,
        unitType: form.unitType || (isHourly ? 'TIME' : 'DAY'),
        halfDayType: form.halfDayType,
        destination: form.destination,
        reason: form.reason || form.purpose
      }
    });
  }

  return facts;
}

export const adaptApplicationToCanonicalFact = normalizeApplicationToFacts;

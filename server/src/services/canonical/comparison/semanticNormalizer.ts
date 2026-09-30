/**
 * Semantic Normalizer for Shadow Comparison
 * Canonical Service Fact Architecture — Phase C
 */

import { CanonicalDailyAttendance } from '../../attendance/types';
import { AttendanceDomainResult, CanonicalServiceStatus } from '../types';
import { AttendanceComparisonFact } from './comparisonTypes';

/**
 * 25服務状態の表示記号・名称正規化マッピング (PO定義25項目 + Control Case: WORKED)
 */
const STATUS_DISPLAY_MAP: Record<string, { symbol: string; name: string }> = {
  TRAINING: { symbol: '研', name: '研修' },
  ANNUAL_LEAVE: { symbol: '年', name: '年次有給休暇' },
  SICK_LEAVE: { symbol: '病', name: '病気休暇' },
  SPECIAL_MATERNITY_LEAVE: { symbol: '産', name: '産前産後休暇' },
  SPECIAL_LEAVE_GENERAL: { symbol: '特', name: '特別休暇' },
  CARE_LEAVE: { symbol: '介', name: '介護休暇' },
  CARE_TIME: { symbol: '介時', name: '介護時間' },
  CHILDCARE_SUPPORT_PARTIAL_LEAVE: { symbol: '育部', name: '子育て支援部分休暇' },
  DUTY_EXEMPTION: { symbol: '免', name: '職務専念義務免除' },
  ABSENCE: { symbol: '欠', name: '欠勤' },
  OFFICIAL_BUSINESS_TRIP: { symbol: '出張', name: '公務旅行' },
  SELF_DEVELOPMENT_LEAVE: { symbol: '自休', name: '自己啓発等休業' },
  SPOUSAL_ACCOMPANIMENT_LEAVE: { symbol: '配休', name: '配偶者同行休業' },
  CHILDCARE_LEAVE: { symbol: '育', name: '育児休業' },
  CHILDCARE_SHORT_TIME: { symbol: '育短', name: '育児短時間' },
  CHILDCARE_PARTIAL_LEAVE: { symbol: '部休', name: '部分休業' },
  STUDY_PARTIAL_LEAVE: { symbol: '修休', name: '修学部分休業' },
  ADMINISTRATIVE_LEAVE_SUSPENSION: { symbol: '休', name: '分限休職' },
  UNION_FULL_TIME_SUSPENSION: { symbol: '専', name: '専従休職' },
  DISCIPLINARY_SUSPENSION: { symbol: '停', name: '停職' },
  HOLIDAY: { symbol: '祝', name: '休日' },
  SUBSTITUTE_HOLIDAY: { symbol: '代休', name: '休日の代休日' },
  WEEKLY_OFF: { symbol: '休', name: '週休日' },
  CONCURRENT_APPOINTMENT: { symbol: '兼務', name: '兼務' },
  DISPATCH: { symbol: '派遣', name: '派遣' },
  FOREIGN_DISPATCH: { symbol: '派遣', name: '派遣' }, // 互換
  WORKED: { symbol: '出', name: '通常勤務' } // Baseline / Control Case
};

/**
 * 各服務状態ごとの厳密な表示エイリアス定義 (Status-Bound Display Aliases)
 * ※ 異なる服務状態間での記号同一視は厳格に禁止 (Contract P0)
 */
const STATUS_STRICT_ALIASES: Record<string, string[]> = {
  TRAINING: ['研', '研修', '初任者研修会', '特例法22条研修'],
  ANNUAL_LEAVE: ['年', '年次有給休暇', '年休', '有休'],
  SICK_LEAVE: ['病', '病気休暇', '病休'],
  SPECIAL_MATERNITY_LEAVE: ['産', '産前産後休暇', '産休', '産前休暇', '産後休暇'],
  SPECIAL_LEAVE_GENERAL: ['特', '特別休暇', '特休', '忌引休暇', '結婚休暇'],
  CARE_LEAVE: ['介', '介護休暇', '介護'],
  CARE_TIME: ['介時', '介護時間'],
  CHILDCARE_SUPPORT_PARTIAL_LEAVE: ['育部', '子育て支援部分休暇', '子育て部分休暇'],
  DUTY_EXEMPTION: ['免', '職務専念義務免除', '職専免', '職免'],
  ABSENCE: ['欠', '欠勤', '全日欠勤'],
  OFFICIAL_BUSINESS_TRIP: ['出張', '公務旅行', '公務出張', '張'],
  SELF_DEVELOPMENT_LEAVE: ['自休', '自己啓発等休業', '自己啓発休業', '自'],
  SPOUSAL_ACCOMPANIMENT_LEAVE: ['配休', '配偶者同行休業', '配'],
  CHILDCARE_LEAVE: ['育', '育児休業', '育休'],
  CHILDCARE_SHORT_TIME: ['育短', '育児短時間', '育児短時間勤務'],
  CHILDCARE_PARTIAL_LEAVE: ['部休', '部分休業', '育児部分休業'],
  STUDY_PARTIAL_LEAVE: ['修休', '修学部分休業', '修'],
  ADMINISTRATIVE_LEAVE_SUSPENSION: ['休', '分限休職', '分休', '休職'],
  UNION_FULL_TIME_SUSPENSION: ['専', '専従休職', '専休'], // 停職('停')とは絶対に混同しない (P0)
  DISCIPLINARY_SUSPENSION: ['停', '停職'], // 専従('専')とは絶対に混同しない (P0)
  HOLIDAY: ['祝', '休日', '祝日・休日', '祝日'],
  SUBSTITUTE_HOLIDAY: ['代休', '休日の代休日', '振替・代休', '代'], // 週休日('休')とは絶対に混同しない (P0)
  WEEKLY_OFF: ['休', '週休日', '週休'],
  CONCURRENT_APPOINTMENT: ['兼務', '兼務発令'],
  DISPATCH: ['派遣', '外国派遣', '国内派遣', '派'],
  FOREIGN_DISPATCH: ['派遣', '外国派遣', '派'],
  WORKED: ['出', '通常勤務', '勤務', '勤務日', '育短勤務', '振替勤務日']
};

export class SemanticNormalizer {
  /**
   * Legacy Engine 出力 (CanonicalDailyAttendance) を共通 DTO へ正規化
   */
  static normalizeLegacy(legacy: CanonicalDailyAttendance, userId: number): AttendanceComparisonFact {
    let dutyReq: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED' | 'EXEMPT' = 'WORK_REQUIRED';
    if (legacy.dutyRequirement === 'NO_WORK_REQUIRED') {
      dutyReq = 'NO_WORK_REQUIRED';
    } else if ((legacy as any).dutyRequirement === 'EXEMPT') {
      dutyReq = 'EXEMPT';
    } else if (legacy.dutyRequirement === 'WORK_REQUIRED') {
      dutyReq = 'WORK_REQUIRED';
    } else if (legacy.isWorkRequired === false || (!legacy.isWorkDay && legacy.serviceStatus !== 'ABSENCE_FULL_DAY' && legacy.serviceStatus !== 'LEAVE_ANNUAL' && legacy.serviceStatus !== 'LEAVE_SICK' && legacy.serviceStatus !== 'LEAVE_SPECIAL' && legacy.serviceStatus !== 'LEAVE_DUTY_EXEMPT' && legacy.serviceStatus !== 'LEAVE_CARE')) {
      dutyReq = 'NO_WORK_REQUIRED';
    }

    const primaryStatus = (legacy.serviceStatus || legacy.primaryDayClassification || 'WORKED').toUpperCase();

    // 身分状態オーバーライド時は false、非勤務義務（祝日・週休・代休）時は false、それ以外（通常勤務・年休・特休・欠勤等）は true
    let isScheduledWorkDay = false;
    if (legacy.isPersonnelStatusOverridden) {
      isScheduledWorkDay = false;
    } else if (dutyReq === 'NO_WORK_REQUIRED') {
      isScheduledWorkDay = false;
    } else {
      isScheduledWorkDay = dutyReq === 'WORK_REQUIRED' || (legacy.isWorkDay ?? false);
    }

    return {
      userId,
      date: legacy.date,
      dayOfWeek: legacy.dayOfWeek,
      isScheduledWorkDay,
      dutyRequirement: dutyReq,
      scheduledWorkMinutes: legacy.scheduledWorkMinutes || 0,
      countedWorkMinutes: legacy.actualWorkMinutes || 0,
      deductionMinutes: legacy.deductionMinutes || 0,
      effectiveWorkMinutes: (legacy.actualWorkMinutes !== undefined) ? legacy.actualWorkMinutes : Math.max(0, (legacy.scheduledWorkMinutes || 0) - (legacy.deductionMinutes || 0)),
      primaryStatus,
      displaySymbol: legacy.displaySymbol || '',
      displayName: legacy.displayName || '',
      aggregationCategory: legacy.aggregationCategory || '',
      isPersonnelStatusOverridden: !!legacy.isPersonnelStatusOverridden,
      ruleCount: legacy.explanations ? legacy.explanations.length : 0
    };
  }

  /**
   * Canonical Pipeline 出力 (AttendanceDomainResult) を共通 DTO へ正規化
   */
  static normalizeCanonical(canonical: AttendanceDomainResult): AttendanceComparisonFact {
    const statusMeta = STATUS_DISPLAY_MAP[canonical.primaryCanonicalStatus] || {
      symbol: canonical.primaryCanonicalStatus,
      name: canonical.primaryCanonicalStatus
    };

    return {
      userId: canonical.userId,
      date: canonical.date,
      dayOfWeek: canonical.dayOfWeek,
      isScheduledWorkDay: canonical.isScheduledWorkDay,
      dutyRequirement: canonical.dutyStatus,
      scheduledWorkMinutes: canonical.scheduledWorkMinutes,
      countedWorkMinutes: canonical.countedWorkMinutes,
      deductionMinutes: canonical.deductionMinutes,
      effectiveWorkMinutes: canonical.effectiveWorkMinutes,
      primaryStatus: canonical.primaryCanonicalStatus,
      displaySymbol: statusMeta.symbol,
      displayName: statusMeta.name,
      aggregationCategory: canonical.aggregationCategory,
      isPersonnelStatusOverridden: canonical.isPersonnelStatusOverridden,
      ruleCount: canonical.explanations ? canonical.explanations.length : 0
    };
  }

  /**
   * 2つの表示記号がセマンティックに等価かどうか判定 (Status-Bound Strict Equivalence)
   * @param sym1 記号1
   * @param sym2 記号2
   * @param targetStatus 特定ステータスが指定された場合はそのステータスのAliasのみ照合
   */
  static areSymbolsEquivalent(sym1: string, sym2: string, targetStatus?: string): boolean {
    if (sym1 === sym2) return true;
    const clean1 = sym1.trim();
    const clean2 = sym2.trim();
    if (clean1 === clean2) return true;

    if (targetStatus && STATUS_STRICT_ALIASES[targetStatus]) {
      const aliases = STATUS_STRICT_ALIASES[targetStatus];
      return aliases.includes(clean1) && aliases.includes(clean2);
    }

    // 各ステータスの独立エイリアス集合を順次照合（異なるステータス間の混同は完全禁止）
    for (const aliases of Object.values(STATUS_STRICT_ALIASES)) {
      if (aliases.includes(clean1) && aliases.includes(clean2)) {
        return true;
      }
    }

    return false;
  }
}

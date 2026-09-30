import { ClassCoverageData, ClassCoverageItem, ClassCoverageStatus, ClassCoverageType } from '../types/formSchema';

export interface DisplayClassCoverage {
  hasCoverage: boolean;
  status: ClassCoverageStatus | 'LEGACY';
  statusLabel: string;
  statusBadgeVariant: 'success' | 'warning' | 'info' | 'default';
  notRequiredReason?: string;
  items: Array<{
    id?: string;
    targetDate: string;
    period: string;
    coverageType: ClassCoverageType | 'LEGACY';
    coverageTypeLabel: string;
    substituteUserId?: number;
    substituteTeacherName: string;
    substituteTeacherDept?: string;
    subjectName?: string;
    contentNotes?: string;
  }>;
  summaryText: string;
}

export const COVERAGE_TYPE_LABELS: Record<ClassCoverageType, string> = {
  SUBSTITUTE_LESSON: '授業代替（補欠・代行）',
  SELF_STUDY_SUPERVISION: '自習監督',
  TIMETABLE_EXCHANGE: '時間割変更（授業交換）',
  COMBINED_CLASS: '合同授業',
  OTHER: 'その他'
};

export const COVERAGE_STATUS_LABELS: Record<ClassCoverageStatus, string> = {
  REQUIRED: '授業措置あり',
  NOT_REQUIRED: '授業措置不要',
  UNSURE: '教務・管理職確認中'
};

/**
 * 授業措置表示用 Canonical Read Adapter (SSOT)
 * Option C 構造化明細と旧 substituteTeacher 自由記述文字列の両方を安全に解釈
 */
export function resolveDisplayClassCoverage(formData: Record<string, any> = {}): DisplayClassCoverage {
  const coverageStatus = formData.coverageStatus as ClassCoverageStatus | undefined;
  const coverageItems = Array.isArray(formData.coverageItems) ? (formData.coverageItems as ClassCoverageItem[]) : [];
  const notRequiredReason = formData.notRequiredReason;
  const legacySubstitute = typeof formData.substituteTeacher === 'string' ? formData.substituteTeacher.trim() : '';

  // 1. 新規 3-State Coverage Model (Option C) が存在する場合
  if (coverageStatus) {
    if (coverageStatus === 'REQUIRED') {
      const mappedItems = coverageItems.map((item, idx) => {
        const typeLabel = COVERAGE_TYPE_LABELS[item.coverageType] || item.coverageType || '代替措置';
        const teacherName = item.substituteUserNameSnapshot || (item as any).substituteTeacherName || (item.substituteUserId ? '教員ID:' + item.substituteUserId : '未定');
        return {
          id: item.id || ('cov_' + (idx + 1)),
          targetDate: item.targetDate || formData.targetDate || formData.startDate || '',
          period: item.period || '-',
          coverageType: item.coverageType,
          coverageTypeLabel: typeLabel,
          substituteUserId: item.substituteUserId,
          substituteTeacherName: teacherName,
          substituteTeacherDept: item.substituteUserDeptSnapshot,
          subjectName: item.subjectName,
          contentNotes: item.contentNotes
        };
      });

      const summary = mappedItems.length > 0
        ? mappedItems.map(i => i.targetDate + ' ' + i.period + ': ' + i.coverageTypeLabel + '（' + i.substituteTeacherName + '）').join(' / ')
        : '授業措置あり（明細未登録）';

      return {
        hasCoverage: true,
        status: 'REQUIRED',
        statusLabel: COVERAGE_STATUS_LABELS.REQUIRED,
        statusBadgeVariant: 'warning',
        items: mappedItems,
        summaryText: summary
      };
    }

    if (coverageStatus === 'NOT_REQUIRED') {
      return {
        hasCoverage: false,
        status: 'NOT_REQUIRED',
        statusLabel: COVERAGE_STATUS_LABELS.NOT_REQUIRED,
        statusBadgeVariant: 'default',
        notRequiredReason: notRequiredReason || '担当授業なし等のため措置不要',
        items: [],
        summaryText: notRequiredReason ? '措置不要 (' + notRequiredReason + ')' : '措置不要'
      };
    }

    if (coverageStatus === 'UNSURE') {
      return {
        hasCoverage: true,
        status: 'UNSURE',
        statusLabel: COVERAGE_STATUS_LABELS.UNSURE,
        statusBadgeVariant: 'info',
        items: [],
        summaryText: '教務主任・管理職へ確認中（決裁前に確定が必要）'
      };
    }
  }

  // 2. 旧データ (Legacy substituteTeacher 自由記述文字列) のフォールバック
  if (legacySubstitute) {
    return {
      hasCoverage: true,
      status: 'LEGACY',
      statusLabel: '旧形式引継ぎ記述',
      statusBadgeVariant: 'default',
      items: [
        {
          id: 'legacy_1',
          targetDate: formData.targetDate || formData.startDate || '',
          period: '-',
          coverageType: 'LEGACY',
          coverageTypeLabel: '引継ぎ・代行事項',
          substituteTeacherName: legacySubstitute,
          contentNotes: legacySubstitute
        }
      ],
      summaryText: legacySubstitute
    };
  }

  // 3. 該当なし
  return {
    hasCoverage: false,
    status: 'NOT_REQUIRED',
    statusLabel: '措置不要 / 未設定',
    statusBadgeVariant: 'default',
    items: [],
    summaryText: 'なし'
  };
}
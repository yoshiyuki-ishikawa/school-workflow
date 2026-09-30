export type DerivedTripStatus =
  | 'DRAFT'
  | 'TRAVEL_ORDER_PENDING'
  | 'TRAVEL_ORDER_EX_POST_PENDING'
  | 'ORDER_APPROVED'
  | 'IN_TRIP'
  | 'REPORT_REQUIRED'
  | 'REPORT_REVISION_REQUIRED'
  | 'REPORT_PENDING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED';

/**
 * 物理DBステータスを変更せず、既存事実から決定論的に UI ステータスを導出する Pure Function (SSOT)
 */
export function deriveTripStatus(
  appStatus: string,
  reportStatus: string | null,
  tripStartAt: string,
  tripEndAt: string,
  nowIso: string = new Date().toISOString()
): DerivedTripStatus {
  if (appStatus === 'REJECTED') return 'REJECTED';
  if (appStatus === 'CANCELLED' || appStatus === 'WITHDRAWN') return 'CANCELLED';
  if (appStatus === 'DRAFT') return 'DRAFT';

  // 旅行命令決裁中 (未確定)
  if (['SUBMITTED', 'IN_APPROVAL', 'FIRST_APPROVED', 'SECOND_APPROVED'].includes(appStatus)) {
    if (tripEndAt < nowIso) {
      return 'TRAVEL_ORDER_EX_POST_PENDING'; // 口頭発令等で旅行終了後の事後記録決裁中
    }
    return 'TRAVEL_ORDER_PENDING'; // 通常事前申請決裁中
  }

  // 旅行命令確定済 (TRIP_APPROVED / FINAL_APPROVED)
  if (appStatus === 'TRIP_APPROVED' || appStatus === 'FINAL_APPROVED') {
    if (nowIso < tripStartAt) {
      return 'ORDER_APPROVED'; // 旅行前
    }
    if (nowIso >= tripStartAt && nowIso <= tripEndAt) {
      return 'IN_TRIP'; // 旅行中
    }
    // 旅行終了後 (nowIso > tripEndAt)
    if (!reportStatus || reportStatus === 'UNSUBMITTED') {
      return 'REPORT_REQUIRED'; // 復命未起案・未提出
    }
    if (reportStatus === 'REPORT_RETURNED') {
      return 'REPORT_REVISION_REQUIRED'; // PINPOINT-04 是正: 復命差戻し・再提出待ち
    }
    if (['REPORT_SUBMITTED', 'REPORT_FIRST_APPROVED', 'REPORT_SECOND_APPROVED'].includes(reportStatus)) {
      return 'REPORT_PENDING'; // 復命決裁中
    }
    if (reportStatus === 'REPORT_FINAL_APPROVED') {
      return 'COMPLETED'; // 全行程完了
    }
  }

  return 'TRAVEL_ORDER_PENDING';
}

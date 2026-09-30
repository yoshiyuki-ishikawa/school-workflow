import React from 'react';
import { AlertTriangle, FileText, RotateCcw, Send, CheckCircle2, MapPin, Award, Clock } from 'lucide-react';
import { CancellationReturnMetadata, BusinessTripReportStatus } from '../../types';

export interface WorkflowAlertBannersProps {
  currentStatus: string;
  hasActiveCancellation: boolean;
  cancellationReason?: string | null;
  cancellationReturn?: CancellationReturnMetadata | {
    status: string;
    returnReason?: string | null;
    returnedByUserName?: string | null;
    returnedAt?: string | null;
  } | null;
  // Action Intent Callbacks & Visibility (Step 1B Actionability State 由来)
  canEditDraft?: boolean;
  canResubmit?: boolean;
  canResubmitCancellation?: boolean;
  onOpenDraftModal?: () => void;
  onOpenResubmitModal?: () => void;
  onOpenCancelResubmitModal?: () => void;

  // 出張ライフサイクルバナー表示用プロパティ (v1.1 FINAL Lifecycle Presentation)
  isBusinessTrip?: boolean;
  reportStatus?: BusinessTripReportStatus | null;
  canSubmitReport?: boolean;
  onOpenReportModal?: () => void;
}

/**
 * WorkflowAlertBanners
 * 
 * 現在のワークフロー状態（下書き、差戻し、取消進行中、取消差戻し等）を通知する外殻Presentationコンポーネント。
 * 
 * 【Architecture Invariants】
 * 1. Pure Presentation: 内部で状態機械やRBAC認可を再実装しない。
 * 2. Visual Parity: 既存バナーのカラー、アイコン、文言、アニメーションを完全維持。
 * 3. Intent Boundary: アクションボタンクリック時は提供されたコールバック（Intent）を発火するのみ。
 */
export const WorkflowAlertBanners: React.FC<WorkflowAlertBannersProps> = ({
  currentStatus,
  hasActiveCancellation,
  cancellationReason,
  cancellationReturn,
  canEditDraft = false,
  canResubmit = false,
  canResubmitCancellation = false,
  onOpenDraftModal,
  onOpenResubmitModal,
  onOpenCancelResubmitModal,
  isBusinessTrip = false,
  reportStatus = null,
  canSubmitReport = false,
  onOpenReportModal,
}) => {
  return (
    <div className="space-y-4">
      {/* 下書き保存案内バナー (DRAFT状態の場合) */}
      {currentStatus === 'DRAFT' && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="p-2 bg-amber-100 text-amber-800 rounded-lg">
                <FileText className="w-5 h-5" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-amber-900">この申請は下書き保存状態です（未提出）</h3>
                <p className="text-xs text-amber-700 mt-0.5">
                  決裁ルートはまだ開始されていません。内容を確認・編集し、「下書きを編集して提出」から決裁ルートへ提出してください。
                </p>
              </div>
            </div>
            {canEditDraft && onOpenDraftModal && (
              <button
                type="button"
                onClick={onOpenDraftModal}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition flex-shrink-0"
              >
                <Send className="w-4 h-4" />
                <span>下書きを編集して提出</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 取消進行中バナー (GAP-01) */}
      {hasActiveCancellation && (
        <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-5 shadow-sm space-y-3 animate-pulse">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="p-2 bg-amber-200 text-amber-900 rounded-lg">
                <AlertTriangle className="w-5 h-5" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-amber-950">
                  【承認後取消 進行中】取消承認フローが開始されています
                </h3>
                <p className="text-xs text-amber-800 mt-0.5">
                  取消理由: {cancellationReason || "承認後取消"}
                </p>
                <p className="text-[11px] text-amber-700 mt-1">
                  ※ 取消決裁が完了するまで、本申請の服務・出勤簿・年休引当は有効に継続します。最終決裁により正式に取り消されます。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 取消差戻し警告バナー (Cancellation RETURNED) */}
      {cancellationReturn && cancellationReturn.status === 'RETURNED' && (
        <div className="bg-rose-50 border-2 border-rose-400 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="p-2 bg-rose-200 text-rose-900 rounded-lg">
                <AlertTriangle className="w-5 h-5" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-rose-950">
                  【承認後取消 差戻し】取消申請が決裁者により差戻されました
                </h3>
                <p className="text-xs text-rose-800 mt-0.5">
                  差戻し理由: {cancellationReturn.returnReason || '理由の記載なし'}
                </p>
                {cancellationReturn.returnedByUserName && (
                  <p className="text-xs text-rose-700 mt-0.5">
                    差戻し者: {cancellationReturn.returnedByUserName}
                    {cancellationReturn.returnedAt &&
                      ` (${new Date(cancellationReturn.returnedAt).toLocaleString('ja-JP')})`}
                  </p>
                )}
                <p className="text-[11px] text-rose-700 mt-1">
                  ※ 原申請（決裁完了状態および出勤簿・年休引当）はそのまま有効に維持されています。
                </p>
              </div>
            </div>
            {canResubmitCancellation && onOpenCancelResubmitModal && (
              <button
                type="button"
                onClick={onOpenCancelResubmitModal}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition flex-shrink-0"
              >
                <RotateCcw className="w-4 h-4" />
                <span>取消申請を修正して再提出</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 差戻し警告バナー (RETURNED状態の場合) */}
      {currentStatus === 'RETURNED' && (
        <div className="bg-rose-50 border-2 border-rose-300 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="p-2 bg-rose-100 text-rose-700 rounded-lg">
                <AlertTriangle className="w-5 h-5" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-rose-900">この申請は決裁者により差戻されました</h3>
                <p className="text-xs text-rose-700 mt-0.5">
                  指摘事項や理由を確認の上、「申請内容を修正して再提出」ボタンから内容を更新して再提出してください。
                </p>
              </div>
            </div>
            {canResubmit && onOpenResubmitModal && (
              <button
                type="button"
                onClick={onOpenResubmitModal}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition flex-shrink-0"
              >
                <RotateCcw className="w-4 h-4" />
                <span>修正して再提出する</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 出張ライフサイクルバナー: 1. 旅行命令 決裁完了（出張前・復命待ち） */}
      {isBusinessTrip && (currentStatus === 'TRIP_APPROVED' || (currentStatus === 'FINAL_APPROVED' && (!reportStatus || reportStatus === 'UNSUBMITTED'))) && (
        <div className="bg-indigo-50 border-2 border-indigo-300 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="p-2 bg-indigo-100 text-indigo-800 rounded-lg">
                <MapPin className="w-5 h-5 text-indigo-600" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-indigo-950">
                  【旅行命令 決裁完了】公務出張の旅行命令が発令されています
                </h3>
                <p className="text-xs text-indigo-800 mt-0.5">
                  公務旅行の実施後、速やかに「復命書を提出」ボタンより出張結果および旅行実績をご報告ください。
                </p>
              </div>
            </div>
            {canSubmitReport && onOpenReportModal && (
              <button
                type="button"
                onClick={onOpenReportModal}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition flex-shrink-0"
              >
                <Award className="w-4 h-4" />
                <span>復命書を提出</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 出張ライフサイクルバナー: 2. 出張復命 承認中（第2サイクル審査中） */}
      {isBusinessTrip && (currentStatus === 'REPORT_SUBMITTED' || currentStatus === 'REPORT_FIRST_APPROVED' || currentStatus === 'REPORT_SECOND_APPROVED' || reportStatus === 'REPORT_SUBMITTED' || reportStatus === 'REPORT_FIRST_APPROVED' || reportStatus === 'REPORT_SECOND_APPROVED') && (
        <div className="bg-purple-50 border-2 border-purple-300 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="p-2 bg-purple-100 text-purple-800 rounded-lg">
                <Clock className="w-5 h-5 text-purple-600 animate-pulse" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-purple-950">
                  【出張復命 承認中】復命書の決裁ルートが進行しています
                </h3>
                <p className="text-xs text-purple-800 mt-0.5">
                  出張実績・報告内容の決裁完了をお待ちください。決裁完了をもって全行程が完了します。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 出張ライフサイクルバナー: 3. 出張・復命 全行程完了 */}
      {isBusinessTrip && reportStatus === 'REPORT_FINAL_APPROVED' && (
        <div className="bg-emerald-50 border-2 border-emerald-300 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="p-2 bg-emerald-100 text-emerald-800 rounded-lg">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-emerald-950">
                  【出張・復命 全行程完了】旅行命令および復命書の全決裁が完了しました
                </h3>
                <p className="text-xs text-emerald-800 mt-0.5">
                  本件の出張公務および実績報告は正式に完了・承認保存されています。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

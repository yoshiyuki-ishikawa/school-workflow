import React from 'react';
import {
  ArrowLeft,
  Printer,
  FileCheck2,
  Send,
  RotateCcw,
  Trash2,
} from 'lucide-react';

export interface ApplicationActionBarProps {
  // Navigation & Official Output
  onBack: () => void;
  onOpenPdfModal: () => void;

  // Actionability State (Step 1B 算出の Presentation Fact に依存)
  canSubmitReport?: boolean;
  canEditDraft?: boolean;
  canRequestCancellation?: boolean;
  canResubmit?: boolean;
  canWithdraw?: boolean;
  actionLoading?: boolean;

  // Action Intent Callbacks
  onOpenReportModal?: () => void;
  onOpenDraftModal?: () => void;
  onOpenCancelModal?: () => void;
  onOpenResubmitModal?: () => void;
  onWithdraw?: () => void;
}

/**
 * ApplicationActionBar
 * 
 * 画面上部の主要アクションボタン（公文書出力、復命書提出、下書き提出、取消起案、差戻し再提出、取下げ）を表示する純粋Presentationコンポーネント。
 * 
 * 【Architecture Invariants】
 * 1. Client Authorization Replica = 0: 内部でロール比較・本人判定・ステータス組合せによる権限再計算を行わない。
 * 2. Pure Presentation: 渡された Actionability フラグに従ってボタンを描画するのみ。
 * 3. Intent Boundary: クリック時に Intent コールバックを発火するのみ（API直接実行・モーダル状態管理は行わない）。
 */
export const ApplicationActionBar: React.FC<ApplicationActionBarProps> = ({
  onBack,
  onOpenPdfModal,
  canSubmitReport = false,
  canEditDraft = false,
  canRequestCancellation = false,
  canResubmit = false,
  canWithdraw = false,
  actionLoading = false,
  onOpenReportModal,
  onOpenDraftModal,
  onOpenCancelModal,
  onOpenResubmitModal,
  onWithdraw,
}) => {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
      <button
        type="button"
        onClick={onBack}
        className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 transition"
      >
        <ArrowLeft className="w-4 h-4" /> 一覧に戻る
      </button>

      <div className="flex items-center gap-2">
        {/* 正式公文書 A4 PDF 印刷ボタン */}
        <button
          type="button"
          onClick={onOpenPdfModal}
          className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow-sm"
        >
          <Printer className="w-3.5 h-3.5 text-indigo-400" />
          <span>公文書帳票 (A4 PDF) 出力</span>
        </button>

        {/* 復命書提出ボタン */}
        {canSubmitReport && onOpenReportModal && (
          <button
            type="button"
            onClick={onOpenReportModal}
            className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow-sm"
          >
            <FileCheck2 className="w-3.5 h-3.5" />
            <span>復命書を提出</span>
          </button>
        )}

        {/* 下書き編集・提出ボタン */}
        {canEditDraft && onOpenDraftModal && (
          <button
            type="button"
            onClick={onOpenDraftModal}
            className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
          >
            <Send className="w-3.5 h-3.5" />
            <span>下書きを編集して提出（決裁ルートにのせる）</span>
          </button>
        )}

        {/* 承認後取消起案ボタン */}
        {canRequestCancellation && onOpenCancelModal && (
          <button
            type="button"
            onClick={onOpenCancelModal}
            disabled={actionLoading}
            className="px-3.5 py-1.5 bg-rose-50 border border-rose-300 text-rose-700 hover:bg-rose-100 rounded-lg text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
          >
            <RotateCcw className="w-3.5 h-3.5 text-rose-600" />
            <span>承認後の取消を申請</span>
          </button>
        )}

        {/* 差戻し後の再申請ボタン */}
        {canResubmit && onOpenResubmitModal && (
          <button
            type="button"
            onClick={onOpenResubmitModal}
            className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition shadow-sm animate-bounce"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>申請内容を修正して再提出</span>
          </button>
        )}

        {/* 取下げボタン */}
        {canWithdraw && onWithdraw && (
          <button
            type="button"
            onClick={onWithdraw}
            disabled={actionLoading}
            className="px-3 py-1.5 border border-slate-300 text-rose-600 hover:bg-rose-50 rounded-lg text-xs font-semibold flex items-center gap-1 transition"
          >
            <Trash2 className="w-3.5 h-3.5" /> 取下げ
          </button>
        )}
      </div>
    </div>
  );
};

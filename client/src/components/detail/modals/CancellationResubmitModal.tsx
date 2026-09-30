import React, { useState, useEffect } from 'react';
import { AlertTriangle, RotateCcw, XCircle } from 'lucide-react';
import { CancellationReturnMetadata, WorkflowCycle } from '../../../types';

export interface CancellationResubmitModalProps {
  isOpen: boolean;
  cancellationReturn?: CancellationReturnMetadata | null;
  latestCancellationCycle?: WorkflowCycle | null;
  actionLoading?: boolean;
  onClose: () => void;
  onSubmit: (newCancellationReason: string) => Promise<void>;
}

/**
 * CancellationResubmitModal
 * 
 * 承認後取消が差戻された後の修正・再提出用モーダル (Phase 2)。
 * 
 * 【Architecture Invariants】
 * 1. Domain Intent Separation: 通常の申請再提出 (NewApplicationModal) と取消再提出を完全に区別。
 * 2. Fact Preservation: 決裁者からの差戻し指摘事項および前回の取消理由を Read-Only で明示。
 * 3. Validation Semantics: 修正後の取消理由は入力必須。
 */
export const CancellationResubmitModal: React.FC<CancellationResubmitModalProps> = ({
  isOpen,
  cancellationReturn,
  latestCancellationCycle,
  actionLoading = false,
  onClose,
  onSubmit,
}) => {
  const [newReason, setNewReason] = useState('');

  useEffect(() => {
    if (isOpen) {
      setNewReason(latestCancellationCycle?.cancellation_reason || '');
    }
  }, [isOpen, latestCancellationCycle]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!newReason.trim()) {
      alert('修正後の取消理由の記入は必須です');
      return;
    }
    await onSubmit(newReason.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <RotateCcw className="w-5 h-5 text-rose-600" />
            <span>承認後取消申請の修正・再提出</span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1 rounded-full"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3 text-xs">
          {/* 差戻し理由 (Read-Only) */}
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 space-y-1">
            <span className="font-bold flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>決裁者からの差戻し理由 (指摘事項)</span>
            </span>
            <p className="whitespace-pre-wrap pl-4 font-mono">
              {cancellationReturn?.returnReason || '理由の記載なし'}
            </p>
            {cancellationReturn?.returnedByUserName && (
              <p className="text-[10px] text-rose-600 pl-4">
                差戻し者: {cancellationReturn.returnedByUserName}
              </p>
            )}
          </div>

          {/* 旧取消理由 (Read-Only) */}
          {latestCancellationCycle?.cancellation_reason && (
            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-600 space-y-1">
              <span className="font-semibold block text-slate-500">
                前回の取消理由 (参考)
              </span>
              <p className="whitespace-pre-wrap pl-2 text-slate-700">
                {latestCancellationCycle.cancellation_reason}
              </p>
            </div>
          )}

          {/* 修正後取消理由入力 (Editable) */}
          <div className="space-y-1">
            <label className="block font-bold text-slate-700">
              修正後の取消理由 <span className="text-rose-500">*必須</span>
            </label>
            <textarea
              rows={4}
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              placeholder="指摘事項をふまえた取消理由を具体的に入力してください..."
              className="w-full text-xs p-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-rose-500 focus:outline-none"
            />
          </div>

          <p className="text-[11px] text-slate-500 bg-amber-50/60 p-2 rounded border border-amber-200">
            ※ 再提出すると新しい取消審査フロー（教頭確認 → 校長決裁）が開始されます。最終決裁が完了するまで原申請の効力は維持されます。
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            disabled={actionLoading}
            className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={actionLoading || !newReason.trim()}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white rounded-lg text-xs font-bold shadow-sm transition flex items-center gap-1.5"
          >
            {actionLoading && <span className="animate-spin">⏳</span>}
            <span>修正して再提出する</span>
          </button>
        </div>
      </div>
    </div>
  );
};

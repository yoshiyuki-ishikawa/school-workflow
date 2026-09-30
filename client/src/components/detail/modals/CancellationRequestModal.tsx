import React, { useState, useEffect } from 'react';
import { RotateCcw } from 'lucide-react';

export interface CancellationRequestModalProps {
  isOpen: boolean;
  actionLoading?: boolean;
  onClose: () => void;
  onSubmit: (cancellationReason: string) => Promise<void>;
}

/**
 * CancellationRequestModal
 * 
 * 承認後取消の起案理由を収集する純粋Action Modal (GAP-01)。
 * 
 * 【Architecture Invariants】
 * 1. Client Authorization Replica = 0: 内部で取消起案資格判定を行わない。
 * 2. Intent Boundary: 入力された cancellationReason を onSubmit コールバックへ渡すのみ。
 * 3. Validation Semantics: 取消理由の入力必須（Trimチェック）。
 * 4. Reset on Close: モーダルを閉じた際は入力をリセット。
 */
export const CancellationRequestModal: React.FC<CancellationRequestModalProps> = ({
  isOpen,
  actionLoading = false,
  onClose,
  onSubmit,
}) => {
  const [cancellationReason, setCancellationReason] = useState('');

  useEffect(() => {
    if (isOpen) {
      setCancellationReason('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!cancellationReason.trim()) {
      alert('取消理由の記入は必須です');
      return;
    }
    await onSubmit(cancellationReason.trim());
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
          <RotateCcw className="w-5 h-5 text-rose-600" />
          <span>承認後取消の申請 (理由記入必須)</span>
        </h3>
        <p className="text-xs text-slate-600">
          決裁完了後の申請を取り消すためのワークフローを開始します。承認完了時に自動的に年休や服務台帳の原状復帰が行われます。
        </p>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            取消理由 <span className="text-rose-500">*</span>
          </label>
          <textarea
            rows={3}
            value={cancellationReason}
            onChange={(e) => setCancellationReason(e.target.value)}
            placeholder="公務予定変更・体調回復など、取消の具体的な理由を記入してください"
            className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-rose-500 focus:ring-rose-500"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            disabled={actionLoading}
            className="px-3.5 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={actionLoading}
            className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold shadow-sm transition"
          >
            {actionLoading ? '起案中...' : '取消を起案する'}
          </button>
        </div>
      </div>
    </div>
  );
};

import React, { useState, useEffect } from 'react';
import { CheckCircle, RotateCcw, XCircle } from 'lucide-react';

export interface CancellationActionModalProps {
  isOpen: boolean;
  actionType: 'approve' | 'return' | 'reject' | null;
  actionLoading?: boolean;
  onClose: () => void;
  onSubmit: (comment: string) => Promise<void>;
}

/**
 * CancellationActionModal
 * 
 * 取消承認・差戻し・却下実行時のコメント入力収集モーダル (GAP-01)。
 * 
 * 【Architecture Invariants】
 * 1. Client Authorization Replica = 0: 内部で承認権限判定を行わない。
 * 2. Intent Boundary: 入力された comment を onSubmit へ渡すのみ。
 * 3. Validation Semantics: approve時はコメント任意、return/reject時は必須。
 * 4. Reset on Close: モーダルを閉じた際は入力をリセット。
 */
export const CancellationActionModal: React.FC<CancellationActionModalProps> = ({
  isOpen,
  actionType,
  actionLoading = false,
  onClose,
  onSubmit,
}) => {
  const [commentText, setCommentText] = useState('');

  useEffect(() => {
    if (isOpen) {
      setCommentText('');
    }
  }, [isOpen, actionType]);

  if (!isOpen || !actionType) return null;

  const handleSubmit = async () => {
    if ((actionType === 'return' || actionType === 'reject') && !commentText.trim()) {
      alert('理由の記入は必須です');
      return;
    }
    await onSubmit(commentText.trim());
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
          {actionType === 'approve' && (
            <>
              <CheckCircle className="w-5 h-5 text-emerald-600" />
              <span>取消申出の承認・進達</span>
            </>
          )}
          {actionType === 'return' && (
            <>
              <RotateCcw className="w-5 h-5 text-rose-600" />
              <span>取消申請の差戻し</span>
            </>
          )}
          {actionType === 'reject' && (
            <>
              <XCircle className="w-5 h-5 text-red-600" />
              <span>取消申出への不同意（服務Factの維持）</span>
            </>
          )}
        </h3>

        {actionType === 'reject' && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1">
            <p className="font-bold">⚠️ 服務Fact維持の確認</p>
            <p>この取消申出に同意しない場合、元の承認状態（服務Fact・年休消化）がそのまま維持されます。</p>
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            コメント {actionType !== 'approve' && <span className="text-rose-500">*</span>}
          </label>
          <textarea
            rows={3}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder={actionType === 'approve' ? 'コメント（任意）' : '理由を具体的に記入してください（必須）'}
            className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
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
            {actionLoading ? '処理中...' : '実行する'}
          </button>
        </div>
      </div>
    </div>
  );
};

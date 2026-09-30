import React, { useState, useEffect } from 'react';
import { RotateCcw, XCircle, AlertTriangle } from 'lucide-react';

export interface ReturnOrRejectModalProps {
  isOpen: boolean;
  modalType: 'return' | 'reject' | null;
  actionLoading?: boolean;
  onClose: () => void;
  onSubmit: (comment: string) => Promise<void>;
}

/**
 * ReturnOrRejectModal
 * 
 * 申請の差戻し・却下時に必須となる理由コメントを収集する純粋Action Modal。
 * 
 * 【Architecture Invariants】
 * 1. Client Authorization Replica = 0: 内部で権限判定を行わない。
 * 2. Intent Boundary: 入力された comment を onSubmit コールバックへ渡すのみ（API直接実行禁止）。
 * 3. Validation Semantics: 理由の記入が空の場合は送信不可（Trim必須バリデーション）。
 * 4. Reset on Close: モーダルを閉じた際は入力をリセット。
 * 5. Irreversibility Safety: 却下（REJECT）時は不可逆警告と確認チェックを必須化。
 */
export const ReturnOrRejectModal: React.FC<ReturnOrRejectModalProps> = ({
  isOpen,
  modalType,
  actionLoading = false,
  onClose,
  onSubmit,
}) => {
  const [commentText, setCommentText] = useState('');
  const [isRejectConfirmed, setIsRejectConfirmed] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCommentText('');
      setIsRejectConfirmed(false);
    }
  }, [isOpen, modalType]);

  if (!isOpen || !modalType) return null;

  const isReject = modalType === 'reject';

  const handleSubmit = async () => {
    if (!commentText.trim()) {
      alert('理由の記入は必須です');
      return;
    }
    if (isReject && !isRejectConfirmed) {
      alert('却下の確認チェックを入れてください');
      return;
    }
    await onSubmit(commentText.trim());
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
          {!isReject ? (
            <>
              <RotateCcw className="w-5 h-5 text-amber-600" />
              <span>申請の差戻し (理由記入必須)</span>
            </>
          ) : (
            <>
              <XCircle className="w-5 h-5 text-red-600" />
              <span className="text-red-900">⚠️ 申請の却下 (不可逆・完全終了)</span>
            </>
          )}
        </h3>

        {!isReject ? (
          <p className="text-xs text-slate-600">
            申請者に内容の修正・再提出（RESUBMIT）を依頼します。差戻し理由は申請者に通知されます。
          </p>
        ) : (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 space-y-1.5">
            <div className="flex items-center gap-1.5 font-bold text-red-900">
              <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
              <span>この操作は取り消せません</span>
            </div>
            <p className="text-[11px] leading-relaxed">
              申請を却下するとこのワークフローは完全に終了し、申請者は本申請の修正・再提出ができなくなります（新規起案が必要となります）。
            </p>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            {!isReject ? '差戻し理由' : '却下理由'} <span className="text-red-500">*</span>
          </label>
          <textarea
            rows={3}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder={!isReject ? '差戻し・修正依頼の具体的な理由を記入してください' : '却下の具体的な理由を記入してください'}
            className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>

        {isReject && (
          <label className="flex items-start gap-2 p-2.5 bg-red-50/60 border border-red-200 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={isRejectConfirmed}
              onChange={(e) => setIsRejectConfirmed(e.target.checked)}
              className="mt-0.5 rounded text-red-600 focus:ring-red-500 border-slate-300"
            />
            <span className="text-xs font-semibold text-red-950">
              この申請を完全に却下し、再提出不可とすることを理解しました
            </span>
          </label>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
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
            disabled={actionLoading || (isReject && !isRejectConfirmed)}
            className={`px-4 py-1.5 text-white rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${
              !isReject
                ? 'bg-amber-600 hover:bg-amber-700'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {actionLoading ? '処理中...' : !isReject ? '差戻しを実行' : '却下を確定する'}
          </button>
        </div>
      </div>
    </div>
  );
};

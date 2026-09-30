import React, { useState } from 'react';
import { api } from '../services/api';
import { X, Calendar, PlusCircle, AlertCircle } from 'lucide-react';

interface Props {
  isOpen: boolean;
  caseId: number;
  caseInfoText: string;
  onClose: () => void;
  onSuccess: (newPeriodId: number) => void;
}

export const CarePeriodModal: React.FC<Props> = ({
  isOpen,
  caseId,
  caseInfoText,
  onClose,
  onSuccess,
}) => {
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 2); // 2か月後
    return d.toISOString().split('T')[0];
  });
  const [memo, setMemo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!startDate || !endDate) {
      setError('開始日と終了日は必須です');
      return;
    }
    if (startDate > endDate) {
      setError('開始日は終了日以前である必要があります');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const res = await api.addCarePeriod(caseId, {
        startDate,
        endDate,
        memo,
      });

      if (res.success) {
        onSuccess(res.periodId);
        onClose();
      } else {
        setError(res.message);
      }
    } catch (err: any) {
      setError(err.message || '指定期間の追加に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
        {/* ヘッダー */}
        <div className="px-6 py-4 bg-purple-700 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-purple-200" />
            <h2 className="text-base font-bold">指定期間の追加 (第2期/第3期)</h2>
          </div>
          <button
            onClick={onClose}
            className="text-purple-200 hover:text-white transition p-1 rounded-lg hover:bg-purple-600/50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* フォーム */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="p-3 bg-purple-50 rounded-lg text-xs text-purple-900 border border-purple-100">
            <p className="font-semibold mb-0.5">対象ケース:</p>
            <p className="text-slate-800 font-medium">{caseInfoText}</p>
            <p className="text-[11px] text-purple-700 mt-1">※ 指定期間は要介護者ごとに通算6か月以内、最大3回まで設定できます（条例第15条第1項）。</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                開始日 <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full text-xs border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                終了日 <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full text-xs border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">メモ・事由</label>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="例: 手術後の在宅復帰支援のため"
              className="w-full text-sm border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500"
            />
          </div>

          {/* フッター */}
          <div className="pt-4 border-t border-slate-200 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 transition"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-purple-700 hover:bg-purple-800 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow-xs"
            >
              <PlusCircle className="w-4 h-4" />
              <span>{loading ? '追加中...' : '指定期間を追加'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

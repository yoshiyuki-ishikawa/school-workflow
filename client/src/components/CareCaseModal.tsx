import React, { useState } from 'react';
import { api } from '../services/api';
import { X, Heart, PlusCircle, Calendar, AlertCircle } from 'lucide-react';

interface Props {
  isOpen: boolean;
  targetUserId?: number;
  onClose: () => void;
  onSuccess: (newCaseId: number, newPeriodId?: number) => void;
}

export const CareCaseModal: React.FC<Props> = ({
  isOpen,
  targetUserId,
  onClose,
  onSuccess,
}) => {
  const [recipientRelation, setRecipientRelation] = useState('実母');
  const [recipientName, setRecipientName] = useState('');
  const [conditionSummary, setConditionSummary] = useState('');
  const [careStartDate, setCareStartDate] = useState(new Date().toISOString().split('T')[0]);

  // 初期指定期間 (介護休暇用)
  const [includePeriod, setIncludePeriod] = useState(true);
  const [periodStartDate, setPeriodStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [periodEndDate, setPeriodEndDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 2); // 2か月後
    return d.toISOString().split('T')[0];
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipientRelation.trim() || !recipientName.trim() || !conditionSummary.trim()) {
      setError('続柄・対象者氏名・介護事由は必須です');
      return;
    }

    if (includePeriod && periodStartDate > periodEndDate) {
      setError('指定期間の開始日は終了日以前である必要があります');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const res = await api.createCareCase({
        targetUserId,
        recipientRelation,
        recipientName,
        conditionSummary,
        careStartDate,
        initialPeriod: includePeriod ? {
          startDate: periodStartDate,
          endDate: periodEndDate,
        } : undefined,
      });

      if (res.success) {
        onSuccess(res.caseId, res.periodId);
        onClose();
      } else {
        setError(res.message);
      }
    } catch (err: any) {
      setError(err.message || '登録に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
        {/* ヘッダー */}
        <div className="px-6 py-4 bg-purple-700 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Heart className="w-5 h-5 text-purple-200" />
            <h2 className="text-base font-bold">介護対象家族・指定期間の新規登録</h2>
          </div>
          <button
            onClick={onClose}
            className="text-purple-200 hover:text-white transition p-1 rounded-lg hover:bg-purple-600/50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* フォーム本体 */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="p-3 bg-purple-50 rounded-lg text-xs text-purple-900 leading-relaxed border border-purple-100">
            <p className="font-semibold">【条例第15条・第16条に基づく介護登録】</p>
            <p>介護休暇（通算6か月・最大3回）および介護時間（連続3年・1日2時間）の対象となる家族情報を登録します。</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                続柄 <span className="text-red-500">*</span>
              </label>
              <select
                value={recipientRelation}
                onChange={(e) => setRecipientRelation(e.target.value)}
                className="w-full text-sm border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500"
              >
                <option value="実母">実母</option>
                <option value="実父">実父</option>
                <option value="配偶者">配偶者</option>
                <option value="子">子</option>
                <option value="配偶者の実母">配偶者の実母</option>
                <option value="配偶者の実父">配偶者の実父</option>
                <option value="祖母">祖母（同居）</option>
                <option value="祖父">祖父（同居）</option>
                <option value="兄弟姉妹">兄弟姉妹</option>
                <option value="その他親族">その他親族</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                対象者氏名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                placeholder="例: 山田 花子"
                className="w-full text-sm border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              介護開始日 (連続3年の起算日)
            </label>
            <input
              type="date"
              value={careStartDate}
              onChange={(e) => setCareStartDate(e.target.value)}
              className="w-full text-sm border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              要介護状態・状況の概要 <span className="text-red-500">*</span>
            </label>
            <textarea
              rows={2}
              value={conditionSummary}
              onChange={(e) => setConditionSummary(e.target.value)}
              placeholder="例: 要介護3。通院付添・食事介助およびデイサービス送迎対応のため"
              className="w-full text-sm border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500"
            />
          </div>

          {/* 指定期間登録セクション (介護休暇用) */}
          <div className="pt-3 border-t border-slate-200">
            <label className="flex items-center gap-2 cursor-pointer mb-2">
              <input
                type="checkbox"
                checked={includePeriod}
                onChange={(e) => setIncludePeriod(e.target.checked)}
                className="text-purple-600 rounded focus:ring-purple-500"
              />
              <span className="text-xs font-bold text-slate-800">
                初回の「指定期間（第1期）」も同時に登録する (介護休暇を利用する場合)
              </span>
            </label>

            {includePeriod && (
              <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    指定期間 開始日
                  </label>
                  <input
                    type="date"
                    value={periodStartDate}
                    onChange={(e) => setPeriodStartDate(e.target.value)}
                    className="w-full text-xs border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500 bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    指定期間 終了日
                  </label>
                  <input
                    type="date"
                    value={periodEndDate}
                    onChange={(e) => setPeriodEndDate(e.target.value)}
                    className="w-full text-xs border-slate-300 rounded-md shadow-xs focus:border-purple-500 focus:ring-purple-500 bg-white"
                  />
                </div>
              </div>
            )}
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
              <span>{loading ? '登録中...' : '介護家族情報を登録'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

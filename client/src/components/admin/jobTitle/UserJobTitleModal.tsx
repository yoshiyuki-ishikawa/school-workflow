import React, { useState, useEffect } from 'react';
import { api } from '../../../services/api';
import { OfficialJobTitle, UserJobTitleAssignment, User } from '../../../types';
import { PlusCircle, Calendar, Trash2, Edit2, AlertCircle, CheckCircle2, History } from 'lucide-react';

interface Props {
  user: User;
  onClose: () => void;
  onUpdated?: () => void;
}

export const UserJobTitleModal: React.FC<Props> = ({ user, onClose, onUpdated }) => {
  const [history, setHistory] = useState<UserJobTitleAssignment[]>([]);
  const [current, setCurrent] = useState<UserJobTitleAssignment | null>(null);
  const [jobTitles, setJobTitles] = useState<OfficialJobTitle[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 新規発令フォーム状態
  const [isAdding, setIsAdding] = useState<boolean>(false);
  const [formData, setFormData] = useState<{
    jobTitleId: string;
    effectiveFrom: string;
    effectiveTo: string;
    notes: string;
  }>({
    jobTitleId: '',
    effectiveFrom: new Date().toISOString().split('T')[0],
    effectiveTo: '9999-12-31',
    notes: '',
  });

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [historyRes, titlesRes] = await Promise.all([
        api.getUserJobTitles(user.id),
        api.getOfficialJobTitles({ activeOnly: true }),
      ]);

      if (historyRes.success) {
        setHistory(historyRes.history || []);
        setCurrent(historyRes.current || null);
      }

      if (titlesRes.success && titlesRes.jobTitles) {
        setJobTitles(titlesRes.jobTitles);
        if (!formData.jobTitleId && titlesRes.jobTitles.length > 0) {
          setFormData((prev) => ({ ...prev, jobTitleId: titlesRes.jobTitles[0].id }));
        }
      }
    } catch (err: any) {
      setError(err.message || '職名発令履歴の取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user.id]);

  const handleCreateAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    try {
      await api.assignUserJobTitle(user.id, {
        jobTitleId: formData.jobTitleId,
        effectiveFrom: formData.effectiveFrom,
        effectiveTo: formData.effectiveTo || '9999-12-31',
        notes: formData.notes,
      });

      setSuccessMessage('職名発令を正常に登録しました');
      setIsAdding(false);
      setFormData({
        jobTitleId: jobTitles.length > 0 ? jobTitles[0].id : '',
        effectiveFrom: new Date().toISOString().split('T')[0],
        effectiveTo: '9999-12-31',
        notes: '',
      });
      await loadData();
      if (onUpdated) onUpdated();
    } catch (err: any) {
      setError(err.message || '発令登録に失敗しました (期間重複等の可能性があります)');
    }
  };

  const handleDeleteAssignment = async (assignment: UserJobTitleAssignment) => {
    if (!confirm(`発令期間「${assignment.effective_from} 〜 ${assignment.effective_to}」の職名「${assignment.job_title_display_name}」履歴を削除しますか？`)) {
      return;
    }
    setError(null);
    setSuccessMessage(null);

    try {
      await api.deleteUserJobTitle(user.id, assignment.id);
      setSuccessMessage('職名発令履歴を削除しました');
      await loadData();
      if (onUpdated) onUpdated();
    } catch (err: any) {
      setError(err.message || '削除に失敗しました');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-2xl w-full shadow-2xl overflow-hidden border border-slate-200 animate-fadeIn">
        {/* ヘッダー */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-indigo-600" />
            <h3 className="font-bold text-slate-800">
              正式職名 人事発令履歴管理: <span className="text-indigo-600">{user.displayName}</span> (#{user.id})
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 font-bold p-1">
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
          {/* 現在の職名カード */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between">
            <div>
              <span className="text-xs font-bold text-slate-500 block uppercase tracking-wider">現在有効な正式職名 (本日基準)</span>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xl font-bold text-slate-900">
                  {current ? current.job_title_display_name : '（未発令・未登録）'}
                </span>
                {current ? (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                    発令中 ({current.effective_from} 〜 {current.effective_to === '9999-12-31' ? '無期限' : current.effective_to})
                  </span>
                ) : (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded bg-rose-50 text-rose-700 border border-rose-200">
                    要登録 (帳票出力停止)
                  </span>
                )}
              </div>
            </div>
            {!isAdding && (
              <button
                onClick={() => setIsAdding(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
              >
                <PlusCircle className="w-4 h-4" />
                <span>新規辞令・異動発令</span>
              </button>
            )}
          </div>

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMessage && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* 新規発令フォーム */}
          {isAdding && (
            <form onSubmit={handleCreateAssignment} className="bg-indigo-50/50 border border-indigo-200 rounded-xl p-4 space-y-4">
              <div className="font-bold text-xs text-indigo-900 flex items-center justify-between border-b border-indigo-100 pb-2">
                <span>新しい職名の人事発令を登録 (辞令交付)</span>
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="text-slate-400 hover:text-slate-600 text-xs"
                >
                  キャンセル
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    発令職名 <span className="text-rose-500">*</span>
                  </label>
                  <select
                    required
                    value={formData.jobTitleId}
                    onChange={(e) => setFormData({ ...formData, jobTitleId: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-bold focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  >
                    {jobTitles.map((title) => (
                      <option key={title.id} value={title.id}>
                        {title.display_name} ({title.code})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    発令開始年月日 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={formData.effectiveFrom}
                    onChange={(e) => setFormData({ ...formData, effectiveFrom: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    発令終了年月日
                  </label>
                  <input
                    type="date"
                    value={formData.effectiveTo === '9999-12-31' ? '' : formData.effectiveTo}
                    placeholder="未指定時は無期限"
                    onChange={(e) => setFormData({ ...formData, effectiveTo: e.target.value || '9999-12-31' })}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">発令備考・辞令番号 (任意)</label>
                <input
                  type="text"
                  placeholder="例: 山口県教育委員会 令和8年4月1日付定期人事異動 (教職第123号)"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-indigo-100">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-sm"
                >
                  発令を確定・登録
                </button>
              </div>
            </form>
          )}

          {/* 履歴テーブル */}
          <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <div className="p-3 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700 flex justify-between">
              <span>職名発令履歴タイムライン ({history.length}件)</span>
              <span className="text-[11px] text-slate-400">期間重複はシステムがFail-Closedに遮断します</span>
            </div>
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">有効期間</th>
                  <th className="px-4 py-2.5 text-left font-semibold">職名</th>
                  <th className="px-4 py-2.5 text-left font-semibold">コード</th>
                  <th className="px-4 py-2.5 text-left font-semibold">発令事由・備考</th>
                  <th className="px-4 py-2.5 text-right font-semibold">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                      職名発令履歴が登録されていません。「新規辞令・異動発令」から登録してください。
                    </td>
                  </tr>
                ) : (
                  history.map((assignment) => {
                    const isCurrent = current?.id === assignment.id;
                    return (
                      <tr key={assignment.id} className={isCurrent ? 'bg-indigo-50/30 font-medium' : 'hover:bg-slate-50'}>
                        <td className="px-4 py-2.5 font-mono text-slate-700">
                          <div className="flex items-center gap-1.5">
                            <Calendar className="w-3 h-3 text-slate-400" />
                            <span>{assignment.effective_from} 〜 {assignment.effective_to === '9999-12-31' ? '無期限' : assignment.effective_to}</span>
                            {isCurrent && (
                              <span className="ml-1 px-1.5 py-0.2 text-[10px] bg-indigo-100 text-indigo-700 rounded font-bold">
                                現在
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 font-bold text-slate-900 text-sm">{assignment.job_title_display_name}</td>
                        <td className="px-4 py-2.5 font-mono text-slate-500">{assignment.job_title_code}</td>
                        <td className="px-4 py-2.5 text-slate-500 text-[11px] max-w-xs truncate">{assignment.notes || '-'}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => handleDeleteAssignment(assignment)}
                            className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition"
                            title="発令履歴を削除"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};

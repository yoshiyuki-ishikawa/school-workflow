import React, { useState, useEffect } from 'react';
import { BookOpen, Plus, Trash2 } from 'lucide-react';
import { ClassCoverageItem, ClassCoverageStatus, ClassCoverageType } from '../../../types/formSchema';
import { COVERAGE_TYPE_LABELS } from '../../../utils/coverageAdapter';
import { User } from '../../../types';

export interface ClassCoverageModalProps {
  isOpen: boolean;
  initialCoverageStatus?: ClassCoverageStatus;
  initialNotRequiredReason?: string;
  initialCoverageItems?: ClassCoverageItem[];
  defaultDate?: string;
  members?: User[];
  actionLoading?: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    coverageStatus: ClassCoverageStatus;
    notRequiredReason?: string;
    coverageItems: ClassCoverageItem[];
  }) => Promise<void>;
}

/**
 * ClassCoverageModal
 * 
 * 授業措置（引継ぎ・代替・自習監督）の確定・変更モーダル (GAP-09)。
 * 
 * 【Architecture Invariants】
 * 1. Client Authorization Replica = 0: 内部で認可判定を行わない（親から開かれた時のみ描画）。
 * 2. Intent Boundary: 収集した明細・ステータスを onSubmit に渡すのみ。
 * 3. Validation Semantics: REQUIRED選択時は1件以上の明細行が必須。
 */
export const ClassCoverageModal: React.FC<ClassCoverageModalProps> = ({
  isOpen,
  initialCoverageStatus = 'REQUIRED',
  initialNotRequiredReason = '',
  initialCoverageItems = [],
  defaultDate = '',
  members = [],
  actionLoading = false,
  onClose,
  onSubmit,
}) => {
  const [modalCoverageStatus, setModalCoverageStatus] = useState<ClassCoverageStatus>('REQUIRED');
  const [modalNotRequiredReason, setModalNotRequiredReason] = useState('');
  const [modalCoverageItems, setModalCoverageItems] = useState<ClassCoverageItem[]>([]);

  useEffect(() => {
    if (isOpen) {
      setModalCoverageStatus(initialCoverageStatus);
      setModalNotRequiredReason(initialNotRequiredReason);
      setModalCoverageItems(
        initialCoverageItems.length > 0
          ? initialCoverageItems
          : [
              {
                id: 'cov_1',
                targetDate: defaultDate,
                period: '1',
                coverageType: 'SUBSTITUTE_LESSON',
                subjectName: '',
                contentNotes: '',
              },
            ]
      );
    }
  }, [isOpen, initialCoverageStatus, initialNotRequiredReason, initialCoverageItems, defaultDate]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (modalCoverageStatus === 'REQUIRED' && modalCoverageItems.length === 0) {
      alert('授業措置が必要な場合は1件以上の明細行を入力してください');
      return;
    }

    await onSubmit({
      coverageStatus: modalCoverageStatus,
      notRequiredReason: modalCoverageStatus === 'NOT_REQUIRED' ? modalNotRequiredReason : undefined,
      coverageItems: modalCoverageStatus === 'REQUIRED' ? modalCoverageItems : [],
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b pb-3 border-slate-200">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
            <BookOpen className="w-5 h-5 text-indigo-600" />
            <span>授業引継ぎ・代替措置の確定・変更</span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-sm font-bold"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label
              className={`flex items-start gap-2 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                modalCoverageStatus === 'NOT_REQUIRED'
                  ? 'bg-indigo-50 border-indigo-600 shadow-sm'
                  : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name="modalCoverageStatus"
                value="NOT_REQUIRED"
                checked={modalCoverageStatus === 'NOT_REQUIRED'}
                onChange={() => setModalCoverageStatus('NOT_REQUIRED')}
                className="mt-0.5 text-indigo-600 focus:ring-indigo-500"
              />
              <div>
                <div className="font-bold text-slate-800">措置不要</div>
                <div className="text-[11px] text-slate-500">授業なし / 放課後等</div>
              </div>
            </label>

            <label
              className={`flex items-start gap-2 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                modalCoverageStatus === 'REQUIRED'
                  ? 'bg-indigo-50 border-indigo-600 shadow-sm'
                  : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name="modalCoverageStatus"
                value="REQUIRED"
                checked={modalCoverageStatus === 'REQUIRED'}
                onChange={() => {
                  setModalCoverageStatus('REQUIRED');
                  if (modalCoverageItems.length === 0) {
                    setModalCoverageItems([
                      {
                        id: 'cov_1',
                        targetDate: defaultDate,
                        period: '1',
                        coverageType: 'SUBSTITUTE_LESSON',
                        subjectName: '',
                        contentNotes: '',
                      },
                    ]);
                  }
                }}
                className="mt-0.5 text-indigo-600 focus:ring-indigo-500"
              />
              <div>
                <div className="font-bold text-slate-800">措置が必要</div>
                <div className="text-[11px] text-slate-500">自習・代替等あり</div>
              </div>
            </label>

            <label
              className={`flex items-start gap-2 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                modalCoverageStatus === 'UNSURE'
                  ? 'bg-amber-50 border-amber-600 shadow-sm'
                  : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name="modalCoverageStatus"
                value="UNSURE"
                checked={modalCoverageStatus === 'UNSURE'}
                onChange={() => setModalCoverageStatus('UNSURE')}
                className="mt-0.5 text-amber-600 focus:ring-amber-500"
              />
              <div>
                <div className="font-bold text-amber-900">確認中 (保留)</div>
                <div className="text-[11px] text-amber-700">教務・管理職確認中</div>
              </div>
            </label>
          </div>

          {modalCoverageStatus === 'NOT_REQUIRED' && (
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                措置不要の理由（任意）
              </label>
              <input
                type="text"
                value={modalNotRequiredReason}
                onChange={(e) => setModalNotRequiredReason(e.target.value)}
                placeholder="例: 当該時間帯に授業なし"
                className="w-full text-xs border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
          )}

          {modalCoverageStatus === 'REQUIRED' && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">授業代替措置 明細 (1件以上)</span>
                <button
                  type="button"
                  onClick={() => {
                    setModalCoverageItems([
                      ...modalCoverageItems,
                      {
                        id: `cov_${modalCoverageItems.length + 1}`,
                        targetDate: defaultDate,
                        period: String(modalCoverageItems.length + 1),
                        coverageType: 'SUBSTITUTE_LESSON',
                        subjectName: '',
                        contentNotes: '',
                      },
                    ]);
                  }}
                  className="px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[11px] font-semibold flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> 行を追加
                </button>
              </div>

              <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-200 text-slate-700 font-semibold">
                      <th className="p-1.5 w-28">対象日</th>
                      <th className="p-1.5 w-16">校時</th>
                      <th className="p-1.5 w-32">措置種別</th>
                      <th className="p-1.5 w-36">担当教員</th>
                      <th className="p-1.5 w-20">教科</th>
                      <th className="p-1.5">内容・備考</th>
                      <th className="p-1.5 w-8 text-center">削除</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {modalCoverageItems.map((item, idx) => (
                      <tr key={item.id || idx}>
                        <td className="p-1">
                          <input
                            type="date"
                            value={item.targetDate}
                            onChange={(e) => {
                              const n = [...modalCoverageItems];
                              n[idx] = { ...n[idx], targetDate: e.target.value };
                              setModalCoverageItems(n);
                            }}
                            className="w-full text-xs p-1 border-slate-300 rounded"
                          />
                        </td>
                        <td className="p-1">
                          <input
                            type="text"
                            value={item.period}
                            onChange={(e) => {
                              const n = [...modalCoverageItems];
                              n[idx] = { ...n[idx], period: e.target.value };
                              setModalCoverageItems(n);
                            }}
                            className="w-full text-xs p-1 border-slate-300 rounded"
                          />
                        </td>
                        <td className="p-1">
                          <select
                            value={item.coverageType}
                            onChange={(e) => {
                              const n = [...modalCoverageItems];
                              n[idx] = { ...n[idx], coverageType: e.target.value as ClassCoverageType };
                              setModalCoverageItems(n);
                            }}
                            className="w-full text-xs p-1 border-slate-300 rounded"
                          >
                            <option value="SUBSTITUTE_LESSON">{COVERAGE_TYPE_LABELS.SUBSTITUTE_LESSON}</option>
                            <option value="SELF_STUDY_SUPERVISION">{COVERAGE_TYPE_LABELS.SELF_STUDY_SUPERVISION}</option>
                            <option value="TIMETABLE_EXCHANGE">{COVERAGE_TYPE_LABELS.TIMETABLE_EXCHANGE}</option>
                            <option value="COMBINED_CLASS">{COVERAGE_TYPE_LABELS.COMBINED_CLASS}</option>
                            <option value="OTHER">{COVERAGE_TYPE_LABELS.OTHER}</option>
                          </select>
                        </td>
                        <td className="p-1">
                          <select
                            value={item.substituteUserId || ''}
                            onChange={(e) => {
                              const val = e.target.value ? Number(e.target.value) : undefined;
                              const member = members.find((m) => m.id === val);
                              const n = [...modalCoverageItems];
                              n[idx] = {
                                ...n[idx],
                                substituteUserId: val,
                                substituteUserNameSnapshot: member?.displayName,
                                substituteUserDeptSnapshot: member?.department,
                              };
                              setModalCoverageItems(n);
                            }}
                            className="w-full text-xs p-1 border-slate-300 rounded"
                          >
                            <option value="">-- 教員 --</option>
                            {members.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.displayName}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="p-1">
                          <input
                            type="text"
                            value={item.subjectName || ''}
                            onChange={(e) => {
                              const n = [...modalCoverageItems];
                              n[idx] = { ...n[idx], subjectName: e.target.value };
                              setModalCoverageItems(n);
                            }}
                            placeholder="教科"
                            className="w-full text-xs p-1 border-slate-300 rounded"
                          />
                        </td>
                        <td className="p-1">
                          <input
                            type="text"
                            value={item.contentNotes || ''}
                            onChange={(e) => {
                              const n = [...modalCoverageItems];
                              n[idx] = { ...n[idx], contentNotes: e.target.value };
                              setModalCoverageItems(n);
                            }}
                            placeholder="自習課題等"
                            className="w-full text-xs p-1 border-slate-300 rounded"
                          />
                        </td>
                        <td className="p-1 text-center">
                          <button
                            type="button"
                            onClick={() => {
                              if (modalCoverageItems.length > 1) {
                                setModalCoverageItems(modalCoverageItems.filter((_, i) => i !== idx));
                              }
                            }}
                            disabled={modalCoverageItems.length <= 1}
                            className={`p-1 rounded ${
                              modalCoverageItems.length <= 1
                                ? 'text-slate-300 cursor-not-allowed'
                                : 'text-rose-500 hover:bg-rose-50'
                            }`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
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
            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-sm transition"
          >
            {actionLoading ? '保存中...' : '確定・保存する'}
          </button>
        </div>
      </div>
    </div>
  );
};

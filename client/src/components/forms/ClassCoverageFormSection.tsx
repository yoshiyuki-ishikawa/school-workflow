import React from 'react';
import { ClassCoverageDomainState } from '../../types/formState';
import { ClassCoverageItem, ClassCoverageStatus, ClassCoverageType } from '../../types/formSchema';
import { COVERAGE_TYPE_LABELS } from '../../utils/coverageAdapter';
import { Users, AlertCircle, Plus, Trash2 } from 'lucide-react';

export interface ClassCoverageFormSectionProps {
  sectionId: string;
  state: ClassCoverageDomainState;
  onChange: (updater: (prev: ClassCoverageDomainState) => ClassCoverageDomainState) => void;
  members?: any[];
  defaultTargetDate?: string;
  disabled?: boolean;
}

export const ClassCoverageFormSection: React.FC<ClassCoverageFormSectionProps> = ({
  state,
  onChange,
  members = [],
  defaultTargetDate = new Date().toISOString().split('T')[0],
  disabled = false,
}) => {
  const handleAddRow = () => {
    const newItem: ClassCoverageItem = {
      targetDate: defaultTargetDate,
      period: '1校時',
      coverageType: 'SUBSTITUTE_LESSON',
      substituteUserId: undefined,
      subjectName: '',
      contentNotes: '',
    };
    onChange((prev) => ({
      ...prev,
      coverageItems: [...prev.coverageItems, newItem],
    }));
  };

  const handleUpdateItem = (index: number, updates: Partial<ClassCoverageItem>) => {
    onChange((prev) => {
      const updated = [...prev.coverageItems];
      updated[index] = { ...updated[index], ...updates };
      return { ...prev, coverageItems: updated };
    });
  };

  const handleRemoveItem = (index: number) => {
    onChange((prev) => ({
      ...prev,
      coverageItems: prev.coverageItems.filter((_, i) => i !== index),
    }));
  };

  return (
    <div className="space-y-4 p-4 bg-emerald-50/70 border border-emerald-200 rounded-xl">
      <div className="flex items-center justify-between border-b border-emerald-200 pb-2">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-700" />
          <h3 className="text-sm font-bold text-emerald-950">授業等の引継ぎ・自習措置</h3>
        </div>
        <span className="text-[11px] text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded font-medium">
          学校事務標準
        </span>
      </div>

      {/* 3-State ラジオ */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex items-center gap-2 p-3 bg-white border border-emerald-200 rounded-lg cursor-pointer hover:bg-emerald-50/50">
          <input
            type="radio"
            name="coverageStatus"
            value="NOT_REQUIRED"
            checked={state.coverageStatus === 'NOT_REQUIRED'}
            onChange={() =>
              onChange((prev) => ({ ...prev, coverageStatus: 'NOT_REQUIRED', notRequiredReason: '' }))
            }
            disabled={disabled}
            className="text-emerald-600 focus:ring-emerald-500"
          />
          <span className="text-xs font-semibold text-emerald-950">措置不要（授業なし等）</span>
        </label>

        <label className="flex items-center gap-2 p-3 bg-white border border-emerald-200 rounded-lg cursor-pointer hover:bg-emerald-50/50">
          <input
            type="radio"
            name="coverageStatus"
            value="REQUIRED"
            checked={state.coverageStatus === 'REQUIRED'}
            onChange={() =>
              onChange((prev) => ({ ...prev, coverageStatus: 'REQUIRED' }))
            }
            disabled={disabled}
            className="text-emerald-600 focus:ring-emerald-500"
          />
          <span className="text-xs font-semibold text-emerald-950">措置が必要（補欠・自習等）</span>
        </label>

        <label className="flex items-center gap-2 p-3 bg-white border border-emerald-200 rounded-lg cursor-pointer hover:bg-emerald-50/50">
          <input
            type="radio"
            name="coverageStatus"
            value="UNSURE"
            checked={state.coverageStatus === 'UNSURE'}
            onChange={() =>
              onChange((prev) => ({ ...prev, coverageStatus: 'UNSURE' }))
            }
            disabled={disabled}
            className="text-emerald-600 focus:ring-emerald-500"
          />
          <span className="text-xs font-semibold text-emerald-950">確認中・未定</span>
        </label>
      </div>

      {/* 措置不要の理由 */}
      {state.coverageStatus === 'NOT_REQUIRED' && (
        <div>
          <label className="block text-xs font-semibold text-emerald-900 mb-1">
            措置不要の理由 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={state.notRequiredReason || ''}
            onChange={(e) =>
              onChange((prev) => ({ ...prev, notRequiredReason: e.target.value }))
            }
            placeholder="例: 長期休業期間中、担任外で持ちコマなし"
            disabled={disabled}
            className="w-full text-sm border-emerald-300 rounded-md shadow-sm focus:border-emerald-500 focus:ring-emerald-500 bg-white disabled:bg-slate-100"
          />
        </div>
      )}

      {/* 措置が必要な場合の明細テーブル */}
      {state.coverageStatus === 'REQUIRED' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-emerald-900">引継ぎ明細</span>
            <button
              type="button"
              onClick={handleAddRow}
              disabled={disabled}
              className="text-xs bg-emerald-600 text-white px-2.5 py-1 rounded-md font-medium hover:bg-emerald-700 flex items-center gap-1 disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>行を追加</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-xs divide-y divide-emerald-200 bg-white rounded-lg overflow-hidden border border-emerald-200">
              <thead className="bg-emerald-100/70 text-emerald-950">
                <tr>
                  <th className="px-2 py-1.5 text-left">対象日</th>
                  <th className="px-2 py-1.5 text-left">校時</th>
                  <th className="px-2 py-1.5 text-left">措置種別</th>
                  <th className="px-2 py-1.5 text-left">代替教員</th>
                  <th className="px-2 py-1.5 text-left">教科/内容</th>
                  <th className="px-2 py-1.5 text-center w-10">削除</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-100">
                {state.coverageItems.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                      「行を追加」ボタンから授業引継ぎ明細を登録してください。
                    </td>
                  </tr>
                )}
                {state.coverageItems.map((item, idx) => (
                  <tr key={idx}>
                    <td className="p-1">
                      <input
                        type="date"
                        value={item.targetDate}
                        onChange={(e) => handleUpdateItem(idx, { targetDate: e.target.value })}
                        disabled={disabled}
                        className="w-full border-slate-300 rounded p-1 text-xs"
                      />
                    </td>
                    <td className="p-1">
                      <select
                        value={item.period}
                        onChange={(e) => handleUpdateItem(idx, { period: e.target.value })}
                        disabled={disabled}
                        className="w-full border-slate-300 rounded p-1 text-xs"
                      >
                        <option value="1校時">1校時</option>
                        <option value="2校時">2校時</option>
                        <option value="3校時">3校時</option>
                        <option value="4校時">4校時</option>
                        <option value="5校時">5校時</option>
                        <option value="6校時">6校時</option>
                        <option value="給食・清掃">給食・清掃</option>
                        <option value="終日">終日</option>
                      </select>
                    </td>
                    <td className="p-1">
                      <select
                        value={item.coverageType}
                        onChange={(e) =>
                          handleUpdateItem(idx, { coverageType: e.target.value as ClassCoverageType })
                        }
                        disabled={disabled}
                        className="w-full border-slate-300 rounded p-1 text-xs"
                      >
                        {Object.entries(COVERAGE_TYPE_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-1">
                      <select
                        value={item.substituteUserId || ''}
                        onChange={(e) =>
                          handleUpdateItem(idx, {
                            substituteUserId: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                        disabled={disabled}
                        className="w-full border-slate-300 rounded p-1 text-xs"
                      >
                        <option value="">（未定・自習）</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({m.role})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-1">
                      <input
                        type="text"
                        value={item.subjectName || ''}
                        onChange={(e) => handleUpdateItem(idx, { subjectName: e.target.value })}
                        placeholder="例: 算数 プリント演習"
                        disabled={disabled}
                        className="w-full border-slate-300 rounded p-1 text-xs"
                      />
                    </td>
                    <td className="p-1 text-center">
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(idx)}
                        disabled={disabled}
                        className="text-red-500 hover:text-red-700 p-1 rounded"
                      >
                        <Trash2 className="w-4 h-4" />
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
  );
};

import React from 'react';
import { CareDomainState } from '../../types/formState';
import { Plus } from 'lucide-react';

export interface CareFormSectionProps {
  sectionId: string;
  state: CareDomainState;
  onChange: (updater: (prev: CareDomainState) => CareDomainState) => void;
  careCases?: any[];
  carePeriods?: any[];
  onOpenCareCaseModal?: () => void;
  onOpenCarePeriodModal?: () => void;
  disabled?: boolean;
}

export const CareFormSection: React.FC<CareFormSectionProps> = ({
  state,
  onChange,
  careCases = [],
  carePeriods = [],
  onOpenCareCaseModal,
  onOpenCarePeriodModal,
  disabled = false,
}) => {
  return (
    <div className="space-y-4 p-4 bg-purple-50/70 rounded-xl border border-purple-200">
      <div className="text-xs font-bold text-purple-950 flex items-center justify-between border-b border-purple-200 pb-2">
        <span>【介護関連情報】要介護者の介護（条例第15条・第16条）</span>
      </div>

      {/* 介護ケース選択 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs font-semibold text-purple-900">
            介護対象家族 (ケース) <span className="text-red-500">*</span>
          </label>
          {onOpenCareCaseModal && (
            <button
              type="button"
              onClick={onOpenCareCaseModal}
              disabled={disabled}
              className="text-[11px] text-purple-700 hover:text-purple-900 font-bold flex items-center gap-0.5 hover:underline disabled:opacity-50"
            >
              <Plus className="w-3 h-3" />
              <span>新規登録</span>
            </button>
          )}
        </div>
        <select
          value={state.careCaseId || ''}
          onChange={(e) =>
            onChange((prev) => ({
              ...prev,
              careCaseId: e.target.value ? Number(e.target.value) : '',
            }))
          }
          disabled={disabled}
          className="w-full text-sm border-purple-300 rounded-md shadow-sm focus:border-purple-500 focus:ring-purple-500 bg-white disabled:bg-slate-100"
        >
          {careCases.length === 0 && <option value="">（登録済みの介護ケースがありません）</option>}
          {careCases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.recipient_relation}: {c.recipient_name} ({c.condition_summary})
            </option>
          ))}
        </select>
      </div>

      {/* 指定期間選択 */}
      {onOpenCarePeriodModal && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-semibold text-purple-900">
              通算指定期間 (通算93日枠)
            </label>
            <button
              type="button"
              onClick={onOpenCarePeriodModal}
              disabled={disabled || !state.careCaseId}
              className="text-[11px] text-purple-700 hover:text-purple-900 font-bold flex items-center gap-0.5 hover:underline disabled:opacity-50"
            >
              <Plus className="w-3 h-3" />
              <span>期間枠の追加</span>
            </button>
          </div>
          <select
            value={state.carePeriodId || ''}
            onChange={(e) =>
              onChange((prev) => ({
                ...prev,
                carePeriodId: e.target.value ? Number(e.target.value) : '',
              }))
            }
            disabled={disabled || !state.careCaseId}
            className="w-full text-sm border-purple-300 rounded-md shadow-sm focus:border-purple-500 focus:ring-purple-500 bg-white disabled:bg-slate-100"
          >
            <option value="">（指定期間を選択してください）</option>
            {carePeriods.map((p) => (
              <option key={p.id} value={p.id}>
                第{p.period_number}期: {p.start_date} 〜 {p.end_date} (残{p.remaining_days}日)
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
};

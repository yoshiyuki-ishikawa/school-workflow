import React from 'react';
import { WorkflowPolicyStep } from '../../../types';
import { PlusCircle, Trash2, ArrowUp, ArrowDown, ShieldAlert } from 'lucide-react';

interface PositionOption {
  id: string;
  name: string;
  rankOrder?: number;
  holderType?: string;
}

interface Props {
  steps: WorkflowPolicyStep[];
  onChange: (steps: WorkflowPolicyStep[]) => void;
  availablePositions: PositionOption[];
}

export const WorkflowStepEditor: React.FC<Props> = ({ steps, onChange, availablePositions }) => {
  const handleAddStep = () => {
    const nextOrder = steps.length + 1;
    const defaultPos = availablePositions.find((p) => p.id === 'VICE_PRINCIPAL_1') || availablePositions[0] || { id: 'VICE_PRINCIPAL_1', name: '教頭' };
    const newStep: WorkflowPolicyStep = {
      stepOrder: nextOrder,
      stepName: `第${nextOrder}段階 確認`,
      stepKey: `STEP_${nextOrder}`,
      actionType: 'APPROVE',
      requiredRoleId: 'VICE_PRINCIPAL',
      selectorType: 'POSITION',
      selectorValue: defaultPos.id,
      isFinalDecisionStep: false,
    };
    onChange([...steps, newStep]);
  };

  const handleRemoveStep = (index: number) => {
    const updated = steps
      .filter((_, i) => i !== index)
      .map((s, i) => ({ ...s, stepOrder: i + 1, stepKey: `STEP_${i + 1}` }));
    onChange(updated);
  };

  const handleMoveStep = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= steps.length) return;
    const updated = [...steps];
    const temp = updated[index];
    updated[index] = updated[targetIndex];
    updated[targetIndex] = temp;
    const reindexed = updated.map((s, i) => ({ ...s, stepOrder: i + 1, stepKey: `STEP_${i + 1}` }));
    onChange(reindexed);
  };

  const handleUpdateStep = (index: number, patch: Partial<WorkflowPolicyStep>) => {
    const updated = [...steps];
    updated[index] = { ...updated[index], ...patch };
    onChange(updated);
  };

  const handleSetFinalDecision = (index: number) => {
    const updated = steps.map((s, i) => ({
      ...s,
      isFinalDecisionStep: i === index,
      actionType: i === index ? ('DECIDE' as const) : s.actionType === 'DECIDE' ? ('APPROVE' as const) : s.actionType,
    }));
    onChange(updated);
  };

  const finalCount = steps.filter((s) => s.isFinalDecisionStep).length;

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div>
          <label className="block font-bold text-slate-800 text-xs">承認ステップ構成 (1..N 連番・順序厳守)</label>
          <span className="text-[10px] text-slate-500">
            単一責任者SelectorにはCanonical 役職（POSITION）を指定します。最終決裁ステップは厳格に1件のみ設定してください。
          </span>
        </div>
        <button
          type="button"
          onClick={handleAddStep}
          className="px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-xl text-xs font-bold flex items-center gap-1 transition"
        >
          <PlusCircle className="w-3.5 h-3.5" />
          <span>ステップ追加</span>
        </button>
      </div>

      {finalCount !== 1 && (
        <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-xs flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>最終決裁ステップが厳格に1件選択されていません (現在: {finalCount}件)</span>
        </div>
      )}

      <div className="space-y-2">
        {steps.map((st, idx) => (
          <div
            key={idx}
            className={`p-3.5 rounded-xl border transition ${
              st.isFinalDecisionStep ? 'bg-amber-50/50 border-amber-300' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-purple-600 text-white font-bold text-xs flex items-center justify-center">
                  {st.stepOrder}
                </span>
                <span className="font-bold text-slate-800 text-xs">第 {st.stepOrder} 段階</span>
                {st.isFinalDecisionStep && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 border border-amber-300 font-bold">
                    ★ 最終決裁ステップ
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => handleMoveStep(idx, 'up')}
                  className="p-1 hover:bg-slate-200 rounded text-slate-600 disabled:opacity-30"
                  title="上へ移動"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  disabled={idx === steps.length - 1}
                  onClick={() => handleMoveStep(idx, 'down')}
                  className="p-1 hover:bg-slate-200 rounded text-slate-600 disabled:opacity-30"
                  title="下へ移動"
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
                {steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveStep(idx)}
                    className="p-1 hover:bg-rose-100 rounded text-rose-600 ml-1"
                    title="ステップ削除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
              <div className="sm:col-span-4">
                <label className="block text-[10px] font-semibold text-slate-600 mb-0.5">ステップ表示名 *</label>
                <input
                  type="text"
                  required
                  value={st.stepName}
                  onChange={(e) => handleUpdateStep(idx, { stepName: e.target.value })}
                  placeholder="例: 教頭一次確認"
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>

              <div className="sm:col-span-5">
                <label className="block text-[10px] font-semibold text-slate-600 mb-0.5">承認担当役職 (Canonical Position) *</label>
                <select
                  value={st.selectorValue}
                  onChange={(e) => {
                    const posId = e.target.value;
                    let reqRole = 'TEACHER';
                    if (posId.includes('PRINCIPAL') && !posId.includes('VICE')) reqRole = 'PRINCIPAL';
                    else if (posId.includes('VICE_PRINCIPAL')) reqRole = 'VICE_PRINCIPAL';
                    else if (posId.includes('OFFICE')) reqRole = 'OFFICE';
                    handleUpdateStep(idx, {
                      selectorType: 'POSITION',
                      selectorValue: posId,
                      requiredRoleId: reqRole,
                    });
                  }}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-medium focus:outline-none focus:ring-1 focus:ring-purple-500"
                >
                  {availablePositions.map((pos) => (
                    <option key={pos.id} value={pos.id}>
                      {pos.name} ({pos.id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-3 flex items-end pb-1">
                <label className="flex items-center gap-1.5 cursor-pointer font-bold text-slate-800">
                  <input
                    type="radio"
                    name="finalDecisionGroup"
                    checked={st.isFinalDecisionStep}
                    onChange={() => handleSetFinalDecision(idx)}
                    className="text-amber-600 focus:ring-amber-500"
                  />
                  <span className="text-[11px]">最終決裁に指定</span>
                </label>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

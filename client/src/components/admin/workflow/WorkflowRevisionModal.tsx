import React, { useState, useEffect } from 'react';
import { WorkflowPolicy, WorkflowPolicyVersion, WorkflowPolicyStep, PolicyDraftReadinessResult } from '../../../types';
import { api } from '../../../services/api';
import { WorkflowStepEditor } from './WorkflowStepEditor';
import { WorkflowReadinessBadge } from './WorkflowReadinessBadge';
import { GitBranch, Save, X, AlertTriangle, CheckCircle } from 'lucide-react';

interface PositionOption {
  id: string;
  name: string;
}

interface Props {
  policy: WorkflowPolicy;
  version: WorkflowPolicyVersion;
  availablePositions: PositionOption[];
  onClose: () => void;
  onSaved: () => void;
}

export const WorkflowRevisionModal: React.FC<Props> = ({
  policy,
  version,
  availablePositions,
  onClose,
  onSaved,
}) => {
  const [priority, setPriority] = useState<number>(version.priority || 100);
  const [effectiveFrom, setEffectiveFrom] = useState<string>(version.effectiveFrom || '2026-04-01');
  const [effectiveTo, setEffectiveTo] = useState<string>(version.effectiveTo || '9999-12-31');
  const [steps, setSteps] = useState<WorkflowPolicyStep[]>(() => {
    if (version.steps && version.steps.length > 0) {
      return [...version.steps];
    }
    return [
      {
        stepOrder: 1,
        stepName: '教頭一次確認',
        stepKey: 'VP_STEP',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
      },
      {
        stepOrder: 2,
        stepName: '校長最終決裁',
        stepKey: 'PRIN_STEP',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
      },
    ];
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<PolicyDraftReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);

  const isDraft = version.status === 'DRAFT';

  // サーバー側 Readiness のフェッチ
  const fetchReadiness = async () => {
    setReadinessLoading(true);
    try {
      const res = await api.getWorkflowPolicyDraftReadiness(policy.id, version.id);
      setReadiness(res.data);
    } catch {
      // 未保存状態やエラー時は無視
    } finally {
      setReadinessLoading(false);
    }
  };

  useEffect(() => {
    if (isDraft) {
      fetchReadiness();
    }
  }, [version.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isDraft) {
      setError('ACTIVEまたはINACTIVE状態のバージョンは編集できません (完全不変)');
      return;
    }

    if (steps.length === 0) {
      setError('承認ステップを1件以上設定してください');
      return;
    }

    const finalCount = steps.filter((s) => s.isFinalDecisionStep).length;
    if (finalCount !== 1) {
      setError(`最終決裁ステップは厳格に1件のみ設定してください (現在: ${finalCount}件)`);
      return;
    }

    setSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await api.updateWorkflowPolicyDraftVersion(policy.id, version.id, {
        priority,
        effectiveFrom,
        effectiveTo,
        steps: steps.map((s) => ({
          stepName: s.stepName,
          stepKey: s.stepKey,
          actionType: s.actionType,
          requiredRoleId: s.requiredRoleId,
          selectorType: 'POSITION',
          selectorValue: s.selectorValue,
          isFinalDecisionStep: s.isFinalDecisionStep,
        })),
      });

      setSuccessMsg('下書きバージョン (DRAFT) を保存しました');
      await fetchReadiness();
      onSaved();
    } catch (err: any) {
      setError(`保存エラー: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full border border-slate-200 flex flex-col max-h-[90vh] overflow-hidden">
        {/* 固定ヘッダー */}
        <div className="flex justify-between items-start border-b border-slate-100 p-6 pb-4 shrink-0 bg-white">
          <div>
            <div className="flex items-center gap-2">
              <GitBranch className="w-5 h-5 text-purple-600" />
              <h3 className="text-base font-bold text-slate-900">
                承認ルート改訂エディタ: {policy.policyName} (v{version.version})
              </h3>
              <span
                className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                  version.status === 'ACTIVE'
                    ? 'bg-emerald-100 text-emerald-800'
                    : version.status === 'DRAFT'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                {version.status}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              適用申請種別: <strong className="text-indigo-700">{policy.appTypeIds.join(', ')}</strong> (Policy-owned)
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* スクロール可能フォームボディ */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs flex items-center gap-2">
              <CheckCircle className="w-4 h-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          <form id="workflow-revision-form" onSubmit={handleSubmit} className="space-y-6">
            {/* バージョン属性 (Version-owned) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">優先度 (Priority) *</label>
                <input
                  type="number"
                  required
                  disabled={!isDraft}
                  value={priority}
                  onChange={(e) => setPriority(parseInt(e.target.value, 10) || 100)}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg bg-white font-mono focus:outline-none focus:ring-1 focus:ring-purple-500 disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">適用開始日 (effective_from) *</label>
                <input
                  type="date"
                  required
                  disabled={!isDraft}
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500 disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">適用終了日 (effective_to) *</label>
                <input
                  type="date"
                  required
                  disabled={!isDraft}
                  value={effectiveTo}
                  onChange={(e) => setEffectiveTo(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500 disabled:bg-slate-100"
                />
              </div>
            </div>

            {/* ステップエディタ */}
            <WorkflowStepEditor
              steps={steps}
              onChange={setSteps}
              availablePositions={availablePositions}
            />

            {/* Readiness 表示 */}
            {isDraft && (
              <div className="space-y-2">
                <span className="text-xs font-bold text-slate-700">現在の Activation Readiness:</span>
                <WorkflowReadinessBadge readiness={readiness} loading={readinessLoading} />
              </div>
            )}
          </form>
        </div>

        {/* 固定フッターアクション */}
        <div className="flex justify-end gap-3 p-6 pt-4 border-t border-slate-100 shrink-0 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
          >
            閉じる
          </button>
          {isDraft && (
            <button
              type="submit"
              form="workflow-revision-form"
              disabled={saving}
              className="px-5 py-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 rounded-xl transition shadow-sm disabled:opacity-50 flex items-center gap-1.5"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? '保存中...' : 'DRAFTバージョンを保存'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

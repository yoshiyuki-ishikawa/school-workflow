import React from 'react';
import { PolicyDraftReadinessResult } from '../../../types';
import { CheckCircle2, XCircle, AlertTriangle, ShieldCheck } from 'lucide-react';

interface Props {
  readiness: PolicyDraftReadinessResult | null;
  loading?: boolean;
}

export const WorkflowReadinessBadge: React.FC<Props> = ({ readiness, loading }) => {
  if (loading) {
    return (
      <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl animate-pulse text-xs text-slate-500">
        サーバー側 Invariant 検証を実行中...
      </div>
    );
  }

  if (!readiness) return null;

  const { isReady, checks, errors } = readiness;

  const checkList = [
    { key: 'policyExists', title: 'ポリシー存在確認', check: checks.policyExists },
    { key: 'versionIsDraft', title: 'DRAFT状態確認 (ACTIVE/INACTIVE不変)', check: checks.versionIsDraft },
    { key: 'stepsExist', title: '承認ステップ件数 (1件以上)', check: checks.stepsExist },
    { key: 'stepOrderValid', title: 'ステップ順序連番 (1..N 重複なし)', check: checks.stepOrderValid },
    { key: 'finalDecisionExactlyOne', title: '最終決裁ステップ数 (厳格に1件)', check: checks.finalDecisionExactlyOne },
    { key: 'canonicalPositionsValid', title: 'Canonical 役職指定 (単一担当職制)', check: checks.canonicalPositionsValid },
    { key: 'roleSelectorExcluded', title: 'Roleセレクター不使用 (POSITION指定)', check: checks.roleSelectorExcluded },
    { key: 'applicationTypesBound', title: '適用申請種別バインド', check: checks.applicationTypesBound },
    { key: 'effectivePeriodValid', title: '適用期間形式 (開始 <= 終了)', check: checks.effectivePeriodValid },
    { key: 'effectiveFromReached', title: '適用開始日到達 (本日以降)', check: checks.effectiveFromReached },
    { key: 'effectiveToNotExpired', title: '適用終了日未経過 (本日以前でない)', check: checks.effectiveToNotExpired },
    { key: 'priorityConflictFree', title: '優先度競合なし (同一種別ACTIVE間)', check: checks.priorityConflictFree },
    { key: 'positionHoldersAssigned', title: '役職現任教職員配属済み', check: checks.positionHoldersAssigned },
  ];

  return (
    <div className={`p-4 rounded-xl border space-y-3 ${isReady ? 'bg-emerald-50/70 border-emerald-300' : 'bg-rose-50/70 border-rose-300'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isReady ? (
            <ShieldCheck className="w-5 h-5 text-emerald-600" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-rose-600" />
          )}
          <span className={`text-xs font-bold ${isReady ? 'text-emerald-900' : 'text-rose-900'}`}>
            {isReady ? 'Activation Readiness: 有効化準備完了 (All Invariants Passed)' : 'Activation Readiness: 有効化不可 (要修正)'}
          </span>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${isReady ? 'bg-emerald-200 text-emerald-800' : 'bg-rose-200 text-rose-800'}`}>
          {isReady ? 'READY TO ACTIVATE' : 'BLOCKED'}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
        {checkList.map(({ key, title, check }) => (
          <div
            key={key}
            className={`p-2 rounded-lg border flex items-start gap-2 ${
              check?.pass
                ? 'bg-white/80 border-emerald-200 text-slate-700'
                : 'bg-white border-rose-300 text-rose-900 shadow-2xs'
            }`}
          >
            {check?.pass ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
            )}
            <div>
              <span className="font-semibold">{title}</span>
              <p className={`text-[10px] ${check?.pass ? 'text-slate-500' : 'text-rose-700 font-medium'}`}>
                {check?.message}
              </p>
            </div>
          </div>
        ))}
      </div>

      {errors && errors.length > 0 && (
        <div className="p-3 bg-white rounded-lg border border-rose-200 space-y-1">
          <span className="text-[11px] font-bold text-rose-800">未解決のエラー一覧:</span>
          <ul className="list-disc list-inside text-[11px] text-rose-700 space-y-0.5">
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

import React from 'react';
import { WorkflowPolicy, WorkflowPolicyVersion, PolicyDraftReadinessResult } from '../../../types';
import { WorkflowReadinessBadge } from './WorkflowReadinessBadge';
import { AlertTriangle, ShieldCheck, Check, X, Info } from 'lucide-react';

interface Props {
  policy: WorkflowPolicy;
  version: WorkflowPolicyVersion;
  readiness: PolicyDraftReadinessResult | null;
  readinessLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  activating: boolean;
}

export const WorkflowActivationDialog: React.FC<Props> = ({
  policy,
  version,
  readiness,
  readinessLoading,
  onConfirm,
  onCancel,
  activating,
}) => {
  const currentActive = policy.versions.find((v) => v.status === 'ACTIVE');
  const isReady = readiness?.isReady ?? false;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full p-6 border border-slate-200 space-y-5 my-8">
        <div className="flex justify-between items-start border-b border-slate-100 pb-3">
          <div>
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
              <span>ポリシーバージョンの有効化 (Activation Confirmation)</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              ポリシー「{policy.policyName}」の Version {version.version} を本番適用（ACTIVE）します。
            </p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 影響サマリー */}
        <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl space-y-2 text-xs text-amber-900">
          <div className="flex items-center gap-2 font-bold text-amber-950">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>有効化に伴う世代遷移と Historical Snapshot 保護</span>
          </div>
          <ul className="list-disc list-inside space-y-1 text-slate-700 pl-1">
            <li>
              現行 ACTIVE バージョン (<strong className="font-mono">{currentActive ? `v${currentActive.version}` : 'なし'}</strong>) は自動的に <strong className="text-slate-800">INACTIVE</strong> へ安全に退役します。
            </li>
            <li>
              対象バージョン (<strong className="font-mono">v{version.version}</strong>) が <strong className="text-emerald-700 font-bold">ACTIVE</strong> となり、今後提出される新規申請に適用されます。
            </li>
            <li>
              <strong className="text-slate-900">過去および進行中の申請:</strong> すでに提出された申請は、過去バージョンの承認スナップショットが完全固定されているため、一切影響を受けず最後まで安全に決裁完了できます。
            </li>
          </ul>
        </div>

        {/* Readiness Checklist */}
        <div className="space-y-2">
          <label className="block text-xs font-bold text-slate-700 flex items-center gap-1.5">
            <Info className="w-4 h-4 text-indigo-600" />
            <span>サーバー側 Activation Invariant 判定結果</span>
          </label>
          <WorkflowReadinessBadge readiness={readiness} loading={readinessLoading} />
        </div>

        {/* ダイアログアクション */}
        <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={onCancel}
            disabled={activating}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!isReady || activating || readinessLoading}
            className="px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition shadow-sm disabled:opacity-40 flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>{activating ? '有効化中...' : '確認して有効化 (ACTIVE)'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

import React, { useState } from 'react';
import { WorkflowPolicy, WorkflowPolicyVersion } from '../../../types';
import { WorkflowVersionHistory } from './WorkflowVersionHistory';
import { GitBranch, PlusCircle, ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';

interface Props {
  policy: WorkflowPolicy;
  onEditVersion: (policy: WorkflowPolicy, version: WorkflowPolicyVersion) => void;
  onRequestActivate: (policy: WorkflowPolicy, version: WorkflowPolicyVersion) => void;
  onCreateDraft: (policy: WorkflowPolicy, baseVersionId?: string) => void;
  onDeleteDraft: (policy: WorkflowPolicy, versionId: string) => void;
  loading: boolean;
}

export const WorkflowPolicyCard: React.FC<Props> = ({
  policy,
  onEditVersion,
  onRequestActivate,
  onCreateDraft,
  onDeleteDraft,
  loading,
}) => {
  const [expanded, setExpanded] = useState(false);

  const activeVer = policy.versions.find((v) => v.status === 'ACTIVE');
  const draftVer = policy.versions.find((v) => v.status === 'DRAFT');

  return (
    <div className="border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-2xs">
      {/* カードヘッダー */}
      <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-purple-600" />
            <h3 className="text-sm font-bold text-slate-900">{policy.policyName}</h3>
            <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-slate-200 text-slate-700 font-bold">
              {policy.policyKey}
            </span>
            {policy.policyPurpose === 'POST_TRIP_REPORT' ? (
              <span className="text-[10px] px-2 py-0.5 rounded bg-teal-100 text-teal-800 border border-teal-200 font-bold">
                復命報告
              </span>
            ) : policy.policyPurpose === 'CANCELLATION' ? (
              <span className="text-[10px] px-2 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-200 font-bold">
                取消
              </span>
            ) : (
              <span className="text-[10px] px-2 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200 font-bold">
                承認
              </span>
            )}
            <span className="text-[10px] px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-200 font-semibold">
              {policy.policySource}
            </span>
          </div>
          {policy.description && <p className="text-xs text-slate-500">{policy.description}</p>}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] text-slate-500 font-medium">適用申請種別:</span>
            {policy.appTypeIds.map((at) => (
              <span
                key={at}
                className="text-[10px] px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold font-mono"
              >
                {at}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {activeVer && (
            <span className="text-xs px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              <span>v{activeVer.version} (ACTIVE)</span>
            </span>
          )}
          {draftVer && (
            <span className="text-xs px-2 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 font-bold">
              v{draftVer.version} (DRAFT)
            </span>
          )}

          {!draftVer && (
            <button
              type="button"
              disabled={loading}
              onClick={() => onCreateDraft(policy, activeVer?.id)}
              className="px-3 py-1.5 bg-white border border-purple-300 hover:bg-purple-50 text-purple-700 rounded-xl text-xs font-bold flex items-center gap-1 shadow-2xs transition disabled:opacity-50"
            >
              <PlusCircle className="w-3.5 h-3.5 text-purple-600" />
              <span>新バージョン (DRAFT) を作成</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1 transition"
            title={expanded ? '詳細を折りたたむ' : 'バージョン履歴・ステップ詳細を展開'}
          >
            <span>{expanded ? '詳細を閉じる' : '詳細・履歴'}</span>
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
          </button>
        </div>
      </div>

      {/* カードボディ (バージョン履歴) */}
      {expanded && (
        <div className="p-5">
          <WorkflowVersionHistory
            policy={policy}
            onEditVersion={(ver) => onEditVersion(policy, ver)}
            onRequestActivate={(ver) => onRequestActivate(policy, ver)}
            onDeleteDraft={(verId) => onDeleteDraft(policy, verId)}
            loading={loading}
          />
        </div>
      )}
    </div>
  );
};

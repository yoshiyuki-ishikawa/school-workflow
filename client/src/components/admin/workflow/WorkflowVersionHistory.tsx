import React from 'react';
import { WorkflowPolicy, WorkflowPolicyVersion } from '../../../types';
import { Clock, ShieldCheck, Check, Trash2, Edit2, AlertCircle } from 'lucide-react';

interface Props {
  policy: WorkflowPolicy;
  onEditVersion: (version: WorkflowPolicyVersion) => void;
  onRequestActivate: (version: WorkflowPolicyVersion) => void;
  onDeleteDraft: (versionId: string) => void;
  loading: boolean;
}

export const WorkflowVersionHistory: React.FC<Props> = ({
  policy,
  onEditVersion,
  onRequestActivate,
  onDeleteDraft,
  loading,
}) => {
  const versions = [...policy.versions].sort((a, b) => b.version - a.version);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
        <Clock className="w-4 h-4 text-purple-600" />
        <span>バージョン履歴 (Version Audit History)</span>
      </div>

      <div className="space-y-3">
        {versions.map((ver) => {
          const isActive = ver.status === 'ACTIVE';
          const isDraft = ver.status === 'DRAFT';
          const isInactive = ver.status === 'INACTIVE';

          return (
            <div
              key={ver.id}
              className={`p-4 rounded-xl border transition ${
                isActive
                  ? 'bg-emerald-50/40 border-emerald-300 ring-1 ring-emerald-300/50'
                  : isDraft
                  ? 'bg-amber-50/30 border-amber-300'
                  : 'bg-slate-50/60 border-slate-200 opacity-80'
              }`}
            >
              <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-xs text-slate-900">
                    Version {ver.version}
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
                      isActive
                        ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                        : isDraft
                        ? 'bg-amber-100 text-amber-800 border-amber-300'
                        : 'bg-slate-200 text-slate-700 border-slate-300'
                    }`}
                  >
                    {ver.status}
                  </span>
                  <span className="text-[11px] text-slate-500 font-mono">
                    Priority: {ver.priority}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    期間: {ver.effectiveFrom} 〜 {ver.effectiveTo || '無期限'}
                  </span>
                  {ver.isUsed && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-medium">
                      申請実績あり (Snapshot保護)
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onEditVersion(ver)}
                    className="px-2.5 py-1 text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition shadow-2xs flex items-center gap-1"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                    <span>{isDraft ? '編集 (DRAFT)' : '詳細閲覧'}</span>
                  </button>

                  {isDraft && (
                    <>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => onRequestActivate(ver)}
                        className="px-3 py-1 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition shadow-2xs flex items-center gap-1 disabled:opacity-50"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>有効化 (ACTIVE)</span>
                      </button>

                      {!ver.isUsed && (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => onDeleteDraft(ver.id)}
                          className="p-1 text-rose-600 hover:bg-rose-50 rounded-lg transition"
                          title="下書きを破棄"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* ステップ一覧プレビュー */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                {ver.steps &&
                  ver.steps.map((st) => (
                    <div
                      key={st.id || st.stepOrder}
                      className="p-2 bg-white rounded-lg border border-slate-200/80 shadow-2xs space-y-0.5"
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-slate-800">
                          {st.stepOrder}. {st.stepName}
                        </span>
                        {st.isFinalDecisionStep && (
                          <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-800 border border-amber-200 font-bold">
                            決裁
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 flex items-center justify-between">
                        <span>
                          役職: <strong className="text-indigo-600">{st.selectorValue}</strong>
                        </span>
                        <span>行為: {st.actionType}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

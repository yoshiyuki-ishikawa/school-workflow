import React from 'react';
import { ApprovalStep } from '../types';
import { CheckCircle2, Clock, XCircle, RotateCcw, User, FastForward } from 'lucide-react';
import { HankoStamp } from './HankoStamp';

interface Props {
  steps: ApprovalStep[];
  proxySubmitterName?: string;
  currentStatus?: string;
}

export interface CycleClassification {
  isCycleReturned: boolean;
  isCycleApproved: boolean;
  badgeLabel: string;
  badgeVariant: 'current' | 'approved' | 'returned' | 'historical';
}

/**
 * Historical Cycle Deterministic Classification (POINT-02-B)
 * 既存の steps: ApprovalStep[] プロパティから決定論的にサイクルの状態を導出する。
 */
export function classifyCycleSemantic(
  cycleNum: number,
  cycleSteps: ApprovalStep[],
  isCurrent: boolean
): CycleClassification {
  const isCycleReturned = cycleSteps.some((step) => step.status === 'RETURNED');
  const isCycleApproved = cycleSteps.some(
    (step) => step.status === 'APPROVED' && (step.is_final_decision_step === 1 || step.step_order === cycleSteps.length)
  );

  let badgeLabel = `過去の決裁履歴 (第${cycleNum}サイクル)`;
  let badgeVariant: 'current' | 'approved' | 'returned' | 'historical' = 'historical';

  if (isCurrent) {
    badgeLabel = `現在の承認フロー (第${cycleNum}サイクル)`;
    badgeVariant = 'current';
  } else if (isCycleApproved) {
    badgeLabel = `決裁完了 (第${cycleNum}サイクル)`;
    badgeVariant = 'approved';
  } else if (isCycleReturned) {
    badgeLabel = `差戻し履歴 (第${cycleNum}サイクル)`;
    badgeVariant = 'returned';
  }

  return {
    isCycleReturned,
    isCycleApproved,
    badgeLabel,
    badgeVariant,
  };
}

export function groupStepsByCycle(steps: ApprovalStep[]): [number, ApprovalStep[]][] {
  const map = new Map<number, ApprovalStep[]>();
  for (const step of steps || []) {
    const c = step.approval_cycle || 1;
    if (!map.has(c)) {
      map.set(c, []);
    }
    map.get(c)!.push(step);
  }
  return Array.from(map.entries()).sort((a, b) => b[0] - a[0]); // 最新サイクルを先頭に
}

export const ApprovalTimeline: React.FC<Props> = ({ steps, proxySubmitterName, currentStatus }) => {
  // approval_cycle ごとにグループ化
  const cycles = React.useMemo(() => groupStepsByCycle(steps), [steps]);

  const maxCycle = cycles.length > 0 ? cycles[0][0] : 1;

  // 0ステップ時のハンドリング
  if (!steps || steps.length === 0) {
    if (currentStatus === 'DRAFT') {
      return (
        <div className="flow-root my-4 p-4 rounded-xl border border-dashed border-amber-300 bg-amber-50/50">
          <div className="flex items-center gap-2 text-amber-800 text-xs font-medium">
            <Clock className="w-4 h-4 text-amber-600" />
            <span>この申請は下書き保存状態のため、承認ルート・決裁タイムラインはまだ開始されていません（正式提出後に決裁ルートが生成されます）。</span>
          </div>
        </div>
      );
    }
    return (
      <div className="flow-root my-4 p-4 rounded-xl border border-rose-300 bg-rose-50 text-rose-800 text-xs">
        <span className="font-bold">⚠️ 決裁ルート整合性エラー:</span> 承認ステップが生成されていません。システム管理者に確認してください。
      </div>
    );
  }

  return (
    <div className="flow-root my-4 space-y-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
          <span>決裁ルート・進捗タイムライン</span>
        </h3>
        {proxySubmitterName && (
          <span className="text-xs px-2.5 py-1 rounded bg-amber-50 text-amber-800 border border-amber-300 font-medium">
            代理申請者: {proxySubmitterName}
          </span>
        )}
      </div>

      {cycles.map(([cycleNum, cycleSteps]) => {
        const isCurrent = cycleNum === maxCycle;
        const classification = classifyCycleSemantic(cycleNum, cycleSteps, isCurrent);

        return (
          <div
            key={cycleNum}
            className={`p-4 rounded-xl border ${
              isCurrent
                ? 'bg-white border-slate-200 shadow-sm'
                : 'bg-slate-50/60 border-slate-200/80'
            }`}
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-2 mb-4">
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded ${
                    classification.badgeVariant === 'current'
                      ? 'bg-indigo-100 text-indigo-800'
                      : classification.badgeVariant === 'approved'
                      ? 'bg-emerald-100 text-emerald-800'
                      : classification.badgeVariant === 'returned'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {classification.badgeLabel}
                </span>
                {!isCurrent && classification.isCycleReturned && (
                  <span className="text-[11px] text-amber-700 font-medium flex items-center gap-1">
                    <RotateCcw className="w-3 h-3" /> 差戻し履歴
                  </span>
                )}
                {!isCurrent && classification.isCycleApproved && (
                  <span className="text-[11px] text-emerald-700 font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> 決裁完了
                  </span>
                )}
              </div>
            </div>

            <ul className="-mb-8">
              {cycleSteps.map((step, stepIdx) => {
                const isLast = stepIdx === cycleSteps.length - 1;

                let icon = <Clock className="w-5 h-5 text-slate-400" />;
                let bgClass = 'bg-slate-100 border-slate-300';
                let statusText = '待機中';

                if (step.status === 'APPROVED') {
                  icon = <CheckCircle2 className="w-5 h-5 text-emerald-600" />;
                  bgClass = 'bg-emerald-50 border-emerald-500';
                  statusText = '承認済';
                } else if (step.status === 'PENDING') {
                  icon = <Clock className="w-5 h-5 text-blue-600 animate-pulse" />;
                  bgClass = 'bg-blue-50 border-blue-500';
                  statusText = '現在承認待ち';
                } else if (step.status === 'RETURNED') {
                  icon = <RotateCcw className="w-5 h-5 text-rose-600" />;
                  bgClass = 'bg-rose-50 border-rose-500';
                  statusText = '差戻し';
                } else if (step.status === 'REJECTED') {
                  icon = <XCircle className="w-5 h-5 text-red-600" />;
                  bgClass = 'bg-red-50 border-red-500';
                  statusText = '却下';
                } else if (step.status === 'SKIPPED') {
                  icon = <FastForward className="w-5 h-5 text-amber-600" />;
                  bgClass = 'bg-amber-50 border-amber-400';
                  statusText = 'スキップ（本人申請）';
                }

                const stampName = (step as any).action_user_stamp_name || (step as any).actor_name || '';
                const roleTitle = step.step_name.includes('校長') ? '校長' : step.step_name.includes('教頭') ? '教頭' : '確認';

                return (
                  <li key={step.id}>
                    <div className="relative pb-8">
                      {!isLast && (
                        <span
                          className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-slate-200"
                          aria-hidden="true"
                        />
                      )}
                      <div className="relative flex space-x-3 items-start">
                        <div>
                          <span
                            className={`h-8 w-8 rounded-full flex items-center justify-center ring-4 ring-white border ${bgClass}`}
                          >
                            {icon}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1 pt-1.5 flex justify-between space-x-4">
                          <div>
                            <div className="text-sm font-medium text-slate-900 flex items-center gap-2">
                              <span>第{step.step_order}段階: {step.step_name}</span>
                              <span className="text-xs px-2 py-0.5 rounded font-normal bg-slate-100 text-slate-600 border border-slate-200">
                                {statusText}
                              </span>
                            </div>
                            {(step.actor_name || (step as any).action_user_name) && (
                              <p className="text-xs text-slate-600 mt-0.5 flex items-center gap-1">
                                <User className="w-3 h-3 text-slate-400" />
                                <span>処理者: {step.actor_name || (step as any).action_user_name}</span>
                              </p>
                            )}
                            {step.comment && (
                              <div className={`mt-2 text-xs p-2.5 rounded border ${
                                step.status === 'RETURNED'
                                  ? 'bg-rose-50/80 border-rose-200 text-rose-900 font-medium'
                                  : 'bg-slate-50 border-slate-200 text-slate-700'
                              }`}>
                                <span className="font-bold">
                                  {step.status === 'RETURNED' ? '差戻し理由コメント:' : 'コメント:'}
                                </span>{' '}
                                {step.comment}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-3">
                            {step.status === 'APPROVED' && (
                              <HankoStamp
                                stampName={stampName}
                                roleTitle={roleTitle}
                                dateStr={step.acted_at || undefined}
                                size="sm"
                                variant="double_circle"
                              />
                            )}
                            <div className="text-right text-xs whitespace-nowrap text-slate-500">
                              {step.acted_at ? new Date(step.acted_at).toLocaleDateString('ja-JP') : '-'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
};


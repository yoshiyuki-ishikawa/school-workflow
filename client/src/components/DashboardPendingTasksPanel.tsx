import React from 'react';
import { usePendingTasks } from '../hooks/usePendingTasks';
import { Clock, ArrowRight, UserCheck, AlertTriangle } from 'lucide-react';

interface Props {
  onSelectApplication: (id: number) => void;
  refreshTrigger?: number;
}

export const DashboardPendingTasksPanel: React.FC<Props> = ({ onSelectApplication, refreshTrigger }) => {
  const { pendingCount, tasks, isLoading, error } = usePendingTasks(refreshTrigger);

  if (isLoading) {
    return null;
  }

  if (error) {
    return (
      <div data-testid="dashboard-pending-panel" className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-center gap-3 text-rose-700">
        <AlertTriangle className="w-5 h-5 flex-shrink-0" />
        <div className="text-sm">
          <p className="font-bold">未処理タスクの取得中にエラーが発生しました</p>
          <p className="text-xs text-rose-600">データの整合性エラーまたはサーバーエラーです。管理者に確認してください。</p>
        </div>
      </div>
    );
  }

  if (pendingCount <= 0) {
    return null;
  }

  return (
    <div data-testid="dashboard-pending-panel" className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-amber-500 text-white rounded-xl shadow-xs">
            <UserCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-800">
              あなたが承認すべき未処理タスク
            </h3>
            <p className="text-xs text-slate-500">
              現在、決裁権限を持つ承認待ち申請が <span className="font-bold text-amber-600">{pendingCount}件</span> あります。
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        {tasks.map((task) => (
          <div
            key={`${task.application_id}-${task.cycle_number}`}
            onClick={() => onSelectApplication(task.application_id)}
            className="bg-white p-3.5 rounded-xl border border-amber-100 hover:border-amber-300 hover:shadow-sm cursor-pointer transition-all flex items-center justify-between gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded-md ${
                    task.cycle_purpose === 'CANCELLATION'
                      ? 'bg-rose-100 text-rose-800'
                      : task.cycle_purpose === 'POST_TRIP_REPORT'
                      ? 'bg-purple-100 text-purple-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {task.cycle_purpose === 'CANCELLATION'
                    ? '承認後取消'
                    : task.cycle_purpose === 'POST_TRIP_REPORT'
                    ? `出張復命承認 (${task.current_step_name})`
                    : task.current_step_name}
                </span>
                <span className="text-xs text-slate-500 font-medium">
                  申請者: {task.applicant_name}
                </span>
                <span className="text-xs text-slate-400">
                  {task.submitted_at ? task.submitted_at.substring(0, 10) : ''}
                </span>
              </div>
              <h4 className="text-sm font-semibold text-slate-800 truncate">
                {task.title}
              </h4>
            </div>

            <div className="flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2.5 py-1.5 rounded-lg border border-amber-200 flex-shrink-0">
              <span>承認する</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

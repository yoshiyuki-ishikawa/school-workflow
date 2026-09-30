import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Application, User, UserLeaveSummary } from '../types';
import { StatusBadge } from '../components/StatusBadge';
import { LeaveSummaryWidget } from '../components/LeaveSummaryWidget';
import { DashboardPendingTasksPanel } from '../components/DashboardPendingTasksPanel';
import {
  FileText,
  Clock,
  CheckCircle,
  AlertCircle,
  PlusCircle,
  ChevronRight,
  Filter,
  ArrowRight,
} from 'lucide-react';
import { resolveApplicationDisplayState } from '../services/workflowPresentationResolver';

interface Props {
  currentUser: User;
  activeTab: 'my' | 'pending_approval' | 'all';
  onSelectApplication: (id: number) => void;
  onOpenNewModal: () => void;
  refreshTrigger: number;
}

/**
 * Application-Type-Aware Summary Projection Helper (Defensive & Fail-Closed)
 */
export function formatApplicationPeriodSummary(app: Application): string {
  const fd = (app.form_data || {}) as Record<string, any>;
  const typeId = app.type_id || '';

  // 1. 出張系 (BUSINESS_TRIP)
  if (typeId === 'BUSINESS_TRIP') {
    const s = fd.startDate;
    const e = fd.endDate || s;
    const st = fd.startTime;
    const et = fd.endTime;
    if (!s) return '-';
    const datePart = s === e ? s : `${s}〜${e}`;
    const timePart = st && et ? ` (${st}〜${et})` : '';
    return `${datePart}${timePart}`;
  }

  // 2. 休暇系 (LEAVE_ANNUAL, LEAVE_SICK, LEAVE_SPECIAL, LEAVE_CARE, etc.) / 研修系 (TRAINING_*)
  if (typeId.startsWith('LEAVE_') || typeId.startsWith('TRAINING_') || typeId === 'WORK_PATTERN_CHILDCARE') {
    if (fd.unitType === 'TIME') {
      const mins = Number(fd.calculatedMinutes) || 0;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const d = fd.targetDate || fd.startDate || '-';
      const st = fd.startTime || '';
      const et = fd.endTime || '';
      return `${d} ${st}〜${et} (${h}h${m}m)`.trim();
    }
    if (fd.unitType === 'HALF_DAY') {
      const d = fd.targetDate || fd.startDate || '-';
      const halfLabel = fd.halfDayType === 'AM' ? '午前半日' : (fd.halfDayType === 'PM' ? '午後半日' : '半日');
      return `${d} (${halfLabel} 0.5日)`;
    }
    // 終日 (DAY または デフォルト)
    const s = fd.startDate || fd.targetDate;
    const e = fd.endDate || s;
    const charged = fd.calculatedDays !== undefined && fd.calculatedDays !== null
      ? `${fd.calculatedDays}日`
      : '';
    if (!s) return '-';
    const datePart = s === e ? s : `${s}〜${e}`;
    return charged ? `${datePart} (${charged})` : datePart;
  }

  // 3. その他・身分変動等
  const s = fd.startDate || fd.targetDate;
  const e = fd.endDate || s;
  if (!s) return '-';
  return s === e ? s : `${s}〜${e}`;
}

export const DashboardPage: React.FC<Props> = ({
  currentUser,
  activeTab,
  onSelectApplication,
  onOpenNewModal,
  refreshTrigger,
}) => {
  const [applications, setApplications] = useState<Application[]>([]);
  const [leaveSummary, setLeaveSummary] = useState<UserLeaveSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterType, setFilterType] = useState('ALL');

  const fetchList = () => {
    setLoading(true);
    setError('');
    Promise.all([
      api.getApplications(activeTab),
      api.getLeaveSummary(),
    ])
      .then(([appsRes, summaryRes]) => {
        setApplications(appsRes.applications);
        setLeaveSummary(summaryRes.summary);
      })
      .catch((err) => setError(err.message || 'データの取得に失敗しました'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchList();
  }, [activeTab, refreshTrigger]);

  const filtered = applications.filter((app) => {
    if (filterType === 'ALL') return true;
    return app.type_id === filterType;
  });

  const pendingCount = applications.filter(
    (a) => a.current_status === 'SUBMITTED' || a.current_status === 'FIRST_APPROVED'
  ).length;
  const actionableReturnedApps = applications.filter((a) => {
    const displayState = resolveApplicationDisplayState(a, currentUser.id);
    return displayState.isReturnedActionableForUser;
  });
  const returnedCount = actionableReturnedApps.length;
  const approvedCount = applications.filter((a) => a.current_status === 'FINAL_APPROVED').length;

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
      {/* 0. 未処理タスクサマリーパネル (承認タスク) */}
      <DashboardPendingTasksPanel
        onSelectApplication={onSelectApplication}
        refreshTrigger={refreshTrigger}
      />

      {/* 0.5. 差戻し・要修正アクションパネル (Notice -> Task -> Action 直結) */}
      {activeTab === 'my' && actionableReturnedApps.length > 0 && (
        <div data-testid="dashboard-returned-action-panel" className="bg-gradient-to-r from-rose-50 to-pink-50 border-2 border-rose-300 rounded-2xl p-5 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-rose-600 text-white rounded-xl shadow-xs">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-rose-950">
                  修正・再提出が必要な申請 ({actionableReturnedApps.length}件)
                </h3>
                <p className="text-xs text-rose-700">
                  決裁者から差し戻された申請です。内容を確認し、修正して再提出（RESUBMIT）を行ってください。
                </p>
              </div>
            </div>
            {actionableReturnedApps.length === 1 && (
              <button
                onClick={() => onSelectApplication(actionableReturnedApps[0].id)}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-xs flex-shrink-0"
              >
                <span>修正画面を開く</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {actionableReturnedApps.length > 1 && (
            <div className="space-y-2 pt-1 border-t border-rose-200/60">
              {actionableReturnedApps.map((app) => (
                <div
                  key={app.id}
                  onClick={() => onSelectApplication(app.id)}
                  className="bg-white p-3 rounded-xl border border-rose-200 hover:border-rose-400 hover:shadow-xs cursor-pointer transition flex items-center justify-between gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-bold px-1.5 py-0.2 rounded bg-rose-100 text-rose-800 border border-rose-300">
                        {app.cancellationReturn ? '取消差戻し' : '差戻し'}
                      </span>
                      <span className="text-xs font-medium text-slate-700">{app.type_name}</span>
                      <span className="text-[11px] text-slate-400 font-mono">#{app.id}</span>
                    </div>
                    <h4 className="text-xs font-bold text-slate-900 truncate">{app.title}</h4>
                  </div>
                  <div className="flex items-center gap-1 text-xs font-semibold text-rose-700 bg-rose-50 px-2.5 py-1 rounded-lg border border-rose-200 flex-shrink-0">
                    <span>修正する</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 1. 休暇等累計・年休残数サマリーカード (第9号様式 休暇簿) */}
      {leaveSummary && (
        <LeaveSummaryWidget
          summary={leaveSummary}
          title={`あなたの休暇等累計・年休残数 (${currentUser.displayName})`}
        />
      )}

      {/* 2. 業務ステータスカード */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500">申請総件数</p>
            <h3 className="text-2xl font-bold text-slate-800 mt-1">{applications.length}</h3>
          </div>
          <div className="p-3 bg-blue-50 text-blue-600 rounded-xl">
            <FileText className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500">
              {activeTab === 'pending_approval' ? 'あなたの承認待ち' : '審査・決裁中'}
            </p>
            <h3 className="text-2xl font-bold text-amber-600 mt-1">{pendingCount}</h3>
          </div>
          <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
            <Clock className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500">要修正・差戻し</p>
            <h3 className="text-2xl font-bold text-rose-600 mt-1">{returnedCount}</h3>
          </div>
          <div className="p-3 bg-rose-50 text-rose-600 rounded-xl">
            <AlertCircle className="w-6 h-6" />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500">決裁完了 (承認済)</p>
            <h3 className="text-2xl font-bold text-emerald-600 mt-1">{approvedCount}</h3>
          </div>
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
            <CheckCircle className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* 3. 申請一覧テーブルカード */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 sm:px-6 border-b border-slate-200 flex flex-wrap justify-between items-center gap-3 bg-slate-50">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800">
              {activeTab === 'my' && '自分の申請一覧'}
              {activeTab === 'pending_approval' && '承認待ちの申請一覧'}
              {activeTab === 'all' && '全校内申請一覧'}
            </h2>
            <span className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full font-semibold">
              {filtered.length} 件
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <Filter className="w-3.5 h-3.5" />
              <span>種別:</span>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="border border-slate-300 rounded-lg px-2.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="ALL">すべて</option>
                <option value="LEAVE_ANNUAL">年次有給休暇</option>
                <option value="LEAVE_SICK">病気休暇</option>
                <option value="LEAVE_SPECIAL">特別休暇</option>
                <option value="LEAVE_DUTY_EXEMPT">職専免等</option>
                <option value="BUSINESS_TRIP">出張申請</option>
              </select>
            </div>

            <button
              onClick={onOpenNewModal}
              className="bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors"
            >
              <PlusCircle className="w-4 h-4" />
              <span>新規申請</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="p-4 bg-rose-50 border-b border-rose-200 text-rose-700 text-xs">
            {error}
          </div>
        )}

        {loading ? (
          <div className="p-12 text-center text-slate-400 text-xs">データを読み込み中...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-xs">
            対象の申請はまだありません。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">管理番号</th>
                  <th className="px-4 py-3 text-left font-semibold">申請種別</th>
                  <th className="px-4 py-3 text-left font-semibold">件名</th>
                  {activeTab !== 'my' && (
                    <th className="px-4 py-3 text-left font-semibold">申請者</th>
                  )}
                  <th className="px-4 py-3 text-left font-semibold">期間 / 時間 (8:10〜16:40基準)</th>
                  <th className="px-4 py-3 text-left font-semibold">ステータス</th>
                  <th className="px-4 py-3 text-left font-semibold">最終更新日時</th>
                  <th className="px-4 py-3 text-center font-semibold">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {filtered.map((app) => {
                  const timeText = formatApplicationPeriodSummary(app);

                  return (
                    <tr
                      key={app.id}
                      onClick={() => onSelectApplication(app.id)}
                      className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 font-mono font-medium text-slate-500">
                        #{app.id}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                          {app.type_name}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-900 flex items-center gap-1.5">
                          <span>{app.title}</span>
                          {app.submission_actor_type === 'PROXY' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 font-normal">
                              代理
                            </span>
                          )}
                          {app.submission_mode === 'BATCH' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300 font-normal">
                              一括
                            </span>
                          )}
                        </div>
                      </td>
                      {activeTab !== 'my' && (
                        <td className="px-4 py-3 text-slate-700">
                          <span className="font-semibold">{app.subject_user_name || app.applicant_name}</span>
                          {app.proxy_user_name && app.submission_actor_type === 'PROXY' && (
                            <span className="text-amber-700 text-[10px] block font-medium">
                              (代行: {app.proxy_user_name})
                            </span>
                          )}
                          <span className="text-slate-400 text-[11px] block">{app.subject_department || app.applicant_department}</span>
                        </td>
                      )}
                      <td className="px-4 py-3 text-slate-600 font-mono">
                        {timeText}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge status={app.current_status} />
                          {(() => {
                            const ds = resolveApplicationDisplayState(app, currentUser.id);
                            if (ds.hasSecondaryStatus && ds.secondaryLabel) {
                              const badgeStyle =
                                ds.secondaryColor === 'rose'
                                  ? 'bg-rose-100 text-rose-800 border-rose-300'
                                  : 'bg-amber-100 text-amber-800 border-amber-300';
                              return (
                                <span
                                  className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold border ${badgeStyle}`}
                                >
                                  {ds.secondaryLabel}
                                </span>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-500 font-mono">
                        {new Date(app.updated_at).toLocaleString('ja-JP')}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button className="text-blue-600 hover:text-blue-800 p-1 rounded-full hover:bg-blue-50">
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

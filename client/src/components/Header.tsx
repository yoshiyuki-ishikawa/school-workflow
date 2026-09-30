import React from 'react';
import { User } from '../types';
import { FileText, LogOut, Shield, UserCheck, ShieldCheck, Key } from 'lucide-react';
import { usePendingTasks } from '../hooks/usePendingTasks';
import { PendingTaskBadge } from './PendingTaskBadge';

interface Props {
  user: User;
  activeTab: 'my' | 'pending_approval' | 'all' | 'attendance' | 'admin';
  setActiveTab: (tab: 'my' | 'pending_approval' | 'all' | 'attendance' | 'admin') => void;
  onLogout: () => void;
  onOpenNewModal: () => void;
  onOpenPasswordModal?: () => void;
  appTitle?: string;
  schoolName?: string;
  refreshTrigger?: number;
}

/**
 * UI-005 Presentation Decision: Model A Action Queue (Server Fact Driven)
 * pendingCount > 0 のみで承認待ちタブの表示可否を決定論的に判定する（Client側の役職推測・役割ホワイトリストは完全排除）
 */
export function shouldShowPendingApprovalTab(pendingCount: number): boolean {
  return pendingCount > 0;
}

/**
 * UI-009 Presentation Decision: New Application Action Availability
 * 認証済みユーザーであれば ADMIN を含め全員が新規申請アクションを実行可能（!isAdmin 等の除外ガードは存在しない）
 */
export function shouldShowNewApplicationAction(user: User | null): boolean {
  return user !== null;
}

export const Header: React.FC<Props> = ({
  user,
  activeTab,
  setActiveTab,
  onLogout,
  onOpenNewModal,
  onOpenPasswordModal,
  appTitle = '学校業務ワークフロー',
  schoolName = '校内LAN閉域運用システム',
  refreshTrigger,
}) => {
  const { pendingCount } = usePendingTasks(refreshTrigger);
  const showPendingApprovalTab = shouldShowPendingApprovalTab(pendingCount);
  const showNewApplication = shouldShowNewApplicationAction(user);
  const canViewAll = user.roles.some((r) => ['ADMIN', 'PRINCIPAL', 'VICE_PRINCIPAL', 'OFFICE'].includes(r));

  return (
    <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* ロゴ・システム名 */}
          <div className="flex items-center gap-3">
            <div className="bg-blue-700 text-white p-2 rounded-lg shadow-sm flex items-center justify-center">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-800 leading-tight">{appTitle}</h1>
              <p className="text-xs text-slate-500">{schoolName}</p>
            </div>
          </div>

          {/* ナビゲーション */}
          <nav className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('my')}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'my'
                  ? 'bg-blue-50 text-blue-700 font-semibold'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              自分の申請
            </button>

            {showPendingApprovalTab && (
              <button
                onClick={() => setActiveTab('pending_approval')}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === 'pending_approval'
                    ? 'bg-blue-50 text-blue-700 font-semibold'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <UserCheck className="w-4 h-4" />
                <span>承認待ち</span>
                <PendingTaskBadge count={pendingCount} />
              </button>
            )}

            {canViewAll && (
              <button
                onClick={() => setActiveTab('all')}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === 'all'
                    ? 'bg-blue-50 text-blue-700 font-semibold'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                全申請
              </button>
            )}

            {/* 出勤簿タブ */}
            <button
              onClick={() => setActiveTab('attendance')}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'attendance'
                  ? 'bg-blue-50 text-blue-700 font-semibold'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <span>📅 出勤簿</span>
            </button>

            {/* 権限管理・監査タブ (ADMIN のみ表示) */}
            {user.roles.includes('ADMIN') && (
              <button
                onClick={() => setActiveTab('admin')}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === 'admin'
                    ? 'bg-blue-50 text-blue-700 font-semibold'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>権限管理・監査</span>
              </button>
            )}
          </nav>

          {/* ユーザー情報＆新規作成ボタン＆ログアウト */}
          <div className="flex items-center gap-4">
            {showNewApplication && (
              <button
                onClick={onOpenNewModal}
                className="bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-1.5 rounded-lg text-sm font-medium shadow-sm transition-all flex items-center gap-1.5"
              >
                <span>＋ 新規申請</span>
              </button>
            )}

            <div className="border-l border-slate-200 pl-4 flex items-center gap-3">
              <div className="text-right">
                <div className="text-xs font-semibold text-slate-800">{user.displayName}</div>
                <div className="text-[11px] text-slate-500 flex items-center justify-end gap-1">
                  <span>{user.department}</span>
                  <span className="bg-slate-100 text-slate-700 px-1.5 py-0.2 rounded text-[10px] font-medium border border-slate-200">
                    {user.roles.join(', ')}
                  </span>
                </div>
              </div>

              {onOpenPasswordModal && (
                <button
                  onClick={onOpenPasswordModal}
                  title="パスワード変更"
                  className="text-slate-400 hover:text-blue-600 p-1.5 rounded-lg hover:bg-blue-50 transition-colors"
                >
                  <Key className="w-4 h-4" />
                </button>
              )}

              <button
                onClick={onLogout}
                title="ログアウト"
                className="text-slate-400 hover:text-rose-600 p-1.5 rounded-lg hover:bg-rose-50 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

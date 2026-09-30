import React from 'react';
import { StatusBadge } from '../StatusBadge';
import { ApplicationStatus } from '../../types';
import { UserCheck, User as UserIcon, Building } from 'lucide-react';

export interface ApplicationDetailHeaderProps {
  id: number;
  version: number;
  title: string;
  typeName: string;
  currentStatus: ApplicationStatus | string;
  createdAt: string;
  subjectUserName?: string;
  subjectDepartment?: string | null;
  submissionActorType?: string | null;
  proxyUserName?: string | null;
  currentStepName?: string | null;
  secondaryStatusBadge?: {
    label: string;
    variant: 'rose' | 'amber';
  } | null;
}

/**
 * ApplicationDetailHeader
 * 
 * Applicationの基本属性（ヘッダー事実、ステータス、対象者・操作者メタデータ）を表示する純粋Presentationコンポーネント。
 * 
 * 【Architecture Invariants】
 * 1. Read-Only Presentation: 独自の業務ルール判定や権限判定を行わない。
 * 2. Visual Parity: 既存ヘッダー領域のレイアウト・バッジ・スタイルを完全維持。
 * 3. No API Mutation: 状態変更やAPI呼び出しを行わない。
 */
export const ApplicationDetailHeader: React.FC<ApplicationDetailHeaderProps> = ({
  id,
  version,
  title,
  typeName,
  currentStatus,
  createdAt,
  subjectUserName,
  subjectDepartment,
  submissionActorType,
  proxyUserName,
  currentStepName,
  secondaryStatusBadge,
}) => {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs px-2.5 py-0.5 rounded font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
              {typeName || '服務申請'}
            </span>
            <StatusBadge status={currentStatus as ApplicationStatus} currentStepName={currentStepName} />
            {secondaryStatusBadge && (
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${
                  secondaryStatusBadge.variant === 'rose'
                    ? 'bg-rose-100 text-rose-800 border-rose-300'
                    : 'bg-amber-100 text-amber-800 border-amber-300'
                }`}
              >
                {secondaryStatusBadge.label}
              </span>
            )}
            {submissionActorType === 'PROXY' && (
              <span className="text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-300 flex items-center gap-1">
                <UserCheck className="w-3 h-3" />
                <span>代理申請: {proxyUserName}</span>
              </span>
            )}
          </div>
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
        </div>
        <div className="text-right text-xs text-slate-500">
          <p>申請番号: APP-{id}</p>
          <p>バージョン: v{version}</p>
          <p>作成日時: {new Date(createdAt).toLocaleString('ja-JP')}</p>
        </div>
      </div>

      {/* 申請者・対象者プロファイル */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs">
        <div>
          <span className="text-slate-500 block mb-0.5">申請対象教職員 (Subject)</span>
          <span className="font-bold text-slate-900 flex items-center gap-1">
            <UserIcon className="w-3.5 h-3.5 text-slate-400" />
            {subjectUserName || '-'}
          </span>
        </div>
        <div>
          <span className="text-slate-500 block mb-0.5">所属部署・学年</span>
          <span className="font-semibold text-slate-800 flex items-center gap-1">
            <Building className="w-3.5 h-3.5 text-slate-400" />
            {subjectDepartment || '教務部'}
          </span>
        </div>
        <div>
          <span className="text-slate-500 block mb-0.5">操作主体 (Actor)</span>
          <span className="text-slate-700">
            {submissionActorType === 'PROXY' ? `代理提出: ${proxyUserName}` : '本人直接申請'}
          </span>
        </div>
      </div>
    </div>
  );
};

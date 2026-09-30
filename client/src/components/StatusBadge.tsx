import React from 'react';
import { ApplicationStatus } from '../types';

interface Props {
  status: ApplicationStatus;
  currentStepName?: string | null;
  labelOverride?: string | null;
}

export const StatusBadge: React.FC<Props> = ({ status, currentStepName, labelOverride }) => {
  // Priority 1: Explicit Override or Authoritative Current Step Presentation
  if (labelOverride) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-300">
        {labelOverride}
      </span>
    );
  }

  if (currentStepName && (status === 'SUBMITTED' || status === 'FIRST_APPROVED' || status === 'SECOND_APPROVED')) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300">
        {currentStepName}待ち
      </span>
    );
  }

  // Priority 2: Generic Non-Guessing Fallback (No Guessing on Role or Step Order)
  switch (status) {
    case 'DRAFT':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-300">下書き</span>;
    case 'SUBMITTED':
    case 'FIRST_APPROVED':
    case 'SECOND_APPROVED':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300">審査中</span>;
    case 'TRIP_APPROVED':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800 border border-indigo-300">旅行命令発令済 (復命待ち)</span>;
    case 'REPORT_SUBMITTED':
    case 'REPORT_FIRST_APPROVED':
    case 'REPORT_SECOND_APPROVED':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-800 border border-teal-300">復命 審査中</span>;
    case 'FINAL_APPROVED':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">決裁完了</span>;
    case 'RETURNED':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-800 border border-rose-300">差戻し (要修正)</span>;
    case 'REJECTED':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 border border-red-300">却下</span>;
    case 'WITHDRAWN':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 border border-gray-300">取下げ済</span>;
    case 'CANCELLED':
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-200 text-slate-700 border border-slate-400">取消決裁済 (無効)</span>;
    default:
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">{status}</span>;
  }
};

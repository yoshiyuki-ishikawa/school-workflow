import React from 'react';
import { UserLeaveSummary } from '../types';
import { Calendar, Clock, HeartPulse, Sparkles, Briefcase, Award } from 'lucide-react';

interface Props {
  summary: UserLeaveSummary;
  title?: string;
  compact?: boolean;
}

export const LeaveSummaryWidget: React.FC<Props> = ({
  summary,
  title = '現在の休暇等累計・年休残数 (第9号様式 休暇簿)',
  compact = false,
}) => {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
          <Award className="w-4 h-4 text-blue-600" />
          <span>{title}</span>
        </h3>
        <span className="text-[11px] text-slate-500">
          ※ 1日 = 7時間45分換算 (勤務時間: 8:10〜16:40)
        </span>
      </div>

      <div className={`p-4 grid grid-cols-2 ${compact ? 'md:grid-cols-2' : 'md:grid-cols-4'} gap-3 text-xs`}>
        {/* 年休 (残数＆累計) */}
        <div className="bg-blue-50/70 border border-blue-200 p-3 rounded-xl col-span-2 md:col-span-1">
          <div className="flex items-center justify-between text-blue-800 font-semibold mb-1">
            <span className="flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-blue-600" />
              年次有給休暇 (年休)
            </span>
            <span className="text-[10px] bg-blue-200/60 px-1.5 py-0.2 rounded text-blue-900 font-mono">
              付与{summary.annualLeave.initialDays}日
            </span>
          </div>
          <div className="mt-2 space-y-1">
            <div className="flex justify-between items-baseline">
              <span className="text-slate-500 text-[11px]">残日数:</span>
              <span className="font-bold text-base text-blue-700 font-mono">
                {summary.annualLeave.remaining.formatted || '20日 0時間 0分'}
              </span>
            </div>
            <div className="flex justify-between items-baseline text-[11px] pt-1 border-t border-blue-100">
              <span className="text-slate-500">取得累計:</span>
              <span className="font-semibold text-slate-700 font-mono">
                {summary.annualLeave.used.formatted || '0日 0時間 0分'}
              </span>
            </div>
          </div>
        </div>

        {/* 病気休暇 */}
        <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl">
          <div className="text-slate-700 font-semibold mb-1 flex items-center gap-1">
            <HeartPulse className="w-3.5 h-3.5 text-rose-500" />
            病気休暇 (病休)
          </div>
          <div className="mt-2">
            <div className="text-slate-500 text-[11px] mb-0.5">取得累計:</div>
            <div className="font-bold text-sm text-slate-800 font-mono">
              {summary.sickLeave.formatted || '0日 0時間 0分'}
            </div>
          </div>
        </div>

        {/* 特別休暇 */}
        <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl">
          <div className="text-slate-700 font-semibold mb-1 flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            特別休暇 (特休)
          </div>
          <div className="mt-2">
            <div className="text-slate-500 text-[11px] mb-0.5">取得累計:</div>
            <div className="font-bold text-sm text-slate-800 font-mono">
              {summary.specialLeave.formatted || '0日 0時間 0分'}
            </div>
          </div>
        </div>

        {/* 職専免等 */}
        <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl">
          <div className="text-slate-700 font-semibold mb-1 flex items-center gap-1">
            <Briefcase className="w-3.5 h-3.5 text-emerald-600" />
            職専免等
          </div>
          <div className="mt-2">
            <div className="text-slate-500 text-[11px] mb-0.5">取得累計:</div>
            <div className="font-bold text-sm text-slate-800 font-mono">
              {summary.dutyExempt.formatted || '0日 0時間 0分'}
            </div>
          </div>
        </div>

        {/* 介護休暇・介護時間 (無給・減額) */}
        {(summary.careLeave?.totalMinutes || 0) > 0 && (
          <div className="bg-purple-50/70 border border-purple-200 p-3 rounded-xl">
            <div className="text-purple-800 font-semibold mb-1 flex items-center justify-between">
              <span>介護休暇 (無給)</span>
              <span className="text-[10px] bg-purple-200/60 px-1 py-0.2 rounded text-purple-900 font-mono">通算6か月</span>
            </div>
            <div className="mt-2">
              <div className="text-slate-500 text-[11px] mb-0.5">取得累計:</div>
              <div className="font-bold text-sm text-purple-900 font-mono">
                {summary.careLeave?.formatted || '0分'}
              </div>
            </div>
          </div>
        )}

        {(summary.careTime?.totalMinutes || 0) > 0 && (
          <div className="bg-purple-50/70 border border-purple-200 p-3 rounded-xl">
            <div className="text-purple-800 font-semibold mb-1 flex items-center justify-between">
              <span>介護時間 (無給)</span>
              <span className="text-[10px] bg-purple-200/60 px-1 py-0.2 rounded text-purple-900 font-mono">1日最大2h</span>
            </div>
            <div className="mt-2">
              <div className="text-slate-500 text-[11px] mb-0.5">取得累計:</div>
              <div className="font-bold text-sm text-purple-900 font-mono">
                {summary.careTime?.formatted || '0分'}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

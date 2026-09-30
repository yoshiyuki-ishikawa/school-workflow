import React from 'react';
import { Heart, User, Calendar, Info } from 'lucide-react';

export interface CareDetailViewProps {
  formData: Record<string, any>;
  careCases?: any[];
  carePeriods?: any[];
}

/**
 * CareDetailView
 * 
 * 介護休暇・介護部分休業（条例第15条・第16条）に関する申請 Fact および関連ケース情報を Read-Only 表示する。
 * 
 * 【Architecture Invariant】
 * 1. Historical Fact vs Institutional Summary: 今回申請に保存された Fact を正本とし、マスター情報は補助情報として表示。
 * 2. Silent Drop = 0: 介護関連キーを漏れなく可視化。
 */
export const CareDetailView: React.FC<CareDetailViewProps> = ({
  formData,
  careCases = [],
  carePeriods = [],
}) => {
  const data = formData || {};

  const careCaseId = data.careCaseId || data.selectedCareCaseId;
  const carePeriodId = data.carePeriodId || data.selectedCarePeriodId;

  // マスターから該当ケース・期間を探索
  const currentCase = careCases.find((c) => String(c.id) === String(careCaseId));
  const currentPeriod = carePeriods.find((p) => String(p.id) === String(carePeriodId));

  const recipientRelation = data.careRecipientRelation || currentCase?.recipient_relation;
  const recipientName = data.careRecipientName || currentCase?.recipient_name;
  const conditionSummary = data.careConditionSummary || currentCase?.condition_summary;

  return (
    <div className="border border-purple-200 rounded-xl overflow-hidden bg-white shadow-xs">
      <div className="bg-purple-50/80 border-b border-purple-200 px-4 py-2.5 font-bold text-purple-950 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5">
          <Heart className="w-4 h-4 text-purple-600" />
          <span>要介護者・介護状況（条例第15条・第16条）</span>
        </span>
        <span className="text-[10px] px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-300 font-medium">
          介護関連情報
        </span>
      </div>

      <div className="p-4 space-y-3.5 text-xs sm:text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <span className="text-xs text-slate-500 block mb-0.5">介護対象家族 (続柄・氏名)</span>
            <span className="font-bold text-slate-900 flex items-center gap-1">
              <User className="w-4 h-4 text-purple-500 shrink-0" />
              {recipientName ? `${recipientRelation || '家族'}: ${recipientName}` : `ケースID: ${careCaseId || '（未選択）'}`}
            </span>
          </div>

          <div>
            <span className="text-xs text-slate-500 block mb-0.5">通算指定期間枠</span>
            <span className="font-semibold text-slate-800 flex items-center gap-1">
              <Calendar className="w-4 h-4 text-purple-500 shrink-0" />
              {currentPeriod
                ? `第${currentPeriod.period_number}期: ${currentPeriod.start_date} 〜 ${currentPeriod.end_date} (残${currentPeriod.remaining_days}日)`
                : carePeriodId
                ? `期間枠ID: ${carePeriodId}`
                : '（期間枠の指定なし）'}
            </span>
          </div>

          {conditionSummary && (
            <div className="sm:col-span-2">
              <span className="text-xs text-slate-500 block mb-0.5">要介護状態・事由概要</span>
              <p className="text-xs text-slate-700 bg-purple-50/50 p-2.5 rounded-lg border border-purple-100">
                {conditionSummary}
              </p>
            </div>
          )}
        </div>

        {/* 制度解説注記 */}
        <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] text-slate-600 flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
          <span>
            介護休暇・部分休業は対象家族1人につき通算93日（3回まで分割可能）の範囲内で取得可能です。
          </span>
        </div>
      </div>
    </div>
  );
};

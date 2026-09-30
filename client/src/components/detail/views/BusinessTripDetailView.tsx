import React from 'react';
import { MapPin, Calendar, Car, FileCheck2, Award, AlertCircle, FileText } from 'lucide-react';

export interface BusinessTripDetailViewProps {
  formData: Record<string, any>;
  hasConflict?: boolean;
}

/**
 * BusinessTripDetailView
 * 
 * GAP-03 出張計画 Fact および復命書（事後報告）Actual Fact を分離して型安全に Read-Only 表示する。
 * 
 * 【Architecture Invariant】
 * 1. Plan vs Actual: 申請時の出張計画と復命書提出時の実績を混同せず、独立カードとして描画。
 * 2. Silent Drop = 0: 計画キーおよび復命実績キーを余さず可視化。
 * 3. No Mutation: 復命書の作成・編集・認可判定は行わず、保存された Fact のみを描画。
 */
export const BusinessTripDetailView: React.FC<BusinessTripDetailViewProps> = ({
  formData,
  hasConflict,
}) => {
  const data = formData || {};

  // 1. 出張計画 Fact (Planned Facts)
  const purpose = data.purpose || data.reason || '（未設定）';
  const destination = data.destination || data.venue || '（未設定）';
  const transport = data.transport || data.transportationMethod || '公用車';
  const transportOther = data.transportOther;
  const departurePlace = data.departurePlace || '本校';
  const arrivalPlace = data.arrivalPlace || '本校';
  const privateCarReason = data.privateCarReason;
  const fundingSource = data.fundingSource;
  const fundingSourceOther = data.fundingSourceOther;
  const isExpenseClaimed = Boolean(data.isExpenseClaimed);
  const isOralOrder = Boolean(data.isOralOrder);
  const oralOrderIssuedAt = data.oralOrderIssuedAt;
  const startDate = data.startDate || data.targetDate;
  const endDate = data.endDate || startDate;
  const calculatedDays = data.calculatedDays || 1;

  // 2. 復命書事後実績 Fact (Post-Trip Actual Facts: GAP-03)
  const hasReport = Boolean(data.reportDate || data.reportResult);
  const reportDate = data.reportDate;
  const reportResult = data.reportResult;
  const reportRemarks = data.reportRemarks;
  const actualMatchesPlan = data.actualMatchesPlan;
  const actualDeparturePlace = data.actualDeparturePlace;
  const actualArrivalPlace = data.actualArrivalPlace;
  const actualTransportMode = data.actualTransportMode;
  const vehicleUsageType = data.vehicleUsageType;
  const actualDistanceKm = data.actualDistanceKm;
  const communicationCostBorne = data.communicationCostBorne;
  const travelExpenseRemarks = data.travelExpenseRemarks;

  return (
    <div className="space-y-4">
      {/* 計画 Fact カード */}
      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-xs">
        <div className="bg-slate-50/80 border-b border-slate-200 px-4 py-2.5 font-bold text-slate-800 flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5">
            <MapPin className="w-4 h-4 text-rose-500" />
            <span>出張計画・用務日程</span>
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium">
            公務旅行計画
          </span>
        </div>

        <div className="p-4 space-y-3.5 text-xs sm:text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-slate-500 block mb-0.5">用務</span>
              <span className="font-bold text-slate-900 flex items-center gap-1">
                <FileText className="w-4 h-4 text-indigo-500 shrink-0" />
                {purpose}
              </span>
            </div>

            <div>
              <span className="text-xs text-slate-500 block mb-0.5">用務地・出張先</span>
              <span className="font-bold text-slate-900 flex items-center gap-1">
                <MapPin className="w-4 h-4 text-rose-500 shrink-0" />
                {destination}
              </span>
            </div>

            <div>
              <span className="text-xs text-slate-500 block mb-0.5">交通機関・移動手段</span>
              <span className="font-semibold text-slate-800">
                {transport}{transport === 'その他' && transportOther ? ` (${transportOther})` : ''}
              </span>
            </div>

            <div>
              <span className="text-xs text-slate-500 block mb-0.5">出張期間</span>
              <span className="font-bold text-slate-900 flex items-center gap-1">
                <Calendar className="w-4 h-4 text-indigo-500 shrink-0" />
                {startDate ? `${startDate} 〜 ${endDate} (${calculatedDays}日間)` : '（未設定）'}
              </span>
            </div>

            <div>
              <span className="text-xs text-slate-500 block mb-0.5">行程（出発地 / 帰着地）</span>
              <span className="font-medium text-slate-800">
                {departurePlace} 発 ➔ {arrivalPlace} 着
              </span>
            </div>

            {fundingSource && (
              <div>
                <span className="text-xs text-slate-500 block mb-0.5">旅費財源</span>
                <span className="font-semibold text-slate-800">
                  {fundingSource}{fundingSource === 'その他' && fundingSourceOther ? ` (${fundingSourceOther})` : ''}
                </span>
              </div>
            )}
          </div>

          {/* 自家用車公務使用の特記 */}
          {transport === '自家用車' && (
            <div className="p-3 bg-amber-50/80 border border-amber-200 rounded-lg space-y-1">
              <span className="text-xs font-bold text-amber-900 flex items-center gap-1">
                <Car className="w-3.5 h-3.5" />
                <span>自家用車公務使用</span>
              </span>
              <p className="text-xs text-amber-800">
                使用理由: {privateCarReason || '（理由の記載なし）'}
              </p>
            </div>
          )}

          {/* 口頭命令・旅費請求フラグ */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100 text-xs">
            {isExpenseClaimed && (
              <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded border border-slate-200 font-medium">
                旅費請求あり
              </span>
            )}
            {isOralOrder && (
              <span className="px-2 py-0.5 bg-amber-100 text-amber-900 rounded border border-amber-300 font-semibold flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                <span>口頭命令による先行出張 {oralOrderIssuedAt && `(命令日時: ${oralOrderIssuedAt})`}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 復命実績 Fact カード (GAP-03: 提出済の場合) */}
      {hasReport && (
        <div className="border border-emerald-300 bg-emerald-50/30 rounded-xl overflow-hidden shadow-xs">
          <div className="bg-emerald-100/80 border-b border-emerald-300 px-4 py-2.5 font-bold text-emerald-900 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <Award className="w-4 h-4 text-emerald-700" />
              <span>出張復命書（研修・公務結果及び実績報告）</span>
            </span>
            <span className="text-xs font-medium text-emerald-800">
              復命日: {reportDate || '（未記載）'}
            </span>
          </div>

          <div className="p-4 space-y-3.5 text-xs sm:text-sm">
            <div>
              <span className="text-xs text-emerald-900 font-bold block mb-1">【結果及び状況】</span>
              <p className="text-slate-900 whitespace-pre-wrap leading-relaxed bg-white p-3 rounded-lg border border-emerald-200">
                {reportResult || '（記載なし）'}
              </p>
            </div>

            {reportRemarks && (
              <div>
                <span className="text-xs text-emerald-800 font-semibold block mb-0.5">復命備考</span>
                <p className="text-xs text-slate-700">{reportRemarks}</p>
              </div>
            )}

            {/* GAP-03 旅行実績情報 */}
            <div className="p-3 bg-white border border-emerald-200 rounded-lg space-y-2 text-xs">
              <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                <span className="font-bold text-slate-800">旅行実績（計画との一致性）</span>
                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                  actualMatchesPlan === true
                    ? 'bg-emerald-100 text-emerald-800'
                    : actualMatchesPlan === false
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-slate-100 text-slate-600'
                }`}>
                  {actualMatchesPlan === true ? '当初計画どおり実施' : actualMatchesPlan === false ? '差異・変更あり' : '未記録'}
                </span>
              </div>

              {actualMatchesPlan === false && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-700 pt-1">
                  <div>実出発地: <strong className="text-slate-900">{actualDeparturePlace || '本校'}</strong></div>
                  <div>実帰着地: <strong className="text-slate-900">{actualArrivalPlace || '本校'}</strong></div>
                  <div>実交通手段: <strong className="text-slate-900">{actualTransportMode || '-'}</strong></div>
                </div>
              )}

              {/* 自家用車実績 */}
              {(actualTransportMode === '自家用車' || transport === '自家用車') && (vehicleUsageType || actualDistanceKm) && (
                <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-3 text-slate-700">
                  {vehicleUsageType && (
                    <span>区分: <strong>{vehicleUsageType === 'DRIVER' ? '運転者' : '同乗者'}</strong></span>
                  )}
                  {actualDistanceKm !== undefined && actualDistanceKm !== '' && (
                    <span>実走行距離: <strong className="font-mono">{actualDistanceKm} km</strong></span>
                  )}
                </div>
              )}

              {/* 通信運送費・特記事項 */}
              <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between text-slate-700">
                <span>通信運送費実費負担: <strong>{communicationCostBorne ? '負担あり（領収書提出）' : '負担なし'}</strong></span>
                {travelExpenseRemarks && <span>旅費特記: {travelExpenseRemarks}</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

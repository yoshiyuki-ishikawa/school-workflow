import React, { useState, useEffect } from 'react';
import { Award } from 'lucide-react';

export interface BusinessTripReportPayload {
  reportDate: string;
  reportResult: string;
  reportRemarks?: string;
  actualMatchesPlan: boolean;
  actualDeparturePlace?: string;
  actualArrivalPlace?: string;
  actualTransportMode?: string;
  vehicleUsageType?: 'DRIVER' | 'PASSENGER' | '';
  actualDistanceKm?: number;
  communicationCostBorne?: boolean | null;
  actualTripStartAt?: string;
  actualTripEndAt?: string;
  travelExpenseRemarks?: string;
}

export interface BusinessTripReportModalProps {
  isOpen: boolean;
  defaultTransport?: string;
  actionLoading?: boolean;
  onClose: () => void;
  onSubmit: (payload: BusinessTripReportPayload) => Promise<void>;
}

/**
 * BusinessTripReportModal
 * 
 * 出張復命書（結果及び状況報告）および旅行実績情報（GAP-03 Actual Facts）を収集するモーダル。
 * 
 * 【Architecture Invariants】
 * 1. Plan Fact Isolation: 入力された実績値（Actual）は元の旅行計画（Plan）を Client 側で汚染・上書きしない。
 * 2. Strict Tri-State / Validation: 計画どおり実施かどうかの二者択一選択および必須項目バリデーションを完全維持。
 * 3. Intent Boundary: 構築した BusinessTripReportPayload を onSubmit に渡すのみ。
 */
export const BusinessTripReportModal: React.FC<BusinessTripReportModalProps> = ({
  isOpen,
  defaultTransport = '公用車',
  actionLoading = false,
  onClose,
  onSubmit,
}) => {
  const [reportDate, setReportDate] = useState('');
  const [reportResult, setReportResult] = useState('');
  const [reportRemarks, setReportRemarks] = useState('');
  const [actualMatchesPlan, setActualMatchesPlan] = useState<boolean | null>(null);
  const [actualDeparturePlace, setActualDeparturePlace] = useState('');
  const [actualArrivalPlace, setActualArrivalPlace] = useState('');
  const [actualTransportMode, setActualTransportMode] = useState('');
  const [vehicleUsageType, setVehicleUsageType] = useState<'DRIVER' | 'PASSENGER' | ''>('');
  const [actualDistanceKm, setActualDistanceKm] = useState<string>('');
  const [communicationCostBorne, setCommunicationCostBorne] = useState<boolean | null>(null);
  const [actualTripStartAt, setActualTripStartAt] = useState('');
  const [actualTripEndAt, setActualTripEndAt] = useState('');
  const [travelExpenseRemarks, setTravelExpenseRemarks] = useState('');

  useEffect(() => {
    if (isOpen) {
      setReportDate(new Date().toISOString().split('T')[0]);
      setReportResult('');
      setReportRemarks('');
      setActualMatchesPlan(null);
      setActualDeparturePlace('');
      setActualArrivalPlace('');
      setActualTransportMode('');
      setVehicleUsageType('');
      setActualDistanceKm('');
      setCommunicationCostBorne(null);
      setActualTripStartAt('');
      setActualTripEndAt('');
      setTravelExpenseRemarks('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!reportDate) {
      alert('復命年月日の入力は必須です');
      return;
    }
    if (!reportResult.trim()) {
      alert('復命の結果及び状況の記入は必須です');
      return;
    }
    if (actualMatchesPlan === null) {
      alert('「当初の旅行計画どおり実施」について「はい」または「いいえ（差異あり）」を選択してください');
      return;
    }
    if (actualMatchesPlan === false) {
      if (!actualDeparturePlace.trim()) {
        alert('実際に出発した場所（出発地）を入力してください');
        return;
      }
      if (!actualArrivalPlace.trim()) {
        alert('実際に帰着した場所（帰着地）を入力してください');
        return;
      }
      if (!actualTransportMode) {
        alert('実際の交通手段を選択してください');
        return;
      }
    }

    const payload: BusinessTripReportPayload = {
      reportDate,
      reportResult: reportResult.trim(),
      reportRemarks: reportRemarks.trim(),
      actualMatchesPlan: Boolean(actualMatchesPlan),
    };

    if (!actualMatchesPlan) {
      payload.actualDeparturePlace = actualDeparturePlace.trim();
      payload.actualArrivalPlace = actualArrivalPlace.trim();
      payload.actualTransportMode = actualTransportMode;
    }

    if (vehicleUsageType) {
      payload.vehicleUsageType = vehicleUsageType;
    }
    if (actualDistanceKm !== '') {
      payload.actualDistanceKm = Number(actualDistanceKm);
    }
    if (communicationCostBorne !== null) {
      payload.communicationCostBorne = communicationCostBorne;
    }
    if (actualTripStartAt) {
      payload.actualTripStartAt = actualTripStartAt;
    }
    if (actualTripEndAt) {
      payload.actualTripEndAt = actualTripEndAt;
    }
    if (travelExpenseRemarks.trim()) {
      payload.travelExpenseRemarks = travelExpenseRemarks.trim();
    }

    await onSubmit(payload);
  };

  const isCarUsage = actualMatchesPlan === false ? actualTransportMode === '自家用車' : defaultTransport === '自家用車';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
          <Award className="w-5 h-5 text-emerald-600" />
          <span>出張復命書（結果及び状況報告）の提出</span>
        </h3>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            復命年月日 <span className="text-red-500">*</span>
          </label>
          <input
            type="date"
            value={reportDate}
            onChange={(e) => setReportDate(e.target.value)}
            className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            研修・出張の結果及び状況 <span className="text-red-500">*</span>
          </label>
          <textarea
            rows={4}
            value={reportResult}
            onChange={(e) => setReportResult(e.target.value)}
            placeholder="研修内容、成果、協議事項などを具体的に記入してください"
            className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">備考</label>
          <input
            type="text"
            value={reportRemarks}
            onChange={(e) => setReportRemarks(e.target.value)}
            placeholder="資料添付の有無や伝達講習予定等"
            className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>

        {/* GAP-03: 旅行実績情報（Actual Facts）入力セクション */}
        <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
          <div>
            <label className="block text-xs font-bold text-slate-800 mb-1.5">
              当初の旅行計画どおり実施しましたか？ <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-4 text-xs font-medium text-slate-800">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="actualMatchesPlan"
                  checked={actualMatchesPlan === true}
                  onChange={() => {
                    setActualMatchesPlan(true);
                    setActualDeparturePlace('');
                    setActualArrivalPlace('');
                    setActualTransportMode('');
                  }}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
                <span>はい（計画どおり）</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="actualMatchesPlan"
                  checked={actualMatchesPlan === false}
                  onChange={() => setActualMatchesPlan(false)}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
                <span>いいえ（差異・変更あり）</span>
              </label>
            </div>
          </div>

          {actualMatchesPlan === false && (
            <div className="space-y-3 pt-2 border-t border-slate-200 animate-in fade-in duration-150">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    実出発地 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={actualDeparturePlace}
                    onChange={(e) => setActualDeparturePlace(e.target.value)}
                    placeholder="例: 本校 / 自宅"
                    className="w-full text-xs p-1.5 border border-slate-300 rounded-md bg-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    実帰着地 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={actualArrivalPlace}
                    onChange={(e) => setActualArrivalPlace(e.target.value)}
                    placeholder="例: 本校 / 自宅"
                    className="w-full text-xs p-1.5 border border-slate-300 rounded-md bg-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  実交通手段 <span className="text-red-500">*</span>
                </label>
                <select
                  value={actualTransportMode}
                  onChange={(e) => {
                    const val = e.target.value;
                    setActualTransportMode(val);
                    if (val !== '自家用車') {
                      setVehicleUsageType('');
                      setActualDistanceKm('');
                    }
                  }}
                  className="w-full text-xs p-1.5 border border-slate-300 rounded-md bg-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                >
                  <option value="">-- 選択してください --</option>
                  <option value="公用車">公用車</option>
                  <option value="自家用車">自家用車 (公務使用)</option>
                  <option value="公共交通機関">公共交通機関 (電車・バス)</option>
                  <option value="徒歩">徒歩・自転車</option>
                </select>
              </div>
            </div>
          )}

          {/* 実効交通手段が自家用車の場合の追加項目 */}
          {isCarUsage && (
            <div className="p-2.5 bg-amber-50/70 border border-amber-200 rounded-md space-y-2 text-xs animate-in fade-in duration-150">
              <span className="font-bold text-amber-900 block">自家用車公務使用 実績</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-amber-800 mb-1">運転・同乗区分</label>
                  <select
                    value={vehicleUsageType}
                    onChange={(e) => {
                      const val = e.target.value as 'DRIVER' | 'PASSENGER' | '';
                      setVehicleUsageType(val);
                      if (val === 'PASSENGER') {
                        setActualDistanceKm('');
                      }
                    }}
                    className="w-full text-xs p-1.5 border border-amber-300 rounded-md bg-white shadow-sm"
                  >
                    <option value="">未選択</option>
                    <option value="DRIVER">運転者 (走行距離入力)</option>
                    <option value="PASSENGER">同乗者 (走行距離不要)</option>
                  </select>
                </div>

                {vehicleUsageType === 'DRIVER' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-amber-800 mb-1">実走行距離 (km)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={actualDistanceKm}
                      onChange={(e) => setActualDistanceKm(e.target.value)}
                      placeholder="例: 24.5"
                      className="w-full text-xs p-1.5 border border-amber-300 rounded-md bg-white shadow-sm"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 通信運送費の実費負担有無 */}
          <div className="pt-2 border-t border-slate-200">
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              通信運送費（切手代・荷物送料等）の実費負担
            </label>
            <div className="flex gap-4 text-xs font-medium text-slate-800">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="communicationCostBorne"
                  checked={communicationCostBorne === false}
                  onChange={() => setCommunicationCostBorne(false)}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
                <span>負担なし</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="communicationCostBorne"
                  checked={communicationCostBorne === true}
                  onChange={() => setCommunicationCostBorne(true)}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
                <span>負担あり (領収書等を事務へ提出)</span>
              </label>
            </div>
          </div>

          {/* 旅費・実費等 備考 */}
          <div className="pt-2 border-t border-slate-200">
            <label className="block text-xs font-semibold text-slate-700 mb-1">旅費・実費特記事項（任意）</label>
            <input
              type="text"
              value={travelExpenseRemarks}
              onChange={(e) => setTravelExpenseRemarks(e.target.value)}
              placeholder="例: 高速道路利用、駐車料金等"
              className="w-full text-xs p-1.5 border border-slate-300 rounded-md bg-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            disabled={actionLoading}
            className="px-3.5 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={actionLoading}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm transition"
          >
            {actionLoading ? '提出中...' : '復命書を提出'}
          </button>
        </div>
      </div>
    </div>
  );
};

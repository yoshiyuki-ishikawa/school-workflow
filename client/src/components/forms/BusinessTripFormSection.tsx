import React from 'react';
import { MapPin, Calendar, AlertCircle, FileText, Compass, DollarSign } from 'lucide-react';

export interface BusinessTripFormProps {
  destination: string;
  setDestination: (val: string) => void;
  purpose: string;
  setPurpose: (val: string) => void;
  startDate: string;
  setStartDate: (val: string) => void;
  endDate: string;
  setEndDate: (val: string) => void;
  transport: string;
  setTransport: (val: string) => void;
  transportOther?: string;
  setTransportOther?: (val: string) => void;
  departurePlace: string;
  setDeparturePlace: (val: string) => void;
  arrivalPlace: string;
  setArrivalPlace: (val: string) => void;
  fundingSource?: string;
  setFundingSource?: (val: string) => void;
  fundingSourceOther?: string;
  setFundingSourceOther?: (val: string) => void;
  isOralOrder: boolean;
  setIsOralOrder: (val: boolean) => void;
  oralOrderIssuedAt: string;
  setOralOrderIssuedAt: (val: string) => void;
}

export const BusinessTripFormSection: React.FC<BusinessTripFormProps> = ({
  destination,
  setDestination,
  purpose,
  setPurpose,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  transport,
  setTransport,
  transportOther = '',
  setTransportOther,
  departurePlace,
  setDeparturePlace,
  arrivalPlace,
  setArrivalPlace,
  fundingSource = '県費',
  setFundingSource,
  fundingSourceOther = '',
  setFundingSourceOther,
  isOralOrder,
  setIsOralOrder,
  oralOrderIssuedAt,
  setOralOrderIssuedAt,
}) => {
  return (
    <div className="space-y-3.5 p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
      {/* 1. 用務先 & 2. 用務 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            出張先・用務場所 (用務地) <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <MapPin className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="例: 山口市教育センター研修棟"
              className="w-full pl-9 text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500 bg-white"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            出張用務名・用務内容 <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <FileText className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="例: 第1回教育研究会総会 出席"
              className="w-full pl-9 text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500 bg-white"
            />
          </div>
        </div>
      </div>

      {/* 3. 旅行期間 (日付のみ・時刻入力なし) */}
      <div className="p-2.5 bg-white border border-slate-200 rounded-md space-y-1.5">
        <label className="block text-xs font-semibold text-slate-700 flex items-center gap-1.5">
          <Calendar className="w-4 h-4 text-indigo-600" />
          <span>旅行期間 (年月日) <span className="text-red-500">*</span></span>
          <span className="text-[11px] text-slate-500 font-normal">※単日の場合は同日を指定</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              const val = e.target.value;
              setStartDate(val);
              if (!endDate || endDate < val) {
                setEndDate(val);
              }
            }}
            className="text-xs p-2 border border-slate-300 rounded-md bg-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500 flex-1"
          />
          <span className="text-xs text-slate-500 font-medium">〜</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            min={startDate}
            className="text-xs p-2 border border-slate-300 rounded-md bg-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500 flex-1"
          />
        </div>
      </div>

      {/* 4. 出発地 & 5. 帰着地 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
            <Compass className="w-3.5 h-3.5 text-slate-400" />
            <span>出発地 <span className="text-red-500">*</span></span>
          </label>
          <select
            value={departurePlace}
            onChange={(e) => setDeparturePlace(e.target.value)}
            className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500 bg-white"
          >
            <option value="本校">本校</option>
            <option value="自宅">自宅 (直行)</option>
            <option value="その他">その他</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
            <Compass className="w-3.5 h-3.5 text-slate-400" />
            <span>帰着地 <span className="text-red-500">*</span></span>
          </label>
          <select
            value={arrivalPlace}
            onChange={(e) => setArrivalPlace(e.target.value)}
            className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500 bg-white"
          >
            <option value="本校">本校</option>
            <option value="自宅">自宅 (直帰)</option>
            <option value="その他">その他</option>
          </select>
        </div>
      </div>

      {/* 6. 交通手段 & 7. 交通手段その他 */}
      <div className="space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              交通手段 (旅行方法) <span className="text-red-500">*</span>
            </label>
            <select
              value={transport}
              onChange={(e) => {
                const val = e.target.value;
                setTransport(val);
                if (val !== 'その他' && setTransportOther) {
                  setTransportOther('');
                }
              }}
              className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500 bg-white"
            >
              <option value="公用車">公用車</option>
              <option value="自家用車">自家用車 (公務使用承認)</option>
              <option value="公共交通機関">公共交通機関 (電車・バス等)</option>
              <option value="貸切バス">貸切バス</option>
              <option value="徒歩">徒歩</option>
              <option value="その他">その他</option>
            </select>
          </div>
          {transport === 'その他' && (
            <div>
              <label className="block text-xs font-semibold text-amber-900 mb-1">
                交通手段 (その他詳細) <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={transportOther}
                onChange={(e) => setTransportOther && setTransportOther(e.target.value)}
                placeholder="例: タクシー、船舶等"
                className="w-full text-sm border-amber-300 rounded-md shadow-sm focus:border-amber-500 focus:ring-amber-500 bg-amber-50/50"
              />
            </div>
          )}
        </div>
      </div>

      {/* 8. 旅費財源 & 9. 旅費財源その他 */}
      <div className="p-2.5 bg-slate-100/70 border border-slate-200 rounded-md space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
              <DollarSign className="w-3.5 h-3.5 text-slate-500" />
              <span>旅費財源 <span className="text-red-500">*</span></span>
            </label>
            <select
              value={fundingSource}
              onChange={(e) => {
                const val = e.target.value;
                if (setFundingSource) setFundingSource(val);
                if (val !== 'その他' && setFundingSourceOther) {
                  setFundingSourceOther('');
                }
              }}
              className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500 bg-white"
            >
              <option value="県費">県費</option>
              <option value="県費別枠">県費別枠</option>
              <option value="市費">市費</option>
              <option value="主催者負担">主催者負担</option>
              <option value="旅費不要">旅費不要</option>
              <option value="その他">その他</option>
            </select>
          </div>
          {fundingSource === 'その他' && (
            <div>
              <label className="block text-xs font-semibold text-amber-900 mb-1">
                旅費財源 (その他詳細) <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={fundingSourceOther}
                onChange={(e) => setFundingSourceOther && setFundingSourceOther(e.target.value)}
                placeholder="例: PTA会費、研究会負担等"
                className="w-full text-sm border-amber-300 rounded-md shadow-sm focus:border-amber-500 focus:ring-amber-500 bg-amber-50/50"
              />
            </div>
          )}
        </div>
      </div>

      {/* 12. 事前口頭発令出張の事後電算処理セクション */}
      <div className="p-2.5 bg-indigo-50/70 border border-indigo-200 rounded-md space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="isOralOrder"
            checked={isOralOrder}
            onChange={(e) => {
              const checked = e.target.checked;
              setIsOralOrder(checked);
              if (!checked) {
                setOralOrderIssuedAt('');
              }
            }}
            className="rounded text-indigo-600 focus:ring-indigo-500 h-4 w-4"
          />
          <label htmlFor="isOralOrder" className="text-xs font-bold text-indigo-950 cursor-pointer flex items-center gap-1">
            <span>緊急時等の事前口頭発令による出張（事後申請・事後電算処理）</span>
          </label>
        </div>

        {isOralOrder && (
          <div className="pl-6 space-y-1.5 animate-in fade-in duration-150">
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-indigo-900 whitespace-nowrap">
                事前口頭発令年月日 <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={oralOrderIssuedAt}
                onChange={(e) => setOralOrderIssuedAt(e.target.value)}
                className="text-xs p-1.5 border border-indigo-300 rounded-md bg-white shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
            </div>
            <p className="text-[11px] text-indigo-700 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>旅行命令権者（校長等）から事前に口頭で旅行命令を受けた年月日を記録します。</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
};


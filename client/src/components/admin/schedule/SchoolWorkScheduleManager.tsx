import React, { useState, useEffect } from 'react';
import { api, SchoolWorkSchedule } from '../../../services/api';
import {
  projectSchoolWorkSchedulePayload,
  calculateDayWorkMinutes,
  calculateWeeklyTotalMinutes,
  SchoolScheduleProjectionError,
  BreakIntervalInput,
  DayScheduleDetail,
} from '../../../utils/schoolWorkSchedulePayloadProjection';
import {
  Clock,
  Calendar,
  History,
  PlusCircle,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  Trash2,
  X,
  Info,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';

export interface SchoolWorkScheduleManagerProps {
  canManage?: boolean;
}

export const SchoolWorkScheduleManager: React.FC<SchoolWorkScheduleManagerProps> = ({
  canManage = true,
}) => {
  const [schedules, setSchedules] = useState<SchoolWorkSchedule[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 改定モーダル状態
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  // フォーム入力値
  const [formScheduleName, setFormScheduleName] = useState<string>('');
  const [formEffectiveFrom, setFormEffectiveFrom] = useState<string>('');
  const [formStartTime, setFormStartTime] = useState<string>('08:15');
  const [formEndTime, setFormEndTime] = useState<string>('16:45');
  const [formBreaks, setFormBreaks] = useState<BreakIntervalInput[]>([
    { startTime: '12:00', endTime: '12:45' },
  ]);

  // データロード
  const loadSchedules = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await api.getSchoolWorkSchedules();
      if (res.success && res.schedules) {
        setSchedules(res.schedules);
      } else {
        setFetchError('学校標準日課の取得に失敗しました');
      }
    } catch (err: any) {
      setFetchError(err.message || '学校標準日課の通信エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSchedules();
  }, []);

  // 現在有効な開区間日課の特定
  const currentSchedule = schedules.find(
    (s) => s.effective_to === '9999-12-31' && s.is_active === 1
  ) || schedules[0] || null;

  // モーダルオープン初期化
  const handleOpenCreateModal = () => {
    setFormError(null);
    setFormScheduleName('標準勤務日課');
    // デフォルト適用開始日（現在日課があればその開始日より後、なければ今日）
    if (currentSchedule) {
      const curDate = new Date(currentSchedule.effective_from);
      curDate.setFullYear(curDate.getFullYear() + 1);
      curDate.setMonth(3, 1); // 翌年度4月1日
      setFormEffectiveFrom(curDate.toISOString().split('T')[0]);
    } else {
      const now = new Date();
      setFormEffectiveFrom(now.toISOString().split('T')[0]);
    }
    setFormStartTime('08:15');
    setFormEndTime('16:45');
    setFormBreaks([{ startTime: '12:00', endTime: '12:45' }]);
    setIsModalOpen(true);
  };

  // 休憩時間帯の追加
  const handleAddBreak = () => {
    setFormBreaks([...formBreaks, { startTime: '', endTime: '' }]);
  };

  // 休憩時間帯の削除
  const handleRemoveBreak = (idx: number) => {
    setFormBreaks(formBreaks.filter((_, i) => i !== idx));
  };

  // 休憩時間帯の変更
  const handleBreakChange = (idx: number, field: 'startTime' | 'endTime', value: string) => {
    const updated = [...formBreaks];
    updated[idx] = { ...updated[idx], [field]: value };
    setFormBreaks(updated);
  };

  // リアルタイム週勤務時間のプレビュー計算
  let previewWeeklyMinutes: number | null = null;
  let previewDayMinutes: number | null = null;
  let previewCalculationError: string | null = null;

  try {
    if (formStartTime && formEndTime) {
      const validBreaks = formBreaks.filter((b) => b.startTime && b.endTime);
      previewDayMinutes = calculateDayWorkMinutes(formStartTime, formEndTime, validBreaks);
      previewWeeklyMinutes = calculateWeeklyTotalMinutes(formStartTime, formEndTime, validBreaks, '0,6');
    }
  } catch (err: any) {
    previewCalculationError = err.message;
  }

  // フォーム送信処理 (Pure Projection -> API POST -> GET Refresh)
  const handleSubmitNewRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);

    try {
      // 1. Pure Projection による Canonical Payload 生成 (Stateless Client Validation)
      const validBreaks = formBreaks.filter((b) => b.startTime && b.endTime);
      const payload = projectSchoolWorkSchedulePayload({
        scheduleName: formScheduleName,
        effectiveFrom: formEffectiveFrom,
        weeklyOffDays: '0,6',
        startTime: formStartTime,
        endTime: formEndTime,
        breakIntervals: validBreaks,
      });

      // 2. Existing Server API への POST (Server Authoritative Transaction)
      const res = await api.createSchoolWorkSchedule(payload);

      if (res.success) {
        setIsModalOpen(false);
        setSuccessMessage(`学校標準日課を新バージョンとして改定登録しました (日課ID: ${res.scheduleId})`);
        // 3. GET Refresh による Server Fact の再取得
        await loadSchedules();
      } else {
        // 4. Server エラーの提示 (400, 409等)
        setFormError(res.message || '学校標準日課の改定登録に失敗しました');
      }
    } catch (err: any) {
      if (err instanceof SchoolScheduleProjectionError) {
        setFormError(err.message);
      } else {
        setFormError(err.message || '通信エラーまたは予期しないエラーが発生しました');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // 日課詳細 JSON のパース表示ヘルパー
  const parseRepresentativeSchedule = (jsonStr: string): {
    startTime: string;
    endTime: string;
    breaks: string;
    dayMinutes: number;
  } => {
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, DayScheduleDetail>;
      // 月曜日 ('1') を代表日課として表示
      const mon = parsed['1'];
      if (!mon || !mon.isWorkDay) return { startTime: '-', endTime: '-', breaks: 'なし', dayMinutes: 0 };

      const intervals = mon.intervals || [];
      const startTime = mon.startTime || (intervals[0]?.startTime ?? '-');
      const endTime = mon.endTime || (intervals[intervals.length - 1]?.endTime ?? '-');

      // 休憩区間の抽出 (interval と interval の間)
      const breakStrs: string[] = [];
      for (let i = 0; i < intervals.length - 1; i++) {
        breakStrs.push(`${intervals[i].endTime}〜${intervals[i + 1].startTime}`);
      }

      return {
        startTime,
        endTime,
        breaks: breakStrs.length > 0 ? breakStrs.join(', ') : 'なし',
        dayMinutes: mon.workMinutes || 0,
      };
    } catch {
      return { startTime: '-', endTime: '-', breaks: '-', dayMinutes: 0 };
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden space-y-6 p-6">
      {/* ヘッダーエリア */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Clock className="w-5 h-5 text-indigo-600" />
            <span>学校標準勤務日課の管理 (School Default Daily Schedule)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            全教職員の基本となる公立学校の標準勤務時間を管理します。
            改定は過去の服務記録を保護するため、履歴を不可変に保全する有効期間（Effective-Dated）方式で新版が追加されます。
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            type="button"
            onClick={loadSchedules}
            disabled={loading}
            className="p-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition disabled:opacity-50"
            title="再読み込み"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-indigo-600' : ''}`} />
          </button>

          {canManage && (
            <button
              type="button"
              onClick={handleOpenCreateModal}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition shadow-sm"
            >
              <PlusCircle className="w-4 h-4" />
              <span>新しい標準日課を適用（改定）</span>
            </button>
          )}
        </div>
      </div>

      {/* メッセージ通知エリア */}
      {successMessage && (
        <div className="p-4 rounded-xl text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMessage(null)}
            className="text-emerald-600 hover:text-emerald-900"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {fetchError && (
        <div className="p-4 rounded-xl text-xs bg-rose-50 border border-rose-200 text-rose-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0" />
          <span>{fetchError}</span>
        </div>
      )}

      {/* 1. 現在有効な日課 (Current Active Schedule Card) */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5 uppercase tracking-wider">
          <ShieldCheck className="w-4 h-4 text-indigo-600" />
          <span>現在適用中の学校標準日課 (Current Active Schedule)</span>
        </h3>

        {loading && schedules.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
            日課情報を読み込み中...
          </div>
        ) : currentSchedule ? (
          (() => {
            const rep = parseRepresentativeSchedule(currentSchedule.schedule_details_json);
            return (
              <div className="bg-gradient-to-br from-indigo-50/60 via-slate-50 to-white p-5 rounded-xl border border-indigo-100 shadow-sm relative overflow-hidden">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2.5">
                      <span className="text-sm font-bold text-slate-900">{currentSchedule.schedule_name}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                        運用中 (開区間)
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        <span>適用期間: <strong>{currentSchedule.effective_from}</strong> 〜 <strong>{currentSchedule.effective_to === '9999-12-31' ? '現在 (無期限)' : currentSchedule.effective_to}</strong></span>
                      </span>
                      <span className="text-slate-300">|</span>
                      <span>定例週休日: <strong>日曜日・土曜日</strong></span>
                    </div>
                  </div>

                  {/* 勤務時間サマリーカード */}
                  <div className="flex items-center gap-3 bg-white p-3.5 rounded-xl border border-slate-200 shadow-xs">
                    <div className="text-center px-2">
                      <div className="text-[10px] text-slate-400 font-bold">基本勤務時間</div>
                      <div className="text-sm font-black text-indigo-700 mt-0.5">
                        {rep.startTime} 〜 {rep.endTime}
                      </div>
                    </div>
                    <div className="w-px h-8 bg-slate-200" />
                    <div className="text-center px-2">
                      <div className="text-[10px] text-slate-400 font-bold">休憩時間帯</div>
                      <div className="text-xs font-semibold text-slate-700 mt-0.5">
                        {rep.breaks}
                      </div>
                    </div>
                    <div className="w-px h-8 bg-slate-200" />
                    <div className="text-center px-2">
                      <div className="text-[10px] text-slate-400 font-bold">週総実働時間</div>
                      <div className="text-xs font-bold text-slate-800 mt-0.5">
                        38時間45分 <span className="text-[10px] text-slate-400">({currentSchedule.weekly_total_minutes}分)</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-indigo-100/60 flex items-center justify-between text-[11px] text-slate-400">
                  <span>登録日: {new Date(currentSchedule.created_at).toLocaleDateString('ja-JP')}</span>
                  {currentSchedule.created_by_user_name && (
                    <span>登録者: {currentSchedule.created_by_user_name}</span>
                  )}
                </div>
              </div>
            );
          })()
        ) : (
          <div className="p-8 text-center text-xs text-slate-500 bg-amber-50/50 rounded-xl border border-amber-200 flex flex-col items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-amber-500" />
            <span className="font-bold text-slate-800">学校標準日課が登録されていません</span>
            <p className="text-[11px] text-slate-500 max-w-md">
              教職員が「学校標準」を選択した勤務パターンを正常に機能させるため、最初の標準勤務日課を登録してください。
            </p>
          </div>
        )}
      </div>

      {/* 2. 改定履歴タイムライン / 一覧 (Revision History - Read-Only) */}
      <div className="space-y-3 pt-2">
        <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5 uppercase tracking-wider">
          <History className="w-4 h-4 text-slate-500" />
          <span>学校標準日課の改定履歴 (Revision History - 過去・将来の確定版)</span>
        </h3>

        {schedules.length === 0 ? (
          <div className="p-4 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-slate-200">
            履歴はありません
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 text-[11px] text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 font-semibold">日課名</th>
                  <th className="px-4 py-3 font-semibold">適用開始日</th>
                  <th className="px-4 py-3 font-semibold">適用終了日</th>
                  <th className="px-4 py-3 font-semibold">勤務時間帯</th>
                  <th className="px-4 py-3 font-semibold">週実働時間</th>
                  <th className="px-4 py-3 font-semibold">状態</th>
                  <th className="px-4 py-3 font-semibold">登録者 / 更新者</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {schedules.map((s) => {
                  const rep = parseRepresentativeSchedule(s.schedule_details_json);
                  const isCurrent = s.effective_to === '9999-12-31';

                  return (
                    <tr key={s.id} className={isCurrent ? 'bg-indigo-50/30 font-medium' : 'hover:bg-slate-50/60'}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span>{s.schedule_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono">{s.effective_from}</td>
                      <td className="px-4 py-3 font-mono">
                        {s.effective_to === '9999-12-31' ? (
                          <span className="text-indigo-600 font-bold">9999-12-31 (無期限)</span>
                        ) : (
                          s.effective_to
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span>{rep.startTime} 〜 {rep.endTime}</span>
                        <span className="text-slate-400 text-[10px] ml-1.5">(休: {rep.breaks})</span>
                      </td>
                      <td className="px-4 py-3">
                        <span>{s.weekly_total_minutes}分</span>
                        <span className="text-slate-400 text-[10px] ml-1">(38h45m)</span>
                      </td>
                      <td className="px-4 py-3">
                        {isCurrent ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                            現在運用中
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                            確定履歴 (閲覧のみ)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[11px] text-slate-500">
                        {s.created_by_user_name || '-'}
                        <div className="text-[10px] text-slate-400">
                          {new Date(s.created_at).toLocaleDateString('ja-JP')}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3. 新規改定モーダル (Create New Version Modal) */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-8">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-600" />
                <span>学校標準勤務日課の改定（新バージョン適用）</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitNewRevision} className="p-6 space-y-5">
              {/* 改定の説明アラート */}
              <div className="p-3.5 bg-indigo-50/70 border border-indigo-100 rounded-xl text-xs text-indigo-900 space-y-1">
                <div className="font-bold flex items-center gap-1.5">
                  <Info className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                  <span>有効期間による過去Fact保全契約 (Effective-Dated Versioning)</span>
                </div>
                <p className="text-[11px] text-indigo-800 leading-relaxed pl-5">
                  新日課を登録すると、現在の日課は新適用開始日の前日をもって自動的に終了します。
                  過去の出勤簿・年休計算・半日判定は、過去当時の確定日課を参照するため影響を受けません。
                </p>
              </div>

              {/* エラー表示 */}
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              {/* 日課名 */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  日課名称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={formScheduleName}
                  onChange={(e) => setFormScheduleName(e.target.value)}
                  placeholder="例: 令和8年度 標準勤務日課"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              {/* 適用開始日 */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  新適用開始日 (YYYY-MM-DD) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="date"
                  required
                  value={formEffectiveFrom}
                  onChange={(e) => setFormEffectiveFrom(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
                {currentSchedule && (
                  <p className="text-[11px] text-slate-400 mt-1">
                    ※ 現在有効な日課の開始日は <strong className="text-slate-600 font-mono">{currentSchedule.effective_from}</strong> です。
                    新開始日はこれ以降の日付を指定してください（同日または過去日はサーバー側で競合拒絶されます）。
                  </p>
                )}
              </div>

              {/* 勤務時間帯 (開始・終了) */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    勤務開始時刻 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="time"
                    required
                    value={formStartTime}
                    onChange={(e) => setFormStartTime(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    勤務終了時刻 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="time"
                    required
                    value={formEndTime}
                    onChange={(e) => setFormEndTime(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* 休憩時間帯 (複数対応) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-bold text-slate-700">
                    休憩時間帯 (Break Intervals)
                  </label>
                  <button
                    type="button"
                    onClick={handleAddBreak}
                    className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    <span>休憩時間を追加</span>
                  </button>
                </div>

                {formBreaks.length === 0 ? (
                  <div className="p-3 text-center text-xs text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                    休憩時間なし
                  </div>
                ) : (
                  <div className="space-y-2">
                    {formBreaks.map((brk, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="time"
                          value={brk.startTime}
                          onChange={(e) => handleBreakChange(idx, 'startTime', e.target.value)}
                          className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <span className="text-xs text-slate-400">〜</span>
                        <input
                          type="time"
                          value={brk.endTime}
                          onChange={(e) => handleBreakChange(idx, 'endTime', e.target.value)}
                          className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveBreak(idx)}
                          className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100 transition"
                          title="削除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* リアルタイム計算プレビュー */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="text-[11px] font-bold text-slate-500 flex items-center justify-between">
                  <span>実働時間リアルタイム計算プレビュー</span>
                  <span>法定基準: <strong>週38時間45分 (2,325分)</strong></span>
                </div>

                {previewCalculationError ? (
                  <div className="text-xs text-rose-600 font-medium">
                    ⚠ {previewCalculationError}
                  </div>
                ) : previewWeeklyMinutes !== null && previewDayMinutes !== null ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">1日の実働時間:</span>
                      <strong className="text-slate-800">
                        {Math.floor(previewDayMinutes / 60)}時間{previewDayMinutes % 60}分 ({previewDayMinutes}分)
                      </strong>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">週総実働時間 (月〜金 5日):</span>
                      <strong className="text-slate-900 font-mono text-sm">
                        {Math.floor(previewWeeklyMinutes / 60)}時間{previewWeeklyMinutes % 60}分 ({previewWeeklyMinutes}分)
                      </strong>
                    </div>

                    {previewWeeklyMinutes === 2325 ? (
                      <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-bold flex items-center gap-1.5">
                        <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                        <span>週38時間45分（法定標準時間）に完全に適合しています</span>
                      </div>
                    ) : (
                      <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[11px] font-bold flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                        <span>
                          法定週時間（2,325分）と一致していません（差分: {previewWeeklyMinutes - 2325 > 0 ? '+' : ''}{previewWeeklyMinutes - 2325}分）。
                          登録には厳格に2,325分一致が必須です。
                        </span>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              {/* アクションボタン */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={submitting}
                  className="px-4 py-2 border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-xl text-xs font-bold transition disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={submitting || previewWeeklyMinutes !== 2325}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>改定中...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4" />
                      <span>新日課を適用・改定登録</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

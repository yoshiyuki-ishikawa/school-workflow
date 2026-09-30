import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { User, MonthlyAttendanceData, AttendanceDayCell } from '../types';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Printer,
  CheckCircle2,
  AlertCircle,
  PlusCircle,
  Clock,
  ArrowRight,
  Award,
  RefreshCw,
  ExternalLink,
  Shield,
  Trash2,
  AlertTriangle,
  Info,
  Check,
  X,
  Unlock,
} from 'lucide-react';

import { HankoStamp } from '../components/HankoStamp';
import { OfficialFormModal } from '../components/OfficialFormModal';
import { CalendarImportModal } from '../components/CalendarImportModal';

interface Props {
  currentUser: User;
  onSelectApplication: (id: number) => void;
}

export const AttendanceBookPage: React.FC<Props> = ({ currentUser, onSelectApplication }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number>(currentUser.id);
  const [yearMonth, setYearMonth] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  const [data, setData] = useState<MonthlyAttendanceData | null>(null);
  const [adjustments, setAdjustments] = useState<any[]>([]);
  const [schoolName, setSchoolName] = useState<string>('学校');
  const [startDayOfWeek, setStartDayOfWeek] = useState<'MON' | 'SUN'>(() => {
    return (localStorage.getItem('attendance_start_day') as 'MON' | 'SUN') || 'MON';
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 帳票PDFモーダル
  const [isPdfModalOpen, setIsPdfModalOpen] = useState(false);

  // 服務調整 (振替) 登録モーダル
  const [isAdjModalOpen, setIsAdjModalOpen] = useState(false);
  const [scopeType, setScopeType] = useState<'ALL' | 'USER'>('ALL');
  const [adjustmentType, setAdjustmentType] = useState<'WEEK_OFF_TRANSFER' | 'SUBSTITUTE_HOLIDAY' | 'SINGLE_WORKDAY_OVERRIDE' | 'DESIGNATED_NON_WORKDAY'>('WEEK_OFF_TRANSFER');
  const [reasonCode, setReasonCode] = useState<'SCHOOL_EVENT' | 'CLUB_ACTIVITY' | 'OFFICIAL_DUTY' | 'SCHOOL_DESIGNATED_HOLIDAY' | 'OTHER_AUTHORIZED'>('SCHOOL_EVENT');
  const [authorityBasis, setAuthorityBasis] = useState('学校職員服務規程');
  const [sourceDate, setSourceDate] = useState('');
  const [sourceDutyStatus, setSourceDutyStatus] = useState<'WORK_REQUIRED' | 'NO_WORK_REQUIRED'>('WORK_REQUIRED');
  const [targetDate, setTargetDate] = useState('');
  const [targetDutyStatus, setTargetDutyStatus] = useState<'WORK_REQUIRED' | 'NO_WORK_REQUIRED'>('NO_WORK_REQUIRED');
  const [eventName, setEventName] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjSaving, setAdjSaving] = useState(false);

  // GAP-01: 日課オーバーライド設定 State
  const [enableScheduleOverride, setEnableScheduleOverride] = useState(false);
  const [overrideStartTime, setOverrideStartTime] = useState('08:10');
  const [overrideEndTime, setOverrideEndTime] = useState('16:40');
  const [overrideBreaks, setOverrideBreaks] = useState<Array<{ startTime: string; endTime: string }>>([
    { startTime: '12:15', endTime: '13:00' },
  ]);

  // 調整解除ダイアログ用ステート
  const [selectedAdjustment, setSelectedAdjustment] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelLoading, setCancelLoading] = useState(false);

  // 欠勤登録・訂正モーダル用ステート
  const [isAbsenceModalOpen, setIsAbsenceModalOpen] = useState(false);
  const [absenceType, setAbsenceType] = useState<'FULL_DAY' | 'HOURLY'>('FULL_DAY');
  const [absenceTargetDate, setAbsenceTargetDate] = useState('');
  const [absenceStartTime, setAbsenceStartTime] = useState('08:10');
  const [absenceEndTime, setAbsenceEndTime] = useState('16:40');
  const [absenceReason, setAbsenceReason] = useState('');
  const [absenceSaving, setAbsenceSaving] = useState(false);

  // 欠勤事後訂正モーダル用ステート
  const [isCorrectModalOpen, setIsCorrectModalOpen] = useState(false);
  const [selectedAbsence, setSelectedAbsence] = useState<any | null>(null);
  const [correctTargetType, setCorrectTargetType] = useState<'LEAVE_ANNUAL' | 'LEAVE_SICK' | 'LEAVE_SPECIAL' | 'LEAVE_DUTY_EXEMPT' | 'OTHER'>('LEAVE_ANNUAL');
  const [correctReason, setCorrectReason] = useState('');
  const [correctAppId, setCorrectAppId] = useState<string>('');
  const [correctSaving, setCorrectSaving] = useState(false);

  // 年間カレンダー一括インポートモーダル (Wave 5: GAP-05)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  // 校長月次確定
  const [confirmComment, setConfirmComment] = useState('');
  const [confirmLoading, setConfirmLoading] = useState(false);

  const canManage =
    currentUser.roles.includes('ADMIN') ||
    currentUser.roles.includes('VICE_PRINCIPAL') ||
    currentUser.roles.includes('PRINCIPAL');

  // カレンダー一括インポート・管理操作を行えるUI利便性判定 (UI convenience only)
  const canImportCalendar = canManage || currentUser.roles.includes('OFFICE');

  // 他職員の出勤簿セレクタを操作できる権限 (事務係も閲覧可能)
  const canViewOthers = canManage || currentUser.roles.includes('OFFICE');

  const isPrincipal = currentUser.roles.includes('PRINCIPAL');

  useEffect(() => {
    if (canViewOthers) {
      api.getPocUsers()
        .then((res) => setUsers(res.users))
        .catch(() => {});
    }
  }, [canViewOthers]);

  const fetchData = () => {
    setLoading(true);
    setError('');
    Promise.all([
      api.getMonthlyAttendance(selectedUserId, yearMonth),
      api.getCalendarAdjustments({ yearMonth, userId: selectedUserId }).catch(() => ({ adjustments: [] })),
      api.getPublicSettings().catch(() => ({ success: false, data: null })),
    ])
      .then(([attRes, adjRes, setRes]) => {
        setData(attRes.data);
        setAdjustments(adjRes.adjustments || []);
        if (setRes.data?.schoolName) {
          setSchoolName(setRes.data.schoolName);
        }
      })
      .catch((err) => setError(err.message || '出勤簿データの取得に失敗しました'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, [selectedUserId, yearMonth]);

  // 前月 / 次月
  const handlePrevMonth = () => {
    const [y, m] = yearMonth.split('-').map(Number);
    const prev = new Date(y, m - 2, 1);
    setYearMonth(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
  };

  const handleNextMonth = () => {
    const [y, m] = yearMonth.split('-').map(Number);
    const next = new Date(y, m, 1);
    setYearMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  };

  // 振替種別切替時のデフォルト設定
  const handleAdjTypeChange = (type: typeof adjustmentType) => {
    setAdjustmentType(type);
    if (type === 'WEEK_OFF_TRANSFER') {
      setSourceDutyStatus('WORK_REQUIRED');
      setTargetDutyStatus('NO_WORK_REQUIRED');
      setReasonCode('SCHOOL_EVENT');
    } else if (type === 'SUBSTITUTE_HOLIDAY') {
      setSourceDutyStatus('WORK_REQUIRED');
      setTargetDutyStatus('NO_WORK_REQUIRED');
      setReasonCode('SCHOOL_EVENT');
    } else if (type === 'SINGLE_WORKDAY_OVERRIDE') {
      setSourceDutyStatus('WORK_REQUIRED');
      setTargetDate('');
      setReasonCode('SCHOOL_EVENT');
    } else if (type === 'DESIGNATED_NON_WORKDAY') {
      setSourceDutyStatus('NO_WORK_REQUIRED');
      setTargetDate('');
      setReasonCode('SCHOOL_DESIGNATED_HOLIDAY');
    }
  };

  // セルクリック時の振替登録・詳細オープン
  const handleCellClick = (d: any) => {
    if (d.applicationId) {
      onSelectApplication(d.applicationId);
      return;
    }
    if (d.absenceInfo && canManage) {
      setSelectedAbsence({
        id: d.absenceInfo.absenceId,
        target_date: d.date,
        absence_type: d.absenceInfo.absenceType,
        start_time: d.hourlyEvents?.[0]?.startTime || '08:10',
        end_time: d.hourlyEvents?.[0]?.endTime || '16:40',
        reason: d.absenceInfo.reason || '欠勤記録',
      });
      setCorrectReason('');
      setCorrectAppId('');
      setIsCorrectModalOpen(true);
      return;
    }
    if (d.adjustment && canManage) {
      setSelectedAdjustment(d.adjustment);
      setCancelReason('');
      return;
    }
    if (canManage) {
      setSourceDate(d.date);
      setTargetDate('');
      setEventName('');
      setAdjReason('');
      setAdjustmentType(d.isWeekend || d.isHoliday ? 'WEEK_OFF_TRANSFER' : 'DESIGNATED_NON_WORKDAY');
      handleAdjTypeChange(d.isWeekend || d.isHoliday ? 'WEEK_OFF_TRANSFER' : 'DESIGNATED_NON_WORKDAY');
      setEnableScheduleOverride(false);
      setOverrideStartTime('08:10');
      setOverrideEndTime('16:40');
      setOverrideBreaks([{ startTime: '12:15', endTime: '13:00' }]);
      setIsAdjModalOpen(true);
    }
  };

  // GAP-01: プレビュー用の計算 (Client Preview Only / Non-Authoritative)
  const calculatePreviewMinutes = () => {
    if (!overrideStartTime || !overrideEndTime) return null;
    const [sh, sm] = overrideStartTime.split(':').map(Number);
    const [eh, em] = overrideEndTime.split(':').map(Number);
    const s = (sh || 0) * 60 + (sm || 0);
    const e = (eh || 0) * 60 + (em || 0);
    if (s >= e) return { error: '始業時刻は終業時刻より前である必要があります' };

    let breakMins = 0;
    for (const b of overrideBreaks) {
      if (!b.startTime || !b.endTime) continue;
      const [bsh, bsm] = b.startTime.split(':').map(Number);
      const [beh, bem] = b.endTime.split(':').map(Number);
      const bs = (bsh || 0) * 60 + (bsm || 0);
      const be = (beh || 0) * 60 + (bem || 0);
      if (bs >= be) return { error: '休憩開始時刻は休憩終了時刻より前である必要があります' };
      if (bs < s || be > e) return { error: '休憩時間は勤務時間帯の内側に設定してください' };
      breakMins += (be - bs);
    }

    const netWork = (e - s) - breakMins;
    if (netWork <= 0) return { error: '実労働時間が0分以下です' };
    const hours = Math.floor(netWork / 60);
    const mins = netWork % 60;
    return { netWork, display: `${hours}時間${mins > 0 ? mins + '分' : ''} (${netWork}分)` };
  };

  // 服務調整の保存
  const handleSaveAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceDate || !eventName.trim() || !adjReason.trim()) {
      alert('日付、行事名、理由は必須です');
      return;
    }

    if (enableScheduleOverride && sourceDutyStatus === 'WORK_REQUIRED') {
      const preview = calculatePreviewMinutes();
      if (preview?.error) {
        alert(`勤務日課の設定が不正です: ${preview.error}`);
        return;
      }
    }

    setAdjSaving(true);
    try {
      await api.createCalendarAdjustment({
        scopeType,
        userId: scopeType === 'USER' ? selectedUserId : undefined,
        adjustmentType,
        reasonCode,
        authorityBasis,
        sourceDate,
        sourceDutyStatus,
        targetDate: targetDate || undefined,
        targetDutyStatus: targetDate ? targetDutyStatus : undefined,
        eventName,
        reason: adjReason,
        scheduleOverride: enableScheduleOverride && sourceDutyStatus === 'WORK_REQUIRED' ? {
          startTime: overrideStartTime,
          endTime: overrideEndTime,
          breakIntervals: overrideBreaks.filter(b => b.startTime && b.endTime),
        } : undefined,
      });
      setIsAdjModalOpen(false);
      fetchData();
    } catch (err: any) {
      alert(`服務調整登録エラー: ${err.message}`);
    } finally {
      setAdjSaving(false);
    }
  };

  // 全校一括調整から特定教職員のみの個別例外（免除・別日振替）登録へ遷移
  const handleOpenIndividualExemption = (adj: any) => {
    setSelectedAdjustment(null);
    setScopeType('USER');
    const sDate = adj.sourceDate || adj.source_date;
    const tDate = adj.targetDate || adj.target_date;
    const isPaired = Boolean(tDate);
    const adjType = adj.adjustmentType || adj.adjustment_type;

    setSourceDate(sDate);
    setEventName(`【個人免除】${adj.eventName || adj.event_name}`);
    setAdjReason(`全校行事（${adj.eventName || adj.event_name}）の個別服務例外（通常勤務・週休復帰）`);
    setAuthorityBasis('学校職員服務規程');

    if (isPaired && (adjType === 'WEEK_OFF_TRANSFER' || adjType === 'SUBSTITUTE_HOLIDAY')) {
      // ペア振替の場合: 土日(source)を週休(免除)に戻し、平日(target)を通常勤務日に戻す
      setTargetDate(tDate);
      setAdjustmentType(adjType);
      setSourceDutyStatus('NO_WORK_REQUIRED'); // 土日は非勤務 (週休)
      setTargetDutyStatus('WORK_REQUIRED');   // 平日は勤務日 (通常勤務)
      setReasonCode('OFFICIAL_DUTY');
    } else {
      // 単日指定の場合
      setTargetDate('');
      const isWk = adj.source_duty_status === 'WORK_REQUIRED' || adj.sourceDutyStatus === 'WORK_REQUIRED';
      if (isWk) {
        setAdjustmentType('DESIGNATED_NON_WORKDAY');
        setSourceDutyStatus('NO_WORK_REQUIRED');
        setReasonCode('OFFICIAL_DUTY');
      } else {
        setAdjustmentType('SINGLE_WORKDAY_OVERRIDE');
        setSourceDutyStatus('WORK_REQUIRED');
        setReasonCode('OFFICIAL_DUTY');
      }
    }
    setIsAdjModalOpen(true);
  };

  // 服務調整の取消 (論理解除)
  const handleCancelAdjustment = async () => {
    if (!selectedAdjustment) return;
    const isAll = (selectedAdjustment.scopeType || selectedAdjustment.scope_type) === 'ALL';
    const confirmMsg = isAll
      ? `【警告: 全校一括解除】\n全校行事「${selectedAdjustment.eventName || selectedAdjustment.event_name}」の振替設定を学校全体で取り消しますか？\n（全職員の出勤簿が元の基礎カレンダー状態に復元されます）`
      : `服務調整「${selectedAdjustment.eventName || selectedAdjustment.event_name}」を取り消しますか？\n（元の基礎カレンダー状態に安全に復元されます）`;

    if (!confirm(confirmMsg)) return;

    setCancelLoading(true);
    try {
      await api.cancelCalendarAdjustment(selectedAdjustment.id, cancelReason || '管理者による解除');
      setSelectedAdjustment(null);
      fetchData();
    } catch (err: any) {
      alert(`取消エラー: ${err.message}`);
    } finally {
      setCancelLoading(false);
    }
  };

  // 校長確定サイン
  const handleConfirmAttendance = async () => {
    if (!confirm(`${yearMonth} の出勤簿を点検し、確定・承認サインを行いますか？`)) return;
    setConfirmLoading(true);
    try {
      await api.confirmMonthlyAttendance({
        userId: selectedUserId,
        yearMonth,
        comment: confirmComment || '出勤簿点検・確認済',
      });
      fetchData();
    } catch (err: any) {
      alert(`確定エラー: ${err.message}`);
    } finally {
      setConfirmLoading(false);
    }
  };

  // 校長確定解除
  const [isUnlockModalOpen, setIsUnlockModalOpen] = useState(false);
  const [unlockReason, setUnlockReason] = useState('');
  const [unlockLoading, setUnlockLoading] = useState(false);

  const handleUnlockAttendance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockReason.trim()) {
      alert('解除理由は必須です');
      return;
    }
    setUnlockLoading(true);
    try {
      await api.unlockMonthlyAttendance({
        userId: selectedUserId,
        yearMonth,
        reason: unlockReason,
      });
      setIsUnlockModalOpen(false);
      setUnlockReason('');
      fetchData();
    } catch (err: any) {
      alert(`確定解除エラー: ${err.message}`);
    } finally {
      setUnlockLoading(false);
    }
  };

  // 欠勤登録処理
  const handleAbsenceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!absenceTargetDate || !absenceReason.trim()) {
      alert('対象日と欠勤理由は必須です');
      return;
    }
    setAbsenceSaving(true);
    try {
      await api.createAbsence({
        userId: selectedUserId,
        absenceType,
        targetDate: absenceTargetDate,
        startTime: absenceType === 'HOURLY' ? absenceStartTime : undefined,
        endTime: absenceType === 'HOURLY' ? absenceEndTime : undefined,
        reason: absenceReason,
        status: 'CONFIRMED',
      });
      setIsAbsenceModalOpen(false);
      setAbsenceReason('');
      fetchData();
    } catch (err: any) {
      alert(`欠勤登録エラー: ${err.message}`);
    } finally {
      setAbsenceSaving(false);
    }
  };

  // 欠勤事後訂正処理
  const handleCorrectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAbsence || !correctReason.trim()) {
      alert('事後訂正の理由は必須です');
      return;
    }
    setCorrectSaving(true);
    try {
      await api.correctAbsenceToLeave(selectedAbsence.id, {
        correctionTargetType: correctTargetType,
        correctedApplicationId: correctAppId ? parseInt(correctAppId, 10) : undefined,
        correctionReason: correctReason,
      });
      setIsCorrectModalOpen(false);
      setSelectedAbsence(null);
      setCorrectReason('');
      setCorrectAppId('');
      fetchData();
    } catch (err: any) {
      alert(`事後訂正エラー: ${err.message}`);
    } finally {
      setCorrectSaving(false);
    }
  };

  const getStampClasses = (color?: string) => {
    switch (color) {
      case 'blue':
        return 'bg-blue-100 text-blue-800 border-blue-400 font-bold';
      case 'rose':
        return 'bg-rose-100 text-rose-800 border-rose-400 font-bold';
      case 'amber':
        return 'bg-amber-100 text-amber-900 border-amber-400 font-bold';
      case 'emerald':
        return 'bg-emerald-100 text-emerald-800 border-emerald-400 font-bold';
      case 'indigo':
        return 'bg-indigo-100 text-indigo-800 border-indigo-400 font-bold';
      case 'purple':
        return 'bg-purple-100 text-purple-800 border-purple-400 font-bold';
      case 'teal':
        return 'bg-teal-100 text-teal-900 border-teal-400 font-bold';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-300';
    }
  };

  const [year, month] = yearMonth.split('-').map(Number);

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
      {/* 1. 操作コントロールバー */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap justify-between items-center gap-4">
        {/* 年月セレクター */}
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrevMonth}
            className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1.5 font-bold text-slate-800 text-base font-mono">
            <Calendar className="w-5 h-5 text-blue-600" />
            <span>
              {year}年 {month}月
            </span>
          </div>
          <button
            onClick={handleNextMonth}
            className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* 教職員切替 (管理職・事務用) */}
        {canViewOthers && users.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-slate-600">対象教職員:</span>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(Number(e.target.value))}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium"
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.department})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* アクションボタン群 */}
        <div className="flex items-center gap-2">
          {/* 開始曜日切替 (月曜始まり / 日曜始まり) */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
            <button
              onClick={() => {
                setStartDayOfWeek('MON');
                localStorage.setItem('attendance_start_day', 'MON');
              }}
              className={`px-2.5 py-1 rounded-md font-bold transition ${
                startDayOfWeek === 'MON'
                  ? 'bg-white text-indigo-700 shadow-2xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              月曜始まり
            </button>
            <button
              onClick={() => {
                setStartDayOfWeek('SUN');
                localStorage.setItem('attendance_start_day', 'SUN');
              }}
              className={`px-2.5 py-1 rounded-md font-bold transition ${
                startDayOfWeek === 'SUN'
                  ? 'bg-white text-indigo-700 shadow-2xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              日曜始まり
            </button>
          </div>

          {canImportCalendar && (
            <button
              onClick={() => setIsImportModalOpen(true)}
              className="px-3 py-1.5 border border-purple-200 bg-purple-50 hover:bg-purple-100 text-purple-800 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors"
              title="年間行事計画CSVの一括インポート・競合確認"
            >
              <PlusCircle className="w-3.5 h-3.5 text-purple-600" />
              <span>年間行事一括インポート</span>
            </button>
          )}

          {canManage && (
            <>
              <button
                onClick={() => {
                  setSourceDate(`${yearMonth}-01`);
                  setTargetDate('');
                  setEventName('');
                  setAdjReason('');
                  setAdjustmentType('WEEK_OFF_TRANSFER');
                  handleAdjTypeChange('WEEK_OFF_TRANSFER');
                  setIsAdjModalOpen(true);
                }}
                className="px-3 py-1.5 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>勤務日・週休・代休振替</span>
              </button>

              <button
                onClick={() => {
                  setAbsenceTargetDate(`${yearMonth}-01`);
                  setAbsenceType('FULL_DAY');
                  setAbsenceReason('');
                  setIsAbsenceModalOpen(true);
                }}
                className="px-3 py-1.5 border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors"
              >
                <PlusCircle className="w-3.5 h-3.5 text-rose-600" />
                <span>欠勤記録</span>
              </button>
            </>
          )}

          <button
            onClick={() => setIsPdfModalOpen(true)}
            className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm transition"
          >
            <Printer className="w-3.5 h-3.5 text-indigo-400" />
            <span>出勤簿 A4印刷 / PDF</span>
          </button>

          <button
            onClick={fetchData}
            className="p-1.5 border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 rounded-lg shadow-xs"
            title="再読み込み"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {data?.hasUnknownPattern && (
        <div className="bg-amber-50 border-2 border-amber-400 text-amber-900 p-4 rounded-xl text-xs flex items-start gap-3 shadow-xs">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-sm block text-amber-950">【警告】勤務パターン未設定の日が存在します (Fail-Closed)</span>
            <p className="mt-1 leading-relaxed">
              当月の一部または全日に勤務時間パターンの割り振りが設定されていないため、安全措置として未確定（不明）として表示しています。
              管理設定メニューから該当教職員への勤務パターン（通常勤務・育児短時間等）の割当を行ってください。未設定状態のままでは校長月次確定（ロック）は実行できません。
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 p-4 rounded-xl text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 2. 出勤簿本体 (Server-Authoritative) */}
      {data && (
        <div className="bg-white rounded-2xl border border-slate-300 shadow-sm overflow-hidden print:border-none print:shadow-none">
          {/* 出勤簿ヘッダー */}
          <div className="p-6 border-b border-slate-200 bg-slate-50/50 flex flex-wrap justify-between items-center gap-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <span>{year}年 {month}月 出勤簿</span>
                <span className="text-xs font-normal text-slate-500 font-mono">
                  ({schoolName})
                </span>
              </h2>
            </div>

            <div className="flex items-center gap-6 text-xs">
              <div className="text-right">
                <span className="text-slate-500 block text-[11px]">職名・氏名:</span>
                <span className="font-bold text-slate-900 text-sm flex items-center justify-end gap-1">
                  {(!data.userJobTitle || data.userJobTitle === '（職名未設定）') ? (
                    <span className="text-rose-600 font-bold bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded text-xs">
                      （正式職名未設定）
                    </span>
                  ) : (
                    <span>{data.userJobTitle}</span>
                  )}
                  <span>{data.userName}</span>
                </span>
                <span className="text-slate-400 text-[11px] block">{data.userDepartment}</span>
              </div>

              {/* 校長確認印 */}
              <div className="border border-slate-300 rounded-xl p-2.5 bg-white text-center min-w-[120px] shadow-xs">
                <div className="text-[10px] font-semibold text-slate-500 mb-1 border-b border-slate-200 pb-0.5">
                  所属長 (校長) 確認
                </div>
                {data.approval.status === 'CONFIRMED' ? (
                  <div className="text-red-600 py-1">
                    <div className="inline-block border-2 border-red-600 rounded-full px-2.5 py-0.5 text-xs font-bold font-mono tracking-wider rotate-[-5deg]">
                      決裁済
                    </div>
                    <div className="text-[9px] text-slate-400 mt-1">
                      {data.approval.confirmedByUserName}
                    </div>
                  </div>
                ) : (
                  <div className="text-slate-400 text-[11px] py-2 font-mono">
                    未確定
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* カレンダーグリッド (月曜始まり / 日曜始まり 対応) */}
          <div className="p-6 space-y-3">
            {/* 曜日ヘッダー行 */}
            <div className="grid grid-cols-7 gap-2.5 text-center text-xs font-bold font-mono">
              {startDayOfWeek === 'MON' ? (
                <>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">月</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">火</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">水</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">木</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">金</div>
                  <div className="py-1 bg-blue-100 text-blue-700 rounded-lg">土</div>
                  <div className="py-1 bg-rose-100 text-rose-700 rounded-lg">日</div>
                </>
              ) : (
                <>
                  <div className="py-1 bg-rose-100 text-rose-700 rounded-lg">日</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">月</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">火</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">水</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">木</div>
                  <div className="py-1 bg-slate-100 text-slate-700 rounded-lg">金</div>
                  <div className="py-1 bg-blue-100 text-blue-700 rounded-lg">土</div>
                </>
              )}
            </div>

            {/* 日付セルグリッド */}
            <div className="grid grid-cols-7 gap-2.5">
              {/* 月初日のオフセット空セル */}
              {(() => {
                const firstDayDate = new Date(year, month - 1, 1);
                const firstDayOfWeekIdx = firstDayDate.getDay(); // 0: 日, 1: 月, ..., 6: 土
                let leadingEmptyCount = 0;
                if (startDayOfWeek === 'MON') {
                  leadingEmptyCount = (firstDayOfWeekIdx + 6) % 7;
                } else {
                  leadingEmptyCount = firstDayOfWeekIdx;
                }

                return Array.from({ length: leadingEmptyCount }).map((_, idx) => (
                  <div
                    key={`empty-${idx}`}
                    className="min-h-[110px] p-2.5 rounded-xl border border-dashed border-slate-200 bg-slate-50/40 opacity-40"
                  />
                ));
              })()}

              {data.days.map((d) => {
                const isSun = d.dayOfWeek === '日';
                const isSat = d.dayOfWeek === '土';

                return (
                  <div
                    key={d.day}
                    onClick={() => handleCellClick(d)}
                    className={`min-h-[110px] p-2.5 rounded-xl border flex flex-col justify-between transition-all cursor-pointer hover:ring-2 hover:ring-indigo-400 ${
                      d.adjustment
                        ? 'bg-teal-50/50 border-teal-300 shadow-2xs'
                        : isSun || d.isHoliday
                        ? 'bg-rose-50/40 border-rose-200'
                        : isSat
                        ? 'bg-blue-50/30 border-blue-200'
                        : 'bg-white border-slate-200'
                    }`}
                  >
                    {/* 上部: 日付 ＆ 曜日 ＆ 法的属性 */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <span className="font-bold text-sm font-mono text-slate-800">
                          {d.day}
                        </span>
                        {d.isHoliday && (
                          <span className="text-[9px] px-1 py-0.2 bg-rose-100 text-rose-700 rounded font-medium">
                            祝
                          </span>
                        )}
                      </div>
                      <span
                        className={`text-xs font-bold font-mono ${
                          isSun || d.isHoliday
                            ? 'text-rose-600'
                            : isSat
                            ? 'text-blue-600'
                            : 'text-slate-500'
                        }`}
                      >
                        ({d.dayOfWeek})
                      </span>
                    </div>

                    {/* 中央: 略号印スタンプ (複数スタンプ対応) */}
                    <div className="my-1 flex flex-col items-center justify-center">
                      {d.stamps && d.stamps.length > 1 ? (
                        <div className="flex flex-col gap-1 items-center w-full">
                          {d.stamps.slice(0, 2).map((st, idx) => (
                            <div
                              key={idx}
                              className={`inline-flex items-center justify-center gap-1 px-1.5 py-0.5 rounded border text-[10px] shadow-2xs w-full max-w-[100px] ${getStampClasses(
                                st.color
                              )}`}
                            >
                              <span className="font-bold">{st.text}</span>
                              {st.subText && (
                                <span className="text-[8px] font-mono truncate max-w-[40px]">
                                  {st.subText}
                                </span>
                              )}
                              {idx === 1 && d.stamps && d.stamps.length > 2 && (
                                <span className="text-[8px] bg-slate-700 text-white rounded-full px-1 leading-tight font-bold">
                                  +{d.stamps.length - 2}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : d.stampText ? (
                        <div
                          className={`inline-flex flex-col items-center justify-center px-2 py-0.5 rounded-full border text-[11px] shadow-2xs ${getStampClasses(
                            d.stampColor
                          )}`}
                        >
                          <span>{d.stampText}</span>
                          {d.stampSubText && (
                            <span className="text-[9px] font-mono leading-none truncate max-w-[80px]">
                              {d.stampSubText}
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="text-[10px] text-slate-300 font-mono tracking-wider">
                          ―
                        </div>
                      )}
                    </div>

                    {/* 下部: 振替理由または申請リンク */}
                    <div className="text-[10px] text-slate-500 truncate text-center">
                      {d.applicationTitle ? (
                        <span className="text-blue-600 font-semibold flex items-center justify-center gap-0.5 hover:underline">
                          <ExternalLink className="w-2.5 h-2.5" />
                          #{d.applicationId}
                        </span>
                      ) : d.adjustment ? (
                        <span className="text-teal-700 font-semibold truncate block" title={d.adjustment.reason}>
                          {d.adjustment.eventName}
                        </span>
                      ) : d.holidayName ? (
                        <span className="text-rose-500 truncate block">{d.holidayName}</span>
                      ) : d.isWorkRequired ? (
                        <span className="text-slate-400">通常勤務</span>
                      ) : (
                        <span className="text-slate-300">週休</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 3. 月別集計表 (下部集計欄 ＆ ドメイン集計) */}
          <div className="p-6 bg-slate-50 border-t border-slate-200 space-y-4">
            <div>
              <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Calendar className="w-4 h-4 text-blue-600" />
                <span>月次集計欄 (公文書確定値)</span>
              </h3>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-10 gap-2 text-xs">
                <div className="bg-white p-2.5 rounded-xl border border-slate-200 text-center">
                  <span className="text-slate-500 text-[11px] block">実働勤務日数</span>
                  <span className="font-bold text-sm text-slate-800 font-mono">
                    {data.summary.workdayCount} 日
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-slate-200 text-center">
                  <span className="text-slate-500 text-[11px] block">週休日数</span>
                  <span className="font-bold text-sm text-slate-800 font-mono">
                    {data.summary.weekOffCount} 日
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-slate-200 text-center">
                  <span className="text-slate-500 text-[11px] block">休日・代休日数</span>
                  <span className="font-bold text-sm text-slate-800 font-mono">
                    {data.summary.holidayCount} 日
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-blue-200 text-center bg-blue-50/30">
                  <span className="text-blue-700 text-[11px] block">年次有給休暇</span>
                  <span className="font-bold text-xs text-blue-900 font-mono">
                    {data.summary.annualLeave?.formatted || '0分'}
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-rose-200 text-center bg-rose-50/30">
                  <span className="text-rose-700 text-[11px] block">病気休暇</span>
                  <span className="font-bold text-xs text-rose-900 font-mono">
                    {data.summary.sickLeave?.formatted || '0分'}
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-amber-200 text-center bg-amber-50/30">
                  <span className="text-amber-700 text-[11px] block">特別休暇</span>
                  <span className="font-bold text-xs text-amber-900 font-mono">
                    {data.summary.specialLeave?.formatted || '0分'}
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-amber-300 text-center bg-amber-50/50">
                  <span className="text-amber-800 text-[11px] font-bold block">介護休暇</span>
                  <span className="font-bold text-xs text-amber-900 font-mono">
                    {data.summary.careLeave?.formatted || '0日'}
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-emerald-200 text-center bg-emerald-50/30">
                  <span className="text-emerald-700 text-[11px] block">職務専念義務免除</span>
                  <span className="font-bold text-xs text-emerald-900 font-mono">
                    {data.summary.dutyExempt?.formatted || '0分'}
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-rose-300 text-center bg-rose-50/50">
                  <span className="text-rose-800 text-[11px] font-bold block">欠勤</span>
                  <span className="font-bold text-xs text-rose-900 font-mono">
                    {data.summary.absence?.formatted || '0日'}
                  </span>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-indigo-200 text-center bg-indigo-50/30">
                  <span className="text-indigo-700 text-[11px] block">出張 (日数/回数)</span>
                  <span className="font-bold text-xs text-indigo-900 font-mono">
                    {data.summary.businessTripDays}日 ({data.summary.businessTripCount}回)
                  </span>
                </div>
              </div>
            </div>

            {/* 当月適用中の服務調整一覧 */}
            {adjustments.length > 0 && (
              <div className="pt-3 border-t border-slate-200">
                <h4 className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 text-teal-600" />
                  <span>当月に適用されている服務調整・振替一覧</span>
                </h4>
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden divide-y divide-slate-100">
                  {adjustments.map((adj) => (
                    <div key={adj.id} className="p-3 flex items-center justify-between text-xs hover:bg-slate-50">
                      <div className="flex items-center gap-3">
                        <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                          adj.status === 'ACTIVE' ? 'bg-teal-100 text-teal-800' : 'bg-slate-200 text-slate-500 line-through'
                        }`}>
                          {adj.scope_type === 'ALL' ? '全校一括' : `${adj.target_user_name || '指定職員'}`}
                        </span>
                        <div>
                          <span className="font-bold text-slate-800">{adj.event_name}</span>
                          <span className="text-slate-500 text-[11px] ml-2">
                            {adj.source_date} ({adj.source_duty_status === 'WORK_REQUIRED' ? '勤務' : '免除'})
                            {adj.target_date && ` ⇄ ${adj.target_date} (${adj.target_duty_status === 'WORK_REQUIRED' ? '勤務' : '振替休'})`}
                          </span>
                        </div>
                      </div>
                      {canManage && adj.status === 'ACTIVE' && (
                        <button
                          onClick={() => {
                            setSelectedAdjustment(adj);
                            setCancelReason('');
                          }}
                          className="text-rose-600 hover:text-rose-800 text-[11px] font-semibold flex items-center gap-1 px-2 py-1 rounded hover:bg-rose-50"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>解除</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 4. 校長確定アクションバー */}
          {isPrincipal && (
            <div className="p-4 bg-slate-900 text-white flex flex-wrap justify-between items-center gap-4">
              <div className="flex items-center gap-2 text-xs">
                <Shield className="w-4 h-4 text-amber-400" />
                <span>校長権限：当月の出勤簿点検および決裁押印を行います</span>
              </div>

              {data.approval.status === 'CONFIRMED' ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 text-xs text-emerald-400 font-bold">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{data.approval.confirmedAt?.split('T')[0]} 決裁押印完了</span>
                  </div>
                  <button
                    onClick={() => {
                      setUnlockReason('');
                      setIsUnlockModalOpen(true);
                    }}
                    className="px-3 py-1 bg-rose-600/80 hover:bg-rose-600 text-white rounded-lg text-xs font-semibold flex items-center gap-1 transition shadow-xs"
                    title="確定状態を解除して再編集を許可します"
                  >
                    <Unlock className="w-3.5 h-3.5" />
                    <span>確定解除 (修正許可)</span>
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={confirmComment}
                    onChange={(e) => setConfirmComment(e.target.value)}
                    placeholder="点検コメント (任意)"
                    className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-xs focus:ring-1 focus:ring-amber-400 w-48"
                  />
                  <button
                    onClick={handleConfirmAttendance}
                    disabled={confirmLoading || !data.userJobTitle || data.userJobTitle === '（職名未設定）'}
                    title={(!data.userJobTitle || data.userJobTitle === '（職名未設定）') ? '正式職名が未登録のため月次確定できません (Fail-Closed)' : '出勤簿を確定・承認サイン'}
                    className={`px-4 py-1.5 rounded-lg text-xs font-bold shadow-sm transition flex items-center gap-1 ${
                      (!data.userJobTitle || data.userJobTitle === '（職名未設定）')
                        ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                        : 'bg-amber-500 hover:bg-amber-600 text-slate-950'
                    }`}
                  >
                    <Award className="w-3.5 h-3.5" />
                    <span>{confirmLoading ? '処理中...' : '出勤簿を確定・承認サイン'}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 5. 服務調整 (振替) 登録モーダル */}
      {isAdjModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full overflow-hidden border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-indigo-50">
              <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-indigo-600" />
                <span>服務調整・振替イベントの登録</span>
              </h3>
              <button onClick={() => setIsAdjModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveAdjustment} className="p-6 space-y-4 text-xs">
              {/* 適用範囲 */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  適用範囲 <span className="text-rose-500">*</span>
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="scope"
                      checked={scopeType === 'ALL'}
                      onChange={() => setScopeType('ALL')}
                    />
                    <span>全校一括 (学校行事・全員対象)</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="scope"
                      checked={scopeType === 'USER'}
                      onChange={() => setScopeType('USER')}
                    />
                    <span>指定職員のみ ({data?.userName})</span>
                  </label>
                </div>
              </div>

              {/* 振替種別 */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  調整種別 <span className="text-rose-500">*</span>
                </label>
                <select
                  value={adjustmentType}
                  onChange={(e) => handleAdjTypeChange(e.target.value as any)}
                  className="block w-full px-3 py-2 border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 font-medium"
                >
                  <option value="WEEK_OFF_TRANSFER">週休振替（土日行事勤務 ⇄ 平日振替休業日）</option>
                  <option value="SUBSTITUTE_HOLIDAY">代休指定（祝日等行事勤務 ⇄ 平日代休日）</option>
                  <option value="SINGLE_WORKDAY_OVERRIDE">単独勤務日指定（土日祝の特別出勤）</option>
                  <option value="DESIGNATED_NON_WORKDAY">根拠ある勤務免除（学校指定休日等）</option>
                </select>
              </div>

              {/* 日付ペア設定 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {adjustmentType === 'WEEK_OFF_TRANSFER' || adjustmentType === 'SUBSTITUTE_HOLIDAY' ? '勤務日 (元日)' : '対象日付'} <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={sourceDate}
                    onChange={(e) => setSourceDate(e.target.value)}
                    className="block w-full px-3 py-2 border border-slate-300 rounded-lg bg-white font-mono"
                  />
                </div>

                {(adjustmentType === 'WEEK_OFF_TRANSFER' || adjustmentType === 'SUBSTITUTE_HOLIDAY') && (
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">
                      {adjustmentType === 'WEEK_OFF_TRANSFER' ? '振替休日 (振替先)' : '代休日 (振替先)'} <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="date"
                      required
                      value={targetDate}
                      onChange={(e) => setTargetDate(e.target.value)}
                      className="block w-full px-3 py-2 border border-slate-300 rounded-lg bg-white font-mono"
                    />
                  </div>
                )}
              </div>

              {/* 行事名・理由 */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  行事名・件名 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  placeholder="例: 秋季大運動会 / オープンスクール / 開校記念日"
                  className="block w-full px-3 py-2 border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  事由・服務根拠 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={adjReason}
                  onChange={(e) => setAdjReason(e.target.value)}
                  placeholder="例: 運動会実施及びその週休振替"
                  className="block w-full px-3 py-2 border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* GAP-01: 日課オーバーライド設定 */}
              {sourceDutyStatus === 'WORK_REQUIRED' && (
                <div className="pt-2 border-t border-slate-100">
                  <label className="flex items-center gap-2 cursor-pointer font-bold text-slate-700">
                    <input
                      type="checkbox"
                      checked={enableScheduleOverride}
                      onChange={(e) => setEnableScheduleOverride(e.target.checked)}
                      className="rounded text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>勤務日課を個別変更する（日付オーバーライド）</span>
                  </label>

                  {enableScheduleOverride && (
                    <div className="mt-3 p-3 bg-indigo-50/50 rounded-xl border border-indigo-100 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">
                            勤務開始 (始業)
                          </label>
                          <input
                            type="time"
                            value={overrideStartTime}
                            onChange={(e) => setOverrideStartTime(e.target.value)}
                            className="block w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-mono text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">
                            勤務終了 (終業)
                          </label>
                          <input
                            type="time"
                            value={overrideEndTime}
                            onChange={(e) => setOverrideEndTime(e.target.value)}
                            className="block w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-mono text-xs"
                          />
                        </div>
                      </div>

                      {/* 休憩区間リスト */}
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-[11px] font-bold text-slate-600">休憩時間帯</label>
                          <button
                            type="button"
                            onClick={() => setOverrideBreaks([...overrideBreaks, { startTime: '12:00', endTime: '13:00' }])}
                            className="text-[11px] text-indigo-600 hover:text-indigo-800 font-bold"
                          >
                            ＋ 休憩を追加
                          </button>
                        </div>
                        {overrideBreaks.length === 0 ? (
                          <div className="text-[11px] text-slate-400 italic">休憩なし (連続勤務)</div>
                        ) : (
                          <div className="space-y-1.5">
                            {overrideBreaks.map((b, idx) => (
                              <div key={idx} className="flex items-center gap-2">
                                <input
                                  type="time"
                                  value={b.startTime}
                                  onChange={(e) => {
                                    const next = [...overrideBreaks];
                                    next[idx].startTime = e.target.value;
                                    setOverrideBreaks(next);
                                  }}
                                  className="px-2 py-1 border border-slate-300 rounded bg-white font-mono text-xs"
                                />
                                <span className="text-slate-400">〜</span>
                                <input
                                  type="time"
                                  value={b.endTime}
                                  onChange={(e) => {
                                    const next = [...overrideBreaks];
                                    next[idx].endTime = e.target.value;
                                    setOverrideBreaks(next);
                                  }}
                                  className="px-2 py-1 border border-slate-300 rounded bg-white font-mono text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={() => setOverrideBreaks(overrideBreaks.filter((_, i) => i !== idx))}
                                  className="text-rose-500 hover:text-rose-700 text-xs px-1"
                                  title="削除"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* プレビュー表示 (Client Preview Only / Non-Authoritative) */}
                      {(() => {
                        const preview = calculatePreviewMinutes();
                        if (!preview) return null;
                        if (preview.error) {
                          return (
                            <div className="text-[11px] text-rose-600 bg-rose-50 p-2 rounded border border-rose-200">
                              ⚠️ {preview.error}
                            </div>
                          );
                        }
                        return (
                          <div className="text-[11px] text-indigo-700 bg-indigo-100/60 px-2.5 py-1.5 rounded-lg flex items-center justify-between">
                            <span>実働予定 (プレビュー):</span>
                            <span className="font-bold font-mono">{preview.display}</span>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsAdjModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-100"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={adjSaving}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold shadow-xs flex items-center gap-1"
                >
                  <span>{adjSaving ? '保存中...' : '服務調整を登録する'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 6. 調整詳細 ＆ 安全な解除ダイアログ */}
      {selectedAdjustment && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Info className="w-4 h-4 text-teal-600" />
                <span>服務調整の詳細・解除</span>
              </h3>
              <button onClick={() => setSelectedAdjustment(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-3 text-xs">
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-1.5">
                <div>
                  <span className="text-slate-500">行事名:</span>{' '}
                  <strong>{selectedAdjustment.eventName || selectedAdjustment.event_name}</strong>
                </div>
                <div>
                  <span className="text-slate-500">対象日:</span>{' '}
                  <span className="font-mono font-bold">
                    {selectedAdjustment.sourceDate || selectedAdjustment.source_date}
                    {(selectedAdjustment.targetDate || selectedAdjustment.target_date)
                      ? ` ⇄ ${selectedAdjustment.targetDate || selectedAdjustment.target_date}`
                      : ''}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">事由:</span> {selectedAdjustment.reason}
                </div>
                <div>
                  <span className="text-slate-500">適用範囲:</span>{' '}
                  <span className="font-semibold">
                    {(selectedAdjustment.scopeType || selectedAdjustment.scope_type) === 'ALL'
                      ? '全校一括 (学校行事)'
                      : `指定教職員 (${selectedAdjustment.target_user_name || data?.userName || '個人'})`}
                  </span>
                </div>
              </div>

              {/* 全校一括設定の場合のガイダンス ＆ 個別免除アクション */}
              {(selectedAdjustment.scopeType || selectedAdjustment.scope_type) === 'ALL' ? (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
                  <div className="flex items-center gap-1.5 font-bold text-amber-900 text-xs">
                    <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                    <span>全校一括設定に対する操作選択</span>
                  </div>
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    全校設定を維持したまま、<strong>{data?.userName} 先生のみを個別に除外・免除</strong>する場合は下の青いボタンを押してください。学校行事そのものを取り消す場合のみ右下の赤いボタンを押してください。
                  </p>
                  <button
                    type="button"
                    onClick={() => handleOpenIndividualExemption(selectedAdjustment)}
                    className="w-full py-2 px-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold text-xs flex items-center justify-center gap-1.5 shadow-xs transition"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    <span>この職員（{data?.userName}）のみ個別に除外・免除する</span>
                  </button>
                </div>
              ) : (
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    解除理由 (監査証跡用)
                  </label>
                  <input
                    type="text"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder="例: 行事日程変更のため / 誤登録"
                    className="block w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  />
                </div>
              )}

              {/* 全校解除時の理由入力欄 */}
              {(selectedAdjustment.scopeType || selectedAdjustment.scope_type) === 'ALL' && (
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    全校一括解除の理由 (行事自体の中止・変更等)
                  </label>
                  <input
                    type="text"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder="例: 雨天による運動会順延・行事中止のため"
                    className="block w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  />
                </div>
              )}

              <div className="flex justify-between items-center pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setSelectedAdjustment(null)}
                  className="px-3 py-1.5 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-100"
                >
                  閉じる
                </button>
                <button
                  type="button"
                  onClick={handleCancelAdjustment}
                  disabled={cancelLoading}
                  className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold shadow-xs flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>
                    {cancelLoading
                      ? '解除中...'
                      : (selectedAdjustment.scopeType || selectedAdjustment.scope_type) === 'ALL'
                      ? '学校全体の振替を取り消す'
                      : '振替を解除する'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 公文書帳票 (出勤簿 A4 PDF) モーダル */}
      {isPdfModalOpen && (
        <OfficialFormModal
          isOpen={isPdfModalOpen}
          formType="ATTENDANCE"
          userId={selectedUserId}
          yearMonth={yearMonth}
          onClose={() => setIsPdfModalOpen(false)}
        />
      )}

      {/* 7. 校長確定解除モーダル */}
      {isUnlockModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-rose-50">
              <h3 className="text-sm font-bold text-rose-950 flex items-center gap-2">
                <Unlock className="w-4 h-4 text-rose-600" />
                <span>出勤簿の月次確定解除（再編集の許可）</span>
              </h3>
              <button onClick={() => setIsUnlockModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleUnlockAttendance} className="p-6 space-y-4 text-xs">
              <div className="p-3 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl space-y-1.5">
                <div className="font-bold flex items-center gap-1.5 text-xs text-amber-950">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>確定解除に伴う注意</span>
                </div>
                <p className="text-[11px] leading-relaxed text-amber-800">
                  対象職員（<strong>{data?.userName} 先生</strong>）の <strong>{yearMonth}</strong> 出勤簿のロックを一時的に解除します。
                  解除理由は監査ログに公文書修正履歴として永久記録されます。
                </p>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  確定解除・差戻し理由 <span className="text-rose-500">*</span>
                </label>
                <textarea
                  required
                  rows={3}
                  value={unlockReason}
                  onChange={(e) => setUnlockReason(e.target.value)}
                  placeholder="例: 9月25日の年休追加申請に伴う出勤簿差戻しのため"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500 text-xs"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsUnlockModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={unlockLoading}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl font-bold flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                >
                  <Unlock className="w-3.5 h-3.5" />
                  <span>{unlockLoading ? '解除中...' : '確定を解除する'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 8. 欠勤登録モーダル (管理職・事務用) */}
      {isAbsenceModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-rose-50">
              <h3 className="text-sm font-bold text-rose-950 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600" />
                <span>欠勤記録の登録 (管理職・事務)</span>
              </h3>
              <button onClick={() => setIsAbsenceModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAbsenceSubmit} className="p-6 space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">対象職員</label>
                <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200 font-semibold text-slate-800">
                  {data?.userName} ({data?.userDepartment})
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">欠勤区分 <span className="text-rose-500">*</span></label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setAbsenceType('FULL_DAY')}
                    className={`py-2 px-3 rounded-lg border font-bold text-center transition ${
                      absenceType === 'FULL_DAY'
                        ? 'bg-rose-50 border-rose-400 text-rose-800 shadow-2xs'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    全日欠勤 (1日)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAbsenceType('HOURLY')}
                    className={`py-2 px-3 rounded-lg border font-bold text-center transition ${
                      absenceType === 'HOURLY'
                        ? 'bg-rose-50 border-rose-400 text-rose-800 shadow-2xs'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    時間欠勤 (指定時間帯)
                  </button>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">対象日 <span className="text-rose-500">*</span></label>
                <input
                  type="date"
                  required
                  value={absenceTargetDate}
                  onChange={(e) => setAbsenceTargetDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500 text-xs"
                />
              </div>

              {absenceType === 'HOURLY' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">開始時刻 <span className="text-rose-500">*</span></label>
                    <input
                      type="time"
                      required
                      value={absenceStartTime}
                      onChange={(e) => setAbsenceStartTime(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">終了時刻 <span className="text-rose-500">*</span></label>
                    <input
                      type="time"
                      required
                      value={absenceEndTime}
                      onChange={(e) => setAbsenceEndTime(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500 text-xs"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  欠勤理由・状況 <span className="text-rose-500">*</span>
                </label>
                <textarea
                  required
                  rows={3}
                  value={absenceReason}
                  onChange={(e) => setAbsenceReason(e.target.value)}
                  placeholder="例: 私用による無届欠勤、交通障害による遅刻等"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500 text-xs"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAbsenceModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={absenceSaving}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl font-bold flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{absenceSaving ? '登録中...' : '欠勤を確定登録'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 9. 欠勤事後訂正モーダル (管理職・事務用) */}
      {isCorrectModalOpen && selectedAbsence && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-blue-50">
              <h3 className="text-sm font-bold text-blue-950 flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-blue-600" />
                <span>欠勤から休暇への事後訂正</span>
              </h3>
              <button onClick={() => setIsCorrectModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCorrectSubmit} className="p-6 space-y-4 text-xs">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs space-y-1">
                <div>対象日: <strong>{selectedAbsence.target_date}</strong></div>
                <div>欠勤区分: <strong>{selectedAbsence.absence_type === 'FULL_DAY' ? '全日欠勤' : `時間欠勤 (${selectedAbsence.start_time}〜${selectedAbsence.end_time})`}</strong></div>
                <div>理由: {selectedAbsence.reason}</div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">訂正先休暇種別 <span className="text-rose-500">*</span></label>
                <select
                  value={correctTargetType}
                  onChange={(e: any) => setCorrectTargetType(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs"
                >
                  <option value="LEAVE_ANNUAL">年次有給休暇 (年休)</option>
                  <option value="LEAVE_SICK">病気休暇 (病休)</option>
                  <option value="LEAVE_SPECIAL">特別休暇 (特休)</option>
                  <option value="LEAVE_DUTY_EXEMPT">職務専念義務免除 (職免)</option>
                  <option value="OTHER">その他事由</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">関連する承認済申請ID (任意)</label>
                <input
                  type="number"
                  value={correctAppId}
                  onChange={(e) => setCorrectAppId(e.target.value)}
                  placeholder="例: 12"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">事後訂正理由 <span className="text-rose-500">*</span></label>
                <textarea
                  required
                  rows={3}
                  value={correctReason}
                  onChange={(e) => setCorrectReason(e.target.value)}
                  placeholder="例: 交通機関遅延証明書提出に伴い職務専念義務免除として処理するため"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsCorrectModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={correctSaving}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{correctSaving ? '訂正中...' : '事後訂正を実行'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 5. 年間カレンダー一括インポートモーダル (Wave 5: GAP-05) */}
      <CalendarImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportSuccess={() => {
          fetchData();
        }}
      />
    </div>
  );
};


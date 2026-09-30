import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { AuditLog, User, SystemSettings, UserWorkPattern, Position, UserPosition } from '../types';
import {
  projectWorkPatternPayload,
  validateExistingRecordSource,
  parseExistingScheduleDetails,
  CanonicalScheduleSource,
  CanonicalScheduleDetails,
  PayloadProjectionError,
} from '../utils/workSchedulePayloadProjection';
import { HankoStamp } from '../components/HankoStamp';
import {
  ShieldCheck,
  Database,
  Users,
  HardDriveDownload,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  Clock,
  Server,
  Globe,
  Edit2,
  Check,
  X,
  UserPlus,
  Lock,
  Building,
  Key,
  Shield,
  School,
  FileText,
  UserCheck,
  Save,
  Calendar,
  ChevronLeft,
  ChevronRight,
  PlusCircle,
  Trash2,
  Briefcase,
  Award,
  GitBranch,
  Copy,
} from 'lucide-react';
import { WorkflowPolicy, WorkflowPolicyStep } from '../types';
import { WorkflowPolicyManager } from '../components/admin/workflow/WorkflowPolicyManager';
import { PersonnelStatusManager } from '../components/admin/personnel/PersonnelStatusManager';
import { OfficialJobTitleManager } from '../components/admin/jobTitle/OfficialJobTitleManager';
import { UserJobTitleModal } from '../components/admin/jobTitle/UserJobTitleModal';
import { SchoolWorkScheduleManager } from '../components/admin/schedule/SchoolWorkScheduleManager';

const AVAILABLE_ROLES = [
  { id: 'TEACHER', name: '一般教員 (教員・担任・指導)', desc: '自身の服務申請・出張復命・出勤簿閲覧' },
  { id: 'VICE_PRINCIPAL', name: '教頭 (第一承認・代理申請)', desc: '第1段階審査・他職員の代行提出' },
  { id: 'PRINCIPAL', name: '校長 (最終専決・服務決裁)', desc: '公文書決裁・月次出勤簿確定押印' },
  { id: 'OFFICE', name: '事務係 (出張・旅費確認)', desc: '旅行命令・旅費取扱確認' },
  { id: 'ADMIN', name: 'システム管理者', desc: '教職員権限管理・バックアップ・監査ログ閲覧' },
];

interface Props {
  onSettingsUpdated?: () => void;
  pocMode?: boolean;
  currentUser?: User | null;
}

export const AdminAuditPage: React.FC<Props> = ({ onSettingsUpdated, pocMode = true, currentUser }) => {
  const [activeTab, setActiveTab] = useState<'settings' | 'users' | 'job-titles' | 'annual-leave' | 'personnel-status' | 'calendar' | 'workflow-policies' | 'audit' | 'system'>('settings');

  // RBAC SSOT: Current Admin User および ADMIN 権限の導出 (Fail-Closed)
  const [currentAdminUser, setCurrentAdminUser] = useState<User | null>(currentUser || null);

  useEffect(() => {
    if (!currentUser) {
      api.getMe()
        .then((res) => {
          if (res.success && res.user) {
            setCurrentAdminUser(res.user);
          }
        })
        .catch(() => {});
    }
  }, [currentUser]);

  const effectiveUser = currentUser || currentAdminUser;
  const userRoles = Array.isArray(effectiveUser?.roles)
    ? effectiveUser.roles
    : typeof effectiveUser?.roles === 'string'
    ? (effectiveUser.roles as string).split(',')
    : [];
  const canManageSchoolSchedule = userRoles.includes('ADMIN');

  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [users, setUsers] = useState<(User & { is_active: number; created_at: string; stamp_name?: string })[]>([]);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [selectedUserForJobTitles, setSelectedUserForJobTitles] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [fetchError, setFetchError] = useState('');

  // 年次有給休暇 暦年繰越 ＆ 定期付与用ステート
  const [rolloverYear, setRolloverYear] = useState<number>(() => new Date().getFullYear() + 1);
  const [rolloverPreviews, setRolloverPreviews] = useState<any[]>([]);
  const [rolloverLoading, setRolloverLoading] = useState(false);
  const [rolloverExecuting, setRolloverExecuting] = useState(false);
  const [rolloverMessage, setRolloverMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadRolloverPreview = async (year: number) => {
    setRolloverLoading(true);
    setRolloverMessage(null);
    try {
      const res = await api.getAnnualLeaveRolloverPreview(year);
      setRolloverPreviews(res.previews || []);
    } catch (err: any) {
      setRolloverMessage({ type: 'error', text: `プレビュー取得エラー: ${err.message}` });
    } finally {
      setRolloverLoading(false);
    }
  };

  const handleExecuteRollover = async () => {
    if (!confirm(`${rolloverYear}年1月1日付の「年次有給休暇 繰越（12/31確定残数・上限20日）＆ 定期付与（20日）」を一括実行しますか？\n※ 既に実行済みの場合は最新残数で安全に再整合・上書きされます。`)) {
      return;
    }
    setRolloverExecuting(true);
    setRolloverMessage(null);
    try {
      const res = await api.processAnnualLeaveRollover(rolloverYear);
      setRolloverMessage({ type: 'success', text: `✔ ${res.message} (対象教職員: ${res.processedCount}名)` });
      loadRolloverPreview(rolloverYear);
    } catch (err: any) {
      setRolloverMessage({ type: 'error', text: `繰越付与エラー: ${err.message}` });
    } finally {
      setRolloverExecuting(false);
    }
  };

  // 年間カレンダー ＆ 祝日管理用ステート
  const [calendarYear, setCalendarYear] = useState<number>(() => {
    const d = new Date();
    return d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  });
  const [yearAdjustments, setYearAdjustments] = useState<any[]>([]);
  const [customHolidays, setCustomHolidays] = useState<any[]>([]);
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayType, setNewHolidayType] = useState<'SCHOOL_HOLIDAY' | 'MUNICIPALITY_HOLIDAY' | 'NATIONAL_LEGAL_OVERRIDE'>('SCHOOL_HOLIDAY');
  const [newHolidayNote, setNewHolidayNote] = useState('');
  const [holidaySaving, setHolidaySaving] = useState(false);

  // 学校基本設定フォーム用ステート
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [schoolName, setSchoolName] = useState('');
  const [municipalityName, setMunicipalityName] = useState('');
  const [boardOfEducationName, setBoardOfEducationName] = useState('');
  const [appTitle, setAppTitle] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 印影名インライン編集用ステート
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editingStampName, setEditingStampName] = useState('');

  // 氏名・改姓編集モーダル用ステート
  const [nameModalUser, setNameModalUser] = useState<User | null>(null);
  const [editNameDisplayName, setEditNameDisplayName] = useState('');
  const [editNameFamilyName, setEditNameFamilyName] = useState('');
  const [editNameGivenName, setEditNameGivenName] = useState('');
  const [editNameStampName, setEditNameStampName] = useState('');
  const [editNameReason, setEditNameReason] = useState('');
  const [nameSaveLoading, setNameSaveLoading] = useState(false);
  const [nameSaveError, setNameSaveError] = useState('');

  // 権限（ロール）編集モーダル用ステート
  const [roleModalUser, setRoleModalUser] = useState<User | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [roleSaveLoading, setRoleSaveLoading] = useState(false);
  const [roleSaveError, setRoleSaveError] = useState('');

  // 統合 役割・役職管理（Unified Role & Position Modal）用ステート
  const [unifiedModalUser, setUnifiedModalUser] = useState<User | null>(null);
  const [unifiedRoles, setUnifiedRoles] = useState<string[]>([]);
  const [unifiedExpectedRoles, setUnifiedExpectedRoles] = useState<string[]>([]);
  const [unifiedExpectedPositions, setUnifiedExpectedPositions] = useState<UserPosition[]>([]);
  const [unifiedSuggestion, setUnifiedSuggestion] = useState<{ roleId: string; roleName: string; positionName: string } | null>(null);
  const [unifiedReason, setUnifiedReason] = useState('');
  const [unifiedSaveLoading, setUnifiedSaveLoading] = useState(false);
  const [unifiedError, setUnifiedError] = useState('');
  const [unifiedSuccess, setUnifiedSuccess] = useState('');

  // 組織役職（Position）管理用ステート
  const [positionsMaster, setPositionsMaster] = useState<Position[]>([]);
  const [positionModalUser, setPositionModalUser] = useState<User | null>(null);
  const [userPositions, setUserPositions] = useState<UserPosition[]>([]);
  const [positionLoading, setPositionLoading] = useState(false);
  const [positionError, setPositionError] = useState('');
  const [positionSuccess, setPositionSuccess] = useState('');

  // 役職割当フォーム
  const [newPositionId, setNewPositionId] = useState('');
  const [newPosEffectiveFrom, setNewPosEffectiveFrom] = useState(() => new Date().toISOString().split('T')[0]);
  const [newPosEffectiveTo, setNewPosEffectiveTo] = useState('9999-12-31');
  const [newPosIsPrimary, setNewPosIsPrimary] = useState(true);
  const [newPosNote, setNewPosNote] = useState('');

  // 役職終了モーダル用
  const [endingAssignment, setEndingAssignment] = useState<UserPosition | null>(null);
  const [endPosDate, setEndPosDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [endPosReason, setEndPosReason] = useState('');

  // 役職履歴訂正モーダル用
  const [correctingAssignment, setCorrectingAssignment] = useState<UserPosition | null>(null);
  const [correctPosFrom, setCorrectPosFrom] = useState('');
  const [correctPosTo, setCorrectPosTo] = useState('');
  const [correctPosIsPrimary, setCorrectPosIsPrimary] = useState(false);
  const [correctPosReason, setCorrectPosReason] = useState('');

  // 新規教職員登録モーダル用ステート
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState(pocMode ? 'password123' : '');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newFamilyName, setNewFamilyName] = useState('');
  const [newGivenName, setNewGivenName] = useState('');
  const [newStampName, setNewStampName] = useState('');
  const [newDepartment, setNewDepartment] = useState('教務部 / 第1学年');
  const [newRoles, setNewRoles] = useState<string[]>(['TEACHER']);
  const [newLeaveDays, setNewLeaveDays] = useState(20);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');

  // パスワード初期化・一時パスワード表示モーダル用ステート
  const [resetModalUser, setResetModalUser] = useState<User | null>(null);
  const [issuedTemporaryPassword, setIssuedTemporaryPassword] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState('');

  // 職員別 勤務パターン管理用ステート
  const [selectedUserForPattern, setSelectedUserForPattern] = useState<any>(null);
  const [userPatterns, setUserPatterns] = useState<UserWorkPattern[]>([]);
  const [isPatternModalOpen, setIsPatternModalOpen] = useState(false);
  const [patternLoading, setPatternLoading] = useState(false);
  const [patternError, setPatternError] = useState('');
  const [overlapSuggestion, setOverlapSuggestion] = useState<{
    targetPattern: { id: number; patternName: string; effectiveFrom: string; effectiveTo: string };
    suggestedEndDate: string;
    newPatternParams: any;
  } | null>(null);

  // 新規登録フォーム用
  const [newPatternName, setNewPatternName] = useState('週4日勤務 (水曜週休)');
  const [newPatternType, setNewPatternType] = useState<'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM'>('SHORT_TIME');
  const [newScheduleSource, setNewScheduleSource] = useState<'UNSELECTED' | 'SCHOOL_DEFAULT' | 'INDIVIDUAL'>('UNSELECTED');
  const [newEffectiveFrom, setNewEffectiveFrom] = useState('2026-09-01');
  const [newEffectiveTo, setNewEffectiveTo] = useState('9999-12-31');
  const [newWeeklyOffDays, setNewWeeklyOffDays] = useState<number[]>([0, 3, 6]);
  const [newPatternMemo, setNewPatternMemo] = useState('');

  // 新規個別日課用 State (DELTA-1 準拠: 初期値は完全空欄)
  const [newStartTime, setNewStartTime] = useState<string>('');
  const [newEndTime, setNewEndTime] = useState<string>('');
  const [newBreaks, setNewBreaks] = useState<Array<{ startTime: string; endTime: string }>>([]);

  const handleAddBreak = () => {
    setNewBreaks([...newBreaks, { startTime: '', endTime: '' }]);
  };

  const handleRemoveBreak = (idx: number) => {
    setNewBreaks(newBreaks.filter((_, i) => i !== idx));
  };

  const handleBreakChange = (idx: number, field: 'startTime' | 'endTime', value: string) => {
    const updated = [...newBreaks];
    updated[idx] = { ...updated[idx], [field]: value };
    setNewBreaks(updated);
  };

  // 既存パターン編集用
  const [editingPatternId, setEditingPatternId] = useState<number | null>(null);
  const [editPatternName, setEditPatternName] = useState('');
  const [editPatternType, setEditPatternType] = useState<'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM'>('STANDARD_FULLTIME');
  const [editScheduleSource, setEditScheduleSource] = useState<'SCHOOL_DEFAULT' | 'INDIVIDUAL' | null>(null);
  const [editOriginalScheduleDetails, setEditOriginalScheduleDetails] = useState<CanonicalScheduleDetails | null>(null);
  const [editEffectiveFrom, setEditEffectiveFrom] = useState('');
  const [editEffectiveTo, setEditEffectiveTo] = useState('');
  const [editWeeklyOffDays, setEditWeeklyOffDays] = useState<number[]>([]);
  const [editPatternMemo, setEditPatternMemo] = useState('');

  const loadUserPatterns = async (userId: number) => {
    setPatternLoading(true);
    setPatternError('');
    setOverlapSuggestion(null);
    try {
      const res = await api.getUserWorkPatterns(userId);
      setUserPatterns(res.patterns || []);
    } catch (err: any) {
      setPatternError(err.message || '勤務パターンの取得に失敗しました');
    } finally {
      setPatternLoading(false);
    }
  };

  const handleOpenPatternModal = (u: any) => {
    setSelectedUserForPattern(u);
    setIsPatternModalOpen(true);
    setPatternError('');
    setEditingPatternId(null);
    setEditScheduleSource(null);
    setEditOriginalScheduleDetails(null);
    setNewScheduleSource('UNSELECTED');
    setNewStartTime('');
    setNewEndTime('');
    setNewBreaks([]);
    setOverlapSuggestion(null);
    loadUserPatterns(u.id);
  };

  const handleStartEditPattern = (pat: UserWorkPattern) => {
    setPatternError('');
    setOverlapSuggestion(null);

    // INV-W3-09: 既存レコードの schedule_source を厳格検証 (Fail-Closed)
    let validatedSource: CanonicalScheduleSource;
    try {
      validatedSource = validateExistingRecordSource((pat as any).schedule_source);
    } catch (err: any) {
      setPatternError(err.message || '勤務時間ソースが不正または破損しています (Fail-Closed)');
      setEditingPatternId(null);
      return;
    }

    // INV-W3-10: 既存の schedule_details_json をパースしてスナップショット保持
    try {
      const details = parseExistingScheduleDetails(pat.schedule_details_json);
      setEditOriginalScheduleDetails(details);
    } catch (err: any) {
      setPatternError(err.message || '日課詳細データの解析に失敗しました (Fail-Closed)');
      setEditingPatternId(null);
      return;
    }

    setEditingPatternId(pat.id);
    setEditScheduleSource(validatedSource);
    setEditPatternName(pat.pattern_name);
    setEditPatternType(pat.pattern_type);
    setEditEffectiveFrom(pat.effective_from);
    setEditEffectiveTo(pat.effective_to);
    const offDays = pat.weekly_off_days
      .split(',')
      .map((d) => Number(d.trim()))
      .filter((d) => !isNaN(d));
    setEditWeeklyOffDays(offDays);
    setEditPatternMemo(pat.memo || '');
  };

  const handleCancelEditPattern = () => {
    setEditingPatternId(null);
    setEditScheduleSource(null);
    setEditOriginalScheduleDetails(null);
    setPatternError('');
    setOverlapSuggestion(null);
  };

  const handleSaveEditPattern = async (patternId: number) => {
    if (!selectedUserForPattern) return;
    setPatternLoading(true);
    setPatternError('');
    setOverlapSuggestion(null);
    try {
      if (!editScheduleSource) {
        throw new PayloadProjectionError('MISSING_SCHEDULE_SOURCE', '勤務時間の適用方式が特定できません (Fail-Closed)');
      }

      // Pure Projection による Canonical Payload 生成 (INV-W3-10, INV-W3-11)
      const payload = projectWorkPatternPayload({
        patternName: editPatternName,
        patternType: editPatternType,
        scheduleSource: editScheduleSource,
        effectiveFrom: editEffectiveFrom,
        effectiveTo: editEffectiveTo,
        weeklyOffDays: editWeeklyOffDays,
        memo: editPatternMemo,
        scheduleDetailsDirty: false, // 3A-3 では日課編集なしのため常に原盤保持
        originalScheduleDetails: editOriginalScheduleDetails,
      });

      const res = await api.updateWorkPattern(selectedUserForPattern.id, patternId, payload);
      if (res.success) {
        setEditingPatternId(null);
        setEditScheduleSource(null);
        setEditOriginalScheduleDetails(null);
        loadUserPatterns(selectedUserForPattern.id);
      } else {
        setPatternError(res.message || '更新に失敗しました');
      }
    } catch (err: any) {
      setPatternError(err.message || '勤務パターンの更新に失敗しました');
    } finally {
      setPatternLoading(false);
    }
  };

  const handleCreatePattern = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserForPattern) return;
    setPatternLoading(true);
    setPatternError('');
    setOverlapSuggestion(null);

    // 新規登録時の明示選択チェック (Fail-Closed)
    if (newScheduleSource === 'UNSELECTED') {
      setPatternError('勤務時間の適用方式（学校標準または個別日課）を選択してください (Fail-Closed)');
      setPatternLoading(false);
      return;
    }

    // Pure Projection による Canonical Payload 生成 (INV-W3-11)
    const payload = projectWorkPatternPayload({
      patternName: newPatternName,
      patternType: newPatternType,
      scheduleSource: newScheduleSource,
      effectiveFrom: newEffectiveFrom,
      effectiveTo: newEffectiveTo,
      weeklyOffDays: newWeeklyOffDays,
      memo: newPatternMemo,
      commonDailySchedule: newScheduleSource === 'INDIVIDUAL' ? {
        startTime: newStartTime,
        endTime: newEndTime,
        breakIntervals: newBreaks,
      } : null,
    });

    try {
      await api.createWorkPattern(selectedUserForPattern.id, payload);
      setNewScheduleSource('UNSELECTED');
      setNewStartTime('');
      setNewEndTime('');
      setNewBreaks([]);
      loadUserPatterns(selectedUserForPattern.id);
    } catch (err: any) {
      setPatternError(err.message || '勤務パターンの登録に失敗しました');
      const overlapping = err.data?.overlappingPattern || (err as any).overlappingPattern;
      if (overlapping && overlapping.effectiveFrom < newEffectiveFrom) {
        const startDate = new Date(newEffectiveFrom);
        startDate.setDate(startDate.getDate() - 1);
        const suggestedEndDate = startDate.toISOString().split('T')[0];
        setOverlapSuggestion({
          targetPattern: overlapping,
          suggestedEndDate,
          newPatternParams: payload,
        });
      }
    } finally {
      setPatternLoading(false);
    }
  };

  const handleApplyOverlapResolution = async () => {
    if (!selectedUserForPattern || !overlapSuggestion) return;
    setPatternLoading(true);
    setPatternError('');
    try {
      const res = await api.resolveWorkPatternOverlap(selectedUserForPattern.id, {
        targetPatternId: overlapSuggestion.targetPattern.id,
        expectedCurrentEffectiveTo: overlapSuggestion.targetPattern.effectiveTo,
        newPattern: overlapSuggestion.newPatternParams,
      });

      if (!res.success) {
        throw new Error(res.message || '期間自動調整処理に失敗しました');
      }

      setOverlapSuggestion(null);
      setNewScheduleSource('UNSELECTED');
      loadUserPatterns(selectedUserForPattern.id);
    } catch (err: any) {
      setPatternError(err.message || '期間自動調整処理に失敗しました');
    } finally {
      setPatternLoading(false);
    }
  };

  const handleDeletePattern = async (patternId: number) => {
    if (!selectedUserForPattern) return;
    if (!confirm('この勤務パターン履歴を削除してもよろしいですか？\n※確定済み出勤簿から参照されている場合は削除が拒否されます。')) return;
    setPatternLoading(true);
    setPatternError('');
    setOverlapSuggestion(null);
    try {
      const res = await api.deleteWorkPattern(selectedUserForPattern.id, patternId);
      if (res.success) {
        loadUserPatterns(selectedUserForPattern.id);
      } else {
        setPatternError(res.message || '削除に失敗しました');
      }
    } catch (err: any) {
      setPatternError(err.message || '勤務パターンの削除に失敗しました');
    } finally {
      setPatternLoading(false);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    setFetchError('');
    try {
      const [logsRes, usersRes, statusRes, settingsRes, adjRes, holRes] = await Promise.all([
        api.getAuditLogs(100).catch(() => ({ success: false, logs: [] as AuditLog[] })),
        api.getAdminUsers().catch(() => ({ success: false, users: [] })),
        api.getSystemStatus().catch(() => ({ success: false, status: null })),
        api.getAdminSettings().catch(() => ({ success: false, settings: null as any })),
        api.getCalendarAdjustments({ fiscalYear: calendarYear }).catch(() => ({ success: false, adjustments: [] })),
        api.getCustomHolidays(calendarYear).catch(() => ({ success: false, year: calendarYear, customHolidays: [] })),
      ]);
      setLogs(logsRes.logs || []);
      setUsers((usersRes.users as any) || []);
      setSystemStatus(statusRes.status || null);
      setYearAdjustments(adjRes.adjustments || []);
      setCustomHolidays(holRes.customHolidays || []);

      if (settingsRes.settings) {
        setSettings(settingsRes.settings);
        setSchoolName(settingsRes.settings.schoolName || '');
        setMunicipalityName(settingsRes.settings.municipalityName || '');
        setBoardOfEducationName(settingsRes.settings.boardOfEducationName || '');
        setAppTitle(settingsRes.settings.appTitle || '');
      }
    } catch (err: any) {
      console.error('Failed to load admin data:', err);
      setFetchError(err.message || 'データの取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHolidayDate || !newHolidayName.trim()) {
      alert('日付と名称は必須です');
      return;
    }
    setHolidaySaving(true);
    try {
      await api.saveCustomHoliday({
        holidayDate: newHolidayDate,
        name: newHolidayName,
        holidayType: newHolidayType,
        note: newHolidayNote,
      });
      setNewHolidayDate('');
      setNewHolidayName('');
      setNewHolidayNote('');
      fetchData();
    } catch (err: any) {
      alert(`休日保存エラー: ${err.message}`);
    } finally {
      setHolidaySaving(false);
    }
  };

  const handleToggleHoliday = async (id: number) => {
    try {
      await api.toggleCustomHoliday(id);
      fetchData();
    } catch (err: any) {
      alert(`切替エラー: ${err.message}`);
    }
  };

  useEffect(() => {
    fetchData();
  }, [calendarYear]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;

    setSettingsSaving(true);
    setSettingsMessage(null);
    try {
      const res = await api.updateAdminSettings({
        schoolName,
        municipalityName,
        boardOfEducationName,
        appTitle,
        expectedVersion: settings.version,
      });

      setSettings(res.settings);
      setSchoolName(res.settings.schoolName);
      setMunicipalityName(res.settings.municipalityName);
      setBoardOfEducationName(res.settings.boardOfEducationName);
      setAppTitle(res.settings.appTitle);

      setSettingsMessage({ type: 'success', text: `✔ ${res.message} (Version: ${res.settings.version})` });
      if (onSettingsUpdated) {
        onSettingsUpdated();
      }
    } catch (err: any) {
      setSettingsMessage({ type: 'error', text: `⚠ 設定保存エラー: ${err.message}` });
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleManualBackup = async () => {
    setBackupLoading(true);
    setBackupMessage('');
    try {
      const res = await api.triggerBackup();
      setBackupMessage(`✔ ${res.message}`);
      fetchData();
    } catch (err: any) {
      setBackupMessage(`⚠ バックアップエラー: ${err.message}`);
    } finally {
      setBackupLoading(false);
    }
  };

  const handleSaveStampName = async (userId: number) => {
    if (!editingStampName.trim()) return;
    try {
      await api.updateUserStampName(userId, editingStampName.trim());
      setEditingUserId(null);
      fetchData();
    } catch (err: any) {
      alert(`印影名更新エラー: ${err.message}`);
    }
  };

  const handleOpenNameModal = (user: any) => {
    setNameModalUser(user);
    const dName = user.display_name || user.displayName || '';
    const fName = user.family_name || user.familyName || '';
    const gName = user.given_name || user.givenName || '';
    const sName = user.stamp_name || user.stampName || '';

    setEditNameDisplayName(dName);
    setEditNameFamilyName(fName);
    setEditNameGivenName(gName);
    setEditNameStampName(sName || fName || dName.slice(0, 4));
    setEditNameReason('');
    setNameSaveError('');
  };

  const handleEditDisplayNameChange = (val: string) => {
    setEditNameDisplayName(val);
    const parts = val.trim().split(/[\s　]+/);
    if (parts.length >= 2) {
      setEditNameFamilyName(parts[0]);
      setEditNameGivenName(parts.slice(1).join(' '));
      setEditNameStampName(parts[0].slice(0, 4));
    } else if (parts.length === 1 && parts[0]) {
      setEditNameFamilyName(parts[0]);
      setEditNameStampName(parts[0].slice(0, 4));
    }
  };

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameModalUser) return;
    if (!editNameDisplayName.trim()) {
      setNameSaveError('氏名（フルネーム）を入力してください');
      return;
    }

    setNameSaveLoading(true);
    setNameSaveError('');
    try {
      await api.updateUserName(nameModalUser.id, {
        displayName: editNameDisplayName.trim(),
        familyName: editNameFamilyName.trim(),
        givenName: editNameGivenName.trim(),
        stampName: editNameStampName.trim(),
        reason: editNameReason.trim() || undefined,
      });
      setNameModalUser(null);
      fetchData();
      if (onSettingsUpdated) {
        onSettingsUpdated();
      }
    } catch (err: any) {
      setNameSaveError(err.message || '氏名の更新に失敗しました');
    } finally {
      setNameSaveLoading(false);
    }
  };

  const handleOpenResetModal = (targetUser: User) => {
    setResetModalUser(targetUser);
    setIssuedTemporaryPassword(null);
    setResetError('');
  };

  const handleExecuteResetPassword = async () => {
    if (!resetModalUser) return;
    setResetLoading(true);
    setResetError('');
    try {
      const res = await api.adminResetPassword(resetModalUser.id);
      setIssuedTemporaryPassword(res.temporaryPassword);
      fetchData();
    } catch (err: any) {
      setResetError(err.message || 'パスワードの初期化に失敗しました');
    } finally {
      setResetLoading(false);
    }
  };

  const handleOpenRoleModal = (user: User) => {
    setRoleModalUser(user);
    const userRoles = Array.isArray(user.roles)
      ? user.roles
      : typeof user.roles === 'string'
      ? (user.roles as string).split(',')
      : ['TEACHER'];
    setSelectedRoles(userRoles);
    setRoleSaveError('');
  };

  const handleSaveRoles = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleModalUser) return;
    if (selectedRoles.length === 0) {
      setRoleSaveError('最低1つのロールを選択してください');
      return;
    }

    setRoleSaveLoading(true);
    setRoleSaveError('');
    try {
      await api.updateUserRoles(roleModalUser.id, selectedRoles);
      setRoleModalUser(null);
      fetchData();
    } catch (err: any) {
      setRoleSaveError(err.message || '権限の更新に失敗しました');
    } finally {
      setRoleSaveLoading(false);
    }
  };

  const handleOpenUnifiedModal = async (user: User) => {
    setUnifiedModalUser(user);
    const userRoles = Array.isArray(user.roles)
      ? user.roles
      : typeof user.roles === 'string'
      ? (user.roles as string).split(',')
      : ['TEACHER'];
    setUnifiedRoles(userRoles);
    setUnifiedExpectedRoles(userRoles);
    setUnifiedSuggestion(null);
    setUnifiedReason('');
    setUnifiedError('');
    setUnifiedSuccess('');
    setEndingAssignment(null);
    setCorrectingAssignment(null);
    setNewPosEffectiveFrom(new Date().toISOString().split('T')[0]);
    setNewPosEffectiveTo('9999-12-31');
    setNewPosIsPrimary(true);
    setNewPosNote('');

    setPositionLoading(true);
    try {
      const [posRes, masterRes] = await Promise.all([
        api.getUserPositions(user.id),
        positionsMaster.length === 0 ? api.getPositions() : Promise.resolve({ success: true, positions: positionsMaster }),
      ]);
      if (masterRes.positions) {
        setPositionsMaster(masterRes.positions);
        if (!newPositionId && masterRes.positions.length > 0) {
          setNewPositionId(masterRes.positions[0].id);
        }
      }
      const pList = posRes.positions || [];
      setUserPositions(pList);
      setUnifiedExpectedPositions(pList);
    } catch (err: any) {
      setUnifiedError(err.message || '役職情報の取得に失敗しました');
    } finally {
      setPositionLoading(false);
    }
  };

  const handlePositionSelectionChange = (posId: string) => {
    setNewPositionId(posId);
    // Auto-Suggest only (NO auto-select / NO silent grant)
    if (posId === 'PRINCIPAL' && !unifiedRoles.includes('PRINCIPAL')) {
      setUnifiedSuggestion({ roleId: 'PRINCIPAL', roleName: '校長 (PRINCIPAL)', positionName: '校長' });
    } else if ((posId === 'VICE_PRINCIPAL_1' || posId === 'VICE_PRINCIPAL_2') && !unifiedRoles.includes('VICE_PRINCIPAL')) {
      setUnifiedSuggestion({ roleId: 'VICE_PRINCIPAL', roleName: '教頭 (VICE_PRINCIPAL)', positionName: posId === 'VICE_PRINCIPAL_1' ? '第1教頭' : '第2教頭' });
    } else if (posId === 'CHIEF_TEACHER' && !unifiedRoles.includes('TEACHER')) {
      setUnifiedSuggestion({ roleId: 'TEACHER', roleName: '一般教員 (TEACHER)', positionName: '教務主任' });
    } else if (posId === 'OFFICE_HEAD' && !unifiedRoles.includes('OFFICE')) {
      setUnifiedSuggestion({ roleId: 'OFFICE', roleName: '事務室 (OFFICE)', positionName: '事務主幹' });
    } else {
      setUnifiedSuggestion(null);
    }
  };

  const handleExplicitAddSuggestedRole = (roleId: string) => {
    if (!unifiedRoles.includes(roleId)) {
      setUnifiedRoles([...unifiedRoles, roleId]);
    }
    setUnifiedSuggestion(null);
  };

  const handleSaveUnifiedAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unifiedModalUser) return;
    if (unifiedRoles.length === 0) {
      setUnifiedError('最低1つの認可ロールを選択してください');
      return;
    }

    setUnifiedSaveLoading(true);
    setUnifiedError('');
    setUnifiedSuccess('');

    const positionOperations: any[] = [];
    if (newPositionId && newPosEffectiveFrom) {
      positionOperations.push({
        operation: 'ASSIGN',
        positionId: newPositionId,
        effectiveFrom: newPosEffectiveFrom,
        effectiveTo: newPosEffectiveTo || '9999-12-31',
        isPrimary: newPosIsPrimary,
      });
    }

    const expectedPositionSnapshot = unifiedExpectedPositions.map((p) => ({
      assignmentId: p.id,
      positionId: p.position_id,
      effectiveFrom: p.effective_from,
      effectiveTo: p.effective_to || '',
      isPrimary: p.is_primary === 1,
    }));

    try {
      const res = await api.updateUserAccess(unifiedModalUser.id, {
        roles: unifiedRoles,
        expectedRoles: unifiedExpectedRoles,
        positionOperations: positionOperations.length > 0 ? positionOperations : undefined,
        expectedPositionSnapshot,
        reason: unifiedReason.trim() || undefined,
      });

      if (res.success) {
        setUnifiedSuccess(`✔ ${res.message}`);
        fetchData();
        setTimeout(() => {
          setUnifiedModalUser(null);
        }, 1200);
      } else {
        setUnifiedError(res.message || '統合保存に失敗しました');
      }
    } catch (err: any) {
      setUnifiedError(err.message || '統合更新エラーが発生しました');
    } finally {
      setUnifiedSaveLoading(false);
    }
  };

  const loadUserPositions = async (userId: number) => {
    setPositionLoading(true);
    setPositionError('');
    setPositionSuccess('');
    try {
      const [posRes, masterRes] = await Promise.all([
        api.getUserPositions(userId),
        positionsMaster.length === 0 ? api.getPositions() : Promise.resolve({ success: true, positions: positionsMaster }),
      ]);
      if (masterRes.positions) {
        setPositionsMaster(masterRes.positions);
        if (!newPositionId && masterRes.positions.length > 0) {
          setNewPositionId(masterRes.positions[0].id);
        }
      }
      setUserPositions(posRes.positions || []);
    } catch (err: any) {
      setPositionError(err.message || '役職情報の取得に失敗しました');
    } finally {
      setPositionLoading(false);
    }
  };

  const handleOpenPositionModal = (user: User) => {
    setPositionModalUser(user);
    setPositionError('');
    setPositionSuccess('');
    setEndingAssignment(null);
    setCorrectingAssignment(null);
    setNewPosEffectiveFrom(new Date().toISOString().split('T')[0]);
    setNewPosEffectiveTo('9999-12-31');
    setNewPosIsPrimary(true);
    setNewPosNote('');
    loadUserPositions(user.id);
  };

  const handleAssignPosition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!positionModalUser || !newPositionId) return;
    setPositionLoading(true);
    setPositionError('');
    setPositionSuccess('');
    try {
      const res = await api.assignUserPosition(positionModalUser.id, {
        positionId: newPositionId,
        effectiveFrom: newPosEffectiveFrom,
        effectiveTo: newPosEffectiveTo,
        isPrimary: newPosIsPrimary,
        note: newPosNote,
      });
      if (res.success) {
        setPositionSuccess(res.message);
        loadUserPositions(positionModalUser.id);
        fetchData();
      } else {
        setPositionError(res.message || '役職の割当に失敗しました');
      }
    } catch (err: any) {
      setPositionError(err.message || '役職の割当に失敗しました');
    } finally {
      setPositionLoading(false);
    }
  };

  const handleExecuteEndPosition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!positionModalUser || !endingAssignment) return;
    setPositionLoading(true);
    setPositionError('');
    setPositionSuccess('');
    try {
      const res = await api.endUserPosition(positionModalUser.id, endingAssignment.id, {
        endDate: endPosDate,
        reason: endPosReason,
      });
      if (res.success) {
        setPositionSuccess(res.message);
        setEndingAssignment(null);
        loadUserPositions(positionModalUser.id);
        fetchData();
      } else {
        setPositionError(res.message || '役職の終了処理に失敗しました');
      }
    } catch (err: any) {
      setPositionError(err.message || '役職の終了処理に失敗しました');
    } finally {
      setPositionLoading(false);
    }
  };

  const handleExecuteCorrectPosition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!positionModalUser || !correctingAssignment) return;
    if (!correctPosReason.trim()) {
      setPositionError('履歴訂正理由を入力してください');
      return;
    }
    setPositionLoading(true);
    setPositionError('');
    setPositionSuccess('');
    try {
      const res = await api.correctUserPosition(positionModalUser.id, correctingAssignment.id, {
        effectiveFrom: correctPosFrom,
        effectiveTo: correctPosTo,
        isPrimary: correctPosIsPrimary,
        correctionReason: correctPosReason.trim(),
      });
      if (res.success) {
        setPositionSuccess(res.message);
        setCorrectingAssignment(null);
        loadUserPositions(positionModalUser.id);
        fetchData();
      } else {
        setPositionError(res.message || '役職履歴の訂正に失敗しました');
      }
    } catch (err: any) {
      setPositionError(err.message || '役職履歴の訂正に失敗しました');
    } finally {
      setPositionLoading(false);
    }
  };

  const handleDisplayNameChange = (val: string) => {
    setNewDisplayName(val);
    const parts = val.trim().split(/[\s　]+/);
    if (parts.length >= 2) {
      setNewFamilyName(parts[0]);
      setNewGivenName(parts.slice(1).join(' '));
      if (!newStampName || newStampName === newFamilyName) {
        setNewStampName(parts[0].slice(0, 4));
      }
    } else if (parts.length === 1 && parts[0]) {
      setNewFamilyName(parts[0]);
      if (!newStampName) {
        setNewStampName(parts[0].slice(0, 4));
      }
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim() || !newDisplayName.trim()) {
      setCreateError('ユーザーIDと氏名は必須です');
      return;
    }
    if (newRoles.length === 0) {
      setCreateError('最低1つの権限ロールを選択してください');
      return;
    }

    setCreateLoading(true);
    setCreateError('');
    try {
      await api.createUser({
        username: newUsername.trim(),
        password: newPassword,
        displayName: newDisplayName.trim(),
        familyName: newFamilyName.trim(),
        givenName: newGivenName.trim(),
        stampName: (newStampName || newFamilyName || newDisplayName).trim().slice(0, 4),
        department: newDepartment.trim(),
        roles: newRoles,
        initialAnnualLeaveDays: newLeaveDays,
      });

      setIsCreateModalOpen(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewFamilyName('');
      setNewGivenName('');
      setNewStampName('');
      setNewDepartment('教務部 / 第1学年');
      setNewRoles(['TEACHER']);
      fetchData();
    } catch (err: any) {
      setCreateError(err.message || '教職員の登録に失敗しました');
    } finally {
      setCreateLoading(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
      {/* ページヘッダー */}
      <div className="flex flex-wrap justify-between items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-purple-100 text-purple-700 rounded-xl">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">システム管理・権限・組織設定</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              学校基本設定・教職員アカウント・電子印影・フォレンジック監査ログの一元管理
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition shadow-2xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>最新情報に更新</span>
          </button>
        </div>
      </div>

      {fetchError && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span>{fetchError}</span>
        </div>
      )}

      {/* サブナビゲーション タブ */}
      <div className="flex border-b border-slate-200 gap-2 bg-white px-4 pt-2 rounded-t-xl">
        <button
          onClick={() => setActiveTab('settings')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'settings'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <School className="w-4 h-4" />
          <span>🏫 学校基本設定・帳票カスタマイズ</span>
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'users'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>👥 教職員・権限管理</span>
        </button>

        <button
          onClick={() => setActiveTab('job-titles')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'job-titles'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Award className="w-4 h-4" />
          <span>🎓 正式職名マスタ管理 (辞令)</span>
        </button>

        <button
          onClick={() => {
            setActiveTab('annual-leave');
            loadRolloverPreview(rolloverYear);
          }}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'annual-leave'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Calendar className="w-4 h-4" />
          <span>🏖️ 年休一暦年繰越・付与管理</span>
        </button>

        <button
          onClick={() => setActiveTab('personnel-status')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'personnel-status'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Briefcase className="w-4 h-4" />
          <span>🏛️ 人事発令（休職・停職等）管理</span>
        </button>

        <button
          onClick={() => setActiveTab('calendar')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'calendar'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Calendar className="w-4 h-4" />
          <span>📅 年間行事カレンダー・祝日マスタ</span>
        </button>

        <button
          onClick={() => setActiveTab('workflow-policies')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'workflow-policies'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <GitBranch className="w-4 h-4" />
          <span>🌿 承認フロー・ポリシー管理</span>
        </button>

        <button
          onClick={() => setActiveTab('audit')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'audit'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>🔍 監査ログ・改ざん検証</span>
        </button>

        <button
          onClick={() => setActiveTab('system')}
          className={`px-4 py-2.5 text-xs font-bold border-b-2 flex items-center gap-2 transition ${
            activeTab === 'system'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Database className="w-4 h-4" />
          <span>⚙️ システム状態・バックアップ</span>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* 1. 学校基本設定・帳票カスタマイズ タブ */}
      {/* ========================================================================= */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-6">
            <div>
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <School className="w-5 h-5 text-purple-600" />
                <span>学校組織情報 ＆ 公文書規程名称の設定</span>
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                設定変更は画面ヘッダー・ログイン画面および未確定の帳票へ即座に反映されます。
                （※ 既に承認・確定済みの過去公文書は、確定当時の組織情報スナップショットが安全に維持されます）
              </p>
            </div>

            {settingsMessage && (
              <div
                className={`p-4 rounded-xl text-xs flex items-center gap-2 ${
                  settingsMessage.type === 'success'
                    ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                    : 'bg-rose-50 border border-rose-200 text-rose-800'
                }`}
              >
                {settingsMessage.type === 'success' ? (
                  <CheckCircle className="w-4 h-4 flex-shrink-0 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 text-rose-600" />
                )}
                <span>{settingsMessage.text}</span>
              </div>
            )}

            <form onSubmit={handleSaveSettings} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* 学校名 */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    学校名 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={schoolName}
                    onChange={(e) => setSchoolName(e.target.value)}
                    placeholder="例: 〇〇市立第一小学校"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">画面各所および各種帳票の学校名欄に表示されます</p>
                </div>

                {/* 自治体名 */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    自治体名（市町村名等） <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={municipalityName}
                    onChange={(e) => setMunicipalityName(e.target.value)}
                    placeholder="例: 〇〇市"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                {/* 教育委員会名 */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    教育委員会名（任命権者） <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={boardOfEducationName}
                    onChange={(e) => setBoardOfEducationName(e.target.value)}
                    placeholder="例: 〇〇市教育委員会"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                {/* システム表示名 */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    システム表示タイトル <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={appTitle}
                    onChange={(e) => setAppTitle(e.target.value)}
                    placeholder="例: 学校業務ワークフローシステム"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">ヘッダーやログイン画面のタイトルとして表示されます</p>
                </div>
              </div>

              {settings && (
                <div className="bg-slate-50 p-4 rounded-xl text-[11px] text-slate-500 flex justify-between items-center border border-slate-200">
                  <div>
                    <span>現在の設定バージョン: <strong className="text-slate-700 font-mono">v{settings.version}</strong></span>
                    <span className="mx-2">|</span>
                    <span>最終更新: <strong className="text-slate-700 font-mono">{new Date(settings.updatedAt).toLocaleString('ja-JP')}</strong></span>
                    {settings.updatedByUserName && (
                      <>
                        <span className="mx-2">|</span>
                        <span>更新者: <strong className="text-slate-700">{settings.updatedByUserName}</strong></span>
                      </>
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={settingsSaving}
                  className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition shadow-sm disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{settingsSaving ? '設定を保存中...' : '学校基本設定を保存'}</span>
                </button>
              </div>
            </form>
          </div>

          {/* 学校標準勤務日課の管理 (Step 3B-3) */}
          <SchoolWorkScheduleManager canManage={canManageSchoolSchedule} />
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. 教職員・権限管理 タブ */}
      {/* ========================================================================= */}
      {activeTab === 'users' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Users className="w-4 h-4 text-purple-600" />
                <span>教職員アカウント ＆ 電子印影・権限一覧 ({users.length}名)</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">名字入り電子認印・職責ロール・所属部署の管理</p>
            </div>
            <button
              onClick={() => {
                setIsCreateModalOpen(true);
                setCreateError('');
              }}
              className="px-3.5 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow-2xs"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>教職員を新規登録</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">ID</th>
                  <th className="px-4 py-3 text-left font-semibold">ユーザーID</th>
                  <th className="px-4 py-3 text-left font-semibold">氏名</th>
                  <th className="px-4 py-3 text-left font-semibold">印影プレビュー</th>
                  <th className="px-4 py-3 text-left font-semibold">認印 名字</th>
                  <th className="px-4 py-3 text-left font-semibold">正式職名 (辞令)</th>
                  <th className="px-4 py-3 text-left font-semibold">所属部署・学年</th>
                  <th className="px-4 py-3 text-left font-semibold">保有権限ロール</th>
                  <th className="px-4 py-3 text-left font-semibold">組織役職 (現在有効)</th>
                  <th className="px-4 py-3 text-left font-semibold">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {users.map((u) => {
                  const currentStamp = u.stamp_name || u.displayName?.slice(0, 4) || '印';
                  const isEditingStamp = editingUserId === u.id;
                  const userRoles = Array.isArray(u.roles)
                    ? u.roles
                    : typeof u.roles === 'string'
                    ? (u.roles as string).split(',')
                    : ['TEACHER'];
                  const curPositions = u.currentPositions || [];

                  return (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-500 font-mono">#{u.id}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-800">{u.username}</td>
                      <td className="px-4 py-3 font-bold text-slate-900">
                        <div className="flex items-center gap-1.5">
                          <span>{(u as any).display_name || u.displayName}</span>
                          <button
                            onClick={() => handleOpenNameModal(u)}
                            className="text-slate-400 hover:text-purple-600 p-0.5"
                            title="氏名変更・改姓対応"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <HankoStamp stampName={currentStamp} size="mini" />
                      </td>
                      <td className="px-4 py-3 font-bold text-indigo-900 font-serif">
                        {isEditingStamp ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={editingStampName}
                              onChange={(e) => setEditingStampName(e.target.value)}
                              className="px-2 py-1 text-xs border border-indigo-500 rounded bg-white w-20 focus:outline-none"
                              autoFocus
                            />
                            <button
                              onClick={() => handleSaveStampName(u.id)}
                              className="p-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded"
                              title="保存"
                            >
                              <Check className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => setEditingUserId(null)}
                              className="p-1 bg-slate-300 hover:bg-slate-400 text-slate-700 rounded"
                              title="キャンセル"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <span>{currentStamp}</span>
                            <button
                              onClick={() => {
                                setEditingUserId(u.id);
                                setEditingStampName(currentStamp);
                              }}
                              className="text-slate-400 hover:text-indigo-600 p-0.5"
                              title="印影名を変更"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {u.currentOfficialJobTitle ? (
                          <span className="font-bold text-slate-900 text-xs px-2 py-0.5 bg-slate-100 rounded border border-slate-200">
                            {u.currentOfficialJobTitle}
                          </span>
                        ) : (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 font-bold border border-rose-200 flex items-center gap-1 w-fit">
                            <AlertTriangle className="w-3 h-3 text-rose-500" />
                            <span>未登録</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{u.department || '未設定'}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1 flex-wrap">
                          {userRoles.map((r) => (
                            <span
                              key={r}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                                r === 'ADMIN'
                                  ? 'bg-purple-100 text-purple-900 border-purple-300'
                                  : r === 'PRINCIPAL'
                                  ? 'bg-amber-100 text-amber-900 border-amber-300'
                                  : r === 'VICE_PRINCIPAL'
                                  ? 'bg-blue-100 text-blue-900 border-blue-300'
                                  : r === 'OFFICE'
                                  ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                                  : 'bg-slate-100 text-slate-700 border-slate-200'
                              }`}
                            >
                              {r}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {curPositions.length === 0 ? (
                          <span className="text-slate-400 text-[11px]">未割当</span>
                        ) : (
                          <div className="flex gap-1 flex-wrap">
                            {curPositions.map((pos) => (
                              <span
                                key={pos.id}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                                  pos.isPrimary
                                    ? 'bg-indigo-50 text-indigo-900 border-indigo-300'
                                    : 'bg-slate-50 text-slate-700 border-slate-200'
                                }`}
                                title={`有効期間: ${pos.effectiveFrom} 〜 ${pos.effectiveTo || '無期限'}`}
                              >
                                {pos.name}
                                {pos.isPrimary && <span className="ml-1 text-[9px] text-indigo-600 font-normal">[主]</span>}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleOpenUnifiedModal(u)}
                            className="px-2 py-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white rounded-md font-bold flex items-center gap-1 text-[11px] shadow-2xs"
                            title="役割・役職の統合管理 (Unified Access)"
                          >
                            <GitBranch className="w-3 h-3 text-purple-200" />
                            <span>役割・役職統合</span>
                          </button>
                          <button
                            onClick={() => handleOpenNameModal(u)}
                            className="px-2 py-1 bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-800 rounded-md font-medium flex items-center gap-1 text-[11px] shadow-2xs"
                            title="氏名変更・改姓対応"
                          >
                            <UserCheck className="w-3 h-3 text-purple-600" />
                            <span>改姓・氏名</span>
                          </button>
                          <button
                            onClick={() => handleOpenRoleModal(u)}
                            className="px-2 py-1 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 rounded-md font-medium flex items-center gap-1 text-[11px] shadow-2xs"
                            title="認可ロール変更"
                          >
                            <Shield className="w-3 h-3 text-indigo-600" />
                            <span>権限</span>
                          </button>
                          <button
                            onClick={() => handleOpenPositionModal(u)}
                            className="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 rounded-md font-medium flex items-center gap-1 text-[11px] shadow-2xs"
                            title="組織役職・職階管理"
                          >
                            <Award className="w-3 h-3 text-indigo-600" />
                            <span>役職割当</span>
                          </button>
                          <button
                            onClick={() => setSelectedUserForJobTitles(u)}
                            className="px-2 py-1 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-900 rounded-md font-bold flex items-center gap-1 text-[11px] shadow-2xs"
                            title="正式職名 人事発令・辞令履歴管理"
                          >
                            <Award className="w-3 h-3 text-amber-600" />
                            <span>辞令発令</span>
                          </button>
                          <button
                            onClick={() => handleOpenPatternModal(u)}
                            className="px-2 py-1 bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-700 rounded-md font-medium flex items-center gap-1 text-[11px] shadow-2xs"
                            title="勤務割振り"
                          >
                            <Briefcase className="w-3 h-3 text-purple-600" />
                            <span>勤務</span>
                          </button>
                          <button
                            onClick={() => handleOpenResetModal(u)}
                            className="px-2 py-1 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 rounded-md font-medium flex items-center gap-1 text-[11px] shadow-2xs"
                            title="パスワード初期化・一時パスワード発行"
                          >
                            <Key className="w-3 h-3 text-rose-600" />
                            <span>初期化</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2.1.5. 正式職名マスタ管理 (辞令・職名) タブ */}
      {/* ========================================================================= */}
      {activeTab === 'job-titles' && <OfficialJobTitleManager />}

      {/* ========================================================================= */}
      {/* 2.2. 年次有給休暇 暦年繰越 ＆ 定期付与管理 タブ */}
      {/* ========================================================================= */}
      {activeTab === 'annual-leave' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-6">
            <div className="flex flex-wrap justify-between items-center gap-4">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Calendar className="w-5 h-5 text-purple-600" />
                  <span>年次有給休暇 暦年繰越 ＆ 1月1日定期付与管理（勤務時間条例第12条）</span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  12月31日時点の年休確定残数を最大20日繰越（CARRYOVER）＋ 1月1日定期付与（20日）の一括計算・確定
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-xs bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200">
                  <span className="font-semibold text-slate-600">対象暦年:</span>
                  <input
                    type="number"
                    min={2020}
                    max={2050}
                    value={rolloverYear}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      setRolloverYear(val);
                      if (val > 2000) loadRolloverPreview(val);
                    }}
                    className="w-20 px-2 py-1 border border-slate-300 rounded font-bold font-mono text-center text-slate-800 bg-white"
                  />
                  <span className="font-bold text-slate-700">年（1月1日付与）</span>
                </div>

                <button
                  onClick={handleExecuteRollover}
                  disabled={rolloverExecuting || rolloverLoading || rolloverPreviews.length === 0}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition shadow-sm disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${rolloverExecuting ? 'animate-spin' : ''}`} />
                  <span>{rolloverExecuting ? '一括繰越付与を実行中...' : `${rolloverYear}年1月1日 繰越付与を一括実行`}</span>
                </button>
              </div>
            </div>

            {rolloverMessage && (
              <div
                className={`p-4 rounded-xl text-xs flex items-center gap-2 ${
                  rolloverMessage.type === 'success'
                    ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                    : 'bg-rose-50 border border-rose-200 text-rose-800'
                }`}
              >
                {rolloverMessage.type === 'success' ? (
                  <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
                )}
                <span>{rolloverMessage.text}</span>
              </div>
            )}

            <div className="border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">教職員氏名</th>
                    <th className="px-4 py-3 text-left font-semibold">所属</th>
                    <th className="px-4 py-3 text-center font-semibold">{rolloverYear - 1}年12月31日 確定残日数</th>
                    <th className="px-4 py-3 text-center font-semibold text-indigo-700">翌年繰越日数 (上限20日)</th>
                    <th className="px-4 py-3 text-center font-semibold text-emerald-700">{rolloverYear}年 新規付与日数</th>
                    <th className="px-4 py-3 text-center font-semibold text-purple-700">合計保有日数 ({rolloverYear}年当初)</th>
                    <th className="px-4 py-3 text-center font-semibold">付与状況</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {rolloverLoading ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                        残数計算およびプレビューを算出中...
                      </td>
                    </tr>
                  ) : rolloverPreviews.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                        対象教職員データがありません
                      </td>
                    </tr>
                  ) : (
                    rolloverPreviews.map((p) => (
                      <tr key={p.userId} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-bold text-slate-900">
                          {p.displayName} <span className="font-mono text-slate-400 font-normal">({p.username})</span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{p.department || '教員'}</td>
                        <td className="px-4 py-3 text-center font-mono font-semibold text-slate-700">
                          {p.previousYearRemainingDays} 日
                        </td>
                        <td className="px-4 py-3 text-center font-mono font-bold text-indigo-700 bg-indigo-50/40">
                          +{p.carryoverDays} 日
                        </td>
                        <td className="px-4 py-3 text-center font-mono font-bold text-emerald-700 bg-emerald-50/40">
                          +{p.regularGrantDays} 日
                        </td>
                        <td className="px-4 py-3 text-center font-mono font-black text-purple-800 bg-purple-50/50 text-sm">
                          {p.totalAvailableDays} 日
                        </td>
                        <td className="px-4 py-3 text-center">
                          {p.alreadyRolledOver ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                              確定・付与済
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                              未確定（プレビュー）
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl text-xs text-slate-600 border border-slate-200 space-y-1.5">
              <div className="font-bold text-slate-800 flex items-center gap-1.5">
                <CheckCircle className="w-4 h-4 text-emerald-600" />
                <span>条例準拠および遅延決裁時の自動再整合（Auto-Rebalance）仕様について:</span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                ・<strong>一暦年管理（1/1〜12/31）</strong>: 12月31日23:59時点で有効な残日数を確定し、最大20日を上限として翌年1月1日に繰り越します。<br/>
                ・<strong>年跨ぎ遅延決裁の自動補正</strong>: 1月1日以降に前年12月以前の年休申請が決裁された場合でも、最新の12/31確定残数に基づいて翌年繰越ロットが自動再整合（Auto-Rebalance）されます。<br/>
                ・<strong>時間単位年休</strong>: 年間上限（5日相当）の制限なく、保有する年休残量の範囲内で取得可能です。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2.2. 人事発令管理 タブ (GAP-07) */}
      {/* ========================================================================= */}
      {activeTab === 'personnel-status' && (
        <PersonnelStatusManager />
      )}

      {/* ========================================================================= */}
      {/* 2.5. 年間行事カレンダー ＆ 祝日マスタ タブ */}
      {/* ========================================================================= */}
      {activeTab === 'calendar' && (
        <div className="space-y-6">
          {/* 年間行事・振替一覧 */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
            <div className="flex flex-wrap justify-between items-center gap-4">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Calendar className="w-5 h-5 text-purple-600" />
                  <span>{calendarYear}年度 年間学校行事 ＆ 服務調整・振替一覧</span>
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  4月1日〜翌年3月31日までの運動会・文化祭・参観日・開校記念日・振替休業日（全校/個人）
                </p>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={() => setCalendarYear(calendarYear - 1)}
                  className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="font-bold text-sm font-mono">{calendarYear}年度</span>
                <button
                  onClick={() => setCalendarYear(calendarYear + 1)}
                  className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">調整コード</th>
                    <th className="px-4 py-3 text-left font-semibold">適用範囲</th>
                    <th className="px-4 py-3 text-left font-semibold">調整種別</th>
                    <th className="px-4 py-3 text-left font-semibold">行事名 / 件名</th>
                    <th className="px-4 py-3 text-left font-semibold">対象日 (勤務 ⇄ 振替)</th>
                    <th className="px-4 py-3 text-left font-semibold">事由・服務根拠</th>
                    <th className="px-4 py-3 text-left font-semibold">状態</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {yearAdjustments.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                        {calendarYear}年度の服務調整・振替データはありません
                      </td>
                    </tr>
                  ) : (
                    yearAdjustments.map((adj) => (
                      <tr key={adj.id} className="hover:bg-slate-50/80">
                        <td className="px-4 py-3 font-mono font-medium text-slate-700">{adj.adjustment_code}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            adj.scope_type === 'ALL' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'
                          }`}>
                            {adj.scope_type === 'ALL' ? '全校一括' : adj.target_user_name || '指定教員'}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-800">
                          {adj.adjustment_type === 'WEEK_OFF_TRANSFER' && '週休振替'}
                          {adj.adjustment_type === 'SUBSTITUTE_HOLIDAY' && '代休指定'}
                          {adj.adjustment_type === 'SINGLE_WORKDAY_OVERRIDE' && '特別勤務日'}
                          {adj.adjustment_type === 'DESIGNATED_NON_WORKDAY' && '勤務免除日'}
                        </td>
                        <td className="px-4 py-3 font-bold text-slate-900">{adj.event_name}</td>
                        <td className="px-4 py-3 font-mono text-slate-600">
                          {adj.source_date} ({adj.source_duty_status === 'WORK_REQUIRED' ? '勤務' : '休'})
                          {adj.target_date && ` ⇄ ${adj.target_date} (${adj.target_duty_status === 'WORK_REQUIRED' ? '勤務' : '振替休'})`}
                        </td>
                        <td className="px-4 py-3 text-slate-500">{adj.reason}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            adj.status === 'ACTIVE' ? 'bg-teal-100 text-teal-800' : 'bg-slate-200 text-slate-500 line-through'
                          }`}>
                            {adj.status === 'ACTIVE' ? '有効' : '解除済'}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 祝日法改正補正 ＆ 学校独自休日マスタ */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-6">
            <div>
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Shield className="w-5 h-5 text-purple-600" />
                <span>祝日法改正補正 ＆ 学校独自休日マスタ (完全ローカル自律運用)</span>
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                閉域網環境において、将来の国民の祝日法改正・特例休日の無効化補正や、開校記念日・自治体指定休日の追加・管理を行います。
              </p>
            </div>

            {/* 新規登録フォーム */}
            <form onSubmit={handleSaveHoliday} className="p-4 bg-slate-50 rounded-xl border border-slate-200 grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">日付 *</label>
                <input
                  type="date"
                  required
                  value={newHolidayDate}
                  onChange={(e) => setNewHolidayDate(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg bg-white font-mono"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">休日名 *</label>
                <input
                  type="text"
                  required
                  value={newHolidayName}
                  onChange={(e) => setNewHolidayName(e.target.value)}
                  placeholder="例: 開校記念日 / 都民の日"
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">区分 *</label>
                <select
                  value={newHolidayType}
                  onChange={(e) => setNewHolidayType(e.target.value as any)}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg bg-white font-medium"
                >
                  <option value="SCHOOL_HOLIDAY">学校独自休日 (開校記念日等)</option>
                  <option value="MUNICIPALITY_HOLIDAY">自治体休日 (都民/県民の日等)</option>
                  <option value="NATIONAL_LEGAL_OVERRIDE">国民の祝日 (法改正・特例追加)</option>
                </select>
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={holidaySaving}
                  className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-bold flex items-center justify-center gap-1 shadow-xs"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  <span>{holidaySaving ? '保存中...' : '休日を追加'}</span>
                </button>
              </div>
            </form>

            {/* 休日一覧 */}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">日付</th>
                    <th className="px-4 py-3 text-left font-semibold">休日名称</th>
                    <th className="px-4 py-3 text-left font-semibold">種別</th>
                    <th className="px-4 py-3 text-left font-semibold">ソース</th>
                    <th className="px-4 py-3 text-left font-semibold">状態</th>
                    <th className="px-4 py-3 text-left font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {customHolidays.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                        登録されている学校独自休日・祝日補正はありません（内蔵SYSTEM祝日エンジンが稼働中）
                      </td>
                    </tr>
                  ) : (
                    customHolidays.map((ch) => (
                      <tr key={ch.id} className="hover:bg-slate-50/80">
                        <td className="px-4 py-3 font-mono font-bold text-slate-800">{ch.holiday_date}</td>
                        <td className="px-4 py-3 font-bold text-slate-900">{ch.name}</td>
                        <td className="px-4 py-3 text-slate-600">
                          {ch.holiday_type === 'SCHOOL_HOLIDAY' && '学校独自休日'}
                          {ch.holiday_type === 'MUNICIPALITY_HOLIDAY' && '自治体休日'}
                          {ch.holiday_type === 'NATIONAL_LEGAL_OVERRIDE' && '祝日法改正補正'}
                        </td>
                        <td className="px-4 py-3 text-slate-500">{ch.source}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            ch.is_active === 1 ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'
                          }`}>
                            {ch.is_active === 1 ? '有効' : '無効'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => handleToggleHoliday(ch.id)}
                            className="px-2 py-1 border border-slate-300 hover:bg-slate-100 rounded text-[11px] font-medium"
                          >
                            {ch.is_active === 1 ? '無効化' : '有効化'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 承認フロー・ポリシー管理 タブ */}
      {/* ========================================================================= */}
      {/* 承認フロー・ポリシー管理 (Policy-Driven ワークフロー基盤) */}
      {/* ========================================================================= */}
      {activeTab === 'workflow-policies' && (
        <WorkflowPolicyManager />
      )}

      {activeTab === 'audit' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-600" />
              <span>最新の操作監査ログ (直近100件 / 改ざん検知ハッシュチェーン付き不変ログ)</span>
            </h3>
            <span className="text-[11px] text-slate-500">※ 業務ロールバック時も不正操作ログは独立永続化されます</span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">日時 (Server Time)</th>
                  <th className="px-4 py-2.5 text-left font-semibold">操作者 (Actor)</th>
                  <th className="px-4 py-2.5 text-left font-semibold">対象教員 (Subject)</th>
                  <th className="px-4 py-2.5 text-left font-semibold">申請形態</th>
                  <th className="px-4 py-2.5 text-left font-semibold">操作アクション</th>
                  <th className="px-4 py-2.5 text-left font-semibold">成否</th>
                  <th className="px-4 py-2.5 text-left font-semibold">IPアドレス</th>
                  <th className="px-4 py-2.5 text-left font-semibold">コメント</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {logs.map((log) => {
                  let formattedTime = '-';
                  try {
                    const t = log.timestamp || (log as any).server_timestamp;
                    if (t) formattedTime = new Date(t).toLocaleString('ja-JP');
                  } catch {
                    formattedTime = '-';
                  }

                  return (
                    <tr key={log.id} className={log.is_success === 0 ? 'bg-rose-50/60' : 'hover:bg-slate-50'}>
                      <td className="px-4 py-2 whitespace-nowrap font-mono text-slate-600">{formattedTime}</td>
                      <td className="px-4 py-2 font-semibold text-slate-800">
                        {(log as any).actor_username || log.username || '-'}
                      </td>
                      <td className="px-4 py-2 text-slate-700">
                        {(log as any).subject_user_id ? `教員#${(log as any).subject_user_id}` : '-'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {(log as any).submission_actor_type ? (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              (log as any).submission_actor_type === 'PROXY'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {(log as any).submission_actor_type}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono font-bold text-blue-700">{log.action || '-'}</td>
                      <td className="px-4 py-2">
                        {log.is_success === 1 ? (
                          <span className="text-emerald-600 font-bold">成功</span>
                        ) : (
                          <span className="text-rose-600 font-bold">遮断 (403/400)</span>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-slate-500">{log.ip_address}</td>
                      <td className="px-4 py-2 text-slate-700 max-w-md truncate" title={log.comment || ''}>
                        {log.comment}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. システム状態・バックアップ タブ */}
      {/* ========================================================================= */}
      {activeTab === 'system' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <Database className="w-4 h-4 text-purple-600" />
                  <span>多層データ保全・バックアップ管理</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">SQLite VACUUM INTO + SHA-256チェックサム検証付きバックアップ</p>
              </div>
              <button
                onClick={handleManualBackup}
                disabled={backupLoading}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition shadow-sm disabled:opacity-50"
              >
                <HardDriveDownload className={`w-4 h-4 ${backupLoading ? 'animate-bounce' : ''}`} />
                <span>{backupLoading ? 'バックアップ作成中...' : '手動バックアップを即時実行'}</span>
              </button>
            </div>

            {backupMessage && (
              <div className="p-3 bg-purple-50 border border-purple-200 text-purple-900 rounded-xl text-xs mb-4">
                {backupMessage}
              </div>
            )}

            {systemStatus && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <span className="text-slate-500 block mb-1">データベース整合性</span>
                  <span className="font-bold text-emerald-700 flex items-center gap-1">
                    <CheckCircle className="w-4 h-4" />
                    {systemStatus.integrity}
                  </span>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <span className="text-slate-500 block mb-1">LAN アクセスIP</span>
                  <span className="font-mono font-bold text-slate-800">{systemStatus.lanIps.join(', ') || 'localhost'}</span>
                </div>
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <span className="text-slate-500 block mb-1">稼働時間 (Uptime)</span>
                  <span className="font-mono font-bold text-slate-800">{Math.floor(systemStatus.uptimeSeconds / 60)} 分</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 権限変更モーダル */}
      {roleModalUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 border border-slate-200 animate-in fade-in zoom-in duration-150">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Shield className="w-4 h-4 text-purple-600" />
                <span>教職員 権限（ロール）変更</span>
              </h3>
              <button onClick={() => setRoleModalUser(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 mb-4">
              対象教職員: <strong className="text-slate-900">{roleModalUser.displayName}</strong> ({roleModalUser.username})
            </p>

            {roleSaveError && (
              <div className="p-3 mb-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs">
                {roleSaveError}
              </div>
            )}

            <form onSubmit={handleSaveRoles} className="space-y-3">
              {AVAILABLE_ROLES.map((role) => {
                const checked = selectedRoles.includes(role.id);
                return (
                  <label
                    key={role.id}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ${
                      checked ? 'bg-purple-50/60 border-purple-300' : 'bg-white border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedRoles([...selectedRoles, role.id]);
                        } else {
                          setSelectedRoles(selectedRoles.filter((r) => r !== role.id));
                        }
                      }}
                      className="mt-0.5 rounded text-purple-600 focus:ring-purple-500"
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800">{role.name}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">{role.desc}</div>
                    </div>
                  </label>
                );
              })}

              <div className="flex justify-end gap-2 pt-4">
                <button
                  type="button"
                  onClick={() => setRoleModalUser(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={roleSaveLoading}
                  className="px-4 py-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 rounded-xl transition disabled:opacity-50 shadow-sm"
                >
                  {roleSaveLoading ? '保存中...' : '権限を保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 統合 役割・役職管理モーダル (Unified Role & Position Modal: Option U3) */}
      {unifiedModalUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full p-6 border border-slate-200 animate-in fade-in zoom-in duration-150 my-8 space-y-5">
            <div className="flex justify-between items-start border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-purple-600" />
                  <span>教職員 役割・役職 統合管理 (Unified Administration)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  対象教職員: <strong className="text-slate-900">{unifiedModalUser.displayName}</strong> ({unifiedModalUser.username})
                </p>
              </div>
              <button
                onClick={() => setUnifiedModalUser(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {unifiedError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{unifiedError}</span>
              </div>
            )}

            {unifiedSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs flex items-center gap-2">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>{unifiedSuccess}</span>
              </div>
            )}

            {/* Auto-Suggest Recommendation Banner (Auto-Suggest = ALLOWED, Auto-Select = PROHIBITED) */}
            {unifiedSuggestion && (
              <div className="p-3.5 bg-amber-50 border border-amber-300 rounded-xl text-amber-900 text-xs flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                  <div>
                    <span className="font-bold">適合性推奨（Auto-Suggest）: </span>
                    <span>役職「{unifiedSuggestion.positionName}」の職掌を果たすには「{unifiedSuggestion.roleName}」が必要です。</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleExplicitAddSuggestedRole(unifiedSuggestion.roleId)}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold shrink-0 transition shadow-2xs"
                >
                  +{unifiedSuggestion.roleId} ロールを追加
                </button>
              </div>
            )}

            <form onSubmit={handleSaveUnifiedAccess} className="space-y-5 text-xs">
              {/* 1. 認可ロール (Capability) 設定 */}
              <div>
                <h4 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-purple-600" />
                  <span>認可ロール (Role = Capability: 何を起案・承認・操作できるか)</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {AVAILABLE_ROLES.map((role) => {
                    const checked = unifiedRoles.includes(role.id);
                    return (
                      <label
                        key={role.id}
                        className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition ${
                          checked ? 'bg-purple-50/70 border-purple-300' : 'bg-white border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setUnifiedRoles([...unifiedRoles, role.id]);
                            } else {
                              setUnifiedRoles(unifiedRoles.filter((r) => r !== role.id));
                            }
                          }}
                          className="mt-0.5 rounded text-purple-600 focus:ring-purple-500"
                        />
                        <div>
                          <div className="font-bold text-slate-800">{role.name}</div>
                          <div className="text-[10px] text-slate-500 mt-0.5">{role.desc}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* 2. 組織役職 (Position = Organizational Fact + Workflow Actor Selector) */}
              <div>
                <h4 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5">
                  <Award className="w-3.5 h-3.5 text-indigo-600" />
                  <span>組織役職 (Position = 組織Fact / 単一承認者セレクター)</span>
                </h4>

                {/* 現在有効な役職 */}
                <div className="mb-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="text-[11px] font-semibold text-slate-600 mb-1.5">現在の有効な役職履歴:</div>
                  {userPositions.length === 0 ? (
                    <div className="text-slate-400 text-[11px]">役職は設定されていません</div>
                  ) : (
                    <div className="flex gap-2 flex-wrap">
                      {userPositions.map((up) => {
                        const today = new Date().toISOString().split('T')[0];
                        const isActive = up.effective_from <= today && (!up.effective_to || up.effective_to >= today);
                        return (
                          <div
                            key={up.id}
                            className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 ${
                              isActive ? 'bg-indigo-50 border-indigo-200 text-indigo-900' : 'bg-slate-100 border-slate-200 text-slate-500'
                            }`}
                          >
                            <span className="font-bold">{up.position_name}</span>
                            <span className="font-mono text-[10px]">({up.effective_from}〜{up.effective_to || '無期限'})</span>
                            {up.is_primary === 1 && <span className="text-[9px] bg-indigo-600 text-white px-1 rounded font-bold">主</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 新規役職割当フォーム (インライン) */}
                <div className="p-3.5 bg-indigo-50/40 rounded-xl border border-indigo-200 space-y-2.5">
                  <div className="font-bold text-indigo-950 flex items-center gap-1">
                    <PlusCircle className="w-3 h-3 text-indigo-600" />
                    <span>役職の新規割当・変更 (任意)</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">役職マスタ</label>
                      <select
                        value={newPositionId}
                        onChange={(e) => handlePositionSelectionChange(e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-medium focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      >
                        <option value="">割当なし / 役職を選択...</option>
                        {positionsMaster.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.holder_type === 'SINGLE_HOLDER' ? '単一担当' : '複数担当可'})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">有効開始日</label>
                      <input
                        type="date"
                        value={newPosEffectiveFrom}
                        onChange={(e) => setNewPosEffectiveFrom(e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-mono"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">有効終了日</label>
                      <input
                        type="date"
                        value={newPosEffectiveTo}
                        onChange={(e) => setNewPosEffectiveTo(e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-mono"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-slate-800">
                      <input
                        type="checkbox"
                        checked={newPosIsPrimary}
                        onChange={(e) => setNewPosIsPrimary(e.target.checked)}
                        className="rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>主たる役職として設定 (is_primary)</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* 変更理由 */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">一括変更理由 (任意・監査ログ ChangeSet に記録)</label>
                <input
                  type="text"
                  value={unifiedReason}
                  onChange={(e) => setUnifiedReason(e.target.value)}
                  placeholder="例: 定期人事異動・分掌変更に伴う役割および役職の統合更新"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setUnifiedModalUser(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={unifiedSaveLoading}
                  className="px-5 py-2 text-xs font-bold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 rounded-xl transition disabled:opacity-50 shadow-sm flex items-center gap-1.5"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{unifiedSaveLoading ? '統合更新を実行中...' : '役割・役職を一括保存 (Atomic)'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 教職員 改姓・氏名変更モーダル */}
      {nameModalUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 border border-slate-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-purple-600" />
                <span>教職員 氏名変更・改姓対応</span>
              </h3>
              <button onClick={() => setNameModalUser(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-500 mb-4">
              対象職員: <strong className="text-slate-800">{(nameModalUser as any).display_name || nameModalUser.displayName}</strong> ({nameModalUser.username})
            </p>

            {nameSaveError && (
              <div className="p-3 mb-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs">
                {nameSaveError}
              </div>
            )}

            <form onSubmit={handleSaveName} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">氏名 (フルネーム) *</label>
                <input
                  type="text"
                  required
                  value={editNameDisplayName}
                  onChange={(e) => handleEditDisplayNameChange(e.target.value)}
                  placeholder="例: 佐藤 健太"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-600 mb-1">姓 (苗字)</label>
                  <input
                    type="text"
                    value={editNameFamilyName}
                    onChange={(e) => setEditNameFamilyName(e.target.value)}
                    placeholder="例: 佐藤"
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 mb-1">名 (名前)</label>
                  <input
                    type="text"
                    value={editNameGivenName}
                    onChange={(e) => setEditNameGivenName(e.target.value)}
                    placeholder="例: 健太"
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-indigo-900 mb-1">電子印影 名字 (最大4文字)</label>
                  <input
                    type="text"
                    maxLength={4}
                    value={editNameStampName}
                    onChange={(e) => setEditNameStampName(e.target.value)}
                    placeholder="例: 佐藤"
                    className="w-full px-2.5 py-1.5 border border-indigo-300 rounded-lg bg-indigo-50/40 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">変更理由・辞令番号等 (任意・監査ログ記録)</label>
                <input
                  type="text"
                  value={editNameReason}
                  onChange={(e) => setEditNameReason(e.target.value)}
                  placeholder="例: 戸籍改姓届出受理に伴う変更（辞令番号等）"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-[11px] leading-relaxed">
                <p className="font-bold mb-0.5">※ 履歴保全（Historical Record Immutability）について</p>
                <p>
                  改姓前の過去に確定した決裁履歴・出勤簿確定印影・監査ログのスナップショットは当時の氏名のまま厳格に保全され、改ざん・上書きされません。本変更は以降の新しい起案・承認・帳票出力に適用されます。
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setNameModalUser(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={nameSaveLoading}
                  className="px-4 py-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 rounded-xl transition disabled:opacity-50 shadow-sm"
                >
                  {nameSaveLoading ? '更新中...' : '氏名を更新 (監査記録)'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 組織役職（Position）管理モーダル */}
      {positionModalUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-6 border border-slate-200 animate-in fade-in zoom-in duration-150 my-8 space-y-5">
            <div className="flex justify-between items-start border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Award className="w-4 h-4 text-indigo-600" />
                  <span>教職員 組織役職（Position）管理</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  対象教職員: <strong className="text-slate-900">{positionModalUser.displayName}</strong> ({positionModalUser.username})
                </p>
              </div>
              <button
                onClick={() => setPositionModalUser(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {positionError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{positionError}</span>
              </div>
            )}

            {positionSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs flex items-center gap-2">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>{positionSuccess}</span>
              </div>
            )}

            {/* 現在の役職割当履歴テーブル */}
            <div>
              <h4 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-indigo-600" />
                <span>役職割当履歴一覧 (物理削除禁止・有効期間管理)</span>
              </h4>

              {positionLoading && userPositions.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400">読み込み中...</div>
              ) : userPositions.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400 border border-dashed rounded-xl">
                  役職が設定されていません
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
                  <table className="min-w-full divide-y divide-slate-200 text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold">役職名</th>
                        <th className="px-3 py-2 text-left font-semibold">担当種別</th>
                        <th className="px-3 py-2 text-left font-semibold">有効期間</th>
                        <th className="px-3 py-2 text-left font-semibold">主役職</th>
                        <th className="px-3 py-2 text-left font-semibold">状態</th>
                        <th className="px-3 py-2 text-left font-semibold">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {userPositions.map((up) => {
                        const today = new Date().toISOString().split('T')[0];
                        const isCurrentlyActive = up.effective_from <= today && (!up.effective_to || up.effective_to >= today);
                        const isPast = up.effective_to && up.effective_to < today;
                        const isFuture = up.effective_from > today;

                        return (
                          <tr key={up.id} className={isCurrentlyActive ? 'bg-indigo-50/40' : ''}>
                            <td className="px-3 py-2 font-bold text-slate-800">{up.position_name}</td>
                            <td className="px-3 py-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                up.holder_type === 'SINGLE_HOLDER' ? 'bg-amber-100 text-amber-900 border border-amber-300' : 'bg-slate-100 text-slate-700 border border-slate-200'
                              }`}>
                                {up.holder_type === 'SINGLE_HOLDER' ? '単一担当' : '複数担当可'}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-slate-700">
                              {up.effective_from} 〜 {up.effective_to === '9999-12-31' ? '無期限' : up.effective_to}
                            </td>
                            <td className="px-3 py-2">
                              {up.is_primary === 1 ? (
                                <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold">主たる役職</span>
                              ) : (
                                <span className="text-slate-400 text-[11px]">-</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {isCurrentlyActive ? (
                                <span className="text-emerald-700 font-bold flex items-center gap-1 text-[11px]">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> 有効
                                </span>
                              ) : isFuture ? (
                                <span className="text-blue-600 font-semibold text-[11px]">予約 (未来)</span>
                              ) : (
                                <span className="text-slate-400 text-[11px]">終了 (過去)</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                {isCurrentlyActive && (
                                  <button
                                    onClick={() => {
                                      setEndingAssignment(up);
                                      setEndPosDate(today);
                                      setEndPosReason('');
                                      setPositionError('');
                                    }}
                                    className="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded font-semibold text-[10px] shadow-2xs"
                                  >
                                    期間終了
                                  </button>
                                )}
                                {isPast && (
                                  <button
                                    onClick={() => {
                                      setCorrectingAssignment(up);
                                      setCorrectPosFrom(up.effective_from);
                                      setCorrectPosTo(up.effective_to);
                                      setCorrectPosIsPrimary(up.is_primary === 1);
                                      setCorrectPosReason('');
                                      setPositionError('');
                                    }}
                                    className="px-2 py-1 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-300 rounded font-semibold text-[10px] shadow-2xs"
                                  >
                                    履歴訂正
                                  </button>
                                )}
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

            {/* 新規役職割当フォーム */}
            {!endingAssignment && !correctingAssignment && (
              <form onSubmit={handleAssignPosition} className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
                <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <PlusCircle className="w-3.5 h-3.5 text-indigo-600" />
                  <span>新しい役職を割り当て</span>
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">役職マスタ選択 *</label>
                    <select
                      value={newPositionId}
                      onChange={(e) => setNewPositionId(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-medium"
                      required
                    >
                      {positionsMaster.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.holder_type === 'SINGLE_HOLDER' ? '単一担当' : '複数担当可'}) - {p.description || ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">有効開始日 (YYYY-MM-DD) *</label>
                    <input
                      type="date"
                      value={newPosEffectiveFrom}
                      onChange={(e) => setNewPosEffectiveFrom(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                      required
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">有効終了日 (未定は 9999-12-31) *</label>
                    <input
                      type="date"
                      value={newPosEffectiveTo}
                      onChange={(e) => setNewPosEffectiveTo(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                      required
                    />
                  </div>

                  <div className="flex items-center pt-5">
                    <label className="flex items-center gap-2 cursor-pointer font-semibold text-slate-800">
                      <input
                        type="checkbox"
                        checked={newPosIsPrimary}
                        onChange={(e) => setNewPosIsPrimary(e.target.checked)}
                        className="rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>主たる役職として設定 (is_primary)</span>
                    </label>
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={positionLoading}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition shadow-sm disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Award className="w-3.5 h-3.5" />
                    <span>{positionLoading ? '割当中...' : '役職を割り当て'}</span>
                  </button>
                </div>
              </form>
            )}

            {/* 役職終了 (END) サブフォーム */}
            {endingAssignment && (
              <form onSubmit={handleExecuteEndPosition} className="p-4 bg-amber-50 rounded-xl border border-amber-300 space-y-3">
                <div className="flex justify-between items-center">
                  <h4 className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-amber-700" />
                    <span>役職の有効期間終了: 「{endingAssignment.position_name}」</span>
                  </h4>
                  <button
                    type="button"
                    onClick={() => setEndingAssignment(null)}
                    className="text-amber-800 hover:text-slate-900 text-xs font-semibold"
                  >
                    キャンセル
                  </button>
                </div>
                <p className="text-[11px] text-amber-800">
                  ※ 過去の組織事実を保全するため、物理削除は行わず終了日（effective_to）を設定します。
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-semibold text-amber-950 mb-1">終了日 (endDate: YYYY-MM-DD) *</label>
                    <input
                      type="date"
                      value={endPosDate}
                      onChange={(e) => setEndPosDate(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-amber-300 rounded-lg bg-white font-mono"
                      required
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-amber-950 mb-1">終了理由 / 異動メモ (任意)</label>
                    <input
                      type="text"
                      value={endPosReason}
                      onChange={(e) => setEndPosReason(e.target.value)}
                      placeholder="例: 定期人事異動による後任交代"
                      className="w-full px-2.5 py-1.5 border border-amber-300 rounded-lg bg-white"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setEndingAssignment(null)}
                    className="px-3 py-1.5 bg-white border border-amber-300 text-slate-700 rounded-lg text-xs font-semibold"
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={positionLoading}
                    className="px-4 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded-lg text-xs font-bold shadow-2xs disabled:opacity-50"
                  >
                    {positionLoading ? '処理中...' : '指定日で役職期間を終了'}
                  </button>
                </div>
              </form>
            )}

            {/* 過去履歴訂正 (CORRECTION) サブフォーム */}
            {correctingAssignment && (
              <form onSubmit={handleExecuteCorrectPosition} className="p-4 bg-purple-50 rounded-xl border border-purple-300 space-y-3">
                <div className="flex justify-between items-center">
                  <h4 className="text-xs font-bold text-purple-900 flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5 text-purple-700" />
                    <span>過去役職履歴の訂正: 「{correctingAssignment.position_name}」</span>
                  </h4>
                  <button
                    type="button"
                    onClick={() => setCorrectingAssignment(null)}
                    className="text-purple-800 hover:text-slate-900 text-xs font-semibold"
                  >
                    キャンセル
                  </button>
                </div>
                <p className="text-[11px] text-purple-800">
                  ※ 過去の履歴訂正は厳格な監査証跡（CORRECT_USER_POSITION）として記録されます。過去の承認スナップショットは変更されません。
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-semibold text-purple-950 mb-1">訂正後 開始日 *</label>
                    <input
                      type="date"
                      value={correctPosFrom}
                      onChange={(e) => setCorrectPosFrom(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-purple-300 rounded-lg bg-white font-mono"
                      required
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-purple-950 mb-1">訂正後 終了日 *</label>
                    <input
                      type="date"
                      value={correctPosTo}
                      onChange={(e) => setCorrectPosTo(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-purple-300 rounded-lg bg-white font-mono"
                      required
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block font-semibold text-rose-700 mb-1">訂正理由 (必須・監査ログ記録) *</label>
                    <input
                      type="text"
                      value={correctPosReason}
                      onChange={(e) => setCorrectPosReason(e.target.value)}
                      placeholder="例: 発令日入力誤りの訂正（辞令番号: xxx）"
                      className="w-full px-2.5 py-1.5 border border-rose-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-rose-500"
                      required
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setCorrectingAssignment(null)}
                    className="px-3 py-1.5 bg-white border border-purple-300 text-slate-700 rounded-lg text-xs font-semibold"
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={positionLoading}
                    className="px-4 py-1.5 bg-purple-700 hover:bg-purple-800 text-white rounded-lg text-xs font-bold shadow-2xs disabled:opacity-50"
                  >
                    {positionLoading ? '訂正中...' : '履歴訂正を実行 (監査記録)'}
                  </button>
                </div>
              </form>
            )}

            <div className="flex justify-end pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setPositionModalUser(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新規教職員登録モーダル */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-purple-600" />
                <span>新規教職員の登録</span>
              </h3>
              <button onClick={() => setIsCreateModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {createError && (
              <div className="p-3 mb-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateUser} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">ユーザーID (ログインID) *</label>
                  <input
                    type="text"
                    required
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="例: teacher3"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">初期パスワード *</label>
                  <input
                    type="text"
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">氏名 (フルネーム) *</label>
                <input
                  type="text"
                  required
                  value={newDisplayName}
                  onChange={(e) => handleDisplayNameChange(e.target.value)}
                  placeholder="例: 佐藤 健太"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-medium text-slate-600 mb-1">姓 (苗字)</label>
                  <input
                    type="text"
                    value={newFamilyName}
                    onChange={(e) => setNewFamilyName(e.target.value)}
                    placeholder="例: 佐藤"
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 mb-1">名 (名前)</label>
                  <input
                    type="text"
                    value={newGivenName}
                    onChange={(e) => setNewGivenName(e.target.value)}
                    placeholder="例: 健太"
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-indigo-900 mb-1">電子印影 名字 (最大4文字)</label>
                  <input
                    type="text"
                    maxLength={4}
                    value={newStampName}
                    onChange={(e) => setNewStampName(e.target.value)}
                    placeholder="例: 佐藤"
                    className="w-full px-2.5 py-1.5 border border-indigo-300 rounded-lg bg-indigo-50/40 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">所属部署・学年</label>
                  <input
                    type="text"
                    value={newDepartment}
                    onChange={(e) => setNewDepartment(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">初期年休付与日数 (日)</label>
                  <input
                    type="number"
                    min={0}
                    max={40}
                    value={newLeaveDays}
                    onChange={(e) => setNewLeaveDays(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-2">割り当て権限ロール *</label>
                <div className="space-y-1.5">
                  {AVAILABLE_ROLES.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 p-2 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newRoles.includes(r.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewRoles([...newRoles, r.id]);
                          } else {
                            setNewRoles(newRoles.filter((role) => role !== r.id));
                          }
                        }}
                        className="rounded text-purple-600 focus:ring-purple-500"
                      />
                      <span className="font-semibold text-slate-800">{r.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="px-4 py-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 rounded-xl transition disabled:opacity-50 shadow-sm"
                >
                  {createLoading ? '登録中...' : '教職員を登録'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 5. 勤務割振り・定例週休履歴 設定モーダル */}
      {/* ========================================================================= */}
      {isPatternModalOpen && selectedUserForPattern && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start border-b border-slate-100 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Briefcase className="w-5 h-5 text-purple-600" />
                  <span>週間勤務割振り ＆ 定例週休曜日 履歴管理</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  対象職員: <strong className="text-slate-800 font-bold">{selectedUserForPattern.displayName || selectedUserForPattern.display_name}</strong> (ユーザー名: <span className="font-mono">{selectedUserForPattern.username}</span>)
                </p>
              </div>
              <button
                onClick={() => setIsPatternModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {patternError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{patternError}</span>
              </div>
            )}

            {/* 期間重複時のスマート短縮サジェストバナー */}
            {overlapSuggestion && (
              <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl space-y-3 shadow-2xs">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-900">
                    <p className="font-bold">期間の重複を検出しました（自動調整サポート）</p>
                    <p className="mt-1 text-amber-800 leading-relaxed">
                      既存の「<strong>{overlapSuggestion.targetPattern.patternName}</strong>」の期間（{overlapSuggestion.targetPattern.effectiveFrom}〜{overlapSuggestion.targetPattern.effectiveTo}）を
                      <strong className="text-purple-900 underline mx-1">{overlapSuggestion.targetPattern.effectiveFrom} 〜 {overlapSuggestion.suggestedEndDate}</strong>
                      に短縮し、新規パターン（{overlapSuggestion.newPatternParams.effectiveFrom}〜）を登録しますか？
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-1 border-t border-amber-200">
                  <button
                    type="button"
                    onClick={() => setOverlapSuggestion(null)}
                    className="px-3 py-1.5 bg-white hover:bg-slate-50 border border-amber-300 text-slate-700 rounded-lg text-xs font-semibold"
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    disabled={patternLoading}
                    onClick={handleApplyOverlapResolution}
                    className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold shadow-2xs flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>既存期間を短縮して登録</span>
                  </button>
                </div>
              </div>
            )}

            {/* 適用履歴テーブル */}
            <div>
              <h4 className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-slate-500" />
                <span>適用期間別 勤務パターン履歴</span>
              </h4>
              {patternLoading && userPatterns.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400">読み込み中...</div>
              ) : userPatterns.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400 border border-dashed rounded-xl">
                  勤務パターンが登録されていません
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
                  <table className="min-w-full divide-y divide-slate-200 text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold">パターン名 / 種別</th>
                        <th className="px-3 py-2 text-left font-semibold">適用期間</th>
                        <th className="px-3 py-2 text-left font-semibold">定例週休日</th>
                        <th className="px-3 py-2 text-left font-semibold">週勤務時間</th>
                        <th className="px-3 py-2 text-left font-semibold">備考 / 登録元</th>
                        <th className="px-3 py-2 text-left font-semibold">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {userPatterns.map((pat) => {
                        const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
                        const isEditing = editingPatternId === pat.id;

                        if (isEditing) {
                          return (
                            <tr key={pat.id} className="bg-purple-50/60">
                              <td className="px-3 py-2 space-y-1">
                                <input
                                  type="text"
                                  value={editPatternName}
                                  onChange={(e) => setEditPatternName(e.target.value)}
                                  className="w-full px-2 py-1 text-xs border border-purple-300 rounded bg-white font-bold"
                                  placeholder="パターン名"
                                />
                                <select
                                  value={editPatternType}
                                  onChange={(e) => setEditPatternType(e.target.value as any)}
                                  className="w-full px-2 py-0.5 text-[11px] border border-purple-200 rounded bg-white"
                                >
                                  <option value="SHORT_TIME">短時間勤務</option>
                                  <option value="STANDARD_FULLTIME">通常フルタイム</option>
                                  <option value="CUSTOM">その他変形</option>
                                </select>
                              </td>
                              <td className="px-3 py-2 space-y-1 font-mono">
                                <input
                                  type="date"
                                  value={editEffectiveFrom}
                                  onChange={(e) => setEditEffectiveFrom(e.target.value)}
                                  className="w-full px-1.5 py-0.5 text-xs border border-purple-300 rounded bg-white"
                                />
                                <input
                                  type="date"
                                  value={editEffectiveTo}
                                  onChange={(e) => setEditEffectiveTo(e.target.value)}
                                  className="w-full px-1.5 py-0.5 text-xs border border-purple-300 rounded bg-white"
                                />
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex gap-1 flex-wrap">
                                  {[0, 1, 2, 3, 4, 5, 6].map((d) => {
                                    const sel = editWeeklyOffDays.includes(d);
                                    return (
                                      <button
                                        key={d}
                                        type="button"
                                        onClick={() => {
                                          if (sel) {
                                            setEditWeeklyOffDays(editWeeklyOffDays.filter((x) => x !== d));
                                          } else {
                                            setEditWeeklyOffDays([...editWeeklyOffDays, d].sort((a, b) => a - b));
                                          }
                                        }}
                                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
                                          sel ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-500 border-slate-200'
                                        }`}
                                      >
                                        {dayNames[d]}
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                              <td className="px-3 py-2 font-mono text-slate-500 text-[11px]">
                                {(pat.weekly_total_minutes / 60).toFixed(1)}h
                              </td>
                              <td className="px-3 py-2">
                                <input
                                  type="text"
                                  value={editPatternMemo}
                                  onChange={(e) => setEditPatternMemo(e.target.value)}
                                  placeholder="備考"
                                  className="w-full px-2 py-1 text-[11px] border border-purple-200 rounded bg-white"
                                />
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handleSaveEditPattern(pat.id)}
                                    disabled={patternLoading}
                                    className="p-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded shadow-2xs"
                                    title="保存"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={handleCancelEditPattern}
                                    className="p-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded"
                                    title="キャンセル"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        }

                        const offDayList = pat.weekly_off_days
                          .split(',')
                          .map((d) => Number(d.trim()))
                          .filter((d) => !isNaN(d))
                          .sort((a, b) => a - b);
                        const offDayStr = offDayList.map((d) => `${dayNames[d]}曜`).join('・');

                        return (
                          <tr key={pat.id} className="hover:bg-slate-50">
                            <td className="px-3 py-2">
                              <div className="font-bold text-slate-900">{pat.pattern_name}</div>
                              <div className="flex gap-1 flex-wrap mt-0.5">
                                <span className={`inline-block text-[10px] px-1.5 py-0.2 rounded font-semibold border ${
                                  pat.pattern_type === 'SHORT_TIME'
                                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                                    : pat.pattern_type === 'CUSTOM'
                                    ? 'bg-indigo-50 text-indigo-800 border-indigo-200'
                                    : 'bg-slate-50 text-slate-700 border-slate-200'
                                }`}>
                                  {pat.pattern_type === 'SHORT_TIME' ? '短時間勤務' : pat.pattern_type === 'CUSTOM' ? '変形/独自' : '通常フルタイム'}
                                </span>
                                {pat.statutory_pattern_code && (
                                  <span className="inline-block text-[10px] px-1.5 py-0.2 rounded font-semibold bg-purple-50 text-purple-800 border border-purple-200 font-mono">
                                    {pat.statutory_pattern_code}
                                  </span>
                                )}
                                {(pat as any).schedule_source && (
                                  <span className={`inline-block text-[10px] px-1.5 py-0.2 rounded font-semibold border ${
                                    (pat as any).schedule_source === 'SCHOOL_DEFAULT'
                                      ? 'bg-blue-50 text-blue-800 border-blue-200'
                                      : 'bg-teal-50 text-teal-800 border-teal-200'
                                  }`}>
                                    {(pat as any).schedule_source === 'SCHOOL_DEFAULT' ? '学校標準' : '個別日課'}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                              <div>{pat.effective_from}</div>
                              <div className="text-slate-400">〜 {pat.effective_to === '9999-12-31' ? '（無期限）' : pat.effective_to}</div>
                            </td>
                            <td className="px-3 py-2">
                              <span className="font-semibold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-100">
                                {offDayStr || 'なし'}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-slate-600">
                              {(pat.weekly_total_minutes / 60).toFixed(1)} 時間 ({pat.weekly_total_minutes}分)
                            </td>
                            <td className="px-3 py-2 text-[11px] text-slate-500">
                              <div>{pat.memo || '-'}</div>
                              <span className="text-[10px] text-slate-400">[{pat.record_origin}]</span>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleStartEditPattern(pat)}
                                  className="p-1 text-slate-400 hover:text-indigo-600 rounded transition"
                                  title="このパターン（期間・週休日）を編集"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDeletePattern(pat.id)}
                                  className="p-1 text-slate-400 hover:text-rose-600 rounded transition"
                                  title="このパターン履歴を削除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
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

            {/* 新規パターン追加フォーム */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-4">
              <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <PlusCircle className="w-4 h-4 text-purple-600" />
                <span>新規勤務割振りパターン（期間指定）の登録</span>
              </h4>
              <form onSubmit={handleCreatePattern} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">パターン名 *</label>
                    <input
                      type="text"
                      required
                      value={newPatternName}
                      onChange={(e) => setNewPatternName(e.target.value)}
                      placeholder="例: 週4日勤務 (水曜週休)"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">パターン種別 *</label>
                    <select
                      value={newPatternType}
                      onChange={(e) => setNewPatternType(e.target.value as any)}
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500"
                    >
                      <option value="SHORT_TIME">短時間勤務職員 (条例に基づく平日週休)</option>
                      <option value="STANDARD_FULLTIME">通常フルタイム (週5日・土日週休)</option>
                      <option value="CUSTOM">その他変形・独自勤務</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">勤務時間の適用方式 *</label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label
                      className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer select-none transition ${
                        newScheduleSource === 'SCHOOL_DEFAULT'
                          ? 'bg-purple-50 border-purple-300 text-purple-900 font-bold'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="newScheduleSource"
                        value="SCHOOL_DEFAULT"
                        checked={newScheduleSource === 'SCHOOL_DEFAULT'}
                        onChange={() => setNewScheduleSource('SCHOOL_DEFAULT')}
                        className="mt-0.5 text-purple-600 focus:ring-purple-500"
                      />
                      <div>
                        <div className="font-bold">学校の標準勤務時間を使用する</div>
                        <div className="text-[10px] text-slate-500 font-normal">全校共通の日課表（週38時間45分）に従います</div>
                      </div>
                    </label>

                    <label
                      className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer select-none transition ${
                        newScheduleSource === 'INDIVIDUAL'
                          ? 'bg-purple-50 border-purple-300 text-purple-900 font-bold'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="newScheduleSource"
                        value="INDIVIDUAL"
                        checked={newScheduleSource === 'INDIVIDUAL'}
                        onChange={() => setNewScheduleSource('INDIVIDUAL')}
                        className="mt-0.5 text-purple-600 focus:ring-purple-500"
                      />
                      <div>
                        <div className="font-bold">この職員固有の勤務時間を設定する</div>
                        <div className="text-[10px] text-slate-500 font-normal">育児短時間勤務など個別の日課を設定します</div>
                      </div>
                    </label>
                  </div>
                  {newScheduleSource === 'UNSELECTED' && (
                    <p className="text-[10px] text-amber-600 font-medium mt-1">※勤務時間の適用方式を選択してください（未選択の場合は登録できません）</p>
                  )}
                  {newScheduleSource === 'INDIVIDUAL' && (
                    <div className="mt-3 p-3 bg-purple-50/70 rounded-xl border border-purple-200 space-y-3">
                      <div>
                        <div className="text-[11px] font-bold text-purple-900 mb-0.5">
                          個別勤務時間帯の設定（全勤務日共通）
                        </div>
                        <div className="text-[10px] text-slate-500">
                          ※選択した定例週休日以外のすべての曜日にこの勤務時間が適用されます
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1 flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-purple-600" />
                            <span>始業時刻 *</span>
                          </label>
                          <input
                            type="time"
                            required
                            value={newStartTime}
                            onChange={(e) => setNewStartTime(e.target.value)}
                            className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1 flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-purple-600" />
                            <span>終業時刻 *</span>
                          </label>
                          <input
                            type="time"
                            required
                            value={newEndTime}
                            onChange={(e) => setNewEndTime(e.target.value)}
                            className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                          />
                        </div>
                      </div>

                      <div className="space-y-2 pt-1 border-t border-purple-100">
                        <div className="flex items-center justify-between">
                          <label className="text-[11px] font-bold text-slate-700">休憩時間帯（任意）</label>
                          <button
                            type="button"
                            onClick={handleAddBreak}
                            className="text-[10px] font-bold text-purple-700 hover:text-purple-900 flex items-center gap-1 px-2 py-0.5 rounded hover:bg-purple-100 transition"
                          >
                            <PlusCircle className="w-3 h-3" />
                            <span>休憩を追加</span>
                          </button>
                        </div>

                        {newBreaks.length === 0 ? (
                          <div className="text-[10px] text-slate-400 italic py-1">
                            休憩時間帯は設定されていません（連続勤務）
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            {newBreaks.map((brk, idx) => (
                              <div key={idx} className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-500 font-mono w-4">{idx + 1}.</span>
                                <input
                                  type="time"
                                  value={brk.startTime}
                                  onChange={(e) => handleBreakChange(idx, 'startTime', e.target.value)}
                                  className="px-2 py-1 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                                />
                                <span className="text-xs text-slate-400">〜</span>
                                <input
                                  type="time"
                                  value={brk.endTime}
                                  onChange={(e) => handleBreakChange(idx, 'endTime', e.target.value)}
                                  className="px-2 py-1 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleRemoveBreak(idx)}
                                  className="p-1 text-slate-400 hover:text-rose-600 rounded transition"
                                  title="この休憩を削除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">適用開始日 (YYYY-MM-DD) *</label>
                    <input
                      type="date"
                      required
                      value={newEffectiveFrom}
                      onChange={(e) => setNewEffectiveFrom(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">適用終了日 (YYYY-MM-DD) *</label>
                    <input
                      type="date"
                      required
                      value={newEffectiveTo}
                      onChange={(e) => setNewEffectiveTo(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">定例週休曜日（複数選択）*</label>
                  <div className="flex gap-2 flex-wrap">
                    {[
                      { val: 0, name: '日曜日' },
                      { val: 1, name: '月曜日' },
                      { val: 2, name: '火曜日' },
                      { val: 3, name: '水曜日' },
                      { val: 4, name: '木曜日' },
                      { val: 5, name: '金曜日' },
                      { val: 6, name: '土曜日' },
                    ].map((d) => {
                      const checked = newWeeklyOffDays.includes(d.val);
                      return (
                        <label
                          key={d.val}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs cursor-pointer select-none transition ${
                            checked
                              ? 'bg-purple-100 border-purple-300 text-purple-900 font-bold'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setNewWeeklyOffDays([...newWeeklyOffDays, d.val].sort((a, b) => a - b));
                              } else {
                                setNewWeeklyOffDays(newWeeklyOffDays.filter((x) => x !== d.val));
                              }
                            }}
                            className="rounded text-purple-600 focus:ring-purple-500"
                          />
                          <span>{d.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">備考・人事辞令番号等（任意）</label>
                  <input
                    type="text"
                    value={newPatternMemo}
                    onChange={(e) => setNewPatternMemo(e.target.value)}
                    placeholder="例: 令和8年度短時間勤務承認 辞第123号 (週31時間)"
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={patternLoading || newScheduleSource === 'UNSELECTED'}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition shadow-2xs disabled:opacity-50"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    <span>{patternLoading ? '登録中...' : '勤務パターンを追加'}</span>
                  </button>
                </div>
              </form>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsPatternModalOpen(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* パスワード初期化・一時パスワード発行モーダル */}
      {/* ========================================================================= */}
      {resetModalUser && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex justify-between items-start border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-amber-100 text-amber-700 rounded-lg">
                  <Key className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">パスワード初期化</h3>
                  <p className="text-xs text-slate-500">
                    対象: <strong className="text-slate-700">{resetModalUser.displayName}</strong> ({resetModalUser.username})
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setResetModalUser(null);
                  setIssuedTemporaryPassword(null);
                }}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {resetError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 font-medium flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{resetError}</span>
              </div>
            )}

            {!issuedTemporaryPassword ? (
              <div className="space-y-4">
                <p className="text-xs text-slate-600 leading-relaxed">
                  この操作を実行すると、対象教職員の現在のパスワードが無効化され、安全な<strong>ワンタイム一時パスワード</strong>が新規発行されます。<br />
                  教職員の全アクティブセッションは即時無効化（ログアウト）され、次回ログイン時に強制的に新パスワードの設定が要求されます。
                </p>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setResetModalUser(null)}
                    className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    disabled={resetLoading}
                    onClick={handleExecuteResetPassword}
                    className="px-4 py-2 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-xl transition disabled:opacity-50 shadow-sm flex items-center gap-1.5"
                  >
                    {resetLoading ? '初期化中...' : '初期化を実行して一時パスワードを発行'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
                  <div className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                    <CheckCircle className="w-4 h-4 text-emerald-600" />
                    <span>一時パスワードを発行しました</span>
                  </div>
                  <p className="text-xs text-amber-800 leading-relaxed">
                    ※ この一時パスワードは画面を閉じると二度と表示されません。教職員へ安全に対面または確実な経路で伝達してください。
                  </p>
                  <div className="mt-3 p-3 bg-white border border-amber-300 rounded-lg flex items-center justify-between font-mono text-base font-bold text-slate-800 select-all">
                    <span>{issuedTemporaryPassword}</span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(issuedTemporaryPassword);
                        alert('一時パスワードをクリップボードにコピーしました');
                      }}
                      className="p-1.5 hover:bg-amber-100 text-amber-800 rounded-md transition flex items-center gap-1 text-xs font-sans font-medium"
                      title="コピー"
                    >
                      <Copy className="w-4 h-4" />
                      <span>コピー</span>
                    </button>
                  </div>
                </div>
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setResetModalUser(null);
                      setIssuedTemporaryPassword(null);
                    }}
                    className="px-4 py-2 text-xs font-bold text-white bg-slate-800 hover:bg-slate-900 rounded-xl transition shadow-sm"
                  >
                    確認完了（閉じる）
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {selectedUserForJobTitles && (
        <UserJobTitleModal
          user={selectedUserForJobTitles}
          onClose={() => setSelectedUserForJobTitles(null)}
          onUpdated={fetchData}
        />
      )}
    </div>
  );
};

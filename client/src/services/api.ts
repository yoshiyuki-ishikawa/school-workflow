import {
  User,
  Application,
  ApplicationType,
  AuditLog,
  UserLeaveSummary,
  MonthlyAttendanceData,
  OfficialFormTemplate,
  PublicSettings,
  SystemSettings,
  UserWorkPattern,
} from '../types';
import { ApplicationFormSchema } from '../types/formSchema';
import { CanonicalScheduleSource, CanonicalScheduleDetails } from '../utils/workSchedulePayloadProjection';

export interface SchoolWorkSchedule {
  id: number;
  school_id?: number | null;
  schedule_name: string;
  effective_from: string;
  effective_to: string;
  weekly_off_days: string;
  weekly_total_minutes: number;
  schedule_details_json: string;
  is_active: number;
  created_by_user_id?: number | null;
  updated_by_user_id?: number | null;
  created_at: string;
  updated_at: string;
  created_by_user_name?: string | null;
  updated_by_user_name?: string | null;
}

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '/api';

export class ApiError extends Error {
  status: number;
  data: any;
  errorCode?: string;

  constructor(status: number, data: any) {
    const msg = (typeof data === 'object' && data !== null && data.message)
      ? data.message
      : `HTTP error ${status}`;
    super(msg);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.errorCode = data?.errorCode;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',
  });

  const text = await res.text();
  let data: any = {};
  if (text && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data);
  }
  return data as T;
}

export const api = {
  // 認証 & メンバー
  getMe: () => fetchJson<{ success: boolean; user: User | null; pocMode: boolean }>('/auth/me'),
  login: (username: string, password: string) =>
    fetchJson<{ success: boolean; user: User; pocMode: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => fetchJson<{ success: boolean }>('/auth/logout', { method: 'POST' }),
  getPocUsers: () => fetchJson<{ success: boolean; users: User[] }>('/auth/poc-users'),
  getMembers: () => fetchJson<{ success: boolean; members: User[] }>('/auth/members'),
  pocSwitch: (userId: number) =>
    fetchJson<{ success: boolean; user: User }>('/auth/poc-switch', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  changePassword: (data: { currentPassword?: string; newPassword: string }) =>
    fetchJson<{ success: boolean; message: string; user?: User }>('/auth/password', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  adminResetPassword: (userId: number) =>
    fetchJson<{ success: boolean; message: string; temporaryPassword: string; targetUser: { id: number; username: string; displayName: string } }>(
      `/admin/users/${userId}/reset-password`,
      { method: 'POST' }
    ),

  // スキーマ (Wave 1: Application Form Schema SSOT)
  getFormSchema: (typeId: string, date?: string) =>
    fetchJson<{ success: boolean; schema: ApplicationFormSchema }>(
      date ? `/schemas/${typeId}?date=${date}` : `/schemas/${typeId}`
    ),
  getAllFormSchemas: (date?: string) =>
    fetchJson<{ success: boolean; schemas: ApplicationFormSchema[] }>(
      date ? `/schemas?date=${date}` : '/schemas'
    ),

  getApplicationTypes: () => fetchJson<{ success: boolean; types: ApplicationType[] }>('/applications/types'),
  getPolicyRules: () => fetchJson<{ success: boolean; policyRules: any[] }>('/applications/policy-rules'),
  getSpecialLeavePolicies: () => fetchJson<{ success: boolean; policies: any[] }>('/applications/special-leave-policies'),
  getLeaveSummary: (userId?: number) =>
    fetchJson<{ success: boolean; summary: UserLeaveSummary }>(
      userId ? `/applications/leave-summary?userId=${userId}` : '/applications/leave-summary'
    ),
  previewLeaveCalculation: (params: {
    typeId: string;
    targetDate?: string;
    startDate?: string;
    endDate?: string;
    unitType: 'DAY' | 'HALF_DAY' | 'TIME';
    halfDayType?: 'MORNING' | 'AFTERNOON';
    startTime?: string;
    endTime?: string;
    calculatedDays?: number;
    reasonCode?: string;
    subjectUserId?: number;
  }) =>
    fetchJson<{
      success: boolean;
      calculation: {
        isValid: boolean;
        errorCode?: string;
        message?: string;
        detailsText?: string;
        canUpgradeToHalfDay?: boolean;
        currentRemainingDays?: number;
        simulatedRemainingText?: string;
        totalChargedDays?: number;
        totalChargedHours?: number;
        totalChargedMinutes?: number;
        chargeableDaysCount?: number;
        skippedNonWorkingDaysCount?: number;
        perDayResults?: any[];
        snapshot?: any;
      };
    }>('/applications/preview-calculation', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  getApplications: (scope: 'my' | 'pending_approval' | 'all') =>
    fetchJson<{ success: boolean; applications: Application[] }>(`/applications?scope=${scope}`),
  getPendingCount: () =>
    fetchJson<{ success: boolean; data: { pending_count: number } }>('/applications/pending/count'),
  getPendingTasks: (limit?: number, offset?: number) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.append('limit', limit.toString());
    if (offset !== undefined) params.append('offset', offset.toString());
    const q = params.toString();
    return fetchJson<{ success: boolean; data: { total_count: number; tasks: import('../types').PendingTaskItem[] } }>(
      `/applications/pending/tasks${q ? `?${q}` : ''}`
    );
  },
  getApplicationDetail: (id: number) =>
    fetchJson<{ success: boolean; application: Application }>(`/applications/${id}`),
  saveDraft: (params: { id?: number; expectedVersion?: number; typeId: string; title: string; formData: Record<string, any>; subjectUserId?: number }) =>
    fetchJson<{ success: boolean; message: string; data?: { id: number } }>('/applications/draft', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  submitApplication: (params: { id?: number; expectedVersion?: number; typeId: string; title: string; formData: Record<string, any> }) =>
    fetchJson<{ success: boolean; message: string; data?: { id: number } }>('/applications/submit', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  submitProxyApplication: (params: {
    id?: number;
    expectedVersion?: number;
    typeId: string;
    subjectUserId: number;
    title: string;
    formData: Record<string, any>;
    proxyReason?: string;
  }) =>
    fetchJson<{ success: boolean; message: string; data?: { id: number } }>('/applications/proxy', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  submitReport: (
    id: number,
    params: {
      expectedVersion: number;
      reportDate: string;
      reportResult: string;
      reportRemarks?: string;
      actualMatchesPlan: boolean;
      actualDeparturePlace?: string;
      actualArrivalPlace?: string;
      actualTransportMode?: string;
      vehicleUsageType?: 'DRIVER' | 'PASSENGER';
      actualDistanceKm?: number;
      communicationCostBorne?: boolean | null;
      actualTripStartAt?: string;
      actualTripEndAt?: string;
      travelExpenseRemarks?: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string }>(`/applications/${id}/report`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  approveApplication: (id: number, params: { expectedVersion: number; comment?: string }) =>
    fetchJson<{ success: boolean; message: string; data?: { nextStatus: string; stampName: string } }>(
      `/applications/${id}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    ),
  returnApplication: (id: number, params: { expectedVersion: number; comment: string }) =>
    fetchJson<{ success: boolean; message: string }>(`/applications/${id}/return`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  rejectApplication: (id: number, params: { expectedVersion: number; comment: string }) =>
    fetchJson<{ success: boolean; message: string }>(`/applications/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  resubmitApplication: (id: number, params: { expectedVersion: number; title: string; formData: Record<string, any> }) =>
    fetchJson<{ success: boolean; message: string }>(`/applications/${id}/resubmit`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  withdrawApplication: (id: number, params: { expectedVersion: number }) =>
    fetchJson<{ success: boolean; message: string }>(`/applications/${id}/withdraw`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  resolveClassCoverage: (
    id: number,
    params: {
      expectedVersion: number;
      coverageStatus: import('../types/formSchema').ClassCoverageStatus;
      notRequiredReason?: string;
      coverageItems?: import('../types/formSchema').ClassCoverageItem[];
    }
  ) =>
    fetchJson<{ success: boolean; message: string; data?: any }>(`/applications/${id}/coverage`, {
      method: 'PATCH',
      body: JSON.stringify(params),
    }),
  // 承認後取消 (Wave 1: GAP-01)
  requestCancellation: (id: number, params: { expectedVersion: number; cancellationReason: string }) =>
    fetchJson<{ success: boolean; message: string; data?: any }>(
      `/applications/${id}/cancel-request`,
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),
  approveCancellation: (id: number, params: { expectedVersion: number; comment?: string }) =>
    fetchJson<{ success: boolean; message: string; data?: any }>(
      `/applications/${id}/cancel-approve`,
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),
  rejectCancellation: (id: number, params: { expectedVersion: number; comment: string }) =>
    fetchJson<{ success: boolean; message: string; data?: any }>(
      `/applications/${id}/cancel-reject`,
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),
  returnCancellation: (id: number, params: { expectedVersion: number; comment: string }) =>
    fetchJson<{ success: boolean; message: string; data?: any }>(
      `/applications/${id}/cancel-return`,
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),
  resubmitCancellation: (id: number, params: { expectedVersion: number; cancellationReason: string }) =>
    fetchJson<{ success: boolean; message: string; data?: any }>(
      `/applications/${id}/cancel-resubmit`,
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),

  // 出勤簿 ＆ 服務調整 (Server-Authoritative)
  getMonthlyAttendance: (userId: number, yearMonth: string) =>
    fetchJson<{ success: boolean; data: MonthlyAttendanceData }>(
      `/attendance/monthly?userId=${userId}&yearMonth=${yearMonth}`
    ),
  getCalendarAdjustments: (params?: { fiscalYear?: number; yearMonth?: string; userId?: number }) => {
    const query = new URLSearchParams();
    if (params?.fiscalYear) query.set('fiscalYear', String(params.fiscalYear));
    if (params?.yearMonth) query.set('yearMonth', params.yearMonth);
    if (params?.userId) query.set('userId', String(params.userId));
    return fetchJson<{ success: boolean; adjustments: any[] }>(`/attendance/calendar-adjustments?${query.toString()}`);
  },
  createCalendarAdjustment: (params: {
    scopeType: 'ALL' | 'USER';
    userId?: number;
    adjustmentType: string;
    reasonCode: string;
    authorityBasis?: string;
    sourceDate: string;
    sourceDutyStatus: string;
    targetDate?: string;
    targetDutyStatus?: string;
    eventName: string;
    reason: string;
    relatedAdjustmentId?: number;
    scheduleOverride?: {
      startTime: string;
      endTime: string;
      breakIntervals?: Array<{
        startTime: string;
        endTime: string;
      }>;
    };
  }) =>
    fetchJson<{ success: boolean; message: string; id: number; adjustmentCode: string }>(
      '/attendance/calendar-adjustments',
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    ),
  cancelCalendarAdjustment: (id: number, cancelReason?: string) =>
    fetchJson<{ success: boolean; message: string }>(`/attendance/calendar-adjustments/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ cancelReason }),
    }),
  getCustomHolidays: (year?: number) =>
    fetchJson<{ success: boolean; year: number; customHolidays: any[] }>(
      `/attendance/custom-holidays${year ? `?year=${year}` : ''}`
    ),
  saveCustomHoliday: (params: {
    holidayDate: string;
    name: string;
    holidayType: string;
    source?: string;
    note?: string;
  }) =>
    fetchJson<{ success: boolean; message: string }>('/attendance/custom-holidays', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  toggleCustomHoliday: (id: number) =>
    fetchJson<{ success: boolean; message: string; isActive: number }>(`/attendance/custom-holidays/${id}/toggle`, {
      method: 'POST',
    }),
  confirmMonthlyAttendance: (params: { userId: number; yearMonth: string; comment?: string }) =>
    fetchJson<{ success: boolean; message: string }>('/attendance/confirm', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  unlockMonthlyAttendance: (params: { userId: number; yearMonth: string; reason: string }) =>
    fetchJson<{ success: boolean; message: string }>('/attendance/unlock', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // 年間カレンダー一括インポート (Wave 5: GAP-05)
  previewCalendarImport: (params: { csvContent: string; fileName: string }) =>
    fetchJson<{ success: boolean; data: any; message?: string }>('/attendance/calendar-import/preview', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  commitCalendarImport: (params: {
    previewToken: string;
    fileSha256: string;
    fileName: string;
    fiscalYear: number;
    approvedConflictIds?: Array<{ factType: 'calendar_adjustments' | 'custom_holidays'; id: number }>;
    commitComment?: string;
  }) =>
    fetchJson<{ success: boolean; data: any; message?: string; code?: string }>('/attendance/calendar-import/commit', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // 帳票テンプレート・公文書データ
  getFormTemplates: () => fetchJson<{ success: boolean; templates: OfficialFormTemplate[] }>('/forms/templates'),
  getLeaveFormPdfData: (applicationId: number) =>
    fetchJson<{
      success: boolean;
      data: {
        template: OfficialFormTemplate;
        application: Application;
        steps: any[];
        leaveSummary: UserLeaveSummary;
      };
    }>(`/forms/leave/${applicationId}/pdf-data`),
  getTripFormPdfData: (applicationId: number) =>
    fetchJson<{
      success: boolean;
      data: {
        template: OfficialFormTemplate;
        application: Application;
        steps: any[];
      };
    }>(`/forms/trip/${applicationId}/pdf-data`),
  getAttendanceFormPdfData: (userId: number, yearMonth: string) =>
    fetchJson<{
      success: boolean;
      data: {
        template: OfficialFormTemplate;
        user: User;
        yearMonth: string;
        monthlyApproval: any;
        overrides: any[];
        applications: any[];
      };
    }>(`/forms/attendance/${userId}/${yearMonth}/pdf-data`),

  // 管理者
  getAuditLogs: (limit = 100) =>
    fetchJson<{ success: boolean; logs: AuditLog[] }>(`/admin/audit-logs?limit=${limit}`),
  getAdminUsers: () =>
    fetchJson<{ success: boolean; users: (User & { is_active: number; created_at: string })[] }>('/admin/users'),
  createUser: (params: {
    username: string;
    password: string;
    displayName: string;
    familyName?: string;
    givenName?: string;
    stampName?: string;
    department: string;
    roles: string[];
    initialAnnualLeaveDays?: number;
  }) =>
    fetchJson<{ success: boolean; message: string; data?: { id: number } }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  updateUserStampName: (userId: number, stampName: string, familyName?: string, givenName?: string) =>
    fetchJson<{ success: boolean; message: string; stampName: string }>(`/admin/users/${userId}/stamp-name`, {
      method: 'PUT',
      body: JSON.stringify({ stampName, familyName, givenName }),
    }),
  updateUserName: (
    userId: number,
    params: {
      displayName: string;
      familyName?: string;
      givenName?: string;
      stampName?: string;
      reason?: string;
    }
  ) =>
    fetchJson<{
      success: boolean;
      message: string;
      data: {
        id: number;
        displayName: string;
        familyName: string;
        givenName: string;
        stampName: string;
      };
    }>(`/admin/users/${userId}/name`, {
      method: 'PUT',
      body: JSON.stringify(params),
    }),
  updateUserRoles: (userId: number, roles: string[]) =>
    fetchJson<{ success: boolean; message: string; roles: string[] }>(`/admin/users/${userId}/roles`, {
      method: 'PUT',
      body: JSON.stringify({ roles }),
    }),
  updateUserAccess: (
    userId: number,
    params: {
      roles: string[];
      expectedRoles?: string[];
      positionOperations?: {
        operation: 'ASSIGN' | 'END' | 'CORRECT';
        assignmentId?: number;
        positionId?: string;
        effectiveFrom?: string;
        effectiveTo?: string;
        isPrimary?: boolean;
        endDate?: string;
        reason?: string;
      }[];
      expectedPositionSnapshot?: {
        assignmentId: number;
        positionId: string;
        effectiveFrom: string;
        effectiveTo: string;
        isPrimary: boolean;
      }[];
      reason?: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string; roles: string[]; errorCode?: string }>(
      `/admin/users/${userId}/access`,
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    ),
  getPositions: () =>
    fetchJson<{ success: boolean; positions: import('../types').Position[] }>('/admin/positions'),
  getUserPositions: (userId: number) =>
    fetchJson<{
      success: boolean;
      user: import('../types').User;
      positions: import('../types').UserPosition[];
      currentPositions: import('../types').UserPosition[];
      currentPrimaryPosition: import('../types').UserPosition | null;
    }>(`/admin/users/${userId}/positions`),

  // 職名マスタ管理 (Server-Authoritative SSOT)
  getOfficialJobTitles: (options?: { activeOnly?: boolean; targetDate?: string }) => {
    const params = new URLSearchParams();
    if (options?.activeOnly) params.append('activeOnly', '1');
    if (options?.targetDate) params.append('targetDate', options.targetDate);
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchJson<{ success: boolean; jobTitles: import('../types').OfficialJobTitle[] }>(`/admin/official-job-titles${query}`);
  },
  createOfficialJobTitle: (params: {
    id?: string;
    code: string;
    displayName: string;
    category: string;
    sortOrder?: number;
    description?: string;
    isActive?: number;
  }) =>
    fetchJson<{ success: boolean; message: string; jobTitle: import('../types').OfficialJobTitle }>(
      '/admin/official-job-titles',
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    ),
  updateOfficialJobTitle: (
    id: string,
    params: {
      code?: string;
      displayName?: string;
      category?: string;
      sortOrder?: number;
      description?: string;
      isActive?: number;
    }
  ) =>
    fetchJson<{ success: boolean; message: string; jobTitle: import('../types').OfficialJobTitle }>(
      `/admin/official-job-titles/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(params),
      }
    ),
  deleteOfficialJobTitle: (id: string) =>
    fetchJson<{ success: boolean; message: string }>(`/admin/official-job-titles/${id}`, {
      method: 'DELETE',
    }),

  // 教職員職名発令履歴管理
  getUserJobTitles: (userId: number) =>
    fetchJson<{
      success: boolean;
      user: { id: number; username: string; displayName: string };
      history: import('../types').UserJobTitleAssignment[];
      current: import('../types').UserJobTitleAssignment | null;
    }>(`/admin/users/${userId}/job-titles`),
  assignUserJobTitle: (
    userId: number,
    params: {
      jobTitleId: string;
      effectiveFrom: string;
      effectiveTo?: string;
      notes?: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string; assignmentId: number }>(
      `/admin/users/${userId}/job-titles`,
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    ),
  updateUserJobTitle: (
    userId: number,
    assignmentId: number,
    params: {
      jobTitleId: string;
      effectiveFrom: string;
      effectiveTo?: string;
      notes?: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string }>(
      `/admin/users/${userId}/job-titles/${assignmentId}`,
      {
        method: 'PUT',
        body: JSON.stringify(params),
      }
    ),
  deleteUserJobTitle: (userId: number, assignmentId: number) =>
    fetchJson<{ success: boolean; message: string }>(
      `/admin/users/${userId}/job-titles/${assignmentId}`,
      {
        method: 'DELETE',
      }
    ),

  // ワークフローポリシー管理
  getWorkflowPolicies: () =>
    fetchJson<{ success: boolean; policies: import('../types').WorkflowPolicy[] }>('/admin/workflow-policies'),
  getWorkflowPolicyDetail: (policyId: string) =>
    fetchJson<{ success: boolean; policy: import('../types').WorkflowPolicy }>(`/admin/workflow-policies/${policyId}`),
  createWorkflowPolicy: (params: {
    policyKey: string;
    policyName: string;
    description?: string;
    appTypeIds: string[];
  }) =>
    fetchJson<{ success: boolean; message: string; data?: { id: string } }>('/admin/workflow-policies', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  createWorkflowPolicyDraftVersion: (policyId: string, baseVersionId?: string) =>
    fetchJson<{ success: boolean; message: string; data: { versionId: string; version: number } }>(
      `/admin/workflow-policies/${policyId}/versions`,
      {
        method: 'POST',
        body: JSON.stringify({ baseVersionId }),
      }
    ),
  updateWorkflowPolicyDraftVersion: (
    policyId: string,
    versionId: string,
    params: {
      priority: number;
      effectiveFrom: string;
      effectiveTo: string;
      conditionsJson?: string;
      steps: {
        stepName: string;
        stepKey?: string;
        actionType?: string;
        requiredRoleId?: string;
        selectorType: 'POSITION';
        selectorValue: string;
        isFinalDecisionStep: boolean;
      }[];
    }
  ) =>
    fetchJson<{ success: boolean; message: string; data?: { versionId: string; version: number } }>(
      `/admin/workflow-policies/${policyId}/versions/${versionId}`,
      {
        method: 'PUT',
        body: JSON.stringify(params),
      }
    ),
  deleteWorkflowPolicyDraftVersion: (policyId: string, versionId: string) =>
    fetchJson<{ success: boolean; message: string }>(
      `/admin/workflow-policies/${policyId}/versions/${versionId}`,
      {
        method: 'DELETE',
      }
    ),
  getWorkflowPolicyDraftReadiness: (policyId: string, versionId: string) =>
    fetchJson<{ success: boolean; data: import('../types').PolicyDraftReadinessResult }>(
      `/admin/workflow-policies/${policyId}/versions/${versionId}/readiness`
    ),
  activateWorkflowPolicyVersion: (versionId: string, expectedCurrentActiveVersionId?: string | null) =>
    fetchJson<{ success: boolean; message: string; errorCode?: string; data?: any }>(
      `/admin/workflow-policies/versions/${versionId}/activate`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedCurrentActiveVersionId }),
      }
    ),
  assignUserPosition: (
    userId: number,
    params: {
      positionId: string;
      effectiveFrom: string;
      effectiveTo?: string;
      isPrimary?: boolean;
      note?: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string; assignmentId: number; errorCode?: string }>(
      `/admin/users/${userId}/positions`,
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    ),
  endUserPosition: (
    userId: number,
    assignmentId: number,
    params: {
      endDate: string;
      reason?: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string; assignmentId: number; effectiveTo?: string; errorCode?: string }>(
      `/admin/users/${userId}/positions/${assignmentId}/end`,
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    ),
  updateUserPosition: (
    userId: number,
    assignmentId: number,
    params: {
      effectiveFrom: string;
      effectiveTo: string;
      isPrimary?: boolean;
    }
  ) =>
    fetchJson<{ success: boolean; message: string; assignmentId: number; errorCode?: string }>(
      `/admin/users/${userId}/positions/${assignmentId}`,
      {
        method: 'PUT',
        body: JSON.stringify(params),
      }
    ),
  correctUserPosition: (
    userId: number,
    assignmentId: number,
    params: {
      effectiveFrom: string;
      effectiveTo: string;
      isPrimary?: boolean;
      correctionReason: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string; assignmentId: number; errorCode?: string }>(
      `/admin/users/${userId}/positions/${assignmentId}/correct`,
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    ),
  // 学校標準日課 (Wave 3A-2)
  getSchoolWorkSchedules: () =>
    fetchJson<{ success: boolean; schedules: SchoolWorkSchedule[] }>('/admin/school-work-schedules'),
  createSchoolWorkSchedule: (params: {
    scheduleName: string;
    effectiveFrom: string;
    weeklyOffDays?: string | number[];
    scheduleDetails: CanonicalScheduleDetails | Record<string, any>;
  }) =>
    fetchJson<{
      success: boolean;
      message: string;
      scheduleId?: number;
      previousScheduleId?: number;
    }>('/admin/school-work-schedules', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  getUserWorkPatterns: (userId: number) =>
    fetchJson<{ success: boolean; patterns: UserWorkPattern[] }>(`/admin/users/${userId}/work-patterns`),
  createWorkPattern: (
    userId: number,
    params: {
      patternName: string;
      patternType: 'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM';
      scheduleSource: CanonicalScheduleSource; // 必須化 (Fail-Closed)
      effectiveFrom: string;
      effectiveTo: string;
      weeklyOffDays: string | number[];
      memo?: string;
      weeklyTotalMinutes?: number;
      scheduleDetails?: CanonicalScheduleDetails | any;
      statutoryPatternCode?: 'CST_01' | 'CST_02' | 'CST_03' | 'CST_04' | null;
    }
  ) =>
    fetchJson<{
      success: boolean;
      message: string;
      patternId?: number;
      errorCode?: string;
      overlappingPattern?: { id: number; patternName: string; effectiveFrom: string; effectiveTo: string };
    }>(`/admin/users/${userId}/work-patterns`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  updateWorkPattern: (
    userId: number,
    patternId: number,
    params: {
      patternName: string;
      patternType: 'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM';
      scheduleSource?: CanonicalScheduleSource; // Server PUT: 省略時は既存値維持
      effectiveFrom: string;
      effectiveTo: string;
      weeklyOffDays: string | number[];
      memo?: string;
      weeklyTotalMinutes?: number;
      scheduleDetails?: CanonicalScheduleDetails | any;
      statutoryPatternCode?: 'CST_01' | 'CST_02' | 'CST_03' | 'CST_04' | null;
    }
  ) =>
    fetchJson<{
      success: boolean;
      message: string;
      errorCode?: string;
      overlappingPattern?: { id: number; patternName: string; effectiveFrom: string; effectiveTo: string };
    }>(`/admin/users/${userId}/work-patterns/${patternId}`, {
      method: 'PUT',
      body: JSON.stringify(params),
    }),
  deleteWorkPattern: (userId: number, patternId: number) =>
    fetchJson<{ success: boolean; message: string; errorCode?: string }>(`/admin/users/${userId}/work-patterns/${patternId}`, {
      method: 'DELETE',
    }),
  resolveWorkPatternOverlap: (
    userId: number,
    params: {
      targetPatternId: number;
      expectedCurrentEffectiveTo: string;
      newPattern: {
        patternName: string;
        patternType: 'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM';
        scheduleSource: 'SCHOOL_DEFAULT' | 'INDIVIDUAL';
        effectiveFrom: string;
        effectiveTo: string;
        weeklyOffDays: number[] | string;
        memo?: string;
        weeklyTotalMinutes?: number;
        scheduleDetails?: Record<string, any>;
        statutoryPatternCode?: string | null;
      };
    }
  ) =>
    fetchJson<{
      success: boolean;
      message: string;
      shortenedPattern: { id: number; effectiveFrom: string; effectiveTo: string };
      createdPattern: { id: number; effectiveFrom: string; effectiveTo: string };
    }>(`/admin/users/${userId}/work-patterns/resolve-overlap`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  triggerBackup: () =>
    fetchJson<{ success: boolean; message: string; backupPath: string }>('/admin/backup', { method: 'POST' }),
  getSystemStatus: () =>
    fetchJson<{
      success: boolean;
      status: {
        dbPath: string;
        backupDir: string;
        integrity: string;
        lanIps: string[];
        port: number;
        pocMode: boolean;
        nodeVersion: string;
        platform: string;
        uptimeSeconds: number;
      };
    }>('/admin/system-status'),

  // システム設定 (Public & Admin)
  getPublicSettings: () =>
    fetchJson<{ success: boolean; data: PublicSettings }>('/system/public-settings'),
  getAdminSettings: () =>
    fetchJson<{ success: boolean; settings: SystemSettings }>('/admin/settings'),
  updateAdminSettings: (params: {
    schoolName: string;
    municipalityName: string;
    boardOfEducationName: string;
    appTitle: string;
    leaveRegulationName?: string;
    travelRegulationName?: string;
    attendanceRegulationName?: string;
    expectedVersion: number;
  }) =>
    fetchJson<{ success: boolean; message: string; settings: SystemSettings }>('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(params),
    }),

  // 欠勤管理 (Absences)
  getAbsences: (params?: { userId?: number; yearMonth?: string }) => {
    const q = new URLSearchParams();
    if (params?.userId) q.set('userId', String(params.userId));
    if (params?.yearMonth) q.set('yearMonth', params.yearMonth);
    const queryStr = q.toString() ? `?${q.toString()}` : '';
    return fetchJson<{ success: boolean; data: any[] }>(`/absences${queryStr}`);
  },
  createAbsence: (params: {
    userId: number;
    absenceType: 'FULL_DAY' | 'HOURLY';
    targetDate: string;
    startTime?: string;
    endTime?: string;
    reason: string;
    status?: 'DRAFT' | 'CONFIRMED';
  }) =>
    fetchJson<{ success: boolean; message: string; id: number }>('/absences', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  updateAbsence: (
    id: number,
    params: {
      absenceType?: 'FULL_DAY' | 'HOURLY';
      startTime?: string;
      endTime?: string;
      reason?: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string }>(`/absences/${id}`, {
      method: 'PUT',
      body: JSON.stringify(params),
    }),
  cancelAbsence: (id: number, cancelReason: string) =>
    fetchJson<{ success: boolean; message: string }>(`/absences/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ cancelReason }),
    }),
  correctAbsenceToLeave: (
    id: number,
    params: {
      correctionTargetType: 'LEAVE_ANNUAL' | 'LEAVE_SICK' | 'LEAVE_SPECIAL' | 'LEAVE_DUTY_EXEMPT' | 'OTHER';
      correctedApplicationId?: number;
      correctionReason: string;
    }
  ) =>
    fetchJson<{ success: boolean; message: string }>(`/absences/${id}/correct-to-leave`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // 介護ケース・指定期間 (条例第15条)
  getCareCases: (userId?: number) => {
    const q = userId ? `?userId=${userId}` : '';
    return fetchJson<{ success: boolean; cases: any[] }>(`/care-cases${q}`);
  },
  createCareCase: (params: {
    targetUserId?: number;
    recipientRelation: string;
    recipientName: string;
    conditionSummary: string;
    careStartDate?: string;
    initialPeriod?: { startDate: string; endDate: string };
  }) =>
    fetchJson<{ success: boolean; message: string; caseId: number; periodId?: number }>('/care-cases', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  addCarePeriod: (caseId: number, params: { startDate: string; endDate: string; memo?: string }) =>
    fetchJson<{ success: boolean; message: string; periodId: number; periodNumber: number }>(`/care-cases/${caseId}/periods`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // 年次有給休暇 暦年繰越 ＆ 定期付与 (条例第12条)
  getAnnualLeaveRolloverPreview: (year: number) =>
    fetchJson<{ success: boolean; targetYear: number; previews: any[] }>(`/admin/annual-leave/rollover-preview?year=${year}`),
  processAnnualLeaveRollover: (year: number) =>
    fetchJson<{ success: boolean; message: string; targetYear: number; processedCount: number; messages: string[] }>(
      '/admin/annual-leave/rollover',
      {
        method: 'POST',
        body: JSON.stringify({ targetYear: year }),
      }
    ),

  // 人事発令 (GAP-07)
  getPersonnelStatuses: () =>
    fetchJson<{ success: boolean; data: any[] }>('/personnel-statuses'),
  createPersonnelStatus: (params: {
    userId: number;
    statusType: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    documentReferenceNo?: string;
    issuedAt?: string;
    authorityBasis?: string;
    reasonCode: string;
  }) =>
    fetchJson<{ success: boolean; id: number; message: string }>('/personnel-statuses', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  amendPersonnelStatus: (
    id: number,
    params: {
      newEffectiveFrom: string;
      newEffectiveTo?: string | null;
      newDocumentReferenceNo?: string;
      newIssuedAt?: string;
      newAuthorityBasis?: string;
      amendmentReason: string;
    }
  ) =>
    fetchJson<{ success: boolean; newId: number; message: string }>(`/personnel-statuses/${id}/amend`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  cancelPersonnelStatus: (id: number, cancellationReason: string) =>
    fetchJson<{ success: boolean; message: string }>(`/personnel-statuses/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ cancellationReason }),
    }),
  returnPersonnelStatusToDuty: (id: number, returnDate: string, comment?: string) =>
    fetchJson<{ success: boolean; message: string }>(`/personnel-statuses/${id}/return-to-duty`, {
      method: 'POST',
      body: JSON.stringify({ returnDate, comment }),
    }),
  extendPersonnelStatusPeriod: (id: number, newEffectiveTo: string, comment?: string) =>
    fetchJson<{ success: boolean; message: string }>(`/personnel-statuses/${id}/extend`, {
      method: 'POST',
      body: JSON.stringify({ newEffectiveTo, comment }),
    }),
};

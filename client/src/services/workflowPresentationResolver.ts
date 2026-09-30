import { Application } from '../types';

export interface ApplicationDisplayState {
  primaryStatus: string;
  primaryLabel: string;
  primaryColor: string;
  hasSecondaryStatus: boolean;
  secondaryLabel?: string;
  secondaryColor?: string;
  isReturnedActionableForUser: boolean;
  showCancellationReturnBanner: boolean;
}

export function resolveApplicationDisplayState(app: Application, currentUserId: number): ApplicationDisplayState {
  // Check Cancellation Return first
  if (app.cancellationReturn && app.cancellationReturn.status === 'RETURNED') {
    const isActionActor =
      typeof app.cancellationReturn.actionActorUserId === 'number' &&
      app.cancellationReturn.actionActorUserId === currentUserId;

    return {
      primaryStatus: 'FINAL_APPROVED',
      primaryLabel: '決裁完了',
      primaryColor: 'emerald',
      hasSecondaryStatus: true,
      secondaryLabel: '取消申請：差戻し (要修正)',
      secondaryColor: 'rose',
      isReturnedActionableForUser: isActionActor,
      showCancellationReturnBanner: true,
    };
  }

  // Check Cancellation In Progress
  if (app.activeCancellationCycle && app.activeCancellationCycle.status === 'IN_PROGRESS') {
    return {
      primaryStatus: 'FINAL_APPROVED',
      primaryLabel: '決裁完了',
      primaryColor: 'emerald',
      hasSecondaryStatus: true,
      secondaryLabel: '取消審査中',
      secondaryColor: 'amber',
      isReturnedActionableForUser: false,
      showCancellationReturnBanner: false,
    };
  }

  // Check Normal Returned
  if (app.current_status === 'RETURNED') {
    const isSubjectOrProxy =
      (typeof app.submitted_by_user_id === 'number' && app.submitted_by_user_id === currentUserId) ||
      (typeof app.subject_user_id === 'number' && app.subject_user_id === currentUserId) ||
      (typeof app.applicant_id === 'number' && app.applicant_id === currentUserId);

    return {
      primaryStatus: 'RETURNED',
      primaryLabel: '差戻し',
      primaryColor: 'rose',
      hasSecondaryStatus: false,
      isReturnedActionableForUser: isSubjectOrProxy,
      showCancellationReturnBanner: false,
    };
  }

  // Fallback / standard statuses
  const statusLabels: Record<string, { label: string; color: string }> = {
    DRAFT: { label: '下書き', color: 'slate' },
    SUBMITTED: { label: '提出済', color: 'blue' },
    IN_PROGRESS: { label: '審査中', color: 'amber' },
    FINAL_APPROVED: { label: '決裁完了', color: 'emerald' },
    REJECTED: { label: '却下', color: 'rose' },
    CANCELLED: { label: '取消済', color: 'slate' },
    WITHDRAWN: { label: '取下げ', color: 'slate' },
  };

  const info = statusLabels[app.current_status] || { label: app.current_status, color: 'slate' };

  return {
    primaryStatus: app.current_status,
    primaryLabel: info.label,
    primaryColor: info.color,
    hasSecondaryStatus: false,
    isReturnedActionableForUser: false,
    showCancellationReturnBanner: false,
  };
}

import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Application, User } from '../types';
import { ApprovalTimeline } from '../components/ApprovalTimeline';
import { LeaveSummaryWidget } from '../components/LeaveSummaryWidget';
import { OfficialFormModal } from '../components/OfficialFormModal';
import { NewApplicationModal } from './NewApplicationModal';
import { ApplicationFormSchema, ClassCoverageStatus, ClassCoverageItem } from '../types/formSchema';
import { SchemaDetailRenderer } from '../components/detail/SchemaDetailRenderer';
import { determineHistoricalSchemaResolutionDate } from '../utils/schemaResolutionDateResolver';
import { resolveApplicationDisplayState } from '../services/workflowPresentationResolver';
import { resolveActionability, isProxySubmission } from '../utils/applicationActionabilityResolver';
import { ApplicationDetailHeader } from '../components/detail/ApplicationDetailHeader';
import { WorkflowAlertBanners } from '../components/detail/WorkflowAlertBanners';
import { ApplicationActionBar } from '../components/detail/ApplicationActionBar';
import { ReturnOrRejectModal } from '../components/detail/modals/ReturnOrRejectModal';
import { CancellationRequestModal } from '../components/detail/modals/CancellationRequestModal';
import { CancellationActionModal } from '../components/detail/modals/CancellationActionModal';
import { CancellationResubmitModal } from '../components/detail/modals/CancellationResubmitModal';
import { BusinessTripReportModal, BusinessTripReportPayload } from '../components/detail/modals/BusinessTripReportModal';
import { ClassCoverageModal } from '../components/detail/modals/ClassCoverageModal';
import {
  ArrowLeft,
  CheckCircle,
  RotateCcw,
  XCircle,
} from 'lucide-react';

interface Props {
  applicationId: number;
  currentUser: User;
  onBack: () => void;
  onRefresh: () => void;
}

export const ApplicationDetailPage: React.FC<Props> = ({
  applicationId,
  currentUser,
  onBack,
  onRefresh,
}) => {
  const [app, setApp] = useState<Application | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [members, setMembers] = useState<User[]>([]);

  // 帳票PDF印刷モーダル
  const [isPdfModalOpen, setIsPdfModalOpen] = useState(false);

  // 差戻し/却下モーダル
  const [modalType, setModalType] = useState<'return' | 'reject' | null>(null);

  // GAP-09: 授業措置確定・変更モーダル
  const [isCoverageModalOpen, setIsCoverageModalOpen] = useState(false);

  // 復命書提出モーダル (出張用)
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);

  // 差戻し後の再申請モーダル
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);

  // 承認後取消起案モーダル (GAP-01)
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);

  // 取消承認/差戻し/却下モーダル (GAP-01)
  const [cancelActionModalType, setCancelActionModalType] = useState<"approve" | "return" | "reject" | null>(null);

  // 承認後取消差戻し後の再提出モーダル (Phase 2)
  const [isCancelResubmitModalOpen, setIsCancelResubmitModalOpen] = useState(false);

  // Schema-Driven Detail View 状態
  const [schema, setSchema] = useState<ApplicationFormSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState<boolean>(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // 承認確認モーダル
  const [isApproveModalOpen, setIsApproveModalOpen] = useState(false);
  const [approveComment, setApproveComment] = useState('');

  // 取下げ確認モーダル
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);

  const fetchDetail = () => {
    setLoading(true);
    setError('');
    api.getApplicationDetail(applicationId)
      .then(async (res) => {
        const fetchedApp = res.application;
        setApp(fetchedApp);

        // Historical Schema Resolution (Step 1A: determineHistoricalSchemaResolutionDate)
        if (fetchedApp?.type_id) {
          setSchemaLoading(true);
          setSchemaError(null);
          try {
            const resolutionDate = determineHistoricalSchemaResolutionDate(
              fetchedApp.form_data,
              fetchedApp.created_at
            );
            const schemaRes = await api.getFormSchema(
              fetchedApp.type_id,
              resolutionDate || undefined
            );
            setSchema(schemaRes.schema || null);
          } catch (sErr: any) {
            // Read-Preservation Contract: Schema取得失敗時は null を渡し ResidualFactView でフォールバック表示
            console.warn('[ApplicationDetailPage] Schema fetch error:', sErr);
            setSchema(null);
            setSchemaError(sErr.message || 'スキーマ取得エラー');
          } finally {
            setSchemaLoading(false);
          }
        }
      })
      .catch((err) => setError(err.message || '詳細取得に失敗しました'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchDetail();
    api.getMembers()
      .then((res) => setMembers(res.members || []))
      .catch(() => {});
  }, [applicationId]);

  if (loading) {
    return (
      <div className="p-8 text-center text-slate-500 text-sm font-medium">
        申請詳細を読み込み中...
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="bg-rose-50 border border-rose-200 text-rose-700 p-4 rounded-xl text-sm mb-4">
          {error || '申請が見つかりませんでした'}
        </div>
        <button
          onClick={onBack}
          className="text-xs text-blue-600 hover:underline flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" /> 一覧に戻る
        </button>
      </div>
    );
  }

  const actionability = resolveActionability(app, currentUser);
  const {
    canApprove,
    canApproveCancellation,
    canAdvanceCancellationReview,
    canAcceptCancellation,
    canDeclineCancellation,
    canReturnCancellation,
    canReturn,
    canReject,
    canWithdraw,
    canRequestCancellation,
    canResubmitCancellation,
    canResolveCoverage,
    canSubmitReport,
  } = actionability;
  const displayState = resolveApplicationDisplayState(app, currentUser.id);

  const currentStep = app.steps?.find(
    (s) => s.step_order === app.current_step_order && s.status === 'PENDING'
  );

  const isBusinessTrip = app.type_id === 'BUSINESS_TRIP';
  const hasActiveCancellation = !!app.activeCancellationCycle;

  // 取消承認ステップの判定
  const activeCancelCycleNum = app.activeCancellationCycle?.approval_cycle;
  const currentCancelStep = app.steps?.find(
    (s) => s.approval_cycle === activeCancelCycleNum && s.status === 'PENDING'
  );

  // 承認実行ハンドラ
  const executeApprove = async () => {
    setActionLoading(true);
    try {
      await api.approveApplication(app.id, {
        expectedVersion: app.version,
        comment: approveComment.trim() || `${currentUser.displayName} による確認・承認`,
      });
      setIsApproveModalOpen(false);
      setApproveComment('');
      fetchDetail();
      onRefresh();
    } catch (err: any) {
      alert(`承認エラー: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // 取下げ実行ハンドラ
  const executeWithdraw = async () => {
    setActionLoading(true);
    try {
      await api.withdrawApplication(app.id, {
        expectedVersion: app.version,
      });
      setIsWithdrawModalOpen(false);
      fetchDetail();
      onRefresh();
    } catch (err: any) {
      alert(`取下げエラー: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReturnOrRejectSubmit = async (comment: string) => {
    setActionLoading(true);
    try {
      if (modalType === 'return') {
        await api.returnApplication(app.id, {
          expectedVersion: app.version,
          comment,
        });
      } else if (modalType === 'reject') {
        await api.rejectApplication(app.id, {
          expectedVersion: app.version,
          comment,
        });
      }
      setModalType(null);
      fetchDetail();
      onRefresh();
    } catch (err: any) {
      alert(`処理エラー: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleResolveCoverageSubmit = async (payload: {
    coverageStatus: ClassCoverageStatus;
    notRequiredReason?: string;
    coverageItems: ClassCoverageItem[];
  }) => {
    setActionLoading(true);
    try {
      await api.resolveClassCoverage(app.id, {
        expectedVersion: app.version,
        coverageStatus: payload.coverageStatus,
        notRequiredReason: payload.coverageStatus === 'NOT_REQUIRED' ? payload.notRequiredReason : undefined,
        coverageItems: payload.coverageStatus === 'REQUIRED' ? payload.coverageItems : []
      });
      setIsCoverageModalOpen(false);
      fetchDetail();
      onRefresh();
    } catch (err: any) {
      alert(`授業措置更新エラー: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReportSubmit = async (payload: BusinessTripReportPayload) => {
    setActionLoading(true);
    try {
      const submitPayload: any = {
        expectedVersion: app.version,
        ...payload,
      };
      if (submitPayload.vehicleUsageType === '') {
        delete submitPayload.vehicleUsageType;
      }
      await api.submitReport(app.id, submitPayload);
      setIsReportModalOpen(false);
      fetchDetail();
      onRefresh();
    } catch (err: any) {
      alert(`復命書提出エラー: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRequestCancellation = async (cancellationReason: string) => {
    setActionLoading(true);
    try {
      await api.requestCancellation(app.id, {
        expectedVersion: app.version,
        cancellationReason,
      });
      setIsCancelModalOpen(false);
      fetchDetail();
      onRefresh();
    } catch (err: any) {
      alert(`取消起案エラー: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelActionSubmit = async (comment: string) => {
    setActionLoading(true);
    try {
      if (cancelActionModalType === "approve") {
        await api.approveCancellation(app.id, {
          expectedVersion: app.version,
          comment: comment || `${currentUser.displayName} による取消承認`,
        });
      } else if (cancelActionModalType === "reject") {
        await api.rejectCancellation(app.id, {
          expectedVersion: app.version,
          comment,
        });
      } else if (cancelActionModalType === "return") {
        await api.returnCancellation(app.id, {
          expectedVersion: app.version,
          comment,
        });
      }
      setCancelActionModalType(null);
      fetchDetail();
      onRefresh();
    } catch (err: any) {
      alert(`取消処理エラー: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelResubmitSubmit = async (newCancellationReason: string) => {
    setActionLoading(true);
    try {
      await api.resubmitCancellation(app.id, {
        expectedVersion: app.version,
        cancellationReason: newCancellationReason,
      });
      setIsCancelResubmitModalOpen(false);
      fetchDetail();
      onRefresh();
    } catch (err: any) {
      alert(`取消再申請エラー: ${err.message}`);
      if (err.statusCode === 409 || err.message?.includes('更新')) {
        fetchDetail();
      }
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* 1. 外殻アクションバー (Shell Component: ApplicationActionBar) */}
      <ApplicationActionBar
        onBack={onBack}
        onOpenPdfModal={() => setIsPdfModalOpen(true)}
        canSubmitReport={actionability.canSubmitReport}
        canEditDraft={actionability.canEditDraft}
        canRequestCancellation={actionability.canRequestCancellation}
        canResubmit={actionability.canResubmit}
        canWithdraw={actionability.canWithdraw}
        actionLoading={actionLoading}
        onOpenReportModal={() => setIsReportModalOpen(true)}
        onOpenDraftModal={() => setIsEditModalOpen(true)}
        onOpenCancelModal={() => setIsCancelModalOpen(true)}
        onOpenResubmitModal={() => setIsEditModalOpen(true)}
        onWithdraw={() => setIsWithdrawModalOpen(true)}
      />

      {/* 2. ワークフロー通知バナー (Shell Component: WorkflowAlertBanners) */}
      <WorkflowAlertBanners
        currentStatus={app.current_status}
        hasActiveCancellation={hasActiveCancellation}
        cancellationReason={app.activeCancellationCycle?.cancellation_reason}
        cancellationReturn={app.cancellationReturn}
        canEditDraft={actionability.canEditDraft}
        canResubmit={actionability.canResubmit}
        canResubmitCancellation={displayState.isReturnedActionableForUser}
        onOpenDraftModal={() => setIsEditModalOpen(true)}
        onOpenResubmitModal={() => setIsEditModalOpen(true)}
        onOpenCancelResubmitModal={() => {
          setIsCancelResubmitModalOpen(true);
        }}
        isBusinessTrip={isBusinessTrip}
        reportStatus={app.report_status}
        canSubmitReport={actionability.canSubmitReport}
        onOpenReportModal={() => setIsReportModalOpen(true)}
      />

      {/* 3. 申請ヘッダー情報カード (Shell Component: ApplicationDetailHeader) */}
      <ApplicationDetailHeader
        id={app.id}
        version={app.version}
        title={app.title}
        typeName={app.type_name || '服務申請'}
        currentStatus={app.current_status}
        createdAt={app.created_at}
        subjectUserName={app.subject_user_name || app.applicant_name}
        subjectDepartment={app.subject_department || app.applicant_department}
        submissionActorType={app.submission_actor_type}
        proxyUserName={app.proxy_user_name}
        currentStepName={currentStep?.step_name}
        secondaryStatusBadge={
          displayState.hasSecondaryStatus && displayState.secondaryLabel
            ? {
                label: displayState.secondaryLabel,
                variant: displayState.secondaryColor === 'rose' ? 'rose' : 'amber',
              }
            : null
        }
      />

      {/* 申請明細・進捗カード */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">

        {/* 4. スキーマ駆動 申請詳細レンダラー (Step 2/3/6: SchemaDetailRenderer) */}
        <SchemaDetailRenderer
          schema={schema}
          formData={app.form_data}
          isSchemaLoading={schemaLoading}
          schemaError={schemaError}
          canResolveCoverage={canApprove}
          onOpenCoverageModal={() => setIsCoverageModalOpen(true)}
        />

        {/* 休暇残数サマリー */}
        {app.leaveSummarySnapshot && !isBusinessTrip && (
          <div className="mt-2">
            <LeaveSummaryWidget summary={app.leaveSummarySnapshot} compact={true} />
          </div>
        )}

        {/* 承認進捗タイムライン (認印付き) */}
        <ApprovalTimeline
          steps={app.steps || []}
          proxySubmitterName={isProxySubmission(app) ? app.proxy_user_name : undefined}
          currentStatus={app.current_status}
        />

        {/* 取消承認アクションバー (GAP-01 / Semantic Alignment) */}
        {(canApproveCancellation || canReturnCancellation) && currentCancelStep && (
          <div className="p-4 bg-rose-50 border-2 border-rose-300 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-rose-950 flex items-center gap-1.5">
                  <RotateCcw className="w-4 h-4 text-rose-600" />
                  <span>
                    {currentCancelStep.action_type === 'REVIEW'
                      ? `取消審査操作: 第${currentCancelStep.step_order}段階「${currentCancelStep.step_name}」`
                      : `取消決裁操作: 第${currentCancelStep.step_order}段階「${currentCancelStep.step_name}」`}
                  </span>
                </h4>
                <p className="text-xs text-rose-800 mt-0.5">
                  {currentCancelStep.action_type === 'REVIEW'
                    ? 'この申請の「承認後取消」に対する確認・進達および差戻しが可能です。'
                    : 'この申請の「承認後取消」に対する同意・不同意および差戻しが可能です。'}
                </p>
              </div>
            </div>

            <div className="flex gap-2 justify-end pt-2 border-t border-rose-200">
              {canReturnCancellation && (
                <button
                  onClick={() => setCancelActionModalType("return")}
                  disabled={actionLoading}
                  className="px-3.5 py-1.5 border border-rose-300 text-rose-700 bg-white hover:bg-rose-100 rounded-lg text-xs font-semibold flex items-center gap-1 transition"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> 取消差戻し
                </button>
              )}
              {canDeclineCancellation && (
                <button
                  onClick={() => setCancelActionModalType("reject")}
                  disabled={actionLoading}
                  className="px-3.5 py-1.5 border border-red-300 text-red-700 bg-white hover:bg-red-50 rounded-lg text-xs font-semibold flex items-center gap-1 transition"
                >
                  <XCircle className="w-3.5 h-3.5" /> 取消に同意しない
                </button>
              )}
              {canApproveCancellation && (
                <button
                  onClick={() => setCancelActionModalType("approve")}
                  disabled={actionLoading}
                  className="px-5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
                >
                  <CheckCircle className="w-4 h-4" />
                  {canAdvanceCancellationReview ? '確認して校長へ進達' : '取消に同意する'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* 決裁・審査アクションバー (承認権限がある場合) */}
        {canApprove && currentStep && (
          <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5">
                  <CheckCircle className="w-4 h-4 text-indigo-600" />
                  <span>
                    {currentStep.action_type === 'ACK'
                      ? `受領確認操作: 第${currentStep.step_order}段階「${currentStep.step_name}」`
                      : currentStep.action_type === 'REVIEW'
                      ? `審査・確認操作: 第${currentStep.step_order}段階「${currentStep.step_name}」`
                      : `承認決裁操作: 第${currentStep.step_order}段階「${currentStep.step_name}」`}
                  </span>
                </h4>
                <p className="text-xs text-indigo-700 mt-0.5">
                  {currentStep.action_type === 'ACK'
                    ? 'あなたのアカウントでこの届出の受領確認を行うことができます。'
                    : currentStep.action_type === 'REVIEW'
                    ? 'あなたのアカウントで内容の審査・進達または差戻しが可能です。'
                    : 'あなたのアカウントでこのステップの承認または差戻し・却下が可能です。'}
                </p>
              </div>
            </div>

            <div className="flex gap-2 justify-end pt-2 border-t border-indigo-200/60">
              {canReturn && (
                <button
                  onClick={() => setModalType('return')}
                  disabled={actionLoading}
                  className="px-3.5 py-1.5 border border-rose-300 text-rose-700 bg-white hover:bg-rose-50 rounded-lg text-xs font-semibold flex items-center gap-1 transition"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> 差戻し
                </button>
              )}
              {canReject && (
                <button
                  onClick={() => setModalType('reject')}
                  disabled={actionLoading}
                  className="px-3.5 py-1.5 border border-red-300 text-red-700 bg-white hover:bg-red-50 rounded-lg text-xs font-semibold flex items-center gap-1 transition"
                >
                  <XCircle className="w-3.5 h-3.5" /> 却下
                </button>
              )}
              <button
                onClick={() => setIsApproveModalOpen(true)}
                disabled={actionLoading}
                className="px-5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
              >
                <CheckCircle className="w-4 h-4" />
                {currentStep.action_type === 'ACK'
                  ? '受領確認する'
                  : currentStep.action_type === 'REVIEW'
                  ? '確認して進達'
                  : '承認する'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 承認確認モーダル */}
      {isApproveModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-emerald-600" />
              <span>
                {currentStep?.action_type === 'ACK'
                  ? '届出の受領確認'
                  : currentStep?.action_type === 'REVIEW'
                  ? '申請の審査・進達確認'
                  : '申請の承認・決裁確認'}
              </span>
            </h3>

            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg space-y-1.5 text-xs text-emerald-950">
              <div className="font-semibold text-slate-800">
                <span className="text-slate-500 font-normal">申請件名: </span>{app.title}
              </div>
              <div>
                <span className="text-slate-500">申請者: </span>
                <span className="font-semibold">{app.subject_user_name || app.applicant_name}</span> ({app.subject_department || app.applicant_department})
              </div>
              <div>
                <span className="text-slate-500">適用承認段階: </span>
                <span className="font-bold text-indigo-700">{currentStep?.step_name || '承認ステップ'}</span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {currentStep?.action_type === 'ACK' ? '確認コメント (任意)' : '承認コメント (任意)'}
              </label>
              <input
                type="text"
                value={approveComment}
                onChange={(e) => setApproveComment(e.target.value)}
                placeholder={currentStep?.action_type === 'ACK' ? '例: 受領しました' : '例: 確認しました / 承認します'}
                className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-emerald-500 focus:ring-emerald-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setIsApproveModalOpen(false);
                  setApproveComment('');
                }}
                disabled={actionLoading}
                className="px-3.5 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={executeApprove}
                disabled={actionLoading}
                className="px-5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
              >
                <CheckCircle className="w-4 h-4" />
                <span>
                  {actionLoading
                    ? '処理中...'
                    : currentStep?.action_type === 'ACK'
                    ? '受領確認を確定する'
                    : currentStep?.action_type === 'REVIEW'
                    ? '審査を完了して進達'
                    : '承認を確定する'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 取下げ確認モーダル */}
      {isWithdrawModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <RotateCcw className="w-5 h-5 text-slate-600" />
              <span>申請の取下げ確認</span>
            </h3>

            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1">
              <p className="font-bold">⚠️ この操作は取り消せません</p>
              <p>この申請（{app.title}）を取下げます。取下げられた申請は無効となり、決裁フローは完全に終了します。</p>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsWithdrawModalOpen(false)}
                disabled={actionLoading}
                className="px-3.5 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={executeWithdraw}
                disabled={actionLoading}
                className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold shadow-sm transition"
              >
                {actionLoading ? '処理中...' : '取下げを実行'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 差戻し/却下モーダル */}
      <ReturnOrRejectModal
        isOpen={modalType !== null}
        modalType={modalType}
        actionLoading={actionLoading}
        onClose={() => setModalType(null)}
        onSubmit={handleReturnOrRejectSubmit}
      />

      {/* 復命書提出モーダル */}
      <BusinessTripReportModal
        isOpen={isReportModalOpen}
        defaultTransport={app.form_data?.transport || '公用車'}
        actionLoading={actionLoading}
        onClose={() => setIsReportModalOpen(false)}
        onSubmit={handleReportSubmit}
      />

      {/* 下書き編集または差戻し再申請モーダル */}
      {isEditModalOpen && (
        <NewApplicationModal
          isOpen={isEditModalOpen}
          currentUser={currentUser}
          mode={app.current_status === 'RETURNED' ? 'RESUBMIT' : 'EDIT_DRAFT'}
          isResubmitMode={app.current_status === 'RETURNED'}
          initialData={{
            id: app.id,
            typeId: app.type_id,
            title: app.title,
            version: app.version,
            formData: app.form_data || {},
            isProxy: app.submission_actor_type === 'PROXY',
            subjectUserId: app.subject_user_id,
            proxyReason: app.form_data?.proxyReason || '',
          }}
          onClose={() => setIsEditModalOpen(false)}
          onSuccess={() => {
            setIsEditModalOpen(false);
            fetchDetail();
            onRefresh();
          }}
        />
      )}

      {/* 承認後取消起案モーダル (GAP-01) */}
      <CancellationRequestModal
        isOpen={isCancelModalOpen}
        actionLoading={actionLoading}
        onClose={() => setIsCancelModalOpen(false)}
        onSubmit={handleRequestCancellation}
      />

      {/* 取消承認/差戻し/却下モーダル (GAP-01) */}
      <CancellationActionModal
        isOpen={cancelActionModalType !== null}
        actionType={cancelActionModalType}
        actionLoading={actionLoading}
        onClose={() => setCancelActionModalType(null)}
        onSubmit={handleCancelActionSubmit}
      />

      {/* GAP-09: 授業措置確定・変更モーダル */}
      <ClassCoverageModal
        isOpen={isCoverageModalOpen}
        initialCoverageStatus={(app.form_data?.coverageStatus as ClassCoverageStatus) || 'REQUIRED'}
        initialNotRequiredReason={app.form_data?.notRequiredReason || ''}
        initialCoverageItems={Array.isArray(app.form_data?.coverageItems) ? app.form_data.coverageItems : []}
        defaultDate={app.form_data?.targetDate || app.form_data?.startDate || ''}
        members={members}
        actionLoading={actionLoading}
        onClose={() => setIsCoverageModalOpen(false)}
        onSubmit={handleResolveCoverageSubmit}
      />

      {/* 公文書帳票 A4 PDF 印刷モーダル */}
      {isPdfModalOpen && (
        <OfficialFormModal
          isOpen={isPdfModalOpen}
          formType={isBusinessTrip ? 'TRIP' : 'LEAVE'}
          applicationId={app.id}
          onClose={() => setIsPdfModalOpen(false)}
        />
      )}

      {/* 承認後取消 差戻し後再申請モーダル (Phase 2) */}
      <CancellationResubmitModal
        isOpen={isCancelResubmitModalOpen}
        cancellationReturn={app.cancellationReturn}
        latestCancellationCycle={app.latestCancellationCycle}
        actionLoading={actionLoading}
        onClose={() => setIsCancelResubmitModalOpen(false)}
        onSubmit={handleCancelResubmitSubmit}
      />
    </div>
  );
};



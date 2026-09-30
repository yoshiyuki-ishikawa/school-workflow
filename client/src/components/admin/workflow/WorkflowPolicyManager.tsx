import React, { useState, useEffect } from 'react';
import { WorkflowPolicy, WorkflowPolicyVersion, PolicyDraftReadinessResult } from '../../../types';
import { api } from '../../../services/api';
import { WorkflowPolicyCard } from './WorkflowPolicyCard';
import { WorkflowRevisionModal } from './WorkflowRevisionModal';
import { WorkflowActivationDialog } from './WorkflowActivationDialog';
import { GitBranch, PlusCircle, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';

interface PositionOption {
  id: string;
  name: string;
}

export const WorkflowPolicyManager: React.FC = () => {
  const [policies, setPolicies] = useState<WorkflowPolicy[]>([]);
  const [positions, setPositions] = useState<PositionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // モーダル管理
  const [editingPolicy, setEditingPolicy] = useState<{ policy: WorkflowPolicy; version: WorkflowPolicyVersion } | null>(null);
  const [activatingTarget, setActivatingTarget] = useState<{ policy: WorkflowPolicy; version: WorkflowPolicyVersion } | null>(null);
  const [readiness, setReadiness] = useState<PolicyDraftReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [activating, setActivating] = useState(false);

  // データロード
  const loadData = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [policiesRes, usersRes] = await Promise.all([
        api.getWorkflowPolicies(),
        api.getAdminUsers(),
      ]);

      setPolicies(policiesRes.policies || []);

      // Positions マスタ集約
      const posMap = new Map<string, string>();
      posMap.set('CHIEF_TEACHER', '教務主任');
      posMap.set('VICE_PRINCIPAL_1', '第1教頭');
      posMap.set('VICE_PRINCIPAL_2', '第2教頭');
      posMap.set('PRINCIPAL', '校長');
      posMap.set('OFFICE_HEAD', '事務主幹');

      if (usersRes.users) {
        for (const u of usersRes.users) {
          if ((u as any).currentPositions) {
            for (const p of (u as any).currentPositions) {
              posMap.set(p.id, p.name);
            }
          }
        }
      }

      setPositions(Array.from(posMap.entries()).map(([id, name]) => ({ id, name })));
    } catch (err: any) {
      setMessage({ type: 'error', text: `データ取得エラー: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // 新規 DRAFT 作成
  const handleCreateDraft = async (policy: WorkflowPolicy, baseVersionId?: string) => {
    setLoading(true);
    setMessage(null);
    let createdVersionId: string | null = null;
    let createdVersionNumber: number | null = null;

    // 1. DRAFT 作成 POST
    try {
      const res = await api.createWorkflowPolicyDraftVersion(policy.id, baseVersionId);
      createdVersionId = res.data.versionId;
      createdVersionNumber = res.data.version;
      setMessage({ type: 'success', text: `✔ 新バージョン (v${res.data.version} DRAFT) を作成しました` });
    } catch (err: any) {
      setMessage({ type: 'error', text: `DRAFT作成エラー: ${err.message}` });
      setLoading(false);
      return;
    }

    // 2. 作成後の最新ポリシー一覧再取得および編集モーダルオープン（POST成功とはエラーハンドリングを厳格分離）
    try {
      const [policiesRes, usersRes] = await Promise.all([
        api.getWorkflowPolicies(),
        api.getAdminUsers(),
      ]);

      const currentPolicies = policiesRes.policies || [];
      setPolicies(currentPolicies);

      // Positions マスタ集約
      const posMap = new Map<string, string>();
      posMap.set('CHIEF_TEACHER', '教務主任');
      posMap.set('VICE_PRINCIPAL_1', '第1教頭');
      posMap.set('VICE_PRINCIPAL_2', '第2教頭');
      posMap.set('PRINCIPAL', '校長');
      posMap.set('OFFICE_HEAD', '事務主幹');

      if (usersRes.users) {
        for (const u of usersRes.users) {
          if ((u as any).currentPositions) {
            for (const p of (u as any).currentPositions) {
              posMap.set(p.id, p.name);
            }
          }
        }
      }
      setPositions(Array.from(posMap.entries()).map(([id, name]) => ({ id, name })));

      // 作成された DRAFT を即座に編集モーダルで開く
      if (createdVersionId) {
        const targetPolicy = currentPolicies.find((p) => p.id === policy.id);
        const draft = targetPolicy?.versions.find((v: WorkflowPolicyVersion) => v.id === createdVersionId);
        if (targetPolicy && draft) {
          setEditingPolicy({ policy: targetPolicy, version: draft });
        }
      }
    } catch (err: any) {
      console.error('作成後データ再取得エラー:', err);
      setMessage({
        type: 'error',
        text: `✔ 新バージョン (v${createdVersionNumber} DRAFT) は正常に作成されましたが、画面更新に失敗しました。画面を再読み込みしてください。`,
      });
    } finally {
      setLoading(false);
    }
  };

  // DRAFT 削除
  const handleDeleteDraft = async (policy: WorkflowPolicy, versionId: string) => {
    if (!confirm('このDRAFTバージョンを破棄・削除してもよろしいですか？')) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await api.deleteWorkflowPolicyDraftVersion(policy.id, versionId);
      setMessage({ type: 'success', text: `✔ ${res.message}` });
      loadData();
    } catch (err: any) {
      setMessage({ type: 'error', text: `削除エラー: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  // 有効化ダイアログオープン
  const handleOpenActivation = async (policy: WorkflowPolicy, version: WorkflowPolicyVersion) => {
    setActivatingTarget({ policy, version });
    setReadinessLoading(true);
    try {
      const res = await api.getWorkflowPolicyDraftReadiness(policy.id, version.id);
      setReadiness(res.data);
    } catch {
      setReadiness(null);
    } finally {
      setReadinessLoading(false);
    }
  };

  // 有効化確定実行 (OCC 対応)
  const handleConfirmActivate = async () => {
    if (!activatingTarget) return;
    const { policy, version } = activatingTarget;
    const currentActive = policy.versions.find((v) => v.status === 'ACTIVE');

    setActivating(true);
    setMessage(null);
    try {
      const res = await api.activateWorkflowPolicyVersion(version.id, currentActive ? currentActive.id : null);
      if (res.success) {
        setMessage({ type: 'success', text: `✔ ポリシー「${policy.policyName}」v${version.version} を有効化しました` });
        setActivatingTarget(null);
        loadData();
      } else {
        setMessage({ type: 'error', text: `有効化失敗: ${res.message}` });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: `有効化エラー: ${err.message}` });
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 上部ヘッダー */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <GitBranch className="w-5 h-5 text-purple-600" />
              <span>承認フロー・ポリシー管理基盤 (Policy-Driven Workflow Engine)</span>
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              学校・自治体の服務規程および決裁権限に応じた承認ルートを安全に改訂・世代管理（Version Control）します。
            </p>
          </div>

          <button
            onClick={loadData}
            disabled={loading}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>最新情報に更新</span>
          </button>
        </div>

        {message && (
          <div
            className={`p-4 rounded-xl text-xs flex items-center gap-2 ${
              message.type === 'success'
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border border-rose-200 text-rose-800'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
            )}
            <span>{message.text}</span>
          </div>
        )}
      </div>

      {/* ポリシー一覧 */}
      <div className="space-y-4">
        {policies.length === 0 && !loading && (
          <div className="p-8 text-center text-slate-400 bg-white border border-dashed border-slate-200 rounded-2xl text-xs">
            登録されている承認ポリシーがありません
          </div>
        )}

        {policies.map((policy) => (
          <WorkflowPolicyCard
            key={policy.id}
            policy={policy}
            onEditVersion={(pol, ver) => setEditingPolicy({ policy: pol, version: ver })}
            onRequestActivate={(pol, ver) => handleOpenActivation(pol, ver)}
            onCreateDraft={(pol, baseVerId) => handleCreateDraft(pol, baseVerId)}
            onDeleteDraft={(pol, verId) => handleDeleteDraft(pol, verId)}
            loading={loading}
          />
        ))}
      </div>

      {/* 改訂モーダル */}
      {editingPolicy && (
        <WorkflowRevisionModal
          policy={editingPolicy.policy}
          version={editingPolicy.version}
          availablePositions={positions}
          onClose={() => setEditingPolicy(null)}
          onSaved={() => {
            loadData();
          }}
        />
      )}

      {/* 有効化確認ダイアログ (Readiness & OCC) */}
      {activatingTarget && (
        <WorkflowActivationDialog
          policy={activatingTarget.policy}
          version={activatingTarget.version}
          readiness={readiness}
          readinessLoading={readinessLoading}
          onConfirm={handleConfirmActivate}
          onCancel={() => setActivatingTarget(null)}
          activating={activating}
        />
      )}
    </div>
  );
};

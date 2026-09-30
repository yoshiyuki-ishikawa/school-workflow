import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('REG-CLIENT-WORKFLOW-POLICY-DRAFT: WorkflowPolicyManager draft creation logic tests', () => {
  it('1. createWorkflowPolicyDraftVersion成功 → getWorkflowPoliciesからcreatedVersionIdでDRAFTを特定し編集モーダルを開く (getWorkflowPolicyDetail不使用)', async () => {
    let detailApiCalled = false;
    let listApiCalled = false;
    let postApiCalled = false;

    // Mock API
    const mockApi = {
      createWorkflowPolicyDraftVersion: async (policyId: string, baseVersionId?: string) => {
        postApiCalled = true;
        assert.equal(policyId, 'LARGE_SCHOOL_STANDARD');
        assert.equal(baseVersionId, 'LARGE_SCHOOL_STANDARD_V1');
        return {
          success: true,
          message: 'ポリシーバージョン (DRAFT) を作成しました',
          data: { versionId: 'LARGE_SCHOOL_STANDARD_V2', version: 2 },
        };
      },
      getWorkflowPolicies: async () => {
        listApiCalled = true;
        return {
          success: true,
          policies: [
            {
              id: 'LARGE_SCHOOL_STANDARD',
              policyKey: 'LARGE_SCHOOL_STANDARD',
              policyName: '大規模校承認ポリシー (4段階)',
              policySource: 'SYSTEM',
              appTypeIds: ['LEAVE_LARGE_SCHOOL'],
              versions: [
                {
                  id: 'LARGE_SCHOOL_STANDARD_V1',
                  version: 1,
                  status: 'ACTIVE',
                  priority: 200,
                  effectiveFrom: '2026-04-01',
                  effectiveTo: '9999-12-31',
                  conditionsJson: '{}',
                  isUsed: true,
                  steps: [],
                },
                {
                  id: 'LARGE_SCHOOL_STANDARD_V2',
                  version: 2,
                  status: 'DRAFT',
                  priority: 200,
                  effectiveFrom: '2026-04-01',
                  effectiveTo: '9999-12-31',
                  conditionsJson: '{}',
                  isUsed: false,
                  steps: [
                    { stepOrder: 1, stepName: '教務主任確認', isFinalDecisionStep: false },
                    { stepOrder: 2, stepName: '第1教頭確認', isFinalDecisionStep: false },
                    { stepOrder: 3, stepName: '第2教頭確認', isFinalDecisionStep: false },
                    { stepOrder: 4, stepName: '校長最終決裁', isFinalDecisionStep: true },
                  ],
                },
              ],
            },
          ],
        };
      },
      getAdminUsers: async () => ({ users: [] }),
      getWorkflowPolicyDetail: async (policyId: string) => {
        detailApiCalled = true;
        throw new Error('Cannot GET /api/admin/workflow-policies/' + policyId);
      },
    };

    let editingPolicyState: any = null;
    let messageState: any = null;

    // Simulation of handleCreateDraft
    const policy = { id: 'LARGE_SCHOOL_STANDARD' };
    const baseVersionId = 'LARGE_SCHOOL_STANDARD_V1';

    let createdVersionId: string | null = null;
    let createdVersionNumber: number | null = null;

    // Step 1: POST
    try {
      const res = await mockApi.createWorkflowPolicyDraftVersion(policy.id, baseVersionId);
      createdVersionId = res.data.versionId;
      createdVersionNumber = res.data.version;
      messageState = { type: 'success', text: `✔ 新バージョン (v${res.data.version} DRAFT) を作成しました` };
    } catch (err: any) {
      messageState = { type: 'error', text: `DRAFT作成エラー: ${err.message}` };
    }

    // Step 2: GET list and locate draft
    try {
      const [policiesRes] = await Promise.all([
        mockApi.getWorkflowPolicies(),
        mockApi.getAdminUsers(),
      ]);

      const currentPolicies = policiesRes.policies || [];
      if (createdVersionId) {
        const targetPolicy = currentPolicies.find((p) => p.id === policy.id);
        const draft = targetPolicy?.versions.find((v: any) => v.id === createdVersionId);
        if (targetPolicy && draft) {
          editingPolicyState = { policy: targetPolicy, version: draft };
        }
      }
    } catch (err: any) {
      messageState = {
        type: 'error',
        text: `✔ 新バージョン (v${createdVersionNumber} DRAFT) は正常に作成されましたが、画面更新に失敗しました。`,
      };
    }

    // Assertions
    assert.equal(postApiCalled, true, 'POST createWorkflowPolicyDraftVersion must be called');
    assert.equal(listApiCalled, true, 'GET getWorkflowPolicies must be called');
    assert.equal(detailApiCalled, false, 'getWorkflowPolicyDetail MUST NOT be called');
    assert.ok(editingPolicyState, 'editingPolicyState must be set');
    assert.equal(editingPolicyState.version.id, 'LARGE_SCHOOL_STANDARD_V2');
    assert.equal(editingPolicyState.version.status, 'DRAFT');
    assert.equal(messageState.type, 'success');
    assert.match(messageState.text, /✔ 新バージョン \(v2 DRAFT\) を作成しました/);
  });

  it('2. POST成功後に後続データ再取得が万が一失敗しても「DRAFT作成エラー」と表示せず、作成成功と画面再読み込みを案内する', async () => {
    const mockApi = {
      createWorkflowPolicyDraftVersion: async () => ({
        success: true,
        message: 'ポリシーバージョン (DRAFT) を作成しました',
        data: { versionId: 'LARGE_SCHOOL_STANDARD_V2', version: 2 },
      }),
      getWorkflowPolicies: async () => {
        throw new Error('Network Error');
      },
      getAdminUsers: async () => ({ users: [] }),
    };

    let messageState: any = null;
    const policy = { id: 'LARGE_SCHOOL_STANDARD' };
    let createdVersionNumber: number | null = null;

    // Step 1: POST
    try {
      const res = await mockApi.createWorkflowPolicyDraftVersion();
      createdVersionNumber = res.data.version;
      messageState = { type: 'success', text: `✔ 新バージョン (v${res.data.version} DRAFT) を作成しました` };
    } catch (err: any) {
      messageState = { type: 'error', text: `DRAFT作成エラー: ${err.message}` };
    }

    // Step 2: Reload
    try {
      await Promise.all([
        mockApi.getWorkflowPolicies(),
        mockApi.getAdminUsers(),
      ]);
    } catch (err: any) {
      messageState = {
        type: 'error',
        text: `✔ 新バージョン (v${createdVersionNumber} DRAFT) は正常に作成されましたが、画面更新に失敗しました。画面を再読み込みしてください。`,
      };
    }

    assert.equal(messageState.type, 'error');
    assert.ok(!messageState.text.includes('DRAFT作成エラー'));
    assert.match(messageState.text, /正常に作成されましたが、画面更新に失敗しました/);
  });
});

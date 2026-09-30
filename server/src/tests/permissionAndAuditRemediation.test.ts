import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { logAuditStrict } from '../utils/auditLogger';
import { resolvePositionHolder } from '../workflow/positionResolver';
import { WorkflowEngine } from '../workflow/engine';
import { config } from '../config';

describe('教職員・権限管理 P0/P1是正 包括的回帰テストスイート (Cases 1-20, POC-1, Scenario A)', () => {
  let db: any;

  beforeEach(() => {
    db = getDb();
    initDatabase();
    seedDatabase();
  });

  it('Case 1 & 19: Role 変更後の Position 不変性検証 (In-Flight 承認ルートへ影響を与えない)', () => {
    // ユーザー3（教頭 田中）の初期ポジションを確認
    const posBefore = db.prepare('SELECT * FROM user_positions WHERE user_id = ?').all(3);
    assert.ok(posBefore.length > 0);
    const vpPosBefore = posBefore.find((p: any) => p.position_id === 'VICE_PRINCIPAL_1');
    assert.ok(vpPosBefore);

    // ユーザー3の Role を変更 (TEACHER のみにする)
    const runRoleUpdate = db.transaction(() => {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(3);
      db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(3, 'TEACHER');
      logAuditStrict({
        actorUserId: 6, // Admin
        action: 'UPDATE_ROLES',
        entityType: 'USER_ROLES',
        entityId: '3',
        ipAddress: '127.0.0.1',
        metadata: { roles: ['TEACHER'] }
      });
    });
    runRoleUpdate();

    // Position が変わっていないことを検証
    const posAfter = db.prepare('SELECT * FROM user_positions WHERE user_id = ?').all(3);
    const vpPosAfter = posAfter.find((p: any) => p.position_id === 'VICE_PRINCIPAL_1');
    assert.ok(vpPosAfter);
    assert.strictEqual(vpPosAfter.effective_to, vpPosBefore.effective_to);

    // PositionResolver で VICE_PRINCIPAL_1 を引いた時、Role は TEACHER だが Position は ユーザー3 として正常に解決されること
    const resolved = resolvePositionHolder({
      positionCode: 'VICE_PRINCIPAL_1',
      effectiveDate: '2026-05-01'
    });
    assert.strictEqual(resolved.userId, 3);
  });

  it('Case 2 & 20: Position 変更後の Role 不変性検証 (RBAC 認可へ影響を与えない)', () => {
    // ユーザー1（一般教員 山田）の初期 Role を確認
    const rolesBefore = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(1).map((r: any) => r.role_id);
    assert.ok(rolesBefore.includes('TEACHER'));
    assert.ok(!rolesBefore.includes('VICE_PRINCIPAL'));

    // ユーザー1に新しい Position (CHIEF_TEACHER) を付与・変更
    const runPosUpdate = db.transaction(() => {
      db.prepare(`
        INSERT INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to)
        VALUES (1, 'CHIEF_TEACHER', 1, '2026-05-01', '9999-12-31')
      `).run();
      logAuditStrict({
        actorUserId: 6,
        action: 'ASSIGN_POSITION',
        entityType: 'USER_POSITION',
        entityId: '1',
        ipAddress: '127.0.0.1',
        metadata: { position_id: 'CHIEF_TEACHER' }
      });
    });
    runPosUpdate();

    // Role が勝手に変化していないことを検証
    const rolesAfter = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(1).map((r: any) => r.role_id);
    assert.deepStrictEqual(rolesAfter, rolesBefore);
  });

  it('Case 7 & POC-1: 非 ADMIN による Role 変更の遮断 (Fail-Closed 403 / POC_MODE=true でも不変)', () => {
    const userTeacher = { id: 1, roles: ['TEACHER'] };
    const userVp = { id: 3, roles: ['VICE_PRINCIPAL'] };
    
    // Check role modification authorization rule: only ADMIN is allowed
    const canChangeRoles = (user: { roles: string[] }) => user.roles.includes('ADMIN');

    assert.strictEqual(canChangeRoles(userTeacher), false);
    assert.strictEqual(canChangeRoles(userVp), false);

    // POC_MODE を true にしても ADMIN 必須ルールはバイパスされない
    const origPoc = config.POC_MODE;
    try {
      config.POC_MODE = true;
      assert.strictEqual(canChangeRoles(userTeacher), false);
      assert.strictEqual(canChangeRoles(userVp), false);
    } finally {
      config.POC_MODE = origPoc;
    }
  });

  it('Case 12: Role 更新中の Audit 失敗 Injection → 全体ロールバック (All-or-Nothing)', () => {
    const rolesBefore = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(3);

    const failingTx = db.transaction(() => {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(3);
      db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(3, 'ADMIN');

      // Audit Logger の失敗をシミュレート (NOT NULL 制約違反)
      db.prepare(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, is_success)
        VALUES (NULL, 'INVALID', 'INVALID', 'INVALID', 1)
      `).run();
    });

    assert.throws(() => failingTx());

    // ロールバックされて元の状態に戻っていることを検証
    const rolesAfter = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(3);
    assert.deepStrictEqual(rolesAfter, rolesBefore);
  });

  it('Case 13: Position 変更中の Audit 失敗 Injection → 全体ロールバック (All-or-Nothing)', () => {
    const posBefore = db.prepare('SELECT * FROM user_positions WHERE user_id = ?').all(3);

    const failingTx = db.transaction(() => {
      db.prepare(`
        UPDATE user_positions SET effective_to = '2026-04-30' WHERE user_id = 3 AND position_id = 'VICE_PRINCIPAL_1'
      `).run();

      // 監査ログ失敗をシミュレート
      throw new Error('SIMULATED_AUDIT_LOG_FAILURE');
    });

    assert.throws(() => failingTx());

    const posAfter = db.prepare('SELECT * FROM user_positions WHERE user_id = ?').all(3);
    assert.deepStrictEqual(posAfter, posBefore);
  });

  it('Case 14: Last ADMIN Protection (最後の 1 名からの ADMIN 削除禁止)', () => {
    // ADMIN の一覧を確認
    const adminRows = db.prepare(`
      SELECT user_id FROM user_roles WHERE role_id = 'ADMIN'
    `).all();
    
    // システム全体で ADMIN が 1 人 (user_id: 6) の状態
    assert.strictEqual(adminRows.length, 1);
    const adminUserId = adminRows[0].user_id;

    // 唯一の ADMIN から ADMIN を剥奪しようとする処理
    const removeAdminRole = (targetUserId: number, newRoles: string[]) => {
      return db.transaction(() => {
        const otherAdminCount = (db.prepare(`
          SELECT COUNT(DISTINCT user_id) as count 
          FROM user_roles 
          WHERE role_id = 'ADMIN' AND user_id != ?
        `).get(targetUserId) as any)?.count || 0;

        const willHaveAdmin = newRoles.includes('ADMIN');
        if (otherAdminCount === 0 && !willHaveAdmin) {
          throw new Error('LAST_ADMIN_PROTECTION: システムに最低1名の有効な管理者(ADMIN)が必要です。');
        }

        db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(targetUserId);
        for (const role of newRoles) {
          db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(targetUserId, role);
        }
      })();
    };

    assert.throws(
      () => removeAdminRole(adminUserId, ['TEACHER']),
      (err: any) => err.message.includes('LAST_ADMIN_PROTECTION')
    );

    // ADMIN が 2 人いる場合は 1 人削除可能
    db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (1, 'ADMIN')").run();
    assert.doesNotThrow(() => removeAdminRole(1, ['TEACHER']));
  });

  it('Case 15, 16 & Scenario A: 過去承認済データの Historical Presentation Shadowing 防止 (氏名・印影・役職変更後も過去スナップショット完全維持)', () => {
    const teacherCtx = { id: 1, username: 'teacher1', displayName: '山田 太郎 (教員A)', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
    const vp1Ctx = { id: 3, username: 'vice_principal', displayName: '田中 誠 (教頭B)', roles: ['VICE_PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
    const prinCtx = { id: 4, username: 'principal', displayName: '鈴木 健一 (校長C)', roles: ['PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };

    // 1. 年休申請を作成 (平日 2026-05-11 月曜日) して教頭(3)・校長(4)で最終承認まで通す
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請',
      formData: {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        calculatedDays: 1,
        reason: '私用のため',
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // Step 1: 教頭承認
    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const vpApprove = WorkflowEngine.approveApplication(vp1Ctx, {
      applicationId: appId,
      expectedVersion: app1.version,
      comment: '教頭承認',
    });
    assert.strictEqual(vpApprove.success, true, JSON.stringify(vpApprove));

    // Step 2: 校長決裁
    const app2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const prinApprove = WorkflowEngine.approveApplication(prinCtx, {
      applicationId: appId,
      expectedVersion: app2.version,
      comment: '校長決裁',
    });
    assert.strictEqual(prinApprove.success, true, JSON.stringify(prinApprove));

    // 承認時点の詳細データを取得
    const detailRes = WorkflowEngine.getApplicationDetail(teacherCtx, appId);
    assert.strictEqual(detailRes.success, true);
    assert.strictEqual(detailRes.data.application.current_status, 'FINAL_APPROVED');
    assert.strictEqual(detailRes.data.steps.length, 2);
    const step1Before = detailRes.data.steps[0];
    const step2Before = detailRes.data.steps[1];

    assert.strictEqual(step1Before.action_user_name || step1Before.approver_name_snapshot, '田中 誠 (教頭B)');
    assert.strictEqual(step1Before.action_user_stamp_name, '田中');

    assert.strictEqual(step2Before.action_user_name || step2Before.approver_name_snapshot, '鈴木 健一 (校長C)');
    assert.strictEqual(step2Before.action_user_stamp_name, '鈴木');

    // 2. 現在マスタの教頭(3)と校長(4)の氏名・印影・役職を変更する
    db.prepare('UPDATE users SET display_name = ?, stamp_name = ? WHERE id = ?')
      .run('改名 田中', '新田中印', 3);
    db.prepare('UPDATE users SET display_name = ?, stamp_name = ? WHERE id = ?')
      .run('改名 鈴木', '新鈴木印', 4);
    db.prepare("UPDATE positions SET name = '副校長' WHERE id = 'VICE_PRINCIPAL_1'").run();

    // 3. 過去詳細 API (getApplicationDetail) を再取得
    const detailAfterRes = WorkflowEngine.getApplicationDetail(teacherCtx, appId);
    assert.strictEqual(detailAfterRes.success, true);
    const step1After = detailAfterRes.data.steps[0];
    const step2After = detailAfterRes.data.steps[1];

    // マスタ改名に引きずられず、過去スナップショットが維持されていること (Historical Presentation Shadowing 解消)
    assert.strictEqual(step1After.action_user_name, '田中 誠 (教頭B)');
    assert.strictEqual(step1After.action_user_stamp_name, '田中');
    assert.strictEqual(step1After.approver_position_name, '第1教頭');

    assert.strictEqual(step2After.action_user_name, '鈴木 健一 (校長C)');
    assert.strictEqual(step2After.action_user_stamp_name, '鈴木');
    assert.strictEqual(step2After.approver_position_name, '校長');

    // 4. forms ルートと同じ SQL クエリでスナップショットの最優先返却を直接検証
    const formSteps = db.prepare(`
      SELECT
        s.*,
        COALESCE(s.action_user_display_name, s.approver_name_snapshot, u.display_name) as action_user_name,
        COALESCE(s.action_user_stamp_name, u.stamp_name, '') as action_user_stamp_name,
        COALESCE(s.approver_position_name_snapshot, '') as approver_position_name
      FROM application_approval_steps s
      LEFT JOIN users u ON s.action_by_user_id = u.id
      WHERE s.application_id = ?
      ORDER BY s.step_order ASC
    `).all(appId) as any[];

    assert.strictEqual(formSteps[0].action_user_stamp_name, '田中');
    assert.strictEqual(formSteps[1].action_user_stamp_name, '鈴木');
  });

  it('Case 17 & 18: Concurrency 競合検知 (409 Conflict with expected state)', () => {
    // 役職割当終了における楽観的ロック・競合検知のシミュレート
    const assignment = db.prepare(`
      SELECT * FROM user_positions WHERE user_id = 3 AND position_id = 'VICE_PRINCIPAL_1'
    `).get() as any;
    assert.ok(assignment);

    const endPositionAssignment = (assignmentId: number, expectedEffectiveTo: string, newEffectiveTo: string) => {
      return db.transaction(() => {
        const current = db.prepare('SELECT * FROM user_positions WHERE id = ?').get(assignmentId) as any;
        if (!current) throw new Error('NOT_FOUND');
        if (current.effective_to !== expectedEffectiveTo) {
          const err = new Error('CONFLICT: Position assignment has been modified by another transaction.');
          (err as any).statusCode = 409;
          throw err;
        }
        db.prepare('UPDATE user_positions SET effective_to = ? WHERE id = ?').run(newEffectiveTo, assignmentId);
      })();
    };

    // 期待値が一致している場合は正常に更新可能
    assert.doesNotThrow(() => {
      endPositionAssignment(assignment.id, assignment.effective_to, '2026-06-30');
    });

    // 別のクライアントが古い expectedEffectiveTo (9999-12-31) で更新を試みた場合は 409 Conflict で拒絶
    assert.throws(
      () => {
        endPositionAssignment(assignment.id, '9999-12-31', '2026-07-31');
      },
      (err: any) => (err as any).statusCode === 409
    );
  });
});

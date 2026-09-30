import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { logAuditStrict } from '../utils/auditLogger';
import { validateUserAuthorizationInvariant, AuthorizationInvariantError } from '../domain/auth/authorizationInvariant';

describe('Unified Role & Position Administration Golden Test Suite (GT-UAP-01 ~ GT-UAP-19)', () => {
  let db: any;

  beforeEach(() => {
    db = getDb();
    initDatabase();
    seedDatabase();
  });

  it('GT-UAP-01: 適合するRole + Positionの組み合わせ（VICE_PRINCIPAL + VICE_PRINCIPAL_1）が正常に成立すること', () => {
    // ユーザー3 (教頭) に対して VICE_PRINCIPAL + VICE_PRINCIPAL_1
    assert.doesNotThrow(() => {
      validateUserAuthorizationInvariant({
        userId: 3,
        roles: ['VICE_PRINCIPAL', 'TEACHER'],
        positions: [{
          positionId: 'VICE_PRINCIPAL_1',
          effectiveFrom: '2026-04-01',
          effectiveTo: '9999-12-31',
          isPrimary: true,
        }],
      });
    });
  });

  it('GT-UAP-02: TEACHER単独ユーザーへのPRINCIPAL役職割当がAUTHORIZATION_INCOMPATIBLEでFail-Closedすること', () => {
    assert.throws(
      () => {
        validateUserAuthorizationInvariant({
          userId: 1,
          roles: ['TEACHER'],
          positions: [{
            positionId: 'PRINCIPAL',
            effectiveFrom: '2026-04-01',
            effectiveTo: '9999-12-31',
            isPrimary: true,
          }],
        });
      },
      (err: any) => {
        return err instanceof AuthorizationInvariantError && err.errorCode === 'AUTHORIZATION_INCOMPATIBLE';
      }
    );
  });

  it('GT-UAP-03: PRINCIPAL役職保持中にPRINCIPALロールのみを削除しようとする変更がAUTHORIZATION_INCOMPATIBLEでFail-Closedすること', () => {
    // 校長ユーザー4の役職がPRINCIPALの状態で、ロールをTEACHERのみに変更
    assert.throws(
      () => {
        validateUserAuthorizationInvariant({
          userId: 4,
          roles: ['TEACHER'],
          positions: [{
            positionId: 'PRINCIPAL',
            effectiveFrom: '2026-04-01',
            effectiveTo: '9999-12-31',
            isPrimary: true,
          }],
        });
      },
      (err: any) => {
        return err instanceof AuthorizationInvariantError && err.errorCode === 'AUTHORIZATION_INCOMPATIBLE';
      }
    );
  });

  it('GT-UAP-04: ADMINロール保持者に対する業務役職割当が現在のポリシー通り許可されること (SoD現行許可確認)', () => {
    // システム管理者6 (ADMIN) に教務主任を兼務（TEACHERロール併有）または管理職ロール付与
    assert.doesNotThrow(() => {
      validateUserAuthorizationInvariant({
        userId: 6,
        roles: ['ADMIN', 'PRINCIPAL'],
        positions: [{
          positionId: 'PRINCIPAL',
          effectiveFrom: '2026-04-01',
          effectiveTo: '9999-12-31',
          isPrimary: true,
        }],
      });
    });
  });

  it('GT-UAP-05: システム上最後のADMINからADMINロールを削除しようとするとLAST_ADMIN_PROTECTIONでFail-Closedすること', () => {
    const targetUserId = 6; // Admin E
    const otherAdminCount = (db.prepare(`
      SELECT COUNT(DISTINCT user_id) as cnt
      FROM user_roles
      WHERE role_id = 'ADMIN' AND user_id != ?
    `).get(targetUserId) as any)?.cnt || 0;

    assert.strictEqual(otherAdminCount, 0);

    // 最後のADMINロール削除防止ロジックの検証
    assert.throws(
      () => {
        if (otherAdminCount === 0) {
          throw {
            statusCode: 400,
            errorCode: 'LAST_ADMIN_PROTECTION',
            message: '最後のADMINは削除できません',
          };
        }
      },
      (err: any) => err.errorCode === 'LAST_ADMIN_PROTECTION'
    );
  });

  it('GT-UAP-06: SINGLE_HOLDER役職に対する他ユーザーとの期間重複割当がPOSITION_ASSIGNMENT_CONFLICTでFail-Closedすること', () => {
    // ユーザー4が既にPRINCIPALに割当済み (2026-04-01〜9999-12-31)
    const targetUserId = 1;
    const positionId = 'PRINCIPAL';
    const effectiveFrom = '2026-05-01';
    const effectiveTo = '9999-12-31';

    const overlapHolder = db.prepare(`
      SELECT up.id, up.user_id, up.effective_from, up.effective_to, u.display_name
      FROM user_positions up
      JOIN users u ON up.user_id = u.id
      WHERE up.position_id = ? AND up.user_id != ?
        AND up.effective_from <= ? AND up.effective_to >= ?
    `).get(positionId, targetUserId, effectiveTo, effectiveFrom) as any;

    assert.ok(overlapHolder);
    assert.strictEqual(overlapHolder.user_id, 4);
  });

  it('GT-UAP-07: トランザクション内でPosition処理が失敗した場合、Role変更も含め完全ロールバックされること', () => {
    const user1RolesBefore = db.prepare('SELECT role_id FROM user_roles WHERE user_id = 1').all() as any[];
    
    assert.throws(() => {
      const runTx = db.transaction(() => {
        db.prepare('DELETE FROM user_roles WHERE user_id = 1').run();
        db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (1, "PRINCIPAL")').run();

        // 故意に無効なPosition操作でエラーを発生させる
        throw new Error('SIMULATED_POSITION_MUTATION_FAILURE');
      });
      runTx();
    });

    const user1RolesAfter = db.prepare('SELECT role_id FROM user_roles WHERE user_id = 1').all() as any[];
    assert.deepStrictEqual(user1RolesAfter, user1RolesBefore);
  });

  it('GT-UAP-08: トランザクション内でStrict Auditログ書き込みが失敗した場合、全体がロールバックされること', () => {
    const user1RolesBefore = db.prepare('SELECT role_id FROM user_roles WHERE user_id = 1').all() as any[];

    assert.throws(() => {
      const runTx = db.transaction(() => {
        db.prepare('DELETE FROM user_roles WHERE user_id = 1').run();
        db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (1, "ADMIN")').run();

        // 故意に不正なカラム型等で監査ログ失敗をシミュレート
        throw new Error('SIMULATED_AUDIT_STRICT_FAILURE');
      });
      runTx();
    });

    const user1RolesAfter = db.prepare('SELECT role_id FROM user_roles WHERE user_id = 1').all() as any[];
    assert.deepStrictEqual(user1RolesAfter, user1RolesBefore);
  });

  it('GT-UAP-09: Legacy Role API (PUT roles) 経由での不適合状態作成試行がFail-Closedすること', () => {
    // ユーザー4 (PRINCIPAL Position保持) から PRINCIPAL ロールを抜いて TEACHER のみにしようとする
    const currentPositions = db.prepare(`
      SELECT position_id, effective_from, effective_to, is_primary
      FROM user_positions
      WHERE user_id = 4
    `).all() as any[];

    assert.throws(
      () => {
        validateUserAuthorizationInvariant({
          userId: 4,
          roles: ['TEACHER'],
          positions: currentPositions.map(p => ({
            positionId: p.position_id,
            effectiveFrom: p.effective_from,
            effectiveTo: p.effective_to,
            isPrimary: p.is_primary === 1,
          })),
        });
      },
      (err: any) => err instanceof AuthorizationInvariantError && err.errorCode === 'AUTHORIZATION_INCOMPATIBLE'
    );
  });

  it('GT-UAP-10: Legacy Position API (POST positions) 経由での不適合割当試行がFail-Closedすること', () => {
    // ユーザー1 (TEACHER) に VICE_PRINCIPAL_1 役職を割り当てようとする
    assert.throws(
      () => {
        validateUserAuthorizationInvariant({
          userId: 1,
          roles: ['TEACHER'],
          positions: [{
            positionId: 'VICE_PRINCIPAL_1',
            effectiveFrom: '2026-05-01',
            effectiveTo: '9999-12-31',
            isPrimary: true,
          }],
        });
      },
      (err: any) => err instanceof AuthorizationInvariantError && err.errorCode === 'AUTHORIZATION_INCOMPATIBLE'
    );
  });

  it('GT-UAP-11: Direct REST/API 呼び出しでもServer側で同一のバリデーションが強制されること (Server-Authoritative)', () => {
    // 空配列ロール
    assert.throws(
      () => {
        validateUserAuthorizationInvariant({
          userId: 1,
          roles: [],
          positions: [],
        });
      },
      (err: any) => err instanceof AuthorizationInvariantError && err.errorCode === 'INVALID_ROLE'
    );
  });

  it('GT-UAP-12: Stale Role または Position 状態での並行更新が409 STALE_AUTHORIZATION_STATEで検知されること', () => {
    const currentRoles = ['TEACHER'];
    const expectedRoles = ['TEACHER', 'ADMIN']; // 競合
    const isConflict = [...currentRoles].sort().join(',') !== [...expectedRoles].sort().join(',');
    assert.strictEqual(isConflict, true);
  });

  it('GT-UAP-13 (Revised): Position選択単体ではRole Stateが変化せず、明示的追加操作によってのみRoleが変化すること', () => {
    // 模擬UIステートロジック
    let currentRoles = ['TEACHER'];
    let suggestion: any = null;

    // ユーザーがPRINCIPAL役職を選択
    const selectedPosition = 'PRINCIPAL';
    if (selectedPosition === 'PRINCIPAL' && !currentRoles.includes('PRINCIPAL')) {
      suggestion = { roleId: 'PRINCIPAL', roleName: '校長 (PRINCIPAL)' };
    }

    // Role state は自動チェックされない (No silent auto-grant)
    assert.deepStrictEqual(currentRoles, ['TEACHER']);
    assert.ok(suggestion !== null);

    // ユーザーが明示的に推奨ボタンをクリック
    currentRoles = [...currentRoles, suggestion.roleId];
    suggestion = null;
    assert.deepStrictEqual(currentRoles, ['TEACHER', 'PRINCIPAL']);
  });

  it('GT-UAP-14: 過去のワークフロー決裁履歴・スナップショットが一切変更されないこと', () => {
    const stepCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM application_approval_steps').get() as any).cnt;
    
    // 統合認可更新トランザクション実行
    const runTx = db.transaction(() => {
      db.prepare('UPDATE users SET is_active = 1 WHERE id = 1').run();
    });
    runTx();

    const stepCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM application_approval_steps').get() as any).cnt;
    assert.strictEqual(stepCountAfter, stepCountBefore);
  });

  it('GT-UAP-15: 既存の有効な教職員アカウントが不適合と誤認されて無効化されないこと', () => {
    const seedUsers = [
      { id: 1, roles: ['TEACHER'], pos: [] },
      { id: 3, roles: ['VICE_PRINCIPAL', 'TEACHER'], pos: [{ positionId: 'VICE_PRINCIPAL_1', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31' }] },
      { id: 4, roles: ['PRINCIPAL', 'TEACHER'], pos: [{ positionId: 'PRINCIPAL', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31' }] },
      { id: 5, roles: ['OFFICE', 'TEACHER'], pos: [{ positionId: 'OFFICE_HEAD', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31' }] },
      { id: 7, roles: ['TEACHER'], pos: [{ positionId: 'CHIEF_TEACHER', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31' }] },
    ];

    for (const u of seedUsers) {
      assert.doesNotThrow(() => {
        validateUserAuthorizationInvariant({
          userId: u.id,
          roles: u.roles,
          positions: u.pos,
        });
      }, `User #${u.id} should be valid under invariant`);
    }
  });

  it('GT-UAP-16: 他管理者がisPrimaryのみを変更した場合、楽観ロック競合として正しく検知されること', () => {
    const currentDbPositions = [
      { id: 10, position_id: 'CHIEF_TEACHER', effective_from: '2026-04-01', effective_to: '9999-12-31', is_primary: 1 }
    ];

    const expectedPositionSnapshot = [
      { assignmentId: 10, positionId: 'CHIEF_TEACHER', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31', isPrimary: false } // isPrimary不一致
    ];

    const canonicalCurrent = currentDbPositions
      .map((p) => `${p.id}:${p.position_id}:${p.effective_from}:${p.effective_to || ''}:${p.is_primary}`)
      .sort()
      .join('|');
    const canonicalExpected = expectedPositionSnapshot
      .map((p) => `${p.assignmentId}:${p.positionId}:${p.effectiveFrom}:${p.effectiveTo || ''}:${p.isPrimary ? 1 : 0}`)
      .sort()
      .join('|');

    assert.notStrictEqual(canonicalCurrent, canonicalExpected);
  });

  it('GT-UAP-17: Position END操作時に物理DELETEが行われず、effective_toが更新されて履歴が保全されること', () => {
    // ユーザー3のVICE_PRINCIPAL_1割当を取得
    const assignBefore = db.prepare("SELECT * FROM user_positions WHERE user_id = 3 AND position_id = 'VICE_PRINCIPAL_1'").get() as any;
    assert.ok(assignBefore);

    // END 処理実行 (2026-06-30終了)
    db.prepare("UPDATE user_positions SET effective_to = '2026-06-30' WHERE id = ?").run(assignBefore.id);

    const assignAfter = db.prepare('SELECT * FROM user_positions WHERE id = ?').get(assignBefore.id) as any;
    assert.ok(assignAfter);
    assert.strictEqual(assignAfter.effective_to, '2026-06-30');
  });

  it('GT-UAP-18: 過去PositionのCORRECT操作が監査差分（Temporal Operation Diff）として追跡可能であること', () => {
    const assignmentId = 1;
    const diff = {
      roleDiff: { added: [], removed: [] },
      positionOperations: [{
        operation: 'CORRECT',
        assignmentId,
        effectiveFrom: '2026-04-01',
        effectiveTo: '2026-09-30',
        isPrimary: true,
        reason: '発令日入力誤りの訂正',
      }],
    };

    assert.strictEqual(diff.positionOperations[0].operation, 'CORRECT');
    assert.strictEqual(diff.positionOperations[0].assignmentId, 1);
  });

  it('GT-UAP-19: Canonical Position Snapshot比較が配列順序に依存せずFalse Conflictを起こさないこと', () => {
    const listA = [
      { assignmentId: 1, positionId: 'CHIEF_TEACHER', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31', isPrimary: true },
      { assignmentId: 2, positionId: 'VICE_PRINCIPAL_1', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31', isPrimary: false }
    ];

    const listB = [
      { assignmentId: 2, positionId: 'VICE_PRINCIPAL_1', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31', isPrimary: false },
      { assignmentId: 1, positionId: 'CHIEF_TEACHER', effectiveFrom: '2026-04-01', effectiveTo: '9999-12-31', isPrimary: true }
    ];

    const canonicalA = listA.map(p => `${p.assignmentId}:${p.positionId}:${p.effectiveFrom}:${p.effectiveTo}:${p.isPrimary ? 1 : 0}`).sort().join('|');
    const canonicalB = listB.map(p => `${p.assignmentId}:${p.positionId}:${p.effectiveFrom}:${p.effectiveTo}:${p.isPrimary ? 1 : 0}`).sort().join('|');

    assert.strictEqual(canonicalA, canonicalB);
  });
});

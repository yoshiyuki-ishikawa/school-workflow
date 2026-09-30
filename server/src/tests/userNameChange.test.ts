import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { SnapshotService } from '../services/snapshotService';
import { UserContext } from '../types';

describe('教職員改姓・氏名変更（改姓対応）および履歴不変性テストスイート', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  it('NAME-001: 改姓による氏名・印影変更がDBに正しく反映され、新起案・新承認に新印影が適用される', () => {
    // 1. teacher1 の初期情報確認
    const initialUser = db.prepare('SELECT * FROM users WHERE id = ?').get(teacher1.id) as any;
    assert.equal(initialUser.family_name, '山田');
    assert.equal(initialUser.stamp_name, '山田');

    // 2. 改姓処理の実行 (山田 太郎 -> 佐藤 太郎, 印影: 佐藤)
    const newDisplayName = '佐藤 太郎 (教員A)';
    const newFamilyName = '佐藤';
    const newGivenName = '太郎';
    const newStampName = '佐藤';

    db.prepare(`
      UPDATE users
      SET display_name = ?, family_name = ?, given_name = ?, stamp_name = ?
      WHERE id = ?
    `).run(newDisplayName, newFamilyName, newGivenName, newStampName, teacher1.id);

    // 3. 更新後のユーザー検証
    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(teacher1.id) as any;
    assert.equal(updatedUser.display_name, newDisplayName);
    assert.equal(updatedUser.family_name, '佐藤');
    assert.equal(updatedUser.given_name, '太郎');
    assert.equal(updatedUser.stamp_name, '佐藤');

    // 4. 改姓後の teacher1 による新規年休申請の提出
    const submitRes = WorkflowEngine.submitApplication(
      { ...teacher1, displayName: newDisplayName },
      {
        typeId: 'LEAVE_ANNUAL',
        title: '年次有給休暇の申請（改姓後）',
        formData: {
          unitType: 'DAY',
          startDate: '2026-10-15',
          endDate: '2026-10-15',
          calculatedDays: 1,
          reason: '私用のため',
        },
      }
    );
    assert.equal(submitRes.success, true);
    const appId = submitRes.data.id;

    // 5. 教頭承認
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const approve1 = WorkflowEngine.approveApplication(
      vicePrincipal,
      { applicationId: appId, expectedVersion: app.version, comment: '確認しました' }
    );
    assert.equal(approve1.success, true);

    // 6. 校長決裁
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const approve2 = WorkflowEngine.approveApplication(
      principal,
      { applicationId: appId, expectedVersion: app.version, comment: '承認します' }
    );
    assert.equal(approve2.success, true);

    // 7. 承認ステップのスナップショット検証
    const steps = db.prepare(`
      SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC
    `).all(appId) as any[];

    assert.equal(steps.length, 2);
    assert.equal(steps[0].action_user_stamp_name, '田中');
    assert.equal(steps[1].action_user_stamp_name, '鈴木');
  });

  it('NAME-002 [INV-016]: 承認者の改姓後も、過去の承認ステップに記録された当時の印影・氏名スナップショットが改変されないこと', () => {
    // 1. teacher1 による年休申請
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年次有給休暇の申請（過去履歴）',
      formData: {
        unitType: 'DAY',
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        calculatedDays: 1,
        reason: '通院のため',
      },
    });
    assert.equal(submitRes.success, true);
    const appId = submitRes.data.id;

    // 2. 教頭（田中 誠, 印影: 田中）による承認
    const appBefore = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(
      vicePrincipal,
      { applicationId: appId, expectedVersion: appBefore.version, comment: '確認' }
    );

    // 過去ステップの確認
    const stepBefore = db.prepare(`
      SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 1
    `).get(appId) as any;
    assert.equal(stepBefore.action_user_stamp_name, '田中');
    assert.equal(stepBefore.action_user_display_name, '田中 誠 (教頭B)');

    // 3. 教頭が改姓（田中 誠 -> 高橋 誠, 印影: 高橋）
    db.prepare(`
      UPDATE users
      SET display_name = '高橋 誠 (教頭B)', family_name = '高橋', given_name = '誠', stamp_name = '高橋'
      WHERE id = ?
    `).run(vicePrincipal.id);

    // 4. 改姓後も、過去の承認ステップスナップショットが「田中」のまま不変であることを検証
    const stepAfter = db.prepare(`
      SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 1
    `).get(appId) as any;
    assert.equal(stepAfter.action_user_stamp_name, '田中');
    assert.equal(stepAfter.action_user_display_name, '田中 誠 (教頭B)');

    // 5. 改姓後に新しい申請を承認した場合、新ステップには新印影「高橋」が記録されること
    const newSubmitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年次有給休暇の申請（改姓後承認）',
      formData: {
        unitType: 'DAY',
        startDate: '2026-11-04',
        endDate: '2026-11-04',
        calculatedDays: 1,
        reason: '私用',
      },
    });
    assert.equal(newSubmitRes.success, true);
    const newAppId = newSubmitRes.data.id;
    const newAppBefore = db.prepare('SELECT version FROM applications WHERE id = ?').get(newAppId) as any;

    WorkflowEngine.approveApplication(
      { ...vicePrincipal, displayName: '高橋 誠 (教頭B)' },
      { applicationId: newAppId, expectedVersion: newAppBefore.version, comment: '新姓で確認' }
    );

    const newStep = db.prepare(`
      SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 1
    `).get(newAppId) as any;
    assert.equal(newStep.action_user_stamp_name, '高橋');
    assert.equal(newStep.action_user_display_name, '高橋 誠 (教頭B)');
  });

  it('NAME-003 [INV-016]: 校長の改姓後も、過去に確定した月次出勤簿スナップショットの確定印影が改変されないこと', () => {
    // 1. 2026-08 月次出勤簿の校長確定（鈴木 校長）
    const snapId = SnapshotService.finalizeMonth(
      teacher1.id,
      '2026-08',
      {
        id: principal.id,
        username: principal.username,
        displayName: principal.displayName,
        stampName: '鈴木',
      },
      '8月度出勤簿確定'
    );
    assert.ok(snapId > 0);

    const snapshotBefore = db.prepare(`
      SELECT * FROM monthly_attendance_snapshots WHERE user_id = ? AND year_month = '2026-08'
    `).get(teacher1.id) as any;
    assert.equal(snapshotBefore.confirmed_user_stamp_name, '鈴木');
    assert.equal(snapshotBefore.confirmed_by_user_name, '鈴木 健一 (校長C)');

    // 2. 校長が改姓（鈴木 健一 -> 渡辺 健一, 印影: 渡辺）
    db.prepare(`
      UPDATE users
      SET display_name = '渡辺 健一 (校長C)', family_name = '渡辺', given_name = '健一', stamp_name = '渡辺'
      WHERE id = ?
    `).run(principal.id);

    // 3. 過去のスナップショットの確定印影が「鈴木」のまま完全保持されていることを検証
    const snapshotAfter = db.prepare(`
      SELECT * FROM monthly_attendance_snapshots WHERE user_id = ? AND year_month = '2026-08'
    `).get(teacher1.id) as any;
    assert.equal(snapshotAfter.confirmed_user_stamp_name, '鈴木');
    assert.equal(snapshotAfter.confirmed_by_user_name, '鈴木 健一 (校長C)');

    // 4. 改姓後に 2026-09 を月次確定した場合は新印影「渡辺」が記録されること
    const newSnapId = SnapshotService.finalizeMonth(
      teacher1.id,
      '2026-09',
      {
        id: principal.id,
        username: principal.username,
        displayName: '渡辺 健一 (校長C)',
        stampName: '渡辺',
      },
      '9月度出勤簿確定'
    );
    assert.ok(newSnapId > 0);

    const newSnapshot = db.prepare(`
      SELECT * FROM monthly_attendance_snapshots WHERE user_id = ? AND year_month = '2026-09'
    `).get(teacher1.id) as any;
    assert.equal(newSnapshot.confirmed_user_stamp_name, '渡辺');
    assert.equal(newSnapshot.confirmed_by_user_name, '渡辺 健一 (校長C)');
  });
});

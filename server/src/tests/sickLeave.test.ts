import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../db/database';
import { migrator } from '../db/migrations';
import { SickLeaveService } from '../services/sickLeaveService';
import { SickLeavePolicyService } from '../services/sickLeavePolicyService';

describe('病気休暇（山口県勤務条例第13条）包括検証テストスイート', () => {
  before(() => {
    // マイグレーションの実行
    const db = getDb();
    migrator.runMigrations(db);
  });

  const mockTeacher = {
    id: 1,
    username: 'yamada_taro',
    displayName: '山田太郎',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1'
  };

  const mockPrincipal = {
    id: 2,
    username: 'suzuki_kocho',
    displayName: '鈴木校長',
    roles: ['PRINCIPAL'],
    ipAddress: '127.0.0.1'
  };

  const mockOffice = {
    id: 3,
    username: 'sato_jimu',
    displayName: '佐藤事務',
    roles: ['OFFICE'],
    ipAddress: '127.0.0.1'
  };

  it('1. 正常系: 休憩時間を挟む時間病休の正味分数算出 (11:00〜14:00, 休憩12:00〜12:45 -> 135分)', () => {
    const res = SickLeaveService.applySickLeave(mockTeacher, {
      targetDate: '2026-05-11', // 月曜日
      durationType: 'TIME',
      startAt: '11:00',
      endAt: '14:00',
      reason: '通院療養'
    });

    // 11:00-12:00 (60分) + 12:45-14:00 (75分) = 135分
    assert.strictEqual(res.calculatedMinutes, 135);
  });

  it('2. Fail-Closed: 正式Display Policy未登録状態での承認決裁停止', () => {
    const db = getDb();
    // 未登録または __POLICY_REQUIRED__ の状態
    db.prepare('DELETE FROM attendance_display_policies WHERE policy_id = ?').run('DEFAULT_MUNICIPALITY');

    const app = SickLeaveService.applySickLeave(mockTeacher, {
      targetDate: '2026-05-12',
      durationType: 'FULL_DAY',
      reason: '感冒療養'
    });

    assert.throws(
      () => {
        SickLeaveService.approveSickLeave(mockPrincipal, app.id);
      },
      (err: any) => {
        return err.message.includes('出勤簿表示Policy未定義のため確定できません');
      }
    );
  });

  it('3. 正常系 & Idempotency: 正式Policy登録後の承認・出勤簿確定 ＆ 重複実行安全性', () => {
    const db = getDb();
    // テスト用Display Policyの登録
    const testPolicyRules = {
      SICK_LEAVE: {
        FULL_DAY: {
          NONE: { displayText: '病休_TEST', code: 'SL_FULL' },
          PUBLIC_DUTY_RECOGNIZED: { displayText: '公病休_TEST', code: 'SL_PUB_FULL' }
        },
        TIME: {
          NONE: { template: '病休_TEST({hours}h)', unit: 'HOURLY_CEIL' },
          PUBLIC_DUTY_RECOGNIZED: { template: '公病休_TEST({hours}h)', unit: 'HOURLY_CEIL' }
        }
      }
    };

    db.prepare(`
      INSERT OR REPLACE INTO attendance_display_policies (
        policy_id, policy_version, effective_from, effective_to, rules_json
      ) VALUES ('DEFAULT_MUNICIPALITY', '2026.1', '2026-04-01', '9999-12-31', ?)
    `).run(JSON.stringify(testPolicyRules));

    const app = SickLeaveService.applySickLeave(mockTeacher, {
      targetDate: '2026-05-13',
      durationType: 'FULL_DAY',
      reason: '発熱療養'
    });

    // 1回目の承認
    const res1 = SickLeaveService.approveSickLeave(mockPrincipal, app.id);
    assert.strictEqual(res1.displayText, '病休_TEST');

    // 2回目の承認（Idempotency検証: レコード重複なく成功）
    const res2 = SickLeaveService.approveSickLeave(mockPrincipal, app.id);
    assert.strictEqual(res2.displayText, '病休_TEST');

    const records = db.prepare('SELECT * FROM attendance_records WHERE user_id = ? AND target_date = ?').all(mockTeacher.id, '2026-05-13');
    assert.strictEqual(records.length, 1);
  });

  it('4. 状態遷移 & 後日再評価: 通常病休承認 ➔ 後日公務災害認定 ➔ 決定論的再評価', () => {
    const db = getDb();
    const app = SickLeaveService.applySickLeave(mockTeacher, {
      targetDate: '2026-05-14',
      durationType: 'FULL_DAY',
      reason: '公務負傷（申請中）'
    });

    // 1. 通常病休として承認
    SickLeaveService.approveSickLeave(mockPrincipal, app.id);

    const beforeRecord = db.prepare('SELECT * FROM attendance_records WHERE user_id = ? AND target_date = ?').get(mockTeacher.id, '2026-05-14') as any;
    assert.strictEqual(beforeRecord.display_text, '病休_TEST');

    // 2. 後日、公務災害が認定
    const resUpdate = SickLeaveService.updateDisasterRecognition(mockOffice, {
      sickLeaveId: app.id,
      newStatus: 'PUBLIC_DUTY_RECOGNIZED',
      authority: '地方公務員災害補償基金山口県支部',
      reference: '令8地公災第123号'
    });

    assert.strictEqual(resUpdate.reevaluated, true);
    assert.strictEqual(resUpdate.displayText, '公病休_TEST');

    // 3. 申請状態と再評価状態の検証（applicationStatusはAPPROVEDを維持）
    const appRow = db.prepare('SELECT * FROM sick_leave_applications WHERE id = ?').get(app.id) as any;
    assert.strictEqual(appRow.application_status, 'APPROVED');
    assert.strictEqual(appRow.disaster_recognition_status, 'PUBLIC_DUTY_RECOGNIZED');
    assert.strictEqual(appRow.reevaluation_status, 'COMPLETED');

    const afterRecord = db.prepare('SELECT * FROM attendance_records WHERE user_id = ? AND target_date = ?').get(mockTeacher.id, '2026-05-14') as any;
    assert.strictEqual(afterRecord.display_text, '公病休_TEST');
  });

  it('5. プライバシー防衛: 診断書・医療情報の物理的分離と出勤簿への非流出', () => {
    const db = getDb();
    const app = SickLeaveService.applySickLeave(mockTeacher, {
      targetDate: '2026-05-15',
      durationType: 'FULL_DAY',
      reason: '機微な傷病名・診断内容',
      evidenceRequired: true
    });

    // 診断書レコードの登録（物理分離）
    const medId = `MED_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO medical_evidence_records (
        id, sick_leave_id, file_storage_path, mime_type, retention_limit_date
      ) VALUES (?, ?, '/secure/storage/med_001.pdf', 'application/pdf', '2031-05-15')
    `).run(medId, app.id);

    // 承認
    SickLeaveService.approveSickLeave(mockPrincipal, app.id);

    // 出勤簿テーブルに診断書パスや理由が含まれていないことを検証
    const record = db.prepare('SELECT * FROM attendance_records WHERE user_id = ? AND target_date = ?').get(mockTeacher.id, '2026-05-15') as any;
    assert.strictEqual(record.display_text, '病休_TEST');
    assert.strictEqual(record.file_storage_path, undefined);
  });
});

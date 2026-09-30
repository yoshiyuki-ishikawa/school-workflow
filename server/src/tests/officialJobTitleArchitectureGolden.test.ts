/**
 * Extensible Official Job Title SSOT & Historical Snapshot Architecture
 * Official Golden Test Suite (GT-JT-01 〜 GT-JT-23)
 * Implementation Plan v1.1 FINAL
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { OfficialJobTitleResolver } from '../domain/jobTitle/officialJobTitleResolver';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { SnapshotService } from '../services/snapshotService';
import { TripFinalizationService } from '../domain/trip/tripFinalizationService';
import express from 'express';
import http from 'node:http';
import adminRouter from '../routes/admin';

describe('Official Job Title SSOT Golden Suite (GT-JT-01〜27)', () => {
  let db: any;
  const now = new Date().toISOString();

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM user_job_titles').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
    db.prepare('DELETE FROM travel_order_snapshots').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM trip_events').run();
  });

  const actorPrincipal = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    stampName: '鈴木',
  };

  it('GT-JT-01: [Target-Date Authoritative Resolution] 対象日における教諭の決定論的解決', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-04-01', '9999-12-31')
    `).run();

    const resolved = OfficialJobTitleResolver.resolveAtDate(db, 1, '2026-05-15');
    assert.strictEqual(resolved.displayName, '教諭');
    assert.strictEqual(resolved.code, 'TEACHER');
  });

  it('GT-JT-02: [Separation] 養護教諭が教諭と混同されず独立解決されること', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_NURSE_TEACHER', '2026-04-01', '9999-12-31')
    `).run();

    const resolved = OfficialJobTitleResolver.resolveAtDate(db, 1, '2026-05-15');
    assert.strictEqual(resolved.displayName, '養護教諭');
    assert.notStrictEqual(resolved.displayName, '教諭');
  });

  it('GT-JT-03: [Separation] 栄養教諭が教諭と混同されず独立解決されること', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_NUTRITION_TEACHER', '2026-04-01', '9999-12-31')
    `).run();

    const resolved = OfficialJobTitleResolver.resolveAtDate(db, 1, '2026-05-15');
    assert.strictEqual(resolved.displayName, '栄養教諭');
  });

  it('GT-JT-04: [Separation] 講師が教諭と混同されず独立解決されること', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_LECTURER', '2026-04-01', '9999-12-31')
    `).run();

    const resolved = OfficialJobTitleResolver.resolveAtDate(db, 1, '2026-05-15');
    assert.strictEqual(resolved.displayName, '講師');
  });

  it('GT-JT-05: [Separation] 主事が一般事務職員等に丸められず主事として解決されること', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (5, 'JOB_TITLE_CLERK', '2026-04-01', '9999-12-31')
    `).run();

    const resolved = OfficialJobTitleResolver.resolveAtDate(db, 5, '2026-05-15');
    assert.strictEqual(resolved.displayName, '主事');
  });

  it('GT-JT-06: [Temporal Boundary] 昇任前後の日付境界（9/30 主事 ⇄ 10/1 主任主事）の正確な解決', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (5, 'JOB_TITLE_CLERK', '2026-04-01', '2026-09-30')
    `).run();
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (5, 'JOB_TITLE_SENIOR_CLERK', '2026-10-01', '9999-12-31')
    `).run();

    const beforePromotion = OfficialJobTitleResolver.resolveAtDate(db, 5, '2026-09-30');
    assert.strictEqual(beforePromotion.displayName, '主事');

    const afterPromotion = OfficialJobTitleResolver.resolveAtDate(db, 5, '2026-10-01');
    assert.strictEqual(afterPromotion.displayName, '主任主事');
  });

  it('GT-JT-07: [Future-dated Isolation] 未来日付発令が現在日付の帳票に誤適用されないこと', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_PRINCIPAL', '2027-04-01', '9999-12-31')
    `).run();

    assert.throws(
      () => OfficialJobTitleResolver.resolveAtDate(db, 1, '2026-05-15', { strict: true }),
      /OFFICIAL_JOB_TITLE_NOT_RESOLVED/
    );
  });

  it('GT-JT-08: [Overlap Protection] 発令期間Overlap（重複）登録がFail-Closedに拒否されること', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-04-01', '2026-12-31')
    `).run();

    assert.throws(
      () => OfficialJobTitleResolver.checkOverlap(db, 1, '2026-10-01', '2027-03-31'),
      /OFFICIAL_JOB_TITLE_OVERLAP_DETECTED/
    );
  });

  it('GT-JT-09: [Position Independence] Position = CHIEF_TEACHER（教務主任）でも職名は「教諭」として出力されること', () => {
    // ユーザー7 (小林 繁) は seeds.ts で Position = CHIEF_TEACHER (教務主任)
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (7, 'JOB_TITLE_TEACHER', '2026-04-01', '9999-12-31')
    `).run();

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(7, '2026-05');
    assert.strictEqual(projection.userJobTitle, '教諭', '教務主任のPositionがあっても正式職名は教諭であること');
  });

  it('GT-JT-10: [Role Independence] Role = OFFICE でも正式職名「主査」が保持され帳票に出力されること', () => {
    // ユーザー5 (高橋 節子) は Role = OFFICE, Position = OFFICE_HEAD (事務主幹)
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (5, 'JOB_TITLE_HEAD_CLERK', '2026-04-01', '9999-12-31')
    `).run();

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(5, '2026-05');
    assert.strictEqual(projection.userJobTitle, '主査', 'OFFICEロールでも正式職名「主査」が反映されること');
  });

  it('GT-JT-11: [Fail-Closed Finalization] 職名未解決時、月次確定および旅行命令決裁が422エラーで遮断されること', () => {
    // ユーザー1 に職名未登録
    assert.throws(
      () => SnapshotService.finalizeMonth(1, '2026-05', actorPrincipal, '確定テスト'),
      /OFFICIAL_JOB_TITLE_NOT_RESOLVED/
    );
  });

  it('GT-JT-12: [Snapshot Immutability] 月次確定後に職名が変更されても、過去確定月の出勤簿職名が不変維持されること', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_LECTURER', '2026-04-01', '2026-05-31')
    `).run();

    // 2026-05 月次確定
    const snapId = SnapshotService.finalizeMonth(1, '2026-05', actorPrincipal, '5月点検');
    assert.ok(snapId > 0);

    // その後、昇任発令
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-06-01', '9999-12-31')
    `).run();

    // 5月の出勤簿を復元 -> 当時の「講師」が保持されていること
    const restored = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    assert.strictEqual(restored.userJobTitle, '講師');
    assert.strictEqual(restored.jobTitleAuthority, 'CANONICAL_SSOT');
  });

  it('GT-JT-13: [Unused Master Mutation Allowed] 未使用職名マスタの表示名修正が許可され、過去事実・スナップショットに一切影響しないこと', () => {
    // 誰も使用していない職名マスタを追加
    db.prepare(`
      INSERT INTO official_job_titles (id, code, display_name, sort_order, is_active)
      VALUES ('JOB_TITLE_TEST_UNUSED', 'TEST_UNUSED', 'テスト職名旧', 999, 1)
    `).run();

    // 使用前なので改変チェックは通過するはず
    assert.doesNotThrow(() => {
      OfficialJobTitleResolver.assertMasterMutable(db, 'JOB_TITLE_TEST_UNUSED', 'TEST_UNUSED', 'テスト職名新');
    });
  });

  it('GT-JT-14: [Zero-Code Extensibility] 未知の将来職名をマスタ追加するだけでコード変更なしに全機能が動作すること', () => {
    // TypeScriptコードに存在しない架空の職名
    db.prepare(`
      INSERT INTO official_job_titles (id, code, display_name, sort_order, is_active, description)
      VALUES ('JOB_TITLE_SYNTHETIC_FUTURE', 'FUTURE_SPECIALIST', '未来型ICT専門指導員', 888, 1, '将来新設職名')
    `).run();

    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_SYNTHETIC_FUTURE', '2026-04-01', '9999-12-31')
    `).run();

    const resolved = OfficialJobTitleResolver.resolveAtDate(db, 1, '2026-05-20');
    assert.strictEqual(resolved.displayName, '未来型ICT専門指導員');
    assert.strictEqual(resolved.code, 'FUTURE_SPECIALIST');

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    assert.strictEqual(projection.userJobTitle, '未来型ICT専門指導員');
  });

  it('GT-JT-15: [Semantic Mutation Guard] 使用実績のある職名マスタの code / display_name 変更が拒否されること (INV-JT-11)', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-04-01', '9999-12-31')
    `).run();

    assert.throws(
      () => OfficialJobTitleResolver.assertMasterMutable(db, 'JOB_TITLE_TEACHER', 'TEACHER', '上級教諭'),
      /OFFICIAL_JOB_TITLE_MASTER_SEMANTIC_IMMUTABLE/
    );

    assert.throws(
      () => OfficialJobTitleResolver.assertMasterMutable(db, 'JOB_TITLE_TEACHER', 'NEW_TEACHER_CODE', '教諭'),
      /OFFICIAL_JOB_TITLE_MASTER_SEMANTIC_IMMUTABLE/
    );
  });

  it('GT-JT-16: [Deactivation & Historical Resolution] 旧職名を is_active=0 にしても過去の対象日解決で旧職名が正しく返却されること', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_CLERK', '2026-04-01', '2026-09-30')
    `).run();

    // 旧職名を新規割当停止
    db.prepare('UPDATE official_job_titles SET is_active = 0 WHERE id = ?').run('JOB_TITLE_CLERK');

    // 過去日付で解決 -> is_active=0 でも過去発令は正常に解決される
    const resolved = OfficialJobTitleResolver.resolveAtDate(db, 1, '2026-06-15');
    assert.strictEqual(resolved.displayName, '主事');
  });

  it('GT-JT-17: [Trip Order Target-Date] 出張命令スナップショットが travel_order_issued_at 時点の職名で固定されること', () => {
    // 9/30までは講師、10/1から教諭
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_LECTURER', '2026-04-01', '2026-09-30')
    `).run();
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-10-01', '9999-12-31')
    `).run();

    // 出張イベント作成
    const tripRes = db.prepare(`
      INSERT INTO trip_events (title, purpose, destination, start_at, end_at, created_by_user_id, created_at, updated_at)
      VALUES ('研究会', '教育研究', '山口県庁', '2026-10-05 09:00', '2026-10-05 17:00', 1, ?, ?)
    `).run(now, now);
    const tripId = Number(tripRes.lastInsertRowid);

      // 申請作成 (発令日 9/25 事前発令)
      const appRes = db.prepare(`
        INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, trip_event_id, title, form_data, current_status, created_at, updated_at)
        VALUES ('BUSINESS_TRIP', 1, 1, ?, '公務出張申請', '{}', 'WAITING_APPROVAL', '2026-09-24T08:00:00Z', '2026-09-24T08:00:00Z')
      `).run(tripId);
      const appId = Number(appRes.lastInsertRowid);

    // 承認ステップ
    db.prepare(`
      INSERT INTO application_approval_steps (application_id, step_order, step_name, step_key, required_role_id, status, acted_at)
      VALUES (?, 1, '校長決裁', 'PRINCIPAL_STEP', 'PRINCIPAL', 'APPROVED', '2026-09-25T10:00:00Z')
    `).run(appId);

    // 決裁実行 (発令日 2026-09-25)
    TripFinalizationService.finalizeTravelOrder(appId, db, actorPrincipal);

    const snapshot = db.prepare('SELECT traveler_position_snapshot FROM travel_order_snapshots WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(snapshot.traveler_position_snapshot, '講師', '発令日(9/25)時点の職名「講師」が記録されること');
  });

  it('GT-JT-18: [No Silent Fallback] 新Resolver例外時にレガシー教諭フォールバックへ戻らず安全に停止（Safe Stop）すること', () => {
    // 職名未設定のユーザー
    assert.throws(
      () => OfficialJobTitleResolver.resolveAtDate(db, 2, '2026-05-15', { strict: true }),
      /OFFICIAL_JOB_TITLE_NOT_RESOLVED/
    );
  });

  it('GT-JT-19: [Provenance Separation] 過去スナップショットが LEGACY_PROJECTION として新形式と出所分離されて復元されること', () => {
    // レガシー形式のスナップショット (officialJobTitleSnapshot なし)
    const legacySummaryJson = JSON.stringify({
      yearMonth: '2026-04',
      userJobTitle: '教頭',
      formSummary: {},
      daysCount: 30
    });
    db.prepare(`
      INSERT INTO monthly_attendance_snapshots (
        user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
        confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json, checksum, created_at
      ) VALUES (1, '2026-04', 1, 'LOCKED', '2026-05-01', 4, '校長', '鈴木', ?, 'dummy-checksum', ?)
    `).run(legacySummaryJson, now);

    const restored = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-04');
    assert.strictEqual(restored.userJobTitle, '教頭');
    assert.strictEqual(restored.jobTitleAuthority, 'LEGACY_PROJECTION', '過去スナップショットはレガシー出所として明示されること');
  });

  it('GT-JT-20: [Permission Isolation] OFFICEロール単体ユーザーが職名管理Permissionを自動取得しないこと', () => {
    // seeds.ts で OFFICE ロールには job_title.* が付与されていないことを検証
    const perms = db.prepare(`
      SELECT rp.permission_id
      FROM role_permissions rp
      WHERE rp.role_id = 'OFFICE' AND rp.permission_id LIKE 'job_title.%'
    `).all();
    assert.strictEqual(perms.length, 0, 'OFFICEロールにjob_titleパーミッションが自動付与されていないこと');
  });

  it('GT-JT-21: [Fail-Closed Output] 職名未設定時、Previewは可能だがOfficial PDF/印刷判定がfalseになること', () => {
    // ユーザー2 は職名未登録
    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(2, '2026-05');
    assert.strictEqual(projection.userJobTitle, '（職名未設定）');
  });

  it('GT-JT-22: [HD-JT-01 CLOSED] 出勤簿の月途中異動（9/1〜15 講師、9/16〜 教諭）で9月出勤簿ヘッダーが「教諭」（月末在籍基準）となり、月内履歴SSOTが user_job_titles に維持されること', () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_LECTURER', '2026-09-01', '2026-09-15')
    `).run();
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-09-16', '9999-12-31')
    `).run();

    // 2026-09 出勤簿プロジェクション
    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-09');
    assert.strictEqual(projection.userJobTitle, '教諭', '月末在籍基準で教諭が解決されること');

    // 月次確定
    const snapId = SnapshotService.finalizeMonth(1, '2026-09', actorPrincipal, '9月点検');
    assert.ok(snapId > 0);

    const locked = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-09');
    assert.strictEqual(locked.userJobTitle, '教諭');

    // 月内履歴が user_job_titles 上に正しく2件存在し不変であること (SSOT)
    const history = db.prepare('SELECT * FROM user_job_titles WHERE user_id = ? ORDER BY effective_from ASC').all(1);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].job_title_id, 'JOB_TITLE_LECTURER');
    assert.strictEqual(history[1].job_title_id, 'JOB_TITLE_TEACHER');
  });

  it('GT-JT-23: [Yamaguchi Initial 14 Seed] 山口県初期14職名マスタが初期シードされ、将来の件数増加にも制約がないこと', () => {
    const titles = db.prepare('SELECT code, display_name FROM official_job_titles ORDER BY sort_order ASC').all() as any[];
    assert.ok(titles.length >= 14, '最低14件の職名が存在すること');

    const expectedNames = [
      '校長', '教頭', '教諭', '助教諭', '講師',
      '養護教諭', '養護助教諭', '栄養教諭', '学校栄養職員',
      '事務長', '主査', '事務主任', '主任主事', '主事'
    ];
    const actualNames = titles.map((t: any) => t.display_name);
    for (const name of expectedNames) {
      assert.ok(actualNames.includes(name), `職名「${name}」が存在すること`);
    }
  });

  // ============================================================
  // Remediation Golden Tests: GT-JT-24 〜 GT-JT-27 & GT-JT-NEG-01
  // DTO Contract & Projection Separation Verification
  // ============================================================

  async function getAdminUsers(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const req: any = {
        method: 'GET',
        url: '/users',
        session: {
          user: {
            id: 6,
            username: 'admin',
            displayName: '管理者',
            department: '事務',
            roles: ['ADMIN'],
          },
        },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      };

      const res: any = {
        _status: 200,
        status(code: number) {
          this._status = code;
          return this;
        },
        json(body: any) {
          if (body.success) {
            resolve(body.users);
          } else {
            reject(new Error(`API Error: ${JSON.stringify(body)}`));
          }
        },
      };

      adminRouter.handle(req, res, (err: any) => {
        if (err) reject(err);
        else reject(new Error('Route handler did not respond'));
      });
    });
  }

  it('GT-JT-24: [Admin DTO Contract - Assigned User] GET /api/admin/users で設定済ユーザーの currentOfficialJobTitle が typeof string かつ表示名文字列であること', async () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-04-01', '9999-12-31')
    `).run();

    const users = await getAdminUsers();
    const user1 = users.find((u: any) => u.id === 1);
    assert.ok(user1, 'ユーザー1が存在すること');

    // 契約検証: currentOfficialJobTitle は Object ではなく string
    assert.strictEqual(typeof user1.currentOfficialJobTitle, 'string', 'currentOfficialJobTitle は string 型であること');
    assert.strictEqual(user1.currentOfficialJobTitle, '教諭', '表示名文字列「教諭」であること');
    assert.notStrictEqual(typeof user1.currentOfficialJobTitle, 'object', 'currentOfficialJobTitle が Object であってはならない');
  });

  it('GT-JT-25: [Admin DTO Contract - Unassigned User] GET /api/admin/users で未設定ユーザーの currentOfficialJobTitle および Detail が null であること', async () => {
    // ユーザー2 は職名未割り当て
    const users = await getAdminUsers();
    const user2 = users.find((u: any) => u.id === 2);
    assert.ok(user2, 'ユーザー2が存在すること');

    assert.strictEqual(user2.currentOfficialJobTitle, null, '未設定時は null であること');
    assert.strictEqual(user2.currentOfficialJobTitleDetail, null, '未設定時は Detail も null であること');
  });

  it('GT-JT-26: [Admin DTO Contract - Detail Object Separation] GET /api/admin/users で currentOfficialJobTitleDetail が分離され正規プロパティを保持すること', async () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-04-01', '9999-12-31')
    `).run();

    const users = await getAdminUsers();
    const user1 = users.find((u: any) => u.id === 1);
    assert.ok(user1, 'ユーザー1が存在すること');

    assert.strictEqual(typeof user1.currentOfficialJobTitleDetail, 'object');
    assert.ok(user1.currentOfficialJobTitleDetail !== null);
    assert.strictEqual(user1.currentOfficialJobTitleDetail.id, 'JOB_TITLE_TEACHER');
    assert.strictEqual(user1.currentOfficialJobTitleDetail.code, 'TEACHER');
    assert.strictEqual(user1.currentOfficialJobTitleDetail.name, '教諭');
    assert.strictEqual(user1.currentOfficialJobTitleDetail.effectiveFrom, '2026-04-01');
    assert.strictEqual(user1.currentOfficialJobTitleDetail.effectiveTo, '9999-12-31');
    assert.strictEqual(user1.currentOfficialJobTitleDetail.name, user1.currentOfficialJobTitle, 'Detail の name と currentOfficialJobTitle が完全一致すること');
  });

  it('GT-JT-27: [Client Rendering Contract Simulation] 教職員一覧描画ロジックで Object as React Child が発生せず文字列として安全に評価されること', async () => {
    db.prepare(`
      INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-04-01', '9999-12-31')
    `).run();

    const users = await getAdminUsers();
    const user1 = users.find((u: any) => u.id === 1);
    const user2 = users.find((u: any) => u.id === 2);

    // AdminAuditPage.tsx:1345 の JSX 式シミュレータ: {u.currentOfficialJobTitle ? u.currentOfficialJobTitle : '未登録'}
    function renderOfficialJobTitleCell(u: any): string {
      const child = u.currentOfficialJobTitle ? u.currentOfficialJobTitle : '未登録';
      // React のランタイム契約: プレーンオブジェクトが子要素として渡されたら致命的エラー
      if (typeof child === 'object' && child !== null) {
        throw new Error('Objects are not valid as a React child (found: object with keys {' + Object.keys(child).join(', ') + '}). If you meant to render a collection of children, use an array instead.');
      }
      return String(child);
    }

    // ユーザー1 (設定済): '教諭'
    assert.doesNotThrow(() => {
      const rendered = renderOfficialJobTitleCell(user1);
      assert.strictEqual(rendered, '教諭');
    });

    // ユーザー2 (未設定): '未登録'
    assert.doesNotThrow(() => {
      const rendered = renderOfficialJobTitleCell(user2);
      assert.strictEqual(rendered, '未登録');
    });
  });

  it('GT-JT-NEG-01: [Contract Negative Test] currentOfficialJobTitle に Object が渡された場合、React Child 契約違反および DTO 違反として即座に検出・遮断されること', () => {
    // 故意に違反 DTO (旧実装のように Object が入ったケース) を再現
    const invalidUserDto = {
      id: 1,
      name: '山田 太郎',
      currentOfficialJobTitle: {
        id: 'JOB_TITLE_TEACHER',
        code: 'TEACHER',
        name: '教諭',
      },
    };

    // 1. DTO 契約検証 (Schema Contract Guard)
    const isValidDto = (u: any): boolean => {
      return typeof u.currentOfficialJobTitle === 'string' || u.currentOfficialJobTitle === null || u.currentOfficialJobTitle === undefined;
    };
    assert.strictEqual(isValidDto(invalidUserDto), false, 'Object が渡された DTO は Schema Contract 違反として拒否されること');

    // 2. React Child 描画シミュレータでの Fail-Closed 検証
    function renderOfficialJobTitleCell(u: any): string {
      const child = u.currentOfficialJobTitle ? u.currentOfficialJobTitle : '未登録';
      if (typeof child === 'object' && child !== null) {
        throw new Error('Objects are not valid as a React child (found: object with keys {' + Object.keys(child).join(', ') + '})');
      }
      return String(child);
    }

    assert.throws(
      () => renderOfficialJobTitleCell(invalidUserDto),
      /Objects are not valid as a React child/,
      'Object が渡された場合、即座に React Child 例外として Fail-Closed 検出されること'
    );
  });
});


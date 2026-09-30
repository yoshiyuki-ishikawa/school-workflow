import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db/database';
import { seedDatabase } from '../db/seeds';
import { ApplicationEligibilityResolver } from '../services/applicationEligibilityResolver';
import { EntryCategoryRegistry } from '../services/schema/entryCategoryRegistry';

describe('New Application Entry Architecture & Authorization Capability Golden Tests (GT-NAE-* & GT-AUTH-*)', () => {
  beforeEach(() => {
    seedDatabase();
  });

  // =========================================================================
  // 1. HD-NAE-04 Canonical Role -> Permission Assignment Golden Tests
  // =========================================================================
  describe('HD-NAE-04: Role Permission Assignment Tests', () => {
    it('GT-AUTH-HD04-01: TEACHER に application.create.self が付与されること', () => {
      const perms = ApplicationEligibilityResolver.resolveUserPermissions(['TEACHER']);
      assert.strictEqual(perms.has('application.create.self'), true);
    });

    it('GT-AUTH-HD04-02: TEACHER に application.create.proxy が付与されないこと', () => {
      const perms = ApplicationEligibilityResolver.resolveUserPermissions(['TEACHER']);
      assert.strictEqual(perms.has('application.create.proxy'), false);
    });

    it('GT-AUTH-HD04-03: TEACHER に application.create.batch が付与されないこと', () => {
      const perms = ApplicationEligibilityResolver.resolveUserPermissions(['TEACHER']);
      assert.strictEqual(perms.has('application.create.batch'), false);
    });

    it('GT-AUTH-HD04-04: OFFICE に self / proxy / batch が付与されること', () => {
      const perms = ApplicationEligibilityResolver.resolveUserPermissions(['OFFICE']);
      assert.strictEqual(perms.has('application.create.self'), true);
      assert.strictEqual(perms.has('application.create.proxy'), true);
      assert.strictEqual(perms.has('application.create.batch'), true);
    });

    it('GT-AUTH-HD04-05: VICE_PRINCIPAL に self / proxy / batch が付与されること', () => {
      const perms = ApplicationEligibilityResolver.resolveUserPermissions(['VICE_PRINCIPAL']);
      assert.strictEqual(perms.has('application.create.self'), true);
      assert.strictEqual(perms.has('application.create.proxy'), true);
      assert.strictEqual(perms.has('application.create.batch'), true);
    });

    it('GT-AUTH-HD04-06: PRINCIPAL に self / proxy / batch が付与されること', () => {
      const perms = ApplicationEligibilityResolver.resolveUserPermissions(['PRINCIPAL']);
      assert.strictEqual(perms.has('application.create.self'), true);
      assert.strictEqual(perms.has('application.create.proxy'), true);
      assert.strictEqual(perms.has('application.create.batch'), true);
    });

    it('GT-AUTH-HD04-07: ADMIN に application.create.* が一切付与されないこと (Fail-Closed)', () => {
      const perms = ApplicationEligibilityResolver.resolveUserPermissions(['ADMIN']);
      assert.strictEqual(perms.has('application.create.self'), false);
      assert.strictEqual(perms.has('application.create.proxy'), false);
      assert.strictEqual(perms.has('application.create.batch'), false);
    });

    it('GT-AUTH-HD04-08: system.manage を持つだけでは Application Initiation Capability が成立しないこと', () => {
      const perms = ApplicationEligibilityResolver.resolveUserPermissions(['ADMIN']);
      // system.manage は持つが application.create.* は持たない
      assert.strictEqual(perms.has('system.manage'), true);
      const evalResult = ApplicationEligibilityResolver.evaluateEligibility({
        actor: { id: 6, username: 'admin', roles: ['ADMIN'], isActive: true },
        initiationMode: 'SELF',
        applicationTypeId: 'LEAVE_ANNUAL',
      });
      assert.strictEqual(evalResult.isEligible, false);
      assert.strictEqual(evalResult.httpStatus, 403);
      assert.strictEqual(evalResult.errorCode, 'APPLICATION_NOT_ELIGIBLE');
    });

    it('GT-AUTH-HD04-09: Role 名を直接判定しなくても、Canonical role_permissions Resolution から同じ Permission 結果が得られること', () => {
      const db = getDb();
      const directRoleQuery = db.prepare('SELECT permission_id FROM role_permissions WHERE role_id = ?').all('TEACHER') as { permission_id: string }[];
      const resolved = ApplicationEligibilityResolver.resolveUserPermissions(['TEACHER']);
      assert.strictEqual(resolved.size, directRoleQuery.length);
      for (const row of directRoleQuery) {
        assert.strictEqual(resolved.has(row.permission_id), true);
      }
    });

    it('GT-AUTH-HD04-10: application.create.proxy を持っていても Proxy 非対応/無効な対象（自己代理）は起案できないこと', () => {
      const evalResult = ApplicationEligibilityResolver.evaluateEligibility({
        actor: { id: 3, username: 'vice_principal', roles: ['VICE_PRINCIPAL'], isActive: true },
        initiationMode: 'PROXY',
        applicationTypeId: 'LEAVE_ANNUAL',
        subjectUserId: 3, // 自己代理
      });
      assert.strictEqual(evalResult.isEligible, false);
      assert.strictEqual(evalResult.httpStatus, 400);
      assert.strictEqual(evalResult.errorCode, 'INVALID_PROXY_TARGET');
    });

    it('GT-AUTH-HD04-11: application.create.batch を持っていても Batch 非対応 Application Type は一括起案できないこと', () => {
      const evalResult = ApplicationEligibilityResolver.evaluateEligibility({
        actor: { id: 3, username: 'vice_principal', roles: ['VICE_PRINCIPAL'], isActive: true },
        initiationMode: 'BATCH',
        applicationTypeId: 'LEAVE_ANNUAL', // 出張以外の一括起案試行
        participantUserIds: [1, 2],
      });
      assert.strictEqual(evalResult.isEligible, false);
      assert.strictEqual(evalResult.httpStatus, 400);
      assert.strictEqual(evalResult.errorCode, 'INVALID_APPLICATION_TYPE');
    });
  });

  // =========================================================================
  // 2. Dedicated Authorization & Security Tests (GT-AUTH-01〜05)
  // =========================================================================
  describe('Authorization & Security Guard Tests (GT-AUTH-*)', () => {
    it('GT-AUTH-01: Role 名の文字列判定ではなく、application.create.proxy Permission に基づいて代理起案が認可されること', () => {
      const teacherUser = dbUser('teacher1');
      const officeUser = dbUser('office');

      const teacherProxy = ApplicationEligibilityResolver.evaluateEligibility({
        actor: { id: teacherUser.id, username: teacherUser.username, roles: ['TEACHER'], isActive: true },
        initiationMode: 'PROXY',
        applicationTypeId: 'LEAVE_ANNUAL',
        subjectUserId: teacherUser.id + 1,
      });
      assert.strictEqual(teacherProxy.isEligible, false);
      assert.strictEqual(teacherProxy.httpStatus, 403);

      const officeProxy = ApplicationEligibilityResolver.evaluateEligibility({
        actor: { id: officeUser.id, username: officeUser.username, roles: ['OFFICE'], isActive: true },
        initiationMode: 'PROXY',
        applicationTypeId: 'LEAVE_ANNUAL',
        subjectUserId: teacherUser.id,
      });
      assert.strictEqual(officeProxy.isEligible, true);
    });

    it('GT-AUTH-02: application.create.proxy を持たない教員が代理起案を実行した場合、403 APPLICATION_NOT_ELIGIBLE で拒絶されること', () => {
      const teacher = dbUser('teacher1');
      assert.throws(
        () => {
          ApplicationEligibilityResolver.assertEligible({
            actor: { id: teacher.id, username: teacher.username, roles: ['TEACHER'], isActive: true },
            initiationMode: 'PROXY',
            applicationTypeId: 'LEAVE_ANNUAL',
            subjectUserId: 2,
          });
        },
        (err: any) => err.statusCode === 403 && err.code === 'APPLICATION_NOT_ELIGIBLE'
      );
    });

    it('GT-AUTH-03: application.create.self を持たない無効ユーザーの本人起案が拒絶されること', () => {
      const evalResult = ApplicationEligibilityResolver.evaluateEligibility({
        actor: { id: 1, username: 'inactive_teacher', roles: ['TEACHER'], isActive: false },
        initiationMode: 'SELF',
        applicationTypeId: 'LEAVE_ANNUAL',
      });
      assert.strictEqual(evalResult.isEligible, false);
      assert.strictEqual(evalResult.httpStatus, 403);
      assert.strictEqual(evalResult.errorCode, 'APPLICATION_NOT_ELIGIBLE');
    });

    it('GT-AUTH-04: isActive === true であっても、退役済み種別（LEAVE_LARGE_SCHOOL）は 403 APPLICATION_TYPE_RETIRED で拒絶されること', () => {
      const teacher = dbUser('teacher1');
      assert.throws(
        () => {
          ApplicationEligibilityResolver.assertEligible({
            actor: { id: teacher.id, username: teacher.username, roles: ['TEACHER'], isActive: true },
            initiationMode: 'SELF',
            applicationTypeId: 'LEAVE_LARGE_SCHOOL',
          });
        },
        (err: any) => err.statusCode === 403 && err.code === 'APPLICATION_TYPE_RETIRED'
      );
    });

    it('GT-AUTH-05: 未定義の typeId は 400 INVALID_APPLICATION_TYPE で拒絶されること', () => {
      const teacher = dbUser('teacher1');
      assert.throws(
        () => {
          ApplicationEligibilityResolver.assertEligible({
            actor: { id: teacher.id, username: teacher.username, roles: ['TEACHER'], isActive: true },
            initiationMode: 'SELF',
            applicationTypeId: 'NON_EXISTENT_CUSTOM_LEAVE',
          });
        },
        (err: any) => err.statusCode === 400 && err.code === 'INVALID_APPLICATION_TYPE'
      );
    });
  });

  // =========================================================================
  // 3. New Application Entry Architecture & Category SSOT Tests (GT-NAE-01〜03)
  // =========================================================================
  describe('Entry Architecture & Server Category SSOT Tests (GT-NAE-*)', () => {
    it('GT-NAE-01: resolveSelectableTypes が 4 カテゴリに分類された有効種別のみを返却すること', () => {
      const teacher = dbUser('teacher1');
      const selectable = ApplicationEligibilityResolver.resolveSelectableTypes({
        id: teacher.id,
        username: teacher.username,
        roles: ['TEACHER'],
        isActive: true,
      });

      assert.ok(selectable.length > 0);
      const categoryIds = new Set(selectable.map((s) => s.categoryId));
      assert.strictEqual(categoryIds.has('TRAVEL'), true);
      assert.strictEqual(categoryIds.has('LEAVE_DUTY_EXEMPT'), true);
      assert.strictEqual(categoryIds.has('CHILDCARE_CARE'), true);
      assert.strictEqual(categoryIds.has('OTHER'), true);
      assert.strictEqual(categoryIds.size, 4);
    });

    it('GT-NAE-02: resolveSelectableTypes から LEAVE_LARGE_SCHOOL が完全に除外されていること', () => {
      const teacher = dbUser('teacher1');
      const selectable = ApplicationEligibilityResolver.resolveSelectableTypes({
        id: teacher.id,
        username: teacher.username,
        roles: ['TEACHER'],
        isActive: true,
      });

      const foundLargeSchool = selectable.find((s) => s.id === 'LEAVE_LARGE_SCHOOL');
      assert.strictEqual(foundLargeSchool, undefined);
    });

    it('GT-NAE-03: 未分類種別が resolveSelectableTypes に混入せず、OTHER にもフォールバックしないこと (UNKNOWN ≠ OTHER)', () => {
      const db = getDb();
      // 一時的に未分類種別を挿入して検証
      db.prepare('INSERT OR REPLACE INTO application_types (id, name, description, default_route_id) VALUES (?, ?, ?, ?)').run(
        'UNKNOWN_RANDOM_TYPE',
        '未分類種別テスト',
        'テスト用',
        1
      );

      const teacher = dbUser('teacher1');
      const selectable = ApplicationEligibilityResolver.resolveSelectableTypes({
        id: teacher.id,
        username: teacher.username,
        roles: ['TEACHER'],
        isActive: true,
      });

      const foundUnknown = selectable.find((s) => s.id === 'UNKNOWN_RANDOM_TYPE');
      assert.strictEqual(foundUnknown, undefined);

      const evalResult = ApplicationEligibilityResolver.evaluateEligibility({
        actor: { id: teacher.id, username: teacher.username, roles: ['TEACHER'], isActive: true },
        initiationMode: 'SELF',
        applicationTypeId: 'UNKNOWN_RANDOM_TYPE',
      });
      assert.strictEqual(evalResult.isEligible, false);
      assert.strictEqual(evalResult.httpStatus, 400);
      assert.strictEqual(evalResult.errorCode, 'INVALID_APPLICATION_TYPE');

      // テストデータをクリーンアップ
      db.prepare('DELETE FROM application_types WHERE id = ?').run('UNKNOWN_RANDOM_TYPE');
    });
  });
});

function dbUser(username: string): { id: number; username: string } {
  const db = getDb();
  return db.prepare('SELECT id, username FROM users WHERE username = ?').get(username) as any;
}

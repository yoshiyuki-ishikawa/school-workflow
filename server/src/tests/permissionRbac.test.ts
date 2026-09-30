import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../db/database';
import { checkUserPermission } from '../middlewares/auth';

describe('Phase 1: Permission-Based RBAC & SYSTEM_ADMIN Isolation Test Suite', () => {
  const db = getDb();

  it('1. PRINCIPAL (校長) は全業務パーミッションおよびrestricted閲覧権限を持つこと', () => {
    assert.strictEqual(checkUserPermission(['PRINCIPAL'], 'personnel.status.read.restricted'), true);
    assert.strictEqual(checkUserPermission(['PRINCIPAL'], 'personnel.status.manage'), true);
    assert.strictEqual(checkUserPermission(['PRINCIPAL'], 'attendance.finalize'), true);
    assert.strictEqual(checkUserPermission(['PRINCIPAL'], 'attendance.reconfirm'), true);
  });

  it('2. VICE_PRINCIPAL (教頭) はrestricted閲覧・管理権限を持つが確定(finalize)権限は持たないこと', () => {
    assert.strictEqual(checkUserPermission(['VICE_PRINCIPAL'], 'personnel.status.read.restricted'), true);
    assert.strictEqual(checkUserPermission(['VICE_PRINCIPAL'], 'personnel.status.manage'), true);
    assert.strictEqual(checkUserPermission(['VICE_PRINCIPAL'], 'attendance.finalize'), false);
  });

  it('3. OFFICE (事務) は起案・管理・基本閲覧権限を持つがrestricted閲覧権限は持たないこと', () => {
    assert.strictEqual(checkUserPermission(['OFFICE'], 'personnel.status.read.basic'), true);
    assert.strictEqual(checkUserPermission(['OFFICE'], 'personnel.status.manage'), true);
    assert.strictEqual(checkUserPermission(['OFFICE'], 'personnel.status.read.restricted'), false);
  });

  it('4. TEACHER (一般教員) は出勤簿閲覧・基本閲覧のみで管理・restricted権限を持たないこと', () => {
    assert.strictEqual(checkUserPermission(['TEACHER'], 'attendance.read'), true);
    assert.strictEqual(checkUserPermission(['TEACHER'], 'personnel.status.read.restricted'), false);
    assert.strictEqual(checkUserPermission(['TEACHER'], 'personnel.status.manage'), false);
  });

  it('5. ADMIN (システム管理者) はシステム管理権限を持つが、人事機密 (restricted) 閲覧権限は遮断されていること', () => {
    assert.strictEqual(checkUserPermission(['ADMIN'], 'system.manage'), true);
    assert.strictEqual(checkUserPermission(['ADMIN'], 'audit.read'), true);
    assert.strictEqual(checkUserPermission(['ADMIN'], 'personnel.status.read.restricted'), false);
    assert.strictEqual(checkUserPermission(['ADMIN'], 'personnel.status.manage'), false);
    assert.strictEqual(checkUserPermission(['ADMIN'], 'attendance.finalize'), false);
  });
});

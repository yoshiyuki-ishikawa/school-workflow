import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { initDatabase, seedDatabase, getDb, checkIntegrity } from '../db';
import { BackupManager } from '../utils/backupManager';
import { WorkflowEngine, UserContext } from '../workflow/engine';

describe('修正④ Backup / Restore 新PC完全復旧モデル テスト', () => {
  const teacherA: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '192.168.1.100',
  };
  const admin: UserContext = {
    id: 5,
    username: 'admin',
    displayName: '事務室D',
    roles: ['ADMIN'],
    ipAddress: '192.168.1.104',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
  });

  it('1. バックアップ作成、チェックサム生成、整合性チェックの完全性', () => {
    // 申請データを投入
    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: 'バックアップ前年休申請',
      formData: { unitType: 'DAY', startDate: '2026-06-01', endDate: '2026-06-01' },
    });
    assert.strictEqual(submitRes.success, true);

    // バックアップ作成
    const backupRes = BackupManager.createBackup(admin);
    assert.strictEqual(backupRes.success, true);
    assert.ok(fs.existsSync(backupRes.backupPath));
    assert.ok(fs.existsSync(path.join(backupRes.backupPath, 'school_workflow.db')));
    assert.ok(fs.existsSync(path.join(backupRes.backupPath, 'backup_metadata.json')));
    assert.ok(fs.existsSync(path.join(backupRes.backupPath, 'system_settings.json')));

    // メタデータ検証
    assert.strictEqual(backupRes.metadata.version, '1.0.0');
    assert.ok(backupRes.metadata.dbChecksum.length === 64); // SHA-256
    assert.ok(backupRes.metadata.counts.applications >= 1);
  });

  it('2. バックアップからのシステム復元 (Disaster Recovery) と業務継続', () => {
    // 1. バックアップ作成
    const backupRes = BackupManager.createBackup(admin);
    const backupPath = backupRes.backupPath;

    // 2. 障害シミュレーション (DBファイルの消失・破壊)
    const { closeDb } = require('../db/database');
    const { config } = require('../config');
    closeDb();
    if (fs.existsSync(config.DB_PATH)) {
      fs.unlinkSync(config.DB_PATH);
    }
    if (fs.existsSync(`${config.DB_PATH}-wal`)) {
      fs.unlinkSync(`${config.DB_PATH}-wal`);
    }
    if (fs.existsSync(`${config.DB_PATH}-shm`)) {
      fs.unlinkSync(`${config.DB_PATH}-shm`);
    }
    assert.strictEqual(fs.existsSync(config.DB_PATH), false);

    // 3. リストア実行
    const restoreRes = BackupManager.restoreBackup(backupPath, admin);
    assert.strictEqual(restoreRes.success, true);

    // 4. 整合性・データ復元検証
    const postIntegrity = checkIntegrity();
    assert.strictEqual(postIntegrity.ok, true);

    const restoredDb = getDb();
    const restoredUserCount = (restoredDb.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
    assert.ok(restoredUserCount >= 5);

    // 5. 復元後の新規業務処理が可能であること
    const newSubmit = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '復元後新規申請',
      formData: { unitType: 'DAY', startDate: '2026-07-01', endDate: '2026-07-01' },
    });
    assert.strictEqual(newSubmit.success, true);
  });
});

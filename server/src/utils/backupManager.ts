import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, checkIntegrity, closeDb } from '../db/database';
import { config } from '../config';
import { getServerIsoString, getServerTime } from './serverTime';
import { logAudit } from './auditLogger';

export interface BackupMetadata {
  backupId: string;
  version: string;
  schemaVersion: number;
  createdAt: string;
  createdByUser?: string;
  dbChecksum: string;
  counts: {
    users: number;
    applications: number;
    tripEvents: number;
    auditLogs: number;
    leaveGrants: number;
  };
}

export interface BackupResult {
  success: boolean;
  backupId: string;
  backupPath: string;
  metadata: BackupMetadata;
  message: string;
}

export interface RestoreResult {
  success: boolean;
  message: string;
  verifiedCounts?: Record<string, number>;
}

/**
 * 堅牢な多層バックアップ・復元マネージャー (Node標準ライブラリのみ使用・完全閉域対応)
 */
export class BackupManager {
  /**
   * 世代バックアップの作成 (VACUUM INTO + メタデータ + 整合性チェック)
   */
  static createBackup(actor?: { id: number; username: string; roles: string[]; ipAddress: string; userAgent?: string }): BackupResult {
    const db = getDb();
    const now = getServerTime();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const timestampStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const backupId = `backup_${timestampStr}`;

    const targetDir = path.resolve(config.BACKUP_DIR, backupId);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const backupDbPath = path.join(targetDir, 'school_workflow.db');
    const metadataPath = path.join(targetDir, 'backup_metadata.json');
    const settingsPath = path.join(targetDir, 'system_settings.json');

    // 1. VACUUM INTO によるクリーンなDBスナップショット作成
    if (fs.existsSync(backupDbPath)) {
      fs.unlinkSync(backupDbPath);
    }
    db.prepare('VACUUM INTO ?').run(backupDbPath);

    // 2. DB破損・整合性検証
    const integrity = checkIntegrity(backupDbPath);
    if (!integrity.ok) {
      throw new Error(`バックアップDBの整合性検証に失敗しました: ${integrity.message}`);
    }

    // 3. SHA-256 チェックサム計算
    const fileBuffer = fs.readFileSync(backupDbPath);
    const hashSum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // 4. レコード件数集計
    const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
    const appCount = (db.prepare('SELECT COUNT(*) as count FROM applications').get() as any).count;
    const tripCount = (db.prepare('SELECT COUNT(*) as count FROM trip_events').get() as any).count;
    const auditCount = (db.prepare('SELECT COUNT(*) as count FROM audit_logs').get() as any).count;
    let leaveGrantCount = 0;
    try {
      leaveGrantCount = (db.prepare('SELECT COUNT(*) as count FROM leave_grants').get() as any).count;
    } catch {
      leaveGrantCount = 0;
    }

    let schemaVersion = 1;
    try {
      const latestMig = db.prepare('SELECT MAX(version) as latest FROM schema_migrations').get() as any;
      if (latestMig && latestMig.latest) {
        schemaVersion = latestMig.latest;
      }
    } catch {
      schemaVersion = 1;
    }

    // 5. システム設定のエクスポート
    let systemSettings: any[] = [];
    try {
      systemSettings = db.prepare('SELECT * FROM system_settings').all();
    } catch {
      systemSettings = [];
    }
    fs.writeFileSync(settingsPath, JSON.stringify(systemSettings, null, 2), 'utf-8');

    // 6. メタデータ生成
    const metadata: BackupMetadata = {
      backupId,
      version: '1.0.0',
      schemaVersion,
      createdAt: getServerIsoString(),
      createdByUser: actor?.username || 'SYSTEM',
      dbChecksum: hashSum,
      counts: {
        users: userCount,
        applications: appCount,
        tripEvents: tripCount,
        auditLogs: auditCount,
        leaveGrants: leaveGrantCount,
      },
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    // 7. 監査ログ記録
    if (actor) {
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        roleSnapshot: actor.roles.join(','),
        action: 'CREATE_BACKUP',
        entityType: 'SYSTEM_BACKUP',
        entityId: backupId,
        comment: `バックアップ作成完了 (チェックサム: ${hashSum.substring(0, 12)}...)`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          backupId,
          dbChecksum: hashSum,
          counts: metadata.counts,
        },
      });
    }

    return {
      success: true,
      backupId,
      backupPath: targetDir,
      metadata,
      message: `バックアップ [${backupId}] を正常に作成しました`,
    };
  }

  /**
   * 指定バックアップからの復元 (Disaster Recovery)
   */
  static restoreBackup(
    backupDirOrZipPath: string,
    actor?: { id: number; username: string; roles: string[]; ipAddress: string; userAgent?: string }
  ): RestoreResult {
    const backupDbPath = path.join(backupDirOrZipPath, 'school_workflow.db');
    const metadataPath = path.join(backupDirOrZipPath, 'backup_metadata.json');

    if (!fs.existsSync(backupDbPath) || !fs.existsSync(metadataPath)) {
      throw new Error('指定されたパスに有効なバックアップファイル（DBまたはメタデータ）が存在しません');
    }

    // 1. メタデータの検証
    const metadataRaw = fs.readFileSync(metadataPath, 'utf-8');
    const metadata: BackupMetadata = JSON.parse(metadataRaw);

    // 2. チェックサムの検証
    const fileBuffer = fs.readFileSync(backupDbPath);
    const calculatedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (calculatedHash !== metadata.dbChecksum) {
      throw new Error(`チェックサムの不一致を検知しました。バックアップファイルが破損または改ざんされています (期待値: ${metadata.dbChecksum}, 実際値: ${calculatedHash})`);
    }

    // 3. バックアップDB自体の SQLite integrity_check
    const integrity = checkIntegrity(backupDbPath);
    if (!integrity.ok) {
      throw new Error(`バックアップDBの整合性チェックに失敗しました: ${integrity.message}`);
    }

    // 4. 現在のDBファイルを安全に退避 (Safety Pre-Restore Backup)
    const currentDbPath = path.resolve(config.DB_PATH);
    const walPath = `${currentDbPath}-wal`;
    const shmPath = `${currentDbPath}-shm`;
    const preRestoreBackupPath = path.resolve(config.BACKUP_DIR, `pre_restore_${Date.now()}.db`);
    
    // コネクションを閉じる
    closeDb();

    if (fs.existsSync(currentDbPath)) {
      fs.copyFileSync(currentDbPath, preRestoreBackupPath);
    }
    // 古い WAL / SHM ファイルの削除
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }
    if (fs.existsSync(shmPath)) {
      fs.unlinkSync(shmPath);
    }

    // 5. DBファイルのリストア適用
    fs.copyFileSync(backupDbPath, currentDbPath);

    // 6. リストア後DBの整合性確認
    const postCheck = checkIntegrity(currentDbPath);
    if (!postCheck.ok) {
      // 復元失敗時は退避したDBに戻す
      if (fs.existsSync(preRestoreBackupPath)) {
        fs.copyFileSync(preRestoreBackupPath, currentDbPath);
      }
      throw new Error(`復元先DBの整合性チェックに失敗したため、ロールバックしました: ${postCheck.message}`);
    }

    if (actor) {
      logAudit({
        actorUserId: actor.id,
        actorUsername: actor.username,
        roleSnapshot: actor.roles.join(','),
        action: 'RESTORE_BACKUP',
        entityType: 'SYSTEM_BACKUP',
        entityId: metadata.backupId,
        comment: `バックアップ [${metadata.backupId}] からのシステム復元完了`,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: {
          backupId: metadata.backupId,
          restoredAt: getServerIsoString(),
        },
      });
    }

    return {
      success: true,
      message: `バックアップ [${metadata.backupId}] からの復元が完了しました。整合性チェック: 正常`,
      verifiedCounts: metadata.counts,
    };
  }
}

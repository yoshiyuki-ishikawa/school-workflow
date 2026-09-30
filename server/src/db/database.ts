import fs from 'fs';
import path from 'path';
import Database, { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config';
import { getServerTime } from '../utils/serverTime';
import { SCHEMA_SQL } from './schema';

let dbInstance: DatabaseType | null = null;

export function getDb(): DatabaseType {
  if (!dbInstance) {
    // ディレクトリが存在することを確認
    if (!fs.existsSync(config.DATA_DIR)) {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(config.BACKUP_DIR)) {
      fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
    }
    if (!fs.existsSync(config.LOGS_DIR)) {
      fs.mkdirSync(config.LOGS_DIR, { recursive: true });
    }

    dbInstance = new Database(config.DB_PATH);
    // WALモードと外部キー制約の有効化
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    dbInstance.pragma('synchronous = NORMAL');
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function setDb(db: DatabaseType): void {
  dbInstance = db;
}

/**
 * データベース整合性検証 (PRAGMA integrity_check)
 */
export function checkIntegrity(targetDbPath?: string): { ok: boolean; message: string } {
  let targetDb: DatabaseType;
  let shouldClose = false;

  if (targetDbPath && fs.existsSync(targetDbPath)) {
    targetDb = new Database(targetDbPath, { readonly: true });
    shouldClose = true;
  } else {
    targetDb = getDb();
  }

  try {
    const result = targetDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    const isOk = result?.integrity_check === 'ok';
    return {
      ok: isOk,
      message: result?.integrity_check || 'unknown result',
    };
  } catch (err: any) {
    return {
      ok: false,
      message: err.message || 'Integrity check failed',
    };
  } finally {
    if (shouldClose) {
      targetDb.close();
    }
  }
}

import { migrator } from './migrations';

/**
 * データベーススキーマ初期化・マイグレーション実行
 */
export function initDatabase(): void {
  const db = getDb();
  // スキーマベース初期化
  db.exec(SCHEMA_SQL);
  // マイグレーション実行 (安全バックアップ + 履歴管理)
  migrator.runMigrations(db);

  // カラム補正 (audit_logs)
  const auditCols = db.prepare('PRAGMA table_info(audit_logs)').all() as { name: string }[];
  const auditColNames = new Set(auditCols.map((c) => c.name));
  if (!auditColNames.has('server_timestamp')) {
    db.exec(`ALTER TABLE audit_logs ADD COLUMN server_timestamp TEXT`);
  }
  if (!auditColNames.has('actor_username')) {
    db.exec(`ALTER TABLE audit_logs ADD COLUMN actor_username TEXT`);
  }
}

/**
 * 安全なバックアップ生成 (VACUUM INTO + 整合性検証 + 30世代保持)
 */
export function createBackup(): { success: boolean; backupPath: string; message: string } {
  const db = getDb();
  const now = getServerTime();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const filename = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`;
  const backupPath = path.resolve(config.BACKUP_DIR, filename);

  try {
    // 既存ファイルがあれば削除
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }

    // SQLiteの VACUUM INTO による整合性保証バックアップ
    db.prepare(`VACUUM INTO ?`).run(backupPath);

    // バックアップファイルの整合性検証
    const check = checkIntegrity(backupPath);
    if (!check.ok) {
      fs.unlinkSync(backupPath);
      throw new Error(`Backup integrity verification failed: ${check.message}`);
    }

    // 世代管理 (直近30世代保持)
    cleanOldBackups(30);

    return {
      success: true,
      backupPath,
      message: `Backup created and verified successfully (${filename})`,
    };
  } catch (err: any) {
    return {
      success: false,
      backupPath: '',
      message: err.message || 'Backup failed',
    };
  }
}

/**
 * 古いバックアップの整理
 */
function cleanOldBackups(keepCount: number): void {
  try {
    const files = fs.readdirSync(config.BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({
        name: f,
        path: path.join(config.BACKUP_DIR, f),
        time: fs.statSync(path.join(config.BACKUP_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    if (files.length > keepCount) {
      const toDelete = files.slice(keepCount);
      for (const item of toDelete) {
        fs.unlinkSync(item.path);
      }
    }
  } catch (err) {
    console.error('Failed to clean old backups:', err);
  }
}

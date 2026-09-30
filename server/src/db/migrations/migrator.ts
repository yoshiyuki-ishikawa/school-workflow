import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../../config';
import { getServerTime } from '../../utils/serverTime';
import { checkIntegrity } from '../database';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseType) => void;
}

/**
 * マイグレーション管理クラス (10大原則完全遵守)
 */
export class DatabaseMigrator {
  private migrations: Migration[] = [];

  register(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * マイグレーション実行
   */
  runMigrations(db: DatabaseType): { appliedCount: number; currentVersion: number } {
    // 0. schema_migrations テーブルの存在確認・作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    // 現在適用済みのバージョン一覧取得
    const appliedRows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version ASC').all() as {
      version: number;
      checksum: string;
    }[];
    const appliedVersions = new Set(appliedRows.map((r) => r.version));
    const pendingMigrations = this.migrations.filter((m) => !appliedVersions.has(m.version));

    if (pendingMigrations.length === 0) {
      const latest = appliedRows.length > 0 ? appliedRows[appliedRows.length - 1].version : 0;
      return { appliedCount: 0, currentVersion: latest };
    }

    console.log(`[DatabaseMigrator] Found ${pendingMigrations.length} pending migration(s).`);

    // 1. 事前 integrity_check
    const preCheckResult = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (preCheckResult?.integrity_check !== 'ok') {
      throw new Error(`[DatabaseMigrator] Pre-migration integrity check failed: ${preCheckResult?.integrity_check}`);
    }

    // 2. トランザクション開始前の VACUUM INTO バックアップ (ファイルDBの場合のみ)
    const isMemoryDb = (db as any).name === ':memory:' || (db as any).memory;
    const now = getServerTime();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const timestampStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const backupFilename = `pre_migration_${timestampStr}.db`;
    const backupPath = path.resolve(config.BACKUP_DIR, backupFilename);

    if (!isMemoryDb && config.DB_PATH !== ':memory:') {
      try {
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
        }
        db.prepare('VACUUM INTO ?').run(backupPath);
        const backupCheck = checkIntegrity(backupPath);
        if (!backupCheck.ok) {
          throw new Error(`[DatabaseMigrator] Pre-migration backup integrity verification failed: ${backupCheck.message}`);
        }
        console.log(`[DatabaseMigrator] Safety backup verified and saved to: ${backupPath}`);
      } catch (err: any) {
        throw new Error(`[DatabaseMigrator] Failed to create pre-migration backup: ${err.message}`);
      }
    }

    // 3. トランザクション内で各マイグレーションを実行
    let appliedCount = 0;
    for (const migration of pendingMigrations) {
      console.log(`[DatabaseMigrator] Applying migration v${migration.version}: ${migration.name}...`);

      // SQLite Table Rebuild (PRAGMA foreign_keys = OFF) を許可するため外側で FK を一時無効化
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');

      const migrationTx = db.transaction(() => {
        // マイグレーション実行
        migration.up(db);

        // チェックサム計算
        const checksum = crypto.createHash('sha256').update(migration.up.toString()).digest('hex');
        const appliedAt = now.toISOString();

        // 履歴記録
        db.prepare(`
          INSERT INTO schema_migrations (version, name, checksum, applied_at)
          VALUES (?, ?, ?, ?)
        `).run(migration.version, migration.name, checksum, appliedAt);
      });

      try {
        migrationTx();
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');

        // 外部キー整合性チェック (Fail-Closed)
        const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
        if (fkErrors.length > 0) {
          throw new Error(`[DatabaseMigrator] Foreign key integrity violation in v${migration.version}: ${JSON.stringify(fkErrors)}`);
        }

        appliedCount++;
        console.log(`[DatabaseMigrator] Migration v${migration.version} successfully applied.`);
      } catch (err: any) {
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');
        console.error(`[DatabaseMigrator] FATAL: Migration v${migration.version} failed. Rollback executed.`, err);
        throw err;
      }
    }

    // 4. マイグレーション完了後の最終 integrity_check
    const postCheck = checkIntegrity();
    if (!postCheck.ok) {
      throw new Error(`[DatabaseMigrator] Post-migration integrity check failed: ${postCheck.message}`);
    }

    const currentVersionRow = db.prepare('SELECT MAX(version) as latest FROM schema_migrations').get() as { latest: number };
    console.log(`[DatabaseMigrator] All migrations completed. Current schema version: v${currentVersionRow.latest}`);

    return {
      appliedCount,
      currentVersion: currentVersionRow.latest,
    };
  }
}

export const migrator = new DatabaseMigrator();

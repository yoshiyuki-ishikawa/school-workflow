import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

// ルートまたはserverディレクトリの.envを読み込み
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const ROOT_DIR = path.resolve(__dirname, '../../../');
const isVercel = !!process.env.VERCEL;
const defaultDataDir = isVercel ? path.join(os.tmpdir(), 'school-workflow-data') : path.resolve(ROOT_DIR, 'data');
const defaultBackupDir = isVercel ? path.join(os.tmpdir(), 'school-workflow-backups') : path.resolve(ROOT_DIR, 'backups');
const defaultLogsDir = isVercel ? path.join(os.tmpdir(), 'school-workflow-logs') : path.resolve(ROOT_DIR, 'logs');

export const config = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  // POC_MODE: デフォルトはtrue（PoC検証用）。'false'が指定された場合のみ物理的に無効化
  POC_MODE: process.env.POC_MODE !== 'false',
  SESSION_SECRET: process.env.SESSION_SECRET || 'school-workflow-secret-key-2026-secure',
  DATA_DIR: process.env.DATA_DIR || defaultDataDir,
  BACKUP_DIR: process.env.BACKUP_DIR || defaultBackupDir,
  LOGS_DIR: process.env.LOGS_DIR || defaultLogsDir,
  DB_PATH: process.env.DB_PATH || path.resolve(process.env.DATA_DIR || defaultDataDir, 'school_workflow.db'),
  CLIENT_DIST: path.resolve(ROOT_DIR, 'client/dist'),
  // Phase D: Canonical Shadow Dual Run Feature Flag (Default: false / Strict literal match)
  CANONICAL_SHADOW_MODE: process.env.CANONICAL_SHADOW_MODE === 'true',
};

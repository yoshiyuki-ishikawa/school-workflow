import path from 'path';
import dotenv from 'dotenv';

// ルートまたはserverディレクトリの.envを読み込み
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const ROOT_DIR = path.resolve(__dirname, '../../../');

export const config = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  // POC_MODE: デフォルトはtrue（PoC検証用）。'false'が指定された場合のみ物理的に無効化
  POC_MODE: process.env.POC_MODE !== 'false',
  SESSION_SECRET: process.env.SESSION_SECRET || 'school-workflow-secret-key-2026-secure',
  DATA_DIR: path.resolve(ROOT_DIR, 'data'),
  BACKUP_DIR: path.resolve(ROOT_DIR, 'backups'),
  LOGS_DIR: path.resolve(ROOT_DIR, 'logs'),
  DB_PATH: path.resolve(ROOT_DIR, 'data', 'school_workflow.db'),
  CLIENT_DIST: path.resolve(ROOT_DIR, 'client/dist'),
  // Phase D: Canonical Shadow Dual Run Feature Flag (Default: false / Strict literal match)
  CANONICAL_SHADOW_MODE: process.env.CANONICAL_SHADOW_MODE === 'true',
};

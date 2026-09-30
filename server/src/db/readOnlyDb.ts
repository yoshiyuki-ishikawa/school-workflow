/**
 * Read-Only Database Connection for Canonical Shadow
 * Canonical Service Fact Architecture — Phase D
 * 
 * Invariant INV-D-04: Structural Read-Only
 * Shadow 実行経路からは INSERT / UPDATE / DELETE / DDL 等が物理的に拒絶される。
 */

import fs from 'fs';
import Database, { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config';

let readOnlyDbInstance: DatabaseType | null = null;

export function getReadOnlyDb(targetDbPath?: string): DatabaseType {
  const dbPath = targetDbPath || config.DB_PATH;
  
  if (targetDbPath || !readOnlyDbInstance) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`[ReadOnlyDb] Database file not found at: ${dbPath}`);
    }
    const instance = new Database(dbPath, { readonly: true, fileMustExist: true });
    instance.pragma('foreign_keys = ON');
    instance.pragma('query_only = ON'); // SQLiteレベルで書込命令を完全禁止
    
    if (!targetDbPath) {
      readOnlyDbInstance = instance;
    }
    return instance;
  }
  
  return readOnlyDbInstance;
}

export function closeReadOnlyDb(): void {
  if (readOnlyDbInstance) {
    readOnlyDbInstance.close();
    readOnlyDbInstance = null;
  }
}

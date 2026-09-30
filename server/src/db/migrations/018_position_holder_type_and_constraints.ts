import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 018: Position holder_type 属性と DB レベル制約の導入
 * 
 * 1. positions テーブルに holder_type カラム (CHECK 制約付き) を導入
 *    - SINGLE_HOLDER: 同一期間に最大1名の担当者を要求 (承認ルート利用可能)
 *    - MULTIPLE_HOLDER: 同一期間に複数担当者が配置可能 (単一承認者ルート指定不可)
 * 2. 既存Positionマスタのデータ保持
 */
export const migration018: Migration = {
  version: 18,
  name: 'position_holder_type_and_constraints',
  up: (db: Database) => {
    // 1. 既存の positions テーブルの構造とデータを確認
    const posCols = db.prepare('PRAGMA table_info(positions)').all() as { name: string }[];
    const hasHolderType = posCols.some((c) => c.name === 'holder_type');

    if (!hasHolderType) {
      // SQLite で CHECK 制約付きカラムを確実に設定するため、テーブル再作成方式 (safe table recreation) を採用
      db.exec(`
        CREATE TABLE positions_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          rank_order INTEGER NOT NULL,
          holder_type TEXT NOT NULL DEFAULT 'SINGLE_HOLDER' CHECK (holder_type IN ('SINGLE_HOLDER', 'MULTIPLE_HOLDER')),
          description TEXT
        );

        INSERT INTO positions_new (id, name, rank_order, holder_type, description)
        SELECT id, name, rank_order, 'SINGLE_HOLDER', description FROM positions;

        DROP TABLE positions;

        ALTER TABLE positions_new RENAME TO positions;
      `);
    }

    // 初期マスタの holder_type 確定更新
    const updateHolderType = db.prepare('UPDATE positions SET holder_type = ? WHERE id = ?');
    updateHolderType.run('SINGLE_HOLDER', 'CHIEF_TEACHER');
    updateHolderType.run('SINGLE_HOLDER', 'VICE_PRINCIPAL_1');
    updateHolderType.run('SINGLE_HOLDER', 'VICE_PRINCIPAL_2');
    updateHolderType.run('SINGLE_HOLDER', 'PRINCIPAL');
    updateHolderType.run('SINGLE_HOLDER', 'OFFICE_HEAD');
  },
};

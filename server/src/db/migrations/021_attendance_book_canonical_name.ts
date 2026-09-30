import { Database as DatabaseType } from 'better-sqlite3';
import { Migration } from './migrator';

/**
 * Migration 021: 出勤簿のCanonical Name統一および様式番号分離 (INV-026, [INV-MIGRATION-FIELD-ISOLATION])
 * - form_name判定とtemplate_definition.subtitle判定を完全分離
 * - 旧Seed値のみを対象とし、ユーザーカスタム名・カスタムsubtitle・他JSONキー・他帳票を非破壊で保持
 */
export const migration021: Migration = {
  version: 21,
  name: 'attendance_book_canonical_name',
  up: (db: DatabaseType) => {
    // 1. official_form_templates テーブルの存在確認
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='official_form_templates'").get();
    if (!tableExists) {
      return;
    }

    // 2. Canonical Key 'ATTENDANCE_BOOK' を持つ対象レコードを取得
    const rows = db.prepare(`
      SELECT id, form_code, form_name, template_definition
      FROM official_form_templates
      WHERE form_code = 'ATTENDANCE_BOOK'
    `).all() as {
      id: number;
      form_code: string;
      form_name: string;
      template_definition: string;
    }[];

    if (rows.length === 0) {
      return;
    }

    const legacySubtitles = new Set([
      '(第6号様式)',
      '（第6号様式）',
      '(第６号様式)',
      '（第６号様式）',
    ]);

    const updateStmt = db.prepare(`
      UPDATE official_form_templates
      SET form_name = ?, template_definition = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      let isModified = false;

      // 2-1. form_name の独立判定と移行（旧Seed値のみを対象とし、ユーザーカスタム名称は完全保護）
      let nextFormName = row.form_name;
      if (row.form_name === '出勤簿 (第6号様式相当)') {
        nextFormName = '出勤簿';
        isModified = true;
      }

      // 2-2. template_definition.subtitle の独立判定と移行
      let nextDefinitionStr = row.template_definition;
      try {
        const currentDef = JSON.parse(row.template_definition);
        if (currentDef && typeof currentDef === 'object' && !Array.isArray(currentDef)) {
          // 他プロパティ（title, authority, sections, orientation, custom keys等）を完全保持
          const migratedDef = { ...currentDef };

          if (
            typeof currentDef.subtitle === 'string' &&
            legacySubtitles.has(currentDef.subtitle.trim())
          ) {
            delete migratedDef.subtitle;
            nextDefinitionStr = JSON.stringify(migratedDef);
            isModified = true;
          }
        }
      } catch (e) {
        // JSON parseエラー時は安全のためtemplate_definitionを改変しない
      }

      // 変更がある場合のみ更新
      if (isModified) {
        updateStmt.run(nextFormName, nextDefinitionStr, row.id);
      }
    }
  },
};

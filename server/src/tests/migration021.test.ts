import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migration021 } from '../db/migrations/021_attendance_book_canonical_name';

describe('Migration 021: 出勤簿Canonical Name統一・フィールド分離 (Case A〜F)', () => {
  const createTestDb = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS official_form_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        authority_id TEXT NOT NULL DEFAULT 'DEFAULT_MUNICIPALITY',
        form_code TEXT NOT NULL,
        form_name TEXT NOT NULL,
        form_type TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0',
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        paper_size TEXT NOT NULL DEFAULT 'A4',
        orientation TEXT NOT NULL DEFAULT 'PORTRAIT',
        template_definition TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );
    `);
    return db;
  };

  it('Case A: 完全な旧Seed値 (form_name移行 + subtitle除去 + 他JSONキー保持)', () => {
    const db = createTestDb();
    const initialDef = {
      title: '出 勤 簿',
      subtitle: '(第6号様式)',
      authority: '公立学校職員服務取扱規程',
      sections: ['header', 'calendar_grid', 'monthly_summary'],
      customProp: 'preserved',
    };

    db.prepare(`
      INSERT INTO official_form_templates (form_code, form_name, form_type, effective_from, template_definition)
      VALUES ('ATTENDANCE_BOOK', '出勤簿 (第6号様式相当)', 'ATTENDANCE', '2026-04-01', ?)
    `).run(JSON.stringify(initialDef));

    migration021.up(db);

    const row = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'ATTENDANCE_BOOK'").get() as any;
    assert.strictEqual(row.form_name, '出勤簿');

    const def = JSON.parse(row.template_definition);
    assert.strictEqual(def.title, '出 勤 簿');
    assert.strictEqual(def.subtitle, undefined);
    assert.strictEqual(def.authority, '公立学校職員服務取扱規程');
    assert.deepStrictEqual(def.sections, ['header', 'calendar_grid', 'monthly_summary']);
    assert.strictEqual(def.customProp, 'preserved');
  });

  it('Case B: ユーザーカスタム名称 + 旧subtitle (form_name保護 + subtitle除去)', () => {
    const db = createTestDb();
    const initialDef = {
      title: '出 勤 簿',
      subtitle: '(第6号様式)',
      authority: '公立学校職員服務取扱規程',
    };

    db.prepare(`
      INSERT INTO official_form_templates (form_code, form_name, form_type, effective_from, template_definition)
      VALUES ('ATTENDANCE_BOOK', '○○市職員出勤簿', 'ATTENDANCE', '2026-04-01', ?)
    `).run(JSON.stringify(initialDef));

    migration021.up(db);

    const row = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'ATTENDANCE_BOOK'").get() as any;
    assert.strictEqual(row.form_name, '○○市職員出勤簿'); // ユーザーカスタム名称は完全保護

    const def = JSON.parse(row.template_definition);
    assert.strictEqual(def.subtitle, undefined); // 旧subtitleは安全に除去
    assert.strictEqual(def.title, '出 勤 簿');
  });

  it('Case C: Canonical Name + 旧subtitle (form_name不変 + subtitle除去)', () => {
    const db = createTestDb();
    const initialDef = {
      title: '出 勤 簿',
      subtitle: '（第６号様式）', // 全角表記揺れ
      authority: '公立学校職員服務取扱規程',
    };

    db.prepare(`
      INSERT INTO official_form_templates (form_code, form_name, form_type, effective_from, template_definition)
      VALUES ('ATTENDANCE_BOOK', '出勤簿', 'ATTENDANCE', '2026-04-01', ?)
    `).run(JSON.stringify(initialDef));

    migration021.up(db);

    const row = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'ATTENDANCE_BOOK'").get() as any;
    assert.strictEqual(row.form_name, '出勤簿');

    const def = JSON.parse(row.template_definition);
    assert.strictEqual(def.subtitle, undefined);
  });

  it('Case D: カスタム名称 + カスタムsubtitle (完全不変)', () => {
    const db = createTestDb();
    const initialDef = {
      title: '出 勤 簿',
      subtitle: '○○市独自帳票',
      authority: '公立学校職員服務取扱規程',
    };

    db.prepare(`
      INSERT INTO official_form_templates (form_code, form_name, form_type, effective_from, template_definition)
      VALUES ('ATTENDANCE_BOOK', '○○市職員出勤簿', 'ATTENDANCE', '2026-04-01', ?)
    `).run(JSON.stringify(initialDef));

    migration021.up(db);

    const row = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'ATTENDANCE_BOOK'").get() as any;
    assert.strictEqual(row.form_name, '○○市職員出勤簿');

    const def = JSON.parse(row.template_definition);
    assert.strictEqual(def.subtitle, '○○市独自帳票'); // カスタムsubtitleも完全保護
  });

  it('Case E: JSON内の別フィールドだけに「第6号様式」が存在 (完全不変・他キー保持)', () => {
    const db = createTestDb();
    const initialDef = {
      title: '出 勤 簿',
      subtitle: '○○市独自帳票',
      note: '旧第6号様式との比較資料',
      sections: ['header', 'calendar_grid'],
    };

    db.prepare(`
      INSERT INTO official_form_templates (form_code, form_name, form_type, effective_from, template_definition)
      VALUES ('ATTENDANCE_BOOK', '○○市職員出勤簿', 'ATTENDANCE', '2026-04-01', ?)
    `).run(JSON.stringify(initialDef));

    migration021.up(db);

    const row = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'ATTENDANCE_BOOK'").get() as any;
    assert.strictEqual(row.form_name, '○○市職員出勤簿');

    const def = JSON.parse(row.template_definition);
    assert.strictEqual(def.subtitle, '○○市独自帳票');
    assert.strictEqual(def.note, '旧第6号様式との比較資料'); // JSON全文LIKE検索を行わないため別フィールドは誤更新されない
    assert.deepStrictEqual(def.sections, ['header', 'calendar_grid']);
  });

  it('Case F: 他帳票 (LEAVE_RECORD / TRIP_ORDER) の完全不変性', () => {
    const db = createTestDb();
    const leaveDef = {
      title: '休 暇 簿',
      subtitle: '(第9号様式)',
      authority: '服務規程第15条',
    };
    const tripDef = {
      title: '旅 行 命 令 簿',
      subtitle: '(別表第一)',
      authority: '公立学校教職員旅費取扱規程',
    };

    db.prepare(`
      INSERT INTO official_form_templates (form_code, form_name, form_type, effective_from, template_definition)
      VALUES ('LEAVE_RECORD', '休暇簿 (第9号様式相当)', 'LEAVE', '2026-04-01', ?)
    `).run(JSON.stringify(leaveDef));

    db.prepare(`
      INSERT INTO official_form_templates (form_code, form_name, form_type, effective_from, template_definition)
      VALUES ('TRIP_ORDER', '旅行命令・依頼簿 (別表第一相当)', 'TRIP', '2026-04-01', ?)
    `).run(JSON.stringify(tripDef));

    migration021.up(db);

    const leaveRow = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'LEAVE_RECORD'").get() as any;
    assert.strictEqual(leaveRow.form_name, '休暇簿 (第9号様式相当)');
    assert.strictEqual(JSON.parse(leaveRow.template_definition).subtitle, '(第9号様式)');

    const tripRow = db.prepare("SELECT * FROM official_form_templates WHERE form_code = 'TRIP_ORDER'").get() as any;
    assert.strictEqual(tripRow.form_name, '旅行命令・依頼簿 (別表第一相当)');
    assert.strictEqual(JSON.parse(tripRow.template_definition).subtitle, '(別表第一)');
  });
});

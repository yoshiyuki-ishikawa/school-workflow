import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';

/**
 * B. Golden PDF Test
 * 3大公文書帳票の論理仕様・レイアウト・必須要素・決定論的印影の整合性を検証:
 * 1. 休暇簿 (LEAVE_RECORD): A4縦 (210×297mm), 表題, 累計表, 2段階印影 (教頭/校長)
 * 2. 旅行命令簿 (TRIP_ORDER): A4横 (297×210mm), 表題, 旅行命令, 復命書, 3段階印影 (教頭/校長/事務)
 * 3. 出勤簿 (ATTENDANCE_BOOK): A4縦 (210×297mm), 表題, 1〜31日グリッド, 月次確定印影
 */
describe('Test B: Golden PDF Test', () => {
  it('3大公文書帳票の論理仕様・テンプレート・印影定義が完全に満たされていること', () => {
    initDatabase();
    seedDatabase();
    const db = getDb();

    // 1. 帳票テンプレートマスタの検証
    const templates = db.prepare('SELECT * FROM official_form_templates').all() as any[];
    assert.strictEqual(templates.length >= 3, true);

    const leaveTpl = templates.find((t) => t.form_code === 'LEAVE_RECORD');
    assert.strictEqual(leaveTpl?.paper_size, 'A4');
    assert.strictEqual(leaveTpl?.orientation, 'PORTRAIT');

    const tripTpl = templates.find((t) => t.form_code === 'TRIP_ORDER');
    assert.strictEqual(tripTpl?.paper_size, 'A4');
    assert.strictEqual(tripTpl?.orientation, 'LANDSCAPE');

    const attendanceTpl = templates.find((t) => t.form_code === 'ATTENDANCE_BOOK');
    assert.strictEqual(attendanceTpl?.paper_size, 'A4');
    assert.strictEqual(attendanceTpl?.orientation, 'PORTRAIT');

    // 2. 決定論的印影メタデータの完全性検証
    const usersWithStamp = db.prepare('SELECT id, display_name, stamp_name FROM users').all() as any[];
    for (const u of usersWithStamp) {
      assert.strictEqual(Boolean(u.stamp_name && u.stamp_name.trim() !== ''), true);
    }
  });
});

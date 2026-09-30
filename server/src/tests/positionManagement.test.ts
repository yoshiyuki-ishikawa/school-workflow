import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { resolvePositionHolder, PositionResolverError } from '../workflow/positionResolver';

describe('Position Management & Canonical Resolver Unit Tests', () => {
  let db: any;

  before(() => {
    db = getDb();
    initDatabase();
    seedDatabase();
  });

  it('1. SINGLE_HOLDER 役職の解決: 有効な担当者1名が正常に解決されること', () => {
    const res = resolvePositionHolder({
      positionCode: 'PRINCIPAL',
      effectiveDate: '2026-05-01',
    });
    assert.strictEqual(res.positionCode, 'PRINCIPAL');
    assert.strictEqual(res.displayName, '鈴木 健一 (校長C)');
    assert.strictEqual(res.userId, 4);
  });

  it('2. MULTIPLE_HOLDER 役職の単一承認ルート指定禁止: POSITION_CARDINALITY_MISMATCH で Fail-Closed', () => {
    // 複数担当可能役職をマスタに挿入
    db.prepare(`
      INSERT OR REPLACE INTO positions (id, name, rank_order, holder_type, description)
      VALUES ('GRADE_CHIEF', '学年主任', 50, 'MULTIPLE_HOLDER', '複数教員が就任可能')
    `).run();

    assert.throws(
      () => {
        resolvePositionHolder({
          positionCode: 'GRADE_CHIEF',
          effectiveDate: '2026-05-01',
        });
      },
      (err: any) => {
        return err instanceof PositionResolverError && err.errorCode === 'POSITION_CARDINALITY_MISMATCH';
      }
    );
  });

  it('3. 担当者0名の役職解決: POSITION_HOLDER_NOT_FOUND で Fail-Closed', () => {
    db.prepare(`
      INSERT OR REPLACE INTO positions (id, name, rank_order, holder_type, description)
      VALUES ('VACANT_POS', '空席役職', 99, 'SINGLE_HOLDER', '担当者なし')
    `).run();

    assert.throws(
      () => {
        resolvePositionHolder({
          positionCode: 'VACANT_POS',
          effectiveDate: '2026-05-01',
        });
      },
      (err: any) => {
        return err instanceof PositionResolverError && err.errorCode === 'POSITION_HOLDER_NOT_FOUND';
      }
    );
  });

  it('4. 担当者2名以上（競合状態）の解決: POSITION_HOLDER_AMBIGUOUS で Fail-Closed (LIMIT 1禁止)', () => {
    // 意図的に2名配置
    db.prepare(`
      INSERT OR REPLACE INTO positions (id, name, rank_order, holder_type, description)
      VALUES ('CONFLICT_POS', '競合役職', 98, 'SINGLE_HOLDER', '重複テスト')
    `).run();

    db.prepare(`
      INSERT INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to)
      VALUES (1, 'CONFLICT_POS', 1, '2026-04-01', '9999-12-31'),
             (2, 'CONFLICT_POS', 1, '2026-04-01', '9999-12-31')
    `).run();

    assert.throws(
      () => {
        resolvePositionHolder({
          positionCode: 'CONFLICT_POS',
          effectiveDate: '2026-05-01',
        });
      },
      (err: any) => {
        return err instanceof PositionResolverError && err.errorCode === 'POSITION_HOLDER_AMBIGUOUS';
      }
    );
  });

  it('5. 有効期間外（過去または未来）の担当者は除外されること', () => {
    db.prepare(`
      INSERT OR REPLACE INTO positions (id, name, rank_order, holder_type, description)
      VALUES ('TIME_POS', '時限役職', 97, 'SINGLE_HOLDER', '期間テスト')
    `).run();

    db.prepare(`
      INSERT INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to)
      VALUES (1, 'TIME_POS', 1, '2026-04-01', '2026-04-30')
    `).run();

    // 2026-05-01 時点では終了済みのため 0名 -> POSITION_HOLDER_NOT_FOUND
    assert.throws(
      () => {
        resolvePositionHolder({
          positionCode: 'TIME_POS',
          effectiveDate: '2026-05-01',
        });
      },
      (err: any) => {
        return err instanceof PositionResolverError && err.errorCode === 'POSITION_HOLDER_NOT_FOUND';
      }
    );

    // 2026-04-15 時点では有効
    const res = resolvePositionHolder({
      positionCode: 'TIME_POS',
      effectiveDate: '2026-04-15',
    });
    assert.strictEqual(res.userId, 1);
  });
});

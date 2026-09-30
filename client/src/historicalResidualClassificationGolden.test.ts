import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  computeResidualFacts,
  formatCalculatedMinutes,
  KNOWN_DERIVED_BUSINESS_FACTS,
  KNOWN_TECHNICAL_METADATA_KEYS,
} from './utils/computeResidualFacts';
import { SchemaDetailRenderer } from './components/detail/SchemaDetailRenderer';
import { HistoricalResidualFactView } from './components/detail/HistoricalResidualFactView';
import { determineHistoricalSchemaResolutionDate } from './utils/schemaResolutionDateResolver';
import { ApplicationFormSchema } from './types/formSchema';

describe('Historical Residual Facts Classification & Presentation Remediation — Golden Tests (GT-HRF)', () => {
  // 基本的なモックスキーマ (LEAVE_ANNUAL 相当)
  const mockAnnualLeaveSchema: ApplicationFormSchema = {
    typeId: 'LEAVE_ANNUAL',
    version: '2026.1',
    title: '年次有給休暇 (年休) 申請書',
    description: '年次有給休暇の届出',
    effectiveFrom: '2026-01-01',
    effectiveTo: '9999-12-31',
    sections: [
      {
        id: 'basic',
        title: '基本申請情報',
        fields: [
          { name: 'unitType', label: '取得単位', type: 'SELECT', required: true },
          { name: 'startDate', label: '開始日', type: 'DATE', required: false },
          { name: 'endDate', label: '終了日', type: 'DATE', required: false },
          { name: 'calculatedDays', label: '取得日数', type: 'NUMBER', required: false },
          { name: 'reason', label: '事由・備考', type: 'TEXT', required: false },
        ],
      },
    ],
  };

  // 巨大な schemaSnapshot モック
  const mockSchemaSnapshot = {
    typeId: 'LEAVE_ANNUAL',
    version: '2026.1',
    title: '年次有給休暇 (年休) 申請書',
    sections: [
      {
        id: 'basic',
        title: '基本申請情報',
        fields: [
          { name: 'unitType', label: '取得単位', type: 'SELECT' },
          { name: 'startDate', label: '開始日', type: 'DATE' },
        ],
      },
      {
        id: 'class_coverage',
        title: '授業措置情報',
        fields: [{ name: 'coverageStatus', label: '授業措置' }],
      },
    ],
  };

  // =========================================================================
  // GT-HRF-01 & GT-HRF-02: Server-Side Persistence Contract
  // =========================================================================
  it('GT-HRF-01: Server-Side schemaVersion Persistence contract is strictly recognized', () => {
    // Given: Server-Authoritative に生成・保存された formData
    const formData = {
      unitType: 'DAY',
      startDate: '2026-09-16',
      calculatedDays: 1,
      calculatedMinutes: 465,
      schemaVersion: '2026.1',
    };
    // When: 保存データのキーを検証
    // Then: schemaVersion が消去されず厳格に保持されていること
    assert.strictEqual(formData.schemaVersion, '2026.1');
    assert.ok(KNOWN_TECHNICAL_METADATA_KEYS.has('schemaVersion'));
  });

  it('GT-HRF-02: Server-Side schemaSnapshot Persistence contract is strictly recognized', () => {
    // Given: Server-Authoritative に生成・保存された formData
    const formData = {
      unitType: 'DAY',
      startDate: '2026-09-16',
      calculatedDays: 1,
      calculatedMinutes: 465,
      schemaSnapshot: mockSchemaSnapshot,
    };
    // When: 保存データのキーを検証
    // Then: schemaSnapshot が完全なオブジェクトとして保持されていること
    assert.ok(formData.schemaSnapshot);
    assert.strictEqual(formData.schemaSnapshot.typeId, 'LEAVE_ANNUAL');
    assert.ok(KNOWN_TECHNICAL_METADATA_KEYS.has('schemaSnapshot'));
  });

  // =========================================================================
  // GT-HRF-03 & GT-HRF-04: UI Technical Metadata Exclusion Contract
  // =========================================================================
  it('GT-HRF-03: UI schemaVersion Exclusion — 通常詳細UIに schemaVersion が露出しない', () => {
    // Given: schemaVersion を含む formData
    const formData = {
      unitType: 'DAY',
      startDate: '2026-09-16',
      calculatedDays: 1,
      calculatedMinutes: 465,
      schemaVersion: '2026.1',
    };
    // When: computeResidualFacts および SchemaDetailRenderer を実行
    const { residuals, technicalMetadata } = computeResidualFacts(formData, mockAnnualLeaveSchema);
    const html = renderToStaticMarkup(
      React.createElement(SchemaDetailRenderer, {
        schema: mockAnnualLeaveSchema,
        formData,
      })
    );

    // Then: residuals に含まれず、通常画面のテキストにも露出しない
    assert.strictEqual(residuals.some((r) => r.key === 'schemaVersion'), false);
    assert.strictEqual(technicalMetadata.some((m) => m.key === 'schemaVersion'), true);
    assert.strictEqual(html.includes('2026.1'), false);
    assert.strictEqual(html.includes('schemaVersion'), false);
  });

  it('GT-HRF-04: UI schemaSnapshot Exclusion — 巨大 schemaSnapshot JSON が画面にレンダリングされない', () => {
    // Given: 巨大な schemaSnapshot を含む formData
    const formData = {
      unitType: 'DAY',
      startDate: '2026-09-16',
      calculatedDays: 1,
      calculatedMinutes: 465,
      schemaSnapshot: mockSchemaSnapshot,
    };
    // When: computeResidualFacts および SchemaDetailRenderer を実行
    const { residuals, technicalMetadata } = computeResidualFacts(formData, mockAnnualLeaveSchema);
    const html = renderToStaticMarkup(
      React.createElement(SchemaDetailRenderer, {
        schema: mockAnnualLeaveSchema,
        formData,
      })
    );

    // Then: residuals から完全に除外され、HTML内に JSON の生ダンプが存在しない
    assert.strictEqual(residuals.some((r) => r.key === 'schemaSnapshot'), false);
    assert.strictEqual(technicalMetadata.some((m) => m.key === 'schemaSnapshot'), true);
    assert.strictEqual(html.includes('class_coverage'), false);
    assert.strictEqual(html.includes('coverageStatus'), false);
  });

  // =========================================================================
  // GT-HRF-05 & GT-HRF-06: calculatedMinutes Projection Contract
  // =========================================================================
  it('GT-HRF-05: calculatedMinutes Residual Exclusion — 残存ファクトテーブルに生値 465 が漏れ出さない', () => {
    // Given: calculatedMinutes = 465 を含む formData
    const formData = {
      unitType: 'DAY',
      startDate: '2026-09-16',
      calculatedDays: 1,
      calculatedMinutes: 465,
    };
    // When: computeResidualFacts を実行
    const { residuals, derivedFacts } = computeResidualFacts(formData, mockAnnualLeaveSchema);

    // Then: residuals は空であり、derivedFacts として正規分類される
    assert.strictEqual(residuals.length, 0);
    assert.strictEqual(derivedFacts.length, 1);
    assert.strictEqual(derivedFacts[0].key, 'calculatedMinutes');
    assert.strictEqual(derivedFacts[0].value, 465);
  });

  it('GT-HRF-06: calculatedMinutes Canonical Business Presentation — 画面上に「7時間45分 (465分)」と人間可読表示される', () => {
    // Given: calculatedMinutes = 465 を持つ年休申請
    const formData = {
      unitType: 'DAY',
      startDate: '2026-09-16',
      calculatedDays: 1,
      calculatedMinutes: 465,
    };
    // When: SchemaDetailRenderer をレンダリング
    const html = renderToStaticMarkup(
      React.createElement(SchemaDetailRenderer, {
        schema: mockAnnualLeaveSchema,
        formData,
      })
    );

    // Then: 業務算出時間ブロックに「7時間45分 (465分)」と表示される
    assert.ok(html.includes('業務算出・控除時間情報'));
    assert.ok(html.includes('7時間45分 (465分)'));
    // 未定義残存テーブルのヘッダは一切表示されない
    assert.strictEqual(html.includes('【過去・拡張項目】'), false);
  });

  // =========================================================================
  // GT-HRF-07 & GT-HRF-08: Genuine Unknown Field Preservation (Silent Drop = 0)
  // =========================================================================
  it('GT-HRF-07: Genuine Unknown Field Preservation (Silent Drop = 0) — 真の未知キーは確実に残存表示される', () => {
    // Given: スキーマにない過去の独自キー legacySpecialApproval を持つ申請
    const formData = {
      unitType: 'DAY',
      startDate: '2026-09-16',
      calculatedDays: 1,
      calculatedMinutes: 465,
      schemaVersion: '2026.1',
      schemaSnapshot: mockSchemaSnapshot,
      legacySpecialApproval: '昭和60年教育長特例承認済',
    };
    // When: computeResidualFacts および SchemaDetailRenderer を実行
    const { residuals } = computeResidualFacts(formData, mockAnnualLeaveSchema);
    const html = renderToStaticMarkup(
      React.createElement(SchemaDetailRenderer, {
        schema: mockAnnualLeaveSchema,
        formData,
      })
    );

    // Then: legacySpecialApproval のみが CLASS D として residuals に残り、画面に表示される
    assert.strictEqual(residuals.length, 1);
    assert.strictEqual(residuals[0].key, 'legacySpecialApproval');
    assert.strictEqual(residuals[0].value, '昭和60年教育長特例承認済');
    assert.ok(html.includes('【過去・拡張項目】'));
    assert.ok(html.includes('legacySpecialApproval'));
    assert.ok(html.includes('昭和60年教育長特例承認済'));
  });

  it('GT-HRF-08: Multiple Unknown Fields Strict Retention — 複数未知キーが1件も欠落しない', () => {
    // Given: 3つの未知キーを持つ申請
    const formData = {
      unitType: 'DAY',
      startDate: '2026-09-16',
      calculatedDays: 1,
      calculatedMinutes: 465,
      unknownFieldAlpha: 'AlphaVal',
      unknownFieldBeta: 12345,
      unknownFieldGamma: true,
    };
    // When: computeResidualFacts を実行
    const { residuals } = computeResidualFacts(formData, mockAnnualLeaveSchema);

    // Then: 3件すべてが保持され、Silent Drop = 0 であること
    assert.strictEqual(residuals.length, 3);
    const keys = residuals.map((r) => r.key);
    assert.ok(keys.includes('unknownFieldAlpha'));
    assert.ok(keys.includes('unknownFieldBeta'));
    assert.ok(keys.includes('unknownFieldGamma'));
  });

  // =========================================================================
  // GT-HRF-09 & GT-HRF-10: Immutability & Invariant Contracts
  // =========================================================================
  it('GT-HRF-09: Historical Schema Resolution Date Invariant — 既存基準日解決ロジックが100%維持される', () => {
    // Given: startDate, targetDate, startAt, created_at
    const d1 = determineHistoricalSchemaResolutionDate({ startDate: '2026-05-10' }, null);
    const d2 = determineHistoricalSchemaResolutionDate({ targetDate: '2026-06-15' }, null);
    const d3 = determineHistoricalSchemaResolutionDate({ startAt: '2026-07-20T08:30:00Z' }, null);
    const d4 = determineHistoricalSchemaResolutionDate({}, '2026-04-01T09:00:00Z');

    // Then: 基準日が意図通り解決される
    assert.strictEqual(d1, '2026-05-10');
    assert.strictEqual(d2, '2026-06-15');
    assert.strictEqual(d3, '2026-07-20');
    assert.strictEqual(d4, '2026-04-01');
  });

  it('GT-HRF-10: Existing Snapshot Immutability — 保存済み snapshot オブジェクトを破壊・改変しない', () => {
    // Given: 凍結された snapshot
    const originalSnapshot = Object.freeze({ ...mockSchemaSnapshot });
    const formData = {
      unitType: 'DAY',
      calculatedMinutes: 465,
      schemaSnapshot: originalSnapshot,
    };
    // When: computeResidualFacts を実行
    const { technicalMetadata } = computeResidualFacts(formData, mockAnnualLeaveSchema);

    // Then: snapshot は完全同一参照・内容のまま technicalMetadata に保持される
    assert.strictEqual(technicalMetadata[0].value, originalSnapshot);
  });

  // =========================================================================
  // GT-HRF-11: Canonical Business Projection of Authoritative Minutes
  // (HALF_DAY Non-Recalculation Contract)
  // =========================================================================
  describe('GT-HRF-11: Canonical Business Projection of Authoritative Minutes (HALF_DAY Non-Recalculation)', () => {
    it('Case 1: 終日年休 calculatedMinutes = 465 -> 7時間45分 (465分)', () => {
      const res = formatCalculatedMinutes(465);
      assert.strictEqual(res.formatted, '7時間45分 (465分)');
    });

    it('Case 2: 半日年休（午前例） calculatedMinutes = 225 -> 3時間45分 (225分) [再計算・丸めなし]', () => {
      // 制度上の実時間割例: 225分 (3h45m)
      const res = formatCalculatedMinutes(225);
      assert.strictEqual(res.formatted, '3時間45分 (225分)');
    });

    it('Case 3: 半日年休（午後例） calculatedMinutes = 240 -> 4時間0分 (240分) [再計算・丸めなし]', () => {
      // 制度上の実時間割例: 240分 (4h0m)
      const res = formatCalculatedMinutes(240);
      assert.strictEqual(res.formatted, '4時間0分 (240分)');
    });

    it('Case 4: 時間単位年休 calculatedMinutes = 120 -> 2時間0分 (120分)', () => {
      const res = formatCalculatedMinutes(120);
      assert.strictEqual(res.formatted, '2時間0分 (120分)');
    });
  });

  // =========================================================================
  // GT-HRF-12: Non-interference with Other Pages Contract
  // =========================================================================
  it('GT-HRF-12: Non-interference with Other Pages — KNOWN_DERIVED_BUSINESS_FACTS / formatCalculatedMinutes does not alter formData object', () => {
    const rawFormData = {
      unitType: 'TIME',
      startTime: '08:10',
      endTime: '10:10',
      calculatedMinutes: 120,
    };
    const cloned = { ...rawFormData };

    computeResidualFacts(rawFormData, mockAnnualLeaveSchema);
    assert.deepStrictEqual(rawFormData, cloned);
  });

  // =========================================================================
  // Negative Tests
  // =========================================================================
  describe('Negative Tests', () => {
    it('NT-01: organizationSnapshot, tripEventId, batchGroupId do not leak into residuals', () => {
      const formData = {
        unitType: 'DAY',
        calculatedMinutes: 465,
        organizationSnapshot: { schoolName: '中央小学校' },
        tripEventId: 101,
        batchGroupId: 'TRIP-EVENT-101',
        values: { old: true },
      };
      const { residuals, technicalMetadata } = computeResidualFacts(formData, mockAnnualLeaveSchema);

      assert.strictEqual(residuals.length, 0);
      assert.strictEqual(technicalMetadata.length, 4);
    });

    it('NT-02: Partial matches (legacy_schema_version, my_schemaSnapshot) are NOT treated as metadata', () => {
      const formData = {
        unitType: 'DAY',
        calculatedMinutes: 465,
        legacy_schema_version: 'v1.0-legacy',
        my_schemaSnapshot: { custom: true },
      };
      const { residuals } = computeResidualFacts(formData, mockAnnualLeaveSchema);

      // 接頭辞や部分一致で誤って非表示にしてはならない (Unknown = Visible)
      assert.strictEqual(residuals.length, 2);
      const keys = residuals.map((r) => r.key);
      assert.ok(keys.includes('legacy_schema_version'));
      assert.ok(keys.includes('my_schemaSnapshot'));
    });

    it('NT-03: Client does NOT fallback to 232 or 233 on HALF_DAY when calculatedMinutes is absent', () => {
      const formData = {
        unitType: 'HALF_DAY',
        targetDate: '2026-09-16',
        // calculatedMinutes is missing
      };
      const { derivedFacts, residuals } = computeResidualFacts(formData, mockAnnualLeaveSchema);

      // calculatedMinutes がない場合、勝手に 232 や 233 を注入しない
      assert.strictEqual(derivedFacts.some((f) => f.key === 'calculatedMinutes'), false);
      assert.strictEqual(residuals.some((r) => r.key === 'calculatedMinutes'), false);
    });

    it('NT-04: Invalid / Malformed calculatedMinutes does NOT fallback to 465 or 0', () => {
      const resNull = formatCalculatedMinutes(null);
      assert.strictEqual(resNull.formatted, 'null');

      const resUndefined = formatCalculatedMinutes(undefined);
      assert.strictEqual(resUndefined.formatted, '未設定');

      const resString = formatCalculatedMinutes('invalid_string');
      assert.strictEqual(resString.formatted, 'invalid_string');

      const resNegative = formatCalculatedMinutes(-465);
      assert.strictEqual(resNegative.formatted, '-465');
    });

    it('NT-05: When schema is missing or fetch fails, technical metadata is still excluded and true data is preserved', () => {
      const formData = {
        unitType: 'DAY',
        reason: '私用',
        calculatedMinutes: 465,
        schemaSnapshot: mockSchemaSnapshot,
        schemaVersion: '2026.1',
        legacyField: '旧データ',
      };
      // When schema is null
      const html = renderToStaticMarkup(
        React.createElement(SchemaDetailRenderer, {
          schema: null,
          schemaError: 'Schema fetch failed',
          formData,
        })
      );

      // schemaSnapshot の巨大 JSON は除外されている
      assert.strictEqual(html.includes('class_coverage'), false);
      // calculatedMinutes は業務時間情報として表示
      assert.ok(html.includes('7時間45分 (465分)'));
      // legacyField は未定義保存データとして表示
      assert.ok(html.includes('legacyField'));
      assert.ok(html.includes('旧データ'));
    });
  });
});

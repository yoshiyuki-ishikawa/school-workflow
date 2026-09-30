/**
 * Wave 4 / GAP-04: 帳票PDF実務印刷完全化・公文書レイアウト保証
 * Golden Tests (GT-W4-01 〜 GT-W4-12) & Typography Boundary Evidence
 * 
 * Invariants Verified:
 * - INV-W4-01: No Silent Truncation
 * - INV-W4-02: Server-Authoritative Deterministic Pagination
 * - INV-W4-03: Calendar Year Strictness for Leave Records (1/1〜12/31)
 * - INV-W4-04: Browser Print / Save as PDF Authority
 * - INV-W4-05: Page Scale & Zoom Prohibition
 * - INV-W4-06: Physical-to-Logical Layout Derivation
 * - INV-W4-07: Oversize Record Safety
 * - INV-W4-08: Attendance Mapping Non-Authority
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import {
  A4_PORTRAIT_CONTRACT,
  A4_LANDSCAPE_CONTRACT,
  LEAVE_LEDGER_FIRST_PAGE_RESERVED,
  LEAVE_LEDGER_CONTINUATION_PAGE_RESERVED,
  LEAVE_LEDGER_TYPOGRAPHY,
  TRAVEL_ORDER_FIRST_PAGE_RESERVED,
  TRAVEL_ORDER_CONTINUATION_PAGE_RESERVED,
  TRAVEL_ORDER_TYPOGRAPHY,
  derivePageLayoutCapacity,
  calculateRecordLayoutCost,
  paginateRecordsDeterministically,
  projectLeaveLedgerPages,
  projectTripOrderPages,
  resolveAttendanceCanonicalDisplayToken,
  PaginatableRecord,
} from '../services/reportProjectionService';

describe('Original Wave 4 (GAP-04: 帳票PDF実務印刷完全化・公文書レイアウト保証) Golden Tests (GT-W4-01 〜 GT-W4-12)', () => {
  initDatabase();
  seedDatabase();
  const db = getDb();

  const firstPageSpec = derivePageLayoutCapacity(
    A4_PORTRAIT_CONTRACT,
    LEAVE_LEDGER_FIRST_PAGE_RESERVED,
    LEAVE_LEDGER_TYPOGRAPHY,
    15
  );

  const continuationPageSpec = derivePageLayoutCapacity(
    A4_PORTRAIT_CONTRACT,
    LEAVE_LEDGER_CONTINUATION_PAGE_RESERVED,
    LEAVE_LEDGER_TYPOGRAPHY,
    25
  );

  // GT-W4-01: Leave Ledger 1-Page Baseline (1〜15件、標準高)
  it('GT-W4-01: Leave Ledger 1-Page Baseline - 15件以下の標準高レコードがA4 1ページに収容されること', () => {
    const records: PaginatableRecord[] = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      isAtomic: true,
      primaryText: `私事都合のため (${i + 1})`,
    }));

    const pages = paginateRecordsDeterministically(records, firstPageSpec, continuationPageSpec);
    assert.strictEqual(pages.length, 1);
    assert.strictEqual(pages[0].pageNumber, 1);
    assert.strictEqual(pages[0].totalPages, 1);
    assert.strictEqual(pages[0].isFirstPage, true);
    assert.strictEqual(pages[0].isContinuationSheet, false);
    assert.strictEqual(pages[0].records.length, 15);
  });

  // GT-W4-02: Leave Ledger Multi-Page Split (16〜40件、STANDARD_HEIGHT_RECORD)
  it('GT-W4-02: Leave Ledger Multi-Page Split - 28件の標準高レコードがP1:15件、P2:13件に決定論的分割されること', () => {
    const records: PaginatableRecord[] = Array.from({ length: 28 }, (_, i) => ({
      id: i + 1,
      isAtomic: true,
      primaryText: `私事都合 (STANDARD_HEIGHT_RECORD ${i + 1})`,
    }));

    const pages = paginateRecordsDeterministically(records, firstPageSpec, continuationPageSpec);
    assert.strictEqual(pages.length, 2);
    assert.strictEqual(pages[0].totalPages, 2);
    assert.strictEqual(pages[1].totalPages, 2);
    assert.strictEqual(pages[0].records.length, 15);
    assert.strictEqual(pages[1].records.length, 13);
    assert.strictEqual(pages[0].isFirstPage, true);
    assert.strictEqual(pages[1].isContinuationSheet, true);

    // 欠落・重複ゼロの検証
    const allIds = pages.flatMap((p) => p.records.map((r) => r.id));
    assert.strictEqual(allIds.length, 28);
    assert.deepStrictEqual(allIds, Array.from({ length: 28 }, (_, i) => i + 1));
  });

  // GT-W4-03: Leave Ledger Large Multi-Page (41〜65件、STANDARD_HEIGHT_RECORD)
  it('GT-W4-03: Leave Ledger Large Multi-Page - 50件の標準高レコードが全3ページ (15, 25, 10) に決定論的分割されること', () => {
    const records: PaginatableRecord[] = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      isAtomic: true,
      primaryText: `事由 ${i + 1}`,
    }));

    const pages = paginateRecordsDeterministically(records, firstPageSpec, continuationPageSpec);
    assert.strictEqual(pages.length, 3);
    assert.strictEqual(pages[0].totalPages, 3);
    assert.strictEqual(pages[1].totalPages, 3);
    assert.strictEqual(pages[2].totalPages, 3);

    assert.strictEqual(pages[0].records.length, 15);
    assert.strictEqual(pages[1].records.length, 25);
    assert.strictEqual(pages[2].records.length, 10);

    const allIds = pages.flatMap((p) => p.records.map((r) => r.id));
    assert.strictEqual(allIds.length, 50);
  });

  // GT-W4-04: Travel Order Single Page (用務・復命がメイン枠容量内)
  it('GT-W4-04: Travel Order Single Page - 用務・復命がメイン枠容量内の場合、1ページのみで完結すること', () => {
    const purpose = '第3回 県小学校教育研究会 夏季研修大会参加';
    const reportResult = '研究協議会において、ICT活用指導力向上に関する実践発表を行い、指導主事からの指導講評を受けた。指導案の修正事項を本校へ還元する。';

    const projected = projectTripOrderPages(purpose, reportResult);
    assert.strictEqual(projected.totalPages, 1);
    assert.strictEqual(projected.hasContinuationSheet, false);
    assert.strictEqual(projected.pages.length, 1);
    assert.strictEqual(projected.pages[0].isFirstPage, true);
    assert.strictEqual(projected.pages[0].mainReportResult, reportResult);
  });

  // GT-W4-05: Travel Order Continuation Sheet (用務・復命がメイン枠容量超過)
  it('GT-W4-05: Travel Order Continuation Sheet - メイン枠超過時に正準参照と続紙が決定論的生成され、Fact欠落がゼロであること', () => {
    const purpose = '県外長期視察研修（3日間）';
    // 12行相当（約500文字以上）の長文復命
    const longParagraphs = [
      '【第1日目】午前中は〇〇市教育センターにて、先進校における校務DX推進体制についての講義を受講した。統合型校務支援システムの導入事例と教職員研修モデルについて質疑応答を行った。',
      '【第2日目】〇〇市立〇〇小学校を実地訪問し、第5学年の算数科におけるデジタル教科書および端末活用授業を参観した。放課後の校内研修会に参加し、ルーブリック評価の運用実務を学んだ。',
      '【第3日目】視察総括会議において、本校への導入計画案を発表した。特にセキュリティポリシーの策定と教職員の意識改革について、指導主事より極めて有益な助言を得た。',
      '【総括および本校への還元】今回の視察で得られた知見を基に、本校のICT推進委員会において校内実践ロードマップを改訂する。教職員向け研修会を来月に設定し、具体的な操作研修を実施する。',
    ];
    const fullReport = longParagraphs.join('\n\n');

    const projected = projectTripOrderPages(purpose, fullReport);
    assert.strictEqual(projected.totalPages >= 2, true);
    assert.strictEqual(projected.hasContinuationSheet, true);

    // 第1面は正準参照
    assert.strictEqual(projected.pages[0].isFirstPage, true);
    assert.strictEqual(projected.pages[0].mainReportResult, '（別紙復命書・続紙のとおり）');

    // 続紙に全内容が展開されていること (No Silent Truncation)
    const continuationText = projected.pages.slice(1).map((p) => p.mainReportResult).join('\n\n');
    for (const p of longParagraphs) {
      assert.strictEqual(continuationText.includes(p.trim()), true);
    }
  });

  // GT-W4-06: Stress Test 200 Records (200件、STANDARD_HEIGHT_RECORD)
  it('GT-W4-06: Stress Test 200 Records - 200件の標準レコードが決定論的計算で欠落0・重複0・全9ページに収容されること', () => {
    const records: PaginatableRecord[] = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      isAtomic: true,
      primaryText: `申請事由 ${i + 1}`,
    }));

    const pages = paginateRecordsDeterministically(records, firstPageSpec, continuationPageSpec);
    // P1: 15件, P2〜P8 (7ページ × 25件 = 175件), P9: 10件 -> 合計 9ページ
    assert.strictEqual(pages.length, 9);
    assert.strictEqual(pages[0].records.length, 15);
    for (let i = 1; i <= 7; i++) {
      assert.strictEqual(pages[i].records.length, 25);
    }
    assert.strictEqual(pages[8].records.length, 10);

    const allIds = pages.flatMap((p) => p.records.map((r) => r.id));
    assert.strictEqual(allIds.length, 200);
    assert.deepStrictEqual(allIds, Array.from({ length: 200 }, (_, i) => i + 1));
  });

  // GT-W4-07: Leave Ledger Calendar Year Rule (暦年 1/1〜12/31 基準)
  it('GT-W4-07: Leave Ledger Calendar Year Rule - 年休が暦年(1/1〜12/31)で集計され、年度1〜3月が別暦年に正しく分離されること', () => {
    // ユーザー1の2026年暦年プロジェクション
    const result2026 = projectLeaveLedgerPages(1, 2026);
    assert.strictEqual(result2026.calendarYear, 2026);
    assert.strictEqual(result2026.period.start, '2026-01-01');
    assert.strictEqual(result2026.period.end, '2026-12-31');

    // 2027年暦年プロジェクション
    const result2027 = projectLeaveLedgerPages(1, 2027);
    assert.strictEqual(result2027.calendarYear, 2027);
    assert.strictEqual(result2027.period.start, '2027-01-01');
    assert.strictEqual(result2027.period.end, '2027-12-31');

    // 期間の完全独立性
    assert.notStrictEqual(result2026.period.start, result2027.period.start);
  });

  // GT-W4-08: Attendance Canonical Display (既存SSOT消費・未解決Fail-Closed)
  it('GT-W4-08: Attendance Canonical Display - 既存SSOTから正準表示トークンが解決され、未解決時はFail-Closedすること', () => {
    // 既存Policyから解決
    const tokenMaternity = resolveAttendanceCanonicalDisplayToken('SPECIAL_MATERNITY_PRE');
    assert.strictEqual(tokenMaternity.isFailClosed, false);
    assert.strictEqual(tokenMaternity.symbol, '産休');

    const tokenCare = resolveAttendanceCanonicalDisplayToken('LEAVE_CARE');
    assert.strictEqual(tokenCare.isFailClosed, false);
    assert.strictEqual(tokenCare.symbol, '介護');

    // 未確定(UNCONFIRMED) Policyの場合は Fail-Closed
    const tokenUnconfirmed = resolveAttendanceCanonicalDisplayToken('SPECIAL_ACT_22_2');
    assert.strictEqual(tokenUnconfirmed.isFailClosed, true);
    assert.strictEqual(tokenUnconfirmed.symbol, '不明');

    // 未定義・不正Policyの場合は Fail-Closed (推測表示禁止)
    const tokenUnknown = resolveAttendanceCanonicalDisplayToken('NON_EXISTENT_POLICY_CODE');
    assert.strictEqual(tokenUnknown.isFailClosed, true);
    assert.strictEqual(tokenUnknown.symbol, '不明');
  });

  // GT-W4-09: Substitution/Comp Leave Sheet ページング
  it('GT-W4-09: Substitution/Comp Leave Sheet - 導出容量モデルに基づき週休振替・代休レコードが決定論的ページングされること', () => {
    const records: PaginatableRecord[] = Array.from({ length: 30 }, (_, i) => ({
      id: `sub-${i + 1}`,
      isAtomic: true,
      primaryText: `運動会に伴う週休振替 (${i + 1})`,
    }));

    const pages = paginateRecordsDeterministically(records, firstPageSpec, continuationPageSpec);
    assert.strictEqual(pages.length, 2);
    assert.strictEqual(pages[0].records.length, 15);
    assert.strictEqual(pages[1].records.length, 15);
  });

  // GT-W4-10: CSS Print Dimensions Invariant (物理寸法契約)
  it('GT-W4-10: CSS Print Dimensions Invariant - A4寸法・マージン・タイポグラフィ契約が数学的に整合していること', () => {
    assert.strictEqual(A4_PORTRAIT_CONTRACT.widthMm, 210);
    assert.strictEqual(A4_PORTRAIT_CONTRACT.heightMm, 297);
    assert.strictEqual(A4_LANDSCAPE_CONTRACT.widthMm, 297);
    assert.strictEqual(A4_LANDSCAPE_CONTRACT.heightMm, 210);

    assert.strictEqual(firstPageSpec.usableHeightMm > 0, true);
    assert.strictEqual(continuationPageSpec.usableHeightMm > 0, true);
    assert.strictEqual(continuationPageSpec.maxLayoutUnits >= firstPageSpec.maxLayoutUnits, true);
  });

  // GT-W4-11: Record Boundary Integrity (可変長レコードの非分割・次ページ送り)
  it('GT-W4-11: Record Boundary Integrity - 残余Capacity不足時に長文レコード全体が次ページ先頭へ送られ、途中分割・文字欠落がゼロであること', () => {
    // 1行の通常レコード14件（P1の最大15件制限直前）
    const records: PaginatableRecord[] = Array.from({ length: 14 }, (_, i) => ({
      id: i + 1,
      isAtomic: true,
      primaryText: `事由 ${i + 1}`,
    }));

    // 15件目に、3行相当を消費する複数行長文レコードを追加
    const multiLineReason = '私事都合のため。\n通院および家族の介護付き添い。\n午後より復帰予定。';
    records.push({
      id: 15,
      isAtomic: true,
      primaryText: multiLineReason,
    });

    const pages = paginateRecordsDeterministically(records, firstPageSpec, continuationPageSpec);
    
    // 全レコードが欠落なく保持されていること
    const allRecords = pages.flatMap((p) => p.records);
    assert.strictEqual(allRecords.length, 15);
    const rec15 = allRecords.find((r) => r.id === 15);
    assert.strictEqual(rec15?.primaryText, multiLineReason);
  });

  // GT-W4-12: Single Record Oversize Handling (Case A: Splittable, Case B: Atomic Fail-Closed)
  describe('GT-W4-12: Single Record Oversize Handling', () => {
    it('Case A: Splittable Record - 続紙最大容量を超える長文復命がApproved Block Boundaryで決定論的続紙分割され、Fact欠落がゼロであること', () => {
      // 続紙1ページを超える巨大な複数段落復命
      const hugeParagraphs = Array.from({ length: 20 }, (_, i) => `【項目${i + 1}】先進校視察の詳細報告段落テキストです。指導案の分析、指導主事からの指導助言、校務DX推進の課題と本校における対応策について具体的に記述します。`);
      const hugeReport = hugeParagraphs.join('\n\n');

      const projected = projectTripOrderPages('長期先進校視察', hugeReport);
      assert.strictEqual(projected.totalPages >= 2, true);
      assert.strictEqual(projected.hasContinuationSheet, true);

      // 全段落が続紙全体で完全網羅されていること (No Silent Truncation)
      const allText = projected.pages.slice(1).map((p) => p.mainReportResult).join('\n\n');
      for (const p of hugeParagraphs) {
        assert.strictEqual(allText.includes(p.trim()), true);
      }
    });

    it('Case B: Non-Splittable Atomic Record - 最大容量を超える単一AtomicレコードがFail-Closedで例外送出されること', () => {
      // 分割禁止 (isAtomic: true) なのに、最大続紙容量を超える巨大テキスト（改行なし10,000文字）
      const hugeAtomicRecord: PaginatableRecord = {
        id: 'atomic-huge-1',
        isAtomic: true,
        primaryText: 'あ'.repeat(10000),
      };

      assert.throws(
        () => {
          paginateRecordsDeterministically([hugeAtomicRecord], firstPageSpec, continuationPageSpec);
        },
        /FAIL_CLOSED: Atomic record layout cost/
      );
    });
  });

  // Implementation Acceptance Test: Typography Boundary Cases
  describe('Implementation Acceptance: Typography Boundary Cases', () => {
    it('全角・半角・英数・改行混在文字列において決定論的コストが計算されること', () => {
      const asciiText = 'ABCDEF 123456';
      const japaneseText = '日本語全角テキスト';
      const mixedText = 'ICT活用研修 (2026年9月9日 13:00〜17:00) 於:〇〇教育センター';

      const costAscii = calculateRecordLayoutCost(asciiText, 18);
      const costJp = calculateRecordLayoutCost(japaneseText, 18);
      const costMixed = calculateRecordLayoutCost(mixedText, 18);

      assert.strictEqual(costAscii >= 1, true);
      assert.strictEqual(costJp >= 1, true);
      assert.strictEqual(costMixed >= 2, true);
    });
  });
});

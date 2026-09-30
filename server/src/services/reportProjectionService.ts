/**
 * Server-Authoritative Document Layout Contract & Deterministic Pagination Engine
 * Wave 4 / GAP-04: 帳票PDF実務印刷完全化・公文書レイアウト保証
 * 
 * Invariants:
 * - INV-W4-01: No Silent Truncation（無言切り捨て絶対禁止）
 * - INV-W4-02: Server-Authoritative Deterministic Pagination（決定論的ページ分割）
 * - INV-W4-03: Calendar Year Strictness for Leave Records（年休暦年1/1〜12/31厳守）
 * - INV-W4-06: Physical-to-Logical Layout Derivation（物理・タイポグラフィ契約からの容量導出）
 * - INV-W4-07: Oversize Record Safety（Whole Record Move -> Approved Block Split -> Fail-Closed）
 * - INV-W4-08: Attendance Mapping Non-Authority（出勤簿マッピング非Authority化・既存SSOT消費・未解決Fail-Closed）
 */

import { getDb } from '../db/database';
import { resolveAttendancePolicy } from './attendance/resolvers';

/**
 * 物理用紙寸法・印刷安全余白仕様契約
 */
export interface PhysicalDocumentContract {
  paperSize: 'A4';
  orientation: 'PORTRAIT' | 'LANDSCAPE';
  widthMm: number;        // A4 Portrait: 210, Landscape: 297
  heightMm: number;       // A4 Portrait: 297, Landscape: 210
  marginTopMm: number;    // 印刷安全余白 (上)
  marginBottomMm: number; // 印刷安全余白 (下)
  marginLeftMm: number;   // 印刷安全余白 (左)
  marginRightMm: number;  // 印刷安全余白 (右)
}

/**
 * 標準物理契約定数 (A4 Portrait / Landscape)
 */
export const A4_PORTRAIT_CONTRACT: PhysicalDocumentContract = {
  paperSize: 'A4',
  orientation: 'PORTRAIT',
  widthMm: 210,
  heightMm: 297,
  marginTopMm: 12,
  marginBottomMm: 12,
  marginLeftMm: 15,
  marginRightMm: 15,
};

export const A4_LANDSCAPE_CONTRACT: PhysicalDocumentContract = {
  paperSize: 'A4',
  orientation: 'LANDSCAPE',
  widthMm: 297,
  heightMm: 210,
  marginTopMm: 12,
  marginBottomMm: 12,
  marginLeftMm: 15,
  marginRightMm: 15,
};

/**
 * 予約領域寸法契約 (Header, ColumnHeader, Summary, Footer)
 */
export interface ReservedAreaContract {
  headerHeightMm: number;       // 表題・公印・決裁欄・申請者情報領域
  columnHeaderHeightMm: number; // 表見出し行領域
  summaryHeightMm: number;      // 合計・残日数・備考フッター領域
  footerHeightMm: number;       // ページ番号・監査メタデータ領域
}

/**
 * タイポグラフィ契約
 */
export interface TypographyContract {
  fontFamily: string;
  fontSizePt: number;
  lineHeightMm: number;         // 1行あたりの高さ (mm)
  cellPaddingMm: number;        // セル上下パディング (mm)
  charsPerLine: number;         // 1行あたりの正準全角文字数 (セル幅に基づく)
}

/**
 * ページレイアウト容量仕様 (導出結果)
 */
export interface PageCapacitySpec {
  maxPhysicalRecords: number;   // 1ページあたりの最大物理レコード数
  maxLayoutUnits: number;       // 1ページあたりの最大レイアウト容量ユニット (行数相当)
  unitPerLine: number;          // 1行あたりの消費ユニット (標準 = 1)
  charsPerLine: number;         // 1行あたりの文字数
  usableHeightMm: number;       // 有効レコード領域高さ (mm)
}

/**
 * 物理契約・予約領域・タイポグラフィから論理レイアウト容量を決定論的に導出 (INV-W4-06)
 */
export function derivePageLayoutCapacity(
  physical: PhysicalDocumentContract,
  reserved: ReservedAreaContract,
  typography: TypographyContract,
  maxPhysicalRecordsLimit: number
): PageCapacitySpec {
  const totalReservedHeightMm =
    physical.marginTopMm +
    physical.marginBottomMm +
    reserved.headerHeightMm +
    reserved.columnHeaderHeightMm +
    reserved.summaryHeightMm +
    reserved.footerHeightMm;

  const usableHeightMm = physical.heightMm - totalReservedHeightMm;
  if (usableHeightMm <= 0) {
    throw new Error('FAIL_CLOSED: Usable record area height is non-positive. Invalid layout contract.');
  }

  const effectiveRowHeightMm = typography.lineHeightMm + (typography.cellPaddingMm * 2);
  const maxLogicalLines = Math.floor(usableHeightMm / effectiveRowHeightMm);

  if (maxLogicalLines <= 0) {
    throw new Error('FAIL_CLOSED: Derived maxLayoutUnits is zero or negative.');
  }

  return {
    maxPhysicalRecords: maxPhysicalRecordsLimit,
    maxLayoutUnits: maxLogicalLines,
    unitPerLine: 1,
    charsPerLine: typography.charsPerLine,
    usableHeightMm,
  };
}

/**
 * 各種帳票の Document Layout Contracts (物理寸法・予約領域・タイポグラフィのSSOT)
 */
export const LEAVE_LEDGER_FIRST_PAGE_RESERVED: ReservedAreaContract = {
  headerHeightMm: 45,       // 表題 + 所属氏名印影欄
  columnHeaderHeightMm: 12, // 表見出し
  summaryHeightMm: 35,      // 休暇取得状況・残数サマリー表 + 今回申請明細固定ヘッダ
  footerHeightMm: 18,       // 決裁・監査証跡署名
};

export const LEAVE_LEDGER_CONTINUATION_PAGE_RESERVED: ReservedAreaContract = {
  headerHeightMm: 18,       // 続紙表題・所属氏名簡略欄
  columnHeaderHeightMm: 10, // 表見出し
  summaryHeightMm: 0,       // 続紙はサマリーなし
  footerHeightMm: 15,       // ページ番号・監査メタデータ
};

export const LEAVE_LEDGER_TYPOGRAPHY: TypographyContract = {
  fontFamily: "'Hiragino Mincho ProN', 'Yu Mincho', 'IPAexMincho', 'MS Mincho', serif",
  fontSizePt: 10,
  lineHeightMm: 6.0,
  cellPaddingMm: 1.5, // 有効行高: 6.0 + 2*1.5 = 9.0mm -> FirstPage: floor(163/9)=18 >= 15, ContPage: floor(230/9)=25
  charsPerLine: 18, // 理由欄セル幅約 60mm における全角収容文字数
};

export const TRAVEL_ORDER_FIRST_PAGE_RESERVED: ReservedAreaContract = {
  headerHeightMm: 20,       // 表題
  columnHeaderHeightMm: 0,
  summaryHeightMm: 0,
  footerHeightMm: 15,       // 監査メタデータ
};

export const TRAVEL_ORDER_CONTINUATION_PAGE_RESERVED: ReservedAreaContract = {
  headerHeightMm: 25,       // 続紙表題・旅行者情報
  columnHeaderHeightMm: 0,
  summaryHeightMm: 0,
  footerHeightMm: 15,       // 監査メタデータ
};

export const TRAVEL_ORDER_TYPOGRAPHY: TypographyContract = {
  fontFamily: "'Hiragino Mincho ProN', 'Yu Mincho', 'IPAexMincho', 'MS Mincho', serif",
  fontSizePt: 10,
  lineHeightMm: 6.5,
  cellPaddingMm: 1.5,
  charsPerLine: 42, // Landscape A4 復命枠全幅における全角文字数
};

/**
 * レコードのレイアウトコスト算出（決定論的）
 * - 日本語全角・半角・改行文字を考慮して消費行数を厳密計算
 */
export function calculateRecordLayoutCost(
  text: string,
  charsPerLine: number,
  unitPerLine: number = 1
): number {
  if (!text || text.trim().length === 0) return unitPerLine;
  
  const lines = text.split(/\r\n|\r|\n/);
  let totalVisualLines = 0;

  for (const line of lines) {
    if (line.length === 0) {
      totalVisualLines += 1;
      continue;
    }
    // 全角=1, 半角=0.5 として等価全角文字幅を計算
    let visualWidth = 0;
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      // 半角英数・半角カナ・ASCII制御文字
      if ((code >= 0x0020 && code <= 0x007e) || (code >= 0xff61 && code <= 0xff9f)) {
        visualWidth += 0.5;
      } else {
        visualWidth += 1.0;
      }
    }
    const visualLines = Math.max(1, Math.ceil(visualWidth / charsPerLine));
    totalVisualLines += visualLines;
  }

  return totalVisualLines * unitPerLine;
}

/**
 * ページ分割対象レコードの抽象インターフェース
 */
export interface PaginatableRecord {
  id: string | number;
  isAtomic: boolean;                        // true: 分割禁止 (Atomic Record), false: 承認済みブロック分割可
  primaryText: string;                     // レイアウトコスト計算対象の主要テキスト
  secondaryText?: string;
  splittableBlocks?: string[];             // 承認済み分割可能コンテンツブロック (Approved Splittable Blocks)
  metadata?: Record<string, any>;
}

/**
 * ページDTO (Server-Authoritative Pagination Result)
 */
export interface ProjectedDocumentPage<T extends PaginatableRecord = PaginatableRecord> {
  pageNumber: number;
  totalPages: number;
  isFirstPage: boolean;
  isContinuationSheet: boolean;
  records: T[];
  consumedUnits: number;
  maxUnits: number;
}

/**
 * 決定論的ページ分割アルゴリズム (INV-W4-02, INV-W4-07)
 */
export function paginateRecordsDeterministically<T extends PaginatableRecord>(
  records: T[],
  firstPageSpec: PageCapacitySpec,
  continuationPageSpec: PageCapacitySpec
): ProjectedDocumentPage<T>[] {
  const pages: ProjectedDocumentPage<T>[] = [];
  
  if (!records || records.length === 0) {
    return [{
      pageNumber: 1,
      totalPages: 1,
      isFirstPage: true,
      isContinuationSheet: false,
      records: [],
      consumedUnits: 0,
      maxUnits: firstPageSpec.maxLayoutUnits,
    }];
  }

  let currentPageIndex = 0;
  let currentPageSpec = firstPageSpec;

  const createNewPage = (isFirst: boolean): ProjectedDocumentPage<T> => ({
    pageNumber: pages.length + 1,
    totalPages: 0, // 後で一括設定
    isFirstPage: isFirst,
    isContinuationSheet: !isFirst,
    records: [],
    consumedUnits: 0,
    maxUnits: isFirst ? firstPageSpec.maxLayoutUnits : continuationPageSpec.maxLayoutUnits,
  });

  pages.push(createNewPage(true));

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const recordCost = calculateRecordLayoutCost(record.primaryText, currentPageSpec.charsPerLine, currentPageSpec.unitPerLine);

    const currentPage = pages[currentPageIndex];

    // Check Case 1: 現在ページに収まるか
    const fitsRecordCount = currentPage.records.length + 1 <= currentPageSpec.maxPhysicalRecords;
    const fitsUnits = currentPage.consumedUnits + recordCost <= currentPageSpec.maxLayoutUnits;

    if (fitsRecordCount && fitsUnits) {
      currentPage.records.push(record);
      currentPage.consumedUnits += recordCost;
      continue;
    }

    // Check Case 2: 新規続紙ページにレコード全体が収まるか (Whole Record Move)
    const fitsInFreshContinuation = recordCost <= continuationPageSpec.maxLayoutUnits && continuationPageSpec.maxPhysicalRecords >= 1;

    if (fitsInFreshContinuation) {
      // 現在ページを確定し、新規続紙ページを作成
      const newPage = createNewPage(false);
      pages.push(newPage);
      currentPageIndex++;
      currentPageSpec = continuationPageSpec;

      newPage.records.push(record);
      newPage.consumedUnits += recordCost;
      continue;
    }

    // Check Case 3: 単一レコードが続紙最大容量を超える場合 (Single Record Oversize)
    if (!record.isAtomic && record.splittableBlocks && record.splittableBlocks.length > 0) {
      // Approved Splittable Content Blocks に基づく決定論的ブロック分割
      let remainingBlocks = [...record.splittableBlocks];
      let partIndex = 1;

      while (remainingBlocks.length > 0) {
        let activePage = pages[currentPageIndex];
        let activeSpec = currentPageIndex === 0 ? firstPageSpec : continuationPageSpec;

        // 現在ページに空きがほとんどない場合は新規ページへ
        if (activePage.consumedUnits + 2 > activeSpec.maxLayoutUnits || activePage.records.length >= activeSpec.maxPhysicalRecords) {
          const newPage = createNewPage(false);
          pages.push(newPage);
          currentPageIndex++;
          activePage = newPage;
          activeSpec = continuationPageSpec;
        }

        const availableUnits = activeSpec.maxLayoutUnits - activePage.consumedUnits;
        const currentBatchBlocks: string[] = [];
        let batchCost = 0;

        while (remainingBlocks.length > 0) {
          const nextBlock = remainingBlocks[0];
          const nextCost = calculateRecordLayoutCost(nextBlock, activeSpec.charsPerLine, activeSpec.unitPerLine);
          if (currentBatchBlocks.length > 0 && (batchCost + nextCost > availableUnits)) {
            break;
          }
          if (currentBatchBlocks.length === 0 && nextCost > availableUnits && activePage.records.length > 0) {
            // 現在ページに他レコードがある場合は新規ページへ送る
            break;
          }
          currentBatchBlocks.push(remainingBlocks.shift()!);
          batchCost += nextCost;
        }

        if (currentBatchBlocks.length === 0) {
          // 白紙ページでも1ブロックが入らない場合のFail-Closed
          if (activePage.records.length === 0) {
            throw new Error(`FAIL_CLOSED: Splittable block exceeds maximum page capacity. Block length: ${remainingBlocks[0]?.length}`);
          }
          // 新規ページを作成してリトライ
          const newPage = createNewPage(false);
          pages.push(newPage);
          currentPageIndex++;
          continue;
        }

        const partialRecord = {
          ...record,
          id: `${record.id}-part-${partIndex++}`,
          primaryText: currentBatchBlocks.join('\n\n'),
          splittableBlocks: currentBatchBlocks,
        } as T;

        activePage.records.push(partialRecord);
        activePage.consumedUnits += batchCost;
      }
      continue;
    }

    // Case 4: 分割不可 (Atomic) なレコードが最大容量を超過 -> Fail-Closed
    throw new Error(
      `FAIL_CLOSED: Atomic record layout cost (${recordCost} units) exceeds maximum supported page capacity (${continuationPageSpec.maxLayoutUnits} units). Record ID: ${record.id}`
    );
  }

  // 全ページの totalPages を一括確定
  const total = pages.length;
  for (const p of pages) {
    p.totalPages = total;
  }

  return pages;
}

/**
 * 休暇簿（年休・病休・特休・職免）レコード投影 (INV-W4-03: 暦年 1/1〜12/31 基準)
 */
export interface LeaveLedgerRecordItem extends PaginatableRecord {
  applicationId: number;
  typeId: string;
  typeName: string;
  startDate: string;
  endDate: string;
  daysCount: number;
  minutesCount: number;
  unitType: 'DAY' | 'HALF_DAY' | 'TIME';
  timeSpanFormatted?: string;
  reason: string;
  approvedAt?: string;
  approverStampName?: string;
}

export function projectLeaveLedgerPages(
  userId: number,
  calendarYear: number
): {
  calendarYear: number;
  period: { start: string; end: string };
  firstPageCapacity: PageCapacitySpec;
  continuationPageCapacity: PageCapacitySpec;
  pages: ProjectedDocumentPage<LeaveLedgerRecordItem>[];
  totalApprovedRecords: number;
} {
  const db = getDb();
  const yearStart = `${calendarYear}-01-01`;
  const yearEnd = `${calendarYear}-12-31`;

  // 1. 暦年基準で最終承認済み休暇申請を取得 (INV-W4-03)
  const rows = db.prepare(`
    SELECT
      a.id,
      a.type_id,
      t.name as type_name,
      a.form_data,
      a.created_at,
      a.updated_at
    FROM applications a
    JOIN application_types t ON a.type_id = t.id
    WHERE a.subject_user_id = ?
      AND a.current_status = 'FINAL_APPROVED'
      AND (
        (json_extract(a.form_data, '$.startDate') >= ? AND json_extract(a.form_data, '$.startDate') <= ?)
        OR (json_extract(a.form_data, '$.targetDate') >= ? AND json_extract(a.form_data, '$.targetDate') <= ?)
      )
    ORDER BY COALESCE(json_extract(a.form_data, '$.startDate'), json_extract(a.form_data, '$.targetDate')) ASC, a.id ASC
  `).all(userId, yearStart, yearEnd, yearStart, yearEnd) as any[];

  // 2. レコードDTOの構築
  const records: LeaveLedgerRecordItem[] = rows.map((r) => {
    const data = JSON.parse(r.form_data || '{}');
    const startDate = data.startDate || data.targetDate || '';
    const endDate = data.endDate || data.targetDate || startDate;
    const unitType = data.unitType || 'DAY';
    const reason = data.reason || '';

    // 印影取得
    const finalStep = db.prepare(`
      SELECT approver_name_snapshot, action_user_stamp_name, acted_at
      FROM application_approval_steps
      WHERE application_id = ? AND status = 'APPROVED'
      ORDER BY step_order DESC LIMIT 1
    `).get(r.id) as any;

    return {
      id: r.id,
      applicationId: r.id,
      isAtomic: true, // 休暇簿明細行は分割禁止の Atomic Record
      typeId: r.type_id,
      typeName: r.type_name,
      startDate,
      endDate,
      daysCount: data.calculatedDays || (unitType === 'DAY' ? 1 : (unitType === 'HALF_DAY' ? 0.5 : 0)),
      minutesCount: data.calculatedMinutes || 0,
      unitType,
      timeSpanFormatted: unitType === 'TIME' ? `${data.startTime || ''}〜${data.endTime || ''}` : undefined,
      reason,
      primaryText: reason,
      approvedAt: finalStep?.acted_at,
      approverStampName: finalStep?.action_user_stamp_name || finalStep?.approver_name_snapshot || '認',
    };
  });

  // 3. Layout Capacity 導出 (INV-W4-06)
  const firstPageSpec = derivePageLayoutCapacity(
    A4_PORTRAIT_CONTRACT,
    LEAVE_LEDGER_FIRST_PAGE_RESERVED,
    LEAVE_LEDGER_TYPOGRAPHY,
    15 // 最大15件
  );

  const continuationPageSpec = derivePageLayoutCapacity(
    A4_PORTRAIT_CONTRACT,
    LEAVE_LEDGER_CONTINUATION_PAGE_RESERVED,
    LEAVE_LEDGER_TYPOGRAPHY,
    25 // 最大25件
  );

  // 4. 決定論的ページネーション実行
  const pages = paginateRecordsDeterministically(records, firstPageSpec, continuationPageSpec);

  return {
    calendarYear,
    period: { start: yearStart, end: yearEnd },
    firstPageCapacity: firstPageSpec,
    continuationPageCapacity: continuationPageSpec,
    pages,
    totalApprovedRecords: records.length,
  };
}

/**
 * 旅行命令・復命書 決定論的ページネーション投影
 */
export interface ProjectedTripOrderDocument {
  totalPages: number;
  hasContinuationSheet: boolean;
  pages: {
    pageNumber: number;
    totalPages: number;
    isFirstPage: boolean;
    isContinuationSheet: boolean;
    mainPurpose: string;
    mainReportResult: string;
    continuationReportParagraphs?: string[];
  }[];
}

export function projectTripOrderPages(
  purpose: string,
  reportResult: string
): ProjectedTripOrderDocument {
  // 第1面メイン枠の許容行数コスト (MAIN_BLOCK_MAX_LINES = 12)
  const MAIN_BLOCK_MAX_LINES = 12;
  const charsPerLine = TRAVEL_ORDER_TYPOGRAPHY.charsPerLine; // 42

  const purposeCost = calculateRecordLayoutCost(purpose, charsPerLine, 1);
  const reportCost = calculateRecordLayoutCost(reportResult, charsPerLine, 1);
  const totalFirstPageCost = purposeCost + reportCost;

  // メイン枠に収まる場合: 1ページのみ
  if (totalFirstPageCost <= MAIN_BLOCK_MAX_LINES) {
    return {
      totalPages: 1,
      hasContinuationSheet: false,
      pages: [
        {
          pageNumber: 1,
          totalPages: 1,
          isFirstPage: true,
          isContinuationSheet: false,
          mainPurpose: purpose,
          mainReportResult: reportResult,
        },
      ],
    };
  }

  // メイン枠を超過する場合: 第1面に正準参照、続紙へ全内容を決定論的展開 (INV-W4-01, INV-W4-07)
  const splittableParagraphs = reportResult ? reportResult.split(/\r\n\r\n|\n\n/) : [reportResult];

  // 続紙容量導出
  const contPageSpec = derivePageLayoutCapacity(
    A4_LANDSCAPE_CONTRACT,
    TRAVEL_ORDER_CONTINUATION_PAGE_RESERVED,
    TRAVEL_ORDER_TYPOGRAPHY,
    100
  );

  const reportRecord: PaginatableRecord = {
    id: 'trip-report',
    isAtomic: false, // 復命書は承認済みブロック分割可能
    primaryText: reportResult,
    splittableBlocks: splittableParagraphs,
  };

  const continuationPages = paginateRecordsDeterministically(
    [reportRecord],
    contPageSpec,
    contPageSpec
  );

  const totalPages = 1 + continuationPages.length;

  const resultPages: ProjectedTripOrderDocument['pages'] = [
    {
      pageNumber: 1,
      totalPages,
      isFirstPage: true,
      isContinuationSheet: false,
      mainPurpose: purpose,
      mainReportResult: '（別紙復命書・続紙のとおり）',
    },
  ];

  for (let i = 0; i < continuationPages.length; i++) {
    const cp = continuationPages[i];
    resultPages.push({
      pageNumber: 2 + i,
      totalPages,
      isFirstPage: false,
      isContinuationSheet: true,
      mainPurpose: purpose,
      mainReportResult: cp.records.map((r) => r.primaryText).join('\n\n'),
      continuationReportParagraphs: cp.records.flatMap((r) => r.splittableBlocks || [r.primaryText]),
    });
  }

  return {
    totalPages,
    hasContinuationSheet: true,
    pages: resultPages,
  };
}

/**
 * 出勤簿 Canonical Display Token 解決 (INV-W4-08: 既存SSOT消費・非Authority化)
 */
export function resolveAttendanceCanonicalDisplayToken(
  policyCode: string,
  authorityId: string = 'DEFAULT_MUNICIPALITY'
): {
  symbol: string;
  displayName: string;
  isFailClosed: boolean;
} {
  const resolved = resolveAttendancePolicy(policyCode, authorityId);
  if (resolved.isFailClosed || !resolved.displaySymbol) {
    return {
      symbol: '不明',
      displayName: '未解決ポリシー',
      isFailClosed: true,
    };
  }
  return {
    symbol: resolved.displaySymbol,
    displayName: resolved.displayName || resolved.displaySymbol,
    isFailClosed: false,
  };
}

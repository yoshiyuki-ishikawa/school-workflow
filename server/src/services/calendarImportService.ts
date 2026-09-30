import crypto from 'crypto';
import { getDb } from '../db/database';
import { getServerIsoString, getServerTime } from '../utils/serverTime';
import { logAudit, logAuditStrict } from '../utils/auditLogger';

export interface RawCsvRow {
  date: string;
  eventType: string;
  eventName: string;
  targetDate?: string;
  notes?: string;
  rawLineIndex: number;
}

export type CanonicalCandidateType = 'WEEK_OFF_TRANSFER' | 'SUBSTITUTE_HOLIDAY' | 'SCHOOL_HOLIDAY';

export interface CanonicalCalendarCandidate {
  candidateType: CanonicalCandidateType;
  sourceDate: string;
  targetDate?: string;
  sourceDutyStatus: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED';
  targetDutyStatus?: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED';
  eventName: string;
  reason: string;
  authorityBasis?: string;
  rawLineIndices: number[];
}

export type FactImpactCategory = 'NEW' | 'UNCHANGED_IDENTICAL' | 'CONFLICT_UPDATE' | 'LOCKED';

export interface PreviewItemDto {
  candidateType: CanonicalCandidateType;
  sourceDate: string;
  targetDate?: string;
  eventName: string;
  reason: string;
  sourceDutyStatus: string;
  targetDutyStatus?: string;
  
  impactCategory: FactImpactCategory;
  isLocked: boolean;
  lockReason?: string;
  
  conflictDetails?: {
    existingFactType: 'calendar_adjustments' | 'custom_holidays';
    existingId: number;
    existingEventName: string;
    existingStatus: string;
    existingRecordOrigin: string;
  };
}

export interface ImportPreviewResult {
  fileName: string;
  fileSha256: string;
  fiscalYear: number;
  totalParsedRows: number;
  candidatesCount: number;
  
  items: PreviewItemDto[];
  
  summary: {
    newCount: number;
    identicalCount: number;
    conflictCount: number;
    lockedCount: number;
  };
  
  hasLockedMonth: boolean;
  hasConflict: boolean;
  
  previewFingerprint: string;
  previewToken: string;
}

export interface CommitCalendarImportPayload {
  previewToken: string;
  fileSha256: string;
  fileName: string;
  fiscalYear: number;
  approvedConflictIds?: Array<{ factType: 'calendar_adjustments' | 'custom_holidays'; id: number }>;
  commitComment?: string;
}

export interface CommitResultDto {
  batchId: number;
  batchCode: string;
  fiscalYear: number;
  totalApplied: number;
  appliedAdjustmentsCount: number;
  appliedCustomHolidaysCount: number;
  supersededAdjustmentsCount: number;
  supersededCustomHolidaysCount: number;
  message: string;
}

export class CalendarImportService {
  public static parseCsv(buffer: Buffer, fileName: string): { rows: RawCsvRow[]; sha256: string; totalLines: number } {
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    let text = '';
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      text = buffer.subarray(3).toString('utf8');
    } else {
      try {
        const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
        text = utf8Decoder.decode(buffer);
      } catch {
        try {
          const sjisDecoder = new TextDecoder('shift-jis', { fatal: true });
          text = sjisDecoder.decode(buffer);
        } catch {
          text = buffer.toString('utf8');
        }
      }
    }

    const lines = text.split(/\r?\n/);
    const rows: RawCsvRow[] = [];
    let headerSkipped = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = this.splitCsvLine(line);
      if (cols.length === 0) continue;

      if (!headerSkipped) {
        const firstCol = cols[0].trim();
        if (firstCol.includes('日付') || firstCol.includes('年月日') || firstCol.toLowerCase().includes('date')) {
          headerSkipped = true;
          continue;
        }
        headerSkipped = true;
      }

      if (cols.length < 3) {
        throw new Error(`CSV ${i + 1} 行目のカラム数が不足しています (日付, 区分, 行事名は必須)`);
      }

      const dateRaw = cols[0].trim();
      const eventTypeRaw = cols[1].trim();
      const eventNameRaw = cols[2].trim();
      const targetDateRaw = cols.length > 3 ? cols[3].trim() : '';
      const notesRaw = cols.length > 4 ? cols[4].trim() : '';

      const normalizedDate = this.normalizeDateFormat(dateRaw, i + 1);
      const normalizedTargetDate = targetDateRaw ? this.normalizeDateFormat(targetDateRaw, i + 1) : undefined;

      rows.push({
        date: normalizedDate,
        eventType: eventTypeRaw,
        eventName: eventNameRaw,
        targetDate: normalizedTargetDate,
        notes: notesRaw || undefined,
        rawLineIndex: i + 1,
      });
    }

    if (rows.length === 0) {
      throw new Error('有効なデータ行が存在しません');
    }

    return { rows, sha256, totalLines: lines.length };
  }

  private static splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        result.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    result.push(cur);
    return result;
  }

  private static normalizeDateFormat(dateStr: string, lineNo: number): string {
    const s = dateStr.replace(/\//g, '-').trim();
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) {
      throw new Error(`CSV ${lineNo} 行目の日付形式が無効です: ${dateStr} (YYYY-MM-DD 形式で指定してください)`);
    }
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`CSV ${lineNo} 行目の日付が存在しません: ${dateStr}`);
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  public static resolveCanonicalPairs(rows: RawCsvRow[]): CanonicalCalendarCandidate[] {
    const candidates: CanonicalCalendarCandidate[] = [];
    const usedIndices = new Set<number>();

    for (let i = 0; i < rows.length; i++) {
      if (usedIndices.has(i)) continue;
      const r = rows[i];
      const evType = r.eventType.trim();

      if (
        evType === '学校行事休日' ||
        evType === '学校指定休日' ||
        evType === '開校記念日' ||
        evType === '学校休日' ||
        evType === 'SCHOOL_HOLIDAY'
      ) {
        candidates.push({
          candidateType: 'SCHOOL_HOLIDAY',
          sourceDate: r.date,
          sourceDutyStatus: 'NO_WORK_REQUIRED',
          eventName: r.eventName,
          reason: r.notes || r.eventName,
          rawLineIndices: [r.rawLineIndex],
        });
        usedIndices.add(i);
        continue;
      }

      if (r.targetDate) {
        if (r.date === r.targetDate) {
          throw new Error(`CSV ${r.rawLineIndex} 行目: 振替元日と振替先日が同一です (${r.date})`);
        }

        const isWeekOff = evType.includes('週休') || evType.includes('振替') || evType === 'WEEK_OFF_TRANSFER';
        const isSubst = evType.includes('代休') || evType === 'SUBSTITUTE_HOLIDAY';

        if (!isWeekOff && !isSubst) {
          throw new Error(`CSV ${r.rawLineIndex} 行目: 未知の区分です (${r.eventType})`);
        }

        const cType: CanonicalCandidateType = isWeekOff ? 'WEEK_OFF_TRANSFER' : 'SUBSTITUTE_HOLIDAY';

        const dateObj1 = new Date(r.date + 'T00:00:00Z');
        const dateObj2 = new Date(r.targetDate + 'T00:00:00Z');
        const dayOfWeek1 = dateObj1.getUTCDay();
        const dayOfWeek2 = dateObj2.getUTCDay();

        let sourceDate = r.date;
        let targetDate = r.targetDate;

        if ((dayOfWeek1 !== 0 && dayOfWeek1 !== 6) && (dayOfWeek2 === 0 || dayOfWeek2 === 6)) {
          sourceDate = r.targetDate;
          targetDate = r.date;
        }

        candidates.push({
          candidateType: cType,
          sourceDate,
          targetDate,
          sourceDutyStatus: 'WORK_REQUIRED',
          targetDutyStatus: 'NO_WORK_REQUIRED',
          eventName: r.eventName,
          reason: r.notes || r.eventName,
          rawLineIndices: [r.rawLineIndex],
        });
        usedIndices.add(i);
        continue;
      }
    }

    const remainingIndices = rows.map((_, idx) => idx).filter((idx) => !usedIndices.has(idx));
    for (let j = 0; j < remainingIndices.length; j++) {
      const idx1 = remainingIndices[j];
      if (usedIndices.has(idx1)) continue;
      const r1 = rows[idx1];

      let matchedIdx: number | null = null;
      for (let k = j + 1; k < remainingIndices.length; k++) {
        const idx2 = remainingIndices[k];
        if (usedIndices.has(idx2)) continue;
        const r2 = rows[idx2];

        const isNameMatch = r1.eventName === r2.eventName ||
                            r1.eventName.includes(r2.eventName) ||
                            r2.eventName.includes(r1.eventName);
        
        const isOneWorkOneRest =
          ((r1.eventType.includes('勤務') || r1.eventType.includes('授業') || r1.eventType.includes('行事')) &&
           (r2.eventType.includes('休') || r2.eventType.includes('振替') || r2.eventType.includes('代休'))) ||
          ((r2.eventType.includes('勤務') || r2.eventType.includes('授業') || r2.eventType.includes('行事')) &&
           (r1.eventType.includes('休') || r1.eventType.includes('振替') || r1.eventType.includes('代休')));

        if (isNameMatch && isOneWorkOneRest) {
          matchedIdx = idx2;
          break;
        }
      }

      if (matchedIdx !== null) {
        const r2 = rows[matchedIdx];
        const isR1Work = r1.eventType.includes('勤務') || r1.eventType.includes('授業') || r1.eventType.includes('行事');
        const workRow = isR1Work ? r1 : r2;
        const restRow = isR1Work ? r2 : r1;

        const isWeekOff = workRow.eventType.includes('週休') || restRow.eventType.includes('週休') ||
                          workRow.eventType.includes('振替') || restRow.eventType.includes('振替');
        const cType: CanonicalCandidateType = isWeekOff ? 'WEEK_OFF_TRANSFER' : 'SUBSTITUTE_HOLIDAY';

        candidates.push({
          candidateType: cType,
          sourceDate: workRow.date,
          targetDate: restRow.date,
          sourceDutyStatus: 'WORK_REQUIRED',
          targetDutyStatus: 'NO_WORK_REQUIRED',
          eventName: workRow.eventName,
          reason: workRow.notes || restRow.notes || workRow.eventName,
          rawLineIndices: [workRow.rawLineIndex, restRow.rawLineIndex].sort((a, b) => a - b),
        });

        usedIndices.add(idx1);
        usedIndices.add(matchedIdx);
      } else {
        if (r1.eventType.includes('振替') || r1.eventType.includes('代休') || r1.eventType.includes('週休')) {
          throw new Error(`CSV ${r1.rawLineIndex} 行目: 振替・代休の対となる相手日が見つかりません (${r1.date} ${r1.eventName})`);
        }
        candidates.push({
          candidateType: 'SCHOOL_HOLIDAY',
          sourceDate: r1.date,
          sourceDutyStatus: 'NO_WORK_REQUIRED',
          eventName: r1.eventName,
          reason: r1.notes || r1.eventName,
          rawLineIndices: [r1.rawLineIndex],
        });
        usedIndices.add(idx1);
      }
    }

    const dedupMap = new Map<string, CanonicalCalendarCandidate>();
    for (const cand of candidates) {
      const key = `${cand.candidateType}_${cand.sourceDate}_${cand.targetDate || ''}`;
      if (!dedupMap.has(key)) {
        dedupMap.set(key, cand);
      } else {
        const existing = dedupMap.get(key)!;
        existing.rawLineIndices = Array.from(new Set([...existing.rawLineIndices, ...cand.rawLineIndices])).sort((a, b) => a - b);
      }
    }

    return Array.from(dedupMap.values()).sort((a, b) => a.sourceDate.localeCompare(b.sourceDate));
  }

  public static generatePreview(
    candidates: CanonicalCalendarCandidate[],
    fileName: string,
    fileSha256: string,
    currentUserId: number
  ): ImportPreviewResult {
    const db = getDb();

    const allDates = candidates.flatMap((c) => (c.targetDate ? [c.sourceDate, c.targetDate] : [c.sourceDate]));
    if (allDates.length === 0) {
      throw new Error('候補データが空です');
    }
    const firstDate = allDates.sort()[0];
    const [yStr, mStr] = firstDate.split('-');
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    const fiscalYear = m >= 4 ? y : y - 1;

    const lockedRows = db.prepare(`
      SELECT DISTINCT year_month FROM monthly_attendance_approvals
      WHERE status = 'CONFIRMED'
    `).all() as { year_month: string }[];
    const lockedMonths = new Set(lockedRows.map((r) => r.year_month));

    const previewItems: PreviewItemDto[] = [];
    let newCount = 0;
    let identicalCount = 0;
    let conflictCount = 0;
    let lockedCount = 0;
    let hasLockedMonth = false;
    let hasConflict = false;

    const existingAdjustments = db.prepare(`
      SELECT id, adjustment_code, adjustment_type, source_date, target_date, event_name, status, record_origin
      FROM calendar_adjustments
      WHERE status = 'ACTIVE' AND scope_type = 'ALL'
    `).all() as any[];

    const existingHolidays = db.prepare(`
      SELECT id, holiday_date, name, holiday_type, is_active, record_origin
      FROM custom_holidays
      WHERE is_active = 1
    `).all() as any[];

    for (const cand of candidates) {
      const sourceYm = cand.sourceDate.substring(0, 7);
      const targetYm = cand.targetDate ? cand.targetDate.substring(0, 7) : null;

      const isSourceLocked = lockedMonths.has(sourceYm);
      const isTargetLocked = targetYm ? lockedMonths.has(targetYm) : false;
      const isLocked = isSourceLocked || isTargetLocked;

      if (isLocked) {
        hasLockedMonth = true;
        lockedCount++;
        const lockReason = isSourceLocked && isTargetLocked
          ? `対象年月 ${sourceYm} および ${targetYm} の出勤簿は確定済み(CONFIRMED)のため変更できません`
          : isSourceLocked
          ? `対象年月 ${sourceYm} の出勤簿は確定済み(CONFIRMED)のため変更できません`
          : `対象年月 ${targetYm} の出勤簿は確定済み(CONFIRMED)のため変更できません`;

        previewItems.push({
          candidateType: cand.candidateType,
          sourceDate: cand.sourceDate,
          targetDate: cand.targetDate,
          eventName: cand.eventName,
          reason: cand.reason,
          sourceDutyStatus: cand.sourceDutyStatus,
          targetDutyStatus: cand.targetDutyStatus,
          impactCategory: 'LOCKED',
          isLocked: true,
          lockReason,
        });
        continue;
      }

      if (cand.candidateType === 'SCHOOL_HOLIDAY') {
        const existingHol = existingHolidays.find(
          (h) => h.holiday_date === cand.sourceDate && h.holiday_type === 'SCHOOL_HOLIDAY'
        );

        if (!existingHol) {
          newCount++;
          previewItems.push({
            candidateType: cand.candidateType,
            sourceDate: cand.sourceDate,
            eventName: cand.eventName,
            reason: cand.reason,
            sourceDutyStatus: cand.sourceDutyStatus,
            impactCategory: 'NEW',
            isLocked: false,
          });
        } else if (existingHol.name === cand.eventName) {
          identicalCount++;
          previewItems.push({
            candidateType: cand.candidateType,
            sourceDate: cand.sourceDate,
            eventName: cand.eventName,
            reason: cand.reason,
            sourceDutyStatus: cand.sourceDutyStatus,
            impactCategory: 'UNCHANGED_IDENTICAL',
            isLocked: false,
          });
        } else {
          conflictCount++;
          hasConflict = true;
          previewItems.push({
            candidateType: cand.candidateType,
            sourceDate: cand.sourceDate,
            eventName: cand.eventName,
            reason: cand.reason,
            sourceDutyStatus: cand.sourceDutyStatus,
            impactCategory: 'CONFLICT_UPDATE',
            isLocked: false,
            conflictDetails: {
              existingFactType: 'custom_holidays',
              existingId: existingHol.id,
              existingEventName: existingHol.name,
              existingStatus: 'ACTIVE',
              existingRecordOrigin: existingHol.record_origin || 'MANUAL',
            },
          });
        }
      } else {
        const existingAdj = existingAdjustments.find(
          (a) =>
            (a.source_date === cand.sourceDate || a.target_date === cand.sourceDate) ||
            (cand.targetDate && (a.source_date === cand.targetDate || a.target_date === cand.targetDate))
        );

        if (!existingAdj) {
          newCount++;
          previewItems.push({
            candidateType: cand.candidateType,
            sourceDate: cand.sourceDate,
            targetDate: cand.targetDate,
            eventName: cand.eventName,
            reason: cand.reason,
            sourceDutyStatus: cand.sourceDutyStatus,
            targetDutyStatus: cand.targetDutyStatus,
            impactCategory: 'NEW',
            isLocked: false,
          });
        } else if (
          existingAdj.adjustment_type === cand.candidateType &&
          existingAdj.source_date === cand.sourceDate &&
          existingAdj.target_date === (cand.targetDate || null) &&
          existingAdj.event_name === cand.eventName
        ) {
          identicalCount++;
          previewItems.push({
            candidateType: cand.candidateType,
            sourceDate: cand.sourceDate,
            targetDate: cand.targetDate,
            eventName: cand.eventName,
            reason: cand.reason,
            sourceDutyStatus: cand.sourceDutyStatus,
            targetDutyStatus: cand.targetDutyStatus,
            impactCategory: 'UNCHANGED_IDENTICAL',
            isLocked: false,
          });
        } else {
          conflictCount++;
          hasConflict = true;
          previewItems.push({
            candidateType: cand.candidateType,
            sourceDate: cand.sourceDate,
            targetDate: cand.targetDate,
            eventName: cand.eventName,
            reason: cand.reason,
            sourceDutyStatus: cand.sourceDutyStatus,
            targetDutyStatus: cand.targetDutyStatus,
            impactCategory: 'CONFLICT_UPDATE',
            isLocked: false,
            conflictDetails: {
              existingFactType: 'calendar_adjustments',
              existingId: existingAdj.id,
              existingEventName: existingAdj.event_name,
              existingStatus: existingAdj.status,
              existingRecordOrigin: existingAdj.record_origin || 'MANUAL',
            },
          });
        }
      }
    }

    const affectedDates = Array.from(new Set(allDates)).sort();
    const stateFingerprintPayload = JSON.stringify({
      affectedDates,
      activeAdjs: existingAdjustments
        .filter((a) => affectedDates.includes(a.source_date) || (a.target_date && affectedDates.includes(a.target_date)))
        .map((a) => ({ id: a.id, type: a.adjustment_type, s: a.source_date, t: a.target_date, name: a.event_name, st: a.status })),
      activeHols: existingHolidays
        .filter((h) => affectedDates.includes(h.holiday_date))
        .map((h) => ({ id: h.id, d: h.holiday_date, name: h.name, type: h.holiday_type, active: h.is_active })),
      lockedMonths: Array.from(lockedMonths).sort(),
    });

    const previewFingerprint = crypto.createHash('sha256').update(stateFingerprintPayload).digest('hex');

    const previewTokenData = {
      fileSha256,
      fileName,
      fiscalYear,
      previewFingerprint,
      candidates,
      createdAt: getServerIsoString(),
      userId: currentUserId,
    };
    const tokenJson = JSON.stringify(previewTokenData);
    const previewToken = Buffer.from(tokenJson).toString('base64');

    return {
      fileName,
      fileSha256,
      fiscalYear,
      totalParsedRows: candidates.length,
      candidatesCount: candidates.length,
      items: previewItems,
      summary: {
        newCount,
        identicalCount,
        conflictCount,
        lockedCount,
      },
      hasLockedMonth,
      hasConflict,
      previewFingerprint,
      previewToken,
    };
  }

  public static commitImport(
    payload: CommitCalendarImportPayload,
    currentUserId: number,
    currentUser: any
  ): CommitResultDto {
    const db = getDb();
    const now = getServerIsoString();

    if (!payload.previewToken) {
      throw new Error('PreviewToken が指定されていません');
    }

    let tokenData: {
      fileSha256: string;
      fileName: string;
      fiscalYear: number;
      previewFingerprint: string;
      candidates: CanonicalCalendarCandidate[];
      userId: number;
    };

    try {
      const decoded = Buffer.from(payload.previewToken, 'base64').toString('utf8');
      tokenData = JSON.parse(decoded);
    } catch {
      throw new Error('無効な PreviewToken です');
    }

    if (tokenData.fileSha256 !== payload.fileSha256) {
      throw new Error('ファイル SHA-256 がプレビュー時と一致しません');
    }

    const candidates = tokenData.candidates;
    if (!candidates || candidates.length === 0) {
      throw new Error('コミット対象の候補データがありません');
    }

    const revalidatedPreview = this.generatePreview(
      candidates,
      tokenData.fileName,
      tokenData.fileSha256,
      currentUserId
    );

    if (revalidatedPreview.previewFingerprint !== tokenData.previewFingerprint) {
      logAudit({
        actorUserId: currentUserId,
        actorUsername: currentUser.username,
        action: 'CALENDAR_IMPORT_COMMIT_FAILED',
        entityType: 'CALENDAR_IMPORT',
        comment: 'カレンダー一括インポート失敗: Stale Preview Conflict (プレビュー後のDB変更検知)',
        ipAddress: currentUser.ipAddress || '127.0.0.1',
        userAgent: currentUser.userAgent,
        metadata: {
          errorCode: 'STALE_PREVIEW_CONFLICT',
          expectedFingerprint: tokenData.previewFingerprint,
          currentFingerprint: revalidatedPreview.previewFingerprint,
        },
        isSuccess: false,
      });

      const err: any = new Error('カレンダー情報がプレビュー後に変更されています。再度プレビューを行ってください。');
      err.statusCode = 409;
      err.code = 'STALE_PREVIEW_CONFLICT';
      throw err;
    }

    if (revalidatedPreview.hasLockedMonth) {
      logAudit({
        actorUserId: currentUserId,
        actorUsername: currentUser.username,
        action: 'CALENDAR_IMPORT_COMMIT_FAILED',
        entityType: 'CALENDAR_IMPORT',
        comment: 'カレンダー一括インポート失敗: 確定済み月度の変更試行を遮断',
        ipAddress: currentUser.ipAddress || '127.0.0.1',
        userAgent: currentUser.userAgent,
        metadata: { errorCode: 'LOCKED_MONTH_VIOLATION' },
        isSuccess: false,
      });

      const err: any = new Error('確定済み(CONFIRMED)の出勤簿月度が含まれているため、インポートできません。');
      err.statusCode = 400;
      err.code = 'LOCKED_MONTH_VIOLATION';
      throw err;
    }

    const conflicts = revalidatedPreview.items.filter((item) => item.impactCategory === 'CONFLICT_UPDATE');
    if (conflicts.length > 0) {
      const approvedList = payload.approvedConflictIds || [];
      const approvedKeySet = new Set(approvedList.map((a) => `${a.factType}_${a.id}`));

      for (const conf of conflicts) {
        if (!conf.conflictDetails) continue;
        const key = `${conf.conflictDetails.existingFactType}_${conf.conflictDetails.existingId}`;
        if (!approvedKeySet.has(key)) {
          logAudit({
            actorUserId: currentUserId,
            actorUsername: currentUser.username,
            action: 'CALENDAR_IMPORT_COMMIT_FAILED',
            entityType: 'CALENDAR_IMPORT',
            comment: `カレンダー一括インポート失敗: 未承認の競合が存在 (${conf.eventName} on ${conf.sourceDate})`,
            ipAddress: currentUser.ipAddress || '127.0.0.1',
            userAgent: currentUser.userAgent,
            metadata: { errorCode: 'UNAPPROVED_CONFLICT_DETECTED', unapprovedFact: conf.conflictDetails },
            isSuccess: false,
          });

          const err: any = new Error(`未承認の競合設定が存在します (${conf.sourceDate} ${conf.eventName})。すべての競合を承認してから実行してください。`);
          err.statusCode = 400;
          err.code = 'UNAPPROVED_CONFLICT_DETECTED';
          throw err;
        }
      }
    }

    const fiscalYear = tokenData.fiscalYear;
    const st = getServerTime();
    const dateCompact = `${st.getFullYear()}${String(st.getMonth() + 1).padStart(2, '0')}${String(st.getDate()).padStart(2, '0')}`;
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const batchCode = `BATCH-${fiscalYear}-${dateCompact}-${randomSuffix}`;

    let totalAppliedAdjustments = 0;
    let totalAppliedHolidays = 0;
    let totalSupersededAdjustments = 0;
    let totalSupersededHolidays = 0;

    const commitTx = db.transaction(() => {
      const batchStmt = db.prepare(`
        INSERT INTO calendar_import_batches (
          batch_code, fiscal_year, imported_by_user_id, file_name, file_sha256,
          total_rows, applied_adjustments_count, applied_custom_holidays_count,
          superseded_adjustments_count, superseded_custom_holidays_count,
          commit_comment, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const batchInfo = batchStmt.run(
        batchCode,
        fiscalYear,
        currentUserId,
        tokenData.fileName,
        tokenData.fileSha256,
        candidates.length,
        0,
        0,
        0,
        0,
        payload.commitComment || null,
        now
      );
      const batchId = Number(batchInfo.lastInsertRowid);

      for (const item of revalidatedPreview.items) {
        if (item.impactCategory === 'UNCHANGED_IDENTICAL') {
          continue;
        }

        if (item.candidateType === 'SCHOOL_HOLIDAY') {
          if (item.impactCategory === 'CONFLICT_UPDATE' && item.conflictDetails) {
            totalSupersededHolidays++;
            db.prepare(`
              UPDATE custom_holidays
              SET name = ?, source = 'CUSTOM', note = ?, import_batch_id = ?, record_origin = 'CSV_IMPORT', updated_at = ?
              WHERE id = ?
            `).run(
              item.eventName,
              item.reason || null,
              batchId,
              now,
              item.conflictDetails.existingId
            );

            logAuditStrict({
              actorUserId: currentUserId,
              actorUsername: currentUser.username,
              action: 'CALENDAR_FACT_REPLACED',
              entityType: 'CUSTOM_HOLIDAY',
              entityId: String(item.conflictDetails.existingId),
              comment: `学校休日置換 [Batch ${batchId}]: ${item.conflictDetails.existingEventName} -> ${item.eventName} (${item.sourceDate})`,
              ipAddress: currentUser.ipAddress || '127.0.0.1',
              userAgent: currentUser.userAgent,
              metadata: {
                batchId,
                action: 'CALENDAR_FACT_REPLACED',
                previousFact: {
                  type: 'custom_holidays',
                  id: item.conflictDetails.existingId,
                  eventName: item.conflictDetails.existingEventName,
                },
                resultingFact: {
                  type: 'custom_holidays',
                  id: item.conflictDetails.existingId,
                  eventName: item.eventName,
                },
                sourceHash: tokenData.fileSha256,
              },
            });
          } else if (item.impactCategory === 'NEW') {
            totalAppliedHolidays++;
            db.prepare(`
              INSERT INTO custom_holidays (
                holiday_date, name, holiday_type, source, is_active, note,
                import_batch_id, record_origin, created_by_user_id, created_at, updated_at
              ) VALUES (?, ?, 'SCHOOL_HOLIDAY', 'CUSTOM', 1, ?, ?, 'CSV_IMPORT', ?, ?, ?)
              ON CONFLICT(holiday_date, holiday_type) DO UPDATE SET
                name = excluded.name,
                source = excluded.source,
                is_active = 1,
                note = excluded.note,
                import_batch_id = excluded.import_batch_id,
                record_origin = excluded.record_origin,
                updated_at = excluded.updated_at
            `).run(
              item.sourceDate,
              item.eventName,
              item.reason || null,
              batchId,
              currentUserId,
              now,
              now
            );

            logAuditStrict({
              actorUserId: currentUserId,
              actorUsername: currentUser.username,
              action: 'CUSTOM_HOLIDAY_CREATED',
              entityType: 'CUSTOM_HOLIDAY',
              entityId: item.sourceDate,
              comment: `学校休日一括登録 [Batch ${batchId}]: ${item.sourceDate} ${item.eventName}`,
              ipAddress: currentUser.ipAddress || '127.0.0.1',
              userAgent: currentUser.userAgent,
              metadata: { batchId, sourceHash: tokenData.fileSha256 },
            });
          }
        } else {
          const adjCode = `ADJ-${dateCompact}-${Math.floor(1000 + Math.random() * 9000)}`;

          const insertAdj = db.prepare(`
            INSERT INTO calendar_adjustments (
              adjustment_code, scope_type, user_id, adjustment_type, reason_code,
              authority_basis, source_date, source_duty_status, target_date, target_duty_status,
              event_name, reason, status, import_batch_id, record_origin,
              created_by_user_id, created_at, updated_by_user_id, updated_at
            ) VALUES (?, 'ALL', NULL, ?, 'SCHOOL_EVENT', ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, 'CSV_IMPORT', ?, ?, ?, ?)
          `).run(
            adjCode,
            item.candidateType,
            `学校年間行事計画 (${tokenData.fileName})`,
            item.sourceDate,
            item.sourceDutyStatus,
            item.targetDate || null,
            item.targetDutyStatus || null,
            item.eventName,
            item.reason,
            batchId,
            currentUserId,
            now,
            currentUserId,
            now
          );
          const newAdjId = Number(insertAdj.lastInsertRowid);
          totalAppliedAdjustments++;

          if (item.impactCategory === 'CONFLICT_UPDATE' && item.conflictDetails) {
            totalSupersededAdjustments++;
            db.prepare(`
              UPDATE calendar_adjustments
              SET status = 'CANCELLED',
                  cancelled_by_user_id = ?,
                  cancelled_at = ?,
                  cancel_reason = ?,
                  superseded_by_adjustment_id = ?,
                  updated_by_user_id = ?,
                  updated_at = ?
              WHERE id = ?
            `).run(
              currentUserId,
              now,
              `一括インポート(Batch ${batchId})による新設定置換`,
              newAdjId,
              currentUserId,
              now,
              item.conflictDetails.existingId
            );

            logAuditStrict({
              actorUserId: currentUserId,
              actorUsername: currentUser.username,
              action: 'CALENDAR_FACT_REPLACED',
              entityType: 'CALENDAR_ADJUSTMENT',
              entityId: String(newAdjId),
              comment: `服務調整置換 [Batch ${batchId}]: ${item.conflictDetails.existingEventName} (ID:${item.conflictDetails.existingId}) -> ${item.eventName} (ID:${newAdjId})`,
              ipAddress: currentUser.ipAddress || '127.0.0.1',
              userAgent: currentUser.userAgent,
              metadata: {
                batchId,
                action: 'CALENDAR_FACT_REPLACED',
                previousFact: {
                  type: 'calendar_adjustments',
                  id: item.conflictDetails.existingId,
                  eventName: item.conflictDetails.existingEventName,
                },
                resultingFact: {
                  type: 'calendar_adjustments',
                  id: newAdjId,
                  eventName: item.eventName,
                },
                sourceHash: tokenData.fileSha256,
              },
            });
          } else {
            logAuditStrict({
              actorUserId: currentUserId,
              actorUsername: currentUser.username,
              action: 'CALENDAR_ADJUSTMENT_CREATED',
              entityType: 'CALENDAR_ADJUSTMENT',
              entityId: String(newAdjId),
              comment: `服務調整一括登録 [Batch ${batchId}] [${adjCode}] ${item.eventName} (${item.sourceDate}${item.targetDate ? ' -> ' + item.targetDate : ''}): ${item.reason}`,
              ipAddress: currentUser.ipAddress || '127.0.0.1',
              userAgent: currentUser.userAgent,
              metadata: { batchId, sourceHash: tokenData.fileSha256 },
            });
          }
        }
      }

      db.prepare(`
        UPDATE calendar_import_batches
        SET applied_adjustments_count = ?,
            applied_custom_holidays_count = ?,
            superseded_adjustments_count = ?,
            superseded_custom_holidays_count = ?
        WHERE id = ?
      `).run(
        totalAppliedAdjustments,
        totalAppliedHolidays,
        totalSupersededAdjustments,
        totalSupersededHolidays,
        batchId
      );

      return batchId;
    });

    try {
      const batchId = commitTx();
      return {
        batchId,
        batchCode,
        fiscalYear,
        totalApplied: totalAppliedAdjustments + totalAppliedHolidays,
        appliedAdjustmentsCount: totalAppliedAdjustments,
        appliedCustomHolidaysCount: totalAppliedHolidays,
        supersededAdjustmentsCount: totalSupersededAdjustments,
        supersededCustomHolidaysCount: totalSupersededHolidays,
        message: `年間カレンダー一括インポートが正常に完了しました (Batch: ${batchCode})`,
      };
    } catch (err: any) {
      logAudit({
        actorUserId: currentUserId,
        actorUsername: currentUser.username,
        action: 'CALENDAR_IMPORT_COMMIT_FAILED',
        entityType: 'CALENDAR_IMPORT',
        comment: `カレンダー一括インポート失敗による全ロールバック: ${err.message}`,
        ipAddress: currentUser.ipAddress || '127.0.0.1',
        userAgent: currentUser.userAgent,
        metadata: {
          errorCode: err.code || 'COMMIT_TRANSACTION_FAILED',
          errorMessage: err.message,
          fileSha256: tokenData.fileSha256,
        },
        isSuccess: false,
      });
      throw err;
    }
  }
}

import { CanonicalServiceStatus, ServiceFactSourceType } from './types';

export interface CanonicalFactIdentityInput {
  sourceType: ServiceFactSourceType;
  sourceTable: string;
  sourceId: number | string;
  sourceVersion?: number | null;
  workflowCycleId?: number | null;
  targetDate: string;
  startTime?: string | null;
  endTime?: string | null;
  canonicalStatus: CanonicalServiceStatus;
}

/**
 * 区切り文字エスケープ (Delimiter Collision 対策)
 * '|', ':', '\\' をエスケープする
 */
function escapeIdentityToken(val: string | number): string {
  const str = String(val);
  return str.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/\|/g, '\\|');
}

/**
 * 時刻文字列の正規化 (HH:MM 形式の厳密統一)
 */
function normalizeTimeString(timeStr?: string | null): string {
  if (!timeStr || typeof timeStr !== 'string' || timeStr.trim() === '') {
    return 'NO_TIME';
  }
  const clean = timeStr.trim();
  const parts = clean.split(':');
  if (parts.length >= 2) {
    const h = String(parseInt(parts[0], 10)).padStart(2, '0');
    const m = String(parseInt(parts[1], 10)).padStart(2, '0');
    return `${h}${m}`;
  }
  return clean.replace(/[^0-9]/g, '');
}

/**
 * Canonical Fact Identity 決定論的生成機構
 * 
 * 構造:
 * [sourceType]|[sourceTable]|[sourceId]|[sourceVersion_Sentinel]|[cycleId_Sentinel]|[targetDate]|[normStart]|[normEnd]|[canonicalStatus]
 */
export function generateCanonicalFactIdentity(input: CanonicalFactIdentityInput): string {
  // 1. 各要素の明示的 Sentinel 解決
  const sType = escapeIdentityToken(input.sourceType);
  const sTable = escapeIdentityToken(input.sourceTable);
  const sId = escapeIdentityToken(input.sourceId);

  // 重要: Version/Cycle の欠損値を Version 1 / Cycle 0 と誤同一視しないための明示的 Sentinel
  const sVer = input.sourceVersion !== undefined && input.sourceVersion !== null
    ? `VER_${input.sourceVersion}`
    : 'NO_VERSION';

  const sCycle = input.workflowCycleId !== undefined && input.workflowCycleId !== null
    ? `CYCLE_${input.workflowCycleId}`
    : 'NO_CYCLE';

  // 2. 日付の正規化 (YYYY-MM-DD)
  const normDate = input.targetDate.trim();

  // 3. 開始・終了時刻の正規化
  const normStart = input.startTime ? normalizeTimeString(input.startTime) : 'NO_START';
  const normEnd = input.endTime ? normalizeTimeString(input.endTime) : 'NO_END';

  const status = escapeIdentityToken(input.canonicalStatus);

  // 4. パイプ '|' による決定論的結合
  return [
    sType,
    sTable,
    sId,
    sVer,
    sCycle,
    normDate,
    normStart,
    normEnd,
    status
  ].join('|');
}

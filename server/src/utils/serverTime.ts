/**
 * Server Time Authority: 業務上意味を持つすべての時刻をサーバー側で生成・管理する
 * クライアントから送信された時刻は信用せず、必ず本関数で生成した時刻を採用する。
 */

export function getServerTime(): Date {
  return new Date();
}

export function getServerIsoString(): string {
  return getServerTime().toISOString();
}

export function formatServerTimestamp(date: Date = getServerTime()): string {
  const d = date;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Server Canonical Business Date: 日本標準時 (JST) 基準の業務日付 (YYYY-MM-DD)
 * クライアント端末の日時や UTC ISO 文字列切り出しではなく、サーバー側の業務日付 SSOT を返す。
 */
export function getCanonicalBusinessDate(date: Date = getServerTime()): string {
  return toTokyoCalendarDate(date);
}

/**
 * 任意のタイムスタンプ / ISO 文字列 / Date オブジェクトを
 * 日本標準時 (Asia/Tokyo) の公務暦日 (YYYY-MM-DD) へ決定論的に変換する
 */
export function toTokyoCalendarDate(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date input for toTokyoCalendarDate: ${input}`);
  }
  // Asia/Tokyo タイムゾーンでフォーマット
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // ja-JP formatted as YYYY/MM/DD
  const parts = formatter.formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  const day = parts.find((p) => p.type === 'day')?.value || '';
  return `${year}-${month}-${day}`;
}



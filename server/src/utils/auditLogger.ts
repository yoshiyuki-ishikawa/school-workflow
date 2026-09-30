import crypto from 'crypto';
import { getDb } from '../db/database';
import { getServerIsoString } from './serverTime';

export interface AuditLogParams {
  eventId?: string;
  actorUserId?: number | null;
  actorUsername?: string;
  subjectUserId?: number | null;
  submissionActorType?: 'SELF' | 'PROXY' | 'SYSTEM' | string;
  submissionMode?: 'SINGLE' | 'BATCH' | string;
  roleSnapshot?: string;
  action: string;
  entityType?: string;
  entityId?: string | number | null;
  entityVersion?: number | null;
  requestId?: string | null;
  beforeState?: string | null;
  afterState?: string | null;
  comment?: string | null;
  ipAddress: string;
  userAgent?: string | null;
  metadata?: Record<string, any> | null;
  isSuccess?: boolean;

  // 互換性用エイリアス
  userId?: number | null;
  username?: string;
  targetType?: string;
  targetId?: string | number | null;
}

/**
 * 監査ログ書き込みのコアロジック
 */
function writeAuditLogCore(params: AuditLogParams): void {
  const db = getDb();
  const timestamp = getServerIsoString();
  const eventId = params.eventId || crypto.randomUUID();

  const actorUserId = params.actorUserId !== undefined ? params.actorUserId : (params.userId ?? null);
  const actorUsername = params.actorUsername || params.username || 'ANONYMOUS';
  const subjectUserId = params.subjectUserId !== undefined ? params.subjectUserId : actorUserId;
  const submissionActorType = params.submissionActorType || (actorUserId === subjectUserId ? 'SELF' : 'PROXY');
  const submissionMode = params.submissionMode || 'SINGLE';
  const entityType = params.entityType || params.targetType || 'APPLICATION';
  const entityId = params.entityId ? String(params.entityId) : (params.targetId ? String(params.targetId) : null);

  // 直前のログの event_hash を取得 (チェーン構築)
  let prevHash = '';
  try {
    const lastLog = db.prepare('SELECT event_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get() as { event_hash?: string } | undefined;
    prevHash = lastLog?.event_hash || 'GENESIS_HASH';
  } catch {
    prevHash = 'GENESIS_HASH';
  }

  const metadataStr = params.metadata ? JSON.stringify(params.metadata) : null;
  const isSuccess = params.isSuccess === false ? 0 : 1;

  // event_hash の計算 (SHA-256)
  const hashPayload = `${eventId}:${timestamp}:${actorUserId}:${subjectUserId}:${submissionActorType}:${submissionMode}:${params.action}:${entityType}:${entityId}:${params.entityVersion || 1}:${params.beforeState || ''}:${params.afterState || ''}:${prevHash}`;
  const eventHash = crypto.createHash('sha256').update(hashPayload).digest('hex');

  const stmt = db.prepare(`
    INSERT INTO audit_logs (
      event_id, server_timestamp, actor_user_id, actor_username, subject_user_id,
      submission_actor_type, submission_mode, action, entity_type, entity_id,
      entity_version, request_id, before_state, after_state, comment,
      ip_address, user_agent, metadata, prev_hash, event_hash, is_success
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `);

  stmt.run(
    eventId,
    timestamp,
    actorUserId,
    actorUsername,
    subjectUserId,
    submissionActorType,
    submissionMode,
    params.action,
    entityType,
    entityId,
    params.entityVersion ?? 1,
    params.requestId ?? null,
    params.beforeState ?? null,
    params.afterState ?? null,
    params.comment ?? null,
    params.ipAddress || 'UNKNOWN',
    params.userAgent ?? null,
    metadataStr,
    prevHash,
    eventHash,
    isSuccess
  );
}

/**
 * 監査ログの独立永続化 (Forensic & Audit Trail)
 * 業務トランザクションの成否・ロールバックに関わらず、即時自動コミットで独立してDBに書き込む。
 * 改ざん検知チェーン（prev_hash / event_hash）を自動計算。
 */
export function logAudit(params: AuditLogParams): void {
  try {
    writeAuditLogCore(params);
  } catch (err) {
    // 監査ログ書き込み自体のエラーは標準エラー出力・ログファイルへ退避
    console.error('CRITICAL: Failed to write forensic audit log:', err, params);
  }
}

/**
 * トランザクション内同期監査ログ記録 (Strict Audit Trail)
 * 業務トランザクション内で実行され、AuditLog書き込みに失敗した場合は例外を throw して
 * トランザクション全体を All-or-Nothing で確実にロールバックさせる (INV-017)。
 */
export function logAuditStrict(params: AuditLogParams): void {
  writeAuditLogCore(params);
}


import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import os from 'os';
import { getDb, createBackup, checkIntegrity } from '../db/database';
import { config } from '../config';
import { requireRole, requirePermission, getUserContext } from '../middlewares/auth';
import { logAudit, logAuditStrict } from '../utils/auditLogger';
import { getCanonicalBusinessDate } from '../utils/serverTime';
import { PolicyActivationService } from '../services/policyActivationService';
import { generateTemporaryCredential } from '../domain/auth/passwordPolicy';
import {
  validateUserAuthorizationInvariant,
  AuthorizationInvariantError,
  CanonicalPositionAssignment,
} from '../domain/auth/authorizationInvariant';
import { OfficialJobTitleResolver } from '../domain/jobTitle/officialJobTitleResolver';
import {
  WorkTimeInterval,
  StatutoryPatternCode,
  ScheduleSource,
  DayScheduleDetail,
  validateWorkIntervals,
  timeToMinutes,
  minutesToTime,
} from '../services/attendance/workPatternResolver';

function getPreviousDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getPreviousLocalDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  const prevYear = utcDate.getUTCFullYear();
  const prevMonth = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const prevDay = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${prevYear}-${prevMonth}-${prevDay}`;
}

function isValidIsoDate(dateStr: string): boolean {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const router = Router();


// 管理画面アクセス制御: 管理者または管理職(ADMIN, VICE_PRINCIPAL, PRINCIPAL)のみ許可
router.use((req: Request, res: Response, next) => {
  const user = getUserContext(req);
  if (!user) {
    res.status(401).json({ success: false, message: 'ログインが必要です' });
    return;
  }
  const isAuthorized = user.roles.some((r) => ['ADMIN', 'VICE_PRINCIPAL', 'PRINCIPAL'].includes(r));
  if (!isAuthorized) {
    res.status(403).json({ success: false, message: '管理者または管理職権限が必要です' });
    return;
  }
  next();
});

/**
 * 監査ログ一覧取得
 */
router.get('/audit-logs', (req: Request, res: Response): void => {
  const db = getDb();
  const limit = parseInt(req.query.limit as string, 10) || 100;
  const logs = db.prepare(`
    SELECT * FROM audit_logs
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);

  res.json({ success: true, logs });
});

/**
 * ユーザー一覧取得 (現在有効なPosition情報を含む)
 */
router.get('/users', (req: Request, res: Response): void => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.family_name, u.given_name, u.stamp_name, u.department, u.is_active, u.created_at,
           GROUP_CONCAT(DISTINCT ur.role_id) as roles
    FROM users u
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    GROUP BY u.id
    ORDER BY u.id ASC
  `).all() as any[];

  // 各ユーザーの現在有効なPositionを取得
  const activePositions = db.prepare(`
    SELECT up.user_id, up.position_id, up.is_primary, up.effective_from, up.effective_to,
           p.name as position_name, p.rank_order, p.holder_type
    FROM user_positions up
    JOIN positions p ON up.position_id = p.id
    WHERE up.effective_from <= ?
      AND (up.effective_to IS NULL OR up.effective_to >= ?)
    ORDER BY up.is_primary DESC, p.rank_order ASC
  `).all(today, today) as any[];

  const userPosMap = new Map<number, any[]>();
  for (const pos of activePositions) {
    if (!userPosMap.has(pos.user_id)) {
      userPosMap.set(pos.user_id, []);
    }
    userPosMap.get(pos.user_id)!.push({
      id: pos.position_id,
      name: pos.position_name,
      rankOrder: pos.rank_order,
      holderType: pos.holder_type,
      isPrimary: pos.is_primary === 1,
      effectiveFrom: pos.effective_from,
      effectiveTo: pos.effective_to,
    });
  }

  // 各ユーザーの現在有効なOfficialJobTitleを取得
  const activeJobTitles = db.prepare(`
    SELECT ujt.user_id, ujt.job_title_id, ujt.effective_from, ujt.effective_to,
           ojt.code as job_title_code, ojt.display_name as job_title_name
    FROM user_job_titles ujt
    JOIN official_job_titles ojt ON ujt.job_title_id = ojt.id
    WHERE ujt.effective_from <= ?
      AND (ujt.effective_to IS NULL OR ujt.effective_to >= ?)
    ORDER BY ujt.id DESC
  `).all(today, today) as any[];

  const userJobTitleMap = new Map<number, any>();
  for (const jt of activeJobTitles) {
    if (!userJobTitleMap.has(jt.user_id)) {
      userJobTitleMap.set(jt.user_id, {
        id: jt.job_title_id,
        code: jt.job_title_code,
        name: jt.job_title_name,
        effectiveFrom: jt.effective_from,
        effectiveTo: jt.effective_to,
      });
    }
  }

  const formatted = users.map((u) => {
    const positions = userPosMap.get(u.id) || [];
    const primaryPos = positions.find((p) => p.isPrimary) || (positions.length > 0 ? positions[0] : null);
    const currentJobTitle = userJobTitleMap.get(u.id) || null;
    return {
      ...u,
      roles: u.roles ? u.roles.split(',') : [],
      currentPositions: positions,
      currentPrimaryPosition: primaryPos,
      currentOfficialJobTitle: currentJobTitle ? currentJobTitle.name : null,
      currentOfficialJobTitleDetail: currentJobTitle ? currentJobTitle : null,
    };
  });

  res.json({ success: true, users: formatted });
});

/**
 * 新規教職員の登録 (管理者用)
 */
router.post('/users', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '新規教職員の登録はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const {
    username,
    password,
    displayName,
    familyName,
    givenName,
    stampName,
    department,
    roles,
    initialAnnualLeaveDays,
  } = req.body;

  if (!username || !password || !displayName || !department) {
    res.status(400).json({ success: false, message: 'ユーザー名、パスワード、氏名、所属は必須です' });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    res.status(409).json({ success: false, message: `ユーザー名「${username.trim()}」は既に使用されています` });
    return;
  }

  const bcrypt = require('bcryptjs');
  const passwordHash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const currentFiscalYear = new Date().getFullYear();

  const finalFamilyName = familyName?.trim() || displayName.trim().split(/[\s　]+/)[0] || displayName.trim().slice(0, 2);
  const finalGivenName = givenName?.trim() || displayName.trim().split(/[\s　]+/)[1] || '';
  const finalStampName = stampName?.trim() || finalFamilyName.slice(0, 4);
  const userRoles = Array.isArray(roles) && roles.length > 0 ? roles : ['TEACHER'];
  const leaveDays = Number(initialAnnualLeaveDays) || 20;
  const baseDate = `${currentFiscalYear}-04-01`;
  const expiresDate = `${currentFiscalYear + 1}-03-31`;

  // FROZEN CONTRACT 2: Point-in-Time Coverage Gate
  // 新規教職員の初期勤務パターン（SCHOOL_DEFAULT）の開始日（baseDate）時点で有効な学校標準日課が存在するか検証
  const activeSchoolSchedule = db.prepare(`
    SELECT id FROM school_work_schedules
    WHERE effective_from <= ? AND effective_to >= ? AND is_active = 1
    LIMIT 1
  `).get(baseDate, baseDate) as any;

  if (!activeSchoolSchedule) {
    res.status(400).json({
      success: false,
      errorCode: 'SCHOOL_DEFAULT_NOT_CONFIGURED',
      message: `勤務パターンの開始日（${baseDate}）時点で有効な学校標準日課が登録されていません`,
    });
    return;
  }

  const runTx = db.transaction(() => {
    // 1. users テーブル挿入
    const userRes = db.prepare(`
      INSERT INTO users (
        username, password_hash, display_name, family_name, given_name, stamp_name, department, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      username.trim(),
      passwordHash,
      displayName.trim(),
      finalFamilyName,
      finalGivenName,
      finalStampName,
      department.trim(),
      now
    );

    const newUserId = Number(userRes.lastInsertRowid);

    // 2. user_roles テーブル挿入
    const insertRole = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
    for (const r of userRoles) {
      insertRole.run(newUserId, r);
    }

    // 3. user_leave_settings および leave_grants 初期データ投入
    db.prepare(`
      INSERT OR REPLACE INTO user_leave_settings (user_id, annual_base_date, updated_at)
      VALUES (?, ?, ?)
    `).run(newUserId, baseDate, now);

    db.prepare(`
      INSERT INTO leave_grants (
        user_id, leave_type, granted_amount, grant_date, effective_from, expires_at, reason, created_at
      ) VALUES (?, 'ANNUAL', ?, ?, ?, ?, '採用・異動初期付与', ?)
    `).run(newUserId, leaveDays, baseDate, baseDate, expiresDate, now);

    // 4. 初期勤務パターン (user_work_patterns) の登録 (Canonical Default: SCHOOL_DEFAULT)
    const { patternName, patternType, weeklyOffDays } = req.body;
    const pName = patternName?.trim() || '通常フルタイム (週5日・土日週休)';
    const pType = patternType || 'STANDARD_FULLTIME';
    const offDays = weeklyOffDays !== undefined ? (Array.isArray(weeklyOffDays) ? weeklyOffDays.join(',') : String(weeklyOffDays)) : '0,6';

    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, weekly_total_minutes, memo, record_origin,
        created_by_user_id, created_at, updated_by_user_id, updated_at, schedule_source
      ) VALUES (?, ?, ?, ?, '9999-12-31', ?, 2325, '採用・新規教職員初期登録', 'ADMIN_CONFIGURED', ?, ?, ?, ?, 'SCHOOL_DEFAULT')
    `).run(newUserId, pName, pType, baseDate, offDays, user.id, now, user.id, now);

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: newUserId,
      action: 'CREATE_USER',
      entityType: 'USER',
      entityId: newUserId,
      afterState: 'ACTIVE',
      comment: `新規教職員登録: ${displayName} (${username}) [${userRoles.join(',')}]`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    return newUserId;
  });

  try {
    const newUserId = runTx();

    res.status(201).json({
      success: true,
      message: `教職員「${displayName}」を新規登録しました`,
      data: { id: newUserId },
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: `登録エラー: ${err.message}` });
  }
});

/**
 * 教職員のパスワード初期化・一時パスワード発行 (管理者用)
 * Dedicated Permission: user.credential.reset (AD-PW-01, AD-PW-02 Model C)
 * CAS 楽観排他制御 (WHERE id = ? AND auth_version = ?) により Lost Update を完全防止
 */
router.post('/users/:id/reset-password', requirePermission('user.credential.reset'), (req: Request, res: Response): void => {
  const adminUser = getUserContext(req)!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);

  if (isNaN(targetUserId)) {
    res.status(400).json({ success: false, message: '無効なユーザーIDです' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT id, username, display_name, is_active, auth_version FROM users WHERE id = ?').get(targetUserId) as any;

  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象教職員が見つかりません' });
    return;
  }

  if (targetUser.is_active === 0) {
    res.status(400).json({ success: false, message: '無効化されたアカウントのパスワードはリセットできません' });
    return;
  }

  // 暗号論的不偏サンプリングによる一時パスワード生成 (57文字種 / 16文字)
  const tempPassword = generateTemporaryCredential();
  const bcrypt = require('bcryptjs');
  const tempHash = bcrypt.hashSync(tempPassword, 10);
  const now = new Date().toISOString();
  const expectedAuthVersion = targetUser.auth_version || 1;
  const nextAuthVersion = expectedAuthVersion + 1;

  const runTx = db.transaction(() => {
    // CAS UPDATE
    const updateRes = db.prepare(`
      UPDATE users
      SET password_hash = ?,
          must_change_password = 1,
          auth_version = ?,
          password_changed_at = ?
      WHERE id = ? AND auth_version = ?
    `).run(tempHash, nextAuthVersion, now, targetUserId, expectedAuthVersion);

    if (updateRes.changes === 0) {
      throw {
        statusCode: 409,
        errorCode: 'AUTH_STATE_CONFLICT',
        message: '認証情報の排他制御競合が発生しました（他の操作によって更新されました）。再試行してください。',
      };
    }

    logAuditStrict({
      actorUserId: adminUser.id,
      actorUsername: adminUser.username,
      subjectUserId: targetUserId,
      action: 'ADMIN_PASSWORD_RESET',
      entityType: 'USER',
      entityId: targetUserId,
      afterState: 'MUST_CHANGE_PASSWORD',
      comment: `教職員 [${targetUser.display_name} (${targetUser.username})] のパスワードを初期化（一時パスワード発行）`,
      ipAddress: adminUser.ipAddress,
      userAgent: adminUser.userAgent,
    });
  });

  try {
    runTx();

    res.json({
      success: true,
      message: `教職員「${targetUser.display_name}」の一時パスワードを発行しました`,
      temporaryPassword: tempPassword, // 一回限りレスポンス
      targetUser: {
        id: targetUser.id,
        username: targetUser.username,
        displayName: targetUser.display_name,
      },
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({
      success: false,
      errorCode: err.errorCode || 'INTERNAL_ERROR',
      message: err.message || 'パスワードリセットエラー',
    });
  }
});

/**
 * 教職員の改姓・氏名変更 (管理者用)
 * displayName, familyName, givenName, stampName を一括安全更新
 */
router.put('/users/:id/name', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '氏名変更はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);
  const { displayName, familyName, givenName, stampName, reason } = req.body;

  if (!displayName || displayName.trim() === '') {
    res.status(400).json({ success: false, message: '氏名（displayName）は必須です' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const cleanDisplayName = displayName.trim();
  const parts = cleanDisplayName.split(/[\s　]+/);
  const finalFamilyName = familyName !== undefined ? familyName.trim() : (parts[0] || '');
  const finalGivenName = givenName !== undefined ? givenName.trim() : (parts.slice(1).join(' ') || '');
  const finalStampName = stampName !== undefined && stampName.trim() !== ''
    ? stampName.trim().slice(0, 4)
    : (finalFamilyName || cleanDisplayName).slice(0, 4);

  const beforeState = JSON.stringify({
    displayName: targetUser.display_name,
    familyName: targetUser.family_name,
    givenName: targetUser.given_name,
    stampName: targetUser.stamp_name,
  });

  const afterState = JSON.stringify({
    displayName: cleanDisplayName,
    familyName: finalFamilyName,
    givenName: finalGivenName,
    stampName: finalStampName,
  });

  const runTx = db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET display_name = ?, family_name = ?, given_name = ?, stamp_name = ?
      WHERE id = ?
    `).run(cleanDisplayName, finalFamilyName, finalGivenName, finalStampName, targetUserId);

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'UPDATE_USER_NAME',
      entityType: 'USER',
      entityId: targetUserId,
      beforeState,
      afterState,
      comment: `教職員改姓・氏名変更 [${targetUser.display_name} -> ${cleanDisplayName}] (印影: ${targetUser.stamp_name} -> ${finalStampName})${reason ? ` 理由: ${reason.trim()}` : ''}`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  try {
    runTx();
    res.json({
      success: true,
      message: `教職員「${targetUser.display_name}」の氏名を「${cleanDisplayName}」に更新しました`,
      data: {
        id: targetUserId,
        displayName: cleanDisplayName,
        familyName: finalFamilyName,
        givenName: finalGivenName,
        stampName: finalStampName,
      },
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: `氏名更新エラー: ${err.message}` });
  }
});

/**
 * 教職員の印影用氏名 (stamp_name) の更新 (管理者用)
 */
router.put('/users/:id/stamp-name', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '印影名変更はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);
  const { stampName, familyName, givenName } = req.body;

  if (!stampName || stampName.trim() === '') {
    res.status(400).json({ success: false, message: '印影用氏名（stamp_name）を入力してください' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const runTx = db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET stamp_name = ?, family_name = COALESCE(?, family_name), given_name = COALESCE(?, given_name)
      WHERE id = ?
    `).run(stampName.trim(), familyName || null, givenName || null, targetUserId);

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'UPDATE_STAMP_NAME',
      entityType: 'USER',
      entityId: targetUserId,
      beforeState: targetUser.stamp_name,
      afterState: stampName.trim(),
      comment: `印影用氏名更新 [${targetUser.display_name}] ${targetUser.stamp_name} -> ${stampName.trim()}`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  try {
    runTx();
    res.json({ success: true, message: '印影用氏名を更新しました', stampName: stampName.trim() });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: `印影名更新エラー: ${err.message}` });
  }
});

/**
 * 教職員の保有ロール（権限）の更新 (ADMIN専用)
 */
router.put('/users/:id/roles', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '権限ロール変更はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);
  const { roles, expectedRoles } = req.body;

  if (!Array.isArray(roles) || roles.length === 0) {
    res.status(400).json({ success: false, message: '保有ロールを1つ以上指定してください' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const currentRoles = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(targetUserId) as { role_id: string }[];
  const currentRoleIds = currentRoles.map((r) => r.role_id);
  const beforeRolesStr = currentRoleIds.join(',');

  // Concurrency Protection: expectedRoles が指定されている場合の比較検証 (Lost Update防止)
  if (Array.isArray(expectedRoles)) {
    const currentSorted = [...currentRoleIds].sort().join(',');
    const expectedSorted = [...expectedRoles].sort().join(',');
    if (currentSorted !== expectedSorted) {
      res.status(409).json({
        success: false,
        errorCode: 'CONFLICT_DETECTED',
        message: '他の管理者によって権限が更新されています。最新情報を再取得してください。',
      });
      return;
    }
  }

  const afterRolesStr = roles.join(',');

  const runTx = db.transaction(() => {
    // 1. Shared Authorization Invariant: 変更後ロールと現在有効な役職との組織・機能適合性を検証
    const currentPositions = db.prepare(`
      SELECT position_id, effective_from, effective_to, is_primary
      FROM user_positions
      WHERE user_id = ?
    `).all(targetUserId) as any[];

    validateUserAuthorizationInvariant({
      userId: targetUserId,
      roles,
      positions: currentPositions.map((p) => ({
        positionId: p.position_id,
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        isPrimary: p.is_primary === 1,
      })),
    });

    // 2. Last ADMIN Protection: 最後のADMINユーザーからADMINロールを削除することを防止 (P0-2)
    const hadAdmin = currentRoleIds.includes('ADMIN');
    const willHaveAdmin = roles.includes('ADMIN');
    if (hadAdmin && !willHaveAdmin) {
      const otherAdminCount = (db.prepare(`
        SELECT COUNT(DISTINCT user_id) as cnt
        FROM user_roles
        WHERE role_id = 'ADMIN' AND user_id != ?
      `).get(targetUserId) as any)?.cnt || 0;

      if (otherAdminCount === 0) {
        throw {
          statusCode: 400,
          errorCode: 'LAST_ADMIN_PROTECTION',
          message: 'システム上に存在する最後のシステム管理者（ADMIN）の権限を削除することはできません',
        };
      }
    }

    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(targetUserId);
    const insertRole = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
    for (const r of roles) {
      insertRole.run(targetUserId, r);
    }

    // Strict Audit Log inside same transaction (All-or-Nothing: INV-017)
    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'UPDATE_USER_ROLES',
      entityType: 'USER',
      entityId: targetUserId,
      beforeState: beforeRolesStr,
      afterState: afterRolesStr,
      comment: `権限・ロール変更 [${targetUser.display_name}]: ${beforeRolesStr} -> ${afterRolesStr}`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  try {
    runTx();
    res.json({ success: true, message: `「${targetUser.display_name}」の権限を更新しました`, roles });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({
      success: false,
      errorCode: err.errorCode || 'INTERNAL_ERROR',
      message: err.message || `権限更新エラー: ${err.message}`,
    });
  }
});

/**
 * 役職マスタ一覧取得 (ADMIN / 管理職)
 */
router.get('/positions', (req: Request, res: Response): void => {
  const db = getDb();
  const positions = db.prepare('SELECT id, name, rank_order, holder_type, description FROM positions ORDER BY rank_order ASC').all();
  res.json({ success: true, positions });
});

/**
 * 特定教職員の役職割当履歴一覧取得
 */
router.get('/users/:id/positions', (req: Request, res: Response): void => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const targetUser = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const list = db.prepare(`
    SELECT up.id, up.user_id, up.position_id, up.is_primary, up.effective_from, up.effective_to,
           up.created_at, up.updated_at,
           p.name as position_name, p.rank_order, p.holder_type, p.description as position_desc
    FROM user_positions up
    JOIN positions p ON up.position_id = p.id
    WHERE up.user_id = ?
    ORDER BY up.effective_from DESC, up.id DESC
  `).all(targetUserId) as any[];

  const currentPositions = list.filter((p) => p.effective_from <= today && (!p.effective_to || p.effective_to >= today));
  const currentPrimaryPosition = currentPositions.find((p) => p.is_primary === 1) || (currentPositions.length > 0 ? currentPositions[0] : null);

  res.json({
    success: true,
    user: targetUser,
    positions: list,
    currentPositions,
    currentPrimaryPosition,
  });
});

/**
 * 役職割当の新規登録 (ADMINのみ)
 */
router.post('/users/:id/positions', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '役職割当の登録はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);
  const { positionId, effectiveFrom, effectiveTo = '9999-12-31', isPrimary = false, note } = req.body;

  if (!positionId || !effectiveFrom) {
    res.status(400).json({ success: false, message: '役職と有効開始日は必須です' });
    return;
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(effectiveFrom) || !dateRegex.test(effectiveTo)) {
    res.status(400).json({ success: false, message: '日付形式は YYYY-MM-DD で指定してください' });
    return;
  }

  if (effectiveFrom > effectiveTo) {
    res.status(400).json({ success: false, message: '有効開始日は有効終了日以前の日付を指定してください' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const targetPosition = db.prepare('SELECT id, name, holder_type FROM positions WHERE id = ?').get(positionId) as any;
  if (!targetPosition) {
    res.status(400).json({ success: false, message: `指定された役職（${positionId}）が存在しません` });
    return;
  }

  // 1. 同一ユーザー・同一Positionの期間重複検証
  const overlapUserPos = db.prepare(`
    SELECT id, effective_from, effective_to FROM user_positions
    WHERE user_id = ? AND position_id = ?
      AND effective_from <= ? AND effective_to >= ?
  `).get(targetUserId, positionId, effectiveTo, effectiveFrom) as any;

  if (overlapUserPos) {
    res.status(400).json({
      success: false,
      errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
      message: `同一教職員に対して同じ役職の期間（${overlapUserPos.effective_from}〜${overlapUserPos.effective_to}）が重複しています`,
    });
    return;
  }

  // 2. SINGLE_HOLDER の場合、他ユーザーとの期間重複検証 (1名制限)
  if (targetPosition.holder_type === 'SINGLE_HOLDER') {
    const overlapHolder = db.prepare(`
      SELECT up.id, up.user_id, up.effective_from, up.effective_to, u.display_name
      FROM user_positions up
      JOIN users u ON up.user_id = u.id
      WHERE up.position_id = ? AND up.user_id != ?
        AND up.effective_from <= ? AND up.effective_to >= ?
    `).get(positionId, targetUserId, effectiveTo, effectiveFrom) as any;

    if (overlapHolder) {
      res.status(400).json({
        success: false,
        errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
        message: `役職「${targetPosition.name}」は単一担当役職(SINGLE_HOLDER)です。指定期間内に既に「${overlapHolder.display_name}」(${overlapHolder.effective_from}〜${overlapHolder.effective_to})が配置されています`,
      });
      return;
    }
  }

  // 3. isPrimary = true の場合、同一ユーザーの他Primary期間重複検証
  const isPrimaryInt = isPrimary ? 1 : 0;
  if (isPrimaryInt === 1) {
    const overlapPrimary = db.prepare(`
      SELECT up.id, up.position_id, up.effective_from, up.effective_to, p.name as position_name
      FROM user_positions up
      JOIN positions p ON up.position_id = p.id
      WHERE up.user_id = ? AND up.is_primary = 1
        AND up.effective_from <= ? AND up.effective_to >= ?
    `).get(targetUserId, effectiveTo, effectiveFrom) as any;

    if (overlapPrimary) {
      res.status(400).json({
        success: false,
        errorCode: 'PRIMARY_POSITION_CONFLICT',
        message: `指定期間内に既に別の主たる役職「${overlapPrimary.position_name}」(${overlapPrimary.effective_from}〜${overlapPrimary.effective_to})が設定されています`,
      });
      return;
    }
  }

  const now = new Date().toISOString();

  const runTx = db.transaction(() => {
    // 0. Shared Authorization Invariant: 割当後の役職と現在のロールとの適合性を検証
    const currentRoles = (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(targetUserId) as any[]).map((r) => r.role_id);
    const existingPositions = db.prepare(`
      SELECT position_id, effective_from, effective_to, is_primary
      FROM user_positions
      WHERE user_id = ?
    `).all(targetUserId) as any[];

    const proposedPositions: CanonicalPositionAssignment[] = [
      ...existingPositions.map((p) => ({
        positionId: p.position_id,
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        isPrimary: p.is_primary === 1,
      })),
      {
        positionId,
        effectiveFrom,
        effectiveTo,
        isPrimary: isPrimaryInt === 1,
      },
    ];

    validateUserAuthorizationInvariant({
      userId: targetUserId,
      roles: currentRoles,
      positions: proposedPositions,
    });

    const insertRes = db.prepare(`
      INSERT INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(targetUserId, positionId, isPrimaryInt, effectiveFrom, effectiveTo, now, now);

    const assignmentId = Number(insertRes.lastInsertRowid);

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'ASSIGN_USER_POSITION',
      entityType: 'USER_POSITION',
      entityId: assignmentId,
      beforeState: null,
      afterState: JSON.stringify({ positionId, positionName: targetPosition.name, isPrimary: isPrimaryInt, effectiveFrom, effectiveTo }),
      comment: `役職割当 [${targetUser.display_name}] ${targetPosition.name} (${effectiveFrom}〜${effectiveTo}) [Primary: ${isPrimaryInt}] ${note || ''}`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    return assignmentId;
  });

  try {
    const assignmentId = runTx();
    res.status(201).json({
      success: true,
      message: `「${targetUser.display_name}」に役職「${targetPosition.name}」を割り当てました`,
      assignmentId,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: `役職割当エラー: ${err.message}` });
  }
});

/**
 * 役職割当の有効期間終了 (解除: END API, 物理DELETE禁止)
 */
router.post('/users/:id/positions/:assignmentId/end', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '役職終了はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawUserId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawUserId, 10);
  const rawAssignmentId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const assignmentId = parseInt(rawAssignmentId, 10);
  const { endDate, reason, expectedEffectiveTo } = req.body;

  if (!endDate) {
    res.status(400).json({ success: false, message: '終了日 (endDate: YYYY-MM-DD) は必須です' });
    return;
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(endDate)) {
    res.status(400).json({ success: false, message: '終了日は YYYY-MM-DD 形式で指定してください' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const assignment = db.prepare(`
    SELECT up.*, p.name as position_name
    FROM user_positions up
    JOIN positions p ON up.position_id = p.id
    WHERE up.id = ? AND up.user_id = ?
  `).get(assignmentId, targetUserId) as any;

  if (!assignment) {
    res.status(404).json({ success: false, message: '対象の役職割当レコードが見つかりません' });
    return;
  }

  // Concurrency Protection: 楽観ロック競合検証
  if (expectedEffectiveTo !== undefined && assignment.effective_to !== expectedEffectiveTo) {
    res.status(409).json({
      success: false,
      errorCode: 'CONFLICT_DETECTED',
      message: '他の管理者によって役職期間が更新されています。最新情報を再取得してください。',
    });
    return;
  }

  if (endDate < assignment.effective_from) {
    res.status(400).json({
      success: false,
      message: `終了日(${endDate})は開始日(${assignment.effective_from})以降の日付を指定してください`,
    });
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const isAlreadyEnded = assignment.effective_to && assignment.effective_to < today;

  if (isAlreadyEnded) {
    if (assignment.effective_to === endDate) {
      res.json({ success: true, message: '既に指定の終了日で終了しています (Idempotent)', assignmentId });
      return;
    }
    res.status(400).json({
      success: false,
      errorCode: 'HISTORICAL_POSITION_IMMUTABLE',
      message: '既に過去に終了済みの役職割当の終了日はEND APIで変更できません。修正が必要な場合は履歴訂正(CORRECT)を使用してください。',
    });
    return;
  }

  const now = new Date().toISOString();

  const runTx = db.transaction(() => {
    db.prepare('UPDATE user_positions SET effective_to = ?, updated_at = ? WHERE id = ?').run(endDate, now, assignmentId);

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'END_USER_POSITION',
      entityType: 'USER_POSITION',
      entityId: assignmentId,
      beforeState: JSON.stringify({ effectiveTo: assignment.effective_to }),
      afterState: JSON.stringify({ effectiveTo: endDate }),
      comment: `役職期間終了 [${targetUser.display_name}] ${assignment.position_name} (終了日: ${endDate}) ${reason ? `理由: ${reason}` : ''}`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  try {
    runTx();
    res.json({
      success: true,
      message: `「${targetUser.display_name}」の役職「${assignment.position_name}」を ${endDate} 付で終了しました`,
      assignmentId,
      effectiveTo: endDate,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: `役職終了エラー: ${err.message}` });
  }
});

/**
 * 役職割当の通常更新 (未来または現在有効な割当のみ許可)
 */
router.put('/users/:id/positions/:assignmentId', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '役職割当の更新はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawUserId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawUserId, 10);
  const rawAssignmentId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const assignmentId = parseInt(rawAssignmentId, 10);
  const { effectiveFrom, effectiveTo, isPrimary, expectedEffectiveFrom, expectedEffectiveTo } = req.body;

  if (!effectiveFrom || !effectiveTo) {
    res.status(400).json({ success: false, message: '有効期間（開始日・終了日）は必須です' });
    return;
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(effectiveFrom) || !dateRegex.test(effectiveTo)) {
    res.status(400).json({ success: false, message: '日付形式は YYYY-MM-DD で指定してください' });
    return;
  }

  if (effectiveFrom > effectiveTo) {
    res.status(400).json({ success: false, message: '有効開始日は有効終了日以前の日付を指定してください' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const assignment = db.prepare(`
    SELECT up.*, p.name as position_name, p.holder_type
    FROM user_positions up
    JOIN positions p ON up.position_id = p.id
    WHERE up.id = ? AND up.user_id = ?
  `).get(assignmentId, targetUserId) as any;

  if (!assignment) {
    res.status(404).json({ success: false, message: '対象の役職割当レコードが見つかりません' });
    return;
  }

  // Concurrency Protection: 楽観ロック競合検証
  if (
    (expectedEffectiveFrom !== undefined && assignment.effective_from !== expectedEffectiveFrom) ||
    (expectedEffectiveTo !== undefined && assignment.effective_to !== expectedEffectiveTo)
  ) {
    res.status(409).json({
      success: false,
      errorCode: 'CONFLICT_DETECTED',
      message: '他の管理者によって役職期間が更新されています。最新情報を再取得してください。',
    });
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  if (assignment.effective_to < today) {
    res.status(400).json({
      success: false,
      errorCode: 'HISTORICAL_POSITION_IMMUTABLE',
      message: '過去に終了済みの役職割当は通常更新できません。履歴訂正(CORRECT API)を使用してください。',
    });
    return;
  }

  // 1. 同一ユーザー・同一Positionの自身を除く重複検証
  const overlapUserPos = db.prepare(`
    SELECT id, effective_from, effective_to FROM user_positions
    WHERE user_id = ? AND position_id = ? AND id != ?
      AND effective_from <= ? AND effective_to >= ?
  `).get(targetUserId, assignment.position_id, assignmentId, effectiveTo, effectiveFrom) as any;

  if (overlapUserPos) {
    res.status(400).json({
      success: false,
      errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
      message: `同一教職員に対して同じ役職の期間（${overlapUserPos.effective_from}〜${overlapUserPos.effective_to}）が重複しています`,
    });
    return;
  }

  // 2. SINGLE_HOLDER の場合、他ユーザーとの期間重複検証
  if (assignment.holder_type === 'SINGLE_HOLDER') {
    const overlapHolder = db.prepare(`
      SELECT up.id, up.user_id, up.effective_from, up.effective_to, u.display_name
      FROM user_positions up
      JOIN users u ON up.user_id = u.id
      WHERE up.position_id = ? AND up.user_id != ? AND up.id != ?
        AND up.effective_from <= ? AND up.effective_to >= ?
    `).get(assignment.position_id, targetUserId, assignmentId, effectiveTo, effectiveFrom) as any;

    if (overlapHolder) {
      res.status(400).json({
        success: false,
        errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
        message: `役職「${assignment.position_name}」は単一担当役職(SINGLE_HOLDER)です。指定期間内に既に「${overlapHolder.display_name}」(${overlapHolder.effective_from}〜${overlapHolder.effective_to})が配置されています`,
      });
      return;
    }
  }

  // 3. isPrimary = true の場合、同一ユーザーの他Primary期間重複検証
  const isPrimaryInt = isPrimary !== undefined ? (isPrimary ? 1 : 0) : assignment.is_primary;
  if (isPrimaryInt === 1) {
    const overlapPrimary = db.prepare(`
      SELECT up.id, up.position_id, up.effective_from, up.effective_to, p.name as position_name
      FROM user_positions up
      JOIN positions p ON up.position_id = p.id
      WHERE up.user_id = ? AND up.is_primary = 1 AND up.id != ?
        AND up.effective_from <= ? AND up.effective_to >= ?
    `).get(targetUserId, assignmentId, effectiveTo, effectiveFrom) as any;

    if (overlapPrimary) {
      res.status(400).json({
        success: false,
        errorCode: 'PRIMARY_POSITION_CONFLICT',
        message: `指定期間内に既に別の主たる役職「${overlapPrimary.position_name}」(${overlapPrimary.effective_from}〜${overlapPrimary.effective_to})が設定されています`,
      });
      return;
    }
  }

  const now = new Date().toISOString();

  const runTx = db.transaction(() => {
    db.prepare(`
      UPDATE user_positions
      SET effective_from = ?, effective_to = ?, is_primary = ?, updated_at = ?
      WHERE id = ?
    `).run(effectiveFrom, effectiveTo, isPrimaryInt, now, assignmentId);

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'UPDATE_USER_POSITION',
      entityType: 'USER_POSITION',
      entityId: assignmentId,
      beforeState: JSON.stringify({ effectiveFrom: assignment.effective_from, effectiveTo: assignment.effective_to, isPrimary: assignment.is_primary }),
      afterState: JSON.stringify({ effectiveFrom, effectiveTo, isPrimary: isPrimaryInt }),
      comment: `役職割当更新 [${targetUser.display_name}] ${assignment.position_name} (${effectiveFrom}〜${effectiveTo}) [Primary: ${isPrimaryInt}]`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  try {
    runTx();
    res.json({
      success: true,
      message: `「${targetUser.display_name}」の役職割当を更新しました`,
      assignmentId,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: `役職更新エラー: ${err.message}` });
  }
});

/**
 * 役職割当の履歴訂正 (専用CORRECT API)
 */
router.post('/users/:id/positions/:assignmentId/correct', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '役職履歴訂正はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawUserId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawUserId, 10);
  const rawAssignmentId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const assignmentId = parseInt(rawAssignmentId, 10);
  const { effectiveFrom, effectiveTo, isPrimary, correctionReason } = req.body;

  if (!correctionReason || !correctionReason.trim()) {
    res.status(400).json({ success: false, message: '履歴訂正には訂正理由(correctionReason)が必須です' });
    return;
  }

  if (!effectiveFrom || !effectiveTo) {
    res.status(400).json({ success: false, message: '有効期間（開始日・終了日）は必須です' });
    return;
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(effectiveFrom) || !dateRegex.test(effectiveTo)) {
    res.status(400).json({ success: false, message: '日付形式は YYYY-MM-DD で指定してください' });
    return;
  }

  if (effectiveFrom > effectiveTo) {
    res.status(400).json({ success: false, message: '有効開始日は有効終了日以前の日付を指定してください' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  const assignment = db.prepare(`
    SELECT up.*, p.name as position_name, p.holder_type
    FROM user_positions up
    JOIN positions p ON up.position_id = p.id
    WHERE up.id = ? AND up.user_id = ?
  `).get(assignmentId, targetUserId) as any;

  if (!assignment) {
    res.status(404).json({ success: false, message: '対象の役職割当レコードが見つかりません' });
    return;
  }

  // 1. 同一ユーザー・同一Positionの自身を除く重複検証
  const overlapUserPos = db.prepare(`
    SELECT id, effective_from, effective_to FROM user_positions
    WHERE user_id = ? AND position_id = ? AND id != ?
      AND effective_from <= ? AND effective_to >= ?
  `).get(targetUserId, assignment.position_id, assignmentId, effectiveTo, effectiveFrom) as any;

  if (overlapUserPos) {
    res.status(400).json({
      success: false,
      errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
      message: `同一教職員に対して同じ役職の期間（${overlapUserPos.effective_from}〜${overlapUserPos.effective_to}）が重複しています`,
    });
    return;
  }

  // 2. SINGLE_HOLDER の場合、他ユーザーとの期間重複検証
  if (assignment.holder_type === 'SINGLE_HOLDER') {
    const overlapHolder = db.prepare(`
      SELECT up.id, up.user_id, up.effective_from, up.effective_to, u.display_name
      FROM user_positions up
      JOIN users u ON up.user_id = u.id
      WHERE up.position_id = ? AND up.user_id != ? AND up.id != ?
        AND up.effective_from <= ? AND up.effective_to >= ?
    `).get(assignment.position_id, targetUserId, assignmentId, effectiveTo, effectiveFrom) as any;

    if (overlapHolder) {
      res.status(400).json({
        success: false,
        errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
        message: `役職「${assignment.position_name}」は単一担当役職(SINGLE_HOLDER)です。指定期間内に既に「${overlapHolder.display_name}」(${overlapHolder.effective_from}〜${overlapHolder.effective_to})が配置されています`,
      });
      return;
    }
  }

  // 3. isPrimary = true の場合、同一ユーザーの他Primary期間重複検証
  const isPrimaryInt = isPrimary !== undefined ? (isPrimary ? 1 : 0) : assignment.is_primary;
  if (isPrimaryInt === 1) {
    const overlapPrimary = db.prepare(`
      SELECT up.id, up.position_id, up.effective_from, up.effective_to, p.name as position_name
      FROM user_positions up
      JOIN positions p ON up.position_id = p.id
      WHERE up.user_id = ? AND up.is_primary = 1 AND up.id != ?
        AND up.effective_from <= ? AND up.effective_to >= ?
    `).get(targetUserId, assignmentId, effectiveTo, effectiveFrom) as any;

    if (overlapPrimary) {
      res.status(400).json({
        success: false,
        errorCode: 'PRIMARY_POSITION_CONFLICT',
        message: `指定期間内に既に別の主たる役職「${overlapPrimary.position_name}」(${overlapPrimary.effective_from}〜${overlapPrimary.effective_to})が設定されています`,
      });
      return;
    }
  }

  const now = new Date().toISOString();

  const runTx = db.transaction(() => {
    // 0. Shared Authorization Invariant: 訂正後の全有効ポジションと現在ロールとの適合性を検証
    const currentRoles = (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(targetUserId) as any[]).map((r) => r.role_id);
    const otherPositions = db.prepare(`
      SELECT position_id, effective_from, effective_to, is_primary
      FROM user_positions
      WHERE user_id = ? AND id != ?
    `).all(targetUserId, assignmentId) as any[];

    const proposedPositions: CanonicalPositionAssignment[] = [
      ...otherPositions.map((p) => ({
        positionId: p.position_id,
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        isPrimary: p.is_primary === 1,
      })),
      {
        assignmentId,
        positionId: assignment.position_id,
        effectiveFrom,
        effectiveTo,
        isPrimary: isPrimaryInt === 1,
      },
    ];

    validateUserAuthorizationInvariant({
      userId: targetUserId,
      roles: currentRoles,
      positions: proposedPositions,
    });

    db.prepare(`
      UPDATE user_positions
      SET effective_from = ?, effective_to = ?, is_primary = ?, updated_at = ?
      WHERE id = ?
    `).run(effectiveFrom, effectiveTo, isPrimaryInt, now, assignmentId);

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'CORRECT_USER_POSITION',
      entityType: 'USER_POSITION',
      entityId: assignmentId,
      beforeState: JSON.stringify({ effectiveFrom: assignment.effective_from, effectiveTo: assignment.effective_to, isPrimary: assignment.is_primary }),
      afterState: JSON.stringify({ effectiveFrom, effectiveTo, isPrimary: isPrimaryInt }),
      comment: `役職履歴訂正 [${targetUser.display_name}] ${assignment.position_name} (${effectiveFrom}〜${effectiveTo}) [Primary: ${isPrimaryInt}] 理由: ${correctionReason.trim()}`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  try {
    runTx();
    res.json({
      success: true,
      message: `「${targetUser.display_name}」の役職履歴を訂正しました`,
      assignmentId,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: `役職履歴訂正エラー: ${err.message}` });
  }
});

/**
 * 統合 役割・役職管理コマンド (Unified Atomic Admin Command: Option U3)
 * 
 * 1回の保存操作でRole（現行状態置換）およびPosition（時系列操作: ASSIGN/END/CORRECT）を
 * 単一トランザクション境界でアトミックに適用する。
 */
router.post('/users/:id/access', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '役割・役職の統合管理はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);
  const {
    roles,
    expectedRoles,
    positionOperations = [],
    expectedPositionSnapshot,
    reason,
  } = req.body;

  if (!Array.isArray(roles) || roles.length === 0) {
    res.status(400).json({ success: false, errorCode: 'INVALID_ROLE', message: '保有ロールを1つ以上指定してください' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT id, display_name, username FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象ユーザーが見つかりません' });
    return;
  }

  // 1. 現行 Role 取得 & 楽観ロック検証
  const currentRoles = (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(targetUserId) as any[]).map((r) => r.role_id);
  if (Array.isArray(expectedRoles)) {
    const currentSorted = [...currentRoles].sort().join(',');
    const expectedSorted = [...expectedRoles].sort().join(',');
    if (currentSorted !== expectedSorted) {
      res.status(409).json({
        success: false,
        errorCode: 'STALE_AUTHORIZATION_STATE',
        message: '他の管理者によって権限が更新されています。最新情報を再取得してください。',
      });
      return;
    }
  }

  // 2. 現行 Position 取得 & 楽観ロック検証 (Canonical Snapshot Comparison)
  const currentDbPositions = db.prepare(`
    SELECT id, position_id, effective_from, effective_to, is_primary
    FROM user_positions
    WHERE user_id = ?
    ORDER BY id ASC
  `).all(targetUserId) as any[];

  if (Array.isArray(expectedPositionSnapshot)) {
    const canonicalCurrent = currentDbPositions
      .map((p) => `${p.id}:${p.position_id}:${p.effective_from}:${p.effective_to || ''}:${p.is_primary}`)
      .sort()
      .join('|');
    const canonicalExpected = expectedPositionSnapshot
      .map((p: any) => `${p.assignmentId || p.id}:${p.positionId || p.position_id}:${p.effectiveFrom || p.effective_from}:${p.effectiveTo || p.effective_to || ''}:${p.isPrimary !== undefined ? (p.isPrimary ? 1 : 0) : (p.is_primary ? 1 : 0)}`)
      .sort()
      .join('|');

    if (canonicalCurrent !== canonicalExpected) {
      res.status(409).json({
        success: false,
        errorCode: 'STALE_AUTHORIZATION_STATE',
        message: '他の管理者によって役職履歴が更新されています。最新情報を再取得してください。',
      });
      return;
    }
  }

  const now = new Date().toISOString();
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  const runTx = db.transaction(() => {
    // 3. Last ADMIN Protection 検証
    const hadAdmin = currentRoles.includes('ADMIN');
    const willHaveAdmin = roles.includes('ADMIN');
    if (hadAdmin && !willHaveAdmin) {
      const otherAdminCount = (db.prepare(`
        SELECT COUNT(DISTINCT user_id) as cnt
        FROM user_roles
        WHERE role_id = 'ADMIN' AND user_id != ?
      `).get(targetUserId) as any)?.cnt || 0;

      if (otherAdminCount === 0) {
        throw {
          statusCode: 400,
          errorCode: 'LAST_ADMIN_PROTECTION',
          message: 'システム上に存在する最後のシステム管理者（ADMIN）の権限を削除することはできません',
        };
      }
    }

    // 4. Proposed Position State のシミュレーション構築とバリデーション
    const simPositions: Map<number, CanonicalPositionAssignment> = new Map();
    for (const p of currentDbPositions) {
      simPositions.set(p.id, {
        assignmentId: p.id,
        positionId: p.position_id,
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        isPrimary: p.is_primary === 1,
      });
    }

    const appliedOperations: any[] = [];

    for (const op of positionOperations) {
      if (op.operation === 'ASSIGN') {
        const { positionId, effectiveFrom, effectiveTo = '9999-12-31', isPrimary = false, note } = op;
        if (!positionId || !effectiveFrom) {
          throw { statusCode: 400, errorCode: 'INVALID_POSITION', message: '新規役職割当には役職IDと開始日が必須です' };
        }
        if (!dateRegex.test(effectiveFrom) || !dateRegex.test(effectiveTo)) {
          throw { statusCode: 400, errorCode: 'INVALID_DATE', message: '日付形式は YYYY-MM-DD で指定してください' };
        }
        if (effectiveFrom > effectiveTo) {
          throw { statusCode: 400, errorCode: 'INVALID_DATE', message: '開始日は終了日以前の日付を指定してください' };
        }

        const targetPosMaster = db.prepare('SELECT id, name, holder_type FROM positions WHERE id = ?').get(positionId) as any;
        if (!targetPosMaster) {
          throw { statusCode: 400, errorCode: 'INVALID_POSITION', message: `指定された役職（${positionId}）が存在しません` };
        }

        // 仮想ID (-1, -2, ...) でシミュレーションに追加
        const tempId = -1 * (appliedOperations.length + 1);
        simPositions.set(tempId, {
          assignmentId: tempId,
          positionId,
          effectiveFrom,
          effectiveTo,
          isPrimary: !!isPrimary,
        });

        appliedOperations.push({ ...op, isPrimaryInt: isPrimary ? 1 : 0, targetPosMaster });
      } else if (op.operation === 'END') {
        const { assignmentId, endDate, reason: endReason } = op;
        if (!assignmentId || !endDate) {
          throw { statusCode: 400, errorCode: 'INVALID_OPERATION', message: '役職終了には割当IDと終了日が必須です' };
        }
        if (!dateRegex.test(endDate)) {
          throw { statusCode: 400, errorCode: 'INVALID_DATE', message: '終了日は YYYY-MM-DD 形式で指定してください' };
        }
        const existing = simPositions.get(assignmentId);
        if (!existing) {
          throw { statusCode: 404, errorCode: 'ASSIGNMENT_NOT_FOUND', message: `対象の役職割当レコード(#${assignmentId})が見つかりません` };
        }
        if (endDate < existing.effectiveFrom) {
          throw { statusCode: 400, errorCode: 'INVALID_DATE', message: `終了日(${endDate})は開始日(${existing.effectiveFrom})以降を指定してください` };
        }

        simPositions.set(assignmentId, {
          ...existing,
          effectiveTo: endDate,
        });

        appliedOperations.push(op);
      } else if (op.operation === 'CORRECT') {
        const { assignmentId, effectiveFrom, effectiveTo, isPrimary, reason: correctReason } = op;
        if (!assignmentId || !effectiveFrom || !effectiveTo) {
          throw { statusCode: 400, errorCode: 'INVALID_OPERATION', message: '役職履歴訂正には割当IDと期間が必須です' };
        }
        if (!correctReason || !correctReason.trim()) {
          throw { statusCode: 400, errorCode: 'INVALID_OPERATION', message: '役職履歴訂正には訂正理由が必須です' };
        }
        if (!dateRegex.test(effectiveFrom) || !dateRegex.test(effectiveTo)) {
          throw { statusCode: 400, errorCode: 'INVALID_DATE', message: '日付形式は YYYY-MM-DD で指定してください' };
        }
        if (effectiveFrom > effectiveTo) {
          throw { statusCode: 400, errorCode: 'INVALID_DATE', message: '開始日は終了日以前の日付を指定してください' };
        }
        const existing = simPositions.get(assignmentId);
        if (!existing) {
          throw { statusCode: 404, errorCode: 'ASSIGNMENT_NOT_FOUND', message: `対象の役職割当レコード(#${assignmentId})が見つかりません` };
        }

        const isPrimaryBool = isPrimary !== undefined ? !!isPrimary : existing.isPrimary;
        simPositions.set(assignmentId, {
          ...existing,
          effectiveFrom,
          effectiveTo,
          isPrimary: isPrimaryBool,
        });

        appliedOperations.push({ ...op, isPrimaryInt: isPrimaryBool ? 1 : 0 });
      }
    }

    // 5. Shared Authorization Invariant: 変更後ロールとシミュレーション後全役職の組織・機能適合性を検証
    const resultingPositions = Array.from(simPositions.values());
    validateUserAuthorizationInvariant({
      userId: targetUserId,
      roles,
      positions: resultingPositions,
    });

    // 6. DB更新の実行: Roles 更新 (Current State Replacement)
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(targetUserId);
    const insertRoleStmt = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
    for (const r of roles) {
      insertRoleStmt.run(targetUserId, r);
    }

    // 7. DB更新の実行: Positions 更新 (Temporal Operations)
    for (const op of appliedOperations) {
      if (op.operation === 'ASSIGN') {
        const { positionId, effectiveFrom, effectiveTo, isPrimaryInt, targetPosMaster } = op;
        // 同一ユーザー・同一Position期間重複
        const overlapUserPos = db.prepare(`
          SELECT id, effective_from, effective_to FROM user_positions
          WHERE user_id = ? AND position_id = ?
            AND effective_from <= ? AND effective_to >= ?
        `).get(targetUserId, positionId, effectiveTo, effectiveFrom) as any;
        if (overlapUserPos) {
          throw {
            statusCode: 400,
            errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
            message: `同一教職員に対して同じ役職の期間（${overlapUserPos.effective_from}〜${overlapUserPos.effective_to}）が重複しています`,
          };
        }

        // SINGLE_HOLDER 他ユーザー重複
        if (targetPosMaster.holder_type === 'SINGLE_HOLDER') {
          const overlapHolder = db.prepare(`
            SELECT up.id, up.user_id, up.effective_from, up.effective_to, u.display_name
            FROM user_positions up
            JOIN users u ON up.user_id = u.id
            WHERE up.position_id = ? AND up.user_id != ?
              AND up.effective_from <= ? AND up.effective_to >= ?
          `).get(positionId, targetUserId, effectiveTo, effectiveFrom) as any;
          if (overlapHolder) {
            throw {
              statusCode: 400,
              errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
              message: `役職「${targetPosMaster.name}」は単一担当役職(SINGLE_HOLDER)です。指定期間内に既に「${overlapHolder.display_name}」が配置されています`,
            };
          }
        }

        // Primary 重複
        if (isPrimaryInt === 1) {
          const overlapPrimary = db.prepare(`
            SELECT up.id, up.position_id, up.effective_from, up.effective_to, p.name as position_name
            FROM user_positions up
            JOIN positions p ON up.position_id = p.id
            WHERE up.user_id = ? AND up.is_primary = 1
              AND up.effective_from <= ? AND up.effective_to >= ?
          `).get(targetUserId, effectiveTo, effectiveFrom) as any;
          if (overlapPrimary) {
            throw {
              statusCode: 400,
              errorCode: 'PRIMARY_POSITION_CONFLICT',
              message: `指定期間内に既に別の主たる役職「${overlapPrimary.position_name}」が設定されています`,
            };
          }
        }

        db.prepare(`
          INSERT INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(targetUserId, positionId, isPrimaryInt, effectiveFrom, effectiveTo, now, now);
      } else if (op.operation === 'END') {
        db.prepare('UPDATE user_positions SET effective_to = ?, updated_at = ? WHERE id = ?').run(
          op.endDate,
          now,
          op.assignmentId
        );
      } else if (op.operation === 'CORRECT') {
        const { assignmentId, effectiveFrom, effectiveTo, isPrimaryInt } = op;
        const currentAssign = db.prepare('SELECT * FROM user_positions WHERE id = ?').get(assignmentId) as any;

        // 重複検証
        const overlapUserPos = db.prepare(`
          SELECT id, effective_from, effective_to FROM user_positions
          WHERE user_id = ? AND position_id = ? AND id != ?
            AND effective_from <= ? AND effective_to >= ?
        `).get(targetUserId, currentAssign.position_id, assignmentId, effectiveTo, effectiveFrom) as any;
        if (overlapUserPos) {
          throw {
            statusCode: 400,
            errorCode: 'POSITION_ASSIGNMENT_CONFLICT',
            message: `同一教職員に対して同じ役職の期間（${overlapUserPos.effective_from}〜${overlapUserPos.effective_to}）が重複しています`,
          };
        }

        db.prepare(`
          UPDATE user_positions
          SET effective_from = ?, effective_to = ?, is_primary = ?, updated_at = ?
          WHERE id = ?
        `).run(effectiveFrom, effectiveTo, isPrimaryInt, now, assignmentId);
      }
    }

    // 8. 監査ログ記録 (Unified Audit ChangeSet)
    const afterDbPositions = db.prepare(`
      SELECT id, position_id, effective_from, effective_to, is_primary
      FROM user_positions
      WHERE user_id = ?
      ORDER BY id ASC
    `).all(targetUserId) as any[];

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'UNIFIED_AUTHORIZATION_MUTATION',
      entityType: 'USER_AUTHORIZATION',
      entityId: targetUserId,
      beforeState: JSON.stringify({
        roles: currentRoles,
        positions: currentDbPositions,
      }),
      afterState: JSON.stringify({
        roles,
        positions: afterDbPositions,
      }),
      metadata: {
        roleDiff: {
          added: roles.filter((r: string) => !currentRoles.includes(r)),
          removed: currentRoles.filter((r: string) => !roles.includes(r)),
        },
        positionOperations,
        reason: reason || null,
      },
      comment: `役割・役職統合更新 [${targetUser.display_name}]: ロール(${currentRoles.join(',')} -> ${roles.join(',')}), 役職操作数(${positionOperations.length}件)${reason ? ` 理由: ${reason}` : ''}`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  try {
    runTx();
    res.json({
      success: true,
      message: `「${targetUser.display_name}」の役割・役職を統合更新しました`,
      roles,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({
      success: false,
      errorCode: err.errorCode || 'INTERNAL_ERROR',
      message: err.message || `統合更新エラー: ${err.message}`,
    });
  }
});

/**
 * 学校標準日課の一覧取得 (ADMIN, VICE_PRINCIPAL, PRINCIPAL)
 */
router.get('/school-work-schedules', (req: Request, res: Response): void => {
  const db = getDb();
  const schedules = db.prepare(`
    SELECT sws.*, cu.display_name as created_by_user_name, uu.display_name as updated_by_user_name
    FROM school_work_schedules sws
    LEFT JOIN users cu ON sws.created_by_user_id = cu.id
    LEFT JOIN users uu ON sws.updated_by_user_id = uu.id
    ORDER BY sws.effective_from DESC, sws.id DESC
  `).all();

  res.json({ success: true, schedules: schedules || [] });
});

/**
 * 学校標準日課の新規登録・改定 (ADMIN のみ、Append-Only Effective-Dated Versioning & Atomic Transaction)
 */
router.post('/school-work-schedules', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '学校標準日課の登録・改定はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const {
    scheduleName,
    effectiveFrom,
    weeklyOffDays = '0,6',
    scheduleDetails,
  } = req.body;

  if (!scheduleName || typeof scheduleName !== 'string' || !scheduleName.trim()) {
    res.status(400).json({ success: false, message: '日課名（scheduleName）を入力してください' });
    return;
  }

  if (!effectiveFrom || typeof effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    res.status(400).json({ success: false, message: '有効開始日（effectiveFrom: YYYY-MM-DD）を正しく入力してください' });
    return;
  }

  if (!scheduleDetails || typeof scheduleDetails !== 'object') {
    res.status(400).json({ success: false, message: '曜日別日課詳細（scheduleDetails）が必要です' });
    return;
  }

  const offDaysArr = Array.isArray(weeklyOffDays)
    ? weeklyOffDays.map(Number)
    : String(weeklyOffDays).split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n));

  const validatedDetails: Record<string, any> = {};
  let calculatedWeeklyTotal = 0;

  for (let d = 0; d < 7; d++) {
    const dayKey = String(d);
    const dayRaw = scheduleDetails[dayKey] || scheduleDetails[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d]];
    const isOff = offDaysArr.includes(d);

    if (isOff) {
      validatedDetails[dayKey] = {
        isWorkDay: false,
        workMinutes: 0,
        startTime: null,
        endTime: null,
        workIntervals: [],
        intervals: [],
      };
    } else {
      if (!dayRaw) {
        res.status(400).json({
          success: false,
          errorCode: 'INVALID_SCHEDULE_DETAILS',
          message: `勤務日（曜日=${d}）の日課詳細が未設定です`,
        });
        return;
      }

      let intervals: WorkTimeInterval[] = [];
      if (dayRaw.workIntervals && Array.isArray(dayRaw.workIntervals)) {
        intervals = dayRaw.workIntervals.map((inv: any) => ({ start: Number(inv.start), end: Number(inv.end) }));
      } else if (dayRaw.intervals && Array.isArray(dayRaw.intervals)) {
        intervals = dayRaw.intervals.map((inv: any) => ({
          start: timeToMinutes(inv.startTime),
          end: timeToMinutes(inv.endTime),
        }));
      }

      const valRes = validateWorkIntervals(intervals);
      if (!valRes.isValid) {
        res.status(400).json({
          success: false,
          errorCode: 'INVALID_SCHEDULE_INTERVALS',
          message: `曜日（${d}）の勤務区間が不正です: ${valRes.error}`,
        });
        return;
      }

      const dayMins = intervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
      calculatedWeeklyTotal += dayMins;

      validatedDetails[dayKey] = {
        isWorkDay: true,
        workMinutes: dayMins,
        startTime: intervals.length > 0 ? minutesToTime(intervals[0].start) : null,
        endTime: intervals.length > 0 ? minutesToTime(intervals[intervals.length - 1].end) : null,
        workIntervals: intervals,
        intervals: intervals.map((inv) => ({ startTime: minutesToTime(inv.start), endTime: minutesToTime(inv.end) })),
      };
    }
  }

  // FROZEN CONTRACT 1: 週総実働時間は厳格に 2,325分 (38時間45分) 一致
  if (calculatedWeeklyTotal !== 2325) {
    res.status(400).json({
      success: false,
      errorCode: 'INVALID_WEEKLY_TOTAL_MINUTES',
      message: `学校標準日課の週勤務時間は厳格に2,325分（38時間45分）でなければなりません (現在: ${calculatedWeeklyTotal}分, INV-DWS-WEEKLY-SUM)`,
      expected: 2325,
      actual: calculatedWeeklyTotal,
    });
    return;
  }

  const db = getDb();

  // FROZEN CONTRACT 3: Append-Only Effective-Dated Versioning
  // 最新の開区間レコード (effective_to = '9999-12-31') を取得
  const currentOpen = db.prepare(`
    SELECT * FROM school_work_schedules
    WHERE effective_to = '9999-12-31'
  `).get() as any;

  if (currentOpen) {
    // 新開始日が既存開始日以前（同日または過去）の場合は 409 Conflict
    if (effectiveFrom <= currentOpen.effective_from) {
      res.status(409).json({
        success: false,
        errorCode: 'SCHOOL_SCHEDULE_PERIOD_CONFLICT',
        message: `新開始日（${effectiveFrom}）は現在有効な日課の開始日（${currentOpen.effective_from}）より後でなければなりません（同日・過去への割込みは禁止されています）`,
      });
      return;
    }
  } else {
    // もし開区間がない場合でも、過去の閉区間が存在すれば、その最大終了日より前への割込みを拒絶
    const maxClosed = db.prepare(`
      SELECT MAX(effective_to) as max_to FROM school_work_schedules
    `).get() as any;
    if (maxClosed?.max_to && effectiveFrom <= maxClosed.max_to) {
      res.status(409).json({
        success: false,
        errorCode: 'SCHOOL_SCHEDULE_PERIOD_CONFLICT',
        message: `新開始日（${effectiveFrom}）は過去の確定済み日課の終了日（${maxClosed.max_to}）より後でなければなりません`,
      });
      return;
    }
  }

  const now = new Date().toISOString();
  const offDaysStr = offDaysArr.join(',');
  const detailsJson = JSON.stringify(validatedDetails);
  const prevDay = getPreviousDay(effectiveFrom);

  let createdScheduleId = 0;
  let previousScheduleId: number | undefined = undefined;

  // Single Transaction: Atomic Versioning
  const runTx = db.transaction(() => {
    if (currentOpen) {
      previousScheduleId = currentOpen.id;
      db.prepare(`
        UPDATE school_work_schedules
        SET effective_to = ?, updated_by_user_id = ?, updated_at = ?
        WHERE id = ?
      `).run(prevDay, user.id, now, currentOpen.id);
    }

    const insertRes = db.prepare(`
      INSERT INTO school_work_schedules (
        schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active,
        created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (?, ?, '9999-12-31', ?, ?, 2325, 1, ?, ?, ?, ?)
    `).run(
      scheduleName.trim(),
      effectiveFrom,
      offDaysStr,
      detailsJson,
      user.id,
      now,
      user.id,
      now
    );

    createdScheduleId = Number(insertRes.lastInsertRowid);

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'CREATE_SCHOOL_WORK_SCHEDULE',
      entityType: 'SCHOOL_WORK_SCHEDULE',
      entityId: createdScheduleId,
      afterState: `${scheduleName.trim()} (${effectiveFrom}~9999-12-31)`,
      comment: `学校標準日課登録/改定: ${scheduleName.trim()} (${effectiveFrom}~9999-12-31)`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
      metadata: {
        previousScheduleId,
        previousEffectiveTo: currentOpen ? prevDay : undefined,
      },
    });
  });

  try {
    runTx();
  } catch (err: any) {
    res.status(500).json({ success: false, message: `学校標準日課の登録に失敗しました: ${err.message}` });
    return;
  }

  res.json({
    success: true,
    createdScheduleId,
    previousScheduleId,
    effectiveFrom,
    effectiveTo: '9999-12-31',
  });
});

/**
 * 教職員の勤務パターン履歴一覧取得
 */
router.get('/users/:id/work-patterns', (req: Request, res: Response): void => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);

  const db = getDb();
  const patterns = db.prepare(`
    SELECT wp.*, cu.display_name as created_by_user_name
    FROM user_work_patterns wp
    LEFT JOIN users cu ON wp.created_by_user_id = cu.id
    WHERE wp.user_id = ?
    ORDER BY wp.effective_from DESC, wp.id DESC
  `).all(targetUserId);

  res.json({ success: true, patterns });
});

/**
 * 勤務パターンの新規登録 (ADMINのみ、期間重複検査あり)
 */
router.post('/users/:id/work-patterns', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '勤務パターンの登録はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawId, 10);
  const {
    patternName,
    patternType,
    effectiveFrom,
    effectiveTo,
    weeklyOffDays,
    memo,
    weeklyTotalMinutes,
    scheduleDetails,
    statutoryPatternCode,
    scheduleSource: rawScheduleSource,
  } = req.body;

  if (!patternName || !patternType || !effectiveFrom || !effectiveTo || weeklyOffDays === undefined) {
    res.status(400).json({ success: false, message: '必須項目が不足しています' });
    return;
  }

  if (effectiveFrom > effectiveTo) {
    res.status(400).json({ success: false, message: '適用終了日は適用開始日以降の日付を指定してください' });
    return;
  }

  // scheduleSource の明示入力必須化 (Explicit Source Contract: 省略・null・空文字は Fail-Closed)
  if (!rawScheduleSource) {
    res.status(400).json({
      success: false,
      errorCode: 'SCHEDULE_SOURCE_REQUIRED',
      message: '勤務パターンの登録には scheduleSource（"SCHOOL_DEFAULT" または "INDIVIDUAL"）の明示指定が必須です（暗黙補完は禁止されています）',
    });
    return;
  }

  // scheduleSource のバリデーション (Canonical 2-Value Domain: 'SCHOOL_DEFAULT' | 'INDIVIDUAL')
  if (rawScheduleSource !== 'SCHOOL_DEFAULT' && rawScheduleSource !== 'INDIVIDUAL') {
    res.status(400).json({
      success: false,
      errorCode: 'INVALID_SCHEDULE_SOURCE',
      message: `無効な scheduleSource です: ${rawScheduleSource}（'SCHOOL_DEFAULT' または 'INDIVIDUAL' を指定してください）`,
    });
    return;
  }
  const scheduleSource: ScheduleSource = rawScheduleSource;

  // statutoryPatternCode のバリデーション (NULL または CST_01〜04 のみ許可)
  const validStatutoryCodes: Array<StatutoryPatternCode> = ['CST_01', 'CST_02', 'CST_03', 'CST_04'];
  if (statutoryPatternCode !== undefined && statutoryPatternCode !== null && statutoryPatternCode !== '') {
    if (!validStatutoryCodes.includes(statutoryPatternCode)) {
      res.status(400).json({
        success: false,
        errorCode: 'INVALID_STATUTORY_PATTERN_CODE',
        message: `不正な法令承認パターンコードです: ${statutoryPatternCode} (許可値: CST_01, CST_02, CST_03, CST_04)`,
      });
      return;
    }
  }
  const validatedStatutoryCode = statutoryPatternCode || null;

  const db = getDb();

  let validatedScheduleDetailsJson: string | null = null;
  let calculatedWeeklyTotal = 0;

  if (scheduleSource === 'SCHOOL_DEFAULT') {
    // FROZEN CONTRACT 2: Point-in-Time Coverage Gate
    // 勤務パターンの開始日 (effectiveFrom) 時点で有効な学校標準日課が存在するか検証
    const activeSchoolSchedule = db.prepare(`
      SELECT id FROM school_work_schedules
      WHERE effective_from <= ? AND effective_to >= ? AND is_active = 1
      LIMIT 1
    `).get(effectiveFrom, effectiveFrom) as any;

    if (!activeSchoolSchedule) {
      res.status(400).json({
        success: false,
        errorCode: 'SCHOOL_DEFAULT_NOT_CONFIGURED',
        message: `勤務パターンの開始日（${effectiveFrom}）時点で有効な学校標準日課が登録されていません`,
      });
      return;
    }

    // 学校標準日課参照の場合は個別詳細JSONは null、週勤務時間は学校標準日課の 2,325分
    validatedScheduleDetailsJson = null;
    calculatedWeeklyTotal = 2325;
  } else {
    // scheduleSource === 'INDIVIDUAL' の場合
    // 固定 08:10 暗黙フォールバックの完全撤廃 (MUST CHANGE 5): scheduleDetails 必須化
    if (!scheduleDetails || typeof scheduleDetails !== 'object') {
      res.status(400).json({
        success: false,
        errorCode: 'SCHEDULE_DETAILS_REQUIRED',
        message: '個別勤務パターン（INDIVIDUAL）の登録には曜日別日課詳細（scheduleDetails）が必須です（暗黙補完は禁止されています）',
      });
      return;
    }

    const validatedDetails: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      const dayKey = String(d);
      const dayRaw = scheduleDetails[dayKey] || scheduleDetails[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d]];
      if (dayRaw) {
        if (dayRaw.isWorkDay) {
          let intervals: WorkTimeInterval[] = [];
          if (dayRaw.workIntervals && Array.isArray(dayRaw.workIntervals)) {
            intervals = dayRaw.workIntervals.map((inv: any) => ({ start: Number(inv.start), end: Number(inv.end) }));
          } else if (dayRaw.intervals && Array.isArray(dayRaw.intervals)) {
            intervals = dayRaw.intervals.map((inv: any) => ({
              start: timeToMinutes(inv.startTime),
              end: timeToMinutes(inv.endTime),
            }));
          }

          const valRes = validateWorkIntervals(intervals);
          if (!valRes.isValid) {
            res.status(400).json({
              success: false,
              errorCode: 'INVALID_SCHEDULE_INTERVALS',
              message: `曜日（${d}）の勤務区間が不正です: ${valRes.error}`,
            });
            return;
          }

          const dayMins = intervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
          calculatedWeeklyTotal += dayMins;

          validatedDetails[dayKey] = {
            isWorkDay: true,
            workMinutes: dayMins,
            startTime: intervals.length > 0 ? minutesToTime(intervals[0].start) : null,
            endTime: intervals.length > 0 ? minutesToTime(intervals[intervals.length - 1].end) : null,
            workIntervals: intervals,
            intervals: intervals.map((inv) => ({ startTime: minutesToTime(inv.start), endTime: minutesToTime(inv.end) })),
          };
        } else {
          validatedDetails[dayKey] = {
            isWorkDay: false,
            workMinutes: 0,
            startTime: null,
            endTime: null,
            workIntervals: [],
            intervals: [],
          };
        }
      }
    }
    validatedScheduleDetailsJson = JSON.stringify(validatedDetails);
  }

  // INV-DWS-WEEKLY-SUM: クライアント値との厳格比較 (不一致時は HTTP 400 で即座拒絶、サイレント補正禁止)
  if (weeklyTotalMinutes !== undefined && weeklyTotalMinutes !== null) {
    const supplied = Number(weeklyTotalMinutes);
    if (supplied !== calculatedWeeklyTotal) {
      res.status(400).json({
        success: false,
        errorCode: 'INVALID_WEEKLY_TOTAL_MINUTES',
        message: `送信された週勤務時間（${supplied}分）が、日課スケジュールから計算された週総実働時間（${calculatedWeeklyTotal}分）と一致しません (INV-DWS-WEEKLY-SUM 違反)`,
        expected: calculatedWeeklyTotal,
        supplied: supplied,
      });
      return;
    }
  }

  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象教職員が見つかりません' });
    return;
  }

  // 期間重複チェック (Overlap Validation)
  const overlap = db.prepare(`
    SELECT id, pattern_name, effective_from, effective_to
    FROM user_work_patterns
    WHERE user_id = ?
      AND NOT (effective_to < ? OR effective_from > ?)
  `).get(targetUserId, effectiveFrom, effectiveTo) as any;

  if (overlap) {
    res.status(409).json({
      success: false,
      errorCode: 'WORK_PATTERN_PERIOD_OVERLAP',
      message: `指定された適用期間（${effectiveFrom}〜${effectiveTo}）は、既存の勤務パターン「${overlap.pattern_name}（${overlap.effective_from}〜${overlap.effective_to}）」と重複しています`,
      overlappingPattern: {
        id: overlap.id,
        patternName: overlap.pattern_name,
        effectiveFrom: overlap.effective_from,
        effectiveTo: overlap.effective_to,
      },
    });
    return;
  }

  const now = new Date().toISOString();
  const offDaysStr = Array.isArray(weeklyOffDays) ? weeklyOffDays.join(',') : String(weeklyOffDays);
  const totalMins = calculatedWeeklyTotal;

  const insertStmt = db.prepare(`
    INSERT INTO user_work_patterns (
      user_id, pattern_name, pattern_type, effective_from, effective_to,
      weekly_off_days, schedule_details_json, weekly_total_minutes, statutory_pattern_code,
      memo, record_origin, created_by_user_id, created_at, updated_by_user_id, updated_at, schedule_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADMIN_CONFIGURED', ?, ?, ?, ?, ?)
  `);

  let patternId: number;
  const runTx = db.transaction(() => {
    const result = insertStmt.run(
      targetUserId,
      patternName.trim(),
      patternType,
      effectiveFrom,
      effectiveTo,
      offDaysStr,
      validatedScheduleDetailsJson,
      totalMins,
      validatedStatutoryCode,
      memo || null,
      user.id,
      now,
      user.id,
      now,
      scheduleSource
    );
    patternId = Number(result.lastInsertRowid);

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'CREATE_WORK_PATTERN',
      entityType: 'USER_WORK_PATTERN',
      entityId: patternId,
      afterState: `${patternName} (${effectiveFrom}~${effectiveTo}) [off:${offDaysStr}]`,
      comment: `勤務パターン登録 [${targetUser.display_name}]: ${patternName} (${effectiveFrom}~${effectiveTo})`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  runTx();

  res.status(201).json({ success: true, message: '勤務パターンを登録しました', patternId: patternId! });
});

/**
 * 勤務パターンの期間重複自動調整 (Server-Side Atomic Compound Endpoint)
 * 既存パターンの期間短縮 (UPDATE) と新規パターンの登録 (INSERT) を単一トランザクションで不可分に実行
 */
router.post('/users/:id/work-patterns/resolve-overlap', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '勤務パターンの登録・変更はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawUserId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = parseInt(rawUserId, 10);
  if (isNaN(targetUserId)) {
    res.status(400).json({ success: false, message: '無効なユーザーIDです' });
    return;
  }

  const db = getDb();
  const targetUser = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(targetUserId) as any;
  if (!targetUser) {
    res.status(404).json({ success: false, message: '対象のユーザーが見つかりません' });
    return;
  }

  const { targetPatternId, expectedCurrentEffectiveTo, newPattern } = req.body;
  if (!targetPatternId || !expectedCurrentEffectiveTo || !newPattern) {
    res.status(400).json({ success: false, message: '必須項目が不足しています (targetPatternId, expectedCurrentEffectiveTo, newPattern)' });
    return;
  }

  const {
    patternName,
    patternType,
    scheduleSource: rawScheduleSource,
    effectiveFrom,
    effectiveTo,
    weeklyOffDays,
    memo,
    weeklyTotalMinutes,
    scheduleDetails,
    statutoryPatternCode,
  } = newPattern;

  if (!patternName || !patternType || !effectiveFrom || !effectiveTo || weeklyOffDays === undefined) {
    res.status(400).json({ success: false, message: '新規パターンの必須項目が不足しています' });
    return;
  }

  // 形式および実在暦日バリデーション (Guardrail: 不正日付の自動正規化を防止)
  if (!isValidIsoDate(effectiveFrom) || !isValidIsoDate(effectiveTo)) {
    res.status(400).json({ success: false, message: '日付形式または実在しない日付です (YYYY-MM-DD)' });
    return;
  }

  if (effectiveFrom > effectiveTo) {
    res.status(400).json({ success: false, message: '適用終了日は適用開始日以降の日付を指定してください' });
    return;
  }

  if (!rawScheduleSource) {
    res.status(400).json({
      success: false,
      errorCode: 'SCHEDULE_SOURCE_REQUIRED',
      message: '勤務パターンの登録には scheduleSource（"SCHOOL_DEFAULT" または "INDIVIDUAL"）の明示指定が必須です（暗黙補完は禁止されています）',
    });
    return;
  }

  if (rawScheduleSource !== 'SCHOOL_DEFAULT' && rawScheduleSource !== 'INDIVIDUAL') {
    res.status(400).json({
      success: false,
      errorCode: 'INVALID_SCHEDULE_SOURCE',
      message: `無効な scheduleSource です: ${rawScheduleSource}（'SCHOOL_DEFAULT' または 'INDIVIDUAL' を指定してください）`,
    });
    return;
  }
  const scheduleSource: ScheduleSource = rawScheduleSource;

  const validStatutoryCodes: Array<StatutoryPatternCode> = ['CST_01', 'CST_02', 'CST_03', 'CST_04'];
  if (statutoryPatternCode !== undefined && statutoryPatternCode !== null && statutoryPatternCode !== '') {
    if (!validStatutoryCodes.includes(statutoryPatternCode)) {
      res.status(400).json({
        success: false,
        errorCode: 'INVALID_STATUTORY_PATTERN_CODE',
        message: `不正な法令承認パターンコードです: ${statutoryPatternCode} (許可値: CST_01, CST_02, CST_03, CST_04)`,
      });
      return;
    }
  }
  const validatedStatutoryCode = statutoryPatternCode || null;

  let validatedScheduleDetailsJson: string | null = null;
  let calculatedWeeklyTotal = 0;

  if (scheduleSource === 'SCHOOL_DEFAULT') {
    const activeSchoolSchedule = db.prepare(`
      SELECT id FROM school_work_schedules
      WHERE effective_from <= ? AND effective_to >= ? AND is_active = 1
      LIMIT 1
    `).get(effectiveFrom, effectiveFrom) as any;

    if (!activeSchoolSchedule) {
      res.status(400).json({
        success: false,
        errorCode: 'SCHOOL_DEFAULT_NOT_CONFIGURED',
        message: `勤務パターンの開始日（${effectiveFrom}）時点で有効な学校標準日課が登録されていません`,
      });
      return;
    }

    validatedScheduleDetailsJson = null;
    calculatedWeeklyTotal = 2325;
  } else {
    if (!scheduleDetails || typeof scheduleDetails !== 'object') {
      res.status(400).json({
        success: false,
        errorCode: 'SCHEDULE_DETAILS_REQUIRED',
        message: '個別勤務パターン（INDIVIDUAL）の登録には曜日別日課詳細（scheduleDetails）が必須です',
      });
      return;
    }

    const validatedDetails: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      const dayKey = String(d);
      const dayRaw = scheduleDetails[dayKey] || scheduleDetails[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d]];
      if (dayRaw) {
        if (dayRaw.isWorkDay) {
          let intervals: WorkTimeInterval[] = [];
          if (dayRaw.workIntervals && Array.isArray(dayRaw.workIntervals)) {
            intervals = dayRaw.workIntervals.map((inv: any) => ({ start: Number(inv.start), end: Number(inv.end) }));
          } else if (dayRaw.intervals && Array.isArray(dayRaw.intervals)) {
            intervals = dayRaw.intervals.map((inv: any) => ({
              start: timeToMinutes(inv.startTime),
              end: timeToMinutes(inv.endTime),
            }));
          }

          const valRes = validateWorkIntervals(intervals);
          if (!valRes.isValid) {
            res.status(400).json({
              success: false,
              errorCode: 'INVALID_SCHEDULE_INTERVALS',
              message: `曜日（${d}）の勤務区間が不正です: ${valRes.error}`,
            });
            return;
          }

          const dayMins = intervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
          calculatedWeeklyTotal += dayMins;

          validatedDetails[dayKey] = {
            isWorkDay: true,
            workMinutes: dayMins,
            startTime: intervals.length > 0 ? minutesToTime(intervals[0].start) : null,
            endTime: intervals.length > 0 ? minutesToTime(intervals[intervals.length - 1].end) : null,
            workIntervals: intervals,
            intervals: intervals.map((inv) => ({ startTime: minutesToTime(inv.start), endTime: minutesToTime(inv.end) })),
          };
        } else {
          validatedDetails[dayKey] = {
            isWorkDay: false,
            workMinutes: 0,
            startTime: null,
            endTime: null,
            workIntervals: [],
            intervals: [],
          };
        }
      }
    }
    validatedScheduleDetailsJson = JSON.stringify(validatedDetails);
  }

  if (weeklyTotalMinutes !== undefined && weeklyTotalMinutes !== null) {
    const supplied = Number(weeklyTotalMinutes);
    if (supplied !== calculatedWeeklyTotal) {
      res.status(400).json({
        success: false,
        errorCode: 'INVALID_WEEKLY_TOTAL_MINUTES',
        message: `送信された週勤務時間（${supplied}分）が、日課スケジュールから計算された週総実働時間（${calculatedWeeklyTotal}分）と一致しません (INV-DWS-WEEKLY-SUM 違反)`,
        expected: calculatedWeeklyTotal,
        supplied: supplied,
      });
      return;
    }
  }

  // タイムゾーン非依存で短縮後終了日を計算
  const shortenedEffectiveTo = getPreviousLocalDate(effectiveFrom);

  const now = new Date().toISOString();
  const offDaysStr = Array.isArray(weeklyOffDays) ? weeklyOffDays.join(',') : String(weeklyOffDays);
  const totalMins = calculatedWeeklyTotal;

  try {
    let newPatternId: number;
    let targetRow: any;

    const runTx = db.transaction(() => {
      // 1. 対象既存パターンの再照会 & 所有権検証 (IDOR防御)
      targetRow = db.prepare('SELECT * FROM user_work_patterns WHERE id = ? AND user_id = ?').get(targetPatternId, targetUserId) as any;
      if (!targetRow) {
        const notFoundErr = new Error('短縮対象の勤務パターンが見つかりません');
        (notFoundErr as any).status = 404;
        throw notFoundErr;
      }

      // 2. 楽観的排他検証 (Stale-State Conflict 検証)
      if (targetRow.effective_to !== expectedCurrentEffectiveTo) {
        const staleErr = new Error('対象の勤務パターンは既に別の操作によって変更されています。最新の情報を再読み込みしてください');
        (staleErr as any).status = 409;
        (staleErr as any).errorCode = 'STALE_STATE_CONFLICT';
        throw staleErr;
      }

      // 3. 短縮日付の妥当性検証
      if (shortenedEffectiveTo < targetRow.effective_from) {
        const dateErr = new Error(`短縮後の終了日（${shortenedEffectiveTo}）が既存パターンの開始日（${targetRow.effective_from}）より前になるため短縮できません`);
        (dateErr as any).status = 400;
        throw dateErr;
      }

      if (targetRow.effective_to < effectiveFrom) {
        const noOverlapErr = new Error('対象パターンは新パターンと重複していません');
        (noOverlapErr as any).status = 409;
        throw noOverlapErr;
      }

      // 4. 第3パターンとの重複チェック
      // 4-1. 短縮後既存パターンと他パターンの重複 (自身を除外)
      const overlapShortened = db.prepare(`
        SELECT id, pattern_name, effective_from, effective_to
        FROM user_work_patterns
        WHERE user_id = ? AND id != ?
          AND NOT (effective_to < ? OR effective_from > ?)
      `).get(targetUserId, targetPatternId, targetRow.effective_from, shortenedEffectiveTo) as any;

      if (overlapShortened) {
        const conflictErr = new Error(`短縮後の期間（${targetRow.effective_from}〜${shortenedEffectiveTo}）が既存パターン「${overlapShortened.pattern_name}」と重複しています`);
        (conflictErr as any).status = 409;
        (conflictErr as any).errorCode = 'WORK_PATTERN_PERIOD_OVERLAP';
        throw conflictErr;
      }

      // 4-2. 新規パターンと他パターンの重複 (短縮対象を除外)
      const overlapNew = db.prepare(`
        SELECT id, pattern_name, effective_from, effective_to
        FROM user_work_patterns
        WHERE user_id = ? AND id != ?
          AND NOT (effective_to < ? OR effective_from > ?)
      `).get(targetUserId, targetPatternId, effectiveFrom, effectiveTo) as any;

      if (overlapNew) {
        const conflictErr = new Error(`新規パターンの期間（${effectiveFrom}〜${effectiveTo}）が既存パターン「${overlapNew.pattern_name}（${overlapNew.effective_from}〜${overlapNew.effective_to}）」と重複しています`);
        (conflictErr as any).status = 409;
        (conflictErr as any).errorCode = 'WORK_PATTERN_PERIOD_OVERLAP';
        throw conflictErr;
      }

      // 5. UPDATE: 既存パターンの期間短縮
      db.prepare(`
        UPDATE user_work_patterns
        SET effective_to = ?, updated_by_user_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(shortenedEffectiveTo, user.id, now, targetPatternId, targetUserId);

      // 6. INSERT: 新規パターンの登録
      const insertResult = db.prepare(`
        INSERT INTO user_work_patterns (
          user_id, pattern_name, pattern_type, effective_from, effective_to,
          weekly_off_days, schedule_details_json, weekly_total_minutes, statutory_pattern_code,
          memo, record_origin, created_by_user_id, created_at, updated_by_user_id, updated_at, schedule_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADMIN_CONFIGURED', ?, ?, ?, ?, ?)
      `).run(
        targetUserId,
        patternName.trim(),
        patternType,
        effectiveFrom,
        effectiveTo,
        offDaysStr,
        validatedScheduleDetailsJson,
        totalMins,
        validatedStatutoryCode,
        memo || null,
        user.id,
        now,
        user.id,
        now,
        scheduleSource
      );

      newPatternId = Number(insertResult.lastInsertRowid);

      // 7. AUDIT: 同一 request_id (correlationId) による同期相関ログ記録
      const correlationId = crypto.randomUUID();

      logAuditStrict({
        actorUserId: user.id,
        actorUsername: user.username,
        subjectUserId: targetUserId,
        action: 'UPDATE_WORK_PATTERN',
        entityType: 'USER_WORK_PATTERN',
        entityId: targetPatternId,
        requestId: correlationId,
        beforeState: `${targetRow.pattern_name} (${targetRow.effective_from}~${targetRow.effective_to})`,
        afterState: `${targetRow.pattern_name} (${targetRow.effective_from}~${shortenedEffectiveTo})`,
        comment: `期間重複自動調整による既存期間短縮 [ユーザーID:${targetUserId}]: ${targetRow.pattern_name} (${targetRow.effective_from}~${shortenedEffectiveTo})`,
        ipAddress: user.ipAddress,
        userAgent: user.userAgent,
      });

      logAuditStrict({
        actorUserId: user.id,
        actorUsername: user.username,
        subjectUserId: targetUserId,
        action: 'CREATE_WORK_PATTERN',
        entityType: 'USER_WORK_PATTERN',
        entityId: newPatternId,
        requestId: correlationId,
        afterState: `${patternName} (${effectiveFrom}~${effectiveTo}) [off:${offDaysStr}]`,
        comment: `期間重複自動調整による新規登録 [${targetUser.display_name}]: ${patternName} (${effectiveFrom}~${effectiveTo})`,
        ipAddress: user.ipAddress,
        userAgent: user.userAgent,
      });
    });

    runTx();

    res.json({
      success: true,
      message: '勤務パターンの期間短縮および新規登録をアトミックに完了しました',
      shortenedPattern: {
        id: targetPatternId,
        effectiveFrom: targetRow.effective_from,
        effectiveTo: shortenedEffectiveTo,
      },
      createdPattern: {
        id: newPatternId!,
        effectiveFrom,
        effectiveTo,
      },
    });
  } catch (err: any) {
    const status = err.status || 500;
    res.status(status).json({
      success: false,
      errorCode: err.errorCode,
      message: err.message || '期間自動調整処理に失敗しました',
    });
  }
});

/**
 * 勤務パターンの更新・期間修正 (ADMINのみ、期間重複検査あり)
 */
router.put('/users/:id/work-patterns/:patternId', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '勤務パターンの変更はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawUserId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawPatternId = Array.isArray(req.params.patternId) ? req.params.patternId[0] : req.params.patternId;
  const targetUserId = parseInt(rawUserId, 10);
  const patternId = parseInt(rawPatternId, 10);
  const {
    patternName,
    patternType,
    effectiveFrom,
    effectiveTo,
    weeklyOffDays,
    memo,
    weeklyTotalMinutes,
    scheduleDetails,
    statutoryPatternCode,
  } = req.body;

  if (!patternName || !patternType || !effectiveFrom || !effectiveTo || weeklyOffDays === undefined) {
    res.status(400).json({ success: false, message: '必須項目が不足しています' });
    return;
  }

  if (effectiveFrom > effectiveTo) {
    res.status(400).json({ success: false, message: '適用終了日は適用開始日以降の日付を指定してください' });
    return;
  }

  // statutoryPatternCode のバリデーション (NULL または CST_01〜04 のみ許可)
  const validStatutoryCodes: Array<StatutoryPatternCode> = ['CST_01', 'CST_02', 'CST_03', 'CST_04'];
  if (statutoryPatternCode !== undefined && statutoryPatternCode !== null && statutoryPatternCode !== '') {
    if (!validStatutoryCodes.includes(statutoryPatternCode)) {
      res.status(400).json({
        success: false,
        errorCode: 'INVALID_STATUTORY_PATTERN_CODE',
        message: `不正な法令承認パターンコードです: ${statutoryPatternCode} (許可値: CST_01, CST_02, CST_03, CST_04)`,
      });
      return;
    }
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM user_work_patterns WHERE id = ? AND user_id = ?').get(patternId, targetUserId) as any;
  if (!existing) {
    res.status(404).json({ success: false, message: '対象の勤務パターンが見つかりません' });
    return;
  }

  const validatedStatutoryCode = statutoryPatternCode !== undefined ? (statutoryPatternCode || null) : existing.statutory_pattern_code;

  // scheduleSource のバリデーション
  const rawScheduleSource = req.body.scheduleSource;
  if (rawScheduleSource !== undefined && rawScheduleSource !== 'SCHOOL_DEFAULT' && rawScheduleSource !== 'INDIVIDUAL') {
    res.status(400).json({
      success: false,
      errorCode: 'INVALID_SCHEDULE_SOURCE',
      message: `無効な scheduleSource です: ${rawScheduleSource}（'SCHOOL_DEFAULT' または 'INDIVIDUAL' を指定してください）`,
    });
    return;
  }
  const effectiveScheduleSource: ScheduleSource = rawScheduleSource || existing.schedule_source || 'INDIVIDUAL';

  // 他のパターンとの期間重複チェック (自身を除外)
  const overlap = db.prepare(`
    SELECT id, pattern_name, effective_from, effective_to
    FROM user_work_patterns
    WHERE user_id = ? AND id != ?
      AND NOT (effective_to < ? OR effective_from > ?)
  `).get(targetUserId, patternId, effectiveFrom, effectiveTo) as any;

  if (overlap) {
    res.status(409).json({
      success: false,
      errorCode: 'WORK_PATTERN_PERIOD_OVERLAP',
      message: `変更後の期間（${effectiveFrom}〜${effectiveTo}）は、既存の勤務パターン「${overlap.pattern_name}（${overlap.effective_from}〜${overlap.effective_to}）」と重複しています`,
    });
    return;
  }

  // scheduleDetails のバリデーションおよび weekly_total_minutes のサーバー導出
  let validatedScheduleDetailsJson: string | null = null;
  let calculatedWeeklyTotal = 0;

  if (effectiveScheduleSource === 'SCHOOL_DEFAULT') {
    // FROZEN CONTRACT 2: Point-in-Time Coverage Gate
    const activeSchoolSchedule = db.prepare(`
      SELECT id FROM school_work_schedules
      WHERE effective_from <= ? AND effective_to >= ? AND is_active = 1
      LIMIT 1
    `).get(effectiveFrom, effectiveFrom) as any;

    if (!activeSchoolSchedule) {
      res.status(400).json({
        success: false,
        errorCode: 'SCHOOL_DEFAULT_NOT_CONFIGURED',
        message: `勤務パターンの開始日（${effectiveFrom}）時点で有効な学校標準日課が登録されていません`,
      });
      return;
    }

    validatedScheduleDetailsJson = null;
    calculatedWeeklyTotal = 2325;
  } else {
    // effectiveScheduleSource === 'INDIVIDUAL'
    if (scheduleDetails && typeof scheduleDetails === 'object') {
      const validatedDetails: Record<string, any> = {};
      for (let d = 0; d < 7; d++) {
        const dayKey = String(d);
        const dayRaw = scheduleDetails[dayKey] || scheduleDetails[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d]];
        if (dayRaw) {
          if (dayRaw.isWorkDay) {
            let intervals: WorkTimeInterval[] = [];
            if (dayRaw.workIntervals && Array.isArray(dayRaw.workIntervals)) {
              intervals = dayRaw.workIntervals.map((inv: any) => ({ start: Number(inv.start), end: Number(inv.end) }));
            } else if (dayRaw.intervals && Array.isArray(dayRaw.intervals)) {
              intervals = dayRaw.intervals.map((inv: any) => ({
                start: timeToMinutes(inv.startTime),
                end: timeToMinutes(inv.endTime),
              }));
            }

            const valRes = validateWorkIntervals(intervals);
            if (!valRes.isValid) {
              res.status(400).json({
                success: false,
                errorCode: 'INVALID_SCHEDULE_INTERVALS',
                message: `曜日（${d}）の勤務区間が不正です: ${valRes.error}`,
              });
              return;
            }

            const dayMins = intervals.reduce((sum, inv) => sum + (inv.end - inv.start), 0);
            calculatedWeeklyTotal += dayMins;

            validatedDetails[dayKey] = {
              isWorkDay: true,
              workMinutes: dayMins,
              startTime: intervals.length > 0 ? minutesToTime(intervals[0].start) : null,
              endTime: intervals.length > 0 ? minutesToTime(intervals[intervals.length - 1].end) : null,
              workIntervals: intervals,
              intervals: intervals.map((inv) => ({ startTime: minutesToTime(inv.start), endTime: minutesToTime(inv.end) })),
            };
          } else {
            validatedDetails[dayKey] = {
              isWorkDay: false,
              workMinutes: 0,
              startTime: null,
              endTime: null,
              workIntervals: [],
              intervals: [],
            };
          }
        }
      }
      validatedScheduleDetailsJson = JSON.stringify(validatedDetails);
    } else if (existing.schedule_details_json && existing.schedule_source === 'INDIVIDUAL') {
      validatedScheduleDetailsJson = existing.schedule_details_json;
      try {
        const parsed = JSON.parse(existing.schedule_details_json);
        for (let d = 0; d < 7; d++) {
          const dayRaw = parsed[String(d)] || parsed[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d]];
          if (dayRaw && dayRaw.isWorkDay) {
            calculatedWeeklyTotal += (dayRaw.workMinutes || 0);
          }
        }
      } catch {
        calculatedWeeklyTotal = existing.weekly_total_minutes;
      }
    } else {
      res.status(400).json({
        success: false,
        errorCode: 'SCHEDULE_DETAILS_REQUIRED',
        message: '個別勤務パターン（INDIVIDUAL）への変更または設定には曜日別日課詳細（scheduleDetails）が必須です',
      });
      return;
    }
  }

  // INV-DWS-WEEKLY-SUM: クライアント値との厳格比較
  if (weeklyTotalMinutes !== undefined && weeklyTotalMinutes !== null) {
    const supplied = Number(weeklyTotalMinutes);
    if (supplied !== calculatedWeeklyTotal) {
      res.status(400).json({
        success: false,
        errorCode: 'INVALID_WEEKLY_TOTAL_MINUTES',
        message: `送信された週勤務時間（${supplied}分）が、日課スケジュールから計算された週総実働時間（${calculatedWeeklyTotal}分）と一致しません (INV-DWS-WEEKLY-SUM 違反)`,
        expected: calculatedWeeklyTotal,
        supplied: supplied,
      });
      return;
    }
  }

  const now = new Date().toISOString();
  const offDaysStr = Array.isArray(weeklyOffDays) ? weeklyOffDays.join(',') : String(weeklyOffDays);
  const totalMins = calculatedWeeklyTotal;

  const updateStmt = db.prepare(`
    UPDATE user_work_patterns
    SET pattern_name = ?, pattern_type = ?, effective_from = ?, effective_to = ?,
        weekly_off_days = ?, schedule_details_json = ?, weekly_total_minutes = ?,
        statutory_pattern_code = ?, memo = ?, schedule_source = ?,
        updated_by_user_id = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `);

  const runTx = db.transaction(() => {
    updateStmt.run(
      patternName.trim(),
      patternType,
      effectiveFrom,
      effectiveTo,
      offDaysStr,
      validatedScheduleDetailsJson,
      totalMins,
      validatedStatutoryCode,
      memo || null,
      effectiveScheduleSource,
      user.id,
      now,
      patternId,
      targetUserId
    );

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'UPDATE_WORK_PATTERN',
      entityType: 'USER_WORK_PATTERN',
      entityId: patternId,
      beforeState: `${existing.pattern_name} (${existing.effective_from}~${existing.effective_to}) [off:${existing.weekly_off_days}]`,
      afterState: `${patternName} (${effectiveFrom}~${effectiveTo}) [off:${offDaysStr}]`,
      comment: `勤務パターン更新 [ユーザーID:${targetUserId}]: ${patternName} (${effectiveFrom}~${effectiveTo})`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  runTx();

  res.json({ success: true, message: '勤務パターンを更新しました' });
});

/**
 * 勤務パターンの削除 (確定出勤簿参照保護付き)
 */
router.delete('/users/:id/work-patterns/:patternId', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '勤務パターンの削除はシステム管理者(ADMIN)のみ可能です' });
    return;
  }

  const rawUserId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawPatternId = Array.isArray(req.params.patternId) ? req.params.patternId[0] : req.params.patternId;
  const targetUserId = parseInt(rawUserId, 10);
  const patternId = parseInt(rawPatternId, 10);

  const db = getDb();
  const pattern = db.prepare('SELECT * FROM user_work_patterns WHERE id = ? AND user_id = ?').get(patternId, targetUserId) as any;
  if (!pattern) {
    res.status(404).json({ success: false, message: '対象の勤務パターンが見つかりません' });
    return;
  }

  // 確定出勤簿（monthly_attendance_approvals）との参照チェック
  const confirmedAttendance = db.prepare(`
    SELECT year_month FROM monthly_attendance_approvals
    WHERE user_id = ? AND status = 'CONFIRMED'
      AND year_month >= substr(?, 1, 7) AND year_month <= substr(?, 1, 7)
  `).all(targetUserId, pattern.effective_from, pattern.effective_to) as any[];

  if (confirmedAttendance.length > 0) {
    res.status(409).json({
      success: false,
      errorCode: 'PATTERN_REFERENCED_BY_CONFIRMED_ATTENDANCE',
      message: `この勤務パターンは校長月次確定済み出勤簿（${confirmedAttendance.map((a) => a.year_month).join(', ')}）の計算根拠として使用されているため削除できません。履歴保全のため適用終了日を調整してください。`,
    });
    return;
  }

  db.prepare('DELETE FROM user_work_patterns WHERE id = ?').run(patternId);

  logAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    subjectUserId: targetUserId,
    action: 'DELETE_WORK_PATTERN',
    entityType: 'USER_WORK_PATTERN',
    entityId: patternId,
    beforeState: `${pattern.pattern_name} (${pattern.effective_from}~${pattern.effective_to})`,
    comment: `勤務パターン削除 [ユーザーID:${targetUserId}]: ${pattern.pattern_name}`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
  });

  res.json({ success: true, message: '勤務パターンを削除しました' });
});

import { BackupManager } from '../utils/backupManager';

/**
 * 手動バックアップ作成 (VACUUM INTO + メタデータ + チェックサム)
 */
router.post('/backup', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  try {
    const result = BackupManager.createBackup(user);
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: `バックアップ作成失敗: ${err.message}` });
  }
});

/**
 * バックアップからのシステム復元 (Disaster Recovery)
 */
router.post('/restore', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { backupPath } = req.body;

  if (!backupPath) {
    res.status(400).json({ success: false, message: '復元対象のバックアップディレクトリパスを指定してください' });
    return;
  }

  try {
    const result = BackupManager.restoreBackup(backupPath, user);
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: `復元失敗: ${err.message}` });
  }
});

/**
 * システムステータス取得
 */
router.get('/system-status', (req: Request, res: Response): void => {
  const integrity = checkIntegrity();
  
  // LAN IPアドレスの取得
  const interfaces = os.networkInterfaces();
  const lanIps: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        lanIps.push(net.address);
      }
    }
  }

  res.json({
    success: true,
    status: {
      dbPath: config.DB_PATH,
      backupDir: config.BACKUP_DIR,
      integrity: integrity.ok ? '健全 (OK)' : `異常 (${integrity.message})`,
      lanIps,
      port: config.PORT,
      pocMode: config.POC_MODE,
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSeconds: Math.floor(process.uptime()),
    },
  });
});

/**
 * システム基本設定の取得 (ADMIN専用)
 */
router.get('/settings', (req: Request, res: Response): void => {
  const user = getUserContext(req);
  if (!user || !user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: 'システム管理者権限 (ADMIN) が必要です' });
    return;
  }

  const db = getDb();
  const settings = db.prepare(`
    SELECT s.*, u.display_name as updated_by_user_name
    FROM system_settings s
    LEFT JOIN users u ON s.updated_by_user_id = u.id
    WHERE s.id = 1
  `).get() as any;

  if (!settings) {
    res.status(404).json({ success: false, message: 'システム設定レコードが存在しません' });
    return;
  }

  res.json({
    success: true,
    settings: {
      id: settings.id,
      schoolName: settings.school_name,
      municipalityName: settings.municipality_name,
      boardOfEducationName: settings.board_of_education_name,
      appTitle: settings.app_title,
      leaveRegulationName: settings.leave_regulation_name,
      travelRegulationName: settings.travel_regulation_name,
      attendanceRegulationName: settings.attendance_regulation_name,
      version: settings.version,
      updatedAt: settings.updated_at,
      updatedByUserName: settings.updated_by_user_name || null,
    },
  });
});

/**
 * システム基本設定の更新 (ADMIN専用, 楽観的ロック & トランザクション内監査ログ)
 */
router.put('/settings', (req: Request, res: Response): void => {
  const user = getUserContext(req);
  if (!user || !user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: 'システム管理者権限 (ADMIN) が必要です' });
    return;
  }

  const {
    schoolName,
    municipalityName,
    boardOfEducationName,
    appTitle,
    expectedVersion,
  } = req.body;

  // 1. サーバーサイドバリデーション (Current Organization Settings のみを対象)
  const validateField = (val: any, fieldName: string, maxLen: number): string => {
    if (typeof val !== 'string') {
      throw new Error(`${fieldName} は文字列で入力してください`);
    }
    const trimmed = val.trim();
    if (trimmed.length === 0) {
      throw new Error(`${fieldName} を空にすることはできません`);
    }
    if (trimmed.length > maxLen) {
      throw new Error(`${fieldName} は${maxLen}文字以内で入力してください`);
    }
    if (/[\r\n]/.test(trimmed)) {
      throw new Error(`${fieldName} に改行コードを含めることはできません`);
    }
    if (/<[a-z][\s\S]*>/i.test(trimmed)) {
      throw new Error(`${fieldName} にHTMLタグを含めることはできません`);
    }
    return trimmed;
  };

  let cleanSchoolName = '';
  let cleanMunicipalityName = '';
  let cleanBoardOfEducationName = '';
  let cleanAppTitle = '';

  try {
    cleanSchoolName = validateField(schoolName, '学校名', 100);
    cleanMunicipalityName = validateField(municipalityName, '自治体名', 100);
    cleanBoardOfEducationName = validateField(boardOfEducationName, '教育委員会名', 100);
    cleanAppTitle = validateField(appTitle, 'システム表示名', 100);

    if (typeof expectedVersion !== 'number' || expectedVersion < 1) {
      throw new Error('有効な expectedVersion を指定してください');
    }
  } catch (validationErr: any) {
    res.status(400).json({ success: false, message: validationErr.message });
    return;
  }

  const db = getDb();
  const now = new Date().toISOString();

  // 2. トランザクション処理 (楽観的ロック & 監査ログ書き込み)
  try {
    const runTx = db.transaction(() => {
      const current = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as any;
      if (!current) {
        throw { statusCode: 404, message: 'システム設定レコードが存在しません' };
      }

      // 楽観的ロック検証 (version照合)
      if (current.version !== expectedVersion) {
        throw {
          statusCode: 409,
          message: `設定が他の操作によって更新されています (現在のバージョン: ${current.version}, 指定されたバージョン: ${expectedVersion})。画面を更新してください。`,
        };
      }

      const beforeState = {
        schoolName: current.school_name,
        municipalityName: current.municipality_name,
        boardOfEducationName: current.board_of_education_name,
        appTitle: current.app_title,
        version: current.version,
      };

      const newVersion = current.version + 1;

      // 設定レコード更新 (規程名称のWriteは完全停止し、DB既存値を保持)
      db.prepare(`
        UPDATE system_settings
        SET
          school_name = ?,
          municipality_name = ?,
          board_of_education_name = ?,
          app_title = ?,
          version = ?,
          updated_at = ?,
          updated_by_user_id = ?
        WHERE id = 1 AND version = ?
      `).run(
        cleanSchoolName,
        cleanMunicipalityName,
        cleanBoardOfEducationName,
        cleanAppTitle,
        newVersion,
        now,
        user.id,
        expectedVersion
      );

      const afterState = {
        schoolName: cleanSchoolName,
        municipalityName: cleanMunicipalityName,
        boardOfEducationName: cleanBoardOfEducationName,
        appTitle: cleanAppTitle,
        version: newVersion,
      };

      // 監査ログのトランザクション内記録 (原子性担保)
      logAudit({
        actorUserId: user.id,
        actorUsername: user.username,
        roleSnapshot: user.roles.join(','),
        action: 'UPDATE_SYSTEM_SETTINGS',
        entityType: 'SYSTEM_SETTINGS',
        entityId: '1',
        entityVersion: newVersion,
        beforeState: JSON.stringify(beforeState),
        afterState: JSON.stringify(afterState),
        comment: `学校基本設定の更新 (学校名: ${cleanSchoolName}, 自治体: ${cleanMunicipalityName})`,
        ipAddress: user.ipAddress,
        userAgent: user.userAgent,
        metadata: {
          previousVersion: expectedVersion,
          newVersion,
        },
      });

      return {
        id: 1,
        ...afterState,
        updatedAt: now,
        updatedByUserName: user.displayName,
      };
    });

    const updatedSettings = runTx();
    res.json({
      success: true,
      message: '学校基本設定を更新しました',
      settings: updatedSettings,
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

import { AnnualLeaveService } from '../services/annualLeaveService';

/**
 * 12月31日残数 ＆ 翌年1月1日繰越・付与プレビュー一覧取得 (ADMIN / 管理職)
 */
router.get('/annual-leave/rollover-preview', (req: Request, res: Response): void => {
  const year = parseInt(req.query.year as string, 10) || new Date().getFullYear();
  try {
    const previews = AnnualLeaveService.getAnnualRolloverPreview(year);
    res.json({ success: true, year, previews });
  } catch (err: any) {
    res.status(500).json({ success: false, message: `プレビュー取得エラー: ${err.message}` });
  }
});

/**
 * 1月1日 年次繰越 ＆ 定期付与の一括確定実行 (ADMIN専用)
 */
router.post('/annual-leave/rollover', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  if (!user.roles.includes('ADMIN')) {
    res.status(403).json({ success: false, message: '年次繰越一括実行はシステム管理者 (ADMIN) のみ可能です' });
    return;
  }

  const { targetYear } = req.body;
  const year = parseInt(targetYear, 10);
  if (!year || isNaN(year)) {
    res.status(400).json({ success: false, message: '有効な対象年（targetYear）を指定してください' });
    return;
  }

  try {
    const result = AnnualLeaveService.processAnnualRollover(year, user.id);

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'ANNUAL_LEAVE_ROLLOVER',
      entityType: 'ANNUAL_LEAVE',
      entityId: `${year}`,
      comment: `${year}年1月1日付 年次有給休暇繰越・定期付与一括実行 (対象: ${result.processedCount}名)`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    res.json({
      success: true,
      message: `${year}年1月1日付の年次繰越および定期付与（${result.processedCount}名分）を実行しました`,
      data: result,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: `年次繰越実行エラー: ${err.message}` });
  }
});

/**
 * 承認ポリシー一覧取得 (バージョン・ステップ・紐付け申請種別を含む)
 */
router.get('/workflow-policies', (req: Request, res: Response): void => {
  const db = getDb();
  try {
    const policies = db.prepare(`
      SELECT p.*,
             GROUP_CONCAT(DISTINCT pat.app_type_id) as app_type_ids
      FROM workflow_policies p
      LEFT JOIN workflow_policy_application_types pat ON p.id = pat.policy_id
      GROUP BY p.id
      ORDER BY p.id ASC
    `).all() as any[];

    const versions = db.prepare(`
      SELECT * FROM workflow_policy_versions
      ORDER BY policy_id ASC, version DESC
    `).all() as any[];

    const steps = db.prepare(`
      SELECT * FROM workflow_policy_steps
      ORDER BY policy_version_id ASC, step_order ASC
    `).all() as any[];

    const stepsByVersion = new Map<string, any[]>();
    for (const s of steps) {
      if (!stepsByVersion.has(s.policy_version_id)) {
        stepsByVersion.set(s.policy_version_id, []);
      }
      stepsByVersion.get(s.policy_version_id)!.push({
        id: s.id,
        stepOrder: s.step_order,
        stepName: s.step_name,
        stepKey: s.step_key,
        actionType: s.action_type,
        requiredRoleId: s.required_role_id,
        selectorType: s.selector_type,
        selectorValue: s.selector_value,
        isFinalDecisionStep: s.is_final_decision_step === 1,
      });
    }

    const versionsByPolicy = new Map<string, any[]>();
    for (const v of versions) {
      if (!versionsByPolicy.has(v.policy_id)) {
        versionsByPolicy.set(v.policy_id, []);
      }
      versionsByPolicy.get(v.policy_id)!.push({
        id: v.id,
        version: v.version,
        status: v.status,
        priority: v.priority,
        effectiveFrom: v.effective_from,
        effectiveTo: v.effective_to,
        conditionsJson: v.conditions_json,
        isUsed: v.is_used === 1,
        retiredAt: v.retired_at,
        archivedAt: v.archived_at,
        createdAt: v.created_at,
        steps: stepsByVersion.get(v.id) || [],
      });
    }

    const formatted = policies.map((p) => ({
      id: p.id,
      policyKey: p.policy_key,
      policyName: p.policy_name,
      description: p.description,
      policyPurpose: p.policy_purpose || 'APPROVAL',
      policySource: p.policy_source,
      appTypeIds: p.app_type_ids ? p.app_type_ids.split(',') : [],
      versions: versionsByPolicy.get(p.id) || [],
    }));

    res.json({ success: true, policies: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: `ポリシー一覧取得エラー: ${err.message}` });
  }
});

/**
 * 新規論理ポリシーの作成
 */
router.post('/workflow-policies', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { policyKey, policyName, description, policyPurpose, appTypeIds } = req.body;

  if (!policyKey || !policyName || !Array.isArray(appTypeIds) || appTypeIds.length === 0) {
    res.status(400).json({ success: false, message: 'ポリシーキー、ポリシー名、適用申請種別は必須です' });
    return;
  }

  const validPurposes = ['APPROVAL', 'CANCELLATION', 'POST_TRIP_REPORT'];
  const targetPurpose = policyPurpose || 'APPROVAL';
  if (!validPurposes.includes(targetPurpose)) {
    res.status(400).json({ success: false, message: `無効なポリシー用途（policyPurpose: ${policyPurpose}）です` });
    return;
  }

  const db = getDb();
  const runTx = db.transaction(() => {
    const policyId = policyKey.trim().toUpperCase();
    const existing = db.prepare('SELECT id FROM workflow_policies WHERE id = ? OR policy_key = ?').get(policyId, policyId);
    if (existing) {
      throw { statusCode: 409, message: `ポリシー「${policyId}」は既に存在します` };
    }

    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, description, policy_purpose, policy_source, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, 'CUSTOM', ?)
    `).run(policyId, policyId, policyName.trim(), description || '', targetPurpose, user.id);

    const insertNtoM = db.prepare(`
      INSERT INTO workflow_policy_application_types (policy_id, app_type_id)
      VALUES (?, ?)
    `);
    for (const atId of appTypeIds) {
      insertNtoM.run(policyId, atId);
    }

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      roleSnapshot: user.roles.join(','),
      action: 'CREATE_WORKFLOW_POLICY',
      entityType: 'WORKFLOW_POLICY',
      entityId: policyId,
      comment: `新規ワークフローポリシー作成: ${policyName.trim()} (${policyId}, 用途: ${targetPurpose})`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    return policyId;
  });

  try {
    const createdId = runTx();
    res.status(201).json({ success: true, message: 'ポリシーを作成しました', data: { id: createdId } });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});

/**
 * 新規 DRAFT ポリシーバージョンの作成 (ステップ含む または 既存Versionからの安全複製)
 */
router.post('/workflow-policies/:policyId/versions', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { policyId } = req.params;
  const { priority, effectiveFrom, effectiveTo, conditionsJson, steps, baseVersionId } = req.body;

  // steps が明示的に空配列 [] として渡された場合は 422 で拒絶
  if (Array.isArray(steps) && steps.length === 0) {
    res.status(422).json({ success: false, message: '承認ステップは1件以上必要です' });
    return;
  }

  // conditions_json Canonicalization
  let normalizedConditions = '{}';
  if (conditionsJson !== undefined && conditionsJson !== '{}' && conditionsJson !== '') {
    try {
      const parsed = typeof conditionsJson === 'string' ? JSON.parse(conditionsJson) : conditionsJson;
      if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length > 0) {
        res.status(400).json({ success: false, message: '現Releaseでは条件定義 (conditions_json) は空オブジェクト {} のみサポートしています' });
        return;
      }
    } catch {
      res.status(400).json({ success: false, message: '不正なJSON構文です' });
      return;
    }
  }

  const db = getDb();
  const runTx = db.transaction(() => {
    const policy = db.prepare('SELECT * FROM workflow_policies WHERE id = ?').get(policyId) as any;
    if (!policy) {
      throw { statusCode: 404, message: '対象のポリシーが存在しません' };
    }

    // Step解決優先順位: 1. 明示 steps > 2. baseVersionId > 3. ACTIVE Version
    let resolvedSteps: any[] = [];
    let resolvedPriority = priority;
    let resolvedConditionsJson = normalizedConditions;

    if (Array.isArray(steps) && steps.length > 0) {
      // 1. 明示 steps
      resolvedSteps = steps.map((s: any) => ({
        stepName: s.stepName,
        stepKey: s.stepKey,
        actionType: s.actionType,
        requiredRoleId: s.requiredRoleId,
        selectorType: s.selectorType,
        selectorValue: s.selectorValue,
        isFinalDecisionStep: !!s.isFinalDecisionStep,
      }));
    } else {
      let sourceVer: any = null;
      if (baseVersionId) {
        // 2. baseVersionId 指定時: 存在確認および policyId 所属の厳格検証 (不一致時は Fail-Closed)
        sourceVer = db.prepare('SELECT * FROM workflow_policy_versions WHERE id = ? AND policy_id = ?').get(baseVersionId, policyId) as any;
        if (!sourceVer) {
          throw { statusCode: 404, message: `指定された複製元バージョン「${baseVersionId}」は対象ポリシー「${policyId}」に存在しません` };
        }
      } else {
        // 3. baseVersionId 未指定時: 対象ポリシーの ACTIVE Version を取得 (不存在時は Fail-Closed)
        sourceVer = db.prepare('SELECT * FROM workflow_policy_versions WHERE policy_id = ? AND status = \'ACTIVE\'').get(policyId) as any;
        if (!sourceVer) {
          throw { statusCode: 422, message: '複製元となるACTIVEポリシーバージョンが存在しません。承認ステップを明示指定してください' };
        }
      }

      if (resolvedPriority === undefined) {
        resolvedPriority = sourceVer.priority;
      }
      if (conditionsJson === undefined && sourceVer.conditions_json) {
        resolvedConditionsJson = sourceVer.conditions_json;
      }

      // 複製対象フィールドを明示し、業務設定値のみ複製（id, version_id, timestamp等のIdentity/History属性は除外）
      const stepRows = db.prepare(`
        SELECT step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step
        FROM workflow_policy_steps
        WHERE policy_version_id = ?
        ORDER BY step_order ASC
      `).all(sourceVer.id) as any[];

      if (!stepRows || stepRows.length === 0) {
        throw { statusCode: 422, message: '複製元バージョンに承認ステップが存在しません' };
      }

      resolvedSteps = stepRows.map((r: any) => ({
        stepName: r.step_name,
        stepKey: r.step_key,
        actionType: r.action_type,
        requiredRoleId: r.required_role_id,
        selectorType: r.selector_type,
        selectorValue: r.selector_value,
        isFinalDecisionStep: r.is_final_decision_step === 1,
      }));
    }

    if (resolvedSteps.length === 0) {
      throw { statusCode: 422, message: '承認ステップは1件以上必要です' };
    }

    const finalCount = resolvedSteps.filter((s: any) => s.isFinalDecisionStep).length;
    if (finalCount !== 1) {
      throw { statusCode: 422, message: `最終決裁ステップは厳格に1件のみ設定してください (現在: ${finalCount}件)` };
    }

    const maxVerRow = db.prepare('SELECT COALESCE(MAX(version), 0) as max_ver FROM workflow_policy_versions WHERE policy_id = ?').get(policyId) as any;
    const nextVer = (maxVerRow?.max_ver || 0) + 1;
    const versionId = `${policyId}_V${nextVer}`;

    db.prepare(`
      INSERT INTO workflow_policy_versions (
        id, policy_id, version, status, priority, effective_from, effective_to, conditions_json, created_by_user_id
      ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)
    `).run(
      versionId,
      policyId,
      nextVer,
      resolvedPriority !== undefined ? resolvedPriority : 100,
      effectiveFrom || getCanonicalBusinessDate(),
      effectiveTo || '9999-12-31',
      resolvedConditionsJson,
      user.id
    );

    const insertStep = db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let order = 1;
    for (const s of resolvedSteps) {
      if (s.selectorType === 'USER' || s.selectorType === 'ROLE') {
        throw { statusCode: 422, message: '承認ルートの単一責任者Selectorには POSITION を指定してください' };
      }
      insertStep.run(
        versionId,
        order,
        s.stepName,
        s.stepKey || `STEP_${order}`,
        s.actionType || (s.isFinalDecisionStep ? 'DECIDE' : 'APPROVE'),
        s.requiredRoleId || 'TEACHER',
        s.selectorType || 'POSITION',
        s.selectorValue,
        s.isFinalDecisionStep ? 1 : 0
      );
      order++;
    }

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      roleSnapshot: user.roles.join(','),
      action: 'CREATE_WORKFLOW_POLICY_VERSION',
      entityType: 'WORKFLOW_POLICY_VERSION',
      entityId: versionId,
      comment: `ポリシー「${policy.policy_name}」に新バージョン (v${nextVer}) を作成 (DRAFT)`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    return { versionId, version: nextVer };
  });

  try {
    const resData = runTx();
    res.status(201).json({ success: true, message: 'ポリシーバージョン (DRAFT) を作成しました', data: resData });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});

/**
 * DRAFT ポリシーバージョンの更新 (ステップ含む)
 */
router.put('/workflow-policies/:policyId/versions/:versionId', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { policyId, versionId } = req.params;
  const { priority, effectiveFrom, effectiveTo, conditionsJson, steps } = req.body;

  if (!Array.isArray(steps) || steps.length === 0) {
    res.status(422).json({ success: false, message: '承認ステップは1件以上必要です' });
    return;
  }

  const finalCount = steps.filter((s: any) => s.isFinalDecisionStep).length;
  if (finalCount !== 1) {
    res.status(422).json({ success: false, message: `最終決裁ステップは厳格に1件のみ設定してください (現在: ${finalCount}件)` });
    return;
  }

  const db = getDb();
  const runTx = db.transaction(() => {
    const ver = db.prepare('SELECT * FROM workflow_policy_versions WHERE id = ? AND policy_id = ?').get(versionId, policyId) as any;
    if (!ver) {
      throw { statusCode: 404, message: '対象のポリシーバージョンが存在しません' };
    }
    if (ver.status !== 'DRAFT') {
      throw { statusCode: 422, message: 'DRAFT状態のバージョンのみ編集可能です (ACTIVE/INACTIVEは完全不変)' };
    }

    db.prepare(`
      UPDATE workflow_policy_versions
      SET priority = ?, effective_from = ?, effective_to = ?, conditions_json = ?
      WHERE id = ?
    `).run(
      priority !== undefined ? priority : ver.priority,
      effectiveFrom || ver.effective_from,
      effectiveTo || ver.effective_to,
      conditionsJson || ver.conditions_json,
      versionId
    );

    // 既存ステップを削除して再登録
    db.prepare('DELETE FROM workflow_policy_steps WHERE policy_version_id = ?').run(versionId);

    const insertStep = db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let order = 1;
    for (const s of steps) {
      if (s.selectorType === 'USER' || s.selectorType === 'ROLE') {
        throw { statusCode: 422, message: '承認ルートの単一責任者Selectorには POSITION を指定してください' };
      }
      insertStep.run(
        versionId,
        order,
        s.stepName,
        s.stepKey || `STEP_${order}`,
        s.actionType || (s.isFinalDecisionStep ? 'DECIDE' : 'APPROVE'),
        s.requiredRoleId || 'TEACHER',
        s.selectorType || 'POSITION',
        s.selectorValue,
        s.isFinalDecisionStep ? 1 : 0
      );
      order++;
    }

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      roleSnapshot: user.roles.join(','),
      action: 'UPDATE_WORKFLOW_POLICY_VERSION',
      entityType: 'WORKFLOW_POLICY_VERSION',
      entityId: String(versionId),
      comment: `ポリシーバージョン (v${ver.version}) を更新 (DRAFT)`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    return { versionId: String(versionId), version: ver.version };
  });

  try {
    const resData = runTx();
    res.json({ success: true, message: 'ポリシーバージョン (DRAFT) を更新しました', data: resData });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});

/**
 * 未使用 DRAFT ポリシーバージョンの削除
 */
router.delete('/workflow-policies/:policyId/versions/:versionId', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const policyId = String(req.params.policyId);
  const versionId = String(req.params.versionId);

  const db = getDb();
  const runTx = db.transaction(() => {
    const ver = db.prepare('SELECT * FROM workflow_policy_versions WHERE id = ? AND policy_id = ?').get(versionId, policyId) as any;
    if (!ver) {
      throw { statusCode: 404, message: '対象のポリシーバージョンが存在しません' };
    }
    if (ver.status !== 'DRAFT') {
      throw { statusCode: 422, message: 'DRAFT状態のバージョンのみ削除可能です (ACTIVE/INACTIVEは削除不可)' };
    }
    if (ver.is_used === 1) {
      throw { statusCode: 422, message: '申請に使用された実績があるバージョンは削除できません' };
    }

    db.prepare('DELETE FROM workflow_policy_steps WHERE policy_version_id = ?').run(versionId);
    db.prepare('DELETE FROM workflow_policy_versions WHERE id = ?').run(versionId);

    logAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      roleSnapshot: user.roles.join(','),
      action: 'DELETE_WORKFLOW_POLICY_VERSION',
      entityType: 'WORKFLOW_POLICY_VERSION',
      entityId: versionId,
      comment: `ポリシーバージョン (v${ver.version}) を破棄/削除`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });
  });

  try {
    runTx();
    res.json({ success: true, message: 'ポリシーバージョン (DRAFT) を削除しました' });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});

/**
 * DRAFT ポリシーバージョンの Activation Readiness 検証
 */
router.get('/workflow-policies/:policyId/versions/:versionId/readiness', (req: Request, res: Response): void => {
  const versionId = String(req.params.versionId);
  const readiness = PolicyActivationService.validatePolicyDraftReadiness(versionId);
  res.json({ success: true, data: readiness });
});

/**
 * ポリシーバージョンの有効化 (Activation) - OCC 対応
 */
router.post('/workflow-policies/versions/:versionId/activate', (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const versionId = String(req.params.versionId);
  const { expectedCurrentActiveVersionId } = req.body || {};

  const result = PolicyActivationService.activateVersion({
    actor: user,
    versionId,
    expectedCurrentActiveVersionId,
  });

  res.status(result.statusCode).json(result);
});

/* =========================================================================
 * 正式職名マスタ管理 API (Official Job Title Master: INV-JT-08, INV-JT-11)
 * ========================================================================= */

/**
 * 職名マスタ一覧取得
 */
router.get('/official-job-titles', (req: Request, res: Response): void => {
  const db = getDb();
  const titles = db.prepare(`
    SELECT ojt.*,
           (SELECT COUNT(*) FROM user_job_titles WHERE job_title_id = ojt.id) as used_count
    FROM official_job_titles ojt
    ORDER BY ojt.sort_order ASC, ojt.code ASC
  `).all() as any[];

  const formatted = titles.map((t) => ({
    id: t.id,
    code: t.code,
    displayName: t.display_name,
    sortOrder: t.sort_order,
    isActive: t.is_active === 1,
    description: t.description || '',
    isUsed: t.used_count > 0,
    usedCount: t.used_count,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  }));

  res.json({ success: true, jobTitles: formatted });
});

/**
 * 新規職名マスタ登録
 */
router.post('/official-job-titles', requirePermission('job_title.master.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const { id, code, displayName, sortOrder, description } = req.body;

  if (!code || !displayName) {
    res.status(400).json({ success: false, message: '職名コード(code)と正式名称(displayName)は必須です' });
    return;
  }

  const db = getDb();
  const titleId = (id && String(id).trim()) || `JOB_TITLE_${code.trim().toUpperCase()}`;
  const titleCode = code.trim().toUpperCase();
  const titleName = displayName.trim();
  const sOrder = Number(sortOrder) || 100;
  const desc = description ? String(description).trim() : null;
  const now = new Date().toISOString();

  // code 一意性チェック
  const existing = db.prepare('SELECT id FROM official_job_titles WHERE code = ? OR id = ?').get(titleCode, titleId);
  if (existing) {
    res.status(409).json({ success: false, message: `職名コード「${titleCode}」またはID「${titleId}」は既に使用されています` });
    return;
  }

  db.prepare(`
    INSERT INTO official_job_titles (id, code, display_name, sort_order, is_active, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(titleId, titleCode, titleName, sOrder, desc, now, now);

  logAuditStrict({
    actorUserId: user.id,
    actorUsername: user.username,
    action: 'CREATE_JOB_TITLE_MASTER',
    entityType: 'JOB_TITLE_MASTER',
    entityId: titleId,
    afterState: JSON.stringify({ id: titleId, code: titleCode, displayName: titleName }),
    comment: `職名マスタ登録: ${titleName} (${titleCode})`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
  });

  res.status(201).json({
    success: true,
    message: `職名マスタ「${titleName}」を新規登録しました`,
    data: { id: titleId, code: titleCode, displayName: titleName },
  });
});

/**
 * 職名マスタ更新 (使用済みの場合は Semantic Mutation 拒否: INV-JT-11)
 */
router.put('/official-job-titles/:id', requirePermission('job_title.master.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const titleId = String(req.params.id);
  const { code, displayName, sortOrder, isActive, description } = req.body;
  const db = getDb();

  try {
    // 使用実績のあるマスタの code / display_name 改変チェック (INV-JT-11)
    OfficialJobTitleResolver.assertMasterMutable(db, titleId, code, displayName);

    const current = db.prepare('SELECT * FROM official_job_titles WHERE id = ?').get(titleId) as any;
    if (!current) {
      res.status(404).json({ success: false, message: '対象の職名マスタが見つかりません' });
      return;
    }

    const newCode = code !== undefined ? code.trim().toUpperCase() : current.code;
    const newName = displayName !== undefined ? displayName.trim() : current.display_name;
    const newSort = sortOrder !== undefined ? Number(sortOrder) : current.sort_order;
    const newActive = isActive !== undefined ? (isActive ? 1 : 0) : current.is_active;
    const newDesc = description !== undefined ? String(description).trim() : current.description;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE official_job_titles
      SET code = ?, display_name = ?, sort_order = ?, is_active = ?, description = ?, updated_at = ?
      WHERE id = ?
    `).run(newCode, newName, newSort, newActive, newDesc, now, titleId);

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'UPDATE_JOB_TITLE_MASTER',
      entityType: 'JOB_TITLE_MASTER',
      entityId: titleId,
      beforeState: JSON.stringify(current),
      afterState: JSON.stringify({ code: newCode, displayName: newName, isActive: newActive }),
      comment: `職名マスタ更新: ${newName} (${titleId})`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    res.json({ success: true, message: `職名マスタ「${newName}」を更新しました` });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, errorCode: err.code });
  }
});

/**
 * 職名マスタ物理削除 (使用実績がある場合は422拒否)
 */
router.delete('/official-job-titles/:id', requirePermission('job_title.master.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const titleId = String(req.params.id);
  const db = getDb();

  const isUsed = OfficialJobTitleResolver.isMasterUsed(db, titleId);
  if (isUsed) {
    res.status(422).json({
      success: false,
      message: 'この職名マスタは教職員への発令実績が存在するため物理削除できません。新規割当を停止する場合は「新規割当停止(is_active=0)」にしてください (INV-JT-11)',
      errorCode: 'OFFICIAL_JOB_TITLE_IN_USE',
    });
    return;
  }

  const current = db.prepare('SELECT * FROM official_job_titles WHERE id = ?').get(titleId) as any;
  if (!current) {
    res.status(404).json({ success: false, message: '対象の職名マスタが見つかりません' });
    return;
  }

  db.prepare('DELETE FROM official_job_titles WHERE id = ?').run(titleId);

  logAuditStrict({
    actorUserId: user.id,
    actorUsername: user.username,
    action: 'DELETE_JOB_TITLE_MASTER',
    entityType: 'JOB_TITLE_MASTER',
    entityId: titleId,
    beforeState: JSON.stringify(current),
    comment: `職名マスタ物理削除: ${current.display_name} (${titleId})`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
  });

  res.json({ success: true, message: `職名マスタ「${current.display_name}」を削除しました` });
});

/* =========================================================================
 * 教職員 職名発令履歴管理 API (User Official Job Title History: INV-JT-05)
 * ========================================================================= */

/**
 * 教職員の職名発令履歴一覧取得
 */
router.get('/users/:userId/job-titles', (req: Request, res: Response): void => {
  const rawId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const userId = parseInt(rawId, 10);
  const db = getDb();

  const history = db.prepare(`
    SELECT ujt.*, ojt.code as job_title_code, ojt.display_name as job_title_name
    FROM user_job_titles ujt
    JOIN official_job_titles ojt ON ujt.job_title_id = ojt.id
    WHERE ujt.user_id = ?
    ORDER BY ujt.effective_from DESC, ujt.id DESC
  `).all(userId) as any[];

  res.json({ success: true, history });
});

/**
 * 教職員への新規職名発令登録 (重複期間拒否: Overlap Protection)
 */
router.post('/users/:userId/job-titles', requirePermission('job_title.assignment.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const targetUserId = parseInt(rawId, 10);
  const { jobTitleId, effectiveFrom, effectiveTo, orderReferenceNo, note } = req.body;

  if (!jobTitleId || !effectiveFrom) {
    res.status(400).json({ success: false, message: '職名(jobTitleId)と適用開始日(effectiveFrom)は必須です' });
    return;
  }

  const db = getDb();
  const effTo = (effectiveTo && String(effectiveTo).trim()) || '9999-12-31';

  if (effectiveFrom > effTo) {
    res.status(400).json({ success: false, message: '開始日は終了日以前である必要があります' });
    return;
  }

  // 職名マスタ存在確認
  const master = db.prepare('SELECT * FROM official_job_titles WHERE id = ?').get(jobTitleId) as any;
  if (!master) {
    res.status(404).json({ success: false, message: `職名マスタ「${jobTitleId}」が存在しません` });
    return;
  }
  if (master.is_active !== 1) {
    res.status(422).json({ success: false, message: `職名「${master.display_name}」は新規割当停止中のため発令できません` });
    return;
  }

  try {
    // 期間重複チェック (Fail-Closed)
    OfficialJobTitleResolver.checkOverlap(db, targetUserId, effectiveFrom, effTo);

    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO user_job_titles (
        user_id, job_title_id, effective_from, effective_to, order_reference_no, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      targetUserId,
      jobTitleId,
      effectiveFrom,
      effTo,
      orderReferenceNo ? String(orderReferenceNo).trim() : null,
      note ? String(note).trim() : null,
      now,
      now
    );

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'ASSIGN_USER_JOB_TITLE',
      entityType: 'USER_JOB_TITLE',
      entityId: Number(result.lastInsertRowid),
      afterState: JSON.stringify({ jobTitleId, effectiveFrom, effectiveTo: effTo }),
      comment: `職名発令登録: 職員ID ${targetUserId} に「${master.display_name}」を割当 (${effectiveFrom} 〜 ${effTo})`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    res.status(201).json({
      success: true,
      message: `職名「${master.display_name}」の発令を登録しました`,
      data: { id: Number(result.lastInsertRowid) },
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, errorCode: err.code });
  }
});

/**
 * 職名発令履歴の訂正
 */
router.put('/users/:userId/job-titles/:assignmentId', requirePermission('job_title.assignment.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const rawAssignId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const targetUserId = parseInt(rawUserId, 10);
  const assignmentId = parseInt(rawAssignId, 10);
  const { jobTitleId, effectiveFrom, effectiveTo, orderReferenceNo, note, correctionReason } = req.body;

  const db = getDb();
  const current = db.prepare('SELECT * FROM user_job_titles WHERE id = ? AND user_id = ?').get(assignmentId, targetUserId) as any;
  if (!current) {
    res.status(404).json({ success: false, message: '対象の職名発令履歴が見つかりません' });
    return;
  }

  const newJtId = jobTitleId || current.job_title_id;
  const newFrom = effectiveFrom || current.effective_from;
  const newTo = effectiveTo !== undefined ? (effectiveTo ? String(effectiveTo).trim() : '9999-12-31') : current.effective_to;

  if (newFrom > newTo) {
    res.status(400).json({ success: false, message: '開始日は終了日以前である必要があります' });
    return;
  }

  try {
    // 自身を除外して重複期間チェック
    OfficialJobTitleResolver.checkOverlap(db, targetUserId, newFrom, newTo, assignmentId);

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE user_job_titles
      SET job_title_id = ?, effective_from = ?, effective_to = ?, order_reference_no = ?, note = ?, updated_at = ?
      WHERE id = ?
    `).run(
      newJtId,
      newFrom,
      newTo,
      orderReferenceNo !== undefined ? String(orderReferenceNo).trim() : current.order_reference_no,
      note !== undefined ? String(note).trim() : current.note,
      now,
      assignmentId
    );

    logAuditStrict({
      actorUserId: user.id,
      actorUsername: user.username,
      subjectUserId: targetUserId,
      action: 'CORRECT_USER_JOB_TITLE',
      entityType: 'USER_JOB_TITLE',
      entityId: assignmentId,
      beforeState: JSON.stringify(current),
      afterState: JSON.stringify({ jobTitleId: newJtId, effectiveFrom: newFrom, effectiveTo: newTo }),
      comment: `職名発令履歴訂正 (理由: ${correctionReason || '指定なし'})`,
      ipAddress: user.ipAddress,
      userAgent: user.userAgent,
    });

    res.json({ success: true, message: '職名発令履歴を訂正しました' });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, errorCode: err.code });
  }
});

/**
 * 職名発令履歴の取消 (物理削除＋厳格監査ログ)
 */
router.delete('/users/:userId/job-titles/:assignmentId', requirePermission('job_title.assignment.manage'), (req: Request, res: Response): void => {
  const user = getUserContext(req)!;
  const rawUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const rawAssignId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const targetUserId = parseInt(rawUserId, 10);
  const assignmentId = parseInt(rawAssignId, 10);
  const { revokeReason } = req.body || {};

  const db = getDb();
  const current = db.prepare('SELECT * FROM user_job_titles WHERE id = ? AND user_id = ?').get(assignmentId, targetUserId) as any;
  if (!current) {
    res.status(404).json({ success: false, message: '対象の職名発令履歴が見つかりません' });
    return;
  }

  db.prepare('DELETE FROM user_job_titles WHERE id = ?').run(assignmentId);

  logAuditStrict({
    actorUserId: user.id,
    actorUsername: user.username,
    subjectUserId: targetUserId,
    action: 'REVOKE_USER_JOB_TITLE',
    entityType: 'USER_JOB_TITLE',
    entityId: assignmentId,
    beforeState: JSON.stringify(current),
    comment: `職名発令取消 (理由: ${revokeReason || '指定なし'})`,
    ipAddress: user.ipAddress,
    userAgent: user.userAgent,
  });

  res.json({ success: true, message: '職名発令履歴を取り消しました' });
});

export default router;




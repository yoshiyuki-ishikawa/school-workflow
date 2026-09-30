import { Database } from 'better-sqlite3';

export interface ResolvedOfficialJobTitle {
  jobTitleId: string;
  code: string;
  displayName: string;
  effectiveFrom: string;
  effectiveTo: string;
  isFallback?: boolean;
}

export class OfficialJobTitleResolver {
  /**
   * 特定職員の指定日(targetDate)時点の正式職名を決定論的に解決する (Server-Authoritative SSOT)
   */
  static resolveAtDate(
    db: Database,
    userId: number,
    targetDate: string,
    options: { strict?: boolean } = { strict: true }
  ): ResolvedOfficialJobTitle {
    const record = db.prepare(`
      SELECT ujt.effective_from, ujt.effective_to,
             ojt.id as job_title_id, ojt.code, ojt.display_name
      FROM user_job_titles ujt
      JOIN official_job_titles ojt ON ujt.job_title_id = ojt.id
      WHERE ujt.user_id = ?
        AND ujt.effective_from <= ?
        AND ujt.effective_to >= ?
      ORDER BY ujt.id DESC
      LIMIT 1
    `).get(userId, targetDate, targetDate) as {
      effective_from: string;
      effective_to: string;
      job_title_id: string;
      code: string;
      display_name: string;
    } | undefined;

    if (!record) {
      if (options.strict) {
        const err: any = new Error(`職員(ID: ${userId})の指定日(${targetDate})における正式職名が未登録です [OFFICIAL_JOB_TITLE_NOT_RESOLVED]`);
        err.code = 'OFFICIAL_JOB_TITLE_NOT_RESOLVED';
        err.statusCode = 422;
        throw err;
      }
      return {
        jobTitleId: '',
        code: 'UNASSIGNED',
        displayName: '（職名未設定）',
        effectiveFrom: '',
        effectiveTo: '',
        isFallback: true,
      };
    }

    return {
      jobTitleId: record.job_title_id,
      code: record.code,
      displayName: record.display_name,
      effectiveFrom: record.effective_from,
      effectiveTo: record.effective_to,
    };
  }

  /**
   * 発令期間の重複(Overlap)を検査 (Fail-Closed)
   */
  static checkOverlap(
    db: Database,
    userId: number,
    effectiveFrom: string,
    effectiveTo: string,
    excludeAssignmentId?: number
  ): void {
    let sql = `
      SELECT id, effective_from, effective_to
      FROM user_job_titles
      WHERE user_id = ?
        AND effective_from <= ?
        AND effective_to >= ?
    `;
    const params: any[] = [userId, effectiveTo, effectiveFrom];
    if (excludeAssignmentId) {
      sql += ' AND id != ?';
      params.push(excludeAssignmentId);
    }
    const overlapping = db.prepare(sql).all(...params) as any[];

    if (overlapping.length > 0) {
      const err: any = new Error(
        `職員(ID: ${userId})の職名発令期間(${effectiveFrom} 〜 ${effectiveTo})が既存の発令履歴と重複しています [OFFICIAL_JOB_TITLE_OVERLAP_DETECTED]`
      );
      err.code = 'OFFICIAL_JOB_TITLE_OVERLAP_DETECTED';
      err.statusCode = 422;
      throw err;
    }
  }

  /**
   * 職名マスタが既に使用実績（発令履歴）を持つか判定
   */
  static isMasterUsed(db: Database, jobTitleId: string): boolean {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM user_job_titles WHERE job_title_id = ?').get(jobTitleId) as { cnt: number };
    return (count?.cnt || 0) > 0;
  }

  /**
   * 使用実績のある職名マスタのセマンティック改変(code/display_name変更)を拒否 (INV-JT-11)
   */
  static assertMasterMutable(
    db: Database,
    jobTitleId: string,
    newCode?: string,
    newDisplayName?: string
  ): void {
    const current = db.prepare('SELECT id, code, display_name FROM official_job_titles WHERE id = ?').get(jobTitleId) as any;
    if (!current) {
      const err: any = new Error(`職名マスタ「${jobTitleId}」が存在しません`);
      err.statusCode = 404;
      throw err;
    }

    const isUsed = this.isMasterUsed(db, jobTitleId);
    if (isUsed) {
      if (newCode !== undefined && newCode.trim() !== current.code) {
        const err: any = new Error(`職名マスタ「${current.display_name}」は使用実績があるため、識別コードの変更はできません (INV-JT-11) [OFFICIAL_JOB_TITLE_MASTER_SEMANTIC_IMMUTABLE]`);
        err.code = 'OFFICIAL_JOB_TITLE_MASTER_SEMANTIC_IMMUTABLE';
        err.statusCode = 422;
        throw err;
      }
      if (newDisplayName !== undefined && newDisplayName.trim() !== current.display_name) {
        const err: any = new Error(`職名マスタ「${current.display_name}」は使用実績があるため、正式名称の変更はできません。名称変更が必要な場合は新規マスタを作成し、旧マスタを新規割当停止(is_active=0)にしてください (INV-JT-11) [OFFICIAL_JOB_TITLE_MASTER_SEMANTIC_IMMUTABLE]`);
        err.code = 'OFFICIAL_JOB_TITLE_MASTER_SEMANTIC_IMMUTABLE';
        err.statusCode = 422;
        throw err;
      }
    }
  }

  /**
   * 使用実績のある職名マスタの物理削除を拒否 (INV-JT-11)
   */
  static assertMasterDeletable(db: Database, jobTitleId: string): void {
    const current = db.prepare('SELECT id, display_name FROM official_job_titles WHERE id = ?').get(jobTitleId) as any;
    if (!current) {
      const err: any = new Error(`職名マスタ「${jobTitleId}」が存在しません`);
      err.statusCode = 404;
      throw err;
    }
    const isUsed = this.isMasterUsed(db, jobTitleId);
    if (isUsed) {
      const err: any = new Error(`職名マスタ「${current.display_name}」は使用実績があるため、物理削除はできません。新規割当停止(is_active=0)に設定してください (INV-JT-11) [OFFICIAL_JOB_TITLE_MASTER_IN_USE]`);
      err.code = 'OFFICIAL_JOB_TITLE_MASTER_IN_USE';
      err.statusCode = 422;
      throw err;
    }
  }
}

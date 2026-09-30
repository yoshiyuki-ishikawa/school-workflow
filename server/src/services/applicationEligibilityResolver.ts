import { getDb } from '../db/database';
import { EntryCategoryRegistry } from './schema/entryCategoryRegistry';

export type InitiationMode = 'SELF' | 'PROXY' | 'BATCH';

export interface EligibilityActorContext {
  id: number;
  username: string;
  roles: string[];
  permissions?: Set<string>;
  isActive: boolean;
}

export interface EligibilityContext {
  actor: EligibilityActorContext;
  initiationMode: InitiationMode;
  applicationTypeId: string;
  subjectUserId?: number;
  participantUserIds?: number[];
}

export interface EligibilityResult {
  isEligible: boolean;
  httpStatus?: 400 | 403 | 500;
  errorCode?: string;
  message?: string;
}

export interface SelectableApplicationTypeDTO {
  id: string;
  name: string;
  description: string;
  default_route_id: number;
  categoryId: string;
  categoryName: string;
  categoryDescription: string;
  categoryOrder: number;
}

/**
 * 申請起案資格判定エンジン (Server Authoritative)
 * 
 * New Application Entry Architecture v1.2
 * HD-NAE-04: Capability-based Eligibility & Canonical RBAC
 * Fail-Closed: Role直判定禁止, Deterministic Error Contract (400/403/500)
 */
export class ApplicationEligibilityResolver {
  /**
   * ユーザーの付与権限セットを role_permissions テーブルから Canonical に解決
   */
  public static resolveUserPermissions(roles: string[]): Set<string> {
    if (!roles || roles.length === 0) {
      return new Set();
    }
    const db = getDb();
    const placeholders = roles.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT DISTINCT permission_id FROM role_permissions
      WHERE role_id IN (${placeholders})
    `).all(...roles) as { permission_id: string }[];

    return new Set(rows.map(r => r.permission_id));
  }

  /**
   * 申請起案可否のアサーション（拒絶時は決定論的エラーレスポンス用例外またはオブジェクト返却）
   */
  public static evaluateEligibility(context: EligibilityContext): EligibilityResult {
    try {
      const { actor, initiationMode, applicationTypeId, subjectUserId, participantUserIds } = context;

      // 1. カテゴリおよび退役種別の判定 (Server SSOT)
      const categoryMeta = EntryCategoryRegistry.getCategoryForType(applicationTypeId);
      if (!categoryMeta) {
        return {
          isEligible: false,
          httpStatus: 400,
          errorCode: 'INVALID_APPLICATION_TYPE',
          message: `指定された申請種別 (${applicationTypeId}) は無効または未登録です`,
        };
      }

      if (categoryMeta.isRetired) {
        return {
          isEligible: false,
          httpStatus: 403,
          errorCode: 'APPLICATION_TYPE_RETIRED',
          message: `申請種別 (${applicationTypeId}) は退役したため新規起案できません`,
        };
      }

      // 2. 権限セットの保証（未解決の場合は解決）
      const permissions = actor.permissions || this.resolveUserPermissions(actor.roles);

      // 3. 在籍状態チェック (isActive は必要条件)
      if (!actor.isActive) {
        return {
          isEligible: false,
          httpStatus: 403,
          errorCode: 'APPLICATION_NOT_ELIGIBLE',
          message: 'アカウントが無効化されているため申請を起案できません',
        };
      }

      // 4. 起案モード別の Capability & 整合性判定
      if (initiationMode === 'SELF') {
        if (!permissions.has('application.create.self')) {
          return {
            isEligible: false,
            httpStatus: 403,
            errorCode: 'APPLICATION_NOT_ELIGIBLE',
            message: '本人申請を起案する権限がありません',
          };
        }
        return { isEligible: true };
      }

      if (initiationMode === 'PROXY') {
        if (!permissions.has('application.create.proxy')) {
          return {
            isEligible: false,
            httpStatus: 403,
            errorCode: 'APPLICATION_NOT_ELIGIBLE',
            message: '代理申請を起案する権限がありません',
          };
        }

        // 代理起案対象者（Subject）の検証
        if (!subjectUserId || typeof subjectUserId !== 'number' || isNaN(subjectUserId)) {
          return {
            isEligible: false,
            httpStatus: 400,
            errorCode: 'INVALID_PROXY_TARGET',
            message: '代理起案の対象教職員を指定してください',
          };
        }

        if (subjectUserId === actor.id) {
          return {
            isEligible: false,
            httpStatus: 400,
            errorCode: 'INVALID_PROXY_TARGET',
            message: '本人自身を対象とした代理申請は無効です（本人申請モードを使用してください）',
          };
        }

        // 対象ユーザーの存在・有効性確認
        const db = getDb();
        const subjectUser = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(subjectUserId) as { id: number; is_active: number } | undefined;
        if (!subjectUser || subjectUser.is_active !== 1) {
          return {
            isEligible: false,
            httpStatus: 400,
            errorCode: 'INVALID_PROXY_TARGET',
            message: '指定された代理申請対象教職員が存在しないか無効です',
          };
        }

        return { isEligible: true };
      }

      if (initiationMode === 'BATCH') {
        if (!permissions.has('application.create.batch')) {
          return {
            isEligible: false,
            httpStatus: 403,
            errorCode: 'APPLICATION_NOT_ELIGIBLE',
            message: '一括申請を起案する権限がありません',
          };
        }

        // 現行 Batch 起案は出張のみ対応（一括拡張の制限）
        if (applicationTypeId !== 'BUSINESS_TRIP') {
          return {
            isEligible: false,
            httpStatus: 400,
            errorCode: 'INVALID_APPLICATION_TYPE',
            message: `申請種別 (${applicationTypeId}) は一括申請に対応していません`,
          };
        }

        if (!participantUserIds || !Array.isArray(participantUserIds) || participantUserIds.length === 0) {
          return {
            isEligible: false,
            httpStatus: 400,
            errorCode: 'INVALID_PROXY_TARGET',
            message: '一括申請の対象教職員を1名以上指定してください',
          };
        }

        const db = getDb();
        const placeholders = participantUserIds.map(() => '?').join(',');
        const validUsers = db.prepare(`SELECT id FROM users WHERE id IN (${placeholders}) AND is_active = 1`).all(...participantUserIds) as { id: number }[];
        if (validUsers.length !== participantUserIds.length) {
          return {
            isEligible: false,
            httpStatus: 400,
            errorCode: 'INVALID_PROXY_TARGET',
            message: '一括申請の対象教職員に無効または存在しない教職員が含まれています',
          };
        }

        return { isEligible: true };
      }

      return {
        isEligible: false,
        httpStatus: 400,
        errorCode: 'INVALID_APPLICATION_TYPE',
        message: `未知の起案モード (${initiationMode}) です`,
      };
    } catch (err: any) {
      return {
        isEligible: false,
        httpStatus: 500,
        errorCode: 'ELIGIBILITY_RESOLUTION_FAILED',
        message: `起案資格の検証中に予期せぬエラーが発生しました: ${err.message}`,
      };
    }
  }

  /**
   * サーバーサイド起案ガード (assertEligible)
   * 不適格時は例外をスロー（エラーオブジェクト付き）
   */
  public static assertEligible(context: EligibilityContext): void {
    const result = this.evaluateEligibility(context);
    if (!result.isEligible) {
      const error: any = new Error(result.message || '起案資格がありません');
      error.statusCode = result.httpStatus || 403;
      error.code = result.errorCode || 'APPLICATION_NOT_ELIGIBLE';
      throw error;
    }
  }

  /**
   * ログイン中ユーザーが起案可能な申請種別一覧を Server-Authoritative に解決し DTO として返却
   */
  public static resolveSelectableTypes(actor: EligibilityActorContext): SelectableApplicationTypeDTO[] {
    try {
      if (!actor.isActive) {
        return [];
      }

      const permissions = actor.permissions || this.resolveUserPermissions(actor.roles);
      // 起案権限（self または proxy）を一切持たない場合は空（Fail-Closed: ADMIN 等）
      if (!permissions.has('application.create.self') && !permissions.has('application.create.proxy')) {
        return [];
      }

      const db = getDb();
      const rawTypes = db.prepare('SELECT * FROM application_types ORDER BY id ASC').all() as {
        id: string;
        name: string;
        description: string;
        default_route_id: number;
      }[];

      const selectableList: SelectableApplicationTypeDTO[] = [];

      for (const t of rawTypes) {
        // 退役種別（LEAVE_LARGE_SCHOOL）は除外
        if (EntryCategoryRegistry.isRetiredType(t.id)) {
          continue;
        }

        const catMeta = EntryCategoryRegistry.getCategoryForType(t.id);
        // 未分類種別は除外 (UNKNOWN ≠ OTHER: Fail-Closed)
        if (!catMeta) {
          continue;
        }

        selectableList.push({
          id: t.id,
          name: t.name,
          description: t.description || '',
          default_route_id: t.default_route_id,
          categoryId: catMeta.id,
          categoryName: catMeta.name,
          categoryDescription: catMeta.description,
          categoryOrder: catMeta.displayOrder,
        });
      }

      return selectableList;
    } catch (err) {
      // リゾルバー異常時は全件許可（Fail-Open）を禁止し、空配列（Fail-Closed）
      return [];
    }
  }
}

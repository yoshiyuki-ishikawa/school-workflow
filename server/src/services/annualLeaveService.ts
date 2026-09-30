import { getDb } from '../db/database';
import { getServerIsoString } from '../utils/serverTime';
import { LeaveEntitlement, LeaveUsage, LeaveUnit } from '../types';
import { AnnualLeavePolicyContextResolver, AnnualLeavePolicyContext } from './leave/annualLeavePolicyContextResolver';

export interface AnnualLeaveBalance {
  totalGrantedDays: number;
  representationMode: 'DAY_AND_TIME_NORMALIZED' | 'TIME_ONLY_DISPLAY';
  remainingDays: number;
  remainingMinutes: number;
  minutesPerDay: number;
  totalRemainingMinutes: number;
  formattedBalanceText: string;
}

export interface RolloverPreviewItem {
  userId: number;
  displayName: string;
  username: string;
  department: string;
  previousYearRemainingDays: number;
  carryoverDays: number;
  regularGrantDays: number;
  totalAvailableDays: number;
  alreadyRolledOver: boolean;
}

export class AnnualLeaveService {
  /**
   * 年次有給休暇の新規ロット付与（Grant Idempotency 保証）
   */
  static grantEntitlement(params: {
    userId: number;
    entitlementType: 'REGULAR_GRANT' | 'MID_CAREER_GRANT' | 'TEMPORARY_GRANT' | 'CARRYOVER' | 'MANUAL_ADJUSTMENT';
    fiscalYear: number;
    grantedDays: number;
    grantDate: string;
    effectiveFrom: string;
    expiresAt: string;
    sourcePolicyId?: number;
    carryoverFromId?: number;
    reason: string;
    grantEventKey?: string;
  }): number {
    const db = getDb();
    const now = getServerIsoString();
    
    // 一意な entitlement_code 生成 (grantEventKey がある場合は冪等キーとして使用)
    const code = params.grantEventKey || `ENT-${params.fiscalYear}-${params.userId}-${params.entitlementType}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    // 冪等性チェック: 同一コードのロットが既に存在する場合はそのIDを返却
    const existing = db.prepare('SELECT id FROM leave_entitlements WHERE entitlement_code = ?').get(code) as { id: number } | undefined;
    if (existing) {
      return existing.id;
    }

    const res = db.prepare(`
      INSERT INTO leave_entitlements (
        user_id, entitlement_code, entitlement_type, fiscal_year, granted_days,
        used_half_days, used_hourly_minutes, grant_date, effective_from, expires_at,
        source_policy_id, carryover_from_id, status, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
    `).run(
      params.userId,
      code,
      params.entitlementType,
      params.fiscalYear,
      params.grantedDays,
      params.grantDate,
      params.effectiveFrom,
      params.expiresAt,
      params.sourcePolicyId || null,
      params.carryoverFromId || null,
      params.reason,
      now,
      now
    );

    return Number(res.lastInsertRowid);
  }

  /**
   * ユーザーの年休残高（Canonical AnnualLeaveBalance）を算出
   */
  static getLeaveBalance(userId: number, asOfDate?: string): AnnualLeaveBalance {
    const db = getDb();
    const today = asOfDate || new Date().toISOString().split('T')[0];
    const calendarYear = parseInt(today.split('-')[0], 10);

    const policyContext = AnnualLeavePolicyContextResolver.resolve(userId, today);
    const minutesPerDay = policyContext.dayConversion.status === 'APPLICABLE' ? policyContext.dayConversion.minutesPerDay : 465;

    // 1. 有効ロット一覧取得 (expires_at ASC, grant_date ASC, id ASC)
    let entitlements = db.prepare(`
      SELECT * FROM leave_entitlements
      WHERE user_id = ?
        AND status = 'ACTIVE'
        AND effective_from <= ?
        AND expires_at >= ?
      ORDER BY expires_at ASC, grant_date ASC, id ASC
    `).all(userId, today, today) as LeaveEntitlement[];

    // ロットが存在しない初期状態の場合の補完
    const hasAny = db.prepare('SELECT id FROM leave_entitlements WHERE user_id = ?').get(userId);
    if (entitlements.length === 0 && !hasAny) {
      const grantDays = policyContext.patternName.includes('週4日') ? 16 : (policyContext.patternName.includes('週3日') ? 12 : 20);
      this.grantEntitlement({
        userId,
        entitlementType: 'REGULAR_GRANT',
        fiscalYear: calendarYear,
        grantedDays: grantDays,
        grantDate: `${calendarYear}-01-01`,
        effectiveFrom: `${calendarYear}-01-01`,
        expiresAt: `${calendarYear + 1}-12-31`,
        reason: '初期付与',
        grantEventKey: `INITIAL-GRANT-${userId}-${calendarYear}`
      });
      entitlements = db.prepare(`
        SELECT * FROM leave_entitlements
        WHERE user_id = ? AND status = 'ACTIVE' AND effective_from <= ? AND expires_at >= ?
        ORDER BY expires_at ASC, grant_date ASC, id ASC
      `).all(userId, today, today) as LeaveEntitlement[];
    }

    let totalGrantedDays = 0;
    let totalUsedHalfUnits = 0;
    let totalUsedHourlyMinutes = 0;

    const hasCarryoverInYear = entitlements.some(e => e.fiscal_year === calendarYear && e.entitlement_type === 'CARRYOVER');

    for (const ent of entitlements) {
      if (hasCarryoverInYear && ent.fiscal_year < calendarYear) {
        // 当年に繰越ロットが存在する場合、前年以前のロットは繰越元として CARRYOVER に集約されているため
        // 当年の totalGrantedDays / 使用量には二重加算しない
      } else {
        totalGrantedDays += ent.granted_days;
        totalUsedHalfUnits += ent.used_half_days;
        totalUsedHourlyMinutes += ent.used_hourly_minutes;
      }
    }

    // 2. 総保有分数と総消費分数の計算
    const totalGrantedMinutes = totalGrantedDays * minutesPerDay;
    const totalUsedMinutes = Math.round((totalUsedHalfUnits * minutesPerDay) / 2) + totalUsedHourlyMinutes;
    const totalRemainingMinutes = Math.max(0, totalGrantedMinutes - totalUsedMinutes);

    // 3. ハイブリッド残日数・残時間の正規化
    const remainingDays = Math.floor(totalRemainingMinutes / minutesPerDay);
    const remainingMinutes = totalRemainingMinutes % minutesPerDay;

    let formattedBalanceText = '';
    if (policyContext.patternUniformity === 'NON_UNIFORM') {
      const h = Math.floor(totalRemainingMinutes / 60);
      const m = totalRemainingMinutes % 60;
      formattedBalanceText = `${h}時間${m > 0 ? m + '分' : ''} (${remainingDays}日相当)`;
    } else {
      const h = Math.floor(remainingMinutes / 60);
      const m = remainingMinutes % 60;
      if (h > 0 || m > 0) {
        formattedBalanceText = `${remainingDays}日 ${h}時間${m > 0 ? m + '分' : ''}`;
      } else {
        formattedBalanceText = `${remainingDays}日`;
      }
    }

    return {
      totalGrantedDays,
      representationMode: policyContext.patternUniformity === 'NON_UNIFORM' ? 'TIME_ONLY_DISPLAY' : 'DAY_AND_TIME_NORMALIZED',
      remainingDays,
      remainingMinutes,
      minutesPerDay,
      totalRemainingMinutes,
      formattedBalanceText
    };
  }

  /**
   * 互換用: 年休残高 Projection の取得
   */
  static getLeaveBalanceProjection(userId: number, asOfDate?: string): {
    totalGrantedDays: number;
    remainingDays: number;
    remainingHalfDayUnits: number;
    hourlyUsedMinutesInYear: number;
    hourlyLimitMinutesInYear: number;
    hourlyRemainingMinutesInYear: number;
    formattedRemaining: string;
    formattedHourlyUsage: string;
  } {
    const bal = this.getLeaveBalance(userId, asOfDate);
    const db = getDb();
    const today = asOfDate || new Date().toISOString().split('T')[0];

    const entitlements = db.prepare(`
      SELECT * FROM leave_entitlements
      WHERE user_id = ? AND status = 'ACTIVE' AND effective_from <= ? AND expires_at >= ?
    `).all(userId, today, today) as LeaveEntitlement[];

    let hourlyUsedMinutes = 0;
    for (const ent of entitlements) {
      hourlyUsedMinutes += ent.used_hourly_minutes;
    }

    return {
      totalGrantedDays: bal.totalGrantedDays,
      remainingDays: bal.remainingDays,
      remainingHalfDayUnits: bal.remainingDays * 2,
      hourlyUsedMinutesInYear: hourlyUsedMinutes,
      hourlyLimitMinutesInYear: bal.totalRemainingMinutes,
      hourlyRemainingMinutesInYear: bal.totalRemainingMinutes,
      formattedRemaining: bal.formattedBalanceText,
      formattedHourlyUsage: `${Math.floor(hourlyUsedMinutes / 60)}時間${hourlyUsedMinutes % 60}分 (時間休上限なし)`
    };
  }

  /**
   * 申請提出時の年次有給休暇バリデーション（LeaveCalculationService と連携）
   */
  static validateAnnualLeaveRequest(formData: Record<string, any>, subjectUserId: number): {
    valid: boolean;
    status: number;
    message?: string;
    deductionUnits?: number;
    hourlyMinutes?: number;
    attendanceDeductionMinutes?: number;
    calculationSnapshot?: any;
  } {
    const { LeaveCalculationService } = require('./leave/leaveCalculationService');
    const startDate = formData.startDate || formData.targetDate || formData.startAt?.split('T')?.[0];
    const endDate = formData.endDate || formData.targetDate || formData.endAt?.split('T')?.[0] || startDate;

    let rawUnit = formData.unitType || 'DAY';
    let halfDayType = formData.halfDayType;
    if (rawUnit === 'FULL_DAY') rawUnit = 'DAY';
    if (rawUnit === 'HOURLY') rawUnit = 'TIME';
    if (rawUnit === 'HALF_DAY_AM') { rawUnit = 'HALF_DAY'; halfDayType = 'MORNING'; }
    if (rawUnit === 'HALF_DAY_PM') { rawUnit = 'HALF_DAY'; halfDayType = 'AFTERNOON'; }

    const calc = LeaveCalculationService.calculate({
      subjectUserId,
      typeId: 'LEAVE_ANNUAL',
      startDate,
      endDate,
      targetDate: startDate,
      unitType: rawUnit,
      halfDayType,
      startTime: formData.startTime,
      endTime: formData.endTime,
      calculatedDays: formData.calculatedDays
    });

    if (!calc.isValid) {
      return {
        valid: false,
        status: 400,
        message: calc.message || '年次有給休暇の算出バリデーションに失敗しました'
      };
    }

    // 残高チェック
    try {
      const balance = this.getLeaveBalance(subjectUserId, startDate);
      const reqMinutes = (calc.entitlementDeduction?.deductionHalfUnits || 0) * Math.round(balance.minutesPerDay / 2) + (calc.entitlementDeduction?.chargedHourlyMinutes || 0);
      if (reqMinutes > balance.totalRemainingMinutes) {
        return {
          valid: false,
          status: 422,
          message: `年次有給休暇の残日数が不足しています (所要: ${reqMinutes}分, 残高: ${balance.totalRemainingMinutes}分)`
        };
      }
    } catch {
      // 勤務パターン未設定等の場合は calc 側でハンドリング
    }

    return {
      valid: true,
      status: 200,
      deductionUnits: calc.entitlementDeduction?.deductionHalfUnits,
      hourlyMinutes: calc.entitlementDeduction?.chargedHourlyMinutes,
      attendanceDeductionMinutes: calc.snapshot?.attendanceDeductionMinutes,
      calculationSnapshot: calc.snapshot
    };
  }

  /**
   * 決裁完了時の確定行使・決定論的 FIFO ロット引当 ＆ CalculationSnapshot 固定保存
   */
  static finalizeUsage(applicationId: number): void {
    const db = getDb();
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId) as any;
    if (!app || app.type_id !== 'LEAVE_ANNUAL') return;

    // 二重確定ガード (Idempotency)
    const existingUsage = db.prepare("SELECT id FROM leave_usages WHERE application_id = ? AND status = 'ACTIVE'").get(applicationId);
    if (existingUsage) return;

    const formData = JSON.parse(app.form_data || '{}');
    const startDate = formData.startDate || formData.targetDate;
    const endDate = formData.endDate || formData.targetDate || startDate;

    const { LeaveCalculationService } = require('./leave/leaveCalculationService');

    let rawUnit = formData.unitType || 'DAY';
    let halfDayType = formData.halfDayType;
    if (rawUnit === 'FULL_DAY') rawUnit = 'DAY';
    if (rawUnit === 'HOURLY') rawUnit = 'TIME';
    if (rawUnit === 'HALF_DAY_AM') { rawUnit = 'HALF_DAY'; halfDayType = 'MORNING'; }
    if (rawUnit === 'HALF_DAY_PM') { rawUnit = 'HALF_DAY'; halfDayType = 'AFTERNOON'; }

    const calc = LeaveCalculationService.calculate({
      subjectUserId: app.subject_user_id,
      typeId: 'LEAVE_ANNUAL',
      startDate,
      endDate,
      targetDate: startDate,
      unitType: rawUnit,
      halfDayType,
      startTime: formData.startTime,
      endTime: formData.endTime,
      calculatedDays: formData.calculatedDays
    });

    if (!calc.isValid || !calc.snapshot || !calc.entitlementDeduction) {
      throw new Error(`年休行使確定エラー: ${calc.message}`);
    }

    const snapshot = calc.snapshot;
    const deduction = calc.entitlementDeduction;
    const now = getServerIsoString();
    const snapshotJson = JSON.stringify(snapshot);

    db.transaction(() => {
      // 1. applications.final_calculation_snapshot 固定保存
      db.prepare(`
        UPDATE applications
        SET final_calculation_snapshot = ?, updated_at = ?
        WHERE id = ?
      `).run(snapshotJson, now, applicationId);

      // 2. 有効ロット一覧取得 (決定論的 FIFO: 1. expires_at ASC, 2. grant_date ASC, 3. id ASC)
      const entitlements = db.prepare(`
        SELECT * FROM leave_entitlements
        WHERE user_id = ?
          AND status = 'ACTIVE'
          AND effective_from <= ?
          AND expires_at >= ?
        ORDER BY expires_at ASC, grant_date ASC, id ASC
      `).all(app.subject_user_id, startDate, startDate) as LeaveEntitlement[];

      if (entitlements.length === 0) {
        throw new Error(`[INSUFFICIENT_ENTITLEMENT] 有効な年休ロットが存在しません (userId=${app.subject_user_id})`);
      }

      // expires_at NOT NULL 制約の Fail-Closed チェック
      for (const ent of entitlements) {
        if (!ent.expires_at) {
          throw new Error(`[SYSTEM_DATA_CORRUPTION] ロット (ID=${ent.id}) の expires_at が NULL です`);
        }
      }

      let remainingHalfUnitsToDeduct = deduction.deductionHalfUnits;
      let remainingHourlyMinsToDeduct = deduction.chargedHourlyMinutes;

      // 日単位・半日単位の FIFO 引当
      if (remainingHalfUnitsToDeduct > 0) {
        for (const ent of entitlements) {
          if (remainingHalfUnitsToDeduct <= 0) break;
          const maxHalf = ent.granted_days * 2;
          const availableHalf = maxHalf - ent.used_half_days;

          if (availableHalf > 0) {
            const deduct = Math.min(availableHalf, remainingHalfUnitsToDeduct);
            db.prepare(`
              UPDATE leave_entitlements
              SET used_half_days = used_half_days + ?, updated_at = ?
              WHERE id = ?
            `).run(deduct, now, ent.id);
            remainingHalfUnitsToDeduct -= deduct;
          }
        }
      }

      // 時間休の引当 (先頭ロットの使用時間へ加算)
      if (remainingHourlyMinsToDeduct > 0) {
        const primaryLot = entitlements[0];
        db.prepare(`
          UPDATE leave_entitlements
          SET used_hourly_minutes = used_hourly_minutes + ?, updated_at = ?
          WHERE id = ?
        `).run(remainingHourlyMinsToDeduct, now, primaryLot.id);
      }

      // leave_usages レコード登録
      let usageUnit: LeaveUnit = 'FULL_DAY';
      if (snapshot.unitType === 'HALF_DAY') {
        usageUnit = snapshot.halfDayType === 'AFTERNOON' ? 'HALF_DAY_PM' : 'HALF_DAY_AM';
      } else if (snapshot.unitType === 'TIME') {
        usageUnit = 'HOURLY';
      }

      db.prepare(`
        INSERT INTO leave_usages (
          entitlement_id, application_id, user_id, target_date, unit_type,
          day_deduction_units, hourly_minutes, attendance_deduction_minutes, calculation_snapshot, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
      `).run(
        entitlements[0].id,
        applicationId,
        app.subject_user_id,
        startDate,
        usageUnit,
        deduction.deductionHalfUnits,
        deduction.chargedHourlyMinutes,
        snapshot.attendanceDeductionMinutes,
        snapshotJson,
        now
      );

      // 3. 遅延決裁・過去日付決裁時の年次繰越ロット自動再整合（Auto-Rebalance）
      // 過去年度の年休が事後決裁された場合、翌年度以降の CARRYOVER ロットの granted_days を前年末の実残数に合わせて自動補正
      const appYear = parseInt(startDate.split('-')[0], 10);
      const carryLots = db.prepare(`
        SELECT * FROM leave_entitlements
        WHERE user_id = ? AND entitlement_type = 'CARRYOVER' AND fiscal_year > ? AND status = 'ACTIVE'
        ORDER BY fiscal_year ASC
      `).all(app.subject_user_id, appYear) as LeaveEntitlement[];

      for (const cl of carryLots) {
        const prevYear = cl.fiscal_year - 1;
        const prevAsOf = `${prevYear}-12-31`;
        const prevBal = this.getLeaveBalance(app.subject_user_id, prevAsOf);
        const policyCtx = AnnualLeavePolicyContextResolver.resolve(app.subject_user_id, prevAsOf);
        const maxCarry = policyCtx.patternName.includes('週4日') ? 16 : (policyCtx.patternName.includes('週3日') ? 12 : 20);
        const correctCarryDays = Math.min(maxCarry, prevBal.remainingDays);

        if (cl.granted_days !== correctCarryDays) {
          db.prepare(`
            UPDATE leave_entitlements
            SET granted_days = ?, updated_at = ?
            WHERE id = ?
          `).run(correctCarryDays, now, cl.id);
        }
      }
    })();
  }

  /**
   * 承認後取消における Exact-Reversal 方式の年休原状復帰（物理削除禁止）
   */
  static reconcileLeaveLedgerOnCancellation(params: {
    applicationId: number;
    userId: number;
    cancellationCycleId: number;
    reason: string;
  }): void {
    const db = getDb();
    const now = getServerIsoString();

    const activeUsages = db.prepare(`
      SELECT * FROM leave_usages
      WHERE application_id = ? AND status = 'ACTIVE'
    `).all(params.applicationId) as LeaveUsage[];

    if (activeUsages.length === 0) {
      throw new Error(`[DATA_INCONSISTENCY] 取消対象申請 (ID: ${params.applicationId}) に対応する有効な年休行使履歴が存在しません`);
    }

    db.transaction(() => {
      // 1. leave_usages を status = 'REVERSED' に更新
      db.prepare(`
        UPDATE leave_usages
        SET status = 'REVERSED',
            reversed_at = ?,
            reversal_reason = ?,
            reversal_cycle_id = ?
        WHERE application_id = ? AND status = 'ACTIVE'
      `).run(now, params.reason, params.cancellationCycleId, params.applicationId);

      // 2. 元の消費割当をそのまま元ロットへ戻し入れ (Exact Reversal)
      for (const usage of activeUsages) {
        if (usage.day_deduction_units > 0) {
          db.prepare(`
            UPDATE leave_entitlements
            SET used_half_days = MAX(0, used_half_days - ?), updated_at = ?
            WHERE id = ?
          `).run(usage.day_deduction_units, now, usage.entitlement_id);
        }
        if (usage.hourly_minutes > 0) {
          db.prepare(`
            UPDATE leave_entitlements
            SET used_hourly_minutes = MAX(0, used_hourly_minutes - ?), updated_at = ?
            WHERE id = ?
          `).run(usage.hourly_minutes, now, usage.entitlement_id);
        }

        // 後続年度の CARRYOVER ロットが存在する場合、戻し入れ日数（上限20日）に応じて繰越ロットの granted_days を再同期
        const originalEnt = db.prepare('SELECT * FROM leave_entitlements WHERE id = ?').get(usage.entitlement_id) as LeaveEntitlement | undefined;
        if (originalEnt) {
          const nextYear = originalEnt.fiscal_year + 1;
          const carryoverLot = db.prepare(`
            SELECT * FROM leave_entitlements
            WHERE user_id = ? AND fiscal_year = ? AND entitlement_type = 'CARRYOVER' AND status = 'ACTIVE'
          `).get(params.userId, nextYear) as LeaveEntitlement | undefined;

          if (carryoverLot && usage.day_deduction_units > 0) {
            const restoredDays = usage.day_deduction_units / 2;
            const newCarryoverDays = Math.min(20, carryoverLot.granted_days + restoredDays);
            db.prepare(`
              UPDATE leave_entitlements
              SET granted_days = ?, updated_at = ?
              WHERE id = ?
            `).run(newCarryoverDays, now, carryoverLot.id);
          }
        }
      }
    })();
  }

  /**
   * 勤務形態変更に伴う年休調整・再換算 (Working Pattern Conversion Process)
   * 
   * Type A: UNIFORM -> UNIFORM の調整日数算定式 (提供資料 Ground Truth)
   *   調整日数 B = (新勤務形態基準付与日数 - 旧勤務形態基準付与日数)
   *   有効日数 C = 変更前残日数 A + 調整日数 B
   */
  static convertWorkingPatternLeaveBalance(params: {
    userId: number;
    changeDate: string;
    oldPatternType: string;
    newPatternType: string;
    oldStandardDays: number;
    newStandardDays: number;
    reason: string;
  }): { adjustmentDays: number; newRemainingDays: number; conversionSnapshot: any } {
    const db = getDb();
    const now = getServerIsoString();
    const currentBalance = this.getLeaveBalance(params.userId, params.changeDate);

    // Conversion Policy Matrix 照合 (Type A のみ CONFIRMED, その他は Fail-Closed)
    const isUniformOld = params.oldPatternType !== 'REAPPOINTED_NON_UNIFORM';
    const isUniformNew = params.newPatternType !== 'REAPPOINTED_NON_UNIFORM';

    if (!isUniformOld || !isUniformNew) {
      throw new Error(`[CONVERSION_POLICY_UNRESOLVED] NON_UNIFORM を含む勤務形態変更ポリシーは未定義のため計算を停止しました`);
    }

    const adjustmentDays = params.newStandardDays - params.oldStandardDays;
    const newRemainingDays = currentBalance.remainingDays + adjustmentDays;

    const conversionSnapshot = {
      changeDate: params.changeDate,
      oldPatternType: params.oldPatternType,
      newPatternType: params.newPatternType,
      preChangeRemainingDays: currentBalance.remainingDays,
      preChangeRemainingMinutes: currentBalance.remainingMinutes,
      adjustmentDays,
      postChangeRemainingDays: newRemainingDays,
      calculatedAt: now,
      reason: params.reason
    };

    // 調整ロット（MANUAL_ADJUSTMENT）の登録
    const year = parseInt(params.changeDate.split('-')[0], 10);
    this.grantEntitlement({
      userId: params.userId,
      entitlementType: 'MANUAL_ADJUSTMENT',
      fiscalYear: year,
      grantedDays: adjustmentDays,
      grantDate: params.changeDate,
      effectiveFrom: params.changeDate,
      expiresAt: `${year + 1}-12-31`,
      reason: `勤務形態変更に伴う按分調整: ${params.reason}`,
      grantEventKey: `CONV-ADJ-${params.userId}-${params.changeDate}-${Date.now()}`
    });

    return { adjustmentDays, newRemainingDays, conversionSnapshot };
  }

  /**
   * 1月1日 年次繰越プレビューの取得
   */
  static getAnnualRolloverPreview(targetYear: number): {
    userId: number;
    userName: string;
    carryoverDays: number;
    regularGrantDays: number;
    totalAvailableDays: number;
  }[] {
    const db = getDb();
    const previousYear = targetYear - 1;
    const asOfDate = `${previousYear}-12-31`;

    const users = db.prepare('SELECT id, username, display_name, department FROM users WHERE is_active = 1 ORDER BY id ASC').all() as any[];
    const result: any[] = [];

    for (const u of users) {
      const policyContext = AnnualLeavePolicyContextResolver.resolve(u.id, asOfDate);
      const balance = this.getLeaveBalance(u.id, asOfDate);
      const maxCarry = policyContext.patternName.includes('週4日') ? 16 : (policyContext.patternName.includes('週3日') ? 12 : 20);
      const carryoverDays = Math.min(maxCarry, balance.remainingDays);
      const regularGrantDays = policyContext.patternName.includes('週4日') ? 16 : (policyContext.patternName.includes('週3日') ? 12 : 20);

      result.push({
        userId: u.id,
        userName: u.display_name,
        carryoverDays,
        regularGrantDays,
        totalAvailableDays: carryoverDays + regularGrantDays
      });
    }

    return result;
  }

  /**
   * 1月1日 年次繰越 ＆ 定期付与の一括実行（Carryover Process と Conversion Process を分離）
   */
  static processAnnualRollover(targetYear: number, createdByUserId = 1): { processedCount: number; messages: string[] } {
    const db = getDb();
    const now = getServerIsoString();
    const previousYear = targetYear - 1;
    const asOfDate = `${previousYear}-12-31`;

    const users = db.prepare('SELECT id, username, display_name, department FROM users WHERE is_active = 1 ORDER BY id ASC').all() as any[];
    let processedCount = 0;
    const messages: string[] = [];

    db.transaction(() => {
      for (const u of users) {
        // 12/31時点の旧 Working Pattern のもとで年末残高を確定 (Step 1: Carryover 確定)
        const policyContext = AnnualLeavePolicyContextResolver.resolve(u.id, asOfDate);
        const balance = this.getLeaveBalance(u.id, asOfDate);

        // 繰越上限: フルタイム20日、再任用週4なら16日、週3なら12日
        const maxCarry = policyContext.patternName.includes('週4日') ? 16 : (policyContext.patternName.includes('週3日') ? 12 : 20);
        const carryoverDays = Math.min(maxCarry, balance.remainingDays);

        // 当年定期付与日数
        const regularGrantDays = policyContext.patternName.includes('週4日') ? 16 : (policyContext.patternName.includes('週3日') ? 12 : 20);

        // 繰越ロット登録 (Idempotency ガード)
        if (carryoverDays > 0) {
          this.grantEntitlement({
            userId: u.id,
            entitlementType: 'CARRYOVER',
            fiscalYear: targetYear,
            grantedDays: carryoverDays,
            grantDate: `${targetYear}-01-01`,
            effectiveFrom: `${targetYear}-01-01`,
            expiresAt: `${targetYear}-12-31`,
            reason: `${previousYear}年12月31日残数繰越（上限${maxCarry}日）`,
            grantEventKey: `CARRYOVER-${u.id}-${targetYear}`
          });
        }

        // 当年定期付与ロット登録 (Idempotency ガード)
        this.grantEntitlement({
          userId: u.id,
          entitlementType: 'REGULAR_GRANT',
          fiscalYear: targetYear,
          grantedDays: regularGrantDays,
          grantDate: `${targetYear}-01-01`,
          effectiveFrom: `${targetYear}-01-01`,
          expiresAt: `${targetYear + 1}-12-31`,
          reason: `${targetYear}年定期付与`,
          grantEventKey: `REGULAR-${u.id}-${targetYear}`
        });

        processedCount++;
        messages.push(`${u.display_name}: 繰越 ${carryoverDays}日 ＋ 当年付与 ${regularGrantDays}日`);
      }
    })();

    return { processedCount, messages };
  }
}

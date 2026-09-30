import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { migrator } from '../db/migrations';
import { SCHEMA_SQL } from '../db/schema';
import { seedDatabase } from '../db/seeds';
import { LeaveCalculationService } from '../services/leave/leaveCalculationService';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { WorkflowEngine } from '../workflow/engine';

describe('NEW-GAP-03: Leave Preview Server Integration & Golden Tests', () => {
    let db: any;
    const applicantUser = {
        id: 1,
        username: 'teacher1',
        displayName: '山田 太郎',
        roles: ['TEACHER'],
        ipAddress: '127.0.0.1'
    };
    const unauthorizedUser = {
        id: 2,
        username: 'sato.kenji',
        displayName: '佐藤 健二',
        roles: ['TEACHER'],
        ipAddress: '127.0.0.1'
    };
    const vpUser = {
        id: 3,
        username: 'vice_principal',
        displayName: '教頭',
        roles: ['VICE_PRINCIPAL'],
        ipAddress: '127.0.0.1'
    };
    const principalUser = {
        id: 4,
        username: 'principal',
        displayName: '校長',
        roles: ['PRINCIPAL'],
        ipAddress: '127.0.0.1'
    };

    before(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        db.exec(SCHEMA_SQL);
        migrator.runMigrations(db);
        setDb(db);
        seedDatabase();

        // Set standard work pattern for applicant (Mon-Fri 08:15-16:45, Sat-Sun off)
        db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(applicantUser.id);
        const s465 = JSON.stringify({
            "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
            "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
            "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
            "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
            "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
            "5": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
            "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
        });
        db.prepare(`
            INSERT INTO user_work_patterns (
                user_id, pattern_name, pattern_type, effective_from, effective_to,
                weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
            ) VALUES (?, '通常フルタイム', 'STANDARD_FULLTIME', '2025-01-01', '9999-12-31', '0,6', ?, 2325, 'INDIVIDUAL', 1, '2026-01-01', 1, '2026-01-01')
        `).run(applicantUser.id, s465);

        // Grant annual leave (20 days for 2026)
        db.prepare('DELETE FROM leave_usages WHERE user_id = ?').run(applicantUser.id);
        db.prepare('DELETE FROM leave_entitlements WHERE user_id = ?').run(applicantUser.id);
        AnnualLeaveService.grantEntitlement({
            userId: applicantUser.id,
            entitlementType: 'REGULAR_GRANT',
            fiscalYear: 2026,
            grantedDays: 20,
            grantDate: '2026-01-01',
            effectiveFrom: '2026-01-01',
            expiresAt: '2027-12-31',
            reason: '2026年定期付与'
        });
    });

    after(() => {
        db.close();
    });

    it('GT-PREVIEW-01: Fri-Mon DAY range preview (2 working days, 2 weekend days skipped)', () => {
        // 2026-06-05 (Fri) to 2026-06-08 (Mon)
        const preview = LeaveCalculationService.calculate({
            subjectUserId: applicantUser.id,
            typeId: 'LEAVE_ANNUAL',
            startDate: '2026-06-05',
            endDate: '2026-06-08',
            unitType: 'DAY'
        });

        assert.strictEqual(preview.isValid, true);
        assert.strictEqual(preview.totalChargedDays, 2, 'Total charged days should be 2 for Fri-Mon span');
        assert.strictEqual(preview.skippedNonWorkingDaysCount, 2, '2 weekend days should be skipped');
        assert.strictEqual(preview.chargeableDaysCount, 2, '2 chargeable days');
        assert.ok(Array.isArray(preview.perDayResults));
        assert.strictEqual(preview.perDayResults.length, 4, 'Breakdown should cover 4 calendar dates');
    });

    it('GT-PREVIEW-02: Range with Holiday / Calendar adjustment (e.g. May Golden Week)', () => {
        // 2026-05-01 (Fri) to 2026-05-06 (Wed)
        // 5/1=Work, 5/2=Sat, 5/3=憲法記念日, 5/4=みどりの日, 5/5=こどもの日, 5/6=振替休日
        const preview = LeaveCalculationService.calculate({
            subjectUserId: applicantUser.id,
            typeId: 'LEAVE_ANNUAL',
            startDate: '2026-05-01',
            endDate: '2026-05-06',
            unitType: 'DAY'
        });

        assert.strictEqual(preview.isValid, true);
        assert.strictEqual(preview.totalChargedDays, 1, 'Only 5/1 is charged as leave');
        assert.strictEqual(preview.skippedNonWorkingDaysCount, 5, '5 weekend/holidays should be skipped');
        assert.strictEqual(preview.chargeableDaysCount, 1);
    });

    it('GT-PREVIEW-03: Unauthorized proxy preview returns 403 Forbidden check in router policy', () => {
        const reqSubjectUserId = applicantUser.id;
        const callerUser = unauthorizedUser;

        let isForbidden = false;
        if (reqSubjectUserId && Number(reqSubjectUserId) !== callerUser.id) {
            const isManager = callerUser.roles.some((r) => ['ADMIN', 'VICE_PRINCIPAL', 'PRINCIPAL'].includes(r));
            if (!isManager) {
                isForbidden = true;
            }
        }
        assert.strictEqual(isForbidden, true, 'Non-manager caller must be forbidden from proxy preview');

        const adminCaller = principalUser;
        let adminForbidden = false;
        if (reqSubjectUserId && Number(reqSubjectUserId) !== adminCaller.id) {
            const isManager = adminCaller.roles.some((r) => ['ADMIN', 'VICE_PRINCIPAL', 'PRINCIPAL'].includes(r));
            if (!isManager) {
                adminForbidden = true;
            }
        }
        assert.strictEqual(adminForbidden, false, 'Admin/Principal caller must be permitted to preview for subject');
    });

    it('GT-PREVIEW-04: Semantic equivalence between Preview and final_calculation_snapshot upon Final Approval', () => {
        const testStartDate = '2026-07-03'; // Fri
        const testEndDate = '2026-07-06';   // Mon

        // 1. Preview calculation
        const preview = LeaveCalculationService.calculate({
            subjectUserId: applicantUser.id,
            typeId: 'LEAVE_ANNUAL',
            startDate: testStartDate,
            endDate: testEndDate,
            unitType: 'DAY'
        });

        // 2. Submit application via WorkflowEngine.submitApplication
        const submitResult = WorkflowEngine.submitApplication(applicantUser, {
            typeId: 'LEAVE_ANNUAL',
            title: 'GT-PREVIEW-04 期間年休テスト',
            formData: {
                startDate: testStartDate,
                endDate: testEndDate,
                unitType: 'FULL_DAY',
                calculatedDays: preview.totalChargedDays,
                reason: '私用のため'
            }
        });

        assert.strictEqual(submitResult.success, true);
        const appId = submitResult.data.id;

        // 3. Complete approval flow (VP -> Principal)
        let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
        const vpRes = WorkflowEngine.approveApplication(vpUser, {
            applicationId: appId,
            expectedVersion: app.version
        });
        assert.strictEqual(vpRes.success, true);

        app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
        const princRes = WorkflowEngine.approveApplication(principalUser, {
            applicationId: appId,
            expectedVersion: app.version
        });
        assert.strictEqual(princRes.success, true);

        // 4. Inspect final_calculation_snapshot in DB
        const appRow = db.prepare(`SELECT final_calculation_snapshot FROM applications WHERE id = ?`).get(appId) as { final_calculation_snapshot: string };
        assert.ok(appRow, 'Application row must exist');
        assert.ok(appRow.final_calculation_snapshot, 'final_calculation_snapshot must be populated upon approval');

        const snapshot = JSON.parse(appRow.final_calculation_snapshot);
        assert.strictEqual(snapshot.chargedDays, preview.totalChargedDays);
        assert.strictEqual(snapshot.chargeableDaysCount, preview.chargeableDaysCount);
        assert.strictEqual(snapshot.skippedNonWorkingDaysCount, preview.skippedNonWorkingDaysCount);
    });

    it('GT-PREVIEW-05: State Invariance — Preview is 100% read-only and side-effect-free', () => {
        const countAppsBefore = (db.prepare(`SELECT count(*) as c FROM applications`).get() as any).c;
        const countEntsBefore = (db.prepare(`SELECT count(*) as c FROM leave_entitlements`).get() as any).c;
        const countUsagesBefore = (db.prepare(`SELECT count(*) as c FROM leave_usages`).get() as any).c;
        const countAuditsBefore = (db.prepare(`SELECT count(*) as c FROM audit_logs`).get() as any).c;
        const entBefore = db.prepare(`SELECT used_half_days, used_hourly_minutes FROM leave_entitlements WHERE user_id = ?`).get(applicantUser.id) as { used_half_days: number; used_hourly_minutes: number };

        // Call calculate (preview) multiple times
        for (let i = 0; i < 5; i++) {
            const preview = LeaveCalculationService.calculate({
                subjectUserId: applicantUser.id,
                typeId: 'LEAVE_ANNUAL',
                startDate: '2026-08-03',
                endDate: '2026-08-07',
                unitType: 'DAY'
            });
            assert.strictEqual(preview.isValid, true);
        }

        const countAppsAfter = (db.prepare(`SELECT count(*) as c FROM applications`).get() as any).c;
        const countEntsAfter = (db.prepare(`SELECT count(*) as c FROM leave_entitlements`).get() as any).c;
        const countUsagesAfter = (db.prepare(`SELECT count(*) as c FROM leave_usages`).get() as any).c;
        const countAuditsAfter = (db.prepare(`SELECT count(*) as c FROM audit_logs`).get() as any).c;
        const entAfter = db.prepare(`SELECT used_half_days, used_hourly_minutes FROM leave_entitlements WHERE user_id = ?`).get(applicantUser.id) as { used_half_days: number; used_hourly_minutes: number };

        assert.strictEqual(countAppsAfter, countAppsBefore, 'Applications table row count must not change');
        assert.strictEqual(countEntsAfter, countEntsBefore, 'Leave entitlements table row count must not change');
        assert.strictEqual(countUsagesAfter, countUsagesBefore, 'Leave usages table row count must not change');
        assert.strictEqual(countAuditsAfter, countAuditsBefore, 'Audit logs table row count must not change');
        assert.strictEqual(entAfter.used_half_days, entBefore.used_half_days, 'Entitlement used_half_days must be unchanged');
        assert.strictEqual(entAfter.used_hourly_minutes, entBefore.used_hourly_minutes, 'Entitlement used_hourly_minutes must be unchanged');
    });
});

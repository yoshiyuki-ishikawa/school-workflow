import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../db/database';
import { migrator } from '../db/migrations';
import { SickLeaveCalculator } from '../domain/leave/sickLeaveCalculator';

describe('Original Wave 2B (GAP-06: 病気休暇) Golden Tests (GT-W2B-01 〜 GT-W2B-12)', () => {
  before(() => {
    const db = getDb();
    migrator.runMigrations(db);

    const nowIso = new Date().toISOString();

    // 既存重複を防ぐため、テスト用ユーザー 1, 2 の既存パターンを削除
    db.prepare('DELETE FROM user_work_patterns WHERE user_id IN (1, 2)').run();

    // テストユーザー用の標準勤務パターン (月〜金 465分, 土日週休) を準備 (userId = 1)
    db.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, weekly_off_days, weekly_total_minutes,
        effective_from, effective_to, schedule_details_json, record_origin, created_by_user_id, created_at, updated_at, schedule_source
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INDIVIDUAL'
      )
    `).run(
      99901,
      1,
      '標準フルタイム',
      'STANDARD_FULLTIME',
      '0,6',
      2325,
      '2026-01-01',
      '2027-12-31',
      JSON.stringify({
        0: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null },
        1: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        2: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        3: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        4: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        5: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        6: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null }
      }),
      'ADMIN_CONFIGURED',
      1,
      nowIso,
      nowIso
    );

    // 短時間勤務職員用パターン (月〜金 300分, 土日週休, userId = 2)
    db.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, weekly_off_days, weekly_total_minutes,
        effective_from, effective_to, schedule_details_json, record_origin, created_by_user_id, created_at, updated_at, schedule_source
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INDIVIDUAL'
      )
    `).run(
      99902,
      2,
      '短時間勤務',
      'SHORT_TIME',
      '0,6',
      1500,
      '2026-01-01',
      '2027-12-31',
      JSON.stringify({
        0: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null },
        1: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        2: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        3: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        4: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        5: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        6: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null }
      }),
      'ADMIN_CONFIGURED',
      1,
      nowIso,
      nowIso
    );
  });

  // GT-W2B-01: 金〜月 4暦日病休 (金:W, 土:NW, 日:NW, 月:W)
  it('GT-W2B-01: 金〜月 4暦日病休 (Calendar Span=4, Duty Exemption=2日/930分, 6日判定=false, 通算=4日)', () => {
    // 2026-05-15(金) 〜 2026-05-18(月)
    const res = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-05-15',
      endDate: '2026-05-18',
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    assert.strictEqual(res.isFailClosed, false);
    const snap = res.snapshot!;
    assert.strictEqual(snap.applicationCalendarSpanDays, 4);
    assert.strictEqual(snap.consecutiveSickLeaveSpanDays, 4);
    assert.strictEqual(snap.isConsecutive6Days, false);
    assert.strictEqual(snap.medicalCertificateRequired, false);
    assert.strictEqual(snap.totalDutyExemptionDays, 2.0);
    assert.strictEqual(snap.totalDutyExemptionMinutes, 930);
    assert.strictEqual(snap.accumulatedSameDiseaseCalendarDaysAfter, 4);

    // 4層ブレークダウンの検証
    assert.strictEqual(snap.dailyBreakdown.length, 4);
    assert.strictEqual(snap.dailyBreakdown[0].date, '2026-05-15');
    assert.strictEqual(snap.dailyBreakdown[0].obligation, 'WORKING');
    assert.strictEqual(snap.dailyBreakdown[0].dutyExemptionMinutes, 465);

    assert.strictEqual(snap.dailyBreakdown[1].date, '2026-05-16');
    assert.strictEqual(snap.dailyBreakdown[1].obligation, 'NON_WORKING');
    assert.strictEqual(snap.dailyBreakdown[1].dutyExemptionMinutes, 0);
    assert.deepStrictEqual(snap.dailyBreakdown[1].overlayTags, ['WEEKLY_OFF', 'IN_SICK_LEAVE_PERIOD']);

    assert.strictEqual(snap.dailyBreakdown[2].date, '2026-05-17');
    assert.strictEqual(snap.dailyBreakdown[2].obligation, 'NON_WORKING');
    assert.strictEqual(snap.dailyBreakdown[2].dutyExemptionMinutes, 0);
    assert.deepStrictEqual(snap.dailyBreakdown[2].overlayTags, ['WEEKLY_OFF', 'IN_SICK_LEAVE_PERIOD']);

    assert.strictEqual(snap.dailyBreakdown[3].date, '2026-05-18');
    assert.strictEqual(snap.dailyBreakdown[3].obligation, 'WORKING');
    assert.strictEqual(snap.dailyBreakdown[3].dutyExemptionMinutes, 465);
  });

  // GT-W2B-02: 金〜翌水 6暦日病休 (金:W, 土日:NW, 月〜水:W)
  it('GT-W2B-02: 金〜翌水 6暦日病休 (Calendar Span=6, 免除=4日/1860分, 6日判定=true, 診断書添付必須)', () => {
    // 診断書未添付 ➔ Fail-Closed
    const resBlocked = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-05-15',
      endDate: '2026-05-20',
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });
    assert.strictEqual(resBlocked.isFailClosed, true);
    assert.match(resBlocked.failReason!, /診断書の提出が必要です/);

    // 診断書添付 ➔ 成功
    const resAllowed = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-05-15',
      endDate: '2026-05-20',
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });
    assert.strictEqual(resAllowed.isFailClosed, false);
    const snap = resAllowed.snapshot!;
    assert.strictEqual(snap.applicationCalendarSpanDays, 6);
    assert.strictEqual(snap.consecutiveSickLeaveSpanDays, 6);
    assert.strictEqual(snap.isConsecutive6Days, true);
    assert.strictEqual(snap.medicalCertificateRequired, true);
    assert.strictEqual(snap.totalDutyExemptionDays, 4.0);
    assert.strictEqual(snap.totalDutyExemptionMinutes, 1860);
  });

  // GT-W2B-03: 祝日を含む期間の並印と0分免除
  it('GT-W2B-03: 祝日を含む期間 (祝日Fact保持 + 病休期間所属保持 + 免除0分)', () => {
    // 2026-05-01(金) 〜 2026-05-06(水・振替休日)
    // 5/1:金(W), 5/2:土(NW), 5/3:日(憲法記念日/NW), 5/4:月(みどりの日/NW), 5/5:火(こどもの日/NW), 5/6:水(振替休日/NW)
    const res = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-05-01',
      endDate: '2026-05-06',
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    assert.strictEqual(res.isFailClosed, false);
    const snap = res.snapshot!;
    assert.strictEqual(snap.applicationCalendarSpanDays, 6);
    assert.strictEqual(snap.totalDutyExemptionDays, 1.0); // 5/1のみ
    assert.strictEqual(snap.totalDutyExemptionMinutes, 465);

    const holidayBreakdown = snap.dailyBreakdown.find((d) => d.date === '2026-05-04');
    assert.ok(holidayBreakdown);
    assert.strictEqual(holidayBreakdown.obligation, 'NON_WORKING');
    assert.strictEqual(holidayBreakdown.dutyExemptionMinutes, 0);
    assert.ok(holidayBreakdown.overlayTags.includes('HOLIDAY'));
    assert.ok(holidayBreakdown.overlayTags.includes('IN_SICK_LEAVE_PERIOD'));
  });

  // GT-W2B-04: 90日境界 Off-by-One 検証 (89, 90, 91)
  it('GT-W2B-04: 90日境界 Off-by-One 検証 (89日, 90日, 91日)', () => {
    // 過去に 80日間の同一疾病承認区間が存在
    const priorIntervals = [
      {
        startDate: '2026-01-01',
        endDate: '2026-03-21', // 80暦日
        diseaseContinuityDecision: 'SAME_DISEASE' as const,
        status: 'APPROVED'
      }
    ];

    // Case 89日: 今回 9日間 (80 + 9 = 89)
    const res89 = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-06-01',
      endDate: '2026-06-09',
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE',
      existingApprovedIntervals: priorIntervals
    });
    assert.strictEqual(res89.snapshot!.accumulatedSameDiseaseCalendarDaysAfter, 89);
    assert.strictEqual(res89.snapshot!.isExceeding90Days, false);

    // Case 90日: 今回 10日間 (80 + 10 = 90)
    const res90 = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-06-01',
      endDate: '2026-06-10',
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE',
      existingApprovedIntervals: priorIntervals
    });
    assert.strictEqual(res90.snapshot!.accumulatedSameDiseaseCalendarDaysAfter, 90);
    assert.strictEqual(res90.snapshot!.isExceeding90Days, false);

    // Case 91日: 今回 11日間 (80 + 11 = 91)
    const res91 = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-06-01',
      endDate: '2026-06-11',
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE',
      existingApprovedIntervals: priorIntervals
    });
    assert.strictEqual(res91.snapshot!.accumulatedSameDiseaseCalendarDaysAfter, 91);
    assert.strictEqual(res91.snapshot!.isExceeding90Days, true);
  });

  // GT-W2B-05: diseaseContinuityDecision === 'UNRESOLVED' Fail-Closed
  it('GT-W2B-05: diseaseContinuityDecision === UNRESOLVED での Fail-Closed 遮断', () => {
    const priorIntervals = [
      {
        startDate: '2026-01-01',
        endDate: '2026-01-10',
        diseaseContinuityDecision: 'SAME_DISEASE' as const,
        status: 'APPROVED'
      }
    ];

    const res = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'UNRESOLVED',
      existingApprovedIntervals: priorIntervals
    });

    assert.strictEqual(res.isFailClosed, true);
    assert.match(res.failReason!, /行政判断.*未確定/);
  });

  // GT-W2B-06: 時間単位病休 非自動日換算
  it('GT-W2B-06: 時間単位病休がシステム独自で日換算されて90日通算に加算されないこと', () => {
    const res = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    assert.strictEqual(res.snapshot!.applicationCalendarSpanDays, 1);
    assert.strictEqual(res.snapshot!.accumulatedSameDiseaseCalendarDaysAfter, 1);
  });

  // GT-W2B-07: 週休日＋病休期間所属 (出勤簿並印 Fact 非破壊保持)
  it('GT-W2B-07: 週休 Fact と病休期間所属 Fact が共存し破棄されないこと', () => {
    const res = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-05-16', // 土
      endDate: '2026-05-17',   // 日
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    const snap = res.snapshot!;
    assert.strictEqual(snap.applicationCalendarSpanDays, 2);
    assert.strictEqual(snap.totalDutyExemptionMinutes, 0);
    assert.strictEqual(snap.dailyBreakdown[0].overlayTags.includes('WEEKLY_OFF'), true);
    assert.strictEqual(snap.dailyBreakdown[0].overlayTags.includes('IN_SICK_LEAVE_PERIOD'), true);
  });

  // GT-W2B-08: 重複承認区間のマージ (Interval Union による二重計上排除)
  it('GT-W2B-08: 重複承認区間が存在しても同一暦日が二重計上されないこと (Interval Union)', () => {
    const priorIntervals = [
      {
        startDate: '2026-06-01',
        endDate: '2026-06-10',
        diseaseContinuityDecision: 'SAME_DISEASE' as const,
        status: 'APPROVED'
      },
      {
        startDate: '2026-06-05',
        endDate: '2026-06-15',
        diseaseContinuityDecision: 'SAME_DISEASE' as const,
        status: 'APPROVED'
      }
    ];

    const res = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-06-20',
      endDate: '2026-06-22', // 3日
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SAME_DISEASE',
      existingApprovedIntervals: priorIntervals
    });

    const snap = res.snapshot!;
    assert.strictEqual(snap.accumulatedSameDiseaseCalendarDaysBefore, 15);
    assert.strictEqual(snap.accumulatedSameDiseaseCalendarDaysAfter, 18);
  });

  // GT-W2B-09: 非465分勤務パターン (Working Obligation SSOT 由来の免除時間)
  it('GT-W2B-09: 短時間勤務職員 (300分/日) において SSOT 由来の免除時間が算出されること', () => {
    const res = SickLeaveCalculator.calculate({
      userId: 2,
      startDate: '2026-05-18', // 月
      endDate: '2026-05-19',   // 火
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    const snap = res.snapshot!;
    assert.strictEqual(snap.applicationCalendarSpanDays, 2);
    assert.strictEqual(snap.totalDutyExemptionDays, 2.0);
    assert.strictEqual(snap.totalDutyExemptionMinutes, 600); // 300分 × 2日 = 600分
    assert.strictEqual(snap.dailyBreakdown[0].dutyExemptionMinutes, 300);
  });

  // GT-W2B-10: 分割申請の連続性判定 (Consecutive Sick Leave Resolver: 6日診断書判定)
  it('GT-W2B-10: 直前承認病休と暦日接続する場合に consecutiveSpan が連結され診断書添付が必須となること', () => {
    const priorIntervals = [
      {
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        diseaseContinuityDecision: 'SEPARATE_DISEASE' as const,
        status: 'APPROVED'
      }
    ];

    const resNoMed = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-09-04',
      endDate: '2026-09-06',
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE',
      existingApprovedIntervals: priorIntervals
    });

    assert.strictEqual(resNoMed.isFailClosed, true);
    assert.match(resNoMed.failReason!, /連続6日間.*診断書.*必要/);

    const resWithMed = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-09-04',
      endDate: '2026-09-06',
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SEPARATE_DISEASE',
      existingApprovedIntervals: priorIntervals
    });

    assert.strictEqual(resWithMed.isFailClosed, false);
    assert.strictEqual(resWithMed.snapshot!.applicationCalendarSpanDays, 3);
    assert.strictEqual(resWithMed.snapshot!.consecutiveSickLeaveSpanDays, 6);
    assert.strictEqual(resWithMed.snapshot!.isConsecutive6Days, true);
  });

  // GT-W2B-11: 3種類の日数 Fact の独立性 (型・Resolver・値の分離)
  it('GT-W2B-11: applicationCalendarSpanDays / consecutiveSickLeaveSpanDays / accumulatedSameDiseaseCalendarDays の完全独立性', () => {
    const priorIntervals = [
      {
        startDate: '2026-05-01',
        endDate: '2026-05-02',
        diseaseContinuityDecision: 'SAME_DISEASE' as const,
        status: 'APPROVED'
      }
    ];

    const res = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-05-03',
      endDate: '2026-05-05',
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SAME_DISEASE',
      existingApprovedIntervals: priorIntervals
    });

    const snap = res.snapshot!;
    assert.strictEqual(snap.applicationCalendarSpanDays, 3);
    assert.strictEqual(snap.consecutiveSickLeaveSpanDays, 5);
    assert.strictEqual(snap.accumulatedSameDiseaseCalendarDaysAfter, 5);
    assert.notStrictEqual(snap.applicationCalendarSpanDays, snap.consecutiveSickLeaveSpanDays);
  });

  // GT-W2B-12: 取消・訂正後の90日通算整合性 (CANCELLED 区間が通算から除外されること)
  it('GT-W2B-12: CANCELLED の病気休暇レコードが 90日通算集合から確実に除外されること', () => {
    const priorIntervals = [
      {
        startDate: '2026-01-01',
        endDate: '2026-01-10',
        diseaseContinuityDecision: 'SAME_DISEASE' as const,
        status: 'CANCELLED'
      },
      {
        startDate: '2026-02-01',
        endDate: '2026-02-05',
        diseaseContinuityDecision: 'SAME_DISEASE' as const,
        status: 'APPROVED'
      }
    ];

    const res = SickLeaveCalculator.calculate({
      userId: 1,
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SAME_DISEASE',
      existingApprovedIntervals: priorIntervals
    });

    const snap = res.snapshot!;
    assert.strictEqual(snap.accumulatedSameDiseaseCalendarDaysBefore, 5);
    assert.strictEqual(snap.accumulatedSameDiseaseCalendarDaysAfter, 8);
  });
});

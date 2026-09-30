import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE_URL = 'http://localhost:3000/api';

describe('休暇簿・旅行命令簿・出勤簿 フル統合 E2E HTTP テスト', () => {
  let teacherCookie = '';
  let principalCookie = '';
  let adminCookie = '';

  it('1. ログイン認証', async () => {
    // 教員
    let res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'teacher1', password: 'teacher123' }),
    });
    teacherCookie = res.headers.get('set-cookie')?.split(';')[0] || '';

    // 校長
    res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'principal', password: 'principal123' }),
    });
    principalCookie = res.headers.get('set-cookie')?.split(';')[0] || '';

    // 事務係
    res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    adminCookie = res.headers.get('set-cookie')?.split(';')[0] || '';
  });

  it('2. カレンダー振替（土曜運動会を勤務日に変更、月曜を代休に指定）の登録', async () => {
    // 2026-10-18 (日) -> 勤務日
    let res = await fetch(`${BASE_URL}/attendance/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        date: '2026-10-18',
        scope: 'ALL',
        overrideType: 'WORKDAY',
        reason: '秋季大運動会',
      }),
    });
    assert.strictEqual(res.status, 200);

    // 2026-10-19 (月) -> 代休
    res = await fetch(`${BASE_URL}/attendance/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        date: '2026-10-19',
        scope: 'ALL',
        overrideType: 'SUBSTITUTE_HOLIDAY',
        reason: '運動会振替休業日',
      }),
    });
    assert.strictEqual(res.status, 200);
  });

  it('3. 出勤簿 月間出勤簿データの取得と自動転記・振替の検証', async () => {
    const res = await fetch(`${BASE_URL}/attendance/monthly?userId=1&yearMonth=2026-10`, {
      headers: { Cookie: teacherCookie },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    const data = body.data;

    // 10/18 の検証 (勤務日)
    const day18 = data.days.find((d: any) => d.day === 18);
    assert.strictEqual(day18.stampText, '勤務日');
    assert.strictEqual(day18.stampSubText, '秋季大運動会');

    // 10/19 の検証 (代休)
    const day19 = data.days.find((d: any) => d.day === 19);
    assert.strictEqual(day19.stampText, '代休');
  });

  it('4. 校長による月次出勤簿の確定・承認サイン', async () => {
    const res = await fetch(`${BASE_URL}/attendance/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: principalCookie },
      body: JSON.stringify({
        userId: 1,
        yearMonth: '2026-10',
        comment: '10月度出勤簿点検・決裁完了',
      }),
    });
    assert.strictEqual(res.status, 200);

    // 再取得して CONFIRMED になっていることを確認
    const checkRes = await fetch(`${BASE_URL}/attendance/monthly?userId=1&yearMonth=2026-10`, {
      headers: { Cookie: teacherCookie },
    });
    const checkBody = await checkRes.json();
    assert.strictEqual(checkBody.data.approval.status, 'CONFIRMED');
    assert.strictEqual(checkBody.data.approval.confirmedByUserName, '鈴木 健一 (校長C)');
  });
});

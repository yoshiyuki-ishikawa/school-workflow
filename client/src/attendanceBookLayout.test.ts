import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { OfficialFormModal } from './components/OfficialFormModal.js';

describe('Attendance Book A4 Layout Golden Tests (GT-BUG-ALAY)', () => {
  const dummyAttendanceData = {
    userId: 1,
    userName: '山田 太郎',
    userDepartment: '教務部',
    yearMonth: '2026-05',
    days: Array.from({ length: 31 }, (_, i) => ({
      day: i + 1,
      dayOfWeek: ['日', '月', '火', '水', '木', '金', '土'][(i + 5) % 7],
      isWeekend: (i + 5) % 7 === 0 || (i + 5) % 7 === 6,
      isHoliday: false,
      stampText: i === 0 ? '年休' : undefined,
      stampSubText: undefined,
    })),
    summary: {
      workdayCount: 20,
      weekOffCount: 9,
      holidayCount: 2,
      annualLeave: { formatted: '1日' },
      sickLeave: { formatted: '0分' },
      specialLeave: { formatted: '0分' },
      absence: { formatted: '0日' },
      businessTripDays: 0,
      businessTripCount: 0,
    },
    approval: {
      status: 'OPEN',
    },
  };

  const dummyProps = {
    isOpen: true,
    formType: 'ATTENDANCE' as const,
    userId: 1,
    yearMonth: '2026-05',
    onClose: () => {},
  };

  it('GT-BUG-ALAY-01: AttendanceFormRenderer のカレンダー各行が repeat(16, minmax(0, 1fr)) の明示的 16 列グリッドスタイルを保持していること', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const componentSource = fs.readFileSync(path.resolve('./src/components/OfficialFormModal.tsx'), 'utf-8');

    // 1. grid-cols-16 の未定義クラスへの依存が完全除去されていること
    assert.strictEqual(
      componentSource.includes('grid-cols-16'),
      false,
      '未定義の Tailwind クラス grid-cols-16 が存在しないこと'
    );

    // 2. repeat(16, minmax(0, 1fr)) の明示的インラインスタイルが 4 箇所 (ヘッダー×2, データ×2) に設定されていること
    const matches = componentSource.match(/gridTemplateColumns:\s*'repeat\(16,\s*minmax\(0,\s*1fr\)\)'/g);
    assert.ok(matches, 'gridTemplateColumns 16列スタイルが存在すること');
    assert.strictEqual(matches.length, 4, '1〜16日ヘッダー、1〜16日データ、17〜31日ヘッダー、17〜31日データの計4行に設定されていること');
  });

  it('GT-BUG-ALAY-02: Client Build 成果物に未定義クラスによるスタイル欠落がなく、16列グリッド定義が確実に含まれていること', async () => {
    const fs = await import('fs');
    const path = await import('path');
    
    // client/dist/assets/index-*.js にインラインスタイルが正しくコンパイルされていることを確認
    const distFiles = fs.readdirSync(path.resolve('./dist/assets'));
    const jsBundle = distFiles.find(f => f.startsWith('index-') && f.endsWith('.js'));
    assert.ok(jsBundle, 'クライアント JS バンドルが存在すること');

    const jsContent = fs.readFileSync(path.resolve('./dist/assets', jsBundle), 'utf-8');
    assert.ok(
      jsContent.includes('repeat(16, minmax(0, 1fr))') || jsContent.includes('repeat(16,minmax(0,1fr))'),
      'JS バンドル内に 16 列グリッドのインラインスタイルがコンパイルされていること'
    );
  });

  it('GT-BUG-ANAME-02: AttendanceFormRenderer が user.displayName のみを厳格に使用し、snake_case fallback なしで氏名をレンダリングすること', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const componentSource = fs.readFileSync(path.resolve('./src/components/OfficialFormModal.tsx'), 'utf-8');

    // 1. user.displayName を直接参照していること
    assert.ok(
      componentSource.includes('{user.displayName}'),
      '氏名表示部に {user.displayName} が使用されていること'
    );

    // 2. snake_case の fallback (user.display_name 等) を追加して DTO 違反を隠蔽していないこと
    assert.strictEqual(
      componentSource.includes('user.display_name'),
      false,
      'Renderer 側に user.display_name の fallback が存在しないこと'
    );
  });
});

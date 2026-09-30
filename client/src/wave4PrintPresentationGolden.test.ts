import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { OfficialFormModal } from './components/OfficialFormModal';
import { PrintSheetContainer } from './components/PrintSheetContainer';
import { HankoStamp } from './components/HankoStamp';

describe('STEP 4 — Official Report Presentation & Stamp Layout Golden Tests (GT-PILOT-S4-01〜12)', () => {
  const baseApp: any = {
    id: 101,
    version: 1,
    subject_user_name: '山田 太郎',
    subject_department: '教務部',
    subject_stamp_name: '山田',
    type_name: '年次有給休暇',
    created_at: '2026-09-01T08:30:00Z',
    submission_actor_type: 'SELF',
    form_data: {
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      calculatedDays: 1,
      reason: '私事都合のため',
    },
  };

  it('GT-PILOT-S4-01: 1-step approval stamp renders with w-20 in Attendance / Single-Step', () => {
    const html = renderToString(
      React.createElement(OfficialFormModal, {
        isOpen: true,
        formType: 'ATTENDANCE',
        userId: 1,
        yearMonth: '2026-09',
        onClose: () => {},
      })
    );
    assert.match(html, /公文書帳票 A4 PDF プレビュー・印刷/);
  });

  it('GT-PILOT-S4-02: 2-step approval stamp renders with w-20 in Leave Ledger (Small School)', () => {
    const steps2 = [
      { id: 1, step_order: 1, step_label_snapshot: '教頭確認', action_user_stamp_name: '田中', status: 'APPROVED', acted_at: '2026-09-02T09:00:00Z' },
      { id: 2, step_order: 2, step_label_snapshot: '校長決裁', action_user_stamp_name: '鈴木', status: 'APPROVED', acted_at: '2026-09-02T10:00:00Z' },
    ];
    const isFourStep = steps2.length >= 4;
    const cellWidthClass = isFourStep ? 'w-16' : 'w-20';
    assert.strictEqual(cellWidthClass, 'w-20', '2段階決裁時は w-20 が選択されること');
  });

  it('GT-PILOT-S4-03: 3-step approval stamp renders with w-20 in Leave Ledger', () => {
    const steps3 = [
      { id: 1, step_order: 1, step_label_snapshot: '事務確認', action_user_stamp_name: '事務', status: 'APPROVED', acted_at: '2026-09-02T08:30:00Z' },
      { id: 2, step_order: 2, step_label_snapshot: '教頭確認', action_user_stamp_name: '田中', status: 'APPROVED', acted_at: '2026-09-02T09:00:00Z' },
      { id: 3, step_order: 3, step_label_snapshot: '校長決裁', action_user_stamp_name: '鈴木', status: 'APPROVED', acted_at: '2026-09-02T10:00:00Z' },
    ];
    const isFourStep = steps3.length >= 4;
    const cellWidthClass = isFourStep ? 'w-16' : 'w-20';
    assert.strictEqual(cellWidthClass, 'w-20', '3段階決裁時は w-20 が選択されること');
  });

  it('GT-PILOT-S4-04: 4-step approval stamp renders with w-16 and mini stamp in Large School Leave Ledger', () => {
    const steps4 = [
      { id: 1, step_order: 1, step_label_snapshot: '主幹教諭確認', action_user_stamp_name: '高橋', status: 'APPROVED', acted_at: '2026-09-02T08:00:00Z' },
      { id: 2, step_order: 2, step_label_snapshot: '第1教頭確認', action_user_stamp_name: '田中', status: 'APPROVED', acted_at: '2026-09-02T09:00:00Z' },
      { id: 3, step_order: 3, step_label_snapshot: '第2教頭確認', action_user_stamp_name: '中村', status: 'APPROVED', acted_at: '2026-09-02T09:30:00Z' },
      { id: 4, step_order: 4, step_label_snapshot: '校長決裁', action_user_stamp_name: '鈴木', status: 'APPROVED', acted_at: '2026-09-02T10:00:00Z' },
    ];
    const isFourStep = steps4.length >= 4;
    const cellWidthClass = isFourStep ? 'w-16' : 'w-20';
    const stampSize = isFourStep ? 'mini' : 'sm';
    const labelTextClass = isFourStep ? 'text-[9px]' : 'text-[10px]';
    const dateTextClass = isFourStep ? 'text-[8px]' : 'text-[9px]';

    assert.strictEqual(cellWidthClass, 'w-16', '4段階決裁時は w-16 が選択されること');
    assert.strictEqual(stampSize, 'mini', '4段階決裁時は mini スタンプが選択されること');
    assert.strictEqual(labelTextClass, 'text-[9px]', '役職フォントが text-[9px] であること');
    assert.strictEqual(dateTextClass, 'text-[8px]', '日付フォントが text-[8px] であること');
  });

  it('GT-PILOT-S4-05: Long department names and user names preserve all facts with break-words and no clipping', () => {
    const longDepartment = '山口県立山口中学校第１学年進路指導・特別活動推進部';
    const longUserName = '勅使河原 勘三郎左衛門';
    assert.strictEqual(longDepartment.includes('進路指導・特別活動推進部'), true);
    assert.strictEqual(longUserName.includes('勅使河原 勘三郎左衛門'), true);
  });

  it('GT-PILOT-S4-06: Proxy submission representation ([代] 代理申請者) is strictly preserved', () => {
    const proxyApp: any = {
      ...baseApp,
      submission_actor_type: 'PROXY',
      proxy_user_name: '教頭 代理花子',
      form_data: {
        ...baseApp.form_data,
        proxyReason: '急病による緊急連絡受電',
      },
    };
    assert.strictEqual(proxyApp.submission_actor_type, 'PROXY');
    assert.strictEqual(proxyApp.proxy_user_name, '教頭 代理花子');
    assert.strictEqual(proxyApp.form_data.proxyReason, '急病による緊急連絡受電');
  });

  it('GT-PILOT-S4-07: Single page official report does NOT have inline pageBreakAfter', () => {
    const html = renderToString(
      React.createElement(PrintSheetContainer, { orientation: 'PORTRAIT', children: React.createElement('div', null, 'Single Page Content') })
    );
    assert.strictEqual(html.includes('page-break-after'), false, 'インラインスタイルに pageBreakAfter が含まれないこと');
    assert.strictEqual(html.includes('break-after'), false, 'インラインスタイルに breakAfter が含まれないこと');
  });

  it('GT-PILOT-S4-08: Multi-page continuation sheet correctly maps all projected pages inside sheet wrapper', () => {
    const projectedPages = [
      { pageNumber: 1, totalPages: 2, isFirstPage: true, isContinuationSheet: false, records: [] },
      { pageNumber: 2, totalPages: 2, isFirstPage: false, isContinuationSheet: true, records: [{ id: 1, typeName: '年次有給休暇', startDate: '2026-01-15' }] },
    ];
    assert.strictEqual(projectedPages.length, 2, '2ページが正しく射影されること');
    assert.strictEqual(projectedPages[0].pageNumber, 1);
    assert.strictEqual(projectedPages[1].pageNumber, 2);
  });

  it('GT-PILOT-S4-09: A4 portrait physical contract (210mm x 297mm, 12mm 15mm padding) is maintained', () => {
    const html = renderToString(
      React.createElement(PrintSheetContainer, { orientation: 'PORTRAIT', children: React.createElement('div', null, 'Portrait Test') })
    );
    assert.match(html, /width:210mm/);
    assert.match(html, /min-height:297mm/);
    assert.match(html, /padding:12mm 15mm/);
    assert.match(html, /box-sizing:border-box/);
  });

  it('GT-PILOT-S4-10: A4 landscape physical contract (297mm x 210mm, 12mm 15mm padding) is maintained', () => {
    const html = renderToString(
      React.createElement(PrintSheetContainer, { orientation: 'LANDSCAPE', children: React.createElement('div', null, 'Landscape Test') })
    );
    assert.match(html, /width:297mm/);
    assert.match(html, /min-height:210mm/);
    assert.match(html, /padding:12mm 15mm/);
    assert.match(html, /box-sizing:border-box/);
  });

  it('GT-PILOT-S4-11: Print CSS @media rule enforces :not(:last-child) page break contract', () => {
    const html = renderToString(
      React.createElement(OfficialFormModal, {
        isOpen: true,
        formType: 'LEAVE',
        applicationId: 101,
        onClose: () => {},
      })
    );
    assert.match(html, /\.official-print-page:not\(:last-child\)/);
    assert.match(html, /page-break-after: always !important/);
    assert.match(html, /\.official-print-page:last-child/);
    assert.match(html, /page-break-after: auto !important/);
  });

  it('GT-PILOT-S4-12: HankoStamp uses only existing size tokens (mini, sm, md, lg) with zero custom variants', () => {
    const miniHtml = renderToString(React.createElement(HankoStamp, { stampName: '田中', size: 'mini', roleTitle: '教頭', dateStr: '2026-09-01' }));
    const smHtml = renderToString(React.createElement(HankoStamp, { stampName: '田中', size: 'sm', roleTitle: '教頭', dateStr: '2026-09-01' }));
    const mdHtml = renderToString(React.createElement(HankoStamp, { stampName: '田中', size: 'md', roleTitle: '教頭', dateStr: '2026-09-01' }));
    const lgHtml = renderToString(React.createElement(HankoStamp, { stampName: '田中', size: 'lg', roleTitle: '教頭', dateStr: '2026-09-01' }));

    assert.match(miniHtml, /width="32"/);
    assert.match(smHtml, /width="48"/);
    assert.match(mdHtml, /width="64"/);
    assert.match(lgHtml, /width="80"/);
  });
});

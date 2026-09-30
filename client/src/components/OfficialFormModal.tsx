import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { HankoStamp } from './HankoStamp';
import { PrintSheetContainer } from './PrintSheetContainer';
import { Printer, Download, X, FileText, CheckCircle, AlertTriangle } from 'lucide-react';
import { resolveDisplayClassCoverage } from '../utils/coverageAdapter';

export type FormType = 'LEAVE' | 'TRIP' | 'ATTENDANCE';

interface Props {
  isOpen: boolean;
  formType: FormType;
  applicationId?: number;
  userId?: number;
  yearMonth?: string;
  onClose: () => void;
}

/**
 * 正式公文書帳票 A4 PDF / 印刷モーダル (mm単位固定レイアウト & Server-Authoritative Multi-Page)
 */
export const OfficialFormModal: React.FC<Props> = ({
  isOpen,
  formType,
  applicationId,
  userId,
  yearMonth,
  onClose,
}) => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      setError('');
      if (formType === 'LEAVE' && applicationId) {
        api.getLeaveFormPdfData(applicationId)
          .then((res) => setData(res.data))
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false));
      } else if (formType === 'TRIP' && applicationId) {
        api.getTripFormPdfData(applicationId)
          .then((res) => setData(res.data))
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false));
      } else if (formType === 'ATTENDANCE' && userId && yearMonth) {
        api.getAttendanceFormPdfData(userId, yearMonth)
          .then((res) => setData(res.data))
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false));
      }
    }
  }, [isOpen, formType, applicationId, userId, yearMonth]);

  if (!isOpen) return null;

  const isUnassignedJobTitle =
    formType === 'ATTENDANCE' &&
    (data?.attendanceData?.userJobTitle === '（職名未設定）' || !data?.attendanceData?.userJobTitle);

  const handlePrint = () => {
    if (isUnassignedJobTitle) {
      alert('正式職名が未登録のため、公式帳票の印刷・PDF出力はできません (Fail-Closed)。管理者に職名の人事発令登録を依頼してください。');
      return;
    }
    window.print();
  };

  const isLandscape = formType === 'TRIP';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4 print:p-0 print:bg-white print:static">
      {/* 印刷用CSS定義 (A4寸法固定・等倍100%・改ページ保証) */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #official-form-sheet-wrapper, #official-form-sheet-wrapper * {
            visibility: visible;
          }
          #official-form-sheet-wrapper {
            position: absolute;
            left: 0;
            top: 0;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            box-shadow: none !important;
            border: none !important;
          }
          .official-print-page {
            width: ${isLandscape ? '297mm' : '210mm'} !important;
            height: ${isLandscape ? '210mm' : '297mm'} !important;
            margin: 0 auto !important;
            padding: 12mm 15mm !important;
            box-shadow: none !important;
            border: none !important;
            box-sizing: border-box !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
          .official-print-page:not(:last-child) {
            page-break-after: always !important;
            break-after: page !important;
          }
          .official-print-page:last-child {
            page-break-after: auto !important;
            break-after: auto !important;
          }
          @page {
            size: ${isLandscape ? 'A4 landscape' : 'A4 portrait'};
            margin: 0;
          }
        }
      `}</style>

      <div className="bg-slate-100 rounded-xl shadow-2xl max-w-5xl w-full overflow-hidden flex flex-col max-h-[95vh] print:max-h-none print:shadow-none print:bg-white print:max-w-none print:rounded-none">
        {/* モーダルコントロールヘッダー (印刷時は非表示) */}
        <div className="px-6 py-3.5 bg-slate-800 text-white flex items-center justify-between print:hidden">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-bold">
              公文書帳票 A4 PDF プレビュー・印刷
              {formType === 'LEAVE' && ' (休暇簿)'}
              {formType === 'TRIP' && ' (旅行命令・依頼簿)'}
              {formType === 'ATTENDANCE' && ' (出勤簿)'}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handlePrint}
              disabled={isUnassignedJobTitle}
              title={isUnassignedJobTitle ? '正式職名が未登録のため出力不可' : 'A4印刷 / PDF保存'}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 transition shadow-sm ${
                isUnassignedJobTitle
                  ? 'bg-slate-600 text-slate-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white'
              }`}
            >
              <Printer className="w-4 h-4" />
              <span>A4 印刷 / PDF保存</span>
            </button>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-700 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* プレビュー本体 (スクロール可能 & 複数ページコンテナ対応) */}
        <div className="p-6 overflow-y-auto flex-1 flex flex-col items-center gap-6 bg-slate-200/70 print:p-0 print:bg-white print:gap-0">
          {isUnassignedJobTitle && (
            <div className="w-full max-w-4xl p-3 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 text-xs font-bold flex items-center justify-between shadow-sm print:hidden">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                <div>
                  <div className="font-extrabold text-rose-700">【無効プレビュー: 正式職名未登録】</div>
                  <div>この教職員の対象年月における正式職名の人事発令が未登録です。公文書として印刷・出力することはできません（Fail-Closed）。</div>
                </div>
              </div>
            </div>
          )}
          {loading ? (
            <div className="py-20 text-center text-slate-500 font-medium">帳票データをロード中...</div>
          ) : error ? (
            <div className="py-20 text-center text-red-600 font-medium">エラー: {error}</div>
          ) : data ? (
            <div id="official-form-sheet-wrapper" className="w-full flex flex-col items-center gap-6 print:gap-0">
              {formType === 'LEAVE' && <LeaveFormRenderer data={data} />}
              {formType === 'TRIP' && <TripFormRenderer data={data} />}
              {formType === 'ATTENDANCE' && <AttendanceFormRenderer data={data} />}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/**
 * 1. 休暇簿 レンダラー (A4縦・Server-Authoritative 決定論的ページング対応)
 */
const LeaveFormRenderer: React.FC<{ data: any }> = ({ data }) => {
  const { application: app, steps, leaveSummary, organizationSettings: org, projectedLedger } = data;
  const formData = app.form_data || {};
  const orgSettings = org || {
    schoolName: '公立学校',
    municipalityName: '〇〇市',
  };

  const pages = projectedLedger?.pages || [{
    pageNumber: 1,
    totalPages: 1,
    isFirstPage: true,
    isContinuationSheet: false,
    records: [],
  }];

  const isFourStep = steps && steps.length >= 4;

  return (
    <>
      {pages.map((page: any, pageIdx: number) => {
        return (
          <PrintSheetContainer key={`leave-page-${page.pageNumber || pageIdx + 1}`} orientation="PORTRAIT">
            <div className="space-y-4 text-[13px] leading-tight flex flex-col justify-between h-full">
              <div>
                {/* 帳票表題 */}
                <div className="text-center pb-2">
                  <h1 className="text-2xl font-bold tracking-widest border-b-2 border-black pb-1 inline-block px-8">
                    休 暇 簿 {page.isContinuationSheet && <span className="text-base font-normal">（続紙）</span>}
                  </h1>
                  <p className="text-[11px] text-right mt-1 font-mono">
                    {page.pageNumber} / {page.totalPages} ページ
                  </p>
                </div>

                {/* 所属・氏名・印影欄 */}
                <div className="flex justify-between items-end border border-black p-2">
                  <div className="flex-1 pr-2 break-words">
                    <p><span className="font-bold">所　属：</span>{app.subject_department || orgSettings.schoolName}</p>
                    <p className="mt-1"><span className="font-bold">氏　名：</span><span className="text-base font-bold">{app.subject_user_name}</span></p>
                    <p className="text-[11px] text-slate-600 mt-0.5">（印影氏名：{app.subject_stamp_name || '自筆'}）</p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0 flex-nowrap">
                    {steps && steps.length > 0 ? (
                      steps.map((step: any) => {
                        const label = step.step_label_snapshot || step.step_name || '確認';
                        const shortLabel = label.replace(/確認|決裁|一次|最終/g, '').trim() || label;
                        const isPrincipal = label.includes('校長');
                        const cellWidthClass = isFourStep ? 'w-16' : 'w-20';
                        const stampSize = isFourStep ? 'mini' : 'sm';
                        const labelTextClass = isFourStep ? 'text-[9px]' : 'text-[10px]';
                        const dateTextClass = isFourStep ? 'text-[8px]' : 'text-[9px]';

                        return (
                          <div key={step.id || step.step_order} className={`border border-black ${cellWidthClass} h-24 flex flex-col items-center justify-between p-1 text-center`}>
                            <span className={`${labelTextClass} font-bold border-b border-black w-full pb-0.5 leading-tight`}>{shortLabel}</span>
                            {step.status === 'APPROVED' ? (
                              <HankoStamp
                                stampName={step.action_user_stamp_name || step.approver_name_snapshot || '認'}
                                roleTitle={shortLabel}
                                dateStr={step.acted_at}
                                size={stampSize}
                                variant={isPrincipal ? 'double_circle' : 'circle'}
                              />
                            ) : (
                              <span className="text-[10px] text-slate-400 my-auto">未決</span>
                            )}
                            <span className={`${dateTextClass} text-slate-500`}>{step.acted_at ? step.acted_at.split('T')[0] : ''}</span>
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-[10px] text-slate-400 my-auto">印影情報なし</div>
                    )}
                  </div>
                </div>

                {/* 第1面のみ: 休暇累計・年休残数サマリー表 */}
                {page.isFirstPage && leaveSummary && (
                  <div className="border border-black mt-4">
                    <div className="bg-slate-100 border-b border-black px-2 py-1 font-bold text-[12px]">
                      ■ 休暇取得状況・年休現在残数（基準日数: {leaveSummary.annualLeave.initialDays}日 / 暦年管理）
                    </div>
                    <div className="grid grid-cols-4 divide-x divide-black text-center text-[12px] p-2 bg-white">
                      <div>
                        <p className="text-[11px] text-slate-600">年休既取得</p>
                        <p className="font-bold mt-1">{leaveSummary.annualLeave.used.formatted}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-600 font-bold text-indigo-900">年休現在残数</p>
                        <p className="font-bold text-sm text-indigo-900 mt-1">{leaveSummary.annualLeave.remaining.formatted}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-600">病気休暇累計</p>
                        <p className="font-bold mt-1">{leaveSummary.sickLeave.formatted}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-600">特別休暇累計</p>
                        <p className="font-bold mt-1">{leaveSummary.specialLeave.formatted}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* 第1面のみ: 今回申請明細表 */}
                {page.isFirstPage && (
                  <table className="w-full border-collapse border border-black text-left text-[12px] mt-4">
                    <tbody>
                      <tr className="border-b border-black">
                        <th className="border-r border-black p-2 bg-slate-100 w-28">休暇等の種別</th>
                        <td className="p-2 font-bold">{app.type_name || '年次有給休暇'}</td>
                      </tr>
                      {formData.specialLeaveType && (
                        <tr className="border-b border-black">
                          <th className="border-r border-black p-2 bg-slate-100">特別休暇内訳</th>
                          <td className="p-2">{formData.specialLeaveType}</td>
                        </tr>
                      )}
                      <tr className="border-b border-black">
                        <th className="border-r border-black p-2 bg-slate-100">期　間</th>
                        <td className="p-2">
                          {formData.unitType === 'TIME' ? (
                            <div>
                              <span className="font-bold">{formData.targetDate || formData.startDate}</span>{' '}
                              {formData.startTime} 〜 {formData.endTime} (時間数: {Math.floor((formData.calculatedMinutes || 0)/60)}時間 {(formData.calculatedMinutes || 0)%60}分)
                            </div>
                          ) : (
                            <div>
                              <span className="font-bold">{formData.startDate}</span> 〜 <span className="font-bold">{formData.endDate}</span>{' '}
                              (取得日数: {formData.calculatedDays || 1}日)
                            </div>
                          )}
                        </td>
                      </tr>
                      <tr className="border-b border-black">
                        <th className="border-r border-black p-2 bg-slate-100">事由・理由</th>
                        <td className="p-2 min-h-[40px] whitespace-pre-wrap">{formData.reason || '（私事都合のため）'}</td>
                      </tr>
                      <tr className="border-b border-black">
                        <th className="border-r border-black p-2 bg-slate-100">授業引継ぎ・代替措置</th>
                        <td className="p-2">
                          {(() => {
                            const cov = resolveDisplayClassCoverage(formData);
                            if (cov.status === 'REQUIRED' && cov.items.length > 0) {
                              return (
                                <div className="space-y-1">
                                  <div className="font-bold text-slate-800">{cov.statusLabel}</div>
                                  <div className="text-[11px] text-slate-700 divide-y divide-slate-200">
                                    {cov.items.map((it, idx) => (
                                      <div key={it.id || idx} className="py-0.5">
                                        【{it.targetDate} {it.period}】{it.coverageTypeLabel}：<strong className="text-black">{it.substituteTeacherName}</strong>
                                        {it.subjectName && `（教科:${it.subjectName}）`}
                                        {it.contentNotes && ` ※${it.contentNotes}`}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            }
                            return <span>{cov.summaryText}</span>;
                          })()}
                        </td>
                      </tr>
                      {app.submission_actor_type === 'PROXY' && (
                        <tr className="border-b border-black bg-amber-50/50">
                          <th className="border-r border-black p-2 font-bold text-amber-900">代理申請事項</th>
                          <td className="p-2 text-amber-900">
                            代行操作者: <span className="font-bold">{app.proxy_user_name}</span> (理由: {formData.proxyReason || '本人不在による代理作成'})
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}

                {/* 続紙の場合: 決定論的レコード一覧表 */}
                {page.isContinuationSheet && (
                  <div className="mt-4 border border-black">
                    <table className="w-full border-collapse text-left text-[11px]">
                      <thead>
                        <tr className="bg-slate-100 border-b border-black">
                          <th className="border-r border-black p-1.5 w-10 text-center">番号</th>
                          <th className="border-r border-black p-1.5 w-24">種別</th>
                          <th className="border-r border-black p-1.5 w-32">期間・時間</th>
                          <th className="border-r border-black p-1.5">事由・病名等</th>
                          <th className="p-1.5 w-16 text-center">決裁印</th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.records.map((rec: any, rIdx: number) => (
                          <tr key={rec.id || rIdx} className="border-b border-black last:border-b-0">
                            <td className="border-r border-black p-1 text-center font-mono">{rIdx + 1}</td>
                            <td className="border-r border-black p-1 font-semibold">{rec.typeName}</td>
                            <td className="border-r border-black p-1">
                              <div>{rec.startDate}{rec.endDate && rec.endDate !== rec.startDate ? `〜${rec.endDate}` : ''}</div>
                              {rec.timeSpanFormatted && <div className="text-[10px] text-slate-600">({rec.timeSpanFormatted})</div>}
                            </td>
                            <td className="border-r border-black p-1 whitespace-pre-wrap">{rec.reason || '-'}</td>
                            <td className="p-1 text-center font-bold text-indigo-900">{rec.approverStampName || '認'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* 決裁・監査証跡署名フッター */}
              <div className="pt-4 border-t border-black text-[11px] text-slate-600 flex justify-between">
                <div>
                  <p>申請番号: APP-{app.id} / バージョン: v{app.version}</p>
                  <p>申請確定日時: {app.created_at ? new Date(app.created_at).toLocaleString('ja-JP') : '-'}</p>
                </div>
                <div className="text-right">
                  <p>校内LAN学校業務ワークフロー基盤 (公文書正式帳票出力 / Server-Authoritative)</p>
                  <p>山口県学校職員勤務条例施行規則準拠（暦年管理: 1月1日〜12月31日）</p>
                </div>
              </div>
            </div>
          </PrintSheetContainer>
        );
      })}
    </>
  );
};

/**
 * 2. 旅行命令・復命簿 レンダラー (A4横・Server-Authoritative Multi-Page)
 */
const TripFormRenderer: React.FC<{ data: any }> = ({ data }) => {
  const { application: app, steps, organizationSettings: org, projectedTrip } = data;
  const formData = app.form_data || {};
  const orgSettings = org || {
    schoolName: '公立学校',
    municipalityName: '〇〇市',
  };

  const step1 = steps?.find((s: any) => s.step_order === 1);
  const step2 = steps?.find((s: any) => s.step_order === 2);
  const step3 = steps?.find((s: any) => s.step_order === 3);

  const step4 = steps?.find((s: any) => s.step_order === 4);
  const step5 = steps?.find((s: any) => s.step_order === 5);
  const step6 = steps?.find((s: any) => s.step_order === 6);

  const pages = projectedTrip?.pages || [{
    pageNumber: 1,
    totalPages: 1,
    isFirstPage: true,
    isContinuationSheet: false,
    mainPurpose: formData.reason || app.event_purpose || '公務出張',
    mainReportResult: formData.reportResult || '（復命書未提出）',
  }];

  return (
    <>
      {pages.map((page: any, pageIdx: number) => {
        return (
          <PrintSheetContainer key={`trip-page-${page.pageNumber || pageIdx + 1}`} orientation="LANDSCAPE">
            <div className="space-y-3 text-[12px] leading-tight flex flex-col justify-between h-full">
              <div>
                <div className="flex justify-between items-center border-b-2 border-black pb-1">
                  <h1 className="text-xl font-bold tracking-wider">
                    旅 行 命 令 ・ 依 頼 簿 （ 復 命 書 ） {page.isContinuationSheet && <span className="text-base font-normal">（別紙復命書・続紙）</span>}
                  </h1>
                  <span className="text-[11px] font-mono">{page.pageNumber} / {page.totalPages} ページ</span>
                </div>

                {/* 第1面: 旅行命令 & 復命書メイン枠 */}
                {page.isFirstPage ? (
                  <>
                    {/* 旅行命令欄 */}
                    <div className="border border-black mt-2">
                      <div className="bg-slate-100 border-b border-black px-2 py-1 font-bold text-[12px] flex justify-between items-center">
                        <span>■ １．旅行命令事項（事前申請・発令）</span>
                        <span className="text-[11px] font-normal">旅行者: <strong className="text-sm">{app.subject_user_name}</strong> ({app.subject_department || orgSettings.schoolName})</span>
                      </div>
                      <div className="flex">
                        <table className="w-full border-collapse text-left text-[11px]">
                          <tbody>
                            <tr className="border-b border-black">
                              <th className="border-r border-black p-1.5 bg-slate-50 w-24">旅行期間</th>
                              <td className="p-1.5 border-r border-black font-bold">
                                {formData.startDate} 〜 {formData.endDate} ({formData.calculatedDays || 1}日間)
                              </td>
                              <th className="border-r border-black p-1.5 bg-slate-50 w-20">用務地</th>
                              <td className="p-1.5 font-bold">{formData.destination || app.event_destination}</td>
                            </tr>
                            <tr className="border-b border-black">
                              <th className="border-r border-black p-1.5 bg-slate-50">用務内容</th>
                              <td className="p-1.5 border-r border-black" colSpan={3}>
                                {page.mainPurpose}
                              </td>
                            </tr>
                            <tr>
                              <th className="border-r border-black p-1.5 bg-slate-50">交通機関</th>
                              <td className="p-1.5 border-r border-black">{formData.transport || app.event_transport || '公用車'}</td>
                              <th className="border-r border-black p-1.5 bg-slate-50">授業措置</th>
                              <td className="p-1.5">{resolveDisplayClassCoverage(formData).summaryText}</td>
                            </tr>
                          </tbody>
                        </table>

                        {/* 事前3段階印影欄 */}
                        <div className="flex border-l border-black">
                          <div className="w-16 border-r border-black flex flex-col items-center justify-between p-1 text-center">
                            <span className="text-[10px] font-bold border-b border-black w-full pb-0.5">教　頭</span>
                            {step1?.status === 'APPROVED' ? (
                              <HankoStamp stampName={step1.action_user_stamp_name || '田中'} roleTitle="教頭" dateStr={step1.acted_at} size="mini" />
                            ) : <span className="text-[9px] text-slate-400 my-auto">未決</span>}
                          </div>
                          <div className="w-16 border-r border-black flex flex-col items-center justify-between p-1 text-center">
                            <span className="text-[10px] font-bold border-b border-black w-full pb-0.5">校　長</span>
                            {step2?.status === 'APPROVED' ? (
                              <HankoStamp stampName={step2.action_user_stamp_name || '鈴木'} roleTitle="校長" dateStr={step2.acted_at} size="mini" variant="double_circle" />
                            ) : <span className="text-[9px] text-slate-400 my-auto">未決</span>}
                          </div>
                          <div className="w-16 flex flex-col items-center justify-between p-1 text-center">
                            <span className="text-[10px] font-bold border-b border-black w-full pb-0.5">事務係</span>
                            {step3?.status === 'APPROVED' ? (
                              <HankoStamp stampName={step3.action_user_stamp_name || '事務'} roleTitle="事務" dateStr={step3.acted_at} size="mini" />
                            ) : <span className="text-[9px] text-slate-400 my-auto">未決</span>}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 復命書欄 */}
                    <div className="border border-black mt-2">
                      <div className="bg-slate-100 border-b border-black px-2 py-1 font-bold text-[12px] flex justify-between items-center">
                        <span>■ ２．出張復命書（事後結果・成果報告）</span>
                        <span className="text-[11px] font-normal">復命年月日: <strong>{formData.reportDate || '未提出'}</strong></span>
                      </div>
                      <div className="flex">
                        <div className="flex-1 p-2 min-h-[90px] text-[11px]">
                          <p className="font-bold text-slate-700 mb-1">【研修・出張の結果及び状況】</p>
                          <p className="whitespace-pre-wrap">{page.mainReportResult}</p>
                          {formData.reportRemarks && (
                            <p className="mt-2 text-slate-600">備考: {formData.reportRemarks}</p>
                          )}
                        </div>

                        {/* 復命3段階印影欄 */}
                        <div className="flex border-l border-black">
                          <div className="w-16 border-r border-black flex flex-col items-center justify-between p-1 text-center">
                            <span className="text-[10px] font-bold border-b border-black w-full pb-0.5">復・教頭</span>
                            {step4?.status === 'APPROVED' ? (
                              <HankoStamp stampName={step4.action_user_stamp_name || '田中'} roleTitle="教頭" dateStr={step4.acted_at} size="mini" />
                            ) : <span className="text-[9px] text-slate-400 my-auto">未決</span>}
                          </div>
                          <div className="w-16 border-r border-black flex flex-col items-center justify-between p-1 text-center">
                            <span className="text-[10px] font-bold border-b border-black w-full pb-0.5">復・校長</span>
                            {step5?.status === 'APPROVED' ? (
                              <HankoStamp stampName={step5.action_user_stamp_name || '鈴木'} roleTitle="校長" dateStr={step5.acted_at} size="mini" variant="double_circle" />
                            ) : <span className="text-[9px] text-slate-400 my-auto">未決</span>}
                          </div>
                          <div className="w-16 flex flex-col items-center justify-between p-1 text-center">
                            <span className="text-[10px] font-bold border-b border-black w-full pb-0.5">復・事務</span>
                            {step6?.status === 'APPROVED' ? (
                              <HankoStamp stampName={step6.action_user_stamp_name || '事務'} roleTitle="事務" dateStr={step6.acted_at} size="mini" />
                            ) : <span className="text-[9px] text-slate-400 my-auto">未決</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  /* 続紙面: 長文復命書の決定論的展開 */
                  <div className="border border-black mt-3 p-4 min-h-[140mm]">
                    <div className="border-b border-black pb-2 mb-3 flex justify-between items-center text-[11px]">
                      <span>旅行者: <strong>{app.subject_user_name}</strong> ({app.subject_department || orgSettings.schoolName})</span>
                      <span>用務: <strong>{page.mainPurpose}</strong></span>
                    </div>
                    <div className="text-[12px] leading-relaxed whitespace-pre-wrap">
                      <p className="font-bold text-slate-800 mb-2">【復命内容（続紙）】</p>
                      {page.mainReportResult}
                    </div>
                  </div>
                )}
              </div>

              <div className="text-[10px] text-slate-600 flex justify-between pt-2 border-t border-black">
                <p>申請番号: TRIP-APP-{app.id} / 旅行命令発令確定: {step3?.acted_at ? new Date(step3.acted_at).toLocaleDateString('ja-JP') : '処理中'}</p>
                <p>{orgSettings.municipalityName} {orgSettings.schoolName}（山口県学校職員公文書正式旅行命令様式）</p>
              </div>
            </div>
          </PrintSheetContainer>
        );
      })}
    </>
  );
};

/**
 * 3. 出勤簿 レンダラー (A4縦) - Server-Authoritative
 */
const AttendanceFormRenderer: React.FC<{ data: any }> = ({ data }) => {
  const { user, yearMonth, attendanceData, monthlyApproval, organizationSettings: org } = data;
  const orgSettings = org || {
    schoolName: '公立学校',
    municipalityName: '〇〇市',
  };

  const [year, month] = yearMonth.split('-').map(Number);
  // サーバー判定済みの確定多軸配列 (Single Source of Truth)
  const cells = attendanceData?.days || [];
  const summary = attendanceData?.summary;

  return (
    <PrintSheetContainer orientation="PORTRAIT">
      <div className="space-y-4 text-[12px] leading-tight flex flex-col justify-between h-full">
        <div>
          {/* 表題 */}
          <div className="text-center pb-2">
            <h1 className="text-2xl font-bold tracking-widest border-b-2 border-black pb-1 inline-block px-8">
              出　勤　簿
            </h1>
            <p className="text-[11px] text-right mt-1">
              （{year}年 {month}月度）
            </p>
          </div>

          {/* ヘッダー情報 ＆ 校長確定印 */}
          <div className="flex justify-between items-end border border-black p-2">
            <div>
              <p><span className="font-bold">所　属：</span>{user.department || orgSettings.schoolName}</p>
              <p className="mt-1">
                <span className="font-bold">職名・氏名：</span>
                <span className="text-base font-bold">
                  {attendanceData?.userJobTitle || user?.currentOfficialJobTitle || '（職名未設定）'} {user.displayName}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right text-[11px]">
                <p className="font-bold">校長点検・月次確定押印</p>
                <p className="text-slate-500">{monthlyApproval?.status === 'CONFIRMED' ? `${monthlyApproval.confirmedAt?.split('T')[0]} 確定済` : '点検中'}</p>
              </div>
              <div className="border border-black w-20 h-24 flex flex-col items-center justify-between p-1 text-center">
                <span className="text-[11px] font-bold border-b border-black w-full pb-0.5">校　長</span>
                {monthlyApproval?.status === 'CONFIRMED' ? (
                  <HankoStamp
                    stampName={monthlyApproval.confirmedUserStampName || monthlyApproval.confirmed_by_stamp_name || '鈴木'}
                    roleTitle="校長"
                    dateStr={monthlyApproval.confirmedAt}
                    size="sm"
                    variant="double_circle"
                  />
                ) : (
                  <span className="text-[10px] text-slate-400 my-auto">未確定</span>
                )}
                <span className="text-[9px] text-slate-500">{monthlyApproval?.confirmedAt ? monthlyApproval.confirmedAt.split('T')[0] : ''}</span>
              </div>
            </div>
          </div>

          {/* 1日〜31日 カレンダーマス (16日分割グリッド) */}
          <div className="border border-black mt-4">
            <div
              className="border-b border-black bg-slate-100 text-center font-bold text-[10px] divide-x divide-black"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }}
            >
              {cells.slice(0, 16).map((c: any) => (
                <div key={c.day} className={`p-1 ${c.isWeekend || c.isHoliday ? 'bg-slate-200 text-red-700' : ''}`}>
                  <div>{c.day}</div>
                  <div className="text-[9px]">({c.dayOfWeek})</div>
                </div>
              ))}
            </div>
            <div
              className="border-b-2 border-black text-center text-[11px] divide-x divide-black h-14 items-center"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }}
            >
              {cells.slice(0, 16).map((c: any) => (
                <div key={c.day} className="h-full flex items-center justify-center p-0.5 overflow-hidden">
                  {c.stamps && c.stamps.length > 1 ? (
                    <div className="flex flex-col gap-0.5 items-center w-full">
                      {c.stamps.slice(0, 2).map((st: any, sIdx: number) => (
                        <div key={sIdx} className="flex items-center justify-center gap-0.5 w-full">
                          <span className={`px-0.5 py-0 rounded font-bold text-[8px] leading-tight ${
                            st.text === '年休' ? 'text-indigo-900 border border-indigo-900 bg-indigo-50' :
                            st.text === '出張' ? 'text-emerald-900 border border-emerald-900 bg-emerald-50' :
                            st.text === '研修' ? 'text-teal-900 border border-teal-900 bg-teal-50' :
                            st.text === '代休' ? 'text-purple-900 border border-purple-900 bg-purple-50' :
                            st.text === '勤務日' ? 'text-teal-900 border border-teal-900 bg-teal-50' :
                            st.text === '休日' ? 'text-rose-900 border border-rose-900 bg-rose-50' : 'text-slate-700 border border-slate-400 bg-slate-50'
                          }`}>
                            {st.text}
                          </span>
                          {sIdx === 1 && c.stamps.length > 2 && (
                            <span className="text-[7px] bg-slate-800 text-white rounded-full px-0.5 leading-none font-bold">
                              +{c.stamps.length - 2}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : c.stampText ? (
                    <div className="flex flex-col items-center">
                      <span className={`px-1 py-0.5 rounded font-bold text-[10px] ${
                        c.stampText === '年休' ? 'text-indigo-900 border border-indigo-900 bg-indigo-50' :
                        c.stampText === '出張' ? 'text-emerald-900 border border-emerald-900 bg-emerald-50' :
                        c.stampText === '研修' ? 'text-teal-900 border border-teal-900 bg-teal-50' :
                        c.stampText === '代休' ? 'text-purple-900 border border-purple-900 bg-purple-50' :
                        c.stampText === '勤務日' ? 'text-teal-900 border border-teal-900 bg-teal-50' :
                        c.stampText === '休日' ? 'text-rose-900 border border-rose-900 bg-rose-50' : 'text-slate-500'
                      }`}>
                        {c.stampText}
                      </span>
                      {c.stampSubText && (
                        <span className="text-[8px] text-slate-500 truncate max-w-[45px] leading-tight">
                          {c.stampSubText}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-slate-200">・</span>
                  )}
                </div>
              ))}
            </div>

            <div
              className="border-b border-black bg-slate-100 text-center font-bold text-[10px] divide-x divide-black"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }}
            >
              {cells.slice(16).map((c: any) => (
                <div key={c.day} className={`p-1 ${c.isWeekend || c.isHoliday ? 'bg-slate-200 text-red-700' : ''}`}>
                  <div>{c.day}</div>
                  <div className="text-[9px]">({c.dayOfWeek})</div>
                </div>
              ))}
              {/* 31日に満たない場合の空セル埋め */}
              {Array.from({ length: 16 - cells.slice(16).length }).map((_, i) => (
                <div key={`empty-h-${i}`} className="p-1 bg-slate-100 text-slate-300">-</div>
              ))}
            </div>
            <div
              className="text-center text-[11px] divide-x divide-black h-14 items-center"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }}
            >
              {cells.slice(16).map((c: any) => (
                <div key={c.day} className="h-full flex items-center justify-center p-0.5 overflow-hidden">
                  {c.stamps && c.stamps.length > 1 ? (
                    <div className="flex flex-col gap-0.5 items-center w-full">
                      {c.stamps.slice(0, 2).map((st: any, sIdx: number) => (
                        <div key={sIdx} className="flex items-center justify-center gap-0.5 w-full">
                          <span className={`px-0.5 py-0 rounded font-bold text-[8px] leading-tight ${
                            st.text === '年休' ? 'text-indigo-900 border border-indigo-900 bg-indigo-50' :
                            st.text === '出張' ? 'text-emerald-900 border border-emerald-900 bg-emerald-50' :
                            st.text === '研修' ? 'text-teal-900 border border-teal-900 bg-teal-50' :
                            st.text === '代休' ? 'text-purple-900 border border-purple-900 bg-purple-50' :
                            st.text === '勤務日' ? 'text-teal-900 border border-teal-900 bg-teal-50' :
                            st.text === '休日' ? 'text-rose-900 border border-rose-900 bg-rose-50' : 'text-slate-700 border border-slate-400 bg-slate-50'
                          }`}>
                            {st.text}
                          </span>
                          {sIdx === 1 && c.stamps.length > 2 && (
                            <span className="text-[7px] bg-slate-800 text-white rounded-full px-0.5 leading-none font-bold">
                              +{c.stamps.length - 2}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : c.stampText ? (
                    <div className="flex flex-col items-center">
                      <span className={`px-1 py-0.5 rounded font-bold text-[10px] ${
                        c.stampText === '年休' ? 'text-indigo-900 border border-indigo-900 bg-indigo-50' :
                        c.stampText === '出張' ? 'text-emerald-900 border border-emerald-900 bg-emerald-50' :
                        c.stampText === '研修' ? 'text-teal-900 border border-teal-900 bg-teal-50' :
                        c.stampText === '代休' ? 'text-purple-900 border border-purple-900 bg-purple-50' :
                        c.stampText === '勤務日' ? 'text-teal-900 border border-teal-900 bg-teal-50' :
                        c.stampText === '休日' ? 'text-rose-900 border border-rose-900 bg-rose-50' : 'text-slate-500'
                      }`}>
                        {c.stampText}
                      </span>
                      {c.stampSubText && (
                        <span className="text-[8px] text-slate-500 truncate max-w-[45px] leading-tight">
                          {c.stampSubText}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-slate-200">・</span>
                  )}
                </div>
              ))}
              {Array.from({ length: 16 - cells.slice(16).length }).map((_, i) => (
                <div key={`empty-c-${i}`} className="h-full bg-slate-50" />
              ))}
            </div>
          </div>

          {/* 集計欄 */}
          {summary && (
            <div className="border border-black p-2 bg-slate-50 grid grid-cols-8 gap-1.5 text-center text-[10px] mt-4">
              <div>実働勤務: <strong>{summary.workdayCount}日</strong></div>
              <div>週休: <strong>{summary.weekOffCount}日</strong></div>
              <div>休日・代休: <strong>{summary.holidayCount}日</strong></div>
              <div>年休: <strong>{summary.annualLeave?.formatted || '0分'}</strong></div>
              <div>病休: <strong>{summary.sickLeave?.formatted || '0分'}</strong></div>
              <div>特休・職免: <strong>{summary.specialLeave?.formatted || '0分'}</strong></div>
              <div>欠勤: <strong>{summary.absence?.formatted || '0日'}</strong></div>
              <div>出張: <strong>{summary.businessTripDays}日 ({summary.businessTripCount}回)</strong></div>
            </div>
          )}

          {/* 略号印凡例 */}
          <div className="text-[9px] text-slate-600 flex flex-wrap gap-2.5 p-1.5 bg-slate-50 border border-slate-300 rounded mt-4">
            <span className="font-bold">【略号凡例】</span>
            <span>出: 通常勤務</span>
            <span>勤務日: 振替勤務指定</span>
            <span>週休/休: 週休・指定休</span>
            <span>代休: 休日代休日</span>
            <span>祝/休日: 国民の祝日・学校休日</span>
            <span>年/時年: 年次有給休暇</span>
            <span>病: 病気休暇</span>
            <span>特/産休: 特別休暇</span>
            <span>免: 職務専念義務免除</span>
            <span>出張: 公務旅行</span>
            <span>研修: 教特法第22条研修</span>
            <span>欠: 欠勤</span>
            <span>育/休/停/専: 人事身分状態（育休・休職・停職・専従）</span>
          </div>
        </div>

        <div className="text-[10px] text-slate-500 flex justify-between pt-4 border-t border-black">
          <p>教職員ID: {user.id} / 出勤簿月次確定データ (Single Source of Truth)</p>
          <p>校内LAN学校業務ワークフロー基盤（正式帳票 / Server-Authoritative）</p>
        </div>
      </div>
    </PrintSheetContainer>
  );
};

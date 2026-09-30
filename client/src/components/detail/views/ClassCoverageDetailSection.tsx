import React from 'react';
import { resolveDisplayClassCoverage } from '../../../utils/coverageAdapter';
import { BookOpen, Edit } from 'lucide-react';

export interface ClassCoverageDetailSectionProps {
  formData: Record<string, any>;
  canResolveCoverage?: boolean;
  onOpenCoverageModal?: () => void;
}

/**
 * ClassCoverageDetailSection
 * 
 * GAP-09: 授業引継ぎ・代替措置・自習監督の明細テーブル表示および
 * Contextual Action（確定・変更導線: HD-C-02）を提供する。
 * 
 * 【Architecture Invariant】
 * 1. HD-C-02 Compliant: 承認者が授業措置を確認する文脈（セクション内ヘッダー）に確定ボタンを配置。
 * 2. Pure Presentation Capability: 認可判定は Step 1B（canResolveCoverage）を受け取り、内部で独自再計算しない。
 * 3. Structured Table View: 代替授業・自習監督・時間割交換等の明細をテーブル表示。
 */
export const ClassCoverageDetailSection: React.FC<ClassCoverageDetailSectionProps> = ({
  formData,
  canResolveCoverage = false,
  onOpenCoverageModal,
}) => {
  const coverage = resolveDisplayClassCoverage(formData);

  return (
    <div className="border border-indigo-200 rounded-xl overflow-hidden bg-white shadow-xs">
      <div className="bg-indigo-50/80 border-b border-indigo-200 px-4 py-2.5 font-bold text-indigo-950 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-indigo-700" />
          <span>授業引継ぎ・代替措置・自習監督</span>
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
              coverage.status === 'REQUIRED'
                ? 'bg-amber-100 text-amber-800 border border-amber-300'
                : coverage.status === 'UNSURE'
                ? 'bg-blue-100 text-blue-800 border border-blue-300'
                : 'bg-slate-100 text-slate-700 border border-slate-300'
            }`}
          >
            {coverage.statusLabel}
          </span>
        </div>

        {/* GAP-09 Contextual Action (HD-C-02: 承認権限者のみ表示) */}
        {canResolveCoverage && onOpenCoverageModal && (
          <button
            type="button"
            onClick={onOpenCoverageModal}
            className="px-2.5 py-1 bg-white border border-indigo-300 hover:bg-indigo-50 text-indigo-700 rounded-md text-xs font-semibold flex items-center gap-1 shadow-xs transition"
          >
            <Edit className="w-3.5 h-3.5" />
            <span>引継ぎ措置を確定・変更</span>
          </button>
        )}
      </div>

      <div className="p-4 space-y-3">
        {coverage.status === 'REQUIRED' && coverage.items.length > 0 ? (
          <div className="border border-indigo-200 rounded-lg overflow-hidden bg-white shadow-xs">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-indigo-100/60 border-b border-indigo-200 text-indigo-950 font-semibold">
                  <th className="p-2 w-28">対象日</th>
                  <th className="p-2 w-16">校時</th>
                  <th className="p-2 w-36">措置種別</th>
                  <th className="p-2 w-36">担当教員</th>
                  <th className="p-2 w-24">教科</th>
                  <th className="p-2">内容・備考</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {coverage.items.map((it, idx) => (
                  <tr key={it.id || idx} className="hover:bg-slate-50/80">
                    <td className="p-2 font-mono text-slate-700">{it.targetDate}</td>
                    <td className="p-2 font-bold text-slate-800">{it.period}</td>
                    <td className="p-2">
                      <span className="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[11px] font-medium">
                        {it.coverageTypeLabel}
                      </span>
                    </td>
                    <td className="p-2">
                      <strong className="text-slate-900">{it.substituteTeacherName}</strong>
                      {it.substituteTeacherDept && (
                        <span className="text-[10px] text-slate-500 block">{it.substituteTeacherDept}</span>
                      )}
                    </td>
                    <td className="p-2 text-slate-700">{it.subjectName || '-'}</td>
                    <td className="p-2 text-slate-700 whitespace-pre-wrap">{it.contentNotes || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : coverage.status === 'NOT_REQUIRED' ? (
          <div className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            {coverage.notRequiredReason ? `措置不要理由: ${coverage.notRequiredReason}` : '担当授業なし等のため措置不要'}
          </div>
        ) : coverage.status === 'UNSURE' ? (
          <div className="text-xs text-amber-800 bg-amber-50 p-2.5 rounded-lg border border-amber-200">
            ⚠️ 授業引継ぎ・代替措置の要否を確認中です。最終決裁までに要否を確定させてください。
          </div>
        ) : (
          <div className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            {coverage.summaryText}
          </div>
        )}
      </div>
    </div>
  );
};

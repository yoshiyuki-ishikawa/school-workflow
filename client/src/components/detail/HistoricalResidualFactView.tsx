import React from 'react';
import { Archive, AlertTriangle } from 'lucide-react';

export interface HistoricalResidualFactViewProps {
  residuals: { key: string; value: any }[];
  isSchemaMissing?: boolean;
}

/**
 * HistoricalResidualFactView
 * 
 * Schema によって消費されず、かつ技術メタデータでもない真の残存 Fact（CLASS D: 過去バージョン・移行残存データ）を
 * 一切破棄（Silent Drop）せず、安全に Read-Only 表示するコンポーネント。
 * 
 * 【Architecture Invariant】
 * 1. SILENT DROP = 0: 未知のキーもすべてテーブル形式で閲覧可能。
 * 2. Nested Safe Rendering: object / array でも [object Object] にせず可読フォーマット。
 * 3. Read Preservation: Schema が取得できなかった場合でも全データを安全に表示。
 * 4. Technical Metadata Free: schemaSnapshot などの内部技術エビデンスは本コンポーネントに流入しない。
 */
export const HistoricalResidualFactView: React.FC<HistoricalResidualFactViewProps> = ({
  residuals,
  isSchemaMissing = false,
}) => {
  if (!residuals || residuals.length === 0) {
    return null;
  }

  const formatValue = (val: any): React.ReactNode => {
    if (val === null || val === undefined) {
      return <span className="text-slate-400 italic">null</span>;
    }
    if (typeof val === 'boolean') {
      return (
        <span className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${val ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
          {val ? 'true' : 'false'}
        </span>
      );
    }
    if (typeof val === 'number') {
      return <span className="font-mono font-bold text-slate-800">{val.toLocaleString()}</span>;
    }
    if (typeof val === 'string') {
      return <span className="text-slate-900 whitespace-pre-wrap">{val}</span>;
    }
    if (Array.isArray(val)) {
      return (
        <div className="space-y-1">
          <span className="text-[10px] text-slate-500 font-mono">Array ({val.length}件):</span>
          <pre className="text-[11px] font-mono bg-slate-50 p-1.5 rounded border border-slate-200 overflow-x-auto max-h-32">
            {JSON.stringify(val, null, 2)}
          </pre>
        </div>
      );
    }
    if (typeof val === 'object') {
      return (
        <pre className="text-[11px] font-mono bg-slate-50 p-1.5 rounded border border-slate-200 overflow-x-auto max-h-32">
          {JSON.stringify(val, null, 2)}
        </pre>
      );
    }
    return String(val);
  };

  return (
    <div className={`p-4 rounded-xl border space-y-3 ${
      isSchemaMissing
        ? 'bg-amber-50/70 border-amber-300'
        : 'bg-slate-50/80 border-slate-200'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isSchemaMissing ? (
            <AlertTriangle className="w-4 h-4 text-amber-600" />
          ) : (
            <Archive className="w-4 h-4 text-slate-500" />
          )}
          <h4 className="text-xs font-bold text-slate-800">
            {isSchemaMissing
              ? '【保存情報（Raw Data）】スキーマ未定義のため全保存データを表示しています'
              : '【過去・拡張項目】スキーマ定義外の保存済み情報 (Historical Residual Facts)'}
          </h4>
        </div>
        <span className="text-[11px] px-2 py-0.5 rounded bg-white text-slate-600 border border-slate-200 font-mono">
          {residuals.length} 項目
        </span>
      </div>

      <p className="text-[11px] text-slate-500">
        ※ 申請時に保存されたデータのうち、現在の表示スキーマに含まれない項目です（データの欠落を防ぐため保存値をそのまま表示しています）。
      </p>

      <div className="border border-slate-200 rounded-lg overflow-hidden bg-white shadow-xs">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-slate-100/80 border-b border-slate-200 text-slate-700 font-semibold">
              <th className="p-2 w-1/3 font-mono">項目キー (Key)</th>
              <th className="p-2">保存値 (Persisted Value)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {residuals.map(({ key, value }) => (
              <tr key={key} className="hover:bg-slate-50/80">
                <td className="p-2 font-mono text-slate-700 align-top font-semibold">
                  {key}
                </td>
                <td className="p-2 text-slate-900 align-top">
                  {formatValue(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

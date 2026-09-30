import React from 'react';
import { FormFieldDefinition } from '../../types/formSchema';
import { AlertCircle, HelpCircle } from 'lucide-react';

export interface GenericFieldViewProps {
  field: FormFieldDefinition;
  value: any;
  hasConflict?: boolean;
  conflictingKeys?: { key: string; value: any }[];
  isAlias?: boolean;
  sourceKey?: string;
}

/**
 * GenericFieldView
 * 
 * Schema Field Definition と保存済み Fact を照合し、型安全に Read-Only 表示する。
 * 
 * 【Architecture Invariant】
 * 1. Read-Only Pure Presentation: 編集・状態変更・バリデーションを行わない。
 * 2. Unknown Field Type = Safe Fallback: 未知の型でもクラッシュせず安全に文字列/JSON表示。
 * 3. Null / Undefined / Empty: 「（未設定）」または「（記載なし）」を明示。
 * 4. Alias / Conflict Indicator: エイリアス解決やコンフリクト発生時は警告バッジを表示。
 */
export const GenericFieldView: React.FC<GenericFieldViewProps> = ({
  field,
  value,
  hasConflict,
  conflictingKeys,
  isAlias,
  sourceKey,
}) => {
  const renderFormattedValue = () => {
    if (value === null || value === undefined || value === '') {
      return <span className="text-slate-400 font-normal italic">（未設定）</span>;
    }

    switch (field.type) {
      case 'TEXT':
        return <span className="font-medium text-slate-900">{String(value)}</span>;

      case 'TEXTAREA':
        return (
          <p className="font-medium text-slate-800 whitespace-pre-wrap leading-relaxed text-xs sm:text-sm">
            {String(value)}
          </p>
        );

      case 'NUMBER':
        return <span className="font-mono font-bold text-slate-900">{Number(value).toLocaleString()}</span>;

      case 'DATE':
        return <span className="font-mono font-medium text-slate-900">{String(value)}</span>;

      case 'TIME':
        return <span className="font-mono font-medium text-slate-900">{String(value)}</span>;

      case 'DATETIME':
        return (
          <span className="font-mono font-medium text-slate-900">
            {String(value).replace('T', ' ')}
          </span>
        );

      case 'SELECT':
      case 'RADIO': {
        const option = field.options?.find((opt) => String(opt.value) === String(value));
        const label = option ? option.label : String(value);
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold bg-slate-100 text-slate-800 border border-slate-200">
            {label}
          </span>
        );
      }

      case 'CHECKBOX':
      case 'BOOLEAN': {
        const isChecked = Boolean(value);
        return (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
              isChecked
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-300'
                : 'bg-slate-100 text-slate-600 border border-slate-200'
            }`}
          >
            {isChecked ? 'はい（該当）' : 'いいえ（非該当）'}
          </span>
        );
      }

      case 'USER_SELECT':
        return <span className="font-medium text-slate-900">{String(value)}</span>;

      case 'ATTACHMENT':
        return <span className="font-mono text-xs text-indigo-600">{String(value)}</span>;

      case 'ARRAY':
        if (Array.isArray(value)) {
          return (
            <ul className="list-disc list-inside space-y-0.5 text-xs text-slate-800">
              {value.map((item, idx) => (
                <li key={idx}>
                  {typeof item === 'object' ? JSON.stringify(item) : String(item)}
                </li>
              ))}
            </ul>
          );
        }
        return <span className="text-slate-700">{JSON.stringify(value)}</span>;

      default:
        // 未知の型 (Unknown Field Type) -> 安全なフォールバック表示 (Fact Loss = 0)
        return (
          <div className="flex items-center gap-1.5 text-amber-800 bg-amber-50 px-2 py-1 rounded border border-amber-200 text-xs">
            <HelpCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            <span>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
            <span className="text-[10px] text-amber-600 font-mono">({field.type})</span>
          </div>
        );
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-slate-600">{field.label || field.name}</span>
        {isAlias && (
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-500 border border-slate-200 font-mono" title={`旧項目名 '${sourceKey}' より解決`}>
            旧キー: {sourceKey}
          </span>
        )}
      </div>

      <div className="text-sm">{renderFormattedValue()}</div>

      {hasConflict && conflictingKeys && conflictingKeys.length > 0 && (
        <div className="mt-1 p-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800 space-y-1">
          <div className="flex items-center gap-1 font-bold">
            <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
            <span>項目キーの値に不一致（競合）が検出されました</span>
          </div>
          <ul className="list-disc list-inside text-[11px] font-mono space-y-0.5 pl-1">
            {conflictingKeys.map((ck, idx) => (
              <li key={idx}>
                {ck.key}: {typeof ck.value === 'object' ? JSON.stringify(ck.value) : String(ck.value)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

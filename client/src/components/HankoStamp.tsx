import React from 'react';

export interface HankoStampProps {
  stampName: string; // 例: "田中", "鈴木", "長谷川"
  roleTitle?: string; // 例: "教頭", "校長", "事務", "確認", "決裁"
  dateStr?: string; // 例: "2026-08-29", "2026.08.29"
  size?: 'sm' | 'md' | 'lg' | 'mini'; // サイズ
  variant?: 'circle' | 'abbr' | 'double_circle'; // 円形認印 / 出勤簿略号印 / 二重円決裁印
  className?: string;
}

/**
 * 決定論的電子認印コンポーネント (Deterministic Hanko Stamp)
 * サーバー側承認記録（Approval Record）の視覚的表現。
 * ランダム要素を排し、同一データから常に同一のSVG印影を出力。
 */
export const HankoStamp: React.FC<HankoStampProps> = ({
  stampName,
  roleTitle,
  dateStr,
  size = 'md',
  variant = 'circle',
  className = '',
}) => {
  // 日付のフォーマット (例: 2026.08.29 または 08.29)
  const formattedDate = React.useMemo(() => {
    if (!dateStr) return '';
    const clean = dateStr.split('T')[0].replace(/-/g, '.');
    return clean;
  }, [dateStr]);

  // 印影名のトリム
  const displayName = (stampName || '印').slice(0, 4);

  // サイズ定義
  const dimension = {
    mini: { width: 32, height: 32, fontSize: 10 },
    sm: { width: 48, height: 48, fontSize: 12 },
    md: { width: 64, height: 64, fontSize: 14 },
    lg: { width: 80, height: 80, fontSize: 18 },
  }[size];

  const color = '#c53030'; // 朱肉色 (Crimson Red)

  // 略号印（出勤簿用四角・丸ミニスタンプ）
  if (variant === 'abbr') {
    return (
      <div
        className={`inline-flex items-center justify-center font-bold border-2 rounded ${className}`}
        style={{
          width: `${dimension.width}px`,
          height: `${dimension.height}px`,
          borderColor: color,
          color: color,
          fontSize: `${dimension.fontSize}px`,
          fontFamily: "'Hiragino Mincho ProN', 'Yu Mincho', 'IPAexMincho', serif",
          backgroundColor: '#fff5f5',
        }}
      >
        {displayName}
      </div>
    );
  }

  // 二重線または単線円形認印 (SVG)
  const isDouble = variant === 'double_circle';
  const radius = dimension.width / 2;
  const strokeWidth = size === 'lg' ? 2.5 : size === 'sm' ? 1.5 : 2;

  return (
    <div
      className={`inline-block select-none ${className}`}
      style={{
        width: `${dimension.width}px`,
        height: `${dimension.height}px`,
      }}
      title={`電子認印: ${displayName} (${roleTitle || '承認'}) ${formattedDate}`}
    >
      <svg
        viewBox="0 0 100 100"
        width={dimension.width}
        height={dimension.height}
        className="w-full h-full"
      >
        {/* 外枠円 */}
        <circle
          cx="50"
          cy="50"
          r="46"
          fill="#fffaf8"
          stroke={color}
          strokeWidth={strokeWidth * 1.8}
        />

        {/* 二重枠の場合の内側円 */}
        {isDouble && (
          <circle
            cx="50"
            cy="50"
            r="40"
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
          />
        )}

        {/* 上部区切り線＆役職名 */}
        {roleTitle && (
          <>
            <line x1="16" y1="32" x2="84" y2="32" stroke={color} strokeWidth="1.5" />
            <text
              x="50"
              y="25"
              textAnchor="middle"
              fill={color}
              fontSize="12"
              fontWeight="bold"
              fontFamily="'Hiragino Mincho ProN', 'Yu Mincho', 'IPAexMincho', serif"
            >
              {roleTitle}
            </text>
          </>
        )}

        {/* 中央: 名字 (1文字〜4文字でサイズ・配置を微調整) */}
        <text
          x="50"
          y={roleTitle && formattedDate ? '56' : roleTitle ? '62' : formattedDate ? '48' : '58'}
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontSize={displayName.length >= 3 ? '22' : '28'}
          fontWeight="bold"
          letterSpacing={displayName.length === 2 ? '4' : '1'}
          fontFamily="'Hiragino Mincho ProN', 'Yu Mincho', 'IPAexMincho', serif"
        >
          {displayName}
        </text>

        {/* 下部区切り線＆日付 */}
        {formattedDate && (
          <>
            <line x1="16" y1="72" x2="84" y2="72" stroke={color} strokeWidth="1.5" />
            <text
              x="50"
              y="85"
              textAnchor="middle"
              fill={color}
              fontSize="10"
              fontWeight="600"
              fontFamily="'Courier New', Courier, monospace"
            >
              {formattedDate}
            </text>
          </>
        )}
      </svg>
    </div>
  );
};

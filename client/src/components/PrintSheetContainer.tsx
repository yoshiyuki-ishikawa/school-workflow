import React from 'react';

export interface PrintSheetContainerProps {
  orientation?: 'PORTRAIT' | 'LANDSCAPE';
  children: React.ReactNode;
}

/**
 * A4 印刷・プレビュー用標準ページコンテナ
 * 
 * Invariants:
 * - INV-W4-04: Browser Print / Save as PDF Production Authority
 * - INV-W4-05: Page Scale & Zoom Prohibition (transform: scale / zoom の完全排除)
 * - INV-W4-10: CSS Print Dimensions Invariant (210mm×297mm / 297mm×210mm 等倍)
 */
export const PrintSheetContainer: React.FC<PrintSheetContainerProps> = ({
  orientation = 'PORTRAIT',
  children,
}) => {
  const isLandscape = orientation === 'LANDSCAPE';
  const widthMm = isLandscape ? '297mm' : '210mm';
  const minHeightMm = isLandscape ? '210mm' : '297mm';

  return (
    <div
      className="official-print-page bg-white text-black shadow-lg mx-auto print:shadow-none print:m-0 print:p-0"
      style={{
        width: widthMm,
        minHeight: minHeightMm,
        padding: '12mm 15mm',
        boxSizing: 'border-box',
        fontFamily: "'Hiragino Mincho ProN', 'Yu Mincho', 'IPAexMincho', 'MS Mincho', serif",
      }}
    >
      {children}
    </div>
  );
};

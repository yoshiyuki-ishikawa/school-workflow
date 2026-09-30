import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adminAuditPagePath = path.resolve(__dirname, '../pages/AdminAuditPage.tsx');

describe('Work Pattern Modal Viewport Safety Golden Suite (GT-WPMS-01 〜 GT-WPMS-02)', () => {
  const getWorkPatternModalClasses = () => {
    const src = fs.readFileSync(adminAuditPagePath, 'utf-8');
    
    // isPatternModalOpen && selectedUserForPattern モーダルのブロックを正確に特定
    const modalBlockMatch = src.match(
      /\{\s*isPatternModalOpen\s*&&\s*selectedUserForPattern\s*&&\s*\(\s*<div\s+className="([^"]+)"[\s\S]*?<div\s+className="([^"]+)"/
    );

    assert.ok(
      modalBlockMatch,
      'isPatternModalOpen && selectedUserForPattern modal block (Overlay & Panel) must exist in AdminAuditPage.tsx'
    );

    return {
      overlayClass: modalBlockMatch[1],
      panelClass: modalBlockMatch[2],
    };
  };

  // GT-WPMS-01: Viewport Height Constraint
  it('GT-WPMS-01: Work Pattern Modal Panel に Viewport 最大高さ制約 (max-h-[90vh]) が存在すること', () => {
    const { panelClass } = getWorkPatternModalClasses();

    assert.ok(
      panelClass.includes('max-h-[90vh]'),
      `Work Pattern Modal Panel must have 'max-h-[90vh]' to prevent viewport overflow. Found: "${panelClass}"`
    );
  });

  // GT-WPMS-02: Single Vertical Scroll Authority
  it('GT-WPMS-02: Work Pattern Modal Panel に単一の垂直スクロール権限 (overflow-y-auto) が存在し、Overlay 側の overflow-y-auto および Panel の my-8 が完全に除去されていること', () => {
    const { overlayClass, panelClass } = getWorkPatternModalClasses();

    // 1. Panel に overflow-y-auto が存在すること (Scroll Authority 一元化)
    assert.ok(
      panelClass.includes('overflow-y-auto'),
      `Work Pattern Modal Panel must have 'overflow-y-auto' for internal scrolling. Found: "${panelClass}"`
    );

    // 2. Overlay 側に overflow-y-auto が存在しないこと (二重スクロール・負方向クリッピングの根絶)
    assert.ok(
      !overlayClass.includes('overflow-y-auto'),
      `Work Pattern Modal Overlay must NOT have 'overflow-y-auto' (single scroll authority on Panel). Found: "${overlayClass}"`
    );

    // 3. Panel に my-8 が存在しないこと (90vh + 64px の外寸超過リスク排除)
    assert.ok(
      !panelClass.includes('my-8'),
      `Work Pattern Modal Panel must NOT have 'my-8' to guarantee outer dimensions remain within viewport. Found: "${panelClass}"`
    );
  });
});

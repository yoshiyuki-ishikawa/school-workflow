import { describe, it } from 'node:test';
import assert from 'node:assert';
import { api } from './services/api.js';

describe('NEW-GAP-03: Client API Contract Tests (CL-PREVIEW-01)', () => {
    it('CL-PREVIEW-01: previewLeaveCalculation properly constructs request parameters with startDate and endDate', async () => {
        const originalFetch = globalThis.fetch;
        let capturedUrl = '';
        let capturedOptions: any = null;

        try {
            globalThis.fetch = (async (url: string, options: any) => {
                capturedUrl = url;
                capturedOptions = options;
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({
                        success: true,
                        calculation: {
                            isValid: true,
                            chargeableDaysCount: 2,
                            totalChargedDays: 2,
                            skippedNonWorkingDaysCount: 2,
                            currentRemainingDays: 20,
                            simulatedRemainingText: '残 18日',
                            perDayResults: []
                        }
                    })
                } as any;
            }) as any;

            const res = await api.previewLeaveCalculation({
                typeId: 'LEAVE_ANNUAL',
                subjectUserId: 3,
                startDate: '2026-06-05',
                endDate: '2026-06-08',
                unitType: 'DAY'
            });

            assert.strictEqual(capturedUrl, '/api/applications/preview-calculation');
            assert.strictEqual(capturedOptions?.method, 'POST');
            assert.strictEqual(capturedOptions?.headers?.['Content-Type'], 'application/json');

            const body = JSON.parse(capturedOptions?.body);
            assert.strictEqual(body.typeId, 'LEAVE_ANNUAL');
            assert.strictEqual(body.subjectUserId, 3);
            assert.strictEqual(body.startDate, '2026-06-05');
            assert.strictEqual(body.endDate, '2026-06-08');
            assert.strictEqual(body.unitType, 'DAY');

            assert.strictEqual(res.success, true);
            assert.strictEqual(res.calculation.totalChargedDays, 2);
            assert.strictEqual(res.calculation.skippedNonWorkingDaysCount, 2);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

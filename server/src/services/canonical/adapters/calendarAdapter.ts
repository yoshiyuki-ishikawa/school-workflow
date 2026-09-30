import { CanonicalServiceFact } from '../types';
import { generateCanonicalFactIdentity } from '../identity';
import { getSystemJapaneseHolidayName, getSystemYearEndNewYearHolidayName } from '../../../utils/attendanceEngine';

export interface CustomHolidayRecord {
  id: number;
  holiday_date: string;
  name: string;
  holiday_type: 'NATIONAL_LEGAL_OVERRIDE' | 'SCHOOL_HOLIDAY' | 'MUNICIPALITY_HOLIDAY';
  is_active: number;
}

/**
 * Calendar Pure Normalizer
 */
export function normalizeCalendarToFact(
  userId: number,
  targetDate: string,
  customHolidays?: CustomHolidayRecord[]
): CanonicalServiceFact | null {
  // 1. custom_holidays テーブルのオーバーライドを最優先確認
  if (customHolidays && customHolidays.length > 0) {
    const custom = customHolidays.find(h => h.holiday_date === targetDate);
    if (custom) {
      if (custom.is_active === 0) {
        return null; // 非アクティブ化された休日は除外
      }
      const factId = generateCanonicalFactIdentity({
        sourceType: 'CALENDAR',
        sourceTable: 'custom_holidays',
        sourceId: custom.id,
        sourceVersion: null,
        workflowCycleId: null,
        targetDate,
        startTime: null,
        endTime: null,
        canonicalStatus: 'HOLIDAY'
      });

      return {
        factId,
        userId,
        canonicalStatus: 'HOLIDAY',
        factType: 'CALENDAR_STATUS',
        sourceType: 'CALENDAR',
        sourceTable: 'custom_holidays',
        sourceId: custom.id,
        targetDate,
        isRestricted: false,
        details: {
          holidayName: custom.name,
          holidayType: custom.holiday_type
        }
      };
    }
  }

  // 2. システム祝日 (国民の祝日法)
  const systemHoliday = getSystemJapaneseHolidayName(targetDate);
  if (systemHoliday) {
    const factId = generateCanonicalFactIdentity({
      sourceType: 'CALENDAR',
      sourceTable: 'custom_holidays',
      sourceId: `SYSTEM_HOLIDAY_${targetDate}`,
      sourceVersion: null,
      workflowCycleId: null,
      targetDate,
      startTime: null,
      endTime: null,
      canonicalStatus: 'HOLIDAY'
    });

    return {
      factId,
      userId,
      canonicalStatus: 'HOLIDAY',
      factType: 'CALENDAR_STATUS',
      sourceType: 'CALENDAR',
      sourceTable: 'custom_holidays',
      sourceId: `SYSTEM_HOLIDAY_${targetDate}`,
      targetDate,
      isRestricted: false,
      details: {
        holidayName: systemHoliday,
        holidayType: 'NATIONAL_HOLIDAY'
      }
    };
  }

  // 3. 年末年始
  const yearEndHoliday = getSystemYearEndNewYearHolidayName(targetDate);
  if (yearEndHoliday) {
    const factId = generateCanonicalFactIdentity({
      sourceType: 'CALENDAR',
      sourceTable: 'custom_holidays',
      sourceId: `YEAR_END_HOLIDAY_${targetDate}`,
      sourceVersion: null,
      workflowCycleId: null,
      targetDate,
      startTime: null,
      endTime: null,
      canonicalStatus: 'HOLIDAY'
    });

    return {
      factId,
      userId,
      canonicalStatus: 'HOLIDAY',
      factType: 'CALENDAR_STATUS',
      sourceType: 'CALENDAR',
      sourceTable: 'custom_holidays',
      sourceId: `YEAR_END_HOLIDAY_${targetDate}`,
      targetDate,
      isRestricted: false,
      details: {
        holidayName: yearEndHoliday,
        holidayType: 'YEAR_END_NEW_YEAR'
      }
    };
  }

  return null;
}

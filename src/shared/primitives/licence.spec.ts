import { DRUG_SCHEDULES, FOOD_CATEGORIES } from './goods-type';
import {
  KINDS_REQUIRING_VALID_UNTIL,
  LICENCE_KINDS,
  LICENCE_NEEDS,
  NEED_COVERED_BY,
  SCHEDULE_NEED,
  clientLicenceCovers,
  daysLeftOf,
  expiryStateOf,
  licenceFamily,
  licenceNumberProblem,
  licenceValidOn,
  needsOf,
  normalizeLicenceNumber,
  siteLicenceCovers,
  warningState,
  type LicenceFacts,
} from './licence';

/** Story 1-6c — the licence rule set, pinned rule by rule (decisions 1, 2, 3, 6, 7). */
describe('licence primitive (story 1-6c)', () => {
  const C = 'client-c';
  const W1 = 'site-w1';
  const W2 = 'site-w2';
  const TODAY = '2026-11-01';

  function licence(extra: Partial<LicenceFacts>): LicenceFacts {
    return {
      clientId: null,
      warehouseId: W1,
      kind: 'fssai-state',
      status: 'active',
      validFrom: null,
      validUntil: '2027-03-31',
      ...extra,
    };
  }

  describe('needs (decision 1)', () => {
    it.each([
      ['G', 'drug-20b'],
      ['H', 'drug-20b'],
      ['H1', 'drug-20b'],
      ['C', 'drug-21b'],
      ['C1', 'drug-21b'],
      ['X', 'drug-20g'],
      ['NDPS', 'ndps'],
    ])('schedule %s needs %s', (schedule, need) => {
      expect(needsOf({ foodCategory: null, drugSchedules: [schedule] })).toEqual([need]);
    });

    it('every drug schedule raises a need (none is silently uncovered)', () => {
      expect(DRUG_SCHEDULES.filter((schedule) => SCHEDULE_NEED[schedule] === undefined)).toEqual([]);
    });

    it('a multi-schedule SKU needs one licence per family, each once, in vocabulary order', () => {
      expect(needsOf({ foodCategory: null, drugSchedules: ['NDPS', 'H'] })).toEqual(['drug-20b', 'ndps']);
      expect(needsOf({ foodCategory: null, drugSchedules: ['H', 'H1', 'G'] })).toEqual(['drug-20b']);
      expect(needsOf({ foodCategory: 'dairy', drugSchedules: ['X', 'C1'] })).toEqual(['drug-21b', 'drug-20g', 'fssai']);
    });

    it('every food category but non-food needs fssai; non-food and unset need nothing', () => {
      for (const category of FOOD_CATEGORIES) {
        expect(needsOf({ foodCategory: category, drugSchedules: [] })).toEqual(category === 'non-food' ? [] : ['fssai']);
      }
      expect(needsOf({ foodCategory: null, drugSchedules: [] })).toEqual([]);
    });

    it('every need is covered by at least one kind, and every kind covers exactly one need', () => {
      for (const need of LICENCE_NEEDS) expect(NEED_COVERED_BY[need].length).toBeGreaterThan(0);
      for (const kind of LICENCE_KINDS) {
        expect(LICENCE_NEEDS.filter((need) => NEED_COVERED_BY[need].includes(kind))).toHaveLength(1);
      }
      expect(NEED_COVERED_BY.fssai).toEqual(['fssai-registration', 'fssai-state', 'fssai-central']);
    });
  });

  describe('numbers (decision 7)', () => {
    it('normalises: trimmed, spaces collapsed, upper-cased', () => {
      expect(normalizeLicenceNumber('  mh/pun/20b  12 ')).toBe('MH/PUN/20B 12');
      expect(normalizeLicenceNumber('a\t b')).toBe('A B');
    });

    it('FSSAI: 14 digits with the prefix per kind', () => {
      expect(licenceNumberProblem('fssai-state', '10012345678901')).toBeNull();
      expect(licenceNumberProblem('fssai-central', '10012345678901')).toBeNull();
      expect(licenceNumberProblem('fssai-registration', '20012345678901')).toBeNull();
      expect(licenceNumberProblem('fssai-registration', '10012345678901')).toContain('starts with 2');
      expect(licenceNumberProblem('fssai-state', '20012345678901')).toContain('starts with 1');
      expect(licenceNumberProblem('fssai-central', '20012345678901')).toContain('starts with 1');
      expect(licenceNumberProblem('fssai-state', '1001234567890')).toContain('14 digits');
      expect(licenceNumberProblem('fssai-state', '100123456789012')).toContain('14 digits');
      expect(licenceNumberProblem('fssai-state', '1001234567890A')).toContain('14 digits');
    });

    it('drug and NDPS: 1–50 of A–Z 0–9 space / . -', () => {
      for (const kind of ['drug-20b', 'drug-21b', 'drug-20g', 'ndps'] as const) {
        expect(licenceNumberProblem(kind, 'MH/PUN/20B 12')).toBeNull();
        expect(licenceNumberProblem(kind, 'A')).toBeNull();
        expect(licenceNumberProblem(kind, 'A'.repeat(50))).toBeNull();
        expect(licenceNumberProblem(kind, 'NDPS.7-A')).toBeNull();
        expect(licenceNumberProblem(kind, 'A'.repeat(51))).not.toBeNull();
        expect(licenceNumberProblem(kind, '')).not.toBeNull();
        expect(licenceNumberProblem(kind, 'MH#20')).not.toBeNull();
        expect(licenceNumberProblem(kind, 'mh/20')).not.toBeNull();
      }
    });

    it('families: the three FSSAI tiers are one; each drug kind its own', () => {
      expect(new Set(['fssai-registration', 'fssai-state', 'fssai-central'].map((k) => licenceFamily(k as never)))).toEqual(new Set(['fssai']));
      expect(['drug-20b', 'drug-21b', 'drug-20g', 'ndps'].map((k) => licenceFamily(k as never))).toEqual(['drug-20b', 'drug-21b', 'drug-20g', 'ndps']);
    });

    it('the fixed-term kinds are FSSAI and NDPS', () => {
      expect([...KINDS_REQUIRING_VALID_UNTIL].sort()).toEqual(['fssai-central', 'fssai-registration', 'fssai-state', 'ndps']);
    });
  });

  describe('validity (decision 6)', () => {
    it('valid on D: active, from null or ≤ D, until null or ≥ D', () => {
      expect(licenceValidOn(licence({ validFrom: null, validUntil: null }), TODAY)).toBe(true);
      expect(licenceValidOn(licence({ validFrom: TODAY, validUntil: TODAY }), TODAY)).toBe(true);
      expect(licenceValidOn(licence({ validFrom: '2026-11-02' }), TODAY)).toBe(false);
      expect(licenceValidOn(licence({ validUntil: '2026-10-31' }), TODAY)).toBe(false);
      expect(licenceValidOn(licence({ status: 'withdrawn' }), TODAY)).toBe(false);
    });
  });

  describe('coverage predicates (decision 2)', () => {
    it('a client licence for the site, or for no site, covers; for another site it does not', () => {
      expect(clientLicenceCovers(licence({ clientId: C, warehouseId: W1 }), C, W1, 'fssai', TODAY)).toBe(true);
      expect(clientLicenceCovers(licence({ clientId: C, warehouseId: null }), C, W2, 'fssai', TODAY)).toBe(true);
      expect(clientLicenceCovers(licence({ clientId: C, warehouseId: W1 }), C, W2, 'fssai', TODAY)).toBe(false);
    });

    it('a client licence of another client, another kind, or not valid does not cover', () => {
      expect(clientLicenceCovers(licence({ clientId: 'other', warehouseId: null }), C, W1, 'fssai', TODAY)).toBe(false);
      expect(clientLicenceCovers(licence({ clientId: C, kind: 'drug-20b', validUntil: null }), C, W1, 'drug-20g', TODAY)).toBe(false);
      expect(clientLicenceCovers(licence({ clientId: C, validUntil: '2026-10-31' }), C, W1, 'fssai', TODAY)).toBe(false);
      expect(clientLicenceCovers(licence({ clientId: C, validFrom: '2026-12-01' }), C, W1, 'fssai', TODAY)).toBe(false);
    });

    it('a site licence covers its own site only, and a client licence is never a site licence', () => {
      expect(siteLicenceCovers(licence({ kind: 'fssai-registration' }), W1, 'fssai', TODAY)).toBe(true);
      expect(siteLicenceCovers(licence({}), W2, 'fssai', TODAY)).toBe(false);
      expect(siteLicenceCovers(licence({ clientId: C }), W1, 'fssai', TODAY)).toBe(false);
      expect(siteLicenceCovers(licence({ kind: 'drug-20b', validUntil: null }), W1, 'drug-20g', TODAY)).toBe(false);
      expect(siteLicenceCovers(licence({ status: 'withdrawn' }), W1, 'fssai', TODAY)).toBe(false);
    });
  });

  describe('warning state (decision 3)', () => {
    it('day 61 nothing; day 60 upcoming; the expiry day upcoming; the day after expired', () => {
      expect(warningState('2027-01-01', TODAY)).toBe('none'); // 61 days out
      expect(warningState('2026-12-31', TODAY)).toBe('upcoming'); // 60 days out
      expect(warningState('2026-11-01', TODAY)).toBe('upcoming'); // the expiry day
      expect(warningState('2026-10-31', TODAY)).toBe('expired'); // the day after
      expect(warningState(null, TODAY)).toBe('none');
    });

    it('crosses a leap day and a year end exactly', () => {
      expect(warningState('2028-04-29', '2028-02-29')).toBe('upcoming'); // 60 days across the leap day
      expect(warningState('2028-04-30', '2028-02-29')).toBe('none');
    });

    it('the list badge and days left', () => {
      expect(expiryStateOf({ status: 'withdrawn', validUntil: '2026-10-31' }, TODAY)).toBe('withdrawn');
      expect(expiryStateOf({ status: 'active', validUntil: null }, TODAY)).toBe('valid');
      expect(expiryStateOf({ status: 'active', validUntil: '2027-01-01' }, TODAY)).toBe('valid');
      expect(expiryStateOf({ status: 'active', validUntil: '2026-12-31' }, TODAY)).toBe('upcoming');
      expect(expiryStateOf({ status: 'active', validUntil: '2026-10-31' }, TODAY)).toBe('expired');
      expect(daysLeftOf('2026-12-31', TODAY)).toBe(60);
      expect(daysLeftOf('2026-11-01', TODAY)).toBe(0);
      expect(daysLeftOf('2026-10-31', TODAY)).toBe(-1);
      expect(daysLeftOf(null, TODAY)).toBeNull();
    });
  });
});

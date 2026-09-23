import {
  HAZARD_CLASSES,
  assertHazardClass,
  hazardClassesCompatible,
  segregationConflict,
  segregationStateConflict,
} from './hazard';
import { ProblemException } from '../problem-details/problem.exception';

/**
 * Story 12-2 — the decided default matrix, pinned pair by pair (review
 * triage #7: the human decision of 2026-09-23 rests on this predicate; only
 * oxidizer↔flammable was ever gate-exercised elsewhere). The gates
 * (placement, suggestion, merge, the SKU edit guard) prove the wiring; THIS
 * file proves the matrix itself.
 */
describe('hazard segregation matrix (story 12-2)', () => {
  it('the four decided pairs refuse in BOTH directions; every other classed pair is compatible', () => {
    // The decided pairs (explosive's universal rule is its own test below).
    const decided: [string, string][] = [
      ['oxidizer', 'flammable'],
      ['oxidizer', 'gas'],
      ['corrosive-acid', 'corrosive-base'],
      ['corrosive-acid', 'toxic'],
    ];
    for (const [a, b] of decided) {
      expect(hazardClassesCompatible(a, b)).toBe(false);
      expect(hazardClassesCompatible(b, a)).toBe(false); // symmetry
    }

    // Every UNDECIDED classed pair stays compatible — including same-class
    // pairs (only explosive refuses its own class): flammable beside
    // flammable is a quantity question, not a segregation one.
    for (const a of HAZARD_CLASSES) {
      for (const b of HAZARD_CLASSES) {
        if (a === 'explosive' || b === 'explosive') continue;
        if (decided.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) continue;
        expect(hazardClassesCompatible(a, b)).toBe(true);
      }
    }
  });

  it('explosive segregates from EVERY CLASSED SKU, itself included, in both directions', () => {
    for (const cls of HAZARD_CLASSES) {
      expect(hazardClassesCompatible('explosive', cls)).toBe(false);
      expect(hazardClassesCompatible(cls, 'explosive')).toBe(false); // symmetry
    }
  });

  it('a null class carries no rule in EITHER direction — even beside an explosive (the decided narrowing, triage #8)', () => {
    // The null check runs BEFORE the explosive universal rule — an explosive
    // co-locates with null-class stock, and null-class stock never refuses a
    // placement by its own presence alone.
    expect(hazardClassesCompatible(null, 'explosive')).toBe(true);
    expect(hazardClassesCompatible('explosive', null)).toBe(true);
    expect(hazardClassesCompatible(null, null)).toBe(true);
    expect(hazardClassesCompatible(null, 'oxidizer')).toBe(true);
    expect(hazardClassesCompatible('corrosive-acid', null)).toBe(true);
  });

  it('an unknown value carries no decided pair (the pair set is closed over the decided matrix)', () => {
    expect(hazardClassesCompatible('biohazard', 'toxic')).toBe(true);
    expect(hazardClassesCompatible('biohazard', 'biohazard')).toBe(true);
  });

  it('assertHazardClass skips undefined AND null (PATCH semantics — null is the clear verb) and refuses outside the vocabulary', () => {
    expect(() => assertHazardClass({ hazardClass: undefined })).not.toThrow();
    expect(() => assertHazardClass({ hazardClass: null })).not.toThrow();
    for (const bad of ['biohazard', 'radioactive', 'EXPLOSIVE']) {
      expect(() => assertHazardClass({ hazardClass: bad })).toThrow(ProblemException);
      try {
        assertHazardClass({ hazardClass: bad });
      } catch (err) {
        const problem = err as ProblemException;
        expect(problem.getStatus()).toBe(400);
        expect((problem.getResponse() as { detail: string }).detail).toContain('hazardClass');
      }
    }
    for (const cls of HAZARD_CLASSES) {
      expect(() => assertHazardClass({ hazardClass: cls })).not.toThrow();
    }
  });

  it('the refusal factories split the 400 device-facing refusal from the 409 state conflict', () => {
    const placement = segregationConflict('bin "A-01" holds SKU "OXY" (oxidizer) — SKU "FLM" (flammable) is segregated from it (FR-41).');
    expect(placement.getStatus()).toBe(400);
    expect((placement.getResponse() as { code: string }).code).toBe('bin-segregation-conflict');

    const edit = segregationStateConflict('SKU "X" would carry the "explosive" hazard class …');
    expect(edit.getStatus()).toBe(409);
    expect((edit.getResponse() as { code: string }).code).toBe('hazard-segregation-conflict');
  });
});
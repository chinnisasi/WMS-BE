import {
  EMPTY_PROFILE,
  GOODS_SEGREGATION_RULES,
  GOODS_SEGREGATION_RULE_CODES,
  READY_TO_EAT_CATEGORIES,
  binGoodsConflict,
  conflictKeys,
  goodsConflict,
  goodsConflictDetail,
  goodsConflictTitle,
  goodsStateConflict,
  hazardSet,
  isChemical,
  isEmptyProfile,
  newGoodsConflict,
  sameProfile,
  type SegregationProfile,
} from './segregation';
import { DG_CLASSES, FOOD_CATEGORIES } from './goods-type';
import { HAZARD_CLASSES } from './hazard';

/** Story 1-6b — the goods-type segregation predicate, pinned rule by rule. */
const p = (fields: Partial<SegregationProfile>): SegregationProfile => ({ ...EMPTY_PROFILE, ...fields });

/** Every key of `next` is already in `stored` — the edit guard's pass condition, inlined. */
const conflictKeysSubset = (next: readonly string[], stored: readonly string[]): boolean =>
  next.every((key) => stored.includes(key));

// Fixtures named for the I/O matrix.
const acid = p({ hazardClass: 'corrosive-acid', dgClass: '8' });
const corrosiveNone = p({ dgClass: '8' });
const flammableToxicSub = p({ hazardClass: 'flammable', dgClass: '3', dgSubsidiaryClasses: ['6.1'] });
const flammable = p({ hazardClass: 'flammable', dgClass: '3' });
const battery = p({ dgClass: '9' });
const explosive = p({ hazardClass: 'explosive', dgClass: '1.1' });
const legacyExplosive = p({ hazardClass: 'explosive' });
const oxidizer = p({ hazardClass: 'oxidizer', dgClass: '5.1' });
const legacyToxic = p({ hazardClass: 'toxic' });
const toxic61 = p({ hazardClass: 'toxic', dgClass: '6.1' });
const rice = p({ foodCategory: 'packaged-dry-grocery' });
const drugH = p({ drugSchedules: ['H'] });
const foodDrug = p({ foodCategory: 'other-food', drugSchedules: ['H'] });
const whisky = p({ foodCategory: 'beverages', hazardClass: 'flammable', dgClass: '3' });
const juice = p({ foodCategory: 'beverages' });
const milkSweet = p({ foodCategory: 'confectionery', allergens: ['milk'] });
const plainSweet = p({ foodCategory: 'confectionery' });
const milkEggs = p({ foodCategory: 'confectionery', allergens: ['eggs', 'milk'] });
const chicken = p({ foodCategory: 'meat-poultry-seafood' });
const paneer = p({ foodCategory: 'dairy' });
const salad = p({ foodCategory: 'ready-to-eat' });
const tshirt = p({ foodCategory: 'non-food' });
const peanutSnack = p({ foodCategory: 'packaged-dry-grocery', allergens: ['peanuts'] });

/** The rule in both argument orders — the predicate is symmetric in its verdict. */
function ruleBoth(a: SegregationProfile, b: SegregationProfile): string | null {
  const ab = goodsConflict(a, b);
  const ba = goodsConflict(b, a);
  expect(ba?.rule ?? null).toBe(ab?.rule ?? null);
  return ab?.rule ?? null;
}

describe('segregation primitive (story 1-6b)', () => {
  describe('emptiness', () => {
    it('empty means no hazard, no DG, no subsidiaries, no schedules and a null or non-food category', () => {
      expect(isEmptyProfile(EMPTY_PROFILE)).toBe(true);
      expect(isEmptyProfile(tshirt)).toBe(true);
      expect(isEmptyProfile(p({ hazardClass: 'toxic' }))).toBe(false);
      expect(isEmptyProfile(battery)).toBe(false);
      expect(isEmptyProfile(drugH)).toBe(false);
      expect(isEmptyProfile(rice)).toBe(false);
      // Allergens are ignored for emptiness (they need a food category — the 1-6a CHECK).
      expect(isEmptyProfile(p({ allergens: ['milk'] }))).toBe(true);
    });

    it('an empty profile conflicts with nothing, in either order', () => {
      const everything = [acid, corrosiveNone, flammableToxicSub, battery, explosive, legacyExplosive, oxidizer, rice, drugH, whisky, milkSweet, chicken];
      for (const other of everything) {
        expect(ruleBoth(EMPTY_PROFILE, other)).toBeNull();
        expect(ruleBoth(tshirt, other)).toBeNull();
        expect(conflictKeys(EMPTY_PROFILE, other)).toEqual([]);
      }
    });
  });

  describe('the hazard set (decision 1)', () => {
    it('maps each subsidiary: 1.x explosive, 2.x gas, 3 flammable, 5.1 oxidizer, 6.1 toxic — the rest (8 included) add nothing', () => {
      const expected: Record<string, string | null> = {
        '1.1': 'explosive', '1.2': 'explosive', '1.3': 'explosive', '1.4': 'explosive', '1.5': 'explosive', '1.6': 'explosive',
        '2.1': 'gas', '2.2': 'gas', '2.3': 'gas',
        '3': 'flammable',
        '4.1': null, '4.2': null, '4.3': null,
        '5.1': 'oxidizer', '5.2': null,
        '6.1': 'toxic', '6.2': null,
        '7': null, '8': null, '9': null,
      };
      for (const sub of DG_CLASSES) {
        const set = hazardSet(p({ dgClass: '9', dgSubsidiaryClasses: [sub] }));
        expect(set.map((e) => e.hazardClass)).toEqual(expected[sub] === null ? [] : [expected[sub]]);
        if (expected[sub] !== null) expect(set[0]!.viaSubsidiary).toBe(sub);
      }
    });

    it('is the hazard class plus the mapped subsidiaries, in HAZARD_CLASSES order, the class itself winning a tie', () => {
      expect(hazardSet(flammableToxicSub)).toEqual([
        { hazardClass: 'flammable', viaSubsidiary: null },
        { hazardClass: 'toxic', viaSubsidiary: '6.1' },
      ]);
      expect(hazardSet(p({ hazardClass: 'toxic', dgClass: '6.1', dgSubsidiaryClasses: ['3', '6.1'] })).map((e) => e.hazardClass)).toEqual([
        'flammable',
        'toxic',
      ]);
      expect(hazardSet(p({ hazardClass: 'toxic', dgClass: '8', dgSubsidiaryClasses: ['6.1'] }))[0]).toEqual({ hazardClass: 'toxic', viaSubsidiary: null });
    });
  });

  describe('every rule, both argument orders', () => {
    it('1 hazard-pair: a subsidiary counts like its primary class; a subsidiary beside its own class is allowed', () => {
      expect(ruleBoth(flammableToxicSub, acid)).toBe('hazard-pair');
      const c = goodsConflict(flammableToxicSub, acid)!;
      expect(c).toEqual({ rule: 'hazard-pair', a: { hazardClass: 'toxic', viaSubsidiary: '6.1' }, b: { hazardClass: 'corrosive-acid', viaSubsidiary: null } });
      expect(ruleBoth(flammableToxicSub, flammable)).toBeNull();
      expect(ruleBoth(whisky, oxidizer)).toBe('hazard-pair');
      expect(ruleBoth(legacyExplosive, p({ hazardClass: 'oxidizer' }))).toBe('hazard-pair');
    });

    it('2 explosive-dg: an explosive never shares with any DG class, even one deriving no hazard', () => {
      for (const dg of ['4.1', '5.2', '6.2', '7', '9', '8']) {
        expect(ruleBoth(explosive, p({ dgClass: dg }))).toBe('explosive-dg');
        expect(ruleBoth(legacyExplosive, p({ dgClass: dg }))).toBe('explosive-dg');
      }
      // An explosive via a subsidiary counts too.
      expect(ruleBoth(p({ dgClass: '9', dgSubsidiaryClasses: ['1.4'] }), battery)).toBe('explosive-dg');
      expect(goodsConflict(battery, explosive)).toEqual({ rule: 'explosive-dg', explosive: 'b', dgClass: '9' });
      // Explosive vs a non-DG, non-hazard SKU: no rule (food is not a DG; rule 3 then rules).
      expect(ruleBoth(legacyExplosive, p({ drugSchedules: ['X'] }))).toBe('drug-chemical');
    });

    it('3 food-chemical: food vs a DG with no hazard, and vs a legacy hazard class with no DG', () => {
      expect(ruleBoth(rice, battery)).toBe('food-chemical');
      expect(ruleBoth(rice, legacyToxic)).toBe('food-chemical');
      expect(ruleBoth(rice, toxic61)).toBe('food-chemical');
      expect(goodsConflict(battery, rice)).toEqual({ rule: 'food-chemical', food: 'b' });
    });

    it('4 drug-chemical: a scheduled drug vs a chemical', () => {
      expect(ruleBoth(drugH, corrosiveNone)).toBe('drug-chemical');
      expect(goodsConflict(drugH, corrosiveNone)).toEqual({ rule: 'drug-chemical', drug: 'a' });
      // No drug-vs-food or drug-vs-drug rule.
      expect(ruleBoth(drugH, rice)).toBeNull();
      expect(ruleBoth(drugH, p({ drugSchedules: ['X', 'NDPS'] }))).toBeNull();
    });

    it('5 allergen-mismatch: strict — [] is allergen-free; a superset differs; equal sets share', () => {
      expect(ruleBoth(milkSweet, plainSweet)).toBe('allergen-mismatch');
      expect(ruleBoth(milkSweet, milkEggs)).toBe('allergen-mismatch');
      expect(ruleBoth(milkEggs, p({ foodCategory: 'bakery-cereals', allergens: ['milk', 'eggs'] }))).toBeNull();
      expect(ruleBoth(peanutSnack, tshirt)).toBeNull();
    });

    it('6 raw-ready-to-eat: raw meat vs dairy, ready-to-eat, fresh produce, bakery and cereals, infant food — and nothing else', () => {
      for (const category of FOOD_CATEGORIES) {
        if (category === 'non-food') continue;
        const other = p({ foodCategory: category });
        const expected = READY_TO_EAT_CATEGORIES.includes(category) ? 'raw-ready-to-eat' : null;
        expect(ruleBoth(chicken, other)).toBe(expected);
      }
      expect(goodsConflict(paneer, chicken)).toEqual({ rule: 'raw-ready-to-eat', raw: 'b' });
      expect(ruleBoth(chicken, salad)).toBe('raw-ready-to-eat');
    });
  });

  describe('the rule order', () => {
    it('the first rule that fires is named', () => {
      // A DG 1.1 explosive beside a DG 5.1 oxidizer: hazard-pair before explosive-dg.
      expect(goodsConflict(explosive, oxidizer)!.rule).toBe('hazard-pair');
      // A food + drug SKU beside DG 8 none: food-chemical before drug-chemical.
      expect(ruleBoth(foodDrug, corrosiveNone)).toBe('food-chemical');
      // Different allergens AND raw vs dairy: allergen-mismatch first.
      expect(ruleBoth(chicken, p({ foodCategory: 'dairy', allergens: ['milk'] }))).toBe('allergen-mismatch');
      // A whisky (food + DG 3) beside a DG 1.1 explosive: hazard-pair first.
      expect(ruleBoth(whisky, explosive)).toBe('hazard-pair');
    });

    it('hazard-pair names the first pair walking the incoming set, then the occupant set, in HAZARD_CLASSES order', () => {
      const incoming = p({ hazardClass: 'toxic', dgClass: '6.1', dgSubsidiaryClasses: ['3'] }); // [flammable, toxic]
      const occupant = p({ hazardClass: 'corrosive-acid', dgClass: '8', dgSubsidiaryClasses: ['5.1'] }); // [oxidizer, corrosive-acid]
      expect(goodsConflict(incoming, occupant)).toEqual({
        rule: 'hazard-pair',
        a: { hazardClass: 'flammable', viaSubsidiary: '3' },
        b: { hazardClass: 'oxidizer', viaSubsidiary: '5.1' },
      });
    });

    it('serves the six rules in table order', () => {
      expect(GOODS_SEGREGATION_RULES.map((r) => r.code)).toEqual([...GOODS_SEGREGATION_RULE_CODES]);
      expect(GOODS_SEGREGATION_RULE_CODES).toEqual([
        'hazard-pair',
        'explosive-dg',
        'food-chemical',
        'drug-chemical',
        'allergen-mismatch',
        'raw-ready-to-eat',
      ]);
    });
  });

  describe('decision 8 — a food or drug that is also DG is not a chemical', () => {
    it('spirits sit beside juice; a DG drug sits beside food; both still obey rules 1 and 2', () => {
      expect(isChemical(whisky)).toBe(false);
      expect(ruleBoth(whisky, juice)).toBeNull();
      const dgDrug = p({ drugSchedules: ['H'], hazardClass: 'flammable', dgClass: '3' });
      expect(isChemical(dgDrug)).toBe(false);
      expect(ruleBoth(dgDrug, rice)).toBeNull();
      expect(ruleBoth(dgDrug, oxidizer)).toBe('hazard-pair');
      expect(ruleBoth(whisky, legacyExplosive)).toBe('hazard-pair');
      expect(ruleBoth(p({ foodCategory: 'other-food', dgClass: '9' }), legacyExplosive)).toBe('explosive-dg');
    });
  });

  describe('conflictKeys (decision 3)', () => {
    it('lists every incompatible sorted class pair and every other rule that fires', () => {
      expect(conflictKeys(explosive, oxidizer)).toEqual(['explosive-dg', 'hazard-pair:explosive|oxidizer']);
      expect(conflictKeys(rice, battery)).toEqual(['food-chemical']);
      expect(conflictKeys(oxidizer, flammable)).toEqual(conflictKeys(flammable, oxidizer));
    });

    it('subset cases: the 12-2 explosive → flammable regress is refused; an unrelated change in a mixed bin passes', () => {
      const binmate = p({ hazardClass: 'oxidizer' });
      const before = conflictKeys(legacyExplosive, binmate);
      const after = conflictKeys(p({ hazardClass: 'flammable' }), binmate);
      expect(conflictKeysSubset(after, before)).toBe(false);
      // rice beside DG 9, rice gains allergens: still {food-chemical}.
      const riceMilk = p({ foodCategory: 'packaged-dry-grocery', allergens: ['milk'] });
      expect(conflictKeysSubset(conflictKeys(riceMilk, battery), conflictKeys(rice, battery))).toBe(true);
      // A compatible class edits over the same stock.
      expect(conflictKeysSubset(conflictKeys(p({ hazardClass: 'toxic' }), binmate), before)).toBe(true);
      // Allergen removed beside a [milk] food: newly conflicting.
      expect(conflictKeysSubset(conflictKeys(plainSweet, milkSweet), conflictKeys(milkSweet, milkSweet))).toBe(false);
      // Food → non-food on a DG 3 beverage beside juice: becomes a chemical.
      const whiskyNonFood = p({ foodCategory: 'non-food', hazardClass: 'flammable', dgClass: '3' });
      expect(conflictKeysSubset(conflictKeys(whiskyNonFood, juice), conflictKeys(whisky, juice))).toBe(false);
    });
  });

  describe('newGoodsConflict — the edit guard\'s predicate', () => {
    const fixtures = [
      EMPTY_PROFILE, acid, corrosiveNone, flammableToxicSub, flammable, battery, explosive, legacyExplosive, oxidizer,
      legacyToxic, toxic61, rice, drugH, foodDrug, whisky, juice, milkSweet, plainSweet, milkEggs, chicken, paneer, salad,
      tshirt, peanutSnack,
    ];
    /** The key a returned conflict stands for, in `conflictKeys`' spelling. */
    const keyOf = (c: NonNullable<ReturnType<typeof newGoodsConflict>>): string => {
      if (c.rule !== 'hazard-pair') return c.rule;
      const [x, y] = [c.a.hazardClass, c.b.hazardClass].sort();
      return `hazard-pair:${x}|${y}`;
    };

    it('is null exactly when conflictKeys(next, b) ⊆ conflictKeys(stored, b), and otherwise names a NEW key — every fixture triple', () => {
      let refusals = 0;
      let passes = 0;
      for (const stored of fixtures) {
        for (const next of fixtures) {
          for (const b of fixtures) {
            const nextKeys = conflictKeys(next, b);
            const storedKeys = conflictKeys(stored, b);
            const conflict = newGoodsConflict(next, stored, b);
            expect({ stored, next, b, refused: conflict !== null }).toEqual({
              stored,
              next,
              b,
              refused: !conflictKeysSubset(nextKeys, storedKeys),
            });
            if (conflict !== null) {
              refusals += 1;
              expect(nextKeys).toContain(keyOf(conflict));
              expect(storedKeys).not.toContain(keyOf(conflict));
            } else {
              passes += 1;
            }
          }
        }
      }
      expect(refusals).toBeGreaterThan(0);
      expect(passes).toBeGreaterThan(0);
    });

    it('names the newly fired hazard pair, not an older one already present', () => {
      const stored = p({ hazardClass: 'flammable', dgClass: '3' });
      const next = p({ hazardClass: 'flammable', dgClass: '3', dgSubsidiaryClasses: ['6.1'] });
      const binmate = p({ hazardClass: 'corrosive-acid', dgClass: '8', dgSubsidiaryClasses: ['5.1'] });
      expect(newGoodsConflict(next, stored, binmate)).toEqual({
        rule: 'hazard-pair',
        a: { hazardClass: 'toxic', viaSubsidiary: '6.1' },
        b: { hazardClass: 'corrosive-acid', viaSubsidiary: null },
      });
    });
  });

  describe('sameProfile', () => {
    it('compares arrays as sorted sets', () => {
      expect(sameProfile(p({ allergens: ['milk', 'eggs'], foodCategory: 'dairy' }), p({ allergens: ['eggs', 'milk'], foodCategory: 'dairy' }))).toBe(true);
      expect(sameProfile(p({ drugSchedules: ['H'] }), p({ drugSchedules: [] }))).toBe(false);
      expect(sameProfile(p({ hazardClass: 'toxic' }), p({ hazardClass: 'flammable' }))).toBe(false);
    });
  });

  describe('detail templates and factories', () => {
    it('hazard-pair with no subsidiary is the 12-2 placement detail, byte for byte', () => {
      const ox = p({ hazardClass: 'oxidizer' });
      const fl = p({ hazardClass: 'flammable' });
      expect(
        goodsConflictDetail(goodsConflict(fl, ox)!, { binCode: 'A-01', incomingCode: 'FLM', incoming: fl, occupantCode: 'OXY', occupant: ox }),
      ).toBe('Bin "A-01" holds SKU "OXY" (oxidizer) — SKU "FLM" (flammable) is segregated from it (FR-41).');
    });

    it('each rule names both codes, the facts and the bin, oriented incoming vs occupant', () => {
      const detail = (a: SegregationProfile, b: SegregationProfile): string =>
        goodsConflictDetail(goodsConflict(a, b)!, { binCode: 'B-1', incomingCode: 'IN', incoming: a, occupantCode: 'OCC', occupant: b });
      expect(detail(flammableToxicSub, acid)).toBe(
        'Bin "B-1" holds SKU "OCC" (corrosive-acid) — SKU "IN" (toxic, DG subsidiary 6.1) is segregated from it (FR-41).',
      );
      expect(detail(explosive, battery)).toBe(
        'Bin "B-1" holds SKU "OCC" (DG 9) — SKU "IN" (explosive) is an explosive, and an explosive never shares a bin with a dangerous good.',
      );
      expect(detail(battery, legacyExplosive)).toContain('SKU "IN" (DG 9) is a dangerous good');
      expect(detail(rice, battery)).toBe(
        'Bin "B-1" holds SKU "OCC" (chemical: DG 9) — SKU "IN" (food: packaged-dry-grocery) must be kept apart from it: food never shares a bin with a chemical.',
      );
      expect(detail(corrosiveNone, drugH)).toContain('"OCC" (drug: schedule H) — SKU "IN" (chemical: DG 8)');
      expect(detail(milkSweet, plainSweet)).toContain('"OCC" (confectionery, no allergens) — SKU "IN" (confectionery, allergens: milk)');
      expect(detail(paneer, chicken)).toContain('"OCC" (meat-poultry-seafood) — SKU "IN" (dairy)');
    });

    it('titles and codes per decision 2', () => {
      expect(goodsConflictTitle('hazard-pair')).toBe('Target bin holds a segregated hazard class');
      expect(goodsConflictTitle('explosive-dg')).toBe('Target bin holds a segregated hazard class');
      for (const rule of ['food-chemical', 'drug-chemical', 'allergen-mismatch', 'raw-ready-to-eat'] as const) {
        expect(goodsConflictTitle(rule)).toBe('Target bin holds goods that must be kept apart');
      }
      expect(binGoodsConflict('food-chemical', 'd').getStatus()).toBe(400);
      expect(binGoodsConflict('food-chemical', 'd', 409).getStatus()).toBe(409);
      expect((binGoodsConflict('hazard-pair', 'd').getResponse() as { code: string }).code).toBe('bin-segregation-conflict');
      const state = goodsStateConflict('allergen-mismatch', 'd');
      expect(state.getStatus()).toBe(409);
      expect((state.getResponse() as { code: string }).code).toBe('hazard-segregation-conflict');
    });
  });

  it('every hazard class appears in HAZARD_CLASSES order inside a hazard set', () => {
    for (const cls of HAZARD_CLASSES) {
      expect(hazardSet(p({ hazardClass: cls }))).toEqual([{ hazardClass: cls, viaSubsidiary: null }]);
    }
  });
});

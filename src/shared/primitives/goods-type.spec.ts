import {
  ALLERGENS,
  DEFAULT_GOODS_TYPE,
  DG_CLASSES,
  DG_CLASSES_WITHOUT_PACKING_GROUP,
  DG_HAZARD_MAP,
  assertGoodsType,
  canonicalGoodsType,
  goodsTypeProblem,
  hazardResolution,
  mergeGoodsType,
  presentGoodsTypeKeys,
  resolveHazardClass,
} from './goods-type';
import { ProblemException } from '../problem-details/problem.exception';

/** Story 1-6a — the goods-type rule set, pinned rule by rule (decisions 3, 5, 6, 7, 10). */
describe('goods-type primitive (story 1-6a)', () => {
  const dg = { dgUnNumber: '1203', dgClass: '3' };

  describe('canonicalGoodsType (decision 10)', () => {
    it('strips the UN prefix in any case and sorts and de-duplicates every array', () => {
      expect(
        canonicalGoodsType({
          dgUnNumber: 'un1203',
          drugSchedules: ['H', 'C', 'H'],
          allergens: ['milk', 'eggs', 'milk'],
          dgSubsidiaryClasses: ['8', '6.1'],
        }),
      ).toEqual({ dgUnNumber: '1203', drugSchedules: ['C', 'H'], allergens: ['eggs', 'milk'], dgSubsidiaryClasses: ['6.1', '8'] });
      expect(canonicalGoodsType({ dgUnNumber: 'UN1203' }).dgUnNumber).toBe('1203');
      expect(canonicalGoodsType({ dgUnNumber: '1203' }).dgUnNumber).toBe('1203');
    });

    it('keeps absent keys absent and null null; a malformed value passes through for the assert', () => {
      expect(canonicalGoodsType({ foodCategory: 'dairy' })).toEqual({ foodCategory: 'dairy' });
      expect(canonicalGoodsType({ dgUnNumber: null })).toEqual({ dgUnNumber: null });
      expect(canonicalGoodsType({ dgUnNumber: 'UN12' }).dgUnNumber).toBe('UN12');
    });

    it('presentGoodsTypeKeys spreads present keys only, in the fixed field order', () => {
      expect(JSON.stringify(presentGoodsTypeKeys({ fragile: true, drugSchedules: ['C'], maxStackLayers: null }))).toBe(
        '{"drugSchedules":["C"],"fragile":true,"maxStackLayers":null}',
      );
      expect(presentGoodsTypeKeys({})).toEqual({});
    });
  });

  describe('mergeGoodsType', () => {
    it('merges with !== undefined, so an explicit clear is a clear, not absent', () => {
      const current = { ...DEFAULT_GOODS_TYPE, foodCategory: 'dairy', allergens: ['milk'], maxStackLayers: 4 };
      const merged = mergeGoodsType(current, { foodCategory: null, maxStackLayers: null });
      expect(merged.foodCategory).toBeNull();
      expect(merged.maxStackLayers).toBeNull();
      expect(merged.allergens).toEqual(['milk']);
    });
  });

  describe('goodsTypeProblem / assertGoodsType', () => {
    it('admits the defaults and a full food + DG record together (UN3065 alcohol is food and DG)', () => {
      expect(goodsTypeProblem(DEFAULT_GOODS_TYPE)).toBeNull();
      expect(goodsTypeProblem({})).toBeNull();
      expect(
        goodsTypeProblem({
          drugSchedules: ['C', 'H'],
          foodCategory: 'beverages',
          allergens: ['sulphite'],
          dgUnNumber: '3065',
          dgClass: '3',
          dgSubsidiaryClasses: ['6.1'],
          dgPackingGroup: 'III',
          highValue: true,
          fragile: true,
          maxStackLayers: 1,
        }),
      ).toBeNull();
    });

    const refused: [string, Record<string, unknown>, string][] = [
      ['unknown schedule', { drugSchedules: ['Z'] }, 'drugSchedules'],
      ['unknown food category', { foodCategory: 'snacks' }, 'foodCategory'],
      ['unknown allergen', { foodCategory: 'dairy', allergens: ['milk', 'peanut'] }, 'allergens'],
      ['allergens without a category', { allergens: ['milk'] }, 'allergens'],
      ['allergens on non-food', { foodCategory: 'non-food', allergens: ['milk'] }, 'allergens'],
      ['UN number without a class', { dgUnNumber: '1203' }, 'dgClass'],
      ['class without a UN number', { dgClass: '3' }, 'dgUnNumber'],
      ['UN 0000', { dgUnNumber: '0000', dgClass: '3' }, 'dgUnNumber'],
      ['UN 3600', { dgUnNumber: '3600', dgClass: '3' }, 'dgUnNumber'],
      ['UN with a prefix (not canonical)', { dgUnNumber: 'UN1203', dgClass: '3' }, 'dgUnNumber'],
      ['unknown DG class', { dgUnNumber: '1203', dgClass: '10' }, 'dgClass'],
      ['subsidiary equal to the primary', { ...dg, dgClass: '3', dgUnNumber: '1230', dgSubsidiaryClasses: ['3', '6.1'] }, 'dgSubsidiaryClasses'],
      ['three subsidiaries', { ...dg, dgSubsidiaryClasses: ['6.1', '8', '9'] }, 'dgSubsidiaryClasses'],
      ['subsidiary without a primary', { dgSubsidiaryClasses: ['6.1'] }, 'dgSubsidiaryClasses'],
      ['unknown subsidiary', { ...dg, dgSubsidiaryClasses: ['6.3'] }, 'dgSubsidiaryClasses'],
      ['packing group without a class', { dgPackingGroup: 'II' }, 'dgPackingGroup'],
      ['packing group on class 2.1', { dgUnNumber: '1950', dgClass: '2.1', dgPackingGroup: 'II' }, 'dgPackingGroup'],
      ['unknown packing group', { ...dg, dgPackingGroup: 'IV' }, 'dgPackingGroup'],
      ['stack 0', { maxStackLayers: 0 }, 'maxStackLayers'],
      ['stack 101', { maxStackLayers: 101 }, 'maxStackLayers'],
      ['stack 2.5', { maxStackLayers: 2.5 }, 'maxStackLayers'],
      ['fragile not a boolean', { fragile: 'yes' }, 'fragile'],
    ];
    it.each(refused)('refuses %s, naming the field', (_label, input, field) => {
      expect(goodsTypeProblem(input as never)?.field).toBe(field);
      try {
        assertGoodsType(input as never);
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(ProblemException);
        const body = (err as ProblemException).getResponse() as { code: string; detail: string };
        expect((err as ProblemException).getStatus()).toBe(400);
        expect(body.code).toBe('validation-failed');
        expect(body.detail).toContain(field);
      }
    });

    it('a packing group is refused on exactly the classes without one', () => {
      for (const dgClass of DG_CLASSES) {
        const problem = goodsTypeProblem({ dgUnNumber: '1203', dgClass, dgPackingGroup: 'II' });
        expect(problem === null).toBe(!DG_CLASSES_WITHOUT_PACKING_GROUP.includes(dgClass));
      }
      expect(DG_CLASSES_WITHOUT_PACKING_GROUP).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1', '2.2', '2.3', '5.2', '6.2', '7']);
    });

    it('stack bounds: 1 and 100 are admitted', () => {
      expect(goodsTypeProblem({ maxStackLayers: 1 })).toBeNull();
      expect(goodsTypeProblem({ maxStackLayers: 100 })).toBeNull();
      expect(ALLERGENS).toHaveLength(9);
    });
  });

  describe('resolveHazardClass (decision 7)', () => {
    it('the decision-3 map, exactly', () => {
      expect(DG_HAZARD_MAP).toEqual({
        '1.1': 'explosive',
        '1.2': 'explosive',
        '1.3': 'explosive',
        '1.4': 'explosive',
        '1.5': 'explosive',
        '1.6': 'explosive',
        '2.1': 'gas',
        '2.2': 'gas',
        '2.3': 'gas',
        '3': 'flammable',
        '5.1': 'oxidizer',
        '6.1': 'toxic',
      });
    });

    it('mapped class: absent derives (replacing a stored class), equal is taken, anything else — null included — mismatches', () => {
      const stored = { dgClass: null, hazardClass: 'toxic' };
      expect(resolveHazardClass('3', stored, undefined)).toBe('flammable');
      expect(resolveHazardClass('3', stored, 'flammable')).toBe('flammable');
      expect(hazardResolution('3', stored, 'toxic')).toMatchObject({ code: 'dg-hazard-mismatch' });
      expect(hazardResolution('3', stored, null)).toMatchObject({ code: 'dg-hazard-mismatch' });
      expect(resolveHazardClass('1.1', null, undefined)).toBe('explosive');
      expect(resolveHazardClass('2.3', null, undefined)).toBe('gas');
      expect(resolveHazardClass('5.1', null, undefined)).toBe('oxidizer');
      expect(resolveHazardClass('6.1', null, undefined)).toBe('toxic');
    });

    it('class 8: acid, base or explicit null are taken; anything else mismatches', () => {
      expect(resolveHazardClass('8', null, 'corrosive-acid')).toBe('corrosive-acid');
      expect(resolveHazardClass('8', null, 'corrosive-base')).toBe('corrosive-base');
      expect(resolveHazardClass('8', null, null)).toBeNull();
      expect(hazardResolution('8', null, 'toxic')).toMatchObject({ code: 'dg-hazard-mismatch' });
    });

    it('class 8 absent: keeps a stored corrosive, or the stored value when the DG class is unchanged; else required', () => {
      expect(resolveHazardClass('8', { dgClass: null, hazardClass: 'corrosive-base' }, undefined)).toBe('corrosive-base');
      expect(resolveHazardClass('8', { dgClass: '8', hazardClass: 'corrosive-acid' }, undefined)).toBe('corrosive-acid');
      expect(resolveHazardClass('8', { dgClass: '8', hazardClass: null }, undefined)).toBeNull();
      expect(hazardResolution('8', { dgClass: null, hazardClass: null }, undefined)).toMatchObject({ code: 'dg-hazard-required' });
      expect(hazardResolution('8', { dgClass: '3', hazardClass: 'flammable' }, undefined)).toMatchObject({ code: 'dg-hazard-required' });
      // A create / import row has no stored state.
      expect(hazardResolution('8', null, undefined)).toMatchObject({ code: 'dg-hazard-required' });
    });

    it('unmapped class or no DG class: as before — absent keeps the stored value, a value or null is taken', () => {
      for (const dgClass of ['4.1', '4.2', '4.3', '5.2', '6.2', '7', '9', null]) {
        expect(resolveHazardClass(dgClass, { dgClass: '3', hazardClass: 'flammable' }, undefined)).toBe('flammable');
        expect(resolveHazardClass(dgClass, { dgClass: '3', hazardClass: 'flammable' }, 'toxic')).toBe('toxic');
        expect(resolveHazardClass(dgClass, { dgClass: '3', hazardClass: 'flammable' }, null)).toBeNull();
        expect(resolveHazardClass(dgClass, null, undefined)).toBeNull();
      }
    });

    it('a refusal is a 400 carrying its code', () => {
      try {
        resolveHazardClass('8', null, undefined);
        throw new Error('expected a refusal');
      } catch (err) {
        expect((err as ProblemException).getStatus()).toBe(400);
        expect(((err as ProblemException).getResponse() as { code: string }).code).toBe('dg-hazard-required');
      }
    });
  });
});

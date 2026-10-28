import { istDateOf, istMinuteOfDay, istWeekdayOf } from './time';

/**
 * Story 2-3b — the two IST primitives the dock schedule reads. The boundary
 * fixtures are UTC instants on either side of IST midnight (18:30 UTC) and
 * of the UTC day (00:00 UTC = 05:30 IST): 00:00, 05:29, 05:30 and 23:59 UTC.
 */
describe('istMinuteOfDay / istWeekdayOf (story 2-3b)', () => {
  it.each([
    ['2026-10-29T00:00:00.000Z', 330, '2026-10-29'],
    ['2026-10-29T05:29:00.000Z', 659, '2026-10-29'],
    ['2026-10-29T05:30:00.000Z', 660, '2026-10-29'],
    ['2026-10-29T23:59:00.000Z', 329, '2026-10-30'],
    ['2026-10-28T18:30:00.000Z', 0, '2026-10-29'],
    ['2026-10-28T18:29:59.999Z', 1439, '2026-10-28'],
    ['2026-10-29T05:30:59.999Z', 660, '2026-10-29'],
  ])('%s is IST minute %i of %s', (instant, minute, date) => {
    expect(istMinuteOfDay(instant)).toBe(minute);
    expect(istDateOf(instant)).toBe(date);
  });

  it('takes any zone designator', () => {
    expect(istMinuteOfDay('2026-10-29T10:30:00+05:30')).toBe(630);
    expect(istMinuteOfDay('2026-10-29T00:00:00-05:00')).toBe(630);
  });

  it('refuses an unparseable instant with a RangeError', () => {
    expect(() => istMinuteOfDay('not a time')).toThrow(RangeError);
  });

  it('the ISO weekday of a calendar date, Monday 1 … Sunday 7', () => {
    // 2026-10-26 is a Monday.
    expect(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'].map(istWeekdayOf)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    // The IST date decides, not the UTC one: Sunday 23:59 UTC is Monday in IST.
    expect(istWeekdayOf(istDateOf('2026-11-01T23:59:00.000Z'))).toBe(1);
    expect(istWeekdayOf(istDateOf('2026-11-01T00:00:00.000Z'))).toBe(7);
  });
});

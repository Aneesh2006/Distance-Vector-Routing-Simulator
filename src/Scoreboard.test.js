import { COLORS, CORRECTNESS_STYLES, withAlpha } from './config';
import { correctnessRowStyle } from './Scoreboard';

describe('withAlpha', () => {
  test('expands both hex forms', () => {
    expect(withAlpha('#ff9800', 0.2)).toBe('rgba(255, 152, 0, 0.2)');
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)');
    expect(withAlpha('000000', 0)).toBe('rgba(0, 0, 0, 0)');
  });

  test('every palette colour survives the round trip', () => {
    Object.values(COLORS).forEach((hex) => {
      expect(withAlpha(hex, 0.5)).toMatch(/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.5\)$/);
    });
  });
});

describe('correctnessRowStyle', () => {
  test('leaves a correct table untinted', () => {
    expect(correctnessRowStyle('optimal')).toBeUndefined();
    expect(correctnessRowStyle(undefined)).toBeUndefined();
  });

  test('tints each wrong class with its palette colour', () => {
    expect(correctnessRowStyle('suboptimal')).toEqual({
      backgroundColor: withAlpha(COLORS.warning, CORRECTNESS_STYLES.suboptimal.tint),
      fontWeight: undefined,
    });
    expect(correctnessRowStyle('stale-unreachable').backgroundColor).toBe(
      withAlpha(COLORS.error, CORRECTNESS_STYLES['stale-unreachable'].tint)
    );
  });

  test('the two black-hole classes are the ones set in bold', () => {
    expect(correctnessRowStyle('phantom').fontWeight).toBe(700);
    expect(correctnessRowStyle('looping').fontWeight).toBe(700);
    expect(correctnessRowStyle('suboptimal').fontWeight).toBeUndefined();
  });
});

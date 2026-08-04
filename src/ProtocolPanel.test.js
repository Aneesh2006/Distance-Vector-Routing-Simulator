/**
 * ProtocolPanel.test.js — the pure view helpers behind the generic panel.
 *
 * The components themselves are untested by design (the engine is where the
 * risk is), but these two functions are where a plugin's declarations turn into
 * pixels, and a typo in either fails silently: the tint simply never appears.
 */

import { COLORS, ROUTE_ACCENTS, ROUTER_DECORATIONS, withAlpha } from './config';
import { routeAccentStyle, routerDecoration, toNumber } from './ProtocolPanel';

describe('routeAccentStyle', () => {
  test('marks an accented route with an inset edge, not a background', () => {
    // A policy route is usually also scored suboptimal, so the accent has to
    // survive alongside the correctness tint rather than replace it.
    expect(routeAccentStyle('policy')).toEqual({
      boxShadow: `inset ${ROUTE_ACCENTS.policy.width}px 0 0 ${COLORS.policyRoute}`,
    });
  });

  test('leaves an ordinary route alone', () => {
    expect(routeAccentStyle(undefined)).toBeUndefined();
    expect(routeAccentStyle('not-a-variant')).toBeUndefined();
  });
});

describe('routerDecoration', () => {
  test('tints a decorated router with its palette colour', () => {
    const { style, suffix, title } = routerDecoration('root', false);
    expect(suffix).toBe(ROUTER_DECORATIONS.root.suffix);
    expect(title).toBe(ROUTER_DECORATIONS.root.label);
    expect(style.backgroundColor).toBe(
      withAlpha(COLORS.routerRoot, ROUTER_DECORATIONS.root.tint)
    );
  });

  test('never covers the selection, which the user can act on', () => {
    expect(routerDecoration('stale', true).style).toBeUndefined();
    expect(routerDecoration(undefined, false)).toEqual({ suffix: '' });
  });
});

describe('toNumber', () => {
  test('clamps, and treats an emptied field as "not yet typed"', () => {
    expect(toNumber('250', 100, { min: 0, max: 999 })).toBe(250);
    expect(toNumber('4000', 100, { min: 0, max: 999 })).toBe(999);
    expect(toNumber('', 100)).toBe(100);
    expect(toNumber('abc', 100)).toBe(100);
  });
});

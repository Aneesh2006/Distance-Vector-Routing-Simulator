/**
 * registry.test.js — the half of `protocols/index.js` that can change at runtime.
 *
 * The registry grew a dynamic side for the custom-protocol editor, and the risk
 * that came with it is not that registration fails — it is that registration
 * quietly changes what an *existing* id means. `PROTOCOLS` still has to be the
 * built-ins and still has to be the same array object every other suite pushes
 * throwaway plugins onto, and `dvr` has to keep meaning distance vector no
 * matter what anybody registers.
 */

import {
  DEFAULT_PROTOCOL_ID,
  PROTOCOLS,
  allProtocols,
  customProtocolList,
  getCustomProtocol,
  getProtocol,
  isBuiltinProtocolId,
  registerCustomProtocol,
  unregisterCustomProtocol,
} from './index';
import { distanceVector } from './distanceVector';

const plugin = (id, extra = {}) => ({ id, name: `Plugin ${id}`, ...extra });

/** Whatever a test registers, gone before the next one runs. */
afterEach(() => {
  customProtocolList().forEach((entry) => unregisterCustomProtocol(entry.id));
});

describe('the built-in half is unchanged', () => {
  test('PROTOCOLS is still exactly the shipped protocols', () => {
    expect(PROTOCOLS.map((entry) => entry.id)).toEqual(['dvr', 'ls', 'pv', 'stp', 'dual']);
    expect(DEFAULT_PROTOCOL_ID).toBe(distanceVector.id);
  });

  test('registering does not touch it', () => {
    const before = [...PROTOCOLS];
    registerCustomProtocol(plugin('mine'));
    expect(PROTOCOLS).toEqual(before);
    expect(PROTOCOLS).toHaveLength(5);
  });

  test('isBuiltinProtocolId knows which is which', () => {
    registerCustomProtocol(plugin('mine'));
    expect(isBuiltinProtocolId('dvr')).toBe(true);
    expect(isBuiltinProtocolId('mine')).toBe(false);
    expect(isBuiltinProtocolId('nonsense')).toBe(false);
  });
});

describe('register and look up', () => {
  test('a registered protocol resolves by id', () => {
    const mine = plugin('mine');
    registerCustomProtocol(mine);

    expect(getProtocol('mine')).toBe(mine);
    expect(getCustomProtocol('mine')).toBe(mine);
    expect(getCustomProtocol('dvr')).toBeNull();
  });

  test('registering the same id again replaces it — that is what re-activating is', () => {
    registerCustomProtocol(plugin('mine', { name: 'First' }));
    registerCustomProtocol(plugin('mine', { name: 'Second' }));

    expect(customProtocolList()).toHaveLength(1);
    expect(getProtocol('mine').name).toBe('Second');
  });

  test('unregistering takes it back out', () => {
    registerCustomProtocol(plugin('mine'));
    expect(unregisterCustomProtocol('mine')).toBe(true);
    expect(unregisterCustomProtocol('mine')).toBe(false);
    expect(() => getProtocol('mine')).toThrow(/mine/);
  });

  test('an unknown id is still an error rather than a silent default', () => {
    expect(() => getProtocol('nope')).toThrow(/nope/);
  });
});

describe('collisions', () => {
  test('a built-in id is refused outright', () => {
    expect(() => registerCustomProtocol(plugin('dvr'))).toThrow(/built-in/);
    expect(getProtocol('dvr')).toBe(distanceVector);
    expect(customProtocolList()).toEqual([]);
  });

  test('an id that is not a usable string is refused', () => {
    expect(() => registerCustomProtocol(plugin(''))).toThrow(/id/);
    expect(() => registerCustomProtocol(plugin('   '))).toThrow(/id/);
    expect(() => registerCustomProtocol(null)).toThrow(/id/);
  });
});

describe('allProtocols', () => {
  test('is the built-ins first, then the customs in registration order', () => {
    registerCustomProtocol(plugin('alpha'));
    registerCustomProtocol(plugin('beta'));

    expect(allProtocols().map((entry) => entry.id)).toEqual([
      'dvr',
      'ls',
      'pv',
      'stp',
      'dual',
      'alpha',
      'beta',
    ]);
  });

  test('is the built-ins alone when nothing has been registered', () => {
    expect(allProtocols()).toEqual(PROTOCOLS);
  });
});

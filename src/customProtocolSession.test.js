/**
 * customProtocolSession.test.js — the pipeline and the tab-scoped storage.
 *
 * Two properties matter more than the plumbing:
 *
 *   - **Nothing reaches the registry except through `attemptActivation`.** A
 *     restore on page load has to pass the same compile, the same contract check
 *     and the same smoke run as a click on Activate, or a reload would be a way
 *     of running code that Activate refused.
 *   - **Nothing survives the tab.** `sessionStorage` only, both keys, and an
 *     explicit clear leaves no trace — which is also the fix for "Clear" once
 *     having stored an empty string instead of removing the key.
 */

import {
  ACTIVE_KEY,
  SOURCE_KEY,
  attemptActivation,
  clearStoredProtocol,
  isCustomProtocolId,
  readStoredSource,
  readWasActive,
  restoreCustomProtocol,
  writeStoredSource,
  writeWasActive,
} from './customProtocolSession';
import { customProtocolList, unregisterCustomProtocol } from './engine/protocols';
import { MINIMAL_TEMPLATE } from './engine/protocols/customTemplates';

const SOURCE = `
  return {
    id: 'sess',
    name: 'Session Protocol',
    summary: 'Nothing but itself.',
    messageLabel: 'S',
    options: [{ key: 'infinityCost', label: 'Infinity', type: 'number', default: 16 }],
    columns: [{ key: 'cost', label: 'Cost', format: 'cost' }],
    createState: () => ({}),
    round: () => ({ messages: [], changed: false }),
    tables: (state, topology) =>
      Object.fromEntries(topology.routerIds.map((id) => [id, { [id]: { nextHop: id, cost: 0 } }])),
  };
`;

beforeEach(() => {
  window.sessionStorage.clear();
  customProtocolList().forEach((entry) => unregisterCustomProtocol(entry.id));
});

describe('attemptActivation', () => {
  test('compiles, validates and registers in one go', () => {
    const result = attemptActivation(SOURCE);

    expect(result.ok).toBe(true);
    expect(result.plugin.id).toBe('sess');
    expect(result.errors).toEqual([]);
    expect(isCustomProtocolId('sess')).toBe(true);
  });

  test('a compile failure is reported apart from a validation one', () => {
    const result = attemptActivation('return {');

    expect(result.ok).toBe(false);
    expect(result.compileError).toMatch(/SyntaxError|Line/);
    expect(result.errors).toEqual([]);
    expect(customProtocolList()).toEqual([]);
  });

  test('a plugin that fails the contract is never registered', () => {
    const result = attemptActivation('return { id: "half-done", name: "Half done" };');

    expect(result.ok).toBe(false);
    expect(result.compileError).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(customProtocolList()).toEqual([]);
  });

  test('`register: false` checks without touching the registry', () => {
    const result = attemptActivation(SOURCE, { register: false });

    expect(result.ok).toBe(true);
    expect(customProtocolList()).toEqual([]);
  });
});

describe('storage', () => {
  test('keeps the source and the active flag apart', () => {
    writeStoredSource('const a = 1;');
    writeWasActive(true);

    expect(readStoredSource()).toBe('const a = 1;');
    expect(readWasActive()).toBe(true);

    writeWasActive(false);
    expect(readWasActive()).toBe(false);
    expect(window.sessionStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  test('an empty editor removes the key rather than storing a blank one', () => {
    writeStoredSource('something');
    writeStoredSource('');

    expect(window.sessionStorage.getItem(SOURCE_KEY)).toBeNull();
    expect(readStoredSource()).toBeNull();
  });

  test('clearing leaves nothing behind, registration included', () => {
    attemptActivation(SOURCE);
    writeStoredSource(SOURCE);
    writeWasActive(true);

    clearStoredProtocol('sess');

    expect(Object.keys(window.sessionStorage)).toEqual([]);
    expect(customProtocolList()).toEqual([]);
    expect(isCustomProtocolId('sess')).toBe(false);
  });

  test('nothing is ever written to localStorage', () => {
    attemptActivation(SOURCE);
    writeStoredSource(SOURCE);
    writeWasActive(true);
    expect(Object.keys(window.localStorage)).toEqual([]);
  });
});

describe('restoring after a reload', () => {
  test('brings back the source but registers nothing unless it was active', () => {
    writeStoredSource(MINIMAL_TEMPLATE);

    const restored = restoreCustomProtocol();
    expect(restored.source).toBe(MINIMAL_TEMPLATE);
    expect(restored.activeId).toBeNull();
    expect(customProtocolList()).toEqual([]);
  });

  test('re-registers one that was active, through the same checks', () => {
    writeStoredSource(SOURCE);
    writeWasActive(true);

    const restored = restoreCustomProtocol();
    expect(restored.activeId).toBe('sess');
    expect(restored.error).toBeNull();
    expect(isCustomProtocolId('sess')).toBe(true);
  });

  /**
   * The rule that matters most here: never lose the user's code. Somebody who
   * reloads mid-edit gets their text back, an explanation, and no registration.
   */
  test('a stored protocol that no longer works keeps its code and reports why', () => {
    writeStoredSource('return { id: "broken" };');
    writeWasActive(true);

    const restored = restoreCustomProtocol();
    expect(restored.source).toBe('return { id: "broken" };');
    expect(restored.activeId).toBeNull();
    expect(restored.error).toEqual(expect.any(String));
    expect(customProtocolList()).toEqual([]);
    // …and it stops claiming to be active, so the next reload fails silently
    // rather than repeating the same complaint for ever.
    expect(readWasActive()).toBe(false);
  });

  test('an empty tab restores nothing at all', () => {
    expect(restoreCustomProtocol()).toEqual({ source: null, activeId: null, error: null });
  });
});

/**
 * customLoader.test.js — source text in, plugin object out.
 *
 * The loader has one job and three ways to fail it, and the three have to stay
 * apart: a syntax error, a throw while the body runs, and a body that ran fine
 * and handed back something that is not a protocol are three different fixes.
 * What is *not* tested here is whether the object satisfies the contract — that
 * is `validateProtocol`'s, and keeping the seam sharp is what stops a missing
 * bracket being reported as thirty missing fields.
 */

import {
  PROTOCOL_CONFIG,
  PROTOCOL_HELPERS,
  compileProtocol,
  describeCompileError,
} from './customLoader';
import { SIM } from '../../config';

describe('compiling valid source', () => {
  test('returns the object the body returned', () => {
    const result = compileProtocol(`
      const protocol = { id: 'x', name: 'X', round() { return { messages: [], changed: false }; } };
      return protocol;
    `);

    expect(result.ok).toBe(true);
    expect(result.plugin.id).toBe('x');
    expect(typeof result.plugin.round).toBe('function');
    expect(result.error).toBeNull();
  });

  test('the body is a function body, so anything above the return is in scope', () => {
    const result = compileProtocol(`
      function twice(n) { return n * 2; }
      const eight = twice(4);
      return { id: 'x', eight };
    `);

    expect(result.ok).toBe(true);
    expect(result.plugin.eight).toBe(8);
  });
});

describe('the injected namespaces', () => {
  test('helpers are the same utilities the built-ins use', () => {
    const result = compileProtocol(`
      return {
        sorted: ['10', '9', '1'].sort(helpers.compareIds),
        same: helpers.tablesEqual(
          { A: { nextHop: 'B', cost: 2 } },
          { A: { nextHop: 'B', cost: 2 } }
        ),
        multi: helpers.multipathRoute('C', 5, ['C', 'B']),
        infinite: helpers.formatCost(16, 16),
      };
    `);

    expect(result.ok).toBe(true);
    expect(result.plugin.sorted).toEqual(['1', '9', '10']);
    expect(result.plugin.same).toBe(true);
    expect(result.plugin.multi).toEqual({ nextHop: 'B', nextHops: ['B', 'C'], cost: 5 });
    expect(result.plugin.infinite).toBe('∞');
  });

  test('every helper the templates lean on is actually there', () => {
    expect(Object.keys(PROTOCOL_HELPERS).sort()).toEqual([
      'cloneTable',
      'cloneTables',
      'compareIds',
      'formatCost',
      'multipathRoute',
      'nextHopsOf',
      'tablesEqual',
    ]);
  });

  test('config carries the SIM values', () => {
    const result = compileProtocol('return { ceiling: config.defaultInfinityCost };');
    expect(result.plugin.ceiling).toBe(SIM.defaultInfinityCost);
  });

  /**
   * By value and frozen all the way down. A plugin that assigned to
   * `config.timers.updateInterval` would otherwise retune every *other*
   * protocol in the app for the rest of the session.
   */
  test('config is a frozen copy, so user code cannot retune the app', () => {
    const before = SIM.timers.updateInterval;
    const result = compileProtocol(`
      try { config.timers.updateInterval = 1; } catch (error) { /* strict mode */ }
      return { seen: config.timers.updateInterval };
    `);

    expect(result.ok).toBe(true);
    expect(result.plugin.seen).toBe(before);
    expect(SIM.timers.updateInterval).toBe(before);
    expect(Object.isFrozen(PROTOCOL_CONFIG.timers)).toBe(true);
  });
});

describe('failures, kept apart', () => {
  test('a syntax error is reported as one, with a line number', () => {
    const result = compileProtocol(['const protocol = {', '  id: "x",', 'return protocol;'].join('\n'));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('syntax');
    expect(result.error).toMatch(/SyntaxError/);
    expect(result.plugin).toBeNull();
  });

  test('a throw while the body runs is reported at the line it threw on', () => {
    const result = compileProtocol(
      ['const protocol = {};', 'protocol.id = missingVariable;', 'return protocol;'].join('\n')
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('run');
    expect(result.error).toMatch(/missingVariable/);
    // V8 puts the position in the stack as <anonymous>:LINE:COL; other engines
    // may not, so the loader promises a line only when the browser gave one.
    if (result.line !== null) expect(result.line).toBe(2);
  });

  test('forgetting the return is its own message, not a shape error', () => {
    const result = compileProtocol('const protocol = { id: "x" };');

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('return');
    expect(result.error).toMatch(/return protocol;/);
  });

  test('returning something that is not an object is caught', () => {
    expect(compileProtocol('return 42;').stage).toBe('return');
    expect(compileProtocol('return [];').stage).toBe('return');
    expect(compileProtocol('return null;').stage).toBe('return');
  });

  test('empty source says what to do about it', () => {
    const result = compileProtocol('   ');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/template/);
  });
});

describe('describeCompileError', () => {
  test('prefixes the line when there is one', () => {
    expect(describeCompileError({ ok: false, error: 'Boom', line: 7 })).toBe('Line 7: Boom');
    expect(describeCompileError({ ok: false, error: 'Boom', line: null })).toBe('Boom');
    expect(describeCompileError({ ok: true })).toBe('');
  });
});

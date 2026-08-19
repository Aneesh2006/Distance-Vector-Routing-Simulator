/**
 * customLoader.js — user-written source text, in; a protocol plugin, out.
 *
 * The plugin contract (documented at the top of `Simulation.js`) is a plain
 * object with a handful of methods. Nothing about it needs a module system, a
 * build step or a bundler, so the loader does not pretend to have one: the
 * source *is* a function body, it is handed the two things a built-in imports —
 * the shared helpers and the `SIM` config — and it ends with `return protocol;`.
 *
 *     const protocol = { … };
 *     return protocol;
 *
 * ── Why there is no sandbox ──────────────────────────────────────────────
 *
 * `new Function` compiles onto the main thread with full access to the page,
 * exactly like typing into the browser's console. That is a deliberate choice
 * rather than an oversight, and the editor says so in as many words.
 *
 * A Web Worker was the obvious alternative and does not fit: the contract is
 * synchronous — `round()` and `tables()` are called during a snapshot, several
 * times per render — and a worker can only be spoken to asynchronously. Making
 * the contract async to sandbox one protocol would push a promise through the
 * simulation loop, the correctness scoring, the path finder and both table
 * views, for a threat model where the user is the attacker and the target is
 * their own tab.
 *
 * What the loader *does* guarantee is that a bad plugin cannot take the app down
 * on its way in: every failure below is caught and reported, and nothing is
 * registered until `validateProtocol` has also run it against a throwaway
 * network. The one thing neither can prevent is an infinite loop written into
 * `round()` after activation — the smoke test's round cap catches the common
 * case, but no amount of checking makes the halting problem decidable.
 */

import { ECMP_OPTION, SIM } from '../../config';
import {
  cloneTable,
  cloneTables,
  compareIds,
  formatCost,
  multipathRoute,
  nextHopsOf,
  tablesEqual,
} from '../helpers';

/**
 * Recursive freeze of a *copy*.
 *
 * The plugin gets `SIM` by value and cannot reach the real one: a custom
 * protocol that assigned to `config.timers.updateInterval` would otherwise
 * retune every other protocol in the app for the rest of the session, and the
 * bug would surface long after the edit that caused it.
 */
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value === null || typeof value !== 'object') return value;
  const copy = {};
  Object.entries(value).forEach(([key, inner]) => {
    copy[key] = frozenCopy(inner);
  });
  return Object.freeze(copy);
}

/**
 * The utilities a custom protocol can write against, under one name.
 *
 * These are the same functions the built-in plugins import, so user code can
 * follow the same idioms — `tablesEqual` for an honest `changed` flag,
 * `multipathRoute` for a route that installs more than one next hop, `compareIds`
 * so "10" sorts after "9". Frozen because it is shared between every compile.
 */
export const PROTOCOL_HELPERS = Object.freeze({
  compareIds,
  tablesEqual,
  cloneTable,
  cloneTables,
  multipathRoute,
  nextHopsOf,
  formatCost,
});

/**
 * The `SIM` config, by value, frozen all the way down — plus the one other
 * declaration in `config.js` a protocol legitimately reaches for.
 *
 * `ECMP_OPTION` is the shared equal-cost-multipath switch, declared once so the
 * three built-ins that offer it cannot drift into three spellings of the same
 * thing. A built-in opened in the editor imports it, so the editor has to be
 * able to supply it; and a protocol written from scratch that wants the same
 * switch should spell it the same way for the same reason.
 */
export const PROTOCOL_CONFIG = frozenCopy({ ...SIM, ECMP_OPTION });

/**
 * How many lines `new Function` adds above the body.
 *
 * V8 compiles `new Function(a, b, body)` as:
 *
 *     function anonymous(helpers,config
 *     ) {
 *     <body line 1>
 *
 * so a position reported at generated line 3 is the user's line 1. Only used to
 * translate a line number back for the error message; when the arithmetic lands
 * outside the source the line is dropped rather than guessed at.
 */
const WRAPPER_LINES = 2;

/**
 * Dig a source line out of whatever the browser attached to the error.
 *
 * Firefox puts it on `error.lineNumber`; V8 puts it in the stack as
 * `<anonymous>:LINE:COL`. Neither is guaranteed, hence the null.
 */
function lineOf(error, lineCount) {
  const inRange = (value) => {
    const line = value - WRAPPER_LINES;
    return line >= 1 && line <= lineCount ? line : null;
  };

  const stack = typeof error?.stack === 'string' ? error.stack : '';
  const match = stack.match(/<anonymous>:(\d+):\d+/);
  if (match) {
    const line = inRange(Number(match[1]));
    if (line !== null) return line;
  }
  if (Number.isFinite(error?.lineNumber)) {
    const line = inRange(Number(error.lineNumber));
    if (line !== null) return line;
  }
  return null;
}

/** `Error` -> the one sentence worth putting in front of the user. */
function messageOf(error) {
  if (error instanceof Error) {
    return error.name && !String(error.message).startsWith(error.name)
      ? `${error.name}: ${error.message}`
      : String(error.message || error.name);
  }
  return String(error);
}

const fail = (stage, error, lineCount) => ({
  ok: false,
  plugin: null,
  stage,
  error: messageOf(error),
  line: lineOf(error, lineCount),
});

/**
 * Compile source text into a plugin object.
 *
 * Three things can go wrong and they are reported apart, because the fix is
 * different for each: the text is not valid JavaScript (`stage: 'syntax'`), it
 * threw while being run (`'run'`), or it ran and handed back something that is
 * not a plugin (`'return'`).
 *
 * Nothing here checks whether the object *satisfies* the contract — that is
 * `validateProtocol`'s job, and keeping the two apart means a syntax error is
 * never reported as thirty missing fields.
 *
 * @param {string} source
 * @returns {{ ok: boolean, plugin: Object|null, stage?: string, error?: string,
 *             line?: number|null }}
 */
export function compileProtocol(source) {
  const text = String(source ?? '');
  const lineCount = text.split('\n').length;

  if (text.trim() === '') {
    return {
      ok: false,
      plugin: null,
      stage: 'syntax',
      error: 'There is no code to compile yet — load a template to start from.',
      line: null,
    };
  }

  let factory;
  try {
    // eslint-disable-next-line no-new-func
    factory = new Function('helpers', 'config', text);
  } catch (error) {
    return fail('syntax', error, lineCount);
  }

  let plugin;
  try {
    plugin = factory(PROTOCOL_HELPERS, PROTOCOL_CONFIG);
  } catch (error) {
    return fail('run', error, lineCount);
  }

  if (plugin === undefined || plugin === null) {
    return {
      ok: false,
      plugin: null,
      stage: 'return',
      error: 'The code ran but returned nothing. End it with `return protocol;`.',
      line: null,
    };
  }
  if (typeof plugin !== 'object' || Array.isArray(plugin)) {
    return {
      ok: false,
      plugin: null,
      stage: 'return',
      error:
        `The code returned a ${Array.isArray(plugin) ? 'array' : typeof plugin} rather ` +
        'than a protocol object.',
      line: null,
    };
  }

  return { ok: true, plugin, error: null, line: null };
}

/** `{ ok: false, … }` as one line of prose, for a status line or a test. */
export function describeCompileError(result) {
  if (!result || result.ok) return '';
  return result.line === null ? result.error : `Line ${result.line}: ${result.error}`;
}

export default compileProtocol;

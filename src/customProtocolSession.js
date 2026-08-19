/**
 * customProtocolSession.js — where a user-written protocol lives, and the one
 * path by which it becomes runnable.
 *
 * Two jobs, deliberately in one small file so neither can drift from the other:
 *
 *   1. **The pipeline.** compile → validate → register, in that order, with the
 *      failures of each stage reported apart. `App` and the editor modal both go
 *      through `attemptActivation`, so a protocol restored on page load has
 *      passed exactly the checks a protocol the user just clicked Activate on
 *      passed. A registry entry can only ever come from here.
 *
 *   2. **The storage.** `sessionStorage`, and nothing else. Not `localStorage`:
 *      code the user pasted once should not still be executing in three weeks'
 *      time on a machine they have forgotten about. Not the server, which never
 *      sees it. Not the share link — `scenario.js` encodes a protocol *id*, so
 *      the code cannot travel even by accident, and a link written while a
 *      custom protocol is selected opens on the default one for whoever
 *      receives it.
 *
 * Everything below survives storage being unavailable, because it is: Safari in
 * private mode throws from `sessionStorage.setItem`, and some managed browsers
 * remove the object outright. Losing persistence is a nuisance; a blank page is
 * not, so every access is guarded and failure is silent.
 */

import { compileProtocol, describeCompileError } from './engine/protocols/customLoader';
import { validateProtocol } from './engine/protocols/validateProtocol';
import {
  getCustomProtocol,
  registerCustomProtocol,
  unregisterCustomProtocol,
} from './engine/protocols';

/** The tab-scoped keys. Both are cleared together. */
export const SOURCE_KEY = 'customProtocol.source';
export const ACTIVE_KEY = 'customProtocol.wasActive';

/* ------------------------------------------------------------------ *
 * Storage, guarded
 * ------------------------------------------------------------------ */

function storage() {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch (error) {
    // Accessing the property itself throws when storage is disabled by policy.
    return null;
  }
}

function read(key) {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch (error) {
    return null;
  }
}

function write(key, value) {
  const store = storage();
  if (!store) return false;
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
    return true;
  } catch (error) {
    // Quota, or a private window that refuses writes. The in-memory copy in
    // `App` is still the live one, so this costs the user nothing until reload.
    return false;
  }
}

export const readStoredSource = () => read(SOURCE_KEY);

/**
 * An empty editor is not a draft, so it removes the key rather than storing a
 * blank one — otherwise "Clear" would leave a trace of itself behind, and the
 * next reload would restore an emptiness nobody typed.
 */
export const writeStoredSource = (source) =>
  write(SOURCE_KEY, source === null || source === '' ? null : source);
export const readWasActive = () => read(ACTIVE_KEY) === '1';
export const writeWasActive = (flag) => write(ACTIVE_KEY, flag ? '1' : null);

/** Explicit "Clear": both keys go, and so does any live registration. */
export function clearStoredProtocol(activeId) {
  if (activeId) unregisterCustomProtocol(activeId);
  write(SOURCE_KEY, null);
  write(ACTIVE_KEY, null);
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

/**
 * Source text in, a registered protocol out — or a precise account of why not.
 *
 * @param {string} source
 * @param {Object} [choices]  `{ register: false }` to check without registering
 * @returns {{ ok: boolean, plugin: Object|null, compileError: string|null,
 *             line: number|null, errors: string[], warnings: string[] }}
 */
export function attemptActivation(source, { register = true } = {}) {
  const empty = { plugin: null, compileError: null, line: null, errors: [], warnings: [] };

  const compiled = compileProtocol(source);
  if (!compiled.ok) {
    return {
      ...empty,
      ok: false,
      compileError: describeCompileError(compiled),
      line: compiled.line ?? null,
    };
  }

  const { errors, warnings } = validateProtocol(compiled.plugin);
  if (errors.length > 0) {
    return { ...empty, ok: false, plugin: compiled.plugin, errors, warnings };
  }

  if (!register) {
    return { ...empty, ok: true, plugin: compiled.plugin, warnings };
  }

  try {
    registerCustomProtocol(compiled.plugin);
  } catch (error) {
    // The only way here is an id the contract check somehow let through; report
    // it as a validation error rather than letting it escape as an exception.
    return { ...empty, ok: false, plugin: compiled.plugin, errors: [String(error.message)], warnings };
  }

  return { ...empty, ok: true, plugin: compiled.plugin, warnings };
}

/**
 * Bring back whatever this tab had before the reload.
 *
 * The source always comes back — never lose the user's code is the rule, and a
 * protocol that has stopped compiling because they were mid-edit when they hit
 * refresh is exactly when losing it would hurt most. It is only *re-registered*
 * if it was active before and still passes, and a failure is reported rather
 * than swallowed so the dropdown and the editor cannot disagree about what is
 * loaded.
 *
 * @returns {{ source: string|null, activeId: string|null, error: string|null }}
 */
export function restoreCustomProtocol() {
  const source = readStoredSource();
  if (source === null) return { source: null, activeId: null, error: null };
  if (!readWasActive()) return { source, activeId: null, error: null };

  const result = attemptActivation(source);
  if (result.ok) return { source, activeId: result.plugin.id, error: null };

  // It was active and no longer is. Say so, and stop claiming it is: otherwise
  // the next reload would try again and fail again in silence.
  writeWasActive(false);
  return {
    source,
    activeId: null,
    error:
      result.compileError ||
      result.errors[0] ||
      'The custom protocol from this tab could not be restored.',
  };
}

/** Is `id` a protocol this session registered? */
export function isCustomProtocolId(id) {
  return Boolean(id) && getCustomProtocol(id) !== null;
}

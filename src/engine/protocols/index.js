/**
 * protocols/index.js — the protocol registry.
 *
 * One array of built-ins, in the order the dropdown should show them. Adding a
 * protocol to the app is adding it here: the option panel, the table columns,
 * the packet colours, the help text and the convergence smoke test in
 * `Simulation.test.js` all read from the plugin, so nothing else needs a new
 * branch.
 *
 * ── Custom protocols ─────────────────────────────────────────────────────
 *
 * A second, dynamic half was added for the custom-protocol editor: a plugin the
 * user wrote in the browser is registered here at runtime, and from that moment
 * `getProtocol` resolves its id exactly like a built-in's. Two rules keep the
 * two halves from interfering:
 *
 *   - **`PROTOCOLS` still means "the built-ins", and is still the same array
 *     object.** Every existing import — the comparison runner's row list, the
 *     smoke test's `describe.each`, the suites that push a throwaway plugin onto
 *     it — keeps the meaning it had.
 *   - **A custom id may not collide with a built-in one.** `registerCustomProtocol`
 *     refuses rather than shadowing, because a link that says `dvr` has to keep
 *     meaning distance vector.
 *
 * Registration lives for as long as the tab does and no longer: nothing here
 * touches storage, and `scenario.js` never encodes anything but an id, so a
 * shared link can only ever name a protocol the receiving build already has.
 *
 * React cannot observe a `Map`, so the app holds its own copy of the custom list
 * for rendering; this registry is only what `Simulation` and `scenario.js`
 * resolve ids against.
 */

import { distanceVector } from './distanceVector';
import { dual } from './dual';
import { linkState } from './linkState';
import { pathVector } from './pathVector';
import { spanningTree } from './spanningTree';

export const PROTOCOLS = [distanceVector, linkState, pathVector, spanningTree, dual];

export const DEFAULT_PROTOCOL_ID = distanceVector.id;

/** id -> plugin, for the session only. Never written to, or read from, storage. */
const customProtocols = new Map();

/** True for an id one of the shipped plugins already owns. */
export function isBuiltinProtocolId(id) {
  return PROTOCOLS.some((candidate) => candidate.id === String(id));
}

/**
 * Add (or replace) a user-authored plugin.
 *
 * Replacing under the same id is the ordinary case — it is what "Validate &
 * Activate" does on every edit — and it is why this is a plain `set` rather than
 * an insert that refuses duplicates. What it will not do is shadow a built-in,
 * which would silently change what an existing share link means.
 *
 * @throws {Error} on a missing id, or one a built-in already owns
 */
export function registerCustomProtocol(plugin) {
  if (!plugin || typeof plugin.id !== 'string' || plugin.id.trim() === '') {
    throw new Error('A protocol needs a non-empty string id.');
  }
  const id = plugin.id;
  if (isBuiltinProtocolId(id)) {
    throw new Error(`"${id}" is a built-in protocol id — choose another.`);
  }
  customProtocols.set(id, plugin);
  return plugin;
}

/** Forget a custom plugin. Returns whether there was one to forget. */
export function unregisterCustomProtocol(id) {
  return customProtocols.delete(String(id));
}

/** The custom plugins, in registration order. */
export function customProtocolList() {
  return [...customProtocols.values()];
}

export function getCustomProtocol(id) {
  return customProtocols.get(String(id)) || null;
}

/**
 * Everything the dropdown and the comparison table should offer: the built-ins
 * first, in their declared order, then whatever the user has registered.
 *
 * Built-ins first on purpose — the list is also the teaching order, and a custom
 * protocol is an addition to it rather than a replacement for any of it.
 */
export function allProtocols() {
  return [...PROTOCOLS, ...customProtocols.values()];
}

/**
 * A custom protocol is looked up first.
 *
 * That ordering can never shadow a built-in, because `registerCustomProtocol`
 * rejects those ids outright; it only matters for a plugin registered while a
 * suite has pushed a throwaway of the same name onto `PROTOCOLS`, and the
 * live registration is the more specific answer there.
 */
export function getProtocol(id) {
  const custom = customProtocols.get(String(id));
  if (custom) return custom;
  const protocol = PROTOCOLS.find((candidate) => candidate.id === id);
  if (!protocol) throw new Error(`Unknown protocol "${id}".`);
  return protocol;
}

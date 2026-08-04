/**
 * helpers.js — the small, protocol-agnostic utilities every part of the engine
 * (and both views) needs.
 *
 * These lived in `DvrAlgorithm.js` until the protocol refactor. They were never
 * distance-vector-specific: id ordering, table comparison, lossless copying and
 * cost formatting are the same for link state, path vector, spanning tree and
 * DUAL. Pulling them out first means every later module can depend on them
 * without depending on a protocol.
 *
 * `DvrAlgorithm.js` re-exports everything here, so pre-refactor imports keep
 * working unchanged.
 */

/**
 * A small deterministic PRNG (mulberry32), for everything the asynchronous mode
 * has to decide by chance.
 *
 * `Math.random()` is banned in the engine. Jitter has to be reproducible: a demo
 * that behaves differently on every reload is not a demo, and a test that does
 * is a flake. One generator per simulation, seeded from the UI, so a scenario
 * can be shared as a topology plus a number.
 *
 * Mulberry32 rather than anything larger because the requirements here are
 * "uniform enough to jitter a timer" and "the same sequence everywhere",
 * and it is 32 bits of state and four lines.
 */
export function createRandom(seed) {
  let a = seed >>> 0; // eslint-disable-line no-bitwise
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0; // eslint-disable-line no-bitwise
    let t = Math.imul(a ^ (a >>> 15), 1 | a); // eslint-disable-line no-bitwise
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; // eslint-disable-line no-bitwise
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // eslint-disable-line no-bitwise
  };
}

/** Sort ids so "10" lands after "9" instead of after "1". */
export function compareIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

/* ------------------------------------------------------------------ *
 * Routes, and equal-cost multipath
 * ------------------------------------------------------------------ */

/**
 * A route, carrying its equal-cost next-hop set only when there is more than
 * one of them.
 *
 * Doc 07 §5 proposes changing the shape to `{ nextHops: [], cost }` with
 * `nextHop` as a getter. Two things argue against the getter: it does not
 * survive the spread in `cloneTable`, so the first snapshot would silently
 * flatten it into a plain field and the two could then drift; and one hop is
 * overwhelmingly the common case, so every entry of every protocol would carry
 * a one-element array for nothing. The primary hop therefore stays exactly the
 * plain `nextHop` field every consumer already reads — which is what the getter
 * was for — and `nextHops` appears only when the answer is genuinely a set.
 * `nextHopsOf` normalises the two cases for the few callers that care.
 *
 * The set is sorted with `compareIds`, so `tablesEqual` compares a stable list:
 * without that, the same two hops discovered in a different order would look
 * like a change and convergence would never be detected (doc 07 §5's last
 * bullet). It also makes `nextHop` the lowest id, which is the deterministic
 * choice `findPath` needs.
 */
export function multipathRoute(nextHop, cost, hops, extra = {}) {
  if (!hops || hops.length < 2) return { ...extra, nextHop, cost };
  const nextHops = [...hops].sort(compareIds);
  return { ...extra, nextHop: nextHops[0], nextHops, cost };
}

/** Every next hop a route installs, as a list; `[]` when it has none. */
export function nextHopsOf(route) {
  if (!route) return [];
  if (route.nextHops) return route.nextHops;
  return route.nextHop === null || route.nextHop === undefined ? [] : [route.nextHop];
}

const sameHops = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Two routing tables are equal when every destination has the same hops and cost.
 *
 * Deliberately only the hops and the cost: those two are the route, and every
 * protocol here produces them. A plugin that carries extra columns (an AS path,
 * a feasible distance) and needs them to count as a change compares them itself
 * inside `round()` — see rule 2 of the plugin contract.
 */
export function tablesEqual(a, b) {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => {
    const left = a[key];
    const right = b[key];
    return (
      Boolean(right) &&
      left.cost === right.cost &&
      left.nextHop === right.nextHop &&
      sameHops(nextHopsOf(left), nextHopsOf(right))
    );
  });
}

/**
 * Structural copy that, unlike JSON round-tripping, preserves every cost value.
 *
 * The spread keeps whatever extra columns a protocol added to the route, so one
 * clone works for all of them — but a spread is shallow, and array-valued
 * columns (path vector's AS path, DUAL's feasible successors) would otherwise
 * stay pointing at the engine's own arrays. A snapshot in React state must not
 * alias anything the engine can still rewrite (invariant 9), so those are
 * copied too.
 */
export function cloneTable(table) {
  const copy = {};
  Object.entries(table).forEach(([dest, route]) => {
    const clone = { ...route };
    Object.entries(clone).forEach(([key, value]) => {
      if (Array.isArray(value)) clone[key] = [...value];
    });
    copy[dest] = clone;
  });
  return copy;
}

export function cloneTables(tables) {
  const copy = {};
  Object.entries(tables).forEach(([id, table]) => {
    copy[id] = cloneTable(table);
  });
  return copy;
}

/** Render a cost for humans, collapsing anything at the ceiling to "∞". */
export function formatCost(cost, infinityCost) {
  if (cost === null || cost === undefined) return '∞';
  if (!Number.isFinite(cost) || cost >= infinityCost) return '∞';
  return String(cost);
}

/**
 * Render one table cell for a column declared by a protocol plugin.
 *
 * Protocols describe their columns as data (`{ key, label, format }`) so the
 * DOM table and the 3D panel can be driven from the same declaration. Keeping
 * the formatters here — rather than one copy per view — is what stops the two
 * tables slowly disagreeing about how an unreachable route looks.
 *
 * `row` is the whole route the cell came from. Only `hops` needs it — the
 * equal-cost set lives beside the primary hop rather than in the cell's own
 * field, so that a route with one hop stays exactly the shape it has always
 * been — and every other formatter ignores it.
 */
export function formatCell(format, value, infinityCost, row) {
  switch (format) {
    case 'cost':
      return formatCost(value, infinityCost);
    case 'id':
      return value === null || value === undefined ? '—' : String(value);
    case 'hops': {
      // `{ nextHop: value }` so a caller that has only the cell still gets the
      // single-hop answer rather than an empty one.
      const hops = nextHopsOf(row || { nextHop: value });
      return hops.length > 0 ? hops.join(', ') : '—';
    }
    case 'path':
      return Array.isArray(value) && value.length > 0 ? value.join(' → ') : '—';
    case 'list':
      return Array.isArray(value) && value.length > 0 ? value.join(', ') : '—';
    default:
      return value === null || value === undefined ? '—' : String(value);
  }
}

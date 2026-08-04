/**
 * groundTruth.js — what the topology *is*, independent of what any router
 * believes it to be.
 *
 * Every routing protocol in this simulator is an attempt to discover the
 * answers computed here. Having them on hand turns vague questions ("has it
 * converged?") into measurable ones ("how many of the 25 entries are still
 * wrong, and wrong in which way?").
 *
 * Floyd-Warshall rather than V runs of Dijkstra: one O(V³) pass, no priority
 * queue, and the `via` matrix reconstructs every path — so the same result
 * powers the correctness overlay, the path finder and the per-router scores.
 * At the sizes this app handles (≤ 30 routers ≈ 27k operations) the cubic term
 * is irrelevant, and the result is cached and reused across every round until
 * the topology changes.
 *
 * The only thing this module needs from a topology is three members:
 * `routerIds`, `isActive(id)` and `getLinks()`. Both today's `Network` and the
 * `Topology` object that replaces it satisfy that, so nothing here has to move
 * when the engine is refactored.
 */

/**
 * Key for an ordered pair. Router ids are generated (`nextFreeId`) or come from
 * presets, so they never contain the separator.
 */
export function pairKey(a, b) {
  return `${a}|${b}`;
}

/**
 * All-pairs shortest paths over the live topology.
 *
 * Costs are true distances, so unreachable is `Infinity` — not the protocol's
 * finite ceiling. The ceiling is a property of a protocol's arithmetic, not of
 * the network, and callers that care apply it themselves.
 *
 * @param {{ routerIds: string[], isActive: function, getLinks: function }} topology
 * @returns {{ dist: Map, via: Map, ids: string[] }} `via` holds the *first hop*
 *   from i toward j, which is what path reconstruction walks.
 */
export function allPairsShortestPaths(topology) {
  const ids = topology.routerIds.filter((id) => topology.isActive(id));
  const dist = new Map();
  const via = new Map();

  ids.forEach((a) => ids.forEach((b) => dist.set(pairKey(a, b), a === b ? 0 : Infinity)));

  topology.getLinks().forEach(({ source, destination, cost }) => {
    const forward = pairKey(source, destination);
    // Absent from `dist` means an endpoint is down: a link through a dead
    // router carries nothing, so it must not seed a distance.
    if (!dist.has(forward)) return;
    if (cost >= dist.get(forward)) return;
    const backward = pairKey(destination, source);
    dist.set(forward, cost);
    dist.set(backward, cost);
    via.set(forward, destination);
    via.set(backward, source);
  });

  ids.forEach((k) => {
    ids.forEach((i) => {
      const ik = dist.get(pairKey(i, k));
      if (ik === Infinity) return; // i cannot reach k — the whole row is a dead end
      ids.forEach((j) => {
        const candidate = ik + dist.get(pairKey(k, j));
        if (candidate >= dist.get(pairKey(i, j))) return;
        dist.set(pairKey(i, j), candidate);
        via.set(pairKey(i, j), via.get(pairKey(i, k)));
      });
    });
  });

  return { dist, via, ids };
}

/** True cost from `a` to `b`; `Infinity` when unreachable, down or unknown. */
export function truthCost(truth, a, b) {
  const cost = truth.dist.get(pairKey(a, b));
  return cost === undefined ? Infinity : cost;
}

/** The actual shortest walk from `a` to `b`, or `[]` when there is none. */
export function truthPath(truth, a, b) {
  const source = String(a);
  const destination = String(b);
  if (truthCost(truth, source, destination) === Infinity) return [];
  if (source === destination) return [source];

  const path = [source];
  let cursor = source;
  while (cursor !== destination) {
    const next = truth.via.get(pairKey(cursor, destination));
    // A finite cost always has a `via` chain; bail rather than spin if it does not.
    if (next === undefined || path.length > truth.ids.length) return [];
    path.push(next);
    cursor = next;
  }
  return path;
}

/* ------------------------------------------------------------------ *
 * Correctness overlay
 * ------------------------------------------------------------------ */

/** Every class an entry can hold, in "increasingly wrong" order. */
export const CORRECTNESS_CLASSES = [
  'optimal',
  'suboptimal',
  'stale-unreachable',
  'phantom',
  'looping',
];

const emptyTally = () =>
  CORRECTNESS_CLASSES.reduce((tally, name) => ({ ...tally, [name]: 0 }), {});

/**
 * Does following next hops from `from` toward `dest` revisit a router?
 *
 * A walk that dies at a router with no route is *not* reported as a loop: that
 * router's own entry is already classified wrong, and blaming everyone
 * upstream of it would count one fault many times over.
 */
function walkLoops(tables, from, dest, active) {
  const seen = new Set([from]);
  let current = from;

  while (current !== dest) {
    const route = tables[current] && tables[current][dest];
    const next = route ? route.nextHop : null;
    if (next === null || next === undefined || !active.has(next)) return false;
    if (seen.has(next)) return true;
    seen.add(next);
    current = next;
  }
  return false;
}

/**
 * Classify one table entry against ground truth. See doc `07 §2`.
 *
 * `infinityCost` is what makes "believes unreachable" decidable, and it cuts
 * both ways: a genuine path costlier than the ceiling is one no distance-vector
 * protocol can express, so believing it unreachable is the *right* answer, not
 * a stale one.
 */
function classifyEntry(tables, truth, from, dest, infinityCost, active) {
  const table = tables[from] || {};
  // A missing row means the router does not know the destination at all,
  // which is indistinguishable from believing it unreachable.
  const route = table[dest] || { nextHop: null, cost: infinityCost };

  const believesReachable =
    route.nextHop !== null &&
    route.nextHop !== undefined &&
    Number.isFinite(route.cost) &&
    route.cost < infinityCost;
  const trueCost = truthCost(truth, from, dest);
  const reallyReachable = trueCost < infinityCost;

  if (!believesReachable) return reallyReachable ? 'stale-unreachable' : 'optimal';
  // The loop test comes before the reachability test on purpose. Mid
  // count-to-infinity both are true, and "these two routers point at each
  // other" is the more useful diagnosis — it is also the signature that makes
  // distance vector distinguishable from link state in the comparison table.
  if (walkLoops(tables, from, dest, active)) return 'looping';
  if (!reallyReachable) return 'phantom';
  // Anything that is not exactly the true cost is suboptimal — including the
  // rarer too-cheap belief, where a router has not yet heard that its path
  // got more expensive.
  return route.cost === trueCost ? 'optimal' : 'suboptimal';
}

/**
 * Score every routing table against ground truth.
 *
 * Only active routers are scored, as sources and as destinations: a router that
 * is switched off has a table full of beliefs about a network it is not part
 * of, and counting those would make the meter drop for no reason the user can
 * act on. So the denominator is exactly `active²`.
 *
 * @param {Object} tables   `{ routerId: { dest: { nextHop, cost } } }`
 * @param {Object} truth    the result of `allPairsShortestPaths`
 * @param {Object} options  `{ infinityCost }`
 */
export function classifyTables(tables, truth, { infinityCost }) {
  const active = new Set(truth.ids);
  const entries = {};
  const routers = {};
  const byClass = emptyTally();
  let total = 0;
  let correct = 0;

  truth.ids.forEach((routerId) => {
    const perRouter = {};
    const tally = { total: 0, correct: 0, byClass: emptyTally() };

    truth.ids.forEach((dest) => {
      const name = classifyEntry(tables, truth, routerId, dest, infinityCost, active);
      perRouter[dest] = name;
      tally.total += 1;
      tally.byClass[name] += 1;
      byClass[name] += 1;
      if (name === 'optimal') tally.correct += 1;
    });

    entries[routerId] = perRouter;
    routers[routerId] = tally;
    total += tally.total;
    correct += tally.correct;
  });

  // Never round up to a flattering 100% while something is still wrong.
  const exact = total === 0 ? 100 : (correct / total) * 100;
  const percent = correct === total ? 100 : Math.min(99, Math.round(exact));

  return {
    entries,
    routers,
    totals: { entries: total, correct, wrong: total - correct, percent, byClass },
    loops: byClass.looping,
  };
}

/** Detached copy, so a snapshot in React state can never alias engine internals. */
export function cloneCorrectness(correctness) {
  if (!correctness) return null;
  const entries = {};
  Object.entries(correctness.entries).forEach(([routerId, row]) => {
    entries[routerId] = { ...row };
  });
  const routers = {};
  Object.entries(correctness.routers).forEach(([routerId, tally]) => {
    routers[routerId] = { ...tally, byClass: { ...tally.byClass } };
  });
  return {
    entries,
    routers,
    totals: { ...correctness.totals, byClass: { ...correctness.totals.byClass } },
    loops: correctness.loops,
  };
}

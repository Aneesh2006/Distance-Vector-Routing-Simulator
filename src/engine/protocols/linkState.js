/**
 * linkState.js — Link-State Routing (OSPF-style), RFC 2328 in miniature.
 *
 * Distance vector says "tell your neighbours what you know about everywhere".
 * Link state says "tell everyone what you know about yourself".
 *
 * Model
 * -----
 * Each router writes one **Link State Advertisement** describing its own
 * adjacencies, stamped with a sequence number and an age, and floods it to the
 * whole network. Every router therefore ends up holding the same **Link State
 * Database** — a complete map — and reads its routing table off a Dijkstra run
 * on its own copy of that map.
 *
 * The routing computation is entirely local. The only distributed part is
 * agreeing on the map, and the only rule that agreement needs is "a strictly
 * higher sequence number wins". Nobody ever relays a *conclusion*, so no
 * conclusion can circulate: link state cannot count to infinity, and its
 * convergence time is bounded by the network diameter rather than by the link
 * costs. That contrast with `distanceVector.js` is the whole point of having
 * both.
 *
 * Infinity
 * --------
 * `options.infinityCost` survives only as a display sentinel, so `formatCost`
 * has something to render as "∞". Nothing here counts upward, and raising the
 * ceiling changes no behaviour beyond how large a link cost may be — which is
 * itself worth demonstrating next to distance vector, where the ceiling is load
 * bearing.
 *
 * What is simplified, and why
 * ---------------------------
 * - Hellos are implicit: one per round on every up link (see `exchangeHellos`).
 * - The 7-state adjacency FSM is replaced by "a new adjacency gets the whole
 *   database once" (`resync`) — the part of OSPF's Exchange/Loading that the
 *   simulation cannot do without.
 * - Flooding is reliable because rounds are lossless, so there are no LS
 *   acknowledgements or retransmissions.
 * - No areas, no network-LSAs, no DR election: every link here is
 *   point-to-point, which is the only case those exist for.
 */

import { ECMP_OPTION, SIM } from '../../config';
import { compareIds, multipathRoute, tablesEqual } from '../helpers';

const { linkState: LS } = SIM;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Everything a router remembers, keyed by router id at the top level so the
 * whole network's state is one object the round can walk deterministically.
 *
 * `lsdb` is the only thing that is really *knowledge*; `tables` is a cached
 * derivation of it, and the other four are the flooding machinery.
 */
function createState() {
  return {
    /** routerId -> (lsaKey -> Lsa) : this router's own copy of the map */
    lsdb: new Map(),
    /** routerId -> the sequence number it last stamped on its own router-LSA */
    selfSeq: new Map(),
    /** routerId -> (lsaKey -> seq) for the summaries it originates */
    summarySeq: new Map(),
    /** routerId -> (lsaKey -> the neighbour it arrived from, or null if self-written) */
    pending: new Map(),
    /** routerId -> (neighbourId -> consecutive rounds with no hello heard) */
    silence: new Map(),
    /** routerId -> Set<neighbourId> owed a full database copy */
    resync: new Map(),
    /** routerId -> { dest: { nextHop, cost } } */
    tables: {},
  };
}

/**
 * Where an LSA sits in a database.
 *
 * A router-LSA is keyed by its origin, exactly as it was before areas existed —
 * one router, one router-LSA, whatever areas it touches. A summary is keyed by
 * all three things that make it distinct: who wrote it, which area they put it
 * in, and what it describes.
 */
const lsaKey = (lsa) =>
  lsa.type === 'summary' ? `S|${lsa.origin}|${lsa.area}|${lsa.dest}` : lsa.origin;

/** An LSA with no `type` is a router-LSA — which is what every LSA was. */
const isRouterLsa = (lsa) => Boolean(lsa) && lsa.type !== 'summary';

const mapFor = (store, routerId) => {
  let held = store.get(routerId);
  if (!held) {
    held = new Map();
    store.set(routerId, held);
  }
  return held;
};

const lsdbOf = (state, routerId) => mapFor(state.lsdb, routerId);
const pendingOf = (state, routerId) => mapFor(state.pending, routerId);
const silenceOf = (state, routerId) => mapFor(state.silence, routerId);

function resyncOf(state, routerId) {
  let held = state.resync.get(routerId);
  if (!held) {
    held = new Set();
    state.resync.set(routerId, held);
  }
  return held;
}

/**
 * A copy, because an LSA in flight must not age with the database it came from.
 * Phase 1 builds every message before phase 2 applies any of them (invariant
 * 1); sharing the object would let phase 2's ageing rewrite a message that has
 * already been "sent".
 */
const cloneLsa = (lsa) =>
  lsa.links === undefined ? { ...lsa } : { ...lsa, links: { ...lsa.links } };

/* ------------------------------------------------------------------ *
 * Areas (RFC 2328 §3, §12.4.3, §16.2)
 *
 * A single-area network — which is what every preset is until somebody says
 * otherwise — behaves exactly as it did before any of this existed: one area
 * means no border routers, no summaries and unrestricted flooding, so every
 * function below reduces to what it was.
 *
 * ── Three modelling decisions ────────────────────────────────────────────
 *
 * **An area is a property of a router, not of an interface.** Real OSPF puts
 * each interface in an area, which is what lets one router sit in two of them.
 * Per-router is one number instead of one per link, and the consequence is that
 * a link between two areas has to be assigned to one of them: it goes to the
 * **higher-numbered** area, so an ABR's link into area 1 is in area 1 and the
 * backbone keeps only backbone links. That is the real convention, and it is
 * deterministic for any pair.
 *
 * **A router is in every area its links are in**, plus its own. More than one
 * and it is an area border router: it holds two maps, runs one SPF over both,
 * and is the only thing that can carry a route across.
 *
 * **Containment is enforced by flooding, and the bidirectional check finishes
 * the job.** A router-LSA is only offered to neighbours that share an area with
 * its originator, so an area-1 LSA never reaches a pure area-0 router. An ABR's
 * own LSA does reach both areas and lists all of its links — including ones on
 * the far side — but a router that cannot see the *other* endpoint's LSA skips
 * that edge under §16.1. So the boundary needs no separate rule: it is the point
 * past which nobody can corroborate anything.
 * ------------------------------------------------------------------ */

/** The area an operator put this router in, or the backbone. */
function areaOf(options, routerId) {
  const perRouter = (options.routerOptions || {})[routerId];
  const value = perRouter && perRouter.area;
  return value === undefined ? LS.defaultArea : value;
}

/** Higher-numbered area wins, so the backbone keeps only backbone links. */
const linkAreaOf = (options, a, b) => Math.max(areaOf(options, a), areaOf(options, b));

/** Every area a router participates in: its own, plus every link's. */
function areasOf(topology, options, routerId) {
  const areas = new Set([areaOf(options, routerId)]);
  topology.neighborsOf(routerId).forEach((neighborId) => {
    areas.add(linkAreaOf(options, routerId, neighborId));
  });
  return areas;
}

/** Two routers can exchange an LSA only if they are in the same area. */
function shareArea(topology, options, a, b) {
  const mine = areasOf(topology, options, a);
  return [...areasOf(topology, options, b)].some((area) => mine.has(area));
}

const isBorderRouter = (topology, options, routerId) =>
  areasOf(topology, options, routerId).size > 1;

/** Is the network partitioned into areas at all? Nearly always no. */
function hasAreas(topology, options) {
  const rooms = (options.routerOptions || {});
  if (Object.keys(rooms).length === 0) return false;
  return topology.routerIds.some((id) => areaOf(options, id) !== LS.defaultArea);
}

/**
 * Give every router that exists a place to keep its state, and take it away
 * from routers that no longer do.
 *
 * A removed router's *LSA* is deliberately left in everyone else's database to
 * age out on its own (§5.5). That is the real behaviour, and with the
 * bidirectional check on it is also harmless: its neighbours stop advertising
 * it at once, so every edge into it is one-way and skipped.
 */
function syncRouters(state, topology) {
  topology.routerIds.forEach((routerId) => {
    lsdbOf(state, routerId);
    pendingOf(state, routerId);
    silenceOf(state, routerId);
    resyncOf(state, routerId);
    if (!state.selfSeq.has(routerId)) state.selfSeq.set(routerId, 0);
  });

  [...state.lsdb.keys()].forEach((routerId) => {
    if (!topology.has(routerId)) forgetRouter(state, routerId);
  });
}

function forgetRouter(state, routerId) {
  state.lsdb.delete(routerId);
  state.selfSeq.delete(routerId);
  state.summarySeq.delete(routerId);
  state.pending.delete(routerId);
  state.silence.delete(routerId);
  state.resync.delete(routerId);
  state.silence.forEach((heard) => heard.delete(routerId));
  state.resync.forEach((owed) => owed.delete(routerId));
}

/* ------------------------------------------------------------------ *
 * Origination (§5.2)
 * ------------------------------------------------------------------ */

/**
 * The adjacency set `routerId` would advertise right now.
 *
 * Two different failures are detected two different ways, which is the whole
 * reason the silence counter exists: a *link* going down is reported by the
 * router's own interface and is known instantly, while a *neighbour* going away
 * is only noticed when its hellos stop, `deadRounds` rounds later. Collapsing
 * the two would delete the sim's most instructive delay.
 */
function ownLinks(state, topology, options, routerId) {
  const links = {};
  if (!topology.isActive(routerId)) return links; // a down router advertises nothing
  const heard = silenceOf(state, routerId);

  topology.neighborsOf(routerId).forEach((neighborId) => {
    if ((heard.get(neighborId) || 0) >= options.deadRounds) return;
    links[neighborId] = topology.linkCost(routerId, neighborId);
  });
  return links;
}

const linksEqual = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/**
 * Write a fresh LSA and queue it for flooding.
 *
 * Sequence numbers only ever go up, and they are kept per router rather than
 * per LSA copy: a router that goes down and comes back must carry on counting
 * from where it left off, or its first LSA after the outage would be rejected
 * as stale by everyone still holding the old one.
 */
function originate(state, topology, options, routerId) {
  const seq = (state.selfSeq.get(routerId) || 0) + 1;
  state.selfSeq.set(routerId, seq);
  lsdbOf(state, routerId).set(routerId, {
    origin: routerId,
    seq,
    age: 0,
    links: ownLinks(state, topology, options, routerId),
  });
  pendingOf(state, routerId).set(routerId, null); // null: flood it to everyone
}

/* ------------------------------------------------------------------ *
 * Summary LSAs (type 3, RFC 2328 §12.4.3)
 * ------------------------------------------------------------------ */

/**
 * What an area border router says about the other side.
 *
 * A summary carries a **distance, not a topology**: "I can reach 7, for 4".
 * That one sentence is the whole lesson of areas, and it is worth stating
 * plainly — *inside* an area OSPF is a link-state protocol with a map that
 * cannot lie to you, and *between* areas it is distance vector. Everything that
 * follows from that follows here too: no router outside an area can check a
 * summary, area 0 has to be contiguous for the distances to compose, and with
 * the backbone rule switched off the sim will count to infinity between areas
 * exactly as `distanceVector.js` does within one.
 *
 * An unreachable destination is advertised at the infinity ceiling rather than
 * withdrawn, which is RFC 2328's own answer (LSInfinity) and saves inventing a
 * withdrawal mechanism the flooding rules do not have.
 */
function summaryLsa(origin, area, dest, cost, seq) {
  return { type: 'summary', origin, area, dest, cost, seq, age: 0, links: undefined };
}

/**
 * Everything this router would summarise, as `lsaKey -> Lsa`.
 *
 * Three filters. The first is structural; the second and third are RFC 2328
 * §12.4.3, and together they are the reason the backbone exists:
 *
 *   - nothing is summarised *into* an area that already contains it. That
 *     destination is described by the area's own router-LSAs — which is also why
 *     **area 0 has to be contiguous**: split it with a non-backbone area in the
 *     middle and the two halves stop being able to describe each other at all,
 *     because neither will summarise a destination the other considers its own.
 *     Real OSPF has exactly this hole, and virtual links are the patch.
 *   - **only a router attached to the backbone summarises anything.** An ABR
 *     joining areas 1 and 2 without touching area 0 is a misconfiguration, and
 *     ignoring it is what forces inter-area traffic the long way round through
 *     the backbone instead of taking a shortcut nobody can audit.
 *   - a route this router only heard *about* is not pushed back into the
 *     backbone. It came from there.
 */
function desiredSummaries(state, topology, options, routerId) {
  const wanted = new Map();
  if (!topology.isActive(routerId) || !isBorderRouter(topology, options, routerId)) return wanted;

  const table = state.tables[routerId] || {};
  const mine = areasOf(topology, options, routerId);
  if (options.strictBackbone && !mine.has(LS.defaultArea)) return wanted;

  mine.forEach((area) => {
    topology.routerIds.forEach((dest) => {
      if (dest === routerId) return;
      if (areasOf(topology, options, dest).has(area)) return;

      const route = table[dest];
      if (!route || route.nextHop === null || route.cost >= options.infinityCost) return;
      const hearsay = route.fromArea !== undefined && route.fromArea !== null;
      if (hearsay && options.strictBackbone && area === LS.defaultArea) return;

      const lsa = summaryLsa(routerId, area, dest, route.cost, 0);
      wanted.set(lsaKey(lsa), lsa);
    });
  });

  return wanted;
}

/**
 * Re-originate wherever a summary has stopped being true, and delete the ones
 * this router should no longer be making.
 *
 * Same shape as `reoriginateWhereNeeded` for router-LSAs, and for the same
 * reason: the answer is *derived* from the current routing table rather than
 * tracked with a dirty flag, so a change suppressed by the rate limit is not
 * lost — it is still true next round.
 */
function reoriginateSummaries(state, topology, options) {
  let changed = false;

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId)) return;
    const lsdb = lsdbOf(state, routerId);
    const seqs = mapFor(state.summarySeq, routerId);
    const wanted = desiredSummaries(state, topology, options, routerId);

    wanted.forEach((lsa, key) => {
      const held = lsdb.get(key);
      if (held && held.cost === lsa.cost && held.age < options.minLsIntervalRounds) return;
      if (held && held.cost === lsa.cost && held.age < options.lsaRefreshRounds) return;
      const seq = (seqs.get(key) || 0) + 1;
      seqs.set(key, seq);
      lsdb.set(key, { ...lsa, seq });
      pendingOf(state, routerId).set(key, null);
      changed = true;
    });

    // Withdrawal: a destination this router can no longer reach, or is no longer
    // allowed to talk about, goes out at the infinity ceiling so that every
    // holder of the old copy stops using it. Silence would leave the stale cost
    // in place until max age.
    lsdb.forEach((lsa, key) => {
      if (lsa.type !== 'summary' || lsa.origin !== routerId) return;
      if (wanted.has(key) || lsa.cost >= options.infinityCost) return;
      const seq = (seqs.get(key) || 0) + 1;
      seqs.set(key, seq);
      lsdb.set(key, { ...lsa, seq, age: 0, cost: options.infinityCost });
      pendingOf(state, routerId).set(key, null);
      changed = true;
    });
  });

  return changed;
}

/**
 * Re-originate wherever a router's own LSA has stopped describing it, or the
 * refresh timer has come round.
 *
 * "Needs a new LSA" is *derived* from the difference between the live adjacency
 * set and the LSA on file rather than tracked with a dirty flag, and that is
 * what makes the rate limit safe: an edit suppressed by `minLsIntervalRounds`
 * is not lost, it is simply still true next round and gets picked up then.
 */
function reoriginateWhereNeeded(state, topology, options) {
  let changed = false;

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId)) return;
    const own = lsdbOf(state, routerId).get(routerId);
    // MinLSInterval: at most one re-origination per router per interval, so a
    // flapping link cannot flood the network once per edit.
    if (own && own.age < options.minLsIntervalRounds) return;

    const links = ownLinks(state, topology, options, routerId);
    const describesItself = own && linksEqual(own.links, links);
    const dueForRefresh = own && own.age >= options.lsaRefreshRounds;
    if (describesItself && !dueForRefresh) return;

    originate(state, topology, options, routerId);
    changed = true;
  });

  return changed;
}

/* ------------------------------------------------------------------ *
 * Ageing and hellos (§5.5)
 * ------------------------------------------------------------------ */

/**
 * Every LSA in every database ages by one round; at `lsaMaxAgeRounds` it is
 * deleted. This is the *only* way a down router's LSA ever leaves the network,
 * which is what makes the `requireBidirectional` demo worth watching.
 */
function ageDatabases(state, topology, options) {
  let expired = false;

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId)) return; // a router that is off runs no timers
    const lsdb = lsdbOf(state, routerId);
    lsdb.forEach((lsa, key) => {
      lsa.age += 1;
      if (lsa.age < options.lsaMaxAgeRounds) return;
      lsdb.delete(key);
      pendingOf(state, routerId).delete(key);
      // A summary this router wrote is deleted here like any other and then
      // written again by the refresh below, which is the same cycle a router-LSA
      // goes through — the sequence number in `summarySeq` survives, so the
      // replacement is accepted everywhere rather than rejected as stale.
      expired = true;
    });
  });

  return expired;
}

/**
 * One hello per round on every up link, as RFC 2328's HelloInterval — modelled
 * implicitly rather than as visible messages.
 *
 * A hello on every link every round would triple the packet count and bury the
 * flooding wavefront, which is the thing actually worth watching. Nothing in
 * the protocol depends on their contents; all that matters is *when a router
 * notices silence*, and that is exactly what this counter records.
 */
function exchangeHellos(state, topology, options) {
  topology.routerIds.forEach((routerId) => {
    const heard = silenceOf(state, routerId);
    // Counters for links that no longer exist would keep a dead neighbour alive
    // in `ownLinks` forever.
    [...heard.keys()].forEach((neighborId) => {
      if (!topology.hasLink(routerId, neighborId)) heard.delete(neighborId);
    });

    if (!topology.isActive(routerId)) {
      heard.clear(); // it hears nothing while it is off, and relearns on revival
      return;
    }

    topology.neighborsOf(routerId).forEach((neighborId) => {
      const silent = heard.get(neighborId) || 0;
      if (!topology.isActive(neighborId)) {
        heard.set(neighborId, silent + 1);
        return;
      }
      // Heard from again after being written off: the adjacency is new, so the
      // database has to be re-exchanged. This is OSPF's Exchange/Loading, minus
      // the state machine.
      if (silent >= options.deadRounds) resyncOf(state, routerId).add(neighborId);
      heard.set(neighborId, 0);
    });
  });
}

/* ------------------------------------------------------------------ *
 * SPF (§5.4, RFC 2328 §16.1 simplified)
 * ------------------------------------------------------------------ */

const advertises = (lsdb, routerId, neighborId) => {
  const lsa = lsdb.get(routerId);
  return isRouterLsa(lsa) && lsa.links[neighborId] !== undefined;
};

/**
 * The edges leading out of `current`, as this database sees them.
 *
 * This one function is the difference between a link-state protocol that
 * black-holes on a stale LSA and one that does not:
 *
 *  - with `requireBidirectional` an edge exists only when *both* endpoints
 *    advertise it (RFC 2328 §16.1). A router that has gone away leaves an LSA
 *    claiming links its neighbours have already withdrawn, and those one-sided
 *    claims are skipped.
 *  - with the check off the database is read as an undirected graph — every
 *    adjacency anyone claims is believed, including a dead router's own — so
 *    paths keep being computed *through* the dead router until its LSA ages
 *    out. That is the failure the check exists to prevent, and it is worth
 *    seeing rather than reading about.
 */
function edgesFrom(lsdb, current, options) {
  const edges = new Map();
  const own = lsdb.get(current);

  if (isRouterLsa(own)) {
    Object.entries(own.links).forEach(([neighborId, cost]) => {
      if (options.requireBidirectional && !advertises(lsdb, neighborId, current)) return;
      edges.set(neighborId, cost);
    });
  }
  if (options.requireBidirectional) return edges;

  lsdb.forEach((lsa, key) => {
    // Summaries are distances, not adjacencies, and are no part of the graph.
    if (!isRouterLsa(lsa) || key === current || edges.has(key)) return;
    const cost = lsa.links[current];
    if (cost !== undefined) edges.set(key, cost);
  });
  return edges;
}

/** Cheapest router not yet settled; ties go to the lowest id so SPF is deterministic. */
function cheapestUnsettled(dist, settled) {
  let best = null;
  let bestCost = Infinity;
  dist.forEach((cost, routerId) => {
    if (settled.has(routerId)) return;
    const tied = cost === bestCost && best !== null && compareIds(routerId, best) < 0;
    if (cost < bestCost || tied) {
      best = routerId;
      bestCost = cost;
    }
  });
  return best;
}

/**
 * Which of two equally cheap first hops to keep.
 *
 * The incumbent — the hop this router already uses — wins, so equal-cost paths
 * do not flap from round to round; without that, convergence would never be
 * detected (invariant 4). Failing an incumbent, the lowest id, so the answer
 * does not depend on the order Dijkstra happened to settle things in.
 */
function betterHop(incumbent, held, proposed) {
  if (held === proposed) return held;
  if (incumbent !== undefined && incumbent !== null) {
    if (held === incumbent) return held;
    if (proposed === incumbent) return proposed;
  }
  return compareIds(held, proposed) <= 0 ? held : proposed;
}

/**
 * Dijkstra over one router's own database, rooted at itself.
 *
 * The next hop is *inherited from the parent* rather than recomputed: the first
 * hop of the path to a router is also the first hop of the path to everything
 * behind it. Getting that wrong is the classic link-state bug — the costs come
 * out right and the traffic still goes the wrong way.
 *
 * `hops` holds a *list* per destination so ECMP costs nothing structurally.
 * With the option off the list is always one long and the incumbent-sticky
 * tie-break decides it, exactly as before; with it on, equal-cost parents merge
 * their sets. Merging is safe here for a reason worth stating: every link costs
 * at least one, so a parent of a node is strictly closer to the root and has
 * therefore already settled by the time the node does — no equal-cost parent
 * can turn up afterwards and be missed.
 */
function spf(lsdb, rootId, options, previousTable) {
  const dist = new Map([[rootId, 0]]);
  const hops = new Map([[rootId, [rootId]]]);
  const settled = new Set();

  for (;;) {
    const current = cheapestUnsettled(dist, settled);
    if (current === null) break;
    settled.add(current);

    edgesFrom(lsdb, current, options).forEach((cost, neighborId) => {
      if (settled.has(neighborId)) return;
      const candidate = dist.get(current) + cost;
      const known = dist.get(neighborId);
      const proposed = current === rootId ? [neighborId] : hops.get(current);

      if (known === undefined || candidate < known) {
        dist.set(neighborId, candidate);
        hops.set(neighborId, [...proposed]);
        return;
      }
      if (candidate > known) return;

      const held = hops.get(neighborId);
      if (options.ecmp) {
        hops.set(neighborId, [...new Set([...held, ...proposed])]);
        return;
      }
      const incumbent = (previousTable[neighborId] || {}).nextHop;
      hops.set(neighborId, [betterHop(incumbent, held[0], proposed[0])]);
    });
  }

  return { dist, hops };
}

/** Self only. A router that is switched off is not routing anything. */
function darkTable(topology, routerId, options) {
  const table = {};
  topology.routerIds.forEach((dest) => {
    table[dest] =
      dest === routerId
        ? { nextHop: routerId, cost: 0 }
        : { nextHop: null, cost: options.infinityCost };
  });
  return table;
}

/**
 * The cheapest inter-area route to `dest`, out of every summary on file.
 *
 * Two rules from RFC 2328 §16.2, and both are visible in the demos:
 *
 *   - an **area border router** examines only the summaries it heard on the
 *     backbone. It has its own first-hand map of every area it is in, and
 *     believing another ABR's hearsay about one of them is how inter-area
 *     routing loops. Turning `strictBackbone` off is how to watch that happen.
 *   - the next hop is inherited from the path to the ABR, exactly as it is
 *     inherited from a parent inside the area: the first hop toward a summary's
 *     originator is the first hop toward everything the summary describes.
 */
function bestSummary(state, topology, options, routerId, dest, dist, hops) {
  const lsdb = lsdbOf(state, routerId);
  const onlyBackbone = options.strictBackbone && isBorderRouter(topology, options, routerId);
  let best = null;

  lsdb.forEach((lsa) => {
    if (lsa.type !== 'summary' || lsa.dest !== dest || lsa.origin === routerId) return;
    if (onlyBackbone && lsa.area !== LS.defaultArea) return;
    if (lsa.cost >= options.infinityCost) return; // LSInfinity: a withdrawal

    const toAbr = dist.get(lsa.origin);
    if (toAbr === undefined) return; // the ABR itself is out of reach
    const cost = toAbr + lsa.cost;
    if (cost >= options.infinityCost) return;
    // Cheapest wins; ties go to the lowest ABR id so the answer does not depend
    // on Map iteration order.
    if (best && (cost > best.cost || (cost === best.cost && compareIds(lsa.origin, best.abr) >= 0))) {
      return;
    }
    best = { cost, abr: lsa.origin, area: lsa.area, hops: hops.get(lsa.origin) };
  });

  if (!best) return null;
  return multipathRoute(best.hops[0], best.cost, options.ecmp ? best.hops : null, {
    // Which area's summary this came from, so an ABR re-advertising it can apply
    // the backbone rule — and so the inspector can say where a route came from.
    fromArea: best.area,
    viaBorder: best.abr,
  });
}

function tableFor(state, topology, options, routerId, previousTable) {
  if (!topology.isActive(routerId)) return darkTable(topology, routerId, options);

  const { dist, hops } = spf(lsdbOf(state, routerId), routerId, options, previousTable);
  const table = {};

  topology.routerIds.forEach((dest) => {
    if (dest === routerId) {
      table[dest] = { nextHop: routerId, cost: 0 };
      return;
    }
    const cost = dist.get(dest);
    // Intra-area first, and it wins whatever it costs (RFC 2328 §16): a path
    // computed from a map you hold beats a distance somebody quoted you, even a
    // cheaper one. That preference is also what stops summaries feeding summaries
    // and the areas counting to infinity at each other.
    if (cost !== undefined && cost < options.infinityCost) {
      const reached = hops.get(dest);
      table[dest] = multipathRoute(reached[0], cost, reached);
      return;
    }
    // A real path costlier than the ceiling is one the *display* cannot express,
    // so it reads as unreachable — the same call `shortestPath` makes, which is
    // what keeps the correctness meter agreeing with the table it scores.
    table[dest] =
      bestSummary(state, topology, options, routerId, dest, dist, hops) || {
        nextHop: null,
        cost: options.infinityCost,
      };
  });

  return table;
}

/**
 * Re-run SPF everywhere. Rebuilding the container rather than patching it is
 * what drops a deleted router out of the view instead of leaving a ghost entry.
 */
function recomputeAll(state, topology, options) {
  const previous = state.tables;
  const next = {};
  let changed = topology.routerIds.length !== Object.keys(previous).length;

  topology.routerIds.forEach((routerId) => {
    const previousTable = previous[routerId] || {};
    const table = tableFor(state, topology, options, routerId, previousTable);
    if (!tablesEqual(previousTable, table)) changed = true;
    next[routerId] = table;
  });

  state.tables = next;
  return changed;
}

/* ------------------------------------------------------------------ *
 * Flooding (§5.3)
 * ------------------------------------------------------------------ */

/**
 * The caption on the packet in the scene. Naming the origin is what turns a
 * stream of identical spheres into a visible wavefront spreading out from one
 * router.
 */
const floodLabel = (payload) => {
  if (payload.length !== 1) return `LSA×${payload.length}`;
  // A summary and a router-LSA are different kinds of claim, and the packet
  // caption is the only place the difference is visible in flight.
  return payload[0].type === 'summary'
    ? `SUM·${payload[0].dest}`
    : `LSA·${payload[0].origin}`;
};

/** Every LSA `routerId` should send `neighborId` this round, oldest rule first. */
function payloadFor(state, topology, options, routerId, neighborId) {
  const lsdb = lsdbOf(state, routerId);
  const outbound = pendingOf(state, routerId);
  const wholeDatabase = options.floodWholeDatabase || resyncOf(state, routerId).has(neighborId);

  const keys = wholeDatabase
    ? [...lsdb.keys()]
    : // OSPF never floods an LSA back out of the interface it arrived on: the
      // neighbour that sent it obviously has it already, and re-sending would
      // make every flood echo forever.
      [...outbound.keys()].filter((key) => outbound.get(key) !== neighborId);

  return keys
    .filter((key) => lsdb.has(key))
    .map((key) => lsdb.get(key))
    // Nor to the router that wrote it — the origin holds the authoritative copy
    // by definition, and it is the only one allowed to raise the sequence.
    .filter((lsa) => lsa.origin !== neighborId)
    // Flooding is scoped to an area (§13, §12.4.3). A router-LSA is offered only
    // where its originator is known; a summary only inside the area it was
    // injected into. This is the boundary.
    .filter((lsa) =>
      lsa.type === 'summary'
        ? areasOf(topology, options, neighborId).has(lsa.area)
        : shareArea(topology, options, lsa.origin, neighborId)
    )
    .sort((a, b) => compareIds(lsaKey(a), lsaKey(b)))
    .map(cloneLsa);
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

export const linkState = {
  id: 'ls',
  name: 'Link State (OSPF-style)',
  summary:
    'Routers flood their own adjacencies, build an identical map, and each run Dijkstra on it.',
  messageLabel: 'LSA',

  options: [
    {
      key: 'requireBidirectional',
      label: 'Bidirectional check (§16.1)',
      type: 'boolean',
      default: LS.requireBidirectional,
    },
    {
      key: 'floodWholeDatabase',
      label: 'Flood whole database each round',
      type: 'boolean',
      default: LS.floodWholeDatabase,
    },
    {
      key: 'strictBackbone',
      label: 'Backbone rule (§16.2)',
      type: 'boolean',
      default: LS.strictBackbone,
    },
    {
      key: 'deadRounds',
      label: 'Neighbour dead after (rounds)',
      type: 'number',
      default: LS.deadRounds,
      min: LS.minRounds,
      max: LS.maxRounds,
    },
    {
      key: 'lsaRefreshRounds',
      label: 'LSA refresh (rounds)',
      type: 'number',
      default: LS.lsaRefreshRounds,
      min: LS.minRounds,
      max: LS.maxRounds,
    },
    {
      key: 'lsaMaxAgeRounds',
      label: 'LSA max age (rounds)',
      type: 'number',
      default: LS.lsaMaxAgeRounds,
      min: LS.minRounds,
      max: LS.maxRounds,
    },
    {
      key: 'minLsIntervalRounds',
      label: 'Min gap between own LSAs',
      type: 'number',
      default: LS.minLsIntervalRounds,
      min: LS.minRounds,
      max: LS.maxRounds,
    },
    {
      key: 'infinityCost',
      label: 'Infinity (display only)',
      type: 'number',
      default: SIM.defaultInfinityCost,
      min: SIM.minInfinityCost,
      max: SIM.maxInfinityCost,
    },
    ECMP_OPTION,
  ],

  columns: [
    { key: 'cost', label: 'Cost', format: 'cost' },
    { key: 'nextHop', label: 'Next Hop', format: 'hops' },
  ],

  legend: [
    { colorKey: 'lsaPacket', label: 'LSA in flight' },
    { colorKey: 'lsdbStale', label: 'Database out of step' },
    { colorKey: 'spfTree', label: 'SPF tree (route tree overlay)' },
    { colorKey: 'areaBoundary', label: 'Area boundary' },
  ],

  help: [
    {
      heading: 'How link state works',
      items: [
        'Every router writes one advertisement — an LSA — describing only its ' +
          'own links: "I am 3, my neighbours are 2 at cost 6 and 4 at cost 2". ' +
          'It never describes anywhere else.',
        'That LSA is flooded hop by hop across the whole network. A router ' +
          'forwards a newly accepted LSA to every neighbour except the one it ' +
          'arrived from, so one LSA reaches a router d hops away in exactly d ' +
          'rounds and then stops.',
        'An arriving LSA is accepted only if its sequence number is strictly ' +
          'higher than the copy already held. That single rule is the whole ' +
          'correctness argument for flooding.',
        'Once the databases agree, every router runs Dijkstra on its own copy, ' +
          'rooted at itself. The routing computation is entirely local — the ' +
          'only distributed part is agreeing on the map.',
        'Hellos are modelled implicitly: one per round on every working link. ' +
          'A neighbour that misses "Neighbour dead after" of them is written ' +
          'off, which is how a router notices a *neighbour* dying as opposed to ' +
          'a link failing, which its own interface reports at once.',
      ],
    },
    {
      heading: 'Why it cannot count to infinity',
      items: [
        'Nobody ever relays a conclusion. A distance vector router repeats what ' +
          'its neighbour concluded, so a stale conclusion can circulate and ' +
          'climb; here a router only ever repeats a *fact* about someone else, ' +
          'stamped by the only router allowed to write it.',
        'So convergence is bounded by the network diameter and is independent ' +
          'of the link costs. Multiply every cost by ten and it still takes the ' +
          'same number of rounds — the distance-vector count would take ten ' +
          'times as many.',
        'The infinity setting is therefore only a display sentinel here: it is ' +
          'what makes an unreachable route render as ∞. Nothing counts up to ' +
          'it, and raising it changes no behaviour except how expensive a link ' +
          'is allowed to be.',
        'Transient loops still exist while two routers disagree about the map, ' +
          'but they last a round or two rather than a dozen.',
      ],
    },
    {
      heading: 'Distance vector vs link state',
      items: [
        'What a router knows: its neighbours’ conclusions — versus everyone’s raw facts.',
        'What it sends: one entry per destination, to neighbours only — versus ' +
          'its own adjacencies, flooded network-wide.',
        'How the table is built: Bellman-Ford, distributed over rounds — versus ' +
          'Dijkstra, locally, in one shot.',
        'Memory per router: neighbours × destinations — versus the whole map.',
        'Real protocols: RIP and IGRP — versus OSPF (RFC 2328) and IS-IS.',
      ],
    },
    {
      heading: 'Things worth trying',
      items: [
        'Load "Diameter chain", converge, and break a link in the middle. The ' +
          'two endpoints know at once and the news reaches the far end one hop ' +
          'per round. Switch to distance vector with split horizon off and ' +
          'break the same link to watch it count instead.',
        'Turn the bidirectional check off, then take a router in the middle of ' +
          'a chain down. Its neighbours stop advertising it after four rounds, ' +
          'but its own LSA still claims those links, so everyone keeps routing ' +
          'through a router that is not there — a black hole that lasts until ' +
          'the LSA hits max age. Turn the check back on and the same failure ' +
          'clears in about five rounds. That checkbox is RFC 2328 §16.1.',
        'Select a router and switch on "Show route tree": that is its shortest ' +
          'path tree. Click a different router and watch the tree change — same ' +
          'database, different root, different answer.',
        'Open the LSDB tab and step. The ages tick up every round and snap back ' +
          'to zero when a router re-originates, which it does every "LSA ' +
          'refresh" rounds even when nothing has happened.',
        'A settled network is not a silent one: at the refresh interval every ' +
          'router re-floods its LSA, so the round counter stops reporting ' +
          'CONVERGED for a few rounds. That is honest — LSAs really are in flight.',
        'Cut a network in two and the "LSDB in sync" meter stays below full ' +
          'forever, with one half tinted. That is not a bug either: the halves ' +
          'cannot talk, so there is no longer one map to agree on, and each ' +
          'side keeps the other\'s last known LSAs until they hit max age.',
        'Turn on "Equal-cost multipath" with "Equal-cost diamond" loaded and ' +
          'select router 1: the route tree now covers both sides of the diamond ' +
          'rather than picking one. OSPF has done this since RFC 2328 and it ' +
          'costs the SPF nothing — two parents at the same distance are simply ' +
          'both kept, and everything behind them inherits the pair.',
      ],
    },
    {
      heading: 'Areas: where link state becomes distance vector',
      items: [
        'Select a router and set its "OSPF area". Area 0 is the backbone and the ' +
          'default, so nothing changes until you move something out of it. Load ' +
          '"Two areas, one backbone" for a topology built to show this.',
        'A router-LSA is flooded only inside its own area. So a router in area 0 ' +
          'never holds the map of area 1 — it does not have the topology, and no ' +
          'amount of Dijkstra will give it one. The boundary is visible in the ' +
          'scene as a teal link, and the routers either side of it are marked ◆.',
        'What crosses the boundary instead is a **summary LSA**: an area border ' +
          'router, which is in both areas and holds both maps, injects into each ' +
          'one a plain "I can reach 7, for 4" about every destination in the ' +
          'other. Open the LSDB tab on a router inside an area and the rows ' +
          'beginning S are those.',
        'That is the whole lesson, and it is worth saying baldly: **inside an ' +
          'area OSPF is a link-state protocol, and between areas it is distance ' +
          'vector.** A summary is a distance you cannot check. Everything that ' +
          'follows from that follows here — the backbone has to be contiguous ' +
          'for the distances to compose, inter-area routes cannot be verified ' +
          'the way intra-area ones can, and the counters in Stats show inter-area ' +
          'convergence taking an extra round per boundary while the border router ' +
          'recomputes and re-summarises.',
        'Intra-area always beats inter-area, whatever it costs. A path you ' +
          'computed from a map you hold outranks a cheaper number somebody quoted ' +
          'you (§16) — and that preference is also what stops summaries feeding ' +
          'summaries and the two areas counting to infinity at each other.',
        'The "Backbone rule" checkbox is RFC 2328 §16.2: a border router believes ' +
          'summaries only from the backbone, which is what forces inter-area ' +
          'traffic through area 0. Build three areas in a line — 1, then 0, then ' +
          '2 — and it works, because area 0 is in the middle. Wire area 1 ' +
          'straight to area 2 instead and the shortcut is deliberately ignored. ' +
          'Turn the rule off and the shortcut starts working — and so does the ' +
          'loop it makes possible, because there is nothing left checking whose ' +
          'distance is whose. That is what virtual links exist to avoid.',
        'Not modelled: network-LSAs and DR election (every link here is ' +
          'point-to-point), external routes and ASBRs, stub and NSSA areas, and ' +
          'virtual links. Areas are assigned per router rather than per ' +
          'interface, so a link between two areas is counted in the ' +
          'higher-numbered one — which is where a real ABR\'s interface into ' +
          'area 1 would be anyway.',
      ],
    },
  ],

  createState(topology, options) {
    const state = createState();
    syncRouters(state, topology);
    reoriginateWhereNeeded(state, topology, options);
    recomputeAll(state, topology, options);
    return state;
  },

  /**
   * Areas are per-router configuration, like every other `routerControls` knob:
   * area 0 is the backbone and the default, so a network nobody has partitioned
   * is a network in which none of this exists.
   */
  routerControls: [
    {
      key: 'area',
      label: 'OSPF area',
      type: 'number',
      scope: 'router',
      default: LS.defaultArea,
      min: LS.minArea,
      max: LS.maxArea,
    },
  ],

  /**
   * Topology edits, per doc 02 §5.6.
   *
   * Only two events need a special case; everything else falls out of the
   * question origination already asks every round — "does my LSA still describe
   * me?" — which is why a re-cost, a link break and a new link need no branch.
   */
  onTopologyChange(state, topology, options, event = {}) {
    switch (event.type) {
      case 'removeRouter':
        forgetRouter(state, String(event.id));
        break;

      case 'addLink':
        // A new adjacency has to be seeded with the database that already
        // exists, or a router wired into a running network would only ever hear
        // about future changes and never about the map it just joined.
        resyncOf(state, String(event.a)).add(String(event.b));
        resyncOf(state, String(event.b)).add(String(event.a));
        break;

      case 'setRouterActive':
        if (event.active) revive(state, topology, String(event.id));
        break;

      case 'routerOption':
        // Moving a router between areas changes who is allowed to hear its LSA,
        // and its adjacencies are now in a different area from the one they were
        // in. Real OSPF tears those down and rebuilds them, which does two
        // things, and both are needed:
        //
        //   - the router **re-originates**, so the area it has just joined is
        //     flooded a copy with a higher sequence number. Its content has not
        //     changed, so nothing else would ever send it — and a router two hops
        //     into the new area would never learn the newcomer exists.
        //   - its neighbours **resync**, which is how it learns the map of the
        //     area it has joined rather than only what changes there next.
        if (event.key === 'area') {
          const moved = String(event.routerId);
          originate(state, topology, options, moved);
          topology.neighborsOf(moved).forEach((neighborId) => {
            resyncOf(state, moved).add(neighborId);
            resyncOf(state, neighborId).add(moved);
          });
        }
        break;

      default:
        break;
    }

    syncRouters(state, topology);
    reoriginateWhereNeeded(state, topology, options);
    recomputeAll(state, topology, options);
    // An area change is an edit like any other, and this is what makes it take
    // effect at once rather than at the next round: it arrives here as a
    // `routerOption` event and the summaries are rewritten from the new map.
    if (reoriginateSummaries(state, topology, options)) {
      recomputeAll(state, topology, options);
    }
  },

  /** One synchronous round: flood, then age, then re-originate, then re-run SPF. */
  round(state, topology, options) {
    syncRouters(state, topology);

    // ---- Phase 1: build every message before applying any of them ----
    const messages = [];
    topology.routerIds.forEach((routerId) => {
      if (!topology.isActive(routerId)) return; // a down router forwards nothing
      topology.neighborsOf(routerId).forEach((neighborId) => {
        if (!topology.isActive(neighborId)) return;
        const payload = payloadFor(state, topology, options, routerId, neighborId);
        if (payload.length === 0) return;
        messages.push({
          from: routerId,
          to: neighborId,
          kind: 'lsa',
          label: floodLabel(payload),
          payload,
        });
      });
    });

    // Both queues are consumed by the act of building the messages: an LSA is
    // forwarded exactly once, on the round after it arrived.
    state.pending.forEach((outbound) => outbound.clear());
    state.resync.forEach((owed) => owed.clear());

    // ---- Phase 2: apply ----
    let databaseChanged = false;
    messages.forEach(({ from, to, payload }) => {
      const lsdb = lsdbOf(state, to);
      payload.forEach((lsa) => {
        const key = lsaKey(lsa);
        const held = lsdb.get(key);
        // Strictly newer wins; an equal or older sequence number is discarded.
        if (held && lsa.seq <= held.seq) return;
        lsdb.set(key, lsa);
        pendingOf(state, to).set(key, from);
        databaseChanged = true;
      });
    });

    exchangeHellos(state, topology, options);
    if (ageDatabases(state, topology, options)) databaseChanged = true;
    if (reoriginateWhereNeeded(state, topology, options)) databaseChanged = true;

    let tableChanged = recomputeAll(state, topology, options);
    // Summaries are derived from the routing table, so they are written after
    // SPF and take effect next round — which is exactly what a real ABR does,
    // and the one round of lag is where inter-area convergence time goes.
    if (reoriginateSummaries(state, topology, options)) {
      databaseChanged = true;
      if (recomputeAll(state, topology, options)) tableChanged = true;
    }

    // A database change counts even when no table moves: a refresh rippling
    // through a settled network is real work, and reporting "converged" while
    // LSAs are still in flight would be a lie.
    return { messages, changed: databaseChanged || tableChanged };
  },

  tables(state) {
    return state.tables;
  },

  /* ---------------- what the UI shows ---------------- */

  metrics(state, topology, options) {
    const { inSync, total, areas } = agreement(state, topology, options);
    let queued = 0;
    state.pending.forEach((outbound) => {
      queued += outbound.size;
    });

    const rows = [
      { label: 'LSDB in sync', value: `${inSync} / ${total}` },
      { label: 'LSAs queued to flood', value: queued },
    ];
    // Only worth the rows once somebody has drawn a boundary; on a single-area
    // network they would read "1" and "0" for ever.
    if (hasAreas(topology, options)) {
      const borders = topology.routerIds.filter(
        (id) => topology.isActive(id) && isBorderRouter(topology, options, id)
      );
      let summaries = 0;
      state.lsdb.forEach((lsdb) => {
        lsdb.forEach((lsa) => {
          if (lsa.type === 'summary') summaries += 1;
        });
      });
      rows.push({ label: 'Areas', value: areas });
      rows.push({ label: 'Border routers', value: borders.join(', ') || '—' });
      rows.push({ label: 'Summary LSAs held', value: summaries });
    }
    return rows;
  },

  /**
   * Routers whose database does not match the majority *of their own area* are
   * tinted, so the flooding wavefront is visible as the tint draining away
   * rather than only as packets that have already gone — and border routers are
   * marked, since "which router is holding two maps?" is the first question an
   * area diagram raises.
   */
  decorations(state, topology, options) {
    const { signatures, consensus } = agreement(state, topology, options);
    const routers = {};
    const links = {};

    topology.routerIds.forEach((routerId) => {
      // Out of step wins over being a border router: one is a transient the user
      // is watching, the other is a fact about the diagram that is not going to
      // change while they look at it.
      if (signatures.has(routerId) && signatures.get(routerId) !== consensus(routerId)) {
        routers[routerId] = 'stale';
      } else if (isBorderRouter(topology, options, routerId)) {
        routers[routerId] = 'border';
      }
    });

    topology.getLinks().forEach(({ source, destination }) => {
      if (areaOf(options, source) === areaOf(options, destination)) return;
      links[[source, destination].sort(compareIds).join('|')] = 'areaBoundary';
    });

    return { routers, links };
  },

  /** The LSDB tab: what this router believes the map is, and how old it is. */
  inspect(state, topology, options, routerId) {
    const lsdb = state.lsdb.get(routerId);
    if (!lsdb) return [];

    const own = lsdb.get(routerId);
    const adjacencies = own
      ? Object.entries(own.links)
          .sort(([a], [b]) => compareIds(a, b))
          .map(([neighborId, cost]) => `${neighborId}@${cost}`)
      : [];
    const partitioned = hasAreas(topology, options);

    const rows = [...lsdb.entries()]
      .sort(([a], [b]) => compareIds(a, b))
      .map(([key, lsa]) => ({
        key,
        // A summary describes a destination rather than its originator's links,
        // so the row says which — "S 7 via 3" — instead of pretending they are
        // the same kind of statement.
        origin: lsa.type === 'summary' ? `S ${lsa.dest}←${lsa.origin}` : lsa.origin,
        area: lsa.type === 'summary' ? lsa.area : areaOf(options, lsa.origin),
        seq: lsa.seq,
        age: lsa.age,
        links: lsa.type === 'summary' ? `cost ${lsa.cost}` : Object.keys(lsa.links).length,
      }));

    const columns = [
      { key: 'origin', label: 'Origin', format: 'text' },
      ...(partitioned ? [{ key: 'area', label: 'Area', format: 'text' }] : []),
      { key: 'seq', label: 'Seq', format: 'text' },
      { key: 'age', label: 'Age', format: 'text' },
      { key: 'links', label: 'Links', format: 'text' },
    ];

    const summaryOf = (blocks) => blocks;
    return [
      {
        id: 'lsdb',
        label: 'LSDB',
        blocks: summaryOf([
          {
            type: 'rows',
            rows: [
              ...(partitioned
                ? [
                    { label: 'Area', value: areaOf(options, routerId) },
                    {
                      label: 'In areas',
                      value: [...areasOf(topology, options, routerId)]
                        .sort((a, b) => a - b)
                        .join(', '),
                    },
                  ]
                : []),
              { label: 'Own sequence', value: own ? own.seq : '—' },
              { label: 'Advertising', value: adjacencies.join(', ') || 'nothing' },
              { label: 'Entries held', value: rows.length },
              {
                label: 'Refresh due in',
                value: own
                  ? `${Math.max(0, options.lsaRefreshRounds - own.age)} rounds`
                  : '—',
              },
            ],
          },
          { type: 'table', columns, rows },
          {
            type: 'text',
            text:
              'One row per router this one has heard of. Age ticks up every ' +
              'round and resets when the origin re-originates; an entry nobody ' +
              `refreshes is deleted at ${options.lsaMaxAgeRounds}.` +
              (partitioned
                ? ' Rows beginning S are summaries: a cost quoted by a border ' +
                  'router, not a map you can check.'
                : ''),
          },
        ]),
      },
    ];
  },
};

/* ------------------------------------------------------------------ *
 * Database agreement
 * ------------------------------------------------------------------ */

/**
 * How far the databases have converged, by hashing each router's `(origin, seq)`
 * set and taking the most common answer as the consensus.
 *
 * The mode rather than a fixed reference router: while flooding is in progress
 * "the map most routers hold" is the useful yardstick, and it makes the meter
 * read 1/5 at the start and 5/5 at the end without anyone having to be right.
 */
function agreement(state, topology, options) {
  const signatures = new Map();
  /** area -> (signature -> how many routers hold it) */
  const byArea = new Map();

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId)) return;
    const lsdb = state.lsdb.get(routerId);
    // With areas, routers in different areas hold different databases on purpose,
    // so the question becomes "does everyone in *my* area agree?" — restricted to
    // the router-LSAs of that area, which is the map they are all supposed to
    // share, and asked once per area. With one area that is the whole database
    // asked once, and the answer is the one this meter has always given.
    const area = areaOf(options, routerId);
    const signature = lsdb
      ? [...lsdb.entries()]
          .filter(([, lsa]) => isRouterLsa(lsa) && areaOf(options, lsa.origin) === area)
          .sort(([a], [b]) => compareIds(a, b))
          .map(([key, lsa]) => `${key}:${lsa.seq}`)
          .join(',')
      : '';
    signatures.set(routerId, signature);
    const counts = byArea.get(area) || new Map();
    counts.set(signature, (counts.get(signature) || 0) + 1);
    byArea.set(area, counts);
  });

  /** The database most of an area holds — the useful yardstick mid-flood. */
  const consensusFor = new Map();
  let inSync = 0;
  byArea.forEach((counts, area) => {
    let best = null;
    let most = 0;
    // Insertion order is router-id order, so an even split resolves to the
    // lowest-id router's database rather than to whichever Map happened to win.
    counts.forEach((count, signature) => {
      if (count <= most) return;
      most = count;
      best = signature;
    });
    consensusFor.set(area, best);
    inSync += most;
  });

  const consensus = (routerId) => consensusFor.get(areaOf(options, routerId));
  return { signatures, consensus, inSync, total: signatures.size, areas: byArea.size };
}

/**
 * A router coming back up (§5.6). It re-originates with `seq += 1` and throws
 * its own database away: the network moved on while it was off, and starting
 * from a stale map would let it route on facts everyone else has already
 * retracted.
 */
function revive(state, topology, routerId) {
  lsdbOf(state, routerId).clear();
  pendingOf(state, routerId).clear();
  silenceOf(state, routerId).clear();
  topology.neighborsOf(routerId).forEach((neighborId) => {
    resyncOf(state, routerId).add(neighborId);
    resyncOf(state, neighborId).add(routerId);
  });
}

export default linkState;

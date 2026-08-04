/**
 * dual.js — DUAL, the Diffusing Update Algorithm (EIGRP), RFC 7868 §3.3.
 *
 * Split horizon and poisoned reverse are patches. They stop the two-router
 * version of count-to-infinity and fail on any larger loop, and the reason they
 * have to be patches is that a distance is a conclusion you cannot check: when
 * a neighbour says "I can reach D for 7", nothing in that sentence says whether
 * the 7 runs back through you.
 *
 * DUAL is the actual fix, and it is the only protocol here with a proof of loop
 * freedom *at every instant* rather than after convergence. The whole proof is
 * one inequality.
 *
 * ── The feasibility condition ────────────────────────────────────────────
 *
 *   FD — feasible distance: the lowest distance to a destination this router
 *        has achieved since the destination was last stable.
 *   RD — reported distance: what a neighbour says its own distance is.
 *   FC — a neighbour is usable when **RD < FD**, strictly.
 *
 * If a neighbour's own distance is strictly less than the best this router has
 * ever managed, that neighbour cannot be routing through this router: if it
 * were, its distance would already include the cost of reaching here, which is
 * at least this router's distance, which is at least FD. So the route is
 * loop-free without asking anybody. That is the entire argument, and it is why
 * DUAL needs no infinity ceiling to terminate.
 *
 * The cheapest neighbour passing the FC is the **successor** (the installed next
 * hop); any other neighbour passing it is a **feasible successor**, a backup
 * that has already been proved safe. When the successor dies and a feasible
 * successor exists the switch is instant, local and silent.
 *
 * When it dies and none exists, the router genuinely does not know which of its
 * neighbours route through it — so it stops guessing and asks. The destination
 * goes **ACTIVE**, a QUERY goes to every neighbour, and the router waits for a
 * REPLY from all of them. Neighbours with no answer of their own go ACTIVE and
 * query onward: the computation *diffuses* outward and the replies collapse
 * back inward. That bounded distributed search is what replaces counting.
 *
 * ── Three deliberate departures from doc 05 ──────────────────────────────
 *
 * **A router that is ACTIVE for a destination reports it unreachable.** Doc 05
 * §5.3 freezes the successor and leaves the old distance in place; real EIGRP
 * freezes the *reported* distance and keeps forwarding. Both are correct, and
 * both need the full four-state DUAL machine and its query-origin bookkeeping to
 * stay correct. Saying "I am recomputing, I have no route" instead buys the
 * whole loop-freedom argument in one line — nothing can be installed through a
 * router that is advertising nothing — at the price of a transient unreachable
 * where EIGRP would have a transient sub-optimal path. The successor field is
 * still frozen (it decides who gets an immediate reply, below); it is simply not
 * *used* while the answer is unknown.
 *
 * **A router does not query a neighbour whose query it has not yet answered.**
 * A neighbour that has just queried this router has already said it has no route
 * — asking it back is asking a question it answered in the asking. This is what
 * makes the A–B–C break take two rounds rather than four, and it is what lets a
 * router at the edge of the diffusing wave finish immediately instead of
 * bouncing one more query off the router that woke it up.
 *
 * **`rd` lives on the entry, and there is no separate `received` map.** Doc 05
 * §5.1 keeps both. They are the same numbers indexed two ways, and two copies of
 * one fact drift; the per-destination map is the one the feasibility condition
 * actually reads.
 */

import { SIM } from '../../config';

const DUAL = SIM.dual;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Unlike distance vector, a DUAL router's table is *not* a pure derivation of
 * what its neighbours last said: FD is a memory of what has already been
 * achieved, and the PASSIVE/ACTIVE state is a memory of what is currently being
 * asked. Those are the two things the feasibility condition is built out of, so
 * the entry is genuine per-router state and is stepped rather than rebuilt.
 * `tables` below it is the ordinary derived view, refreshed at the end of every
 * pass.
 */
function createState() {
  return {
    /** routerId -> (dest -> Entry) */
    topologyTable: new Map(),
    /** routerId -> (neighbourId -> messages queued for the next round) */
    outbox: new Map(),
    /** routerId -> { dest: Route } — the derived view the UI reads */
    tables: {},
  };
}

/**
 * @param {number} infinity the unreachable ceiling
 * @returns a destination nobody has heard anything about yet: no route, and an
 *   infinite feasible distance, which makes every finite report feasible. That
 *   is the correct starting point rather than a special case — a router with no
 *   route cannot be on anybody's path to anywhere.
 */
function newEntry(infinity) {
  return {
    fd: infinity,
    successor: null,
    cost: infinity,
    /** neighbourId -> the distance it last reported for this destination */
    rd: new Map(),
    state: 'passive',
    /** neighbours whose REPLY is still outstanding */
    awaiting: new Set(),
    /** neighbours that queried us and are owed a REPLY */
    queriers: new Set(),
    activeRounds: 0,
  };
}

function entriesOf(state, routerId) {
  let entries = state.topologyTable.get(routerId);
  if (!entries) {
    entries = new Map();
    state.topologyTable.set(routerId, entries);
  }
  return entries;
}

/** Read-only variant, for the views: asking a question must not create state. */
const peekEntries = (state, routerId) => state.topologyTable.get(routerId) || new Map();

function queue(state, routerId, neighborId, message) {
  let perNeighbor = state.outbox.get(routerId);
  if (!perNeighbor) {
    perNeighbor = new Map();
    state.outbox.set(routerId, perNeighbor);
  }
  const queued = perNeighbor.get(neighborId) || [];
  queued.push(message);
  perNeighbor.set(neighborId, queued);
}

function outboxEmpty(state) {
  let empty = true;
  state.outbox.forEach((perNeighbor) =>
    perNeighbor.forEach((queued) => {
      if (queued.length > 0) empty = false;
    })
  );
  return empty;
}

/** Back to knowing nothing — used when a router is switched off (invariant 12). */
function resetEntry(entry, infinity) {
  entry.fd = infinity;
  entry.successor = null;
  entry.cost = infinity;
  entry.rd.clear();
  entry.awaiting.clear();
  entry.queriers.clear();
  entry.state = 'passive';
  entry.activeRounds = 0;
}

/** What a change to this entry looks like from outside, for the `changed` flag. */
const signature = (entry) => `${entry.cost}|${entry.successor}|${entry.fd}|${entry.state}`;

/* ------------------------------------------------------------------ *
 * The core computation
 * ------------------------------------------------------------------ */

/**
 * What `neighborId` reports for `dest`, or undefined if it has said nothing.
 *
 * A directly attached destination is the one thing a router knows without being
 * told: the destination's own distance to itself is zero, and a router can see
 * its own interfaces. Since link costs are at least 1 and FD is at least 1 for
 * anything but the router itself, a reachable direct neighbour always satisfies
 * the feasibility condition — which is why a destination you are plugged into
 * can never send you ACTIVE.
 */
function reportedBy(entry, dest, neighborId) {
  if (neighborId === dest) return 0;
  return entry.rd.get(neighborId);
}

/**
 * The cheapest neighbour to route through, optionally filtered by the
 * feasibility condition.
 *
 * `requireFeasible` is the whole difference between the two situations DUAL
 * distinguishes: while PASSIVE only a neighbour that has *proved* it is not
 * behind us may be installed, whereas the recomputation at the end of a
 * diffusing computation may take the best of everything — every neighbour has
 * just answered, so there is nothing left to prove.
 */
function bestVia(topology, options, routerId, dest, entry, requireFeasible) {
  let best = null;

  topology.neighborsOf(routerId).forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) return;
    const rd = reportedBy(entry, dest, neighborId);
    if (rd === undefined) return;
    // RFC 7868 §3.3: strictly less than. Equality is not good enough — a
    // neighbour exactly as far away as our best could be measuring from the
    // other side of us.
    if (requireFeasible && rd >= entry.fd) return;

    const cost = topology.linkCost(routerId, neighborId) + rd;
    if (cost >= options.infinityCost) return;
    // Keep the incumbent on an exact tie so the successor does not flap
    // (invariant 4).
    if (!best || cost < best.cost || (cost === best.cost && neighborId === entry.successor)) {
      best = { neighborId, cost };
    }
  });

  return best;
}

/** The pre-verified backups: everyone else who passes the FC. */
function feasibleSuccessors(topology, options, routerId, dest, entry) {
  return topology.neighborsOf(routerId).filter((neighborId) => {
    if (neighborId === entry.successor) return false;
    if (!topology.canReach(routerId, neighborId)) return false;
    const rd = reportedBy(entry, dest, neighborId);
    if (rd === undefined || rd >= entry.fd) return false;
    return topology.linkCost(routerId, neighborId) + rd < options.infinityCost;
  });
}

/* ------------------------------------------------------------------ *
 * The finite state machine
 * ------------------------------------------------------------------ */

/**
 * PASSIVE: the ordinary case, and the one that should happen almost always.
 *
 * Two rules do all the work here, and doc 05 §5.3 flags both as easy to get
 * wrong in a way that changes the protocol completely:
 *
 *   - **FD only ever drops while PASSIVE.** If it were allowed to rise with the
 *     cost, the feasibility condition would stop proving anything, because a
 *     neighbour could satisfy it by being far away rather than by being in
 *     front. Loops become possible immediately.
 *   - **A destination with no feasible successor is not guessed at.** It goes
 *     ACTIVE and asks.
 *
 * There is a third rule here that doc 05 §5.3's pseudocode leaves out, and
 * without it the protocol converges on answers that are quietly wrong: a
 * feasible successor may be installed in silence **only while it is no worse
 * than the distance already proved achievable**, `cost <= FD`. Raise one link
 * cost on a ring and the reason is immediate — the old successor still reports
 * far less than FD, so it stays feasible however dear the route through it has
 * become, while the genuinely better neighbour reports *at* FD and can never
 * become feasible, because FD is not allowed to rise while PASSIVE. The route
 * would sit at 15 for ever with a 9 available. Asking instead costs one
 * diffusing computation and ends with FD reset to the truth.
 */
function passiveStep(state, topology, options, routerId, dest, entry) {
  const infinity = options.infinityCost;
  const best = bestVia(topology, options, routerId, dest, entry, true);

  if (best && best.cost <= entry.fd) {
    entry.successor = best.neighborId;
    entry.cost = best.cost;
    if (entry.cost < entry.fd) entry.fd = entry.cost;
    return;
  }

  if (entry.successor === null) {
    // Nothing to lose, so nothing to ask about. FD goes back to infinity with
    // the route: a router that admits it cannot reach a destination is not on
    // anyone's path to it, so there is nothing left for the FC to protect and
    // holding a stale bound would only lock out perfectly good future routes.
    entry.cost = infinity;
    entry.fd = infinity;
    return;
  }

  // The successor is gone or has become infeasible and nothing else qualifies.
  const ask = topology
    .neighborsOf(routerId)
    .filter((neighborId) => topology.canReach(routerId, neighborId))
    // A neighbour we owe a reply to has already told us it has no route, in the
    // act of asking. Querying it back would ask a question it has answered.
    .filter((neighborId) => !entry.queriers.has(neighborId))
    // And nobody is asked how to reach itself. Its answer is zero, it is
    // already counted as such, and a router holds no entry for its own id — so
    // the question would go unanswered until the stuck-in-active timer.
    .filter((neighborId) => neighborId !== dest);

  if (ask.length === 0) {
    // Nobody left to ask, so the diffusing computation is already over: take the
    // best of everything on file, with no feasibility test, and reset FD to it.
    const any = bestVia(topology, options, routerId, dest, entry, false);
    entry.successor = any ? any.neighborId : null;
    entry.cost = any ? any.cost : infinity;
    entry.fd = entry.cost;
    return;
  }

  entry.state = 'active';
  entry.activeRounds = 0;
  entry.awaiting = new Set(ask);
  // The successor field is frozen from here (it decides who gets an immediate
  // reply below), but the route is withdrawn: while the answer is unknown this
  // router advertises nothing for `dest`, so nothing can be installed through
  // it and no loop can form through it. See the header note.
  entry.cost = infinity;
  ask.forEach((neighborId) =>
    queue(state, routerId, neighborId, {
      kind: 'query',
      label: `QRY·${dest}`,
      payload: { [dest]: infinity },
    })
  );
}

/**
 * ACTIVE: wait for every reply, then recompute with no feasibility test at all.
 *
 * Dropping the test is safe precisely because the wait is over: every neighbour
 * has been asked and has answered, so every reported distance on file is
 * current, and any neighbour that was routing through this router has already
 * been told that it cannot (the query said so). FD is **reset** to the new cost
 * rather than minimised — without the reset a network whose costs genuinely
 * went up could never find a feasible successor again and would go ACTIVE for
 * ever.
 */
function activeStep(state, topology, options, routerId, dest, entry, tick) {
  const infinity = options.infinityCost;
  if (tick) entry.activeRounds += 1;

  if (entry.awaiting.size === 0) {
    const best = bestVia(topology, options, routerId, dest, entry, false);
    entry.successor = best ? best.neighborId : null;
    entry.cost = best ? best.cost : infinity;
    entry.fd = entry.cost;
    entry.state = 'passive';
    return;
  }

  if (entry.activeRounds > options.maxActiveRounds) {
    // Stuck-In-Active. Real EIGRP tears the silent neighbour relationships down
    // after three minutes; here the destination is simply declared unreachable,
    // which is what stops one wedged computation hanging the simulation.
    entry.awaiting.clear();
    entry.successor = null;
    entry.cost = infinity;
    entry.fd = infinity;
    entry.state = 'passive';
  }
}

/**
 * Pay off the queries we owe.
 *
 * A PASSIVE router answers everyone with its current distance. An ACTIVE one
 * answers everyone *except its own successor* straight away — that reply carries
 * the same infinity it is already advertising, so it tells the querier nothing
 * it could act on wrongly — and defers the successor's until the computation
 * collapses. Deferring only for the successor is what keeps the diffusing
 * computation both visible and deadlock-free: two routers can only wait on each
 * other if each is the other's successor, which is a two-hop routing loop, which
 * is the thing the feasibility condition rules out.
 */
function answerQueriers(state, routerId, dest, entry) {
  [...entry.queriers].forEach((neighborId) => {
    if (entry.state === 'active' && neighborId === entry.successor) return;
    entry.queriers.delete(neighborId);
    queue(state, routerId, neighborId, {
      kind: 'reply',
      label: `RPY·${dest}`,
      payload: { [dest]: entry.cost },
    });
  });
}

/**
 * Forget every neighbour that has become unhearable.
 *
 * Doing it here rather than in `onTopologyChange` covers every way a neighbour
 * can go away — link removed, router deleted, router switched off — with one
 * rule, and it is what stops a destination hanging until the Stuck-In-Active
 * timer when the router it was waiting on is unplugged (doc 05 §8).
 */
function purgeUnreachable(topology, routerId, entry) {
  entry.rd.forEach((_, neighborId) => {
    if (!topology.canReach(routerId, neighborId)) entry.rd.delete(neighborId);
  });
  entry.awaiting.forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) entry.awaiting.delete(neighborId);
  });
  entry.queriers.forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) entry.queriers.delete(neighborId);
  });
}

/** Add entries for new destinations, drop them for departed ones. */
function syncEntries(state, topology, options) {
  const ids = topology.routerIds;
  const live = new Set(ids);

  [...state.topologyTable.keys()].forEach((routerId) => {
    if (live.has(routerId)) return;
    state.topologyTable.delete(routerId);
    state.outbox.delete(routerId);
  });

  ids.forEach((routerId) => {
    const entries = entriesOf(state, routerId);
    [...entries.keys()].forEach((dest) => {
      if (!live.has(dest)) entries.delete(dest);
    });
    ids.forEach((dest) => {
      if (dest !== routerId && !entries.has(dest)) entries.set(dest, newEntry(options.infinityCost));
    });
  });
}

/**
 * One pass of the machine over every router and every destination.
 *
 * `tick` separates a round from a re-derivation: an edit re-runs the machine so
 * the endpoints react at once (invariant 7), but it must not age the
 * Stuck-In-Active counter, or editing a topology while a computation is running
 * would eventually declare it stuck without a single round having passed.
 */
function runMachine(state, topology, options, tick) {
  const infinity = options.infinityCost;
  syncEntries(state, topology, options);
  let changed = false;

  topology.routerIds.forEach((routerId) => {
    const entries = entriesOf(state, routerId);

    if (!topology.isActive(routerId)) {
      state.outbox.delete(routerId);
      entries.forEach((entry) => {
        const before = signature(entry);
        resetEntry(entry, infinity);
        if (signature(entry) !== before) changed = true;
      });
      return;
    }

    entries.forEach((entry, dest) => {
      const before = signature(entry);
      purgeUnreachable(topology, routerId, entry);
      if (entry.state === 'active') {
        activeStep(state, topology, options, routerId, dest, entry, tick);
      } else {
        passiveStep(state, topology, options, routerId, dest, entry);
      }
      answerQueriers(state, routerId, dest, entry);
      if (signature(entry) !== before) changed = true;
    });
  });

  deriveTables(state, topology, options);

  // A destination still being computed, or a message still queued, is work in
  // progress: reporting CONVERGED with a query about to leave would be a lie.
  if (!outboxEmpty(state)) changed = true;
  if (anyActive(state)) changed = true;
  return changed;
}

function anyActive(state) {
  let active = false;
  state.topologyTable.forEach((entries) =>
    entries.forEach((entry) => {
      if (entry.state === 'active') active = true;
    })
  );
  return active;
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/**
 * What `routerId` tells `neighborId` about everything it can reach.
 *
 * Split horizon is an efficiency measure here and nothing more — say so in the
 * help text. The feasibility condition already makes a route back through the
 * listener unusable, so suppressing it saves a line in a packet rather than
 * preventing a loop. That is the opposite of its role in distance vector, where
 * it is one of the two things standing between the network and counting to
 * infinity.
 */
function advertiseTo(state, topology, options, routerId, neighborId) {
  const payload = { [routerId]: 0 };

  peekEntries(state, routerId).forEach((entry, dest) => {
    if (!topology.has(dest)) return;
    if (entry.cost >= options.infinityCost) return;
    if (options.splitHorizon && entry.successor === neighborId && dest !== neighborId) return;
    payload[dest] = entry.cost;
  });

  return payload;
}

/** An update is the whole table, so a destination it omits is a withdrawal. */
function applyUpdate(state, topology, routerId, fromId, payload) {
  if (!topology.canReach(routerId, fromId)) return;
  peekEntries(state, routerId).forEach((entry, dest) => {
    const reported = payload[dest];
    if (reported === undefined) entry.rd.delete(fromId);
    else entry.rd.set(fromId, reported);
  });
}

/** A query and a reply each name exactly one destination. */
function applyDirected(state, topology, routerId, fromId, payload, kind) {
  if (!topology.canReach(routerId, fromId)) return;
  const entries = peekEntries(state, routerId);

  Object.entries(payload).forEach(([dest, reported]) => {
    const entry = entries.get(dest);
    if (!entry) return;
    entry.rd.set(fromId, reported);
    if (kind === 'reply') entry.awaiting.delete(fromId);
    // A query is also a statement — "I have lost this route" — so the reported
    // distance above matters as much as the question does.
    else entry.queriers.add(fromId);
  });
}

/* ------------------------------------------------------------------ *
 * Derived views
 * ------------------------------------------------------------------ */

function deriveTables(state, topology, options) {
  const infinity = options.infinityCost;
  const tables = {};

  topology.routerIds.forEach((routerId) => {
    const rows = {
      [routerId]: { cost: 0, nextHop: routerId, fd: 0, feasible: [], state: 'Passive' },
    };

    peekEntries(state, routerId).forEach((entry, dest) => {
      if (!topology.has(dest)) return;
      const unreachable = entry.cost >= infinity;
      rows[dest] = {
        cost: unreachable ? infinity : entry.cost,
        // A frozen successor is not an installed one: while the answer is being
        // computed there is no next hop, and the table says so rather than
        // pointing at a hop the router is not using.
        nextHop: unreachable ? null : entry.successor,
        fd: entry.fd,
        feasible: feasibleSuccessors(topology, options, routerId, dest, entry),
        state: entry.state === 'active' ? 'Active' : 'Passive',
      };
    });

    tables[routerId] = rows;
  });

  state.tables = tables;
}

/** Routers with at least one destination still being computed. */
function activeRouters(state, topology) {
  return topology.routerIds.filter((routerId) => {
    if (!topology.isActive(routerId)) return false;
    let active = false;
    peekEntries(state, routerId).forEach((entry) => {
      if (entry.state === 'active') active = true;
    });
    return active;
  });
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

export const dual = {
  id: 'dual',
  name: 'DUAL (EIGRP-style)',
  summary:
    'Distance vector with a proof: a neighbour closer than your own best distance cannot be routing through you.',
  messageLabel: 'UPD',

  options: [
    {
      key: 'splitHorizon',
      label: 'Split horizon (efficiency only)',
      type: 'boolean',
      default: DUAL.splitHorizon,
    },
    {
      key: 'maxActiveRounds',
      label: 'Stuck-in-active after (rounds)',
      type: 'number',
      default: DUAL.maxActiveRounds,
      min: DUAL.minRounds,
      max: DUAL.maxRounds,
    },
    {
      key: 'infinityCost',
      label: 'Infinity (display only)',
      type: 'number',
      default: SIM.defaultInfinityCost,
      min: SIM.minInfinityCost,
      max: SIM.maxInfinityCost,
    },
  ],

  /**
   * Five columns, and the last three are the protocol. FD is the bound the
   * feasibility condition is tested against, FS is who passed it, and State is
   * whether this router is currently sure.
   */
  columns: [
    { key: 'cost', label: 'Cost', format: 'cost' },
    { key: 'nextHop', label: 'Successor', format: 'id' },
    { key: 'fd', label: 'FD', format: 'cost' },
    { key: 'feasible', label: 'FS', format: 'list' },
    { key: 'state', label: 'State', format: 'text' },
  ],

  legend: [
    { colorKey: 'queryPacket', label: 'QUERY — "can anyone reach this?"' },
    { colorKey: 'replyPacket', label: 'REPLY — the answer coming back' },
    { colorKey: 'routerActive', label: 'Recomputing (ACTIVE)' },
  ],

  help: [
    {
      heading: 'The feasibility condition, in one inequality',
      items: [
        'FD, the feasible distance, is the lowest cost to a destination this ' +
          'router has managed since the destination was last settled. RD, the ' +
          'reported distance, is what a neighbour says its own cost is. A ' +
          'neighbour is usable when RD < FD — strictly less.',
        'Why that proves loop freedom: if the neighbour were routing through ' +
          'me, its distance would have to include the cost of getting to me, ' +
          'which is at least my distance, which is at least FD. So a neighbour ' +
          'closer than FD cannot be behind me. No timers, no ceiling, no ' +
          'agreement with anybody — one comparison against a number I already ' +
          'had.',
        'The cheapest neighbour passing the test is the successor, the next hop ' +
          'in the table. Everyone else who passes is a feasible successor: a ' +
          'backup already proved safe, listed in the FS column.',
        'FD is not the same as Cost. It only ever falls while the destination ' +
          'is PASSIVE, and it is reset — not minimised — when a diffusing ' +
          'computation finishes. Let it rise with the cost and the inequality ' +
          'stops proving anything; never reset it and a network whose costs ' +
          'genuinely went up can never find a feasible successor again.',
        'Which is why a feasible successor may be installed in silence only ' +
          'while it is no worse than FD. Raise one link cost on a ring and you ' +
          'can watch why: the old successor still reports far below FD, so it ' +
          'stays "feasible" however dear the route through it has become, while ' +
          'the genuinely better neighbour reports exactly at FD and — since FD ' +
          'cannot rise while PASSIVE — could never become feasible. A router ' +
          'about to get worse than it has proved it can do no longer knows it ' +
          'is on the best path, so it asks instead of guessing.',
      ],
    },
    {
      heading: 'Instant failover, and the diffusing computation',
      items: [
        'Load "Feasibility trap" and converge, then select router 1 and read ' +
          'its row for 4: cost 2 through 2, and an FS column listing 5 — a ' +
          'backup already proved safe. Delete link 1 ↔ 2 and the row changes in ' +
          'the same instant, before a single round is run and without one query ' +
          'about 4 being sent. That local, silent, immediate switch is why ' +
          'EIGRP was fast.',
        'Router 1 does go ACTIVE for destination *2* at the same moment, which ' +
          'is worth understanding rather than ignoring: it just lost its direct ' +
          'link, and no third party can possibly report a distance below what ' +
          'that link cost. Losing a directly attached neighbour always costs a ' +
          'diffusing computation for that neighbour. Losing the path *through* ' +
          'one need not, and that is the case the FS column is about.',
        'Now delete 1 ↔ 5 as well. The only way left is through 3, which reports ' +
          '5 — not less than FD, which is 2 — so it fails the test even though ' +
          'the route is perfectly good. Router 1 has no proof, so it stops ' +
          'guessing: the destination goes ACTIVE, a red QUERY goes out, a green ' +
          'REPLY comes back, and the route is installed at cost 6 with FD reset ' +
          'to 6. Two rounds.',
        'On a longer chain the wave is the whole point. Load "Diameter chain", ' +
          'converge, and break 5 ↔ 6: the queries spread outward one hop per ' +
          'round, reach a router that has an answer, and the replies collapse ' +
          'back inward. Routers still waiting are tinted orange. That is a ' +
          'bounded distributed search, and it is what replaces counting to ' +
          'infinity — compare it with the same break under distance vector with ' +
          'split horizon off.',
      ],
    },
    {
      heading: 'What the proof costs',
      items: [
        'The feasibility condition is sufficient, not necessary. A route that ' +
          'is genuinely loop-free can fail it — as router 3 does in ' +
          '"Feasibility trap" — and the router then goes ACTIVE for nothing. ' +
          'DUAL never loops and never counts, but it is not free, and a network ' +
          'with one dear backup path pays for it more often than one with ' +
          'several similar paths.',
        'While a destination is ACTIVE this simulation reports it unreachable ' +
          'rather than continuing to advertise the old distance. Real EIGRP ' +
          'freezes the reported distance and keeps forwarding through the old ' +
          'successor; saying "I am recomputing" instead is what makes the ' +
          'loop-freedom argument fit in a paragraph — nothing can be installed ' +
          'through a router that is advertising nothing. The price is a ' +
          'transient unreachable where EIGRP would have a transient detour.',
        'A computation that never collapses is declared Stuck-In-Active and the ' +
          'destination goes unreachable. Real EIGRP waits three minutes and then ' +
          'tears down the neighbour relationships that never answered; the ' +
          '"Stuck-in-active after" setting is the same guard in rounds, and it ' +
          'is why a wedged query can never hang the simulation.',
        'Split horizon is on the panel because EIGRP uses it, but here it is ' +
          'housekeeping, not correctness: turn it off and the tables settle on ' +
          'exactly the same answers, because the condition — not the silence — ' +
          'is what rules out the loop. That is precisely the claim distance ' +
          'vector cannot make.',
        'The metric is the app\'s additive link cost. Real EIGRP composes one ' +
          'from bandwidth, delay, load and reliability with configurable ' +
          'K-values (K1 = K3 = 1 by default, which reduces to bandwidth plus ' +
          'delay). That formula is arithmetic; the condition above is the ' +
          'lesson.',
      ],
    },
  ],

  createState(topology, options) {
    const state = createState();
    runMachine(state, topology, options, false);
    return state;
  },

  /**
   * Topology edits. Everything falls through to one machine pass, because
   * every edit reduces to the same two questions the machine already asks:
   * which neighbours can I still hear, and does my successor still pass the
   * test? A router that is switched off is the exception worth naming — it
   * forgets everything and is forgotten (invariant 12), which is handled in
   * the pass itself.
   */
  onTopologyChange(state, topology, options) {
    runMachine(state, topology, options, false);
  },

  /**
   * One synchronous round: send what was queued and what is currently believed,
   * then apply all of it, then step the machine.
   *
   * The explicit outbox is doc 05 §8's advice and it earns its keep: phase 1
   * stays a pure read of state, and a query queued by the machine in round N
   * travels in round N + 1 exactly like a distance-vector table change does.
   */
  round(state, topology, options) {
    // ---- Phase 1: build every message before applying any of them ----
    const messages = [];
    topology.routerIds.forEach((routerId) => {
      if (!topology.isActive(routerId)) return;
      const queued = state.outbox.get(routerId);

      topology.neighborsOf(routerId).forEach((neighborId) => {
        if (!topology.canReach(routerId, neighborId)) return;
        (queued ? queued.get(neighborId) || [] : []).forEach((message) =>
          messages.push({ from: routerId, to: neighborId, ...message })
        );
        messages.push({
          from: routerId,
          to: neighborId,
          kind: 'update',
          payload: advertiseTo(state, topology, options, routerId, neighborId),
        });
      });
    });
    state.outbox.clear();

    // ---- Phase 2: apply, then run the machine ----
    // Updates first, then replies, then queries: a query is the most recent
    // news a neighbour has about a destination, so it should be the last word.
    ['update', 'reply', 'query'].forEach((kind) => {
      messages.forEach((message) => {
        if (message.kind !== kind) return;
        if (kind === 'update') applyUpdate(state, topology, message.to, message.from, message.payload);
        else applyDirected(state, topology, message.to, message.from, message.payload, kind);
      });
    });

    return { messages, changed: runMachine(state, topology, options, true) };
  },

  tables(state) {
    return state.tables;
  },

  /* ---------------- what the UI shows ---------------- */

  metrics(state, topology) {
    let destinations = 0;
    let outstanding = 0;
    topology.routerIds.forEach((routerId) =>
      peekEntries(state, routerId).forEach((entry) => {
        if (entry.state !== 'active') return;
        destinations += 1;
        outstanding += entry.awaiting.size;
      })
    );

    return [
      { label: 'Routers recomputing', value: activeRouters(state, topology).length },
      { label: 'Destinations ACTIVE', value: destinations },
      { label: 'Replies outstanding', value: outstanding },
    ];
  },

  /** The orange tint draining away *is* the diffusing computation collapsing. */
  decorations(state, topology) {
    const routers = {};
    activeRouters(state, topology).forEach((routerId) => {
      routers[routerId] = 'active';
    });
    return { routers, links: {} };
  },

  /**
   * The DUAL tab: which destinations this router is still unsure about, who it
   * is waiting on, and who is waiting on it. The table columns already carry FD
   * and FS; what they cannot show is the shape of the outstanding conversation.
   */
  inspect(state, topology, options, routerId) {
    const entries = state.topologyTable.get(routerId);
    if (!entries) return [];

    const rows = [];
    entries.forEach((entry, dest) => {
      if (entry.state !== 'active') return;
      rows.push({
        key: dest,
        dest,
        awaiting: [...entry.awaiting].join(', ') || '—',
        owed: [...entry.queriers].join(', ') || '—',
        rounds: `${entry.activeRounds} / ${options.maxActiveRounds}`,
      });
    });

    const queued = state.outbox.get(routerId);
    let pending = 0;
    if (queued) queued.forEach((list) => (pending += list.length));

    return [
      {
        id: 'dual',
        label: 'DUAL',
        blocks: [
          {
            type: 'rows',
            rows: [
              { label: 'Destinations ACTIVE', value: rows.length },
              { label: 'Messages queued', value: pending },
              {
                label: 'Feasible successors held',
                value: topology.routerIds.reduce((total, dest) => {
                  const entry = entries.get(dest);
                  return (
                    total +
                    (entry ? feasibleSuccessors(topology, options, routerId, dest, entry).length : 0)
                  );
                }, 0),
              },
            ],
          },
          rows.length > 0
            ? {
                type: 'table',
                columns: [
                  { key: 'dest', label: 'Dest', format: 'id' },
                  { key: 'awaiting', label: 'Awaiting', format: 'text' },
                  { key: 'owed', label: 'Owes', format: 'text' },
                  { key: 'rounds', label: 'Rounds', format: 'text' },
                ],
                rows,
              }
            : {
                type: 'text',
                text: 'Every destination is PASSIVE — nothing is being recomputed.',
              },
        ],
      },
    ];
  },
};

export default dual;

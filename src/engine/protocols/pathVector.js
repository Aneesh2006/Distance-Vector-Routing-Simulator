/**
 * pathVector.js — Path Vector Routing (BGP-style), RFC 4271 in miniature.
 *
 * Distance vector advertises "I can reach D at cost 7". The listener has no way
 * to tell whether that route runs back through itself, which is the entire
 * cause of count-to-infinity and the reason split horizon and poisoned reverse
 * exist as patches.
 *
 * Path vector advertises "I can reach D at cost 7, via B → E → D". Loop
 * prevention becomes trivial and exact: *if I am already on that path, the
 * route is useless to me — discard it* (§9.1.2). No ceiling, no split horizon,
 * no poisoned reverse, and no timer anywhere in the correctness argument.
 *
 * Policy
 * ------
 * The second thing the path buys is **policy**. Once a router can see the whole
 * path it can prefer routes for reasons other than length, and BGP's decision
 * process puts those reasons first: LOCAL_PREF outranks path length, and path
 * length outranks anything resembling a cost. Cost is step 7 of about 13 in the
 * real thing. BGP is a policy protocol first and a shortest-path protocol a
 * distant second, which is why `preferCost` is off by default here — and why
 * turning it on is the fastest way to see what the ordering costs you.
 *
 * Infinity
 * --------
 * `options.infinityCost` is a display sentinel only, as it is under link state.
 * Nothing counts up to it; it is what makes an unreachable route render as ∞,
 * and it caps how expensive a usable path may be so that the routing tables and
 * the correctness meter agree about what "unreachable" means.
 *
 * One router = one AS. That keeps the model honest without inventing a second
 * layer of entities; the two-tier version is doc 03 §7's stretch goal.
 */

import { ECMP_OPTION, SIM } from '../../config';
import { compareIds, multipathRoute, nextHopsOf } from '../helpers';

const PV = SIM.pathVector;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Everything a router remembers is what each neighbour last told it; `tables`
 * is a cached derivation of that, refreshed whenever the advertisements or the
 * topology move.
 *
 * Doc 03 §4.1 also gives the state a `localPref` map. It does not live here:
 * LOCAL_PREF is *configuration*, the operator's policy rather than something
 * the router learned, so it rides in `options.routerOptions` where
 * `Simulation.setRouterOption` puts what the inspector collects. One copy, and
 * it resets with the protocol like every other setting.
 */
function createState() {
  return {
    /** routerId -> (neighbourId -> the table that neighbour last advertised) */
    received: new Map(),
    /** routerId -> { dest: Route } */
    tables: {},
  };
}

function receivedBy(state, routerId) {
  let held = state.received.get(routerId);
  if (!held) {
    held = new Map();
    state.received.set(routerId, held);
  }
  return held;
}

/** Everyone forgets what `routerId` told them, and it forgets everyone. */
function forgetRouter(state, routerId) {
  state.received.delete(routerId);
  state.received.forEach((held) => held.delete(routerId));
}

/**
 * The LOCAL_PREF `routerId` applies to everything it hears from `neighborId`.
 *
 * Sparse: a neighbour nobody has set a preference for is worth the default, so
 * the common case costs no storage and every router starts out impartial.
 */
function prefOf(options, routerId, neighborId) {
  const perRouter = (options.routerOptions || {})[routerId];
  const stored = perRouter && perRouter.localPref;
  const value = stored && stored[neighborId];
  return value === undefined ? PV.defaultLocalPref : value;
}

/* ------------------------------------------------------------------ *
 * The second tier: autonomous systems (doc 03 §7)
 *
 * One router is one AS until somebody says otherwise, which is what
 * `asOf` defaulting to the router's own id means — and on that default
 * every function below reduces exactly to the single-tier model, because
 * an AS path of ASes and an AS path of router ids are then the same list.
 *
 * Grouping two routers into one AS is where it gets interesting, because
 * it splits BGP in two:
 *
 *   - **eBGP**, between ASes. The sender prepends its own AS number, and
 *     the receiver rejects any path its own AS already appears in. That is
 *     the loop guard, and it is exact.
 *   - **iBGP**, inside one. Nothing is prepended — no AS is being
 *     traversed — so the guard has nothing to work with, and BGP replaces
 *     it with a blunter rule: a route learned from an iBGP peer is not
 *     passed to another one (RFC 4271 §9.2). That single sentence is why
 *     iBGP needs a full mesh, and why route reflectors exist to get out
 *     of paying for one.
 * ------------------------------------------------------------------ */

/** The AS a router belongs to; its own id unless an operator grouped it. */
function asOf(options, routerId) {
  const perRouter = (options.routerOptions || {})[routerId];
  const value = perRouter && perRouter.as;
  return value === undefined ? String(routerId) : String(value);
}

const isReflector = (options, routerId) =>
  Boolean(((options.routerOptions || {})[routerId] || {}).routeReflector);

/** Same AS on both ends: an internal session, where the path does not grow. */
const isInternal = (options, a, b) => asOf(options, a) === asOf(options, b);

/** Has anyone actually grouped two routers together? Nearly always no. */
function hasTiers(topology, options) {
  const seen = new Set();
  return topology.routerIds.some((id) => {
    const as = asOf(options, id);
    if (seen.has(as)) return true;
    seen.add(as);
    return false;
  });
}

/**
 * Prepend an AS to a path, unless it is already at the front.
 *
 * Real BGP does prepend the same AS more than once — deliberately, to make a
 * route look longer — but as a description of which ASes a packet crosses one
 * entry per AS is what the loop check reads, and collapsing the repeat is what
 * keeps two routers grouped into one AS from inflating every path through them.
 */
const prepend = (as, path) => (path[0] === as ? [...path] : [as, ...path]);

/* ------------------------------------------------------------------ *
 * The three protocol operations
 * ------------------------------------------------------------------ */

/**
 * What `routerId` tells `neighborId` this round.
 *
 * There is still no split horizon and no poisoned reverse — the path *is* the
 * loop guard and the receiver applies it, so advertising a route back to
 * someone already on its path is harmless; they drop it on sight. What the
 * neighbour's identity decides is not *whether* to speak but in which of BGP's
 * two dialects:
 *
 *   - **eBGP** (different AS): prepend this router's AS. The path grows here and
 *     nowhere else, which is why an eBGP session is the only place the loop guard
 *     gets any evidence.
 *   - **iBGP** (same AS): send the path untouched, because no AS is being
 *     crossed — and withhold anything learned from another internal peer, since
 *     an unchanged path cannot detect the loop that would make (§9.2). A route
 *     reflector is a router allowed to break that rule on purpose.
 *
 * On the default of one router per AS every session is external, so this reduces
 * to the single advertisement it always was.
 */
function advertiseTo(state, options, routerId, neighborId) {
  const table = state.tables[routerId] || {};
  const internal = isInternal(options, routerId, neighborId);
  const mine = asOf(options, routerId);
  const withhold = internal && options.ibgpNoReadvertise && !isReflector(options, routerId);
  const advertised = {};

  Object.entries(table).forEach(([dest, route]) => {
    if (route.nextHop === null) return; // no route, nothing to say
    if (withhold && route.viaIbgp) return;
    // The path is copied, not shared: phase 2 replaces every table, and a
    // message has to keep saying what was true when it was sent (invariant 1).
    advertised[dest] = {
      cost: route.cost,
      path: internal ? [...route.path] : prepend(mine, route.path),
    };
  });

  return advertised;
}

/** An advertisement is only kept while the listener is up and still linked to the sender. */
function receive(state, topology, routerId, fromId, advertised) {
  if (!topology.isActive(routerId) || !topology.hasLink(routerId, fromId)) return;
  receivedBy(state, routerId).set(fromId, advertised);
}

/**
 * BGP's decision process (§9.1.2), reduced to the four steps that mean anything
 * in a one-AS-per-router model.
 *
 * The *order* is the lesson, so it is written as one: preference, then length,
 * then cost — with `preferCost` swapping the middle two to show what an IGP
 * would have done instead.
 *
 * Returns false when nothing at all differs, so an equal candidate never
 * displaces the incumbent and the table cannot flap (invariant 4).
 */
function better(candidate, incumbent, options) {
  if (!incumbent) return true;
  if (candidate.pref !== incumbent.pref) return candidate.pref > incumbent.pref;

  const byLength = candidate.path.length - incumbent.path.length;
  const byCost = candidate.cost - incumbent.cost;
  // "Prefer eBGP over iBGP" is a real step of the decision process, and it sits
  // between path length and the metric. On the default of one router per AS every
  // session is external, so it is always a tie and never decides anything — it
  // only starts mattering once somebody groups two routers together.
  const byTier = Number(Boolean(candidate.viaIbgp)) - Number(Boolean(incumbent.viaIbgp));
  const order = options.preferCost
    ? [byCost, byLength, byTier]
    : [byLength, byTier, byCost];
  const decisive = order.find((difference) => difference !== 0);
  if (decisive !== undefined) return decisive < 0;

  // BGP's tie-breaks end at the lowest router id, so the answer never depends
  // on the order the neighbours happened to be walked in.
  return compareIds(candidate.nextHop, incumbent.nextHop) < 0;
}

function bestOf(candidates, options) {
  let best = null;
  candidates.forEach((candidate) => {
    if (better(candidate, best, options)) best = candidate;
  });
  return best;
}

/**
 * Pick the winner, and mark it when *policy* is what won.
 *
 * "Won by policy" is decided by asking the question twice — once for real and
 * once with every neighbour equally preferred — because that is exactly what
 * the claim means: this is not the route the length-and-cost rules would have
 * chosen. Nothing is asked twice while every preference is still equal, which
 * is the default state of the whole network.
 *
 * With ECMP on, every candidate the decision process could not separate from
 * the winner is installed alongside it. "Could not separate" means the three
 * steps that carry meaning — preference, path length, cost — because the only
 * thing left after those is the lowest-id tie-break, which exists to make the
 * answer deterministic rather than to make it better. That is also BGP's own
 * rule for multipath, and note that it is *equal cost*, not the same path: two
 * routes of the same length through different neighbours both count.
 */
function select(candidates, options) {
  const best = bestOf(candidates, options);
  if (!best) return null;

  const contested = candidates.some((candidate) => candidate.pref !== best.pref);
  const winner = !contested
    ? best
    : (() => {
        const neutral = bestOf(
          candidates.map((candidate) => ({ ...candidate, pref: 0 })),
          options
        );
        const decided =
          neutral.nextHop !== best.nextHop ||
          neutral.cost !== best.cost ||
          neutral.path.length !== best.path.length;
        return decided ? { ...best, accent: 'policy' } : best;
      })();

  if (!options.ecmp) return winner;

  const tied = candidates.filter(
    (candidate) =>
      candidate.pref === best.pref &&
      candidate.path.length === best.path.length &&
      candidate.cost === best.cost
  );
  // `bestOf` already ends at the lowest next-hop id, so the winner *is* the
  // first of the sorted set — which is what keeps `path[0] === nextHop` true,
  // since the path shown is the winner's own.
  return multipathRoute(
    winner.nextHop,
    winner.cost,
    tied.map((candidate) => candidate.nextHop),
    winner
  );
}

/**
 * Rebuild one router's table from the advertisements it currently holds.
 *
 * Deriving rather than patching is invariant 2, and it is what makes the
 * withdrawal machinery unnecessary: a neighbour that has stopped listing a
 * destination simply stops contributing a candidate for it, so the route
 * disappears the round the news arrives.
 */
function tableFor(state, topology, options, routerId, destinations) {
  const infinity = options.infinityCost;
  const held = state.received.get(routerId);
  const mine = asOf(options, routerId);
  const next = { [routerId]: { nextHop: routerId, cost: 0, path: [], pref: Infinity } };

  destinations.forEach((dest) => {
    if (dest === routerId) return;
    const candidates = [];

    topology.neighborsOf(routerId).forEach((neighborId) => {
      // False while either end is down, which is also what leaves a switched-off
      // router with nothing but the route to itself.
      if (!topology.canReach(routerId, neighborId)) return;
      const linkCost = topology.linkCost(routerId, neighborId);
      const pref = prefOf(options, routerId, neighborId);
      const internal = isInternal(options, routerId, neighborId);

      // The direct link is always a candidate, even before the neighbour has
      // said anything at all. It is locally originated rather than learned, so
      // it is never withheld from an internal peer however this router is
      // grouped — reaching your own AS is the IGP's job, not BGP's.
      if (neighborId === dest) {
        const destAs = asOf(options, dest);
        candidates.push({
          nextHop: dest,
          cost: linkCost,
          // No AS is crossed to reach something inside your own.
          path: destAs === mine ? [] : [destAs],
          pref,
          viaIbgp: false,
        });
      }

      const advertised = held && held.get(neighborId);
      const route = advertised && advertised[dest];
      if (!route) return;

      // The sender already prepended its AS if it had one to prepend, so the
      // path arrives finished.
      const path = route.path;
      // §9.1.2: "AS loop detection is done by scanning the full AS path, and
      // checking that the autonomous system number of the local system does not
      // appear in the AS path." One line, and it does the work that split
      // horizon, poisoned reverse and a finite infinity do between them in
      // distance vector — exactly, rather than approximately. It says nothing at
      // all about an internal session, which is what §9.2 is for.
      if (path.includes(mine)) return;
      if (path.length > options.maxPathLength) return;

      const cost = linkCost + route.cost;
      // A path dearer than the ceiling is one the display cannot express, so it
      // reads as unreachable — the same call `shortestPath` makes, which is what
      // keeps the correctness meter agreeing with the table it is scoring.
      if (cost >= infinity) return;

      candidates.push({ nextHop: neighborId, cost, path: [...path], pref, viaIbgp: internal });
    });

    // No `viaIbgp` on an unreachable route: there is no route, so there is no
    // session it could have been learned over, and a `false` there would be a
    // claim rather than an absence.
    next[dest] = select(candidates, options) || {
      nextHop: null,
      cost: infinity,
      path: [],
      pref: 0,
    };
  });

  return next;
}

/**
 * `helpers.tablesEqual` compares the hop and the cost, which is the whole route
 * under distance vector and link state. Here the path is both part of what a
 * router believes and part of what it advertises: two routes through the same
 * neighbour at the same cost can carry different paths, and reporting
 * "converged" while those were still moving would stop the round loop with the
 * AS Path column visibly changing under it.
 */
const samePath = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

function tablesMatch(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const left = a[key];
    const right = b[key];
    return (
      Boolean(right) &&
      left.cost === right.cost &&
      left.nextHop === right.nextHop &&
      samePath(nextHopsOf(left), nextHopsOf(right)) &&
      samePath(left.path, right.path)
    );
  });
}

/**
 * Re-derive every table. Rebuilding the container rather than patching it is
 * what drops a deleted router out of the view instead of leaving a ghost entry.
 */
function recomputeAll(state, topology, options) {
  const destinations = topology.routerIds;
  const previous = state.tables;
  const next = {};
  let changed = destinations.length !== Object.keys(previous).length;

  destinations.forEach((routerId) => {
    const table = tableFor(state, topology, options, routerId, destinations);
    if (!tablesMatch(previous[routerId] || {}, table)) changed = true;
    next[routerId] = table;
  });

  state.tables = next;
  return changed;
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

export const pathVector = {
  id: 'pv',
  name: 'Path Vector (BGP-style)',
  summary:
    'Routers advertise the whole path to a destination, and reject any path they are already on.',
  messageLabel: 'PATH',

  options: [
    {
      key: 'preferCost',
      label: 'Prefer total cost, IGP-style',
      type: 'boolean',
      default: PV.preferCost,
    },
    {
      key: 'maxPathLength',
      label: 'Longest AS path accepted',
      type: 'number',
      default: PV.maxPathLength,
      min: PV.minPathLength,
      max: PV.pathLengthCap,
    },
    {
      key: 'ibgpNoReadvertise',
      label: 'iBGP does not re-advertise (§9.2)',
      type: 'boolean',
      default: PV.ibgpNoReadvertise,
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
    { key: 'path', label: 'AS Path', format: 'path' },
  ],

  /**
   * LOCAL_PREF is per *neighbour*, not per router: policy is a statement about
   * who you are willing to route through, and a single number per router could
   * not express it.
   */
  routerControls: [
    /**
     * The AS number. Its default is the router's own id — one router, one
     * autonomous system — which is the model this protocol shipped with, so
     * giving two routers the same number is what turns the second tier on.
     */
    {
      key: 'as',
      label: 'AS number',
      type: 'number',
      scope: 'router',
      defaultFrom: 'routerId',
      min: PV.minAs,
      max: PV.maxAs,
    },
    {
      key: 'routeReflector',
      label: 'Route reflector',
      type: 'boolean',
      scope: 'router',
      default: false,
    },
    {
      key: 'localPref',
      label: 'LOCAL_PREF',
      type: 'number',
      scope: 'neighbor',
      default: PV.defaultLocalPref,
      min: PV.minLocalPref,
      max: PV.maxLocalPref,
      step: PV.localPrefStep,
    },
  ],

  legend: [
    { colorKey: 'pathPacket', label: 'Path advertisement in flight' },
    { colorKey: 'policyRoute', label: 'Route chosen by policy' },
    { colorKey: 'asBoundary', label: 'eBGP session (AS boundary)' },
  ],

  help: [
    {
      heading: 'How path vector works',
      items: [
        'Every advertisement carries the whole path, not just a distance: not ' +
          '"I can reach 4 for 7" but "I can reach 4 for 7, via 3 → 5 → 4". The ' +
          'AS Path column is that path.',
        'A router adds itself to the front of nothing and simply prepends the ' +
          'neighbour it heard the route from, then checks one thing: is my own ' +
          'id already in this path? If so the route would come straight back to ' +
          'me, so it is not considered at all (RFC 4271 §9.1.2).',
        'There is no split horizon here, and no poisoned reverse. Routers ' +
          'advertise everything to everyone — including routes that run back ' +
          'through the listener — because the listener will throw those away on ' +
          'sight. The guard moved from the sender to the receiver, and became ' +
          'exact instead of approximate.',
        'Best-path selection is an ordered list, stopping at the first step ' +
          'that decides: highest LOCAL_PREF, then shortest AS path, then lowest ' +
          'cost, then lowest neighbour id. Notice where cost sits — in real BGP ' +
          'it is step 7 of about 13.',
        'One router here is one autonomous system. Real BGP prepends an AS ' +
          'number rather than a router id, and everything above works the same ' +
          'way one level up.',
      ],
    },
    {
      heading: 'Why the Internet never counts to infinity',
      items: [
        'Load "Three in a line", converge, and delete link 2 ↔ 3. Router 1 ' +
          'holds a route to 3 with the path 2 → 3; router 2 withdraws it by ' +
          'simply not advertising it any more, and 1 has nothing else. Two ' +
          'rounds, and every loop-avoidance option is turned off because there ' +
          'are none to turn on.',
        'Do the same under distance vector with split horizon off and the cost ' +
          'climbs one hop at a time to the infinity ceiling. The difference is ' +
          'not that path vector is cleverer — it is that a distance is a ' +
          'conclusion you cannot check, and a path is one you can.',
        'So the infinity setting here is a display sentinel: it renders an ' +
          'unreachable route as ∞ and caps how dear a usable path may be. ' +
          'Nothing counts up to it.',
        'Withdrawals are implicit. Tables are re-derived from the neighbour ' +
          'tables held on file, so a destination a neighbour has stopped ' +
          'listing stops being a candidate the round the news lands.',
      ],
    },
    {
      heading: 'Path hunting',
      items: [
        'Load "Six-node ring", converge, break a link and step round by round ' +
          'with the AS Path column open. Routers try successively longer paths ' +
          'they had already been told about before settling — that is path ' +
          'hunting, the path vector analogue of counting to infinity.',
        'It terminates quickly, and the reason is visible in the column: every ' +
          'candidate path is loop-free, and there are only finitely many of ' +
          'them. Watch "Longest AS path" in Stats climb and then drop back.',
        'The one thing the path cannot prevent is a *transient* forwarding ' +
          'loop: if two routers lose their own route to a destination in the ' +
          'same instant, each may accept the other\'s last advertisement, which ' +
          'is loop-free as written but out of date. The next round they hear ' +
          'each other\'s new path, find themselves on it, and it is over.',
      ],
    },
    {
      heading: 'Policy beats shortest path',
      items: [
        'Select a router and its LOCAL_PREF fields appear, one per neighbour. ' +
          'Higher wins, and it is checked before path length and before cost, ' +
          'so it overrules both.',
        'Try it on "Textbook 5-node": converge, select router 2, and watch its ' +
          'route to 4 go via 5 for a cost of 7. Set LOCAL_PREF → 3 to 200 and ' +
          'the route moves to 3 for a cost of 8 — the expensive way round, on ' +
          'purpose. That is what the Internet actually does, and it surprises ' +
          'people who have only met shortest-path routing.',
        'A route won that way is marked with a pink edge in the table, and the ' +
          'link it uses is tinted in the scene. It will usually also be scored ' +
          'suboptimal by the correctness meter, which is fair: the meter ' +
          'measures distance, and policy is a decision to spend some.',
        'Turn on "Prefer total cost, IGP-style" to swap the middle two steps of ' +
          'the decision process. The protocol then agrees with the shortest ' +
          'path everywhere — which is exactly what BGP is not for.',
        'Equal-cost multipath is off by default here as it is in every real BGP ' +
          'implementation, and the decision process explains why: two routes are ' +
          'interchangeable only if nothing that carries meaning separated them. ' +
          'Turn it on and a tie has to survive preference, then length, then ' +
          'cost — everything except the final lowest-id step, which is there to ' +
          'make the answer deterministic rather than to make it better.',
      ],
    },
    {
      heading: 'Two tiers: inside an AS and between them',
      items: [
        'Select a router and it has an "AS number", defaulting to its own id — ' +
          'one router, one autonomous system, which is the model everything above ' +
          'describes. Give two neighbouring routers the *same* number and the ' +
          'second tier appears. Load "Two ASes, one peering" for a topology built ' +
          'for it.',
        'Sessions then come in two kinds, and the scene marks them: a purple link ' +
          'is eBGP, between ASes, and every other link is iBGP, inside ' +
          'one. The AS Path grows on an eBGP session and nowhere else, which is ' +
          'the whole point — a path is a list of ASes crossed, so crossing none ' +
          'adds nothing. A destination in your own AS shows an empty path.',
        'That leaves iBGP with no loop guard at all: an unchanged path cannot ' +
          'reveal a loop it never recorded. BGP\'s answer is blunt — a route ' +
          'learned from one internal peer is never passed to another (§9.2) — and ' +
          'the "iBGP does not re-advertise" checkbox is that rule.',
        'Watch what it costs. Put three routers in one AS in a line, with only ' +
          'the far one peering outside: the middle router learns the external ' +
          'route and refuses to pass it on, so the third router never hears about ' +
          'it at all. That is not a bug — it is why iBGP has to be a full mesh ' +
          'between every pair of routers in the AS, which is n²/2 sessions.',
        'The escape is the route reflector: tick it on the middle router and ' +
          'it starts relaying, marked ◈ in the list, and the third router learns ' +
          'the route. Real reflectors carry a CLUSTER_LIST and an ORIGINATOR_ID ' +
          'to detect the loops that reflecting reintroduces; those are not ' +
          'modelled here, so two reflectors pointed at each other will briefly ' +
          'inflate a cost between them before the cheaper route wins. That ' +
          'transient is the honest shape of the problem the real fields solve.',
        'The BGP tab on a selected router lists every session, which side of the ' +
          'boundary it is, and what this router will relay from it.',
        'One more real step of the decision process becomes live with two tiers: ' +
          'prefer eBGP over iBGP, checked after path length and before cost. With ' +
          'one router per AS every session is external, so it never decides ' +
          'anything and you would not know it was there.',
      ],
    },
  ],

  createState(topology, options) {
    const state = createState();
    recomputeAll(state, topology, options);
    return state;
  },

  /**
   * Topology edits, handled by forgetting exactly what has become unhearable
   * and re-deriving. Identical to distance vector's, because the question
   * ("whose advertisements can I still believe?") is the same one — only the
   * answer the advertisements carry has changed.
   *
   * Everything else falls through to the re-derive, which is also what makes a
   * LOCAL_PREF edit take effect at once rather than at the next round: it
   * arrives here as a `routerOption` event.
   */
  onTopologyChange(state, topology, options, event = {}) {
    switch (event.type) {
      case 'removeRouter':
        forgetRouter(state, String(event.id));
        break;
      case 'removeLink':
        receivedBy(state, String(event.a)).delete(String(event.b));
        receivedBy(state, String(event.b)).delete(String(event.a));
        break;
      case 'setRouterActive':
        // Invariant 12: a router that is down forgets its neighbours' tables and
        // they forget its, so it cannot come back up believing a lie.
        if (!event.active) forgetRouter(state, String(event.id));
        break;
      default:
        break;
    }
    recomputeAll(state, topology, options);
  },

  /** One synchronous round: snapshot every advertisement, then deliver, then derive. */
  round(state, topology, options) {
    // Phase 1 — build all outbound messages before anything is applied.
    const messages = [];
    topology.routerIds.forEach((routerId) => {
      if (!topology.isActive(routerId)) return;
      topology.neighborsOf(routerId).forEach((neighborId) => {
        if (!topology.isActive(neighborId)) return;
        // One advertisement per neighbour. It used to be one for everybody,
        // because there was nothing per-listener to decide; with two tiers there
        // is — whether to prepend, and whether to speak at all.
        const payload = advertiseTo(state, options, routerId, neighborId);
        if (Object.keys(payload).length === 0) return;
        messages.push({ from: routerId, to: neighborId, kind: 'path', payload });
      });
    });

    // Phase 2 — deliver, then re-derive every table.
    messages.forEach(({ from, to, payload }) => receive(state, topology, to, from, payload));
    const changed = recomputeAll(state, topology, options);

    return { messages, changed };
  },

  tables(state) {
    return state.tables;
  },

  /* ---------------- what the UI shows ---------------- */

  /**
   * Two numbers, both of which move during the demos this protocol exists for:
   * the longest path anyone is using climbs and falls back as path hunting runs
   * its course, and the policy count is zero until somebody sets a preference.
   */
  metrics(state, topology, options) {
    let longest = 0;
    let policy = 0;

    topology.routerIds.forEach((routerId) => {
      Object.values(state.tables[routerId] || {}).forEach((route) => {
        if (route.nextHop === null) return;
        longest = Math.max(longest, route.path.length);
        if (route.accent === 'policy') policy += 1;
      });
    });

    const rows = [
      { label: 'Longest AS path', value: longest },
      { label: 'Routes chosen by policy', value: policy },
    ];

    // Only once somebody has grouped two routers together. On the default of one
    // AS per router these would read "5 / 7 / 0", which describes nothing.
    if (hasTiers(topology, options)) {
      const systems = new Set(topology.routerIds.map((id) => asOf(options, id)));
      const internal = topology
        .getLinks()
        .filter(({ source, destination }) => isInternal(options, source, destination)).length;
      const reflectors = topology.routerIds.filter((id) => isReflector(options, id));
      rows.push({ label: 'Autonomous systems', value: systems.size });
      rows.push({
        label: 'Sessions (eBGP / iBGP)',
        value: `${topology.getLinks().length - internal} / ${internal}`,
      });
      rows.push({ label: 'Route reflectors', value: reflectors.join(', ') || 'none' });
    }

    return rows;
  },

  /**
   * Every first hop that is carrying traffic because of policy rather than
   * because it was the shortest way.
   *
   * Network-wide rather than per-selected-router: "these links are used for
   * reasons the shortest path would not have chosen" is the fact the LOCAL_PREF
   * demo exists to show. With every preference left at its default, nothing is
   * decorated at all.
   */
  decorations(state, topology, options) {
    const links = {};
    const routers = {};

    // The AS boundaries first, so a policy route drawn over one still wins: the
    // boundary is a fact about the diagram, and a policy route is the thing the
    // user just did.
    if (hasTiers(topology, options)) {
      topology.getLinks().forEach(({ source, destination }) => {
        if (isInternal(options, source, destination)) return;
        links[[source, destination].sort(compareIds).join('|')] = 'asBoundary';
      });
      topology.routerIds.forEach((routerId) => {
        if (isReflector(options, routerId)) routers[routerId] = 'reflector';
      });
    }

    Object.entries(state.tables).forEach(([routerId, table]) => {
      Object.values(table).forEach((route) => {
        if (route.accent !== 'policy' || route.nextHop === null) return;
        links[[routerId, route.nextHop].sort(compareIds).join('|')] = 'policy';
      });
    });

    return { links, routers };
  },

  /**
   * The BGP tab: which AS this router is in and what every session with its
   * neighbours actually is.
   *
   * Offered only once there are two tiers, because until then every session is
   * external and the table would say the same thing on every row.
   */
  inspect(state, topology, options, routerId) {
    if (!hasTiers(topology, options)) return [];

    const mine = asOf(options, routerId);
    const rows = topology.neighborsOf(routerId).map((neighborId) => {
      const internal = isInternal(options, routerId, neighborId);
      return {
        key: neighborId,
        peer: neighborId,
        as: asOf(options, neighborId),
        session: internal ? 'iBGP' : 'eBGP',
        // What this router will pass on from that peer, which is the rule that
        // surprises people.
        passesOn: internal && options.ibgpNoReadvertise && !isReflector(options, routerId)
          ? 'eBGP only'
          : 'everything',
      };
    });

    const learned = Object.values(state.tables[routerId] || {}).filter(
      (route) => route.nextHop !== null && route.viaIbgp
    ).length;

    return [
      {
        id: 'bgp',
        label: 'BGP',
        blocks: [
          {
            type: 'rows',
            rows: [
              { label: 'AS', value: mine },
              {
                label: 'Route reflector',
                value: isReflector(options, routerId) ? 'yes' : 'no',
              },
              { label: 'Routes learned by iBGP', value: learned },
            ],
          },
          {
            type: 'table',
            columns: [
              { key: 'peer', label: 'Peer', format: 'id' },
              { key: 'as', label: 'AS', format: 'text' },
              { key: 'session', label: 'Session', format: 'text' },
              { key: 'passesOn', label: 'Relays', format: 'text' },
            ],
            rows,
          },
          {
            type: 'text',
            text:
              'An eBGP session is where the AS path grows, and therefore the only ' +
              'place the loop check gets any evidence. Across an iBGP session the ' +
              'path is unchanged — so a route heard from one internal peer is not ' +
              'passed to another, unless this router is a route reflector.',
          },
        ],
      },
    ];
  },
};

export default pathVector;

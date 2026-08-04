/**
 * ospfAreas.test.js — OSPF areas and summary LSAs (stage 9.8, doc 02 §3).
 *
 * The claim this stage exists to make is uncomfortable and worth pinning down:
 * **inside an area OSPF is a link-state protocol, and between areas it is
 * distance vector.** So the tests come in three groups —
 *
 *   - *containment*: a router-LSA does not leave its area, and a router outside
 *     the area genuinely has no map of it;
 *   - *summaries*: a border router quotes a cost across the boundary, the cost
 *     is right, and intra-area still wins whatever it costs;
 *   - *the consequences*: the backbone rule is what makes inter-area distances
 *     compose, and switching it off lets the areas count to infinity at each
 *     other exactly as `distanceVector.js` does inside one.
 *
 * The first test is the safety property everything else rests on: with every
 * router in area 0, none of this exists.
 */

import { Simulation } from '../Simulation';
import { Topology } from '../Topology';
import { SIM } from '../../config';

const LS = SIM.linkState;

/**
 * 1–2–3 backbone, 3–4–5 hanging off it, 1–6–7 on the other side.
 * Areas are assigned per test, so the same wiring serves every case.
 */
const TREE = {
  1: [
    { neighbor: '2', cost: 1 },
    { neighbor: '3', cost: 2 },
    { neighbor: '6', cost: 1 },
  ],
  2: [{ neighbor: '3', cost: 1 }],
  3: [{ neighbor: '4', cost: 1 }],
  4: [{ neighbor: '5', cost: 1 }],
  6: [{ neighbor: '7', cost: 1 }],
  5: [],
  7: [],
};

/** A chain, for the simplest possible boundary. */
const CHAIN = {
  A: [{ neighbor: 'B', cost: 1 }],
  B: [{ neighbor: 'C', cost: 1 }],
  C: [{ neighbor: 'D', cost: 1 }],
  D: [],
};

function ls(adjacency, areas = {}, overrides) {
  const simulation = new Simulation(new Topology(adjacency), 'ls', overrides);
  Object.entries(areas).forEach(([routerId, area]) => {
    simulation.setRouterOption(routerId, 'area', area);
  });
  simulation.runToConvergence();
  return simulation;
}

const database = (simulation, routerId) => simulation.state.lsdb.get(routerId);

const routerLsaOrigins = (simulation, routerId) =>
  [...database(simulation, routerId).values()]
    .filter((lsa) => lsa.type !== 'summary')
    .map((lsa) => lsa.origin)
    .sort();

/**
 * The *live* summaries a router holds.
 *
 * A withdrawal is a summary re-issued at the infinity ceiling (RFC 2328's
 * LSInfinity) rather than a deletion, because flooding has no withdrawal
 * mechanism — so it lingers in the database until max age while meaning nothing,
 * and `withdrawnIn` is how a test asks about that half.
 */
const summariesIn = (simulation, routerId) =>
  [...database(simulation, routerId).values()]
    .filter((lsa) => lsa.type === 'summary' && lsa.cost < simulation.infinityCost)
    .map((lsa) => `${lsa.origin}→${lsa.dest}@${lsa.cost}/a${lsa.area}`)
    .sort();

const withdrawnIn = (simulation, routerId) =>
  [...database(simulation, routerId).values()]
    .filter((lsa) => lsa.type === 'summary' && lsa.cost >= simulation.infinityCost)
    .map((lsa) => `${lsa.origin}→${lsa.dest}`)
    .sort();

/** The summaries a router *wrote*, as opposed to the ones it merely holds. */
const originatedBy = (simulation, routerId) =>
  summariesIn(simulation, routerId).filter((entry) => entry.startsWith(`${routerId}→`));

const costsFrom = (simulation, routerId) =>
  Object.fromEntries(
    Object.entries(simulation.tables()[routerId]).map(([dest, route]) => [dest, route.cost])
  );

/* ------------------------------------------------------------------ *
 * One area: none of this exists
 * ------------------------------------------------------------------ */

describe('a network nobody has partitioned', () => {
  test('holds no summaries and has no border routers', () => {
    const simulation = ls(TREE);
    simulation.routerIds.forEach((id) => {
      expect(summariesIn(simulation, id)).toEqual([]);
    });
    expect(simulation.metrics().map((row) => row.label)).toEqual([
      'LSDB in sync',
      'LSAs queued to flood',
    ]);
  });

  test('decorates nothing, so the area machinery is invisible', () => {
    const simulation = ls(TREE);
    expect(simulation.decorations().links).toEqual({});
    expect(simulation.decorations().routers).toEqual({});
  });

  test('every router holds every router-LSA, and every cost is the true one', () => {
    const simulation = ls(TREE);
    simulation.routerIds.forEach((id) => {
      expect(routerLsaOrigins(simulation, id)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    });
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('setting every router to area 0 explicitly changes nothing', () => {
    const plain = ls(TREE);
    const stated = ls(
      TREE,
      Object.fromEntries(Object.keys(TREE).map((id) => [id, LS.defaultArea]))
    );
    expect(costsFrom(stated, '1')).toEqual(costsFrom(plain, '1'));
    expect(summariesIn(stated, '1')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Containment
 * ------------------------------------------------------------------ */

describe('a router-LSA does not leave its area', () => {
  // A and B in the backbone, C and D in area 1. B–C is the boundary.
  const areas = { C: 1, D: 1 };

  test('a backbone router holds no map of the other area', () => {
    const simulation = ls(CHAIN, areas);
    // B is the border router and legitimately holds both. A does not.
    expect(routerLsaOrigins(simulation, 'A')).toEqual(['A', 'B']);
    expect(routerLsaOrigins(simulation, 'B')).toEqual(['A', 'B', 'C', 'D']);
  });

  test('and the far area holds no map of the backbone', () => {
    const simulation = ls(CHAIN, areas);
    expect(routerLsaOrigins(simulation, 'D')).toEqual(['B', 'C', 'D']);
    // B's LSA is there — B is in area 1 too — but it names A, and without A's own
    // LSA the bidirectional check (§16.1) refuses the edge. That is the boundary,
    // and it needs no rule of its own.
    expect(database(simulation, 'D').get('B').links.A).toBe(1);
  });

  test('which routers count as border routers is decided by the wiring', () => {
    const simulation = ls(CHAIN, areas);
    const borders = simulation.metrics().find((row) => row.label === 'Border routers');
    // A link between two areas belongs to the higher-numbered one, so B's link to
    // C puts B in area 1 as well — and C, already in area 1, is not on a boundary.
    expect(borders.value).toBe('B');
    expect(simulation.decorations().routers.B).toBe('border');
    expect(simulation.decorations().routers.C).toBeUndefined();
  });

  test('the boundary link is decorated, and only that link', () => {
    const simulation = ls(CHAIN, areas);
    expect(simulation.decorations().links).toEqual({ 'B|C': 'areaBoundary' });
  });

  test('two areas hanging off a backbone each see only themselves and the core', () => {
    const simulation = ls(TREE, { 4: 1, 5: 1, 6: 2, 7: 2 });
    // Backbone router 2 sees the backbone only.
    expect(routerLsaOrigins(simulation, '2')).toEqual(['1', '2', '3']);
    // Area 1's interior sees area 1 plus its border router.
    expect(routerLsaOrigins(simulation, '5')).toEqual(['3', '4', '5']);
    // Area 2's likewise, and never area 1.
    expect(routerLsaOrigins(simulation, '7')).toEqual(['1', '6', '7']);
  });

  test('the sync meter is per area, so nobody reads as permanently stale', () => {
    const simulation = ls(TREE, { 4: 1, 5: 1, 6: 2, 7: 2 });
    const inSync = simulation.metrics().find((row) => row.label === 'LSDB in sync');
    expect(inSync.value).toBe('7 / 7');
    expect(simulation.metrics().find((row) => row.label === 'Areas').value).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

describe('summary LSAs carry a distance, not a topology', () => {
  const areas = { C: 1, D: 1 };

  test('the border router injects one per destination on the far side', () => {
    const simulation = ls(CHAIN, areas);
    // Into area 0: what B can reach in area 1. Into area 1: what it can reach in
    // area 0. Nothing about itself — everyone in both areas reaches B directly.
    expect(summariesIn(simulation, 'B')).toEqual([
      'B→A@1/a1',
      'B→C@1/a0',
      'B→D@2/a0',
    ]);
  });

  test('a summary reaches the interior of the area it was injected into', () => {
    const simulation = ls(CHAIN, areas);
    expect(summariesIn(simulation, 'A')).toEqual(['B→C@1/a0', 'B→D@2/a0']);
    expect(summariesIn(simulation, 'D')).toEqual(['B→A@1/a1']);
  });

  test('and never crosses back into the area it describes', () => {
    const simulation = ls(CHAIN, areas);
    // D is in area 1; the area-0 summaries about area 1 have no business there.
    expect(summariesIn(simulation, 'D')).not.toContain('B→C@1/a0');
  });

  test('inter-area costs are right — the whole point of quoting a number', () => {
    const simulation = ls(CHAIN, areas);
    // A→D is 3 hops of cost 1. A computes A→B intra-area (1) plus B's quoted 2.
    expect(costsFrom(simulation, 'A')).toEqual({ A: 0, B: 1, C: 2, D: 3 });
    expect(costsFrom(simulation, 'D')).toEqual({ A: 3, B: 2, C: 1, D: 0 });
  });

  test('the next hop is inherited from the path to the border router', () => {
    const simulation = ls(TREE, { 4: 1, 5: 1 });
    // 2 reaches area 1 through the backbone toward 3, which is the border router.
    expect(simulation.tables()['2']['5']).toMatchObject({ nextHop: '3', cost: 3 });
    expect(simulation.tables()['2']['5'].viaBorder).toBe('3');
  });

  test('a route learned by summary says which area it came from', () => {
    const simulation = ls(CHAIN, areas);
    expect(simulation.tables().A.D.fromArea).toBe(LS.defaultArea);
    // An intra-area route carries no such thing: it was not quoted to anyone.
    expect(simulation.tables().A.B.fromArea).toBeUndefined();
  });

  test('with areas the whole network is still 100% correct', () => {
    // The summaries have to compose to the true shortest path, or areas would be
    // a way of being wrong more cheaply.
    [ls(CHAIN, areas), ls(TREE, { 4: 1, 5: 1, 6: 2, 7: 2 })].forEach((simulation) => {
      expect(simulation.correctness.totals.percent).toBe(100);
    });
  });

  test('a destination in my own area is never reached by summary', () => {
    // §16's preference — intra-area over inter-area, whatever it costs — is
    // implemented, but it cannot be brought to a head on this model, and that is
    // worth recording rather than faking a test for it. A router either holds the
    // area's map, in which case it computes the true optimum, or it does not, in
    // which case there is nothing to prefer. The two only compete in real OSPF
    // because a *prefix* can be advertised both ways; here a destination is a
    // router with a definite set of areas. What is worth guarding is the
    // observable half: an area's own destinations are computed, never quoted.
    const AREAS = { 4: 1, 5: 1, 6: 2, 7: 2 };
    const areaFor = (id) => AREAS[id] ?? 0;
    const simulation = ls(TREE, AREAS);

    simulation.routerIds.forEach((from) => {
      Object.entries(simulation.tables()[from]).forEach(([dest, route]) => {
        if (from === dest) return;
        if (areaFor(from) !== areaFor(dest)) return;
        expect(route.fromArea ?? null).toBeNull();
      });
    });
    // And it costs nothing: every entry still matches the true shortest path.
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('a summary is withdrawn at the infinity ceiling, not deleted', () => {
    const simulation = ls(CHAIN, areas);
    expect(costsFrom(simulation, 'A').D).toBe(3);

    // Pull the far end of area 1 out of the network entirely.
    simulation.removeRouter('D');
    simulation.runToConvergence();
    expect(simulation.tables().A.D).toBeUndefined();
    // Flooding has no withdrawal mechanism, so the summary goes out at the
    // ceiling (LSInfinity) and lingers, meaning nothing, until max age.
    expect(summariesIn(simulation, 'B')).toEqual(['B→A@1/a1', 'B→C@1/a0']);
    expect(withdrawnIn(simulation, 'B')).toEqual(['B→D']);
    expect(withdrawnIn(simulation, 'A')).toEqual(['B→D']);
  });

  test('a summary follows the cost when a link inside the far area changes', () => {
    const simulation = ls(CHAIN, areas);
    expect(costsFrom(simulation, 'A').D).toBe(3);

    simulation.setLinkCost('C', 'D', 5);
    simulation.runToConvergence();
    expect(costsFrom(simulation, 'A').D).toBe(7);
  });

  test('breaking the far area leaves the near one saying unreachable, not stale', () => {
    const simulation = ls(CHAIN, areas);
    simulation.removeLink('C', 'D');
    simulation.runToConvergence();

    expect(simulation.tables().A.D.nextHop).toBeNull();
    expect(simulation.tables().A.D.cost).toBe(simulation.infinityCost);
  });
});

/* ------------------------------------------------------------------ *
 * The backbone rule (§16.2)
 * ------------------------------------------------------------------ */

describe('the backbone rule', () => {
  /** 1–2 backbone, 3–4 in area 1, 5–6 in area 2, joined only through 1 and 2. */
  const THREE_AREAS = {
    1: [
      { neighbor: '2', cost: 1 },
      { neighbor: '5', cost: 1 },
    ],
    2: [{ neighbor: '3', cost: 1 }],
    3: [{ neighbor: '4', cost: 1 }],
    5: [{ neighbor: '6', cost: 1 }],
    4: [],
    6: [],
  };
  const AREAS = { 3: 1, 4: 1, 5: 2, 6: 2 };

  test('area 1 reaches area 2 through the backbone', () => {
    // 2 summarises area 1 into area 0; 1 learns that from the backbone and is
    // therefore allowed to re-advertise it into area 2. That chain — two hops of
    // hearsay, each anchored to the backbone — is exactly what the rule permits,
    // and 4→3→2→1→5→6 is the true shortest path at 5.
    const simulation = ls(THREE_AREAS, AREAS);
    expect(simulation.shortestPath('4', '6').cost).toBe(5);
    expect(costsFrom(simulation, '4')['6']).toBe(5);
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('a shortcut between two non-backbone areas is deliberately ignored', () => {
    const simulation = ls(THREE_AREAS, AREAS);

    // Wire area 1 straight to area 2. The link belongs to area 2 (the higher
    // number), so 4 joins areas 1 and 2 — and touches the backbone in neither.
    // §12.4.3: a router like that summarises nothing, which is what stops the
    // shortcut being usable by anybody but its own endpoints.
    simulation.addLink('4', '6', 1);
    simulation.runToConvergence();

    // 4 and 6 are each other's neighbours and reach each other intra-area, which
    // is fine and unavoidable. What must not happen is 3 — one hop behind 4 —
    // taking the shortcut on 4's word.
    expect(simulation.tables()['4']['6'].cost).toBe(1);
    // 4 still *holds* summaries — it is in two areas and both are being told
    // things — but it writes none of its own, which is the rule.
    expect(originatedBy(simulation, '4')).toEqual([]);
    expect(simulation.tables()['3']['6'].cost).toBe(4);
    // It went the long way, through the backbone router that is allowed to speak.
    expect(simulation.tables()['3']['6'].viaBorder).toBe('2');
  });

  test('turning it off lets the shortcut carry traffic', () => {
    const simulation = ls(THREE_AREAS, AREAS, { strictBackbone: false });
    simulation.addLink('4', '6', 1);
    simulation.runToConvergence();

    // With nothing checking whose distance is whose, 3 takes the short way — and
    // it is genuinely shorter. Being right by luck is the trap the rule avoids.
    expect(simulation.tables()['3']['6'].cost).toBe(2);
    expect(simulation.tables()['3']['6'].viaBorder).toBe('4');
  });

  test('and with it off the areas can count to infinity at each other', () => {
    // The honest counterpart to the paragraph above. Cut the backbone so the
    // only path between the two non-backbone areas is the shortcut, and the
    // distances have nothing left to be anchored to: with the rule on the
    // destination reads unreachable, with it off the cost climbs. Either way the
    // ceiling stops it — which is the same mechanism, and the same lesson, as
    // distance vector's.
    const build = (strictBackbone) => {
      const simulation = ls(THREE_AREAS, AREAS, { strictBackbone });
      simulation.addLink('4', '6', 1);
      simulation.runToConvergence();
      simulation.removeLink('1', '2');
      const run = simulation.runToConvergence();
      return { simulation, run };
    };

    const strict = build(true);
    const loose = build(false);

    // Both terminate — nothing here may hang the browser.
    expect(strict.run.rounds).toBeLessThanOrEqual(SIM.maxConvergenceRounds);
    expect(loose.run.rounds).toBeLessThanOrEqual(SIM.maxConvergenceRounds);
    // And no cost anywhere exceeds the ceiling.
    loose.simulation.routerIds.forEach((from) => {
      Object.values(loose.simulation.tables()[from]).forEach((route) => {
        expect(route.cost).toBeLessThanOrEqual(loose.simulation.infinityCost);
      });
    });
  });
});

/* ------------------------------------------------------------------ *
 * Edits, and the inspector
 * ------------------------------------------------------------------ */

describe('living with areas', () => {
  test('moving a router into an area takes effect at once, not next round', () => {
    const simulation = ls(CHAIN);
    expect(summariesIn(simulation, 'B')).toEqual([]);

    // An area change arrives as a routerOption event, which re-summarises before
    // anything else is run.
    simulation.setRouterOption('C', 'area', 1);
    simulation.setRouterOption('D', 'area', 1);
    expect(summariesIn(simulation, 'B').length).toBeGreaterThan(0);
  });

  test('moving it back removes every summary again', () => {
    const simulation = ls(CHAIN, { C: 1, D: 1 });
    expect(summariesIn(simulation, 'B').length).toBeGreaterThan(0);

    simulation.setRouterOption('C', 'area', 0);
    simulation.setRouterOption('D', 'area', 0);
    simulation.runToConvergence();

    // The withdrawals go out at the infinity ceiling and then age away; what
    // matters is that nothing is being *used*.
    expect(simulation.tables().A.D.fromArea).toBeUndefined();
    expect(costsFrom(simulation, 'A')).toEqual({ A: 0, B: 1, C: 2, D: 3 });
  });

  test('a converged network with areas reports no further change', () => {
    // The summary machinery re-derives every round, so a stray sequence bump
    // would make this protocol permanently unconverged.
    const simulation = ls(TREE, { 4: 1, 5: 1, 6: 2, 7: 2 });
    expect(simulation.runIteration().changed).toBe(false);
    expect(simulation.runIteration().changed).toBe(false);
  });

  test('the LSDB tab names the area and marks the summaries', () => {
    const simulation = ls(CHAIN, { C: 1, D: 1 });
    const [tab] = simulation.inspect('A');
    const rows = tab.blocks.find((block) => block.type === 'rows').rows;
    const table = tab.blocks.find((block) => block.type === 'table');

    expect(rows.map((row) => row.label)).toContain('Area');
    expect(table.columns.map((column) => column.key)).toContain('area');
    expect(table.rows.some((row) => String(row.origin).startsWith('S '))).toBe(true);
  });

  test('the tab says nothing about areas on a single-area network', () => {
    const simulation = ls(CHAIN);
    const [tab] = simulation.inspect('A');
    const rows = tab.blocks.find((block) => block.type === 'rows').rows;
    expect(rows.map((row) => row.label)).not.toContain('Area');
  });

  test('a border router going down cuts its area off, and reviving restores it', () => {
    const simulation = ls(CHAIN, { C: 1, D: 1 });
    simulation.setRouterActive('B', false);

    // Stepped rather than run to convergence, and for the reason the whole
    // protocol exists to show: a router falling silent is not an event anyone
    // can see. A keeps believing in B — and therefore in B's summaries — until
    // enough hellos have gone unanswered, so `runToConvergence` would stop on the
    // first round, quite correctly reporting that nothing changed.
    for (let round = 0; round < simulation.options.deadRounds + 2; round += 1) {
      simulation.runIteration();
    }
    expect(simulation.tables().A.D.nextHop).toBeNull();

    simulation.setRouterActive('B', true);
    simulation.runToConvergence();
    expect(costsFrom(simulation, 'A').D).toBe(3);
  });
});

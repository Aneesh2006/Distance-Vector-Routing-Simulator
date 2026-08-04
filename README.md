# Routing Protocol Simulator

An interactive 3D simulator for five routing protocols on one network. Build a topology,
pick a protocol, and step through it round by round — or on a virtual clock running the
protocols' real timers — watching every message travel and every table fill in. Then
score the result against the truth, and compare all five on the same failure.

Live demo: https://distance-vector-routing-simulator.vercel.app/

## The protocols

| Protocol | What it teaches | Headline demo |
| --- | --- | --- |
| **Distance Vector** (RIP-style) | Bellman-Ford, distributed. What a router can be told, and therefore fooled by | Turn off split horizon, break a link, watch it count to 16 |
| **Link State** (OSPF-style) | Flood facts, not conclusions; run Dijkstra locally | The same break resolves in *diameter* rounds — and the cost of the link no longer matters |
| **Path Vector** (BGP-style) | Loop freedom by inspection, and policy above cost | Raise a LOCAL_PREF and send traffic the expensive way on purpose |
| **Spanning Tree** (802.1D) | Elect a root, block the rest, keep redundancy without loops | Break a green link and a dark one comes alive — after the fifty seconds it really takes |
| **DUAL** (EIGRP-style) | The feasibility condition, and a diffusing computation | One break switches over silently; the next sends a red query wave out and a green reply wave back |

Every protocol is a plugin behind one interface, so the options panel, table columns,
packet colours, legend, help text and inspector tabs are all generated from what the
plugin declares. Adding a sixth would touch no UI code.

## Beyond the protocols

- **A scoreboard, not a badge.** Every table entry is classified against all-pairs ground
  truth: optimal, suboptimal, stale, black hole, looping. A meter beside the round counter
  reads `Tables correct: 18 / 25 (72%)`, with a sparkline of the recovery — because a
  network can converge on an answer that is wrong, and CONVERGED would happily say so.
- **A comparison table.** One button runs every protocol from cold on a copy of the current
  topology, optionally breaks a link, and reports rounds to converge, messages, entries
  advertised, peak wrong entries and loops seen. The strongest single artefact here.
- **Two clocks.** Rounds mode is lockstep. Timers mode gives each router its own jittered
  schedule with the RFCs' real constants — RIP's 30 / 180 / 120 seconds, 802.1D's
  2 / 15 / 20 — so convergence takes the minutes it actually takes, seeded so a scenario
  replays identically.
- **Stretch goals that change the lesson.** Equal-cost multipath, OSPF areas with summary
  LSAs (where link state quietly becomes distance vector), and BGP's two-tier AS model with
  iBGP, the no-re-advertise rule and route reflectors.
- **Shareable links.** The whole scenario — topology, protocol, every setting, the seed —
  encodes into the URL fragment.

## Running it

```
npm install
npm start                        # http://localhost:3000
npm test -- --watchAll=false     # the whole suite
npm run build                    # production bundle
```

`PORT=3123 npm start` if 3000 is taken.

## Two things worth understanding

### The round is two-phase

Every router snapshots the message it would send, *then* all messages are delivered, *then*
every table is re-derived. Because tables are derived rather than patched, the outcome never
depends on the order messages happen to be processed in, and a round that changes nothing is
a reliable convergence signal. Two protocols break the "derived" half deliberately — DUAL's
feasible distance and RIP's per-route timers are *memories*, not derivations — and both keep
`tables()` as an ordinary derived view so that everything above them is unaffected.

### The infinity ceiling

`infinityCost` is a small finite number (16 by default, as in RIP) rather than
`Number.POSITIVE_INFINITY`. It is what makes count-to-infinity *terminate*, and it is
load-bearing for exactly one protocol: under link state and path vector the same setting is
only a display sentinel, which is itself worth demonstrating side by side.

### Seeing count-to-infinity

1. Load **Three in a line** with Distance Vector selected.
2. Turn **split horizon** off.
3. Run to convergence — router 1 reaches router 3 at cost 2.
4. Delete the 2 ↔ 3 link, then step round by round.

The cost climbs 2 → 4 → 6 → … → 14, hits the ceiling and settles at ∞. Now switch the
protocol dropdown to Link State and do it again.

## Project layout

```
src/
  engine/                    no React, no rendering
    Topology.js              routers, links, up/down, ground-truth cache
    Simulation.js            rounds, convergence, counters, paths, the snapshot
    Clock.js                 the virtual clock: event queue, outbox, event log, PRNG
    groundTruth.js           Floyd–Warshall + correctness classification
    compare.js               the protocol comparison runner
    scenario.js              a whole simulator state ⇄ a URL
    helpers.js               id ordering, table equality, lossless copies, formatting
    protocols/
      index.js               the registry — adding a protocol is adding it here
      distanceVector.js  linkState.js  pathVector.js  spanningTree.js  dual.js
  App.js                     all React state and controls
  Network3D.js               the WebGL scene
  ProtocolPanel.js           generic renderers for whatever a plugin declares
  Scoreboard.js              correctness meter, sparkline, stats, event log
  Modal.js                   the dialog shell: Escape, focus trap, focus restore
  HelpModal.js  ComparisonModal.js
  config.js                  every tunable constant and the palette
  presets.js                 starter topologies and automatic placement
  DvrAlgorithm.js            thin re-export shim; pre-refactor imports keep working
```

`config.js` owns the palette and writes it into CSS custom properties at startup, so the
DOM and the WebGL scene are always driven by the same colour definitions. The values in
`App.css` are fallbacks for before JavaScript has run.

## Tests

458 tests across 17 suites, all in the engine — which is where the risk is. Each protocol
has its own suite asserting *results* rather than mechanism (the tree is acyclic and
connected; no cost ever exceeds the true post-failure shortest path; every path is a real
walk whose costs sum to its cost), plus randomised loop-freedom checks after every round.
`Simulation.test.js` runs a `describe.each` over the registry, so every protocol present
and future has to converge on the sample topology.

## Technology

React 19, three.js via @react-three/fiber and @react-three/drei, Create React App.

## Notes

- Router labels are rendered with troika text (via drei), which fetches its default font
  from a CDN. Offline, labels may not appear until a font is bundled locally.
- The build prints a source-map warning from `@mediapipe/tasks-vision`, a transitive
  dependency of drei. It is harmless and not fixable from this project.

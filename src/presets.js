/**
 * presets.js — starter topologies.
 *
 * These live as data rather than being baked into the UI so new scenarios can
 * be added without touching any component.
 */

import { SIM } from './config';

/**
 * Dropdown groupings, in display order.
 *
 * The preset list roughly triples as protocols land, and a flat list of twelve
 * unrelated topologies is unreadable — so each preset declares which question
 * it exists to answer and the dropdown renders one `<optgroup>` per group.
 * Groups with no presets are simply not rendered.
 */
export const PRESET_GROUPS = ['Classics', 'Failure demos', 'Protocol showcases'];

export const PRESETS = [
  {
    id: 'textbook',
    name: 'Textbook 5-node',
    group: 'Classics',
    summary: 'The classic worked example. Converges in a handful of rounds.',
    routers: [
      { id: '1', x: -9, y: 0, z: 0 },
      { id: '2', x: -4, y: 0, z: 0 },
      { id: '3', x: 2, y: 0, z: -5 },
      { id: '4', x: 7, y: 0, z: 0 },
      { id: '5', x: 0, y: 0, z: 5 },
    ],
    links: [
      { source: '1', destination: '2', cost: 1 },
      { source: '2', destination: '3', cost: 6 },
      { source: '2', destination: '5', cost: 3 },
      { source: '3', destination: '4', cost: 2 },
      { source: '4', destination: '5', cost: 4 },
    ],
  },
  {
    id: 'chain',
    name: 'Three in a line',
    group: 'Failure demos',
    summary:
      'Converge, then delete link 2 ↔ 3 with split horizon off to watch count-to-infinity.',
    routers: [
      { id: '1', x: -7, y: 0, z: 0 },
      { id: '2', x: 0, y: 0, z: 0 },
      { id: '3', x: 7, y: 0, z: 0 },
    ],
    links: [
      { source: '1', destination: '2', cost: 1 },
      { source: '2', destination: '3', cost: 1 },
    ],
  },
  {
    id: 'ring',
    name: 'Six-node ring',
    group: 'Classics',
    summary: 'Two equal-cost directions around the ring, plus one shortcut.',
    routers: [
      { id: '1', x: 8, y: 0, z: 0 },
      { id: '2', x: 4, y: 2, z: 7 },
      { id: '3', x: -4, y: 2, z: 7 },
      { id: '4', x: -8, y: 0, z: 0 },
      { id: '5', x: -4, y: -2, z: -7 },
      { id: '6', x: 4, y: -2, z: -7 },
    ],
    links: [
      { source: '1', destination: '2', cost: 2 },
      { source: '2', destination: '3', cost: 2 },
      { source: '3', destination: '4', cost: 2 },
      { source: '4', destination: '5', cost: 2 },
      { source: '5', destination: '6', cost: 2 },
      { source: '6', destination: '1', cost: 2 },
      { source: '2', destination: '5', cost: 3 },
    ],
  },
  {
    id: 'diameter-chain',
    name: 'Diameter chain (6 in a line)',
    group: 'Protocol showcases',
    summary:
      'Diameter 5, so link state needs five rounds to tell the far end anything — countable ' +
      'on your fingers. Break a middle link and watch the news travel one hop per round.',
    routers: [
      { id: '1', x: -12.5, y: 0, z: 0 },
      { id: '2', x: -7.5, y: 0, z: 0 },
      { id: '3', x: -2.5, y: 0, z: 0 },
      { id: '4', x: 2.5, y: 0, z: 0 },
      { id: '5', x: 7.5, y: 0, z: 0 },
      { id: '6', x: 12.5, y: 0, z: 0 },
    ],
    links: [
      { source: '1', destination: '2', cost: 1 },
      { source: '2', destination: '3', cost: 1 },
      { source: '3', destination: '4', cost: 1 },
      { source: '4', destination: '5', cost: 1 },
      { source: '5', destination: '6', cost: 1 },
    ],
  },
  {
    id: 'two-rings',
    name: 'Two rings, one joint',
    group: 'Failure demos',
    summary:
      'Break link 3 ↔ 5 and the halves are cut off. Link state says so as soon as the news ' +
      'arrives; distance vector counts its way there.',
    routers: [
      { id: '1', x: -16, y: 0, z: 0 },
      { id: '2', x: -11, y: 0, z: 5 },
      { id: '3', x: -6, y: 0, z: 0 },
      { id: '4', x: -11, y: 0, z: -5 },
      { id: '5', x: 6, y: 0, z: 0 },
      { id: '6', x: 11, y: 0, z: 5 },
      { id: '7', x: 16, y: 0, z: 0 },
      { id: '8', x: 11, y: 0, z: -5 },
    ],
    links: [
      { source: '1', destination: '2', cost: 2 },
      { source: '2', destination: '3', cost: 2 },
      { source: '3', destination: '4', cost: 2 },
      { source: '4', destination: '1', cost: 2 },
      { source: '3', destination: '5', cost: 1 },
      { source: '5', destination: '6', cost: 2 },
      { source: '6', destination: '7', cost: 2 },
      { source: '7', destination: '8', cost: 2 },
      { source: '8', destination: '5', cost: 2 },
    ],
  },
  {
    id: 'diamond',
    name: 'Equal-cost diamond',
    group: 'Protocol showcases',
    summary:
      'Both ways from 1 to 4 cost 6. The tie-break keeps whichever hop is already in use, so ' +
      'the table settles instead of flapping — and only one of the two paths carries traffic.',
    routers: [
      { id: '1', x: -8, y: 0, z: 0 },
      { id: '2', x: 0, y: 0, z: 6 },
      { id: '3', x: 0, y: 0, z: -6 },
      { id: '4', x: 8, y: 0, z: 0 },
    ],
    links: [
      { source: '1', destination: '2', cost: 3 },
      { source: '1', destination: '3', cost: 3 },
      { source: '2', destination: '4', cost: 3 },
      { source: '3', destination: '4', cost: 3 },
    ],
  },
  {
    id: 'redundant-core',
    name: 'Redundant core',
    group: 'Protocol showcases',
    summary:
      'Two cores, three access bridges, every access bridge wired to both. Spanning tree blocks ' +
      'the three links to the losing core; take the winning core down and everything re-homes.',
    routers: [
      { id: '1', x: -5, y: 3, z: 0 },
      { id: '2', x: 5, y: 3, z: 0 },
      { id: '3', x: -9, y: -3, z: 0 },
      { id: '4', x: 0, y: -3, z: 0 },
      { id: '5', x: 9, y: -3, z: 0 },
    ],
    links: [
      { source: '1', destination: '2', cost: 1 },
      { source: '1', destination: '3', cost: 2 },
      { source: '1', destination: '4', cost: 2 },
      { source: '1', destination: '5', cost: 2 },
      { source: '2', destination: '3', cost: 2 },
      { source: '2', destination: '4', cost: 2 },
      { source: '2', destination: '5', cost: 2 },
    ],
  },
  {
    id: 'unequal-ring',
    name: 'Ring with unequal costs',
    group: 'Protocol showcases',
    summary:
      'Bridge 5 sits one hop from the root down a link costing 9. It blocks that link and reaches ' +
      'the root the long way round instead — root path cost, not hop count.',
    routers: [
      { id: '1', x: 0, y: 0, z: -8 },
      { id: '2', x: 7.6, y: 0, z: -2.5 },
      { id: '3', x: 4.7, y: 0, z: 6.5 },
      { id: '4', x: -4.7, y: 0, z: 6.5 },
      { id: '5', x: -7.6, y: 0, z: -2.5 },
    ],
    links: [
      { source: '1', destination: '2', cost: 1 },
      { source: '2', destination: '3', cost: 1 },
      { source: '3', destination: '4', cost: 1 },
      { source: '4', destination: '5', cost: 1 },
      { source: '5', destination: '1', cost: 9 },
    ],
  },
  {
    id: 'feasibility-trap',
    name: 'Feasibility trap',
    group: 'Protocol showcases',
    summary:
      'Router 1 reaches 4 three ways: two cheap (via 2 and 5) and one dear (via 3). Break 1 ↔ 2 and ' +
      'DUAL switches to 5 in the same instant, silently. Break 1 ↔ 5 too and the route left is ' +
      'loop-free but fails the feasibility condition — so it costs a query and a reply.',
    routers: [
      { id: '1', x: -9, y: 0, z: 0 },
      { id: '2', x: 0, y: 0, z: 5 },
      { id: '3', x: 0, y: 0, z: -6 },
      { id: '4', x: 9, y: 0, z: 0 },
      { id: '5', x: 0, y: 0, z: 0 },
    ],
    links: [
      { source: '1', destination: '2', cost: 1 },
      { source: '2', destination: '4', cost: 1 },
      { source: '1', destination: '5', cost: 1 },
      { source: '5', destination: '4', cost: 1 },
      { source: '1', destination: '3', cost: 1 },
      { source: '3', destination: '4', cost: 5 },
    ],
  },
  {
    id: 'two-ases',
    name: 'Two ASes, one peering',
    group: 'Protocol showcases',
    summary:
      'Switch to Path Vector, then set 1, 2 and 3 to AS 1 and 4, 5 and 6 to AS 2. Only 3 ↔ 4 is ' +
      'then eBGP. Router 1 never learns about AS 2, because 2 will not relay what it heard from ' +
      '3 — until you make 2 a route reflector.',
    routers: [
      // AS 1: a line, so the middle router is the one that has to relay.
      { id: '1', x: -13, y: 0, z: 4 },
      { id: '2', x: -7, y: 0, z: -3 },
      { id: '3', x: -2, y: 0, z: 3 },
      // AS 2: the same shape mirrored, so both halves have an interior router.
      { id: '4', x: 4, y: 0, z: 3 },
      { id: '5', x: 9, y: 0, z: -3 },
      { id: '6', x: 15, y: 0, z: 4 },
    ],
    links: [
      { source: '1', destination: '2', cost: 1 },
      { source: '2', destination: '3', cost: 1 },
      // The one peering link.
      { source: '3', destination: '4', cost: 1 },
      { source: '4', destination: '5', cost: 1 },
      { source: '5', destination: '6', cost: 1 },
    ],
  },
  {
    id: 'two-areas',
    name: 'Two areas, one backbone',
    group: 'Protocol showcases',
    summary:
      'Switch to Link State, then set 4 and 5 to area 1 and 6 and 7 to area 2. Routers 3 and 4 ' +
      'become border routers; 1 reaches 7 only because they summarise. Then wire 5 ↔ 6 and see ' +
      'the shortcut ignored — that is the backbone rule.',
    routers: [
      // The backbone: a triangle, so it stays connected when a link goes.
      { id: '1', x: -6, y: 0, z: -6 },
      { id: '2', x: 0, y: 0, z: -9 },
      { id: '3', x: 6, y: 0, z: -6 },
      // Area 1, hanging off backbone router 3.
      { id: '4', x: 10, y: 0, z: 1 },
      { id: '5', x: 6, y: 0, z: 8 },
      // Area 2, hanging off backbone router 1.
      { id: '6', x: -10, y: 0, z: 1 },
      { id: '7', x: -6, y: 0, z: 8 },
    ],
    links: [
      { source: '1', destination: '2', cost: 1 },
      { source: '2', destination: '3', cost: 1 },
      { source: '3', destination: '1', cost: 2 },
      { source: '3', destination: '4', cost: 1 },
      { source: '4', destination: '5', cost: 1 },
      { source: '1', destination: '6', cost: 1 },
      { source: '6', destination: '7', cost: 1 },
    ],
  },
  {
    id: 'async-loop',
    name: 'Async loop trap',
    group: 'Failure demos',
    summary:
      'Timer mode, triggered updates off: break 1 ↔ 5 and the tables loop — with split ' +
      'horizon and poisoned reverse both on. The same break under the round loop is clean, ' +
      'so it is the asynchrony doing it, and it is what DUAL exists to fix.',
    routers: [
      { id: '1', x: 0, y: 0, z: -7 },
      { id: '2', x: 7, y: 0, z: 0 },
      { id: '3', x: 0, y: 0, z: 7 },
      { id: '4', x: -7, y: 0, z: 0 },
      { id: '5', x: 0, y: 0, z: -14 },
    ],
    links: [
      // A ring, so router 3 hears the bad news from two directions and has no
      // reason to expect them to agree.
      { source: '1', destination: '2', cost: 1 },
      { source: '2', destination: '3', cost: 1 },
      { source: '3', destination: '4', cost: 1 },
      { source: '4', destination: '1', cost: 1 },
      // Everything that matters is about reaching 5, which only 1 can.
      { source: '1', destination: '5', cost: 1 },
    ],
  },
  {
    id: 'empty',
    name: 'Empty canvas',
    group: 'Classics',
    summary: 'Build a topology from scratch.',
    routers: [],
    links: [],
  },
];

export const DEFAULT_PRESET = PRESETS[0];

/** Ring-and-tier placement so auto-added routers never stack on each other. */
export function autoPosition(index) {
  const { radius, ringCapacity, ringSpacing, heightStep } = SIM.layout;
  const ring = Math.floor(index / ringCapacity);
  const slot = index % ringCapacity;
  const angle = (slot / ringCapacity) * Math.PI * 2 + ring * 0.4;
  const distance = radius + ring * ringSpacing;
  const round = (value) => Math.round(value * 10) / 10;
  return {
    x: round(Math.cos(angle) * distance),
    y: ring * heightStep,
    z: round(Math.sin(angle) * distance),
  };
}

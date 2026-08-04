/**
 * DvrAlgorithm.js — the compatibility shim left behind by the protocol refactor.
 *
 * The engine now lives in `engine/`:
 *
 *   engine/Topology.js               routers, links, up/down, ground truth
 *   engine/Simulation.js             rounds, convergence, counters, snapshot
 *   engine/protocols/*.js            what each router knows and how it moves
 *   engine/helpers.js                compareIds, tablesEqual, cloneTable, formatCost
 *
 * Everything this file used to export is re-exported from there, so imports
 * written against the distance-vector-only engine keep working — including the
 * original test suite, which is the proof that the refactor changed no
 * behaviour.
 *
 * `Network` is what that suite (and the app, until the protocol dropdown
 * landed) calls the simulator: a `Simulation` pinned to the distance-vector
 * plugin, plus the `routers[id].routingTable` view the old engine exposed
 * directly. New code should use `Simulation` and `getSnapshot()` instead.
 */

import { SIM } from './config';
import { Simulation, defaultsFrom } from './engine/Simulation';
import { Topology, RouterNode } from './engine/Topology';
import { distanceVector } from './engine/protocols/distanceVector';

export {
  compareIds,
  tablesEqual,
  cloneTable,
  cloneTables,
  formatCost,
  formatCell,
} from './engine/helpers';
export { Simulation, createStats, cloneStats } from './engine/Simulation';
export { Topology } from './engine/Topology';
export { PROTOCOLS, getProtocol } from './engine/protocols';

/** Distance-vector option defaults, as the pre-refactor engine spelled them. */
export function createOptions(overrides = {}) {
  return defaultsFrom(distanceVector.options, overrides);
}

/**
 * The old `Router`: a topology node plus the table its protocol derived for it.
 *
 * Prototype delegation rather than copying, so `links`, `isActive`, `neighbors`
 * and `linkCostTo` stay the live topology's — only `routingTable` is grafted
 * on, and it is the plugin's own object.
 */
function routerView(node, table) {
  const view = Object.create(node);
  view.routingTable = table || {};
  return view;
}

class Network extends Simulation {
  /**
   * @param {Object} [topology] adjacency map: { '1': [{ neighbor: '2', cost: 4 }] }
   * @param {Object} [options]  { infinityCost, splitHorizon, poisonedReverse }
   */
  constructor(topology, options) {
    super(
      new Topology(topology, (options && options.infinityCost) || SIM.defaultInfinityCost),
      distanceVector.id,
      options
    );
  }

  /**
   * `{ id: { links, isActive, neighbors, linkCostTo, routingTable } }`.
   *
   * Rebuilt per access: the tables are the plugin's, the nodes are the
   * topology's, and nothing should be caching a merged object of the two.
   */
  get routers() {
    const tables = this.tables();
    const view = {};
    Object.entries(this.topology.routers).forEach(([id, node]) => {
      view[id] = routerView(node, tables[id]);
    });
    return view;
  }

  /** Bulk-load an adjacency map into an existing network. */
  loadAdjacency(topology) {
    this.topology.loadAdjacency(topology);
    this.startEpisode();
    return this.refresh();
  }
}

export { Network, RouterNode as Router };

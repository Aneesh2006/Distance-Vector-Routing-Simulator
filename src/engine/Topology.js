/**
 * Topology.js — the network as it physically is: routers, links, costs and
 * which boxes are switched on.
 *
 * Nothing here knows what a routing protocol is. That separation is the point
 * of the refactor: five protocols share one topology editor, one 3D scene, one
 * path finder and one ground truth, and none of them can corrupt the others'
 * view of the wiring.
 *
 * The one concession to the protocols above is `infinityCost`. Link costs must
 * stay strictly below whatever ceiling the active protocol counts as
 * unreachable, or a link would exist that no router could ever use — so the
 * ceiling is pushed down here and re-clamps the links whenever it moves
 * (invariant 6).
 */

import { SIM } from '../config';
import { allPairsShortestPaths } from './groundTruth';
import { compareIds } from './helpers';

/**
 * One node of the graph. Purely structural: what it is wired to and whether it
 * is up. Everything a router *believes* lives in protocol state instead.
 */
export class RouterNode {
  constructor(id, topology) {
    this.id = String(id);
    this.topology = topology;
    /** neighbourId -> link cost */
    this.links = new Map();
    this.isActive = true;
  }

  get neighbors() {
    return [...this.links.keys()].sort(compareIds);
  }

  /** Cost of the direct link to `id`, or the unreachable ceiling if there is none. */
  linkCostTo(id) {
    const cost = this.links.get(String(id));
    return cost === undefined ? this.topology.infinityCost : cost;
  }

  setLink(neighborId, cost) {
    this.links.set(String(neighborId), cost);
  }

  dropLink(neighborId) {
    this.links.delete(String(neighborId));
  }

  /** A neighbour is only usable while both ends are up. */
  canReach(neighborId) {
    return this.isActive && this.topology.isActive(neighborId);
  }
}

export class Topology {
  /**
   * @param {Object} [adjacency] `{ '1': [{ neighbor: '2', cost: 4 }] }`
   * @param {number} [infinityCost] the active protocol's unreachable ceiling
   */
  constructor(adjacency, infinityCost = SIM.defaultInfinityCost) {
    this.routers = {};
    this.infinityCost = infinityCost;
    /** All-pairs ground truth; recomputed lazily after any edit. */
    this.truthCache = null;
    if (adjacency) this.loadAdjacency(adjacency);
  }

  loadAdjacency(adjacency) {
    Object.keys(adjacency).forEach((id) => this.addRouter(id));
    Object.entries(adjacency).forEach(([id, links]) => {
      (links || []).forEach(({ neighbor, cost }) => this.addLink(id, neighbor, cost));
    });
    return this;
  }

  /* ---------------- reads ---------------- */

  get routerIds() {
    return Object.keys(this.routers).sort(compareIds);
  }

  /**
   * Part of the minimal interface `groundTruth.js` needs (`routerIds`,
   * `isActive`, `getLinks`). A router that does not exist is not active, so
   * callers can ask about any id.
   */
  isActive(id) {
    const router = this.routers[String(id)];
    return Boolean(router && router.isActive);
  }

  has(id) {
    return Boolean(this.routers[String(id)]);
  }

  hasLink(a, b) {
    const router = this.routers[String(a)];
    return Boolean(router && router.links.has(String(b)));
  }

  /** Neighbours of `id`, in id order so every protocol iterates identically. */
  neighborsOf(id) {
    const router = this.routers[String(id)];
    return router ? router.neighbors : [];
  }

  linkCost(a, b) {
    const router = this.routers[String(a)];
    return router ? router.linkCostTo(b) : this.infinityCost;
  }

  /** Both ends exist and are up, and there is a link between them. */
  canReach(a, b) {
    return this.hasLink(a, b) && this.isActive(a) && this.isActive(b);
  }

  /** Undirected link list, de-duplicated and stably ordered. */
  getLinks() {
    const seen = new Set();
    const links = [];
    Object.values(this.routers).forEach((router) => {
      router.links.forEach((cost, neighborId) => {
        const [source, destination] = [router.id, neighborId].sort(compareIds);
        const key = `${source} ${destination}`;
        if (seen.has(key)) return;
        seen.add(key);
        links.push({ source, destination, cost });
      });
    });
    return links.sort(
      (x, y) => compareIds(x.source, y.source) || compareIds(x.destination, y.destination)
    );
  }

  /**
   * Ground truth for the current topology, computed at most once per edit.
   * It is read every round (correctness overlay, path finder, per-router
   * scores) and invalidated far less often, so the cache earns its keep.
   */
  get groundTruth() {
    if (this.truthCache === null) this.truthCache = allPairsShortestPaths(this);
    return this.truthCache;
  }

  invalidateGroundTruth() {
    this.truthCache = null;
  }

  /**
   * A detached copy of the wiring, for the protocol comparison runner.
   *
   * Every row of that table has to start from the same network, and running a
   * protocol on it is not read-only: a plugin declares its own infinity ceiling,
   * and pushing that down re-clamps link costs (invariant 6). So each run gets
   * its own copy rather than all of them sharing one and the first protocol
   * deciding what the rest see.
   *
   * The ground-truth cache is deliberately not carried over. It is derived, the
   * copy recomputes it on first read, and leaving it null keeps "detached"
   * meaning exactly one thing.
   */
  clone() {
    const copy = new Topology(undefined, this.infinityCost);
    this.routerIds.forEach((id) => {
      copy.addRouter(id);
      copy.setRouterActive(id, this.isActive(id));
    });
    this.getLinks().forEach(({ source, destination, cost }) => {
      copy.addLink(source, destination, cost);
    });
    return copy;
  }

  /* ---------------- edits ---------------- */

  addRouter(id) {
    const routerId = String(id);
    if (this.routers[routerId]) return false;
    this.routers[routerId] = new RouterNode(routerId, this);
    this.invalidateGroundTruth();
    return true;
  }

  removeRouter(id) {
    const routerId = String(id);
    if (!this.routers[routerId]) return false;
    delete this.routers[routerId];
    Object.values(this.routers).forEach((router) => router.dropLink(routerId));
    this.invalidateGroundTruth();
    return true;
  }

  addLink(a, b, cost = SIM.defaultLinkCost) {
    const source = String(a);
    const destination = String(b);
    if (source === destination) return false;
    if (!this.routers[source] || !this.routers[destination]) return false;

    const linkCost = this.normalizeCost(cost);
    this.routers[source].setLink(destination, linkCost);
    this.routers[destination].setLink(source, linkCost);
    this.invalidateGroundTruth();
    return true;
  }

  /** Changing a cost is just re-adding the link. */
  setLinkCost(a, b, cost) {
    if (!this.hasLink(a, b)) return false;
    return this.addLink(a, b, cost);
  }

  removeLink(a, b) {
    const source = String(a);
    const destination = String(b);
    if (!this.hasLink(source, destination)) return false;
    this.routers[source].dropLink(destination);
    this.routers[destination].dropLink(source);
    this.invalidateGroundTruth();
    return true;
  }

  /** Take a router down (or bring it back) without deleting it. */
  setRouterActive(id, active) {
    const router = this.routers[String(id)];
    if (!router || router.isActive === active) return false;
    router.isActive = active;
    this.invalidateGroundTruth();
    return true;
  }

  normalizeCost(cost) {
    const numeric = Number(cost);
    if (!Number.isFinite(numeric)) return SIM.defaultLinkCost;
    return Math.min(this.maxLinkCost, Math.max(SIM.minLinkCost, Math.round(numeric)));
  }

  get maxLinkCost() {
    return Math.max(SIM.minLinkCost, this.infinityCost - 1);
  }

  /**
   * Move the unreachable ceiling and re-clamp anything that no longer fits.
   *
   * Returns whether any link actually moved, so the caller can tell a cosmetic
   * option change from one that rewrote the graph — and therefore ground truth.
   */
  setInfinityCost(value) {
    this.infinityCost = value;
    const ceiling = this.maxLinkCost;
    let clamped = false;
    Object.values(this.routers).forEach((router) => {
      router.links.forEach((cost, neighborId) => {
        if (cost <= ceiling) return;
        router.links.set(neighborId, ceiling);
        clamped = true;
      });
    });
    if (clamped) this.invalidateGroundTruth();
    return clamped;
  }
}

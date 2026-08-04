/**
 * protocols/index.js — the protocol registry.
 *
 * One array, in the order the dropdown should show them. Adding a protocol to
 * the app is adding it here: the option panel, the table columns, the packet
 * colours, the help text and the convergence smoke test in `Simulation.test.js`
 * all read from the plugin, so nothing else needs a new branch.
 */

import { distanceVector } from './distanceVector';
import { dual } from './dual';
import { linkState } from './linkState';
import { pathVector } from './pathVector';
import { spanningTree } from './spanningTree';

export const PROTOCOLS = [distanceVector, linkState, pathVector, spanningTree, dual];

export const DEFAULT_PROTOCOL_ID = distanceVector.id;

export function getProtocol(id) {
  const protocol = PROTOCOLS.find((candidate) => candidate.id === id);
  if (!protocol) throw new Error(`Unknown protocol "${id}".`);
  return protocol;
}

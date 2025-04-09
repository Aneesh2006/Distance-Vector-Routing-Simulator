// DvrAlgorithm.js - Adapted from DVR Algo.js for use in React application

<<<<<<< HEAD
<<<<<<< HEAD

class Router {
    constructor(id, topology, network) {
        this.id = id;
        this.topology = topology;
        this.network = network;
        this.routingTable = {};
        this.isActive = true;
        this.initializeRoutingTable();
    }

    initializeRoutingTable() {
        // Initialize routing table with direct neighbors
        this.topology.forEach(neighbor => {
            this.routingTable[neighbor.neighbor] = {
                nextHop: neighbor.neighbor,
                cost: neighbor.cost
            };
        });

        // Add self with cost 0
        this.routingTable[this.id] = {
            nextHop: this.id,
            cost: 0
        };
    }

    sendUpdate(neighborId) {
        const neighborRouter = this.network.routers[neighborId];
        if (!neighborRouter) return false;

        // Send our complete routing table to the neighbor
        return neighborRouter.receiveUpdate(this.id, this.routingTable);
    }

    receiveUpdate(sourceId, receivedTable) {
        let hasChanges = false;

        Object.entries(receivedTable).forEach(([destination, receivedRoute]) => {
            // Skip self routes
            if (destination === this.id) return;

            const currentRoute = this.routingTable[destination];
            const costToSource = this.getCostTo(sourceId);

            // Calculate new cost through this neighbor
            const newCost = costToSource + receivedRoute.cost;

            // Important: We need to update the route in these cases:
            // 1. We don't have a route to this destination
            // 2. This route is better than our current one
            // 3. Our current route is through the sourceId (to handle count-to-infinity)
            // 4. Our current route has infinite cost
            if (!currentRoute || 
                newCost < currentRoute.cost || 
                currentRoute.nextHop === sourceId ||
                currentRoute.cost === Infinity) {
                
                this.routingTable[destination] = {
                    nextHop: sourceId,
                    cost: newCost
                };
                hasChanges = true;
            }
        });

        return hasChanges;
    }

    getCostTo(neighborId) {
        const neighbor = this.topology.find(n => n.neighbor === neighborId);
        return neighbor ? neighbor.cost : Infinity;
    }

    handleLinkFailure(neighborId) {
        // Remove the failed link from routing table
        delete this.routingTable[neighborId];
        
        // Update all routes that used this neighbor as next hop
        Object.keys(this.routingTable).forEach(destination => {
            const route = this.routingTable[destination];
            if (route.nextHop === neighborId) {
                // Set cost to infinity but keep the path
                // This will allow count-to-infinity to happen
                this.routingTable[destination] = {
                    nextHop: neighborId, // Keep the failed next hop
                    cost: Infinity
                };
            }
        });
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
class Router {
    constructor(id, links) {
        this.id = id;
        this.links = links || []; // Array of {neighbor: '2', cost: 1} objects
        this.routingTable = {}; // Format: { destination: { nextHop: '2', cost: 1 } }
        this.neighbors = new Set();

        // Initialize routing table with direct links
        this.routingTable[this.id] = { nextHop: this.id, cost: 0 };

        for (const link of this.links) {
            this.neighbors.add(link.neighbor);
            this.routingTable[link.neighbor] = { nextHop: link.neighbor, cost: link.cost };
        }
    }

    // Generate update message to be sent to neighbors
    generateUpdateMessage() {
        const distances = {};
        for (const [destination, info] of Object.entries(this.routingTable)) {
            distances[destination] = info.cost;
        }
        return { sourceRouter: this.id, distances };
    }

    // Process updates from a neighbor router
    processUpdate(update) {
        let changed = false;
        const sourceRouter = update.sourceRouter;
        const distances = update.distances;

        // Get the cost to reach the router that sent the update
        const linkCost = this.getLinkCost(sourceRouter);
        if (linkCost === Infinity) return false; // Not a direct neighbor

        // For each destination in the update
        for (const [destination, cost] of Object.entries(distances)) {
            // Skip if destination is this router
            if (destination === this.id) continue;

            // Calculate new potential cost through the neighbor
            const newCost = linkCost + cost;

            // If this is a new destination or a better path
            if (
                !(destination in this.routingTable) ||
                newCost < this.routingTable[destination].cost
            ) {
                this.routingTable[destination] = { nextHop: sourceRouter, cost: newCost };
                changed = true;
            }
        }

        return changed;
    }

    // Helper to get link cost to a direct neighbor
    getLinkCost(neighbor) {
        const link = this.links.find(link => link.neighbor === neighbor);
        return link ? link.cost : Infinity;
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    }
}

class Network {
    constructor(topology) {
<<<<<<< HEAD
<<<<<<< HEAD
        this.topology = topology;
        this.routers = {};
        this.iteration = 0;
        this.animations = [];
        this.animationSpeed = 1; // seconds per animation
        this.initializeRouters();
    }

    initializeRouters() {
        Object.keys(this.topology).forEach(routerId => {
            this.routers[routerId] = new Router(routerId, this.topology[routerId], this);
        });
    }

    runIteration() {
        let hasChanges = false;
        this.iteration++;

        // Exchange routing tables between all routers
        Object.values(this.routers).forEach(router => {
            router.topology.forEach(neighbor => {
                const neighborRouter = this.routers[neighbor.neighbor];
                if (neighborRouter) {
                    // Send and receive updates
                    const changes = router.sendUpdate(neighbor.neighbor);
                    hasChanges = hasChanges || changes;
                }
            });
        });

        return hasChanges;
    }

    runUntilConvergence() {
        let hasChanges = true;
        let iterations = 0;
        const maxIterations = 20; // Increased to show count-to-infinity

        while (hasChanges && iterations < maxIterations) {
            hasChanges = this.runIteration();
            iterations++;
        }

        return iterations < maxIterations;
    }

    // Method to find path between two routers
    findPath(sourceId, destinationId) {
        // First ensure we have converged routing tables
        this.runUntilConvergence();

        const sourceRouter = this.routers[sourceId];
        if (!sourceRouter) {
            return { path: [], cost: Infinity, message: "Source router not found" };
        }

        // Find the path from source to destination
        const path = [sourceId];
        let currentRouter = sourceId;
        let totalCost = 0;
        const visited = new Set([sourceId]);

        while (currentRouter !== destinationId) {
            // Get the next hop from current router's routing table
            const routingEntry = this.routers[currentRouter]?.routingTable[destinationId];
            
            if (!routingEntry || routingEntry.cost === Infinity || !routingEntry.nextHop) {
                return { path: [], cost: Infinity, message: "Destination unreachable" };
            }

            const nextHop = routingEntry.nextHop;
            
            // Check for loops
            if (visited.has(nextHop)) {
                return { path: [], cost: Infinity, message: "Loop detected in path" };
            }
            
            // Add next hop to path
            path.push(nextHop);
            totalCost += routingEntry.cost;
            currentRouter = nextHop;
            visited.add(nextHop);
            
            // Safety check to prevent infinite loops
            if (path.length > Object.keys(this.routers).length) {
                return { path: [], cost: Infinity, message: "Path calculation failed" };
            }
        }

        return { path, cost: totalCost };
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
        this.routers = {};
        this.iteration = 0;
        this.setupNetwork(topology);
    }

    setupNetwork(topology) {
        // Create routers based on the topology
        for (const [routerId, links] of Object.entries(topology)) {
            this.routers[routerId] = new Router(routerId, links);
        }
    }

    // Handle router deletion
    handleRouterDeletion(deletedRouterId) {
        // Update all routers' routing tables
        for (const [routerId, router] of Object.entries(this.routers)) {
            // If the routing table has an entry for the deleted router, remove it
            if (router.routingTable[deletedRouterId]) {
                delete router.routingTable[deletedRouterId];
            }

            // For entries where the next hop is through the deleted router, set cost to Infinity
            for (const [destination, info] of Object.entries(router.routingTable)) {
                if (info.nextHop === deletedRouterId) {
                    // Set only the cost to infinity while keeping the next hop information
                    router.routingTable[destination] = {
                        nextHop: info.nextHop,
                        cost: Infinity
                    };
                }
            }

            // Remove the deleted router from neighbors if it exists
            router.neighbors.delete(deletedRouterId);

            // Remove links to the deleted router
            router.links = router.links.filter(link => link.neighbor !== deletedRouterId);
        }
    }

    // Run one iteration of the algorithm
    runIteration() {
        const updates = [];

        // First, collect all updates
        for (const [id, router] of Object.entries(this.routers)) {
            // Send distance vector to all neighbors
            for (const neighborId of router.neighbors) {
                const neighbor = this.routers[neighborId];
                if (!neighbor) continue;

                // Create distance vector
                const distanceVector = {};
                for (const [dest, info] of Object.entries(router.routingTable)) {
                    // Don't send routes through the neighbor to that neighbor (split horizon)
                    if (info.nextHop !== neighborId) {
                        distanceVector[dest] = info.cost;
                    }
                }

                // Apply updates to neighbor's routing table
                for (const [dest, cost] of Object.entries(distanceVector)) {
                    const linkCost = router.links.find(l => l.neighbor === neighborId)?.cost || 0;
                    const totalCost = cost + linkCost;

                    // If the destination is not in the neighbor's table or we found a better path
                    if (!neighbor.routingTable[dest] || totalCost < neighbor.routingTable[dest].cost) {
                        updates.push({
                            router: neighborId,
                            destination: dest,
                            newCost: totalCost,
                            nextHop: id
                        });
                    }
                }
            }
        }

        // Then apply all updates
        for (const update of updates) {
            const router = this.routers[update.router];
            if (router) {
                router.routingTable[update.destination] = {
                    nextHop: update.nextHop,
                    cost: update.newCost
                };
            }
        }

        return updates;
    }

    // Run the algorithm until convergence
    runUntilConvergence() {
        let changes = true;
        while (changes) {
            changes = this.runIteration();
        }
    }

    // Handle link deletion
    handleLinkDeletion(source, destination) {
        // Get the routers
        const sourceRouter = this.routers[source];
        const destRouter = this.routers[destination];

        if (!sourceRouter || !destRouter) return;

        // Remove the link from both routers' links
        sourceRouter.links = sourceRouter.links.filter(link => link.neighbor !== destination);
        destRouter.links = destRouter.links.filter(link => link.neighbor !== source);

        // Remove from neighbors sets
        sourceRouter.neighbors.delete(destination);
        destRouter.neighbors.delete(source);

        // For source router, set cost to destination as infinity
        if (sourceRouter.routingTable[destination]) {
            sourceRouter.routingTable[destination] = {
                nextHop: destination,
                cost: Infinity
            };
        }

        // For destination router, set cost to source as infinity
        if (destRouter.routingTable[source]) {
            destRouter.routingTable[source] = {
                nextHop: source,
                cost: Infinity
            };
        }

        // Force an immediate iteration to start the count-to-infinity process
        this.runIteration();
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    }
}

export { Router, Network }; 
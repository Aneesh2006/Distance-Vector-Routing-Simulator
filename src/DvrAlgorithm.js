// DvrAlgorithm.js - Adapted from DVR Algo.js for use in React application

class Router {
    constructor(id, topology, network) {
        this.id = id;
        this.topology = topology;
        this.network = network;
        this.routingTable = {};
        this.isActive = true;
        this.initializeRoutingTable();
    }

    // Initialize routing table with minimal entries - just self and infinity for others
    initializeRoutingTable() {
        // Add self with cost 0
        this.routingTable[this.id] = {
            nextHop: this.id,
            cost: 0
        };

        // At iteration 0, all other routers should have infinite distance
        // and no next hop, even direct neighbors
        if (this.network && this.network.topology) {
            Object.keys(this.network.topology).forEach(routerId => {
                // Skip if it's self
                if (routerId === this.id) {
                    return;
                }

                // Add with infinite cost and no next hop
                this.routingTable[routerId] = {
                    nextHop: null,
                    cost: Infinity
                };
            });
        }
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
    }
}

class Network {
    constructor(topology) {
        this.topology = topology;
        this.routers = {};
        this.iteration = 0; // Start at iteration 0
        this.animations = [];
        this.animationSpeed = 1; // seconds per animation
        this.initializeRouters();
    }

    initializeRouters() {
        // First create all router objects with empty routing tables
        Object.keys(this.topology).forEach(routerId => {
            this.routers[routerId] = new Router(routerId, this.topology[routerId], this);
        });

        console.log("All routers initialized with routing tables - iteration", this.iteration);
    }

    runIteration() {
        let hasChanges = false;
        console.log("Running iteration", this.iteration);

        // Each iteration has specific behavior:
        // Iteration 0: Already initialized with just self-entries and infinity values for all other routers
        // Iteration 1: Initialize direct neighbors
        // Iteration 2+: Exchange routing tables

        if (this.iteration === 0) {
            // On iteration 0, we update the tables to include direct neighbors
            Object.values(this.routers).forEach(router => {
                // Initialize direct neighbors
                router.topology.forEach(neighbor => {
                    router.routingTable[neighbor.neighbor] = {
                        nextHop: neighbor.neighbor,
                        cost: neighbor.cost
                    };
                });
            });
            hasChanges = true; // Always report changes for iteration 0
            console.log("Iteration 0: Initialized direct neighbors, hasChanges =", hasChanges);
        } else {
            // In iterations 1+, perform the normal DVR exchange
            Object.values(this.routers).forEach(router => {
                router.topology.forEach(neighbor => {
                    const neighborRouter = this.routers[neighbor.neighbor];
                    if (neighborRouter) {
                        // Send and receive updates
                        const changes = router.sendUpdate(neighbor.neighbor);
                        if (changes) {
                            console.log(`Router ${router.id} received updates from ${neighbor.neighbor}, setting hasChanges to true`);
                            hasChanges = true;
                        }
                    }
                });
            });
            console.log(`Iteration ${this.iteration}: Exchange complete, hasChanges =`, hasChanges);
        }

        // Increment iteration counter AFTER processing for this iteration is complete
        this.iteration++;

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
            totalCost += this.routers[currentRouter].getCostTo(nextHop);
            currentRouter = nextHop;
            visited.add(nextHop);

            // Reached destination
            if (currentRouter === destinationId) {
                return { path, cost: totalCost, message: "Path found" };
            }

            // Safety check to prevent infinite loops
            if (path.length > Object.keys(this.routers).length) {
                return { path: [], cost: Infinity, message: "Path too long, possible routing loop" };
            }
        }

        return { path, cost: totalCost, message: "Path found" };
    }

    // Handle router deletion
    handleRouterDeletion(deletedRouterId) {
        // First, remove the deleted router
        delete this.routers[deletedRouterId];

        // Then update all other routers' routing tables
        Object.values(this.routers).forEach(router => {
            // Remove any entries that have the deleted router as next hop or destination
            const newRoutingTable = {};

            Object.entries(router.routingTable).forEach(([destination, route]) => {
                if (destination !== deletedRouterId && route.nextHop !== deletedRouterId) {
                    newRoutingTable[destination] = route;
                }
            });

            router.routingTable = newRoutingTable;

            // Update topology to remove links to the deleted router
            router.topology = router.topology.filter(link => link.neighbor !== deletedRouterId);
        });
    }

    // Handle link deletion
    handleLinkDeletion(source, destination) {
        // Update the topology in the router objects
        const sourceRouter = this.routers[source];
        const destRouter = this.routers[destination];

        if (sourceRouter) {
            sourceRouter.topology = sourceRouter.topology.filter(
                link => link.neighbor !== destination
            );
        }

        if (destRouter) {
            destRouter.topology = destRouter.topology.filter(
                link => link.neighbor !== source
            );
        }

        // Invoke the routers' link failure handling
        if (sourceRouter) sourceRouter.handleLinkFailure(destination);
        if (destRouter) destRouter.handleLinkFailure(source);
    }
}

export { Router, Network }; 
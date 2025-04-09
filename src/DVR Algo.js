class Router {
    constructor(id, links) {
      this.id = id;
      this.links = links; // Array of {neighbor: 'N2', cost: 1} objects
      this.routingTable = {}; // Format: { destination: { nextHop: 'N2', cost: 1 } }
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
    }
    
    // Print the current routing table with the requested format
    printRoutingTable() {
      console.log(`\nRouting table for Router ${this.id}:`);
      console.log("Destination\tDistance Vector\tNext Hop");
      console.log("-".repeat(50));
      
      // Get all possible destinations in the network
      const destinations = Array.from(new Set([
        ...Object.keys(this.routingTable),
        ...['N1', 'N2', 'N3', 'N4', 'N5'] // Ensure all network nodes are listed
      ])).sort();
      
      for (const destination of destinations) {
        if (this.id === destination) {
          console.log(`${destination}\t\t0\t\t${this.id}`);
        } else if (destination in this.routingTable) {
          const { nextHop, cost } = this.routingTable[destination];
          console.log(`${destination}\t\t${cost}\t\t${nextHop}`);
        } else {
          // If destination is not in the routing table, show as infinity
          console.log(`${destination}\t\tInfinity\t-`);
        }
      }
    }
  }
  
  class Network {
    constructor(topology) {
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
    
    // Run one iteration of the algorithm across all routers
    runIteration() {
      this.iteration++;
      console.log(`\n========== ITERATION ${this.iteration} ==========`);
      
      let anyChanges = false;
      const updates = {};
      
      // Each router generates update messages
      for (const [routerId, router] of Object.entries(this.routers)) {
        updates[routerId] = router.generateUpdateMessage();
      }
      
      // Each router processes updates from its neighbors
      for (const [routerId, router] of Object.entries(this.routers)) {
        for (const neighborId of router.neighbors) {
          const changed = router.processUpdate(updates[neighborId]);
          if (changed) anyChanges = true;
        }
        
        // Print routing table after this iteration
        router.printRoutingTable();
      }
      
      return anyChanges; // Return true if any routing table changed
    }
    
    // Run the algorithm until convergence
    runUntilConvergence() {
      console.log("Initial routing tables:");
      for (const router of Object.values(this.routers)) {
        router.printRoutingTable();
      }
      
      let changes = true;
      while (changes) {
        changes = this.runIteration();
      }
      
      console.log("\nFinal routing tables (converged):");
      for (const router of Object.values(this.routers)) {
        router.printRoutingTable();
      }
    }
  }
  
  // Example usage for the specific network
  function main() {
    // Define network topology based on the provided example
    const topology = {
      'N1': [
        { neighbor: 'N2', cost: 1 }
      ],
      'N2': [
        { neighbor: 'N1', cost: 1 },
        { neighbor: 'N3', cost: 6 },
        { neighbor: 'N5', cost: 3 }
      ],
      'N3': [
        { neighbor: 'N2', cost: 6 },
        { neighbor: 'N4', cost: 2 }
      ],
      'N4': [
        { neighbor: 'N3', cost: 2 },
        { neighbor: 'N5', cost: 4 }
      ],
      'N5': [
        { neighbor: 'N2', cost: 3 },
        { neighbor: 'N4', cost: 4 }
      ]
    };
    
    const network = new Network(topology);
    network.runUntilConvergence(); 
  }
  
  // Run the example
  main();
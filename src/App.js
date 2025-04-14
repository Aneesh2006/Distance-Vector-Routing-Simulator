import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import { Router, Network } from './DvrAlgorithm';
import Network3D from './Network3D';
import { Canvas } from '@react-three/fiber';

function HelpModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      backgroundColor: 'white',
      padding: '20px',
      borderRadius: '8px',
      boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
      zIndex: 1000,
      maxWidth: '600px',
      maxHeight: '80vh',
      overflow: 'auto',
      textAlign: 'left'
    }}>
      <h2 style={{ color: '#1976D2', marginBottom: '15px' }}>Welcome to Distance Vector Routing Simulator!</h2>

      <div style={{ marginBottom: '15px' }}>
        <h3>How to Use:</h3>
        <ul style={{ listStyleType: 'disc', paddingLeft: '20px' }}>
          <li>Click and drag in the 3D space to rotate the view</li>
          <li>Use scroll wheel to zoom in/out</li>
          <li>Click on routers to view their routing tables</li>
          <li>Use the control panel to:
            <ul style={{ paddingLeft: '20px', marginTop: '5px' }}>
              <li>Add/Remove routers</li>
              <li>Create/Delete links between routers</li>
              <li>Run the DVR algorithm iterations</li>
              <li>Simulate link failures</li>
            </ul>
          </li>
        </ul>
      </div>

      <div style={{ marginBottom: '15px' }}>
        <h3>Visual Guide:</h3>
        <ul style={{ listStyleType: 'disc', paddingLeft: '20px' }}>
          <li>Blue cubes represent routers</li>
          <li>Green lines represent links between routers</li>
          <li>Red lines indicate the shortest path between routers</li>
          <li>Blue animations show routing updates being propagated</li>
          <li>Numbers on links represent link costs</li>
        </ul>
      </div>

      <button
        onClick={onClose}
        style={{
          backgroundColor: '#1976D2',
          color: 'white',
          padding: '8px 16px',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          float: 'right'
        }}
      >
        Got it!
      </button>
    </div>
  );
}

function App() {
  const [routers, setRouters] = useState({});
  const [links, setLinks] = useState([]);
  const [nextRouterId, setNextRouterId] = useState(1);
  const [routerX, setRouterX] = useState(0);
  const [routerY, setRouterY] = useState(0);
  const [routerZ, setRouterZ] = useState(0);
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [cost, setCost] = useState(1);
  const [network, setNetwork] = useState(null);
  const [iteration, setIteration] = useState(0);
  const [running, setRunning] = useState(false);
  const [selectedRouter, setSelectedRouter] = useState(null);
  const [routingTable, setRoutingTable] = useState({});
  const [animationSpeed, setAnimationSpeed] = useState(5);
  const [animations, setAnimations] = useState([]);
  const [selectedLink, setSelectedLink] = useState('');
  const [convergenceStatus, setConvergenceStatus] = useState('');
  const [pathResult, setPathResult] = useState(null);
  const [pathSource, setPathSource] = useState('');
  const [pathDestination, setPathDestination] = useState('');
  const [showConvergenceModal, setShowConvergenceModal] = useState(false);
  const [highlightedPath, setHighlightedPath] = useState([]);
  const [showHelpModal, setShowHelpModal] = useState(true);
  const [convergenceDetected, setConvergenceDetected] = useState(false);
  const [showHelp, setShowHelp] = useState(true);
  const [previousTables, setPreviousTables] = useState({});

  // Animation frame update
  useEffect(() => {
    if (animations.length > 0) {
      const animationFrame = requestAnimationFrame(() => {
        const currentTime = Date.now();

        // Update animation progress
        const updatedAnimations = animations.map(anim => {
          const elapsed = currentTime - anim.startTime;
          const progress = Math.min(1, elapsed / anim.duration);
          return { ...anim, progress };
        });

        // Remove finished animations
        const activeAnimations = updatedAnimations.filter(anim => anim.progress < 1);

        setAnimations(activeAnimations);
      });

      return () => cancelAnimationFrame(animationFrame);
    }
  }, [animations]);

  // Effect to show alert when convergence is detected
  useEffect(() => {
    if (convergenceDetected) {
      // Small delay to ensure state updates complete first
      const timer = setTimeout(() => {
        // Remove the alert
        setConvergenceDetected(false);
        setShowConvergenceModal(true);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [convergenceDetected]);

  useEffect(() => {
    // Remove the localStorage check since we want it to show every time
    setShowHelp(true);
  }, []);

  // Function to add a router
  const addRouter = () => {
    const id = nextRouterId.toString();
    const newRouters = {
      ...routers,
      [id]: { id, x: routerX, y: routerY, z: routerZ }
    };
    setRouters(newRouters);
    setNextRouterId(prev => prev + 1);

    // Reinitialize network with new topology
    const topology = {};
    Object.keys(newRouters).forEach(routerId => {
      topology[routerId] = [];
    });

    links.forEach(link => {
      if (!topology[link.source]) topology[link.source] = [];
      if (!topology[link.destination]) topology[link.destination] = [];

      topology[link.source].push({ neighbor: link.destination, cost: link.cost });
      topology[link.destination].push({ neighbor: link.source, cost: link.cost });
    });

    // Always create a new network when router is added
    const newNetwork = new Network(topology);
    setNetwork(newNetwork);
    setConvergenceStatus('Router added. Press "Run Next Iteration" to see DVR updates...');

    // If a router is selected, update its routing table in the UI
    if (selectedRouter) {
      setTimeout(() => updateRoutingTable(selectedRouter), 0);
    }

    // Clear highlighted path when topology changes
    resetHighlightedPath();
  };

  // Function to delete a router
  const deleteRouter = (id) => {
    const newRouters = { ...routers };
    delete newRouters[id];

    // Also delete all links connected to this router
    const newLinks = links.filter(link =>
      link.source !== id && link.destination !== id
    );

    // Remove any animations involving this router
    const newAnimations = animations.filter(anim =>
      anim.source !== id && anim.target !== id
    );

    setRouters(newRouters);
    setLinks(newLinks);
    setAnimations(newAnimations);

    // Update network topology
    if (network) {
      const topology = {};
      Object.keys(newRouters).forEach(routerId => {
        topology[routerId] = [];
      });

      newLinks.forEach(link => {
        if (!topology[link.source]) topology[link.source] = [];
        if (!topology[link.destination]) topology[link.destination] = [];

        topology[link.source].push({ neighbor: link.destination, cost: link.cost });
        topology[link.destination].push({ neighbor: link.source, cost: link.cost });
      });

      const newNetwork = new Network(topology);
      setNetwork(newNetwork);
      setConvergenceStatus('Router deleted. Press "Run Next Iteration" to see DVR updates...');

      // If a router is selected and it's not the deleted one, update its routing table in the UI
      if (selectedRouter && selectedRouter !== id) {
        updateRoutingTable(selectedRouter);
      }
    }

    if (selectedRouter === id) {
      setSelectedRouter(null);
      setRoutingTable({});
    }

    // Clear highlighted path when topology changes
    resetHighlightedPath();
  };

  // Function to add a link
  const addLink = () => {
    if (!source || !destination || source === destination) return;

    // Check if link already exists
    const exists = links.some(link =>
      (link.source === source && link.destination === destination) ||
      (link.source === destination && link.destination === source)
    );

    if (!exists) {
      const newLink = { source, destination, cost: parseInt(cost) };
      const newLinks = [...links, newLink];
      setLinks(newLinks);

      // Update network topology
      const topology = {};
      Object.keys(routers).forEach(routerId => {
        topology[routerId] = [];
      });

      newLinks.forEach(link => {
        if (!topology[link.source]) topology[link.source] = [];
        if (!topology[link.destination]) topology[link.destination] = [];

        topology[link.source].push({ neighbor: link.destination, cost: link.cost });
        topology[link.destination].push({ neighbor: link.source, cost: link.cost });
      });

      // Always create a new network when link is added
      const newNetwork = new Network(topology);
      setNetwork(newNetwork);
      setConvergenceStatus('Link added. Press "Run Next Iteration" to see DVR updates...');

      // If a router is selected, update its routing table in the UI
      if (selectedRouter) {
        setTimeout(() => updateRoutingTable(selectedRouter), 0);
      }
    }

    // Clear highlighted path when topology changes
    resetHighlightedPath();
  };

  // Function to reset iteration counter
  const resetIterations = () => {
    // Reset UI iteration counter to 0
    setIteration(0);

    // Create a fresh network with the current topology
    if (routers && Object.keys(routers).length > 0) {
      const topology = {};

      // Initialize each router with empty links
      Object.keys(routers).forEach(id => {
        topology[id] = [];
      });

      // Add all links to topology
      links.forEach(link => {
        topology[link.source].push({ neighbor: link.destination, cost: link.cost });
        topology[link.destination].push({ neighbor: link.source, cost: link.cost });
      });

      // Create a new network to reset all routing tables
      const newNetwork = new Network(topology);
      setNetwork(newNetwork);

      // Reset the routing table display if a router is selected
      if (selectedRouter) {
        setTimeout(() => updateRoutingTable(selectedRouter), 0);
      }
    }

    setConvergenceStatus('Network reset. Press "Run Next Iteration" to start...');

    // Clear animations
    setAnimations([]);
  };

  // Function to handle router failure
  const handleRouterFailure = (id) => {
    if (network) {
      // Remove router from UI
      const newRouters = { ...routers };
      delete newRouters[id];

      // Remove links connected to this router
      const newLinks = links.filter(link =>
        link.source !== id && link.destination !== id
      );

      setRouters(newRouters);
      setLinks(newLinks);

      // Create new network with updated topology
      const topology = {};
      Object.keys(newRouters).forEach(routerId => {
        topology[routerId] = [];
      });

      newLinks.forEach(link => {
        if (!topology[link.source]) topology[link.source] = [];
        if (!topology[link.destination]) topology[link.destination] = [];

        topology[link.source].push({ neighbor: link.destination, cost: link.cost });
        topology[link.destination].push({ neighbor: link.source, cost: link.cost });
      });

      const newNetwork = new Network(topology);
      setNetwork(newNetwork);
      setConvergenceStatus('Router failed. Press "Run Next Iteration" to see DVR updates...');

      // If a router is selected and it's not the failed one, update its routing table
      if (selectedRouter && selectedRouter !== id) {
        updateRoutingTable(selectedRouter);
      } else if (selectedRouter === id) {
        setSelectedRouter(null);
        setRoutingTable({});
      }
    }
  };

  // Function to run algorithm iterations
  const runIteration = () => {
    // If no network exists yet, create one
    if (!network) {
      // Check if we have routers to create a network
      if (Object.keys(routers).length === 0) {
        setConvergenceStatus('⚠️ Please add routers first before running iterations');
        return;
      }

      // Check if we have links to create a network
      if (links.length === 0) {
        setConvergenceStatus('⚠️ Please add links between routers before running iterations');
        return;
      }

      // Create network topology
      const topology = {};

      // Initialize each router with empty links
      Object.keys(routers).forEach(id => {
        topology[id] = [];
      });

      // Add all links to topology
      links.forEach(link => {
        topology[link.source].push({ neighbor: link.destination, cost: link.cost });
        topology[link.destination].push({ neighbor: link.source, cost: link.cost });
      });

      // Create the network
      const newNetwork = new Network(topology);
      setNetwork(newNetwork);
      // Set iteration to match network's internal iteration (0)
      setIteration(0);
      console.log("Network initialized with topology:", topology);
    }

    if (running) return; // Prevent multiple simultaneous iterations

    setRunning(true);
    setConvergenceStatus('Running DVR iteration...');

    // Create update message animations
    const updateAnimations = [];

    // Only create animations for active links
    links.forEach(link => {
      const sourceRouter = network?.routers[link.source];
      const destRouter = network?.routers[link.destination];

      if (sourceRouter?.isActive && destRouter?.isActive) {
        updateAnimations.push({
          type: 'update',
          source: link.source,
          target: link.destination,
          progress: 0,
          startTime: Date.now(),
          duration: animationSpeed * 1000,
          iteration: iteration
        });

        updateAnimations.push({
          type: 'update',
          source: link.destination,
          target: link.source,
          progress: 0,
          startTime: Date.now(),
          duration: animationSpeed * 1000,
          iteration: iteration
        });
      }
    });

    setAnimations(prev => [...prev, ...updateAnimations]);

    setTimeout(() => {
      try {
        // Double-check that network is initialized
        if (!network) {
          setRunning(false);
          setConvergenceStatus('⚠️ Network initialization failed. Please try again.');
          return;
        }

        console.log("Running iteration on network:", network);

        // Store current routing tables for comparison
        const previousRoutingTables = {};
        Object.keys(network.routers).forEach(routerId => {
          previousRoutingTables[routerId] = JSON.parse(JSON.stringify(network.routers[routerId].routingTable));
        });

        // Run a single iteration
        const hasChanges = network.runIteration();
        console.log("### Network runIteration returned hasChanges:", hasChanges);

        // Get the current iteration from the network
        const currentIteration = network.iteration - 1; // The iteration we just completed

        // Update our UI iteration to match the network's iteration
        setIteration(network.iteration);
        setRunning(false);

        console.log(`Completed iteration ${currentIteration}, new iteration is ${network.iteration}`);

        // Get current tables after running the iteration
        const currentRoutingTables = {};
        Object.keys(network.routers).forEach(routerId => {
          currentRoutingTables[routerId] = JSON.parse(JSON.stringify(network.routers[routerId].routingTable));
        });

        // Check for convergence using our explicit comparison function
        const converged = checkForConvergence(currentRoutingTables, previousTables);

        // Store current tables for next iteration
        setPreviousTables(currentRoutingTables);

        // First check for convergence using our explicit check
        if (converged) {
          console.log("CONVERGENCE DETECTED - Network has converged (explicit check)!");
          // Remove the alert
          setConvergenceStatus('✅ Routing tables converged');
          setShowConvergenceModal(true);
          setConvergenceDetected(true);
        }
        // Then also check using the hasChanges flag as a backup
        else if (!hasChanges && currentIteration > 0) {
          console.log("CONVERGENCE DETECTED - Network has converged (hasChanges check)!");
          // Remove the alert
          setConvergenceStatus('✅ Routing tables converged');
          setShowConvergenceModal(true);
          setConvergenceDetected(true);
        }

        // Ensure routing table display is updated for currently selected router
        if (selectedRouter) {
          console.log("Updating routing table for selected router after iteration");
          updateRoutingTable(selectedRouter);
        }
      } catch (error) {
        console.error('Error during iteration:', error);
        setRunning(false);
        setConvergenceStatus('⚠️ Error during iteration: ' + error.message);
      }
    }, animationSpeed * 1000);
  };

  // Function to view router's routing table
  const viewRoutingTable = (id) => {
    console.log(`Router ${id} clicked, previously selected: ${selectedRouter}`);

    // Toggle selection if clicking the same router again
    if (id === selectedRouter) {
      setSelectedRouter(null);
      setRoutingTable({});
      console.log("Router deselected, clearing routing table");
    } else {
      setSelectedRouter(id);
      console.log(`Router ${id} selected, updating routing table`);
      // Ensure routing table is updated immediately
      if (network && network.routers[id]) {
        const updatedTable = JSON.parse(JSON.stringify(network.routers[id].routingTable));
        console.log("New routing table:", updatedTable);
        setRoutingTable(updatedTable);
      } else {
        console.log(`Cannot update routing table: Router ${id} not found in network`);
        setRoutingTable({});
      }
    }
  };

  // Update routing table data
  const updateRoutingTable = (id) => {
    if (network && network.routers[id]) {
      console.log(`Updating routing table for router ${id}:`, network.routers[id].routingTable);

      // Create a new object to ensure React detects the change
      const updatedTable = JSON.parse(JSON.stringify(network.routers[id].routingTable));
      setRoutingTable(updatedTable);
    } else {
      console.log(`Cannot update routing table for router ${id}: Router not found or network not initialized`);
      setRoutingTable({});
    }
  };

  // Function to delete a link
  const deleteLink = () => {
    if (!selectedLink) return;

    const [source, destination] = selectedLink.split('-');

    // Filter out the selected link
    const newLinks = links.filter(link =>
      !((link.source === source && link.destination === destination) ||
        (link.source === destination && link.destination === source))
    );

    setLinks(newLinks);

    // Update network topology following DVR protocol
    if (network) {
      // First, notify the routers about the link failure
      const sourceRouter = network.routers[source];
      const destRouter = network.routers[destination];

      if (sourceRouter && destRouter) {
        // Create update message animations for the initial failure notification
        const updateAnimations = [
          {
            type: 'failure',
            source: source,
            target: destination,
            progress: 0,
            startTime: Date.now(),
            duration: animationSpeed * 1000,
            iteration: iteration + 1
          },
          {
            type: 'failure',
            source: destination,
            target: source,
            progress: 0,
            startTime: Date.now(),
            duration: animationSpeed * 1000,
            iteration: iteration + 1
          }
        ];

        setAnimations(prev => [...prev, ...updateAnimations]);

        // After animation completes, handle the DVR updates
        setTimeout(() => {
          // Remove the link from both routers' routing tables
          sourceRouter.handleLinkFailure(destination);
          destRouter.handleLinkFailure(source);

          // Create new network with updated topology
          const topology = {};
          Object.keys(routers).forEach(routerId => {
            topology[routerId] = [];
          });

          newLinks.forEach(link => {
            if (!topology[link.source]) topology[link.source] = [];
            if (!topology[link.destination]) topology[link.destination] = [];

            topology[link.source].push({ neighbor: link.destination, cost: link.cost });
            topology[link.destination].push({ neighbor: link.source, cost: link.cost });
          });

          const newNetwork = new Network(topology);
          // Copy over routing tables from the old network
          Object.keys(network.routers).forEach(routerId => {
            if (newNetwork.routers[routerId]) {
              newNetwork.routers[routerId].routingTable = { ...network.routers[routerId].routingTable };
            }
          });

          setNetwork(newNetwork);
          setConvergenceStatus('Link failed. Press "Run Next Iteration" to see DVR updates...');

          // Update the UI with the initial state
          if (selectedRouter) {
            updateRoutingTable(selectedRouter);
          }

          // Increment iteration counter for the initial failure
          setIteration(prev => prev + 1);
        }, animationSpeed * 1000);
      }
    }

    setSelectedLink('');

    // Clear highlighted path when topology changes
    resetHighlightedPath();
  };

  // New function to handle link failure
  const handleLinkFailure = (source, destination) => {
    if (network) {
      // Find and remove the link from the links array
      const newLinks = links.filter(link =>
        !((link.source === source && link.destination === destination) ||
          (link.source === destination && link.destination === source))
      );
      setLinks(newLinks);

      // Use our new approach to handle link failures
      const sourceRouter = network.routers[source];
      const destRouter = network.routers[destination];

      if (sourceRouter && destRouter) {
        // Create update message animations for the initial failure notification
        const updateAnimations = [
          {
            type: 'failure',
            source: source,
            target: destination,
            progress: 0,
            startTime: Date.now(),
            duration: animationSpeed * 1000,
            iteration: iteration + 1
          },
          {
            type: 'failure',
            source: destination,
            target: source,
            progress: 0,
            startTime: Date.now(),
            duration: animationSpeed * 1000,
            iteration: iteration + 1
          }
        ];

        setAnimations(prev => [...prev, ...updateAnimations]);

        // After animation completes, handle the DVR updates
        setTimeout(() => {
          // Remove the link from both routers' routing tables
          sourceRouter.handleLinkFailure(destination);
          destRouter.handleLinkFailure(source);

          // Create new network with updated topology
          const topology = {};
          Object.keys(routers).forEach(routerId => {
            topology[routerId] = [];
          });

          newLinks.forEach(link => {
            if (!topology[link.source]) topology[link.source] = [];
            if (!topology[link.destination]) topology[link.destination] = [];

            topology[link.source].push({ neighbor: link.destination, cost: link.cost });
            topology[link.destination].push({ neighbor: link.source, cost: link.cost });
          });

          const newNetwork = new Network(topology);
          // Copy over routing tables from the old network
          Object.keys(network.routers).forEach(routerId => {
            if (newNetwork.routers[routerId]) {
              newNetwork.routers[routerId].routingTable = { ...network.routers[routerId].routingTable };
            }
          });

          setNetwork(newNetwork);
          setConvergenceStatus('Link failed. Press "Run Next Iteration" to see DVR updates...');

          // Update the UI with the initial state
          if (selectedRouter) {
            updateRoutingTable(selectedRouter);
          }

          // Increment iteration counter for the initial failure
          setIteration(prev => prev + 1);
        }, animationSpeed * 1000);
      }
    }
  };

  // New function to find path
  const findPath = () => {
    if (!pathSource || !pathDestination || !network) return;

    const result = network.findPath(pathSource, pathDestination);
    setPathResult(result);

    // Set the highlighted path if a path was found
    if (result.path && result.path.length > 0) {
      setHighlightedPath(result.path);
    } else {
      setHighlightedPath([]);
    }
  };

  // Reset highlighted path when changing router or link configurations
  const resetHighlightedPath = () => {
    setHighlightedPath([]);
    setPathResult(null);
    setPathSource('');
    setPathDestination('');
  };

  // Add this new function to check for convergence
  const checkForConvergence = (currentTables, prevTables) => {
    // Skip check if this is the first iteration or there are no previous tables
    if (iteration === 0 || Object.keys(prevTables).length === 0) {
      return false;
    }

    // Check if we have the same routers in both tables
    const currentRouters = Object.keys(currentTables);
    const prevRouters = Object.keys(prevTables);

    if (currentRouters.length !== prevRouters.length) {
      return false;
    }

    // Compare each router's table
    for (const routerId of currentRouters) {
      const currentTable = currentTables[routerId];
      const prevTable = prevTables[routerId];

      // Skip if router doesn't exist in previous tables
      if (!prevTable) {
        return false;
      }

      // Compare destinations
      const currentDests = Object.keys(currentTable);
      const prevDests = Object.keys(prevTable);

      if (currentDests.length !== prevDests.length) {
        return false;
      }

      // Check each destination's cost and next hop
      for (const dest of currentDests) {
        if (!prevTable[dest]) {
          return false;
        }

        // Check cost
        if (currentTable[dest].cost !== prevTable[dest].cost) {
          return false;
        }

        // Check next hop
        if (currentTable[dest].nextHop !== prevTable[dest].nextHop) {
          return false;
        }
      }
    }

    // If we got here, the tables are identical
    console.log("TABLES IDENTICAL - CONVERGENCE DETECTED!");
    return true;
  };

  return (
    <div className="App">
      <HelpModal
        isOpen={showHelp}
        onClose={() => setShowHelp(false)}
      />
      {/* Convergence Modal */}
      {showConvergenceModal && (
        <div className="modal-overlay" onClick={() => setShowConvergenceModal(false)}>
          <div className="modal-content"
            style={{ backgroundColor: '#e6ffee', boxShadow: '0 0 10px green' }}
            onClick={e => e.stopPropagation()}>
            <h2 style={{ color: 'green' }}>DVR Convergence</h2>
            <p>The network has converged! All routing tables are stable.</p>
            <button
              style={{ backgroundColor: '#4CAF50', color: 'white', padding: '8px 16px' }}
              onClick={() => setShowConvergenceModal(false)}>OK</button>
          </div>
        </div>
      )}

      {/* Help Modal */}
      {showHelpModal && (
        <div className="modal-overlay" onClick={() => setShowHelpModal(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            zIndex: 9999,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center'
          }}>
          <div className="modal-content"
            style={{
              backgroundColor: 'white',
              padding: '20px',
              borderRadius: '8px',
              maxWidth: '700px',
              maxHeight: '80vh',
              overflowY: 'auto',
              position: 'relative',
              textAlign: 'left'
            }}
            onClick={e => e.stopPropagation()}>
            <h2 style={{ color: '#1976D2', marginTop: 0, textAlign: 'left' }}>Distance Vector Routing Simulator Help</h2>

            <h3>What is this application?</h3>
            <p>This is a simulator for the Distance Vector Routing (DVR) algorithm used in computer networks. It visualizes how routers exchange information to build their routing tables until they converge.</p>

            <h3>How to use this application:</h3>
            <ol>
              <li><strong>Create a network</strong>:
                <ul>
                  <li>Add routers using the Router Controls (set X, Y, Z coordinates and click Add Router)</li>
                  <li>Connect routers with links using the Link Controls (select source, destination, cost, then click Add Link)</li>
                </ul>
              </li>
              <li><strong>Run the simulation</strong>:
                <ul>
                  <li>Click "Run Next Iteration" to advance the simulation one step</li>
                  <li>Watch as routers exchange information and update their routing tables</li>
                  <li>Continue running iterations until convergence (when tables stabilize)</li>
                </ul>
              </li>
              <li><strong>Explore the network</strong>:
                <ul>
                  <li>Click on a router to see its routing table</li>
                  <li>Use the Path Finder to find the shortest path between routers</li>
                  <li>Delete links or routers to see how the network adapts</li>
                </ul>
              </li>
            </ol>

            <h3>Understanding the visualization:</h3>
            <ul>
              <li><strong>Routers</strong>: The blue cubes with numbers</li>
              <li><strong>Links</strong>: The green tubes connecting routers with cost labels</li>
              <li><strong>Animations</strong>: Blue spheres show routing updates being sent</li>
              <li><strong>Red paths</strong>: Highlighted shortest paths when using the Path Finder</li>
              <li><strong>Iterations</strong>: Each step of the algorithm as routers share information</li>
              <li><strong>Convergence</strong>: When routing tables stop changing (indicated by an alert)</li>
            </ul>

            <h3>Tips:</h3>
            <ul>
              <li>You must create at least two routers and connect them before running iterations</li>
              <li>At iteration 0, routers only know about themselves and direct neighbors</li>
              <li>Rotating the view: Drag with left mouse button</li>
              <li>Zooming: Use mouse wheel or pinch gesture</li>
              <li>Panning: Drag with right mouse button</li>
            </ul>

            <button
              style={{
                backgroundColor: '#1976D2',
                color: 'white',
                padding: '8px 16px',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                marginTop: '20px'
              }}
              onClick={() => setShowHelpModal(false)}>Close Help</button>
          </div>
        </div>
      )}

      <div className="app-container">
        {/* Left Control Panel */}
        <div className="left-panel">
          <div className="control-section">
            <h2>Router Controls</h2>
            <div className="form-group">
              <label>X: </label>
              <input
                type="number"
                value={routerX}
                onChange={(e) => setRouterX(parseInt(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>Y: </label>
              <input
                type="number"
                value={routerY}
                onChange={(e) => setRouterY(parseInt(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>Z: </label>
              <input
                type="number"
                value={routerZ}
                onChange={(e) => setRouterZ(parseInt(e.target.value))}
              />
            </div>
            <button onClick={addRouter}>Add Router</button>
          </div>

          <div className="control-section">
            <h2>Delete Router</h2>
            <select onChange={(e) => deleteRouter(e.target.value)}>
              <option value="">Select Router to Delete</option>
              {Object.keys(routers).map(id => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </div>

          <div className="control-section">
            <h2>Link Controls</h2>
            <div className="form-group">
              <label>Source: </label>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Select Source</option>
                {Object.keys(routers).map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Destination: </label>
              <select value={destination} onChange={(e) => setDestination(e.target.value)}>
                <option value="">Select Destination</option>
                {Object.keys(routers).map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Cost: </label>
              <input
                type="number"
                value={cost}
                onChange={(e) => setCost(parseInt(e.target.value))}
                min="1"
              />
            </div>
            <button onClick={addLink}>Add Link</button>
          </div>

          <div className="control-section">
            <h2>Delete Link</h2>
            <select value={selectedLink} onChange={(e) => setSelectedLink(e.target.value)}>
              <option value="">Select Link to Delete</option>
              {links.map((link, index) => (
                <option key={index} value={`${link.source}-${link.destination}`}>
                  {link.source} ↔ {link.destination} (Cost: {link.cost})
                </option>
              ))}
            </select>
            <button onClick={deleteLink} disabled={!selectedLink}>Delete Link</button>
          </div>
        </div>

        {/* Center Visualization */}
        <div className="visualization-container">
          <div className="visualization">
            <Canvas>
              <Network3D
                routers={routers}
                links={links}
                selectedRouter={selectedRouter}
                onRouterClick={viewRoutingTable}
                routingTable={routingTable}
                animations={animations}
                iteration={iteration}
                highlightedPath={highlightedPath}
              />
            </Canvas>
            <div className="iteration-display">
              <div className="iteration-counter">
                Iteration: {iteration}
                {convergenceStatus.includes('converged') &&
                  <span style={{ color: 'red', fontWeight: 'bold', marginLeft: '10px' }}>
                    CONVERGED!
                  </span>
                }
              </div>
              <div className="iteration-status">
                {convergenceStatus}
                {convergenceStatus.includes('converged') && (
                  // <button
                  //   onClick={() => alert('DVR Convergence')}
                  //   style={{
                  //     marginLeft: '10px',
                  //     backgroundColor: '#d32f2f',
                  //     color: 'white',
                  //     border: 'none',
                  //     padding: '5px 10px',
                  //     borderRadius: '4px',
                  //     cursor: 'pointer'
                  //   }}
                  // >
                  //   Show Alert
                  // </button>
                  <></>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Control Panel */}
        <div className="right-panel">
          <div className="control-section">
            <h2>Algorithm Controls</h2>
            <button onClick={runIteration} disabled={running}>
              {running ? "Running..." : "Run Next Iteration"}
            </button>
            <button onClick={resetIterations}>
              Reset Iterations
            </button>
          </div>

          <div className="control-section">
            <h2>Animation Control</h2>
            <div className="form-group">
              <label>Animation Speed: </label>
              <input
                type="range"
                min="1"
                max="10"
                value={animationSpeed}
                onChange={(e) => setAnimationSpeed(parseInt(e.target.value))}
              />
              <span>{animationSpeed}s</span>
            </div>
          </div>

          <div className="control-section">
            <h2>Path Finder</h2>
            <select value={pathSource} onChange={(e) => setPathSource(e.target.value)}>
              <option value="">Select Source</option>
              {Object.keys(routers).map(id => (
                <option key={id} value={id}>Router {id}</option>
              ))}
            </select>
            <select value={pathDestination} onChange={(e) => setPathDestination(e.target.value)}>
              <option value="">Select Destination</option>
              {Object.keys(routers).map(id => (
                <option key={id} value={id}>Router {id}</option>
              ))}
            </select>
            <button
              onClick={findPath}
              disabled={!pathSource || !pathDestination}
            >
              Find Path
            </button>
            <button
              onClick={resetHighlightedPath}
              disabled={!highlightedPath.length}
            >
              Clear Path
            </button>
            {pathResult && (
              <div className="path-result">
                {pathResult.path.length > 0 ? (
                  <>
                    <p>Path: {pathResult.path.join(' → ')}</p>
                    <p>Total Cost: {pathResult.cost}</p>
                  </>
                ) : (
                  <p>No path found</p>
                )}
              </div>
            )}
          </div>

          {selectedRouter && (
            <div className="control-section">
              <h2>Routing Table for Router {selectedRouter}</h2>
              <div className="routing-table">
                {Object.keys(routingTable).length > 0 ? (
                  Object.entries(routingTable).map(([dest, info]) => (
                    <div key={dest} className="routing-entry">
                      <span>Destination: {dest}</span>
                      <span>Next Hop: {info.nextHop || '-'}</span>
                      <span>Cost: {info.cost === Infinity ? "∞" : info.cost}</span>
                    </div>
                  ))
                ) : (
                  <p>No routing table entries available.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Help Button */}
      <button
        onClick={() => setShowHelpModal(true)}
        style={{
          position: 'fixed',
          bottom: '15px',
          right: '15px',
          width: '70px',
          backgroundColor: '#1976D2',
          color: 'white',
          fontWeight: 'bold',
          padding: '5px 10px',
          fontSize: '12px',
          borderRadius: '4px',
          border: 'none',
          boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
          cursor: 'pointer',
          zIndex: 900
        }}
      >
        HELP
      </button>
    </div>
  );
}

export default App;

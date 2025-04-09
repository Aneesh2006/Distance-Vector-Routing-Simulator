import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import { Router, Network } from './DvrAlgorithm';
import Network3D from './Network3D';
import { Canvas } from '@react-three/fiber';

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
<<<<<<< HEAD
<<<<<<< HEAD
  const [convergenceStatus, setConvergenceStatus] = useState('');
  const [pathResult, setPathResult] = useState(null);
  const [pathSource, setPathSource] = useState('');
  const [pathDestination, setPathDestination] = useState('');
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe

  // Function to add a router
  const addRouter = () => {
    const id = nextRouterId.toString();
    setRouters(prev => ({
      ...prev,
      [id]: { id, x: routerX, y: routerY, z: routerZ }
    }));
    setNextRouterId(prev => prev + 1);
<<<<<<< HEAD
<<<<<<< HEAD

    // Reinitialize network with new topology
    if (network) {
      const topology = {};
      Object.keys({...routers, [id]: { id, x: routerX, y: routerY, z: routerZ }}).forEach(routerId => {
        topology[routerId] = [];
      });

      links.forEach(link => {
        if (!topology[link.source]) topology[link.source] = [];
        if (!topology[link.destination]) topology[link.destination] = [];
        
        topology[link.source].push({ neighbor: link.destination, cost: link.cost });
        topology[link.destination].push({ neighbor: link.source, cost: link.cost });
      });

      const newNetwork = new Network(topology);
      setNetwork(newNetwork);
      setConvergenceStatus('Router added. Press "Run Next Iteration" to see DVR updates...');
      
      // If a router is selected, update its routing table in the UI
      if (selectedRouter) {
        updateRoutingTable(selectedRouter);
      }
    }
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
  };

  // Function to delete a router
  const deleteRouter = (id) => {
    const newRouters = { ...routers };
    delete newRouters[id];

<<<<<<< HEAD
<<<<<<< HEAD
=======
    // Also delete all links connected to this router
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
    // Also delete all links connected to this router
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    const newLinks = links.filter(link =>
      link.source !== id && link.destination !== id
    );

<<<<<<< HEAD
<<<<<<< HEAD
=======
    // Remove any animations involving this router
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
    // Remove any animations involving this router
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    const newAnimations = animations.filter(anim =>
      anim.source !== id && anim.target !== id
    );

<<<<<<< HEAD
<<<<<<< HEAD
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    // Update routing tables in the network to handle the deleted router
    if (network) {
      network.handleRouterDeletion(id);

      // Run an iteration to propagate the changes through the network
      setTimeout(() => {
        network.runIteration();
        setIteration(prev => prev + 1);

        // If a router is selected, update its displayed routing table
        if (selectedRouter && selectedRouter !== id) {
          updateRoutingTable(selectedRouter);
        }
      }, 500);
    }

<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    setRouters(newRouters);
    setLinks(newLinks);
    setAnimations(newAnimations);

<<<<<<< HEAD
<<<<<<< HEAD
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

=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    if (selectedRouter === id) {
      setSelectedRouter(null);
      setRoutingTable({});
    }
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
<<<<<<< HEAD
<<<<<<< HEAD
      const newLink = { source, destination, cost: parseInt(cost) };
      setLinks(prev => [...prev, newLink]);

      // Update network topology
      if (network) {
        const topology = {};
        Object.keys(routers).forEach(routerId => {
          topology[routerId] = [];
        });

        [...links, newLink].forEach(link => {
          if (!topology[link.source]) topology[link.source] = [];
          if (!topology[link.destination]) topology[link.destination] = [];
          
          topology[link.source].push({ neighbor: link.destination, cost: link.cost });
          topology[link.destination].push({ neighbor: link.source, cost: link.cost });
        });

        const newNetwork = new Network(topology);
        setNetwork(newNetwork);
        setConvergenceStatus('Link added. Press "Run Next Iteration" to see DVR updates...');
        
        // If a router is selected, update its routing table in the UI
        if (selectedRouter) {
          updateRoutingTable(selectedRouter);
        }
      }
    }
  };

  // Function to reset iteration counter
  const resetIterations = () => {
    setIteration(0);
    setConvergenceStatus('Iteration counter reset. Press "Run Next Iteration" to start...');
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
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
      setLinks(prev => [
        ...prev,
        { source, destination, cost: parseInt(cost) }
      ]);
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    }
  };

  // Function to run algorithm iterations
  const runIteration = () => {
    if (!network) {
      // Create network on first run
      const topology = {};

      // Initialize each router with empty links
      Object.keys(routers).forEach(id => {
        topology[id] = [];
      });

      // Add all links to topology
      links.forEach(link => {
<<<<<<< HEAD
<<<<<<< HEAD
        if (!topology[link.source]) topology[link.source] = [];
        if (!topology[link.destination]) topology[link.destination] = [];
        
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
        topology[link.source].push({ neighbor: link.destination, cost: link.cost });
        topology[link.destination].push({ neighbor: link.source, cost: link.cost });
      });

<<<<<<< HEAD
<<<<<<< HEAD
      // Only create network if we have routers
      if (Object.keys(topology).length > 0) {
        const newNetwork = new Network(topology);
        setNetwork(newNetwork);
      } else {
        setConvergenceStatus('⚠️ No routers in the network');
        return;
      }
    }

    if (running) return; // Prevent multiple simultaneous iterations

    setRunning(true);
    setConvergenceStatus('Running DVR iteration...');
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
      const newNetwork = new Network(topology);
      setNetwork(newNetwork);
    }

    // Run one iteration
    setRunning(true);
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe

    // Create update message animations
    const updateAnimations = [];

<<<<<<< HEAD
<<<<<<< HEAD
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
          iteration: iteration + 1
        });

        updateAnimations.push({
          type: 'update',
          source: link.destination,
          target: link.source,
          progress: 0,
          startTime: Date.now(),
          duration: animationSpeed * 1000,
          iteration: iteration + 1
        });
      }
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    links.forEach(link => {
      updateAnimations.push({
        type: 'update',
        source: link.source,
        target: link.destination,
        progress: 0,
        startTime: Date.now(),
        duration: animationSpeed * 1000,
      });

      updateAnimations.push({
        type: 'update',
        source: link.destination,
        target: link.source,
        progress: 0,
        startTime: Date.now(),
        duration: animationSpeed * 1000,
      });
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    });

    setAnimations(prev => [...prev, ...updateAnimations]);

    setTimeout(() => {
<<<<<<< HEAD
<<<<<<< HEAD
      try {
        if (!network) {
          setRunning(false);
          setConvergenceStatus('⚠️ Network not initialized');
          return;
        }

        // Store current routing tables for count-to-infinity detection
        const previousRoutingTables = {};
        Object.keys(network.routers).forEach(routerId => {
          previousRoutingTables[routerId] = {...network.routers[routerId].routingTable};
        });

        // Run a single iteration instead of convergence
        const hasChanges = network.runIteration();
        setIteration(prev => prev + 1);
        setRunning(false);

        // Check for count-to-infinity problem (costs increasing without reaching destination)
        let countToInfinityDetected = false;
        let affectedRoutes = [];

        Object.keys(network.routers).forEach(routerId => {
          const router = network.routers[routerId];
          const prevTable = previousRoutingTables[routerId];
          
          Object.keys(router.routingTable).forEach(destination => {
            const newRoute = router.routingTable[destination];
            const prevRoute = prevTable?.[destination];
            
            // If cost is increasing but still using same next hop, likely count-to-infinity
            if (prevRoute && newRoute && 
                newRoute.nextHop === prevRoute.nextHop && 
                newRoute.cost > prevRoute.cost && 
                newRoute.cost !== Infinity && 
                prevRoute.cost !== Infinity) {
              countToInfinityDetected = true;
              affectedRoutes.push(`${routerId}→${destination}`);
            }
          });
        });

        if (countToInfinityDetected && iteration > 3) {
          setConvergenceStatus(`⚠️ Count-to-infinity detected! Costs increasing for routes: ${affectedRoutes.join(', ')}. Continue iterations to see the problem.`);
        } else if (!hasChanges) {
          setConvergenceStatus('✅ Routing tables converged');
        } else {
          setConvergenceStatus(`Completed iteration ${iteration + 1}. Press "Run Next Iteration" to continue...`);
        }

        if (selectedRouter) {
          updateRoutingTable(selectedRouter);
        }
      } catch (error) {
        console.error('Error during iteration:', error);
        setRunning(false);
        setConvergenceStatus('⚠️ Error during iteration');
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
      const anyChanges = network ? network.runIteration() : false;
      setIteration(prev => prev + 1);
      setRunning(false);

      // Update routing table if a router is selected
      if (selectedRouter) {
        updateRoutingTable(selectedRouter);
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
      }
    }, animationSpeed * 1000);
  };

  // Function to view router's routing table
  const viewRoutingTable = (id) => {
    setSelectedRouter(id === selectedRouter ? null : id);
    if (id !== selectedRouter) {
      updateRoutingTable(id);
    }
  };

  // Update routing table data
  const updateRoutingTable = (id) => {
    if (network && network.routers[id]) {
      console.log(`Updating routing table for router ${id}:`, network.routers[id].routingTable);

      // Create a new object to ensure React detects the change
      const updatedTable = { ...network.routers[id].routingTable };
      setRoutingTable(updatedTable);
    }
  };

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

  // Function to delete a link
  const deleteLink = () => {
    if (!selectedLink) return;

<<<<<<< HEAD
<<<<<<< HEAD
    const [source, destination] = selectedLink.split('-');
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    console.log("Deleting link:", selectedLink);

    // Parse the selectedLink value to get source and destination
    const [source, destination] = selectedLink.split('-');

    // Filter out the selected link
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    const newLinks = links.filter(link =>
      !((link.source === source && link.destination === destination) ||
        (link.source === destination && link.destination === source))
    );

<<<<<<< HEAD
<<<<<<< HEAD
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
              newNetwork.routers[routerId].routingTable = {...network.routers[routerId].routingTable};
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
              newNetwork.routers[routerId].routingTable = {...network.routers[routerId].routingTable};
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
  };

  return (
    <div className="App">
      <div className="app-container">
        {/* Left Control Panel */}
        <div className="left-panel">
          <div className="control-section">
            <h2>Router Controls</h2>
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    // Update network if it exists
    if (network) {
      console.log("Network before deletion:", network);
      network.handleLinkDeletion(source, destination);
      console.log("Network after deletion:", network);

      // Run an iteration to propagate the changes
      setTimeout(() => {
        network.runIteration();
        setIteration(prev => prev + 1);

        // Update routing table if a router is selected
        if (selectedRouter) {
          console.log("Updating selected router table:", selectedRouter);
          updateRoutingTable(selectedRouter);
        }
      }, 500);
    }

    setLinks(newLinks);
    setSelectedLink('');
  };

  return (
    <div className="App">
      <div className="control-panel">
        <h1>Distance Vector Routing Visualization</h1>

        <div className="section">
          <h2>Add Router</h2>
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
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

<<<<<<< HEAD
<<<<<<< HEAD
          <div className="control-section">
=======
        <div className="section">
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
        <div className="section">
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
          <h2>Delete Router</h2>
          <select onChange={(e) => deleteRouter(e.target.value)}>
            <option value="">Select Router to Delete</option>
            {Object.keys(routers).map(id => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>

<<<<<<< HEAD
<<<<<<< HEAD
          <div className="control-section">
            <h2>Link Controls</h2>
=======
        <div className="section">
          <h2>Add Link</h2>
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
        <div className="section">
          <h2>Add Link</h2>
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
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

<<<<<<< HEAD
<<<<<<< HEAD
          <div className="control-section">
=======
        <div className="section">
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
        <div className="section">
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
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
<<<<<<< HEAD
<<<<<<< HEAD
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
              />
            </Canvas>
            <div className="iteration-display">
              <div className="iteration-counter">
                Iteration: {iteration}
              </div>
              <div className="iteration-status">
                {convergenceStatus}
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
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
        </div>

        <div className="section">
          <h2>Algorithm Control</h2>
          <button onClick={runIteration} disabled={running}>
            {running ? "Running..." : "Run Next Iteration"}
          </button>
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
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
<<<<<<< HEAD
<<<<<<< HEAD
          </div>

          <div className="control-section">
            <h2>Failure Simulation</h2>
            <select 
              value={selectedRouter} 
              onChange={(e) => setSelectedRouter(e.target.value)}
            >
              <option value="">Select Router</option>
              {Object.keys(routers).map(id => (
                <option key={id} value={id}>Router {id}</option>
              ))}
            </select>
            <button 
              onClick={() => handleRouterFailure(selectedRouter)}
              disabled={!selectedRouter}
            >
              Simulate Router Failure
            </button>
          </div>

          <div className="control-section">
            <h2>Link Failure</h2>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Select Source</option>
              {Object.keys(routers).map(id => (
                <option key={id} value={id}>Router {id}</option>
              ))}
            </select>
            <select value={destination} onChange={(e) => setDestination(e.target.value)}>
              <option value="">Select Destination</option>
              {Object.keys(routers).map(id => (
                <option key={id} value={id}>Router {id}</option>
              ))}
            </select>
            <button 
              onClick={() => handleLinkFailure(source, destination)}
              disabled={!source || !destination}
            >
              Simulate Link Failure
            </button>
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
              <h2>Routing Table</h2>
              <div className="routing-table">
                {Object.entries(routingTable).map(([dest, info]) => (
                  <div key={dest} className="routing-entry">
                    <span>Destination: {dest}</span>
                    <span>Next Hop: {info.nextHop}</span>
                    <span>Cost: {info.cost}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
=======
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
          <div>Current Iteration: {iteration}</div>
        </div>
      </div>

      <div className="visualization">
        <Canvas>
          <Network3D
            routers={routers}
            links={links}
            selectedRouter={selectedRouter}
            onRouterClick={viewRoutingTable}
            routingTable={routingTable}
            animations={animations}
          />
        </Canvas>
      </div>
<<<<<<< HEAD
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
=======
>>>>>>> 3b893c17c33a51216d7c493ca0a1db646b0696fe
    </div>
  );
}

export default App;

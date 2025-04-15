# Distance Vector Routing Algorithm Visualization

This React application visualizes the Distance Vector Routing (DVR) algorithm. It allows you to create a network of routers, add links between them, and run the DVR algorithm step by step to see how routing tables evolve.

## Features

1. Add routers on a 3D plane (x, y, z coordinates)
2. Delete routers
3. Create links between routers with custom costs
4. Run the DVR algorithm one iteration at a time
5. View routing tables for each router

## How to Run

1. Make sure you have Node.js installed
2. Navigate to the project directory
3. Install dependencies:
   ```
   npm install
   ```
4. Start the development server:
   ```
   npm start
   ```
5. Open your browser and go to [http://localhost:3000](http://localhost:3000)

## How to Use

1. **Adding Routers**: Set the X, Y, and Z coordinates and click "Add Router". Routers will be automatically named as 1, 2, 3, etc.
2. **Deleting Routers**: Select a router from the dropdown and click it to delete.
3. **Adding Links**: Select source and destination routers, set the link cost, and click "Add Link".
4. **Running the Algorithm**: Click "Run Next Iteration" to run the algorithm one step at a time. Each iteration takes 5 seconds to complete.
5. **Viewing Routing Tables**: Click on any router in the visualization to see its current routing table.

## Implementation Details

The application is built with React and uses the Distance Vector Routing algorithm implementation from the `src/DvrAlgorithm.js` file. The visualization is created using SVG elements.

The primary components are:
- Router and Network classes for the algorithm
- React-based UI for visualization and interaction
- SVG-based network diagram

## Technology Stack

- React
- Three JS
- SVG for visualization
- CSS for styling

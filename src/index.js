import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { applyTheme } from './config';
import reportWebVitals from './reportWebVitals';

// Mirror the JS palette into CSS custom properties so the DOM and the WebGL
// scene are driven by exactly one set of colour definitions.
applyTheme();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element — check public/index.html.');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Pass a callback (e.g. reportWebVitals(console.log)) to start measuring.
reportWebVitals();

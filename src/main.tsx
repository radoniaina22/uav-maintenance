import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles.css';
import './theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* HashRouter : compatible GitHub Pages (pas de réécriture d'URL côté serveur) */}
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startStreamFromLocation } from './live/streamStart';
import { setUpApp } from './pwa';
import './styles.css';
import './table.css';
import './filters.css';
import './insights.css';
import './charts.css';
import './compare.css';
import './responsive.css';

setUpApp();
// Opened by the logsift launcher (cli/): show its log stream live.
startStreamFromLocation();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

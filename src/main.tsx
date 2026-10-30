import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { setUpApp } from './pwa';
import './styles.css';
import './table.css';
import './filters.css';
import './insights.css';
import './responsive.css';

setUpApp();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

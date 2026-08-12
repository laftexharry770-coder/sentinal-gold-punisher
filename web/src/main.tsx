import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './pwa';
import { TerminalProvider } from './store';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

registerServiceWorker();

createRoot(container).render(
  <StrictMode>
    <TerminalProvider>
      <App />
    </TerminalProvider>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './pwa';
import { TerminalProvider } from './store';
import { applyTheme, watchSystemTheme } from './theme';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

registerServiceWorker();
applyTheme();
watchSystemTheme();

createRoot(container).render(
  <StrictMode>
    <TerminalProvider>
      <App />
    </TerminalProvider>
  </StrictMode>,
);

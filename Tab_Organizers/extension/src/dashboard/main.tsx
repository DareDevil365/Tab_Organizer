import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './workspace.css';
import './completion.css';
import '../design-tokens.css';
import './palette.css';
import { registerWorkspacePanel } from '../lib/workspace-panel';
import { startSaveSync } from '../lib/outbox';
startSaveSync();

void registerWorkspacePanel().catch(error => console.debug('Workspace panel unavailable:', error));

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import {
  createInstallOpportunityController,
  InstallOpportunityProvider,
} from './install/InstallOpportunity';
import { ServoraAntProvider } from './ui/antd/ServoraAntProvider';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

const installOpportunityController = createInstallOpportunityController(window);
installOpportunityController.start();

createRoot(rootElement).render(
  <StrictMode>
    <InstallOpportunityProvider controller={installOpportunityController}>
      <ServoraAntProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ServoraAntProvider>
    </InstallOpportunityProvider>
  </StrictMode>,
);

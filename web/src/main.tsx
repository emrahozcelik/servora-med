import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { ServoraAntProvider } from './ui/antd/ServoraAntProvider';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <ServoraAntProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ServoraAntProvider>
  </StrictMode>,
);

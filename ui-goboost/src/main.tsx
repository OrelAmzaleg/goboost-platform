import './index.css';

// GoBoost: bundle Heebo so chat-panel typography works regardless of
// network/CDN availability. The earlier multi-font cycler was removed —
// Heebo covers all legibility cases. (Earlier Frank Ruhl Libre + Rubik
// imports were removed along with the cycler.)
import '@fontsource/heebo/400.css';
import '@fontsource/heebo/700.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { isBrowserRuntime } from './runtime';

async function main() {
  if (isBrowserRuntime) {
    const { initBrowserMock } = await import('./browserMock.js');
    await initBrowserMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main().catch(console.error);

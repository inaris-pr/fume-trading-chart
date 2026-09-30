import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

if (new URLSearchParams(window.location.search).has('bench')) {
  // Benchmark page, loaded as a separate chunk. It is part of the production build on purpose so
  // it measures the production render path; results are only written into the page text.
  void import('./bench.ts').then(({ runBenchmark }) => runBenchmark(root));
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

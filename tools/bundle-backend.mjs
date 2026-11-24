import { readFileSync } from 'node:fs';

// The browser demo and the hosted worker use the same dependency-free ES modules.
export function bundleBackend() {
  const modules = ['planner', 'policy', 'governance', 'equipment', 'haul', 'order-preview', 'unified-shift', 'service', 'http'];
  return ['public/contract-annex.js', ...modules.map(name => 'backend/' + name + '.mjs')].map(path =>
    readFileSync(path, 'utf8')
      .replace(/^import .*?;$/gm, '')
      .replace(/^export /gm, '')
  ).join('\n');
}

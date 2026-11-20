import { readFileSync } from 'node:fs';

// The browser demo and the hosted worker use the same dependency-free ES modules.
export function bundleBackend() {
  return ['planner', 'policy', 'governance', 'equipment', 'haul', 'order-preview', 'service', 'http'].map(name =>
    readFileSync('backend/' + name + '.mjs', 'utf8')
      .replace(/^import .*?;$/gm, '')
      .replace(/^export /gm, '')
  ).join('\n');
}

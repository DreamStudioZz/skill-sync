import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import { scanBase } from './scanner.js';

/**
 * Start watching the Base directory for changes.
 * Calls onChange callback when files change.
 */
export function startWatcher(basePath, onChange) {
  if (!basePath || !fs.existsSync(basePath)) return null;

  // Debounce rapid changes
  let debounceTimer = null;

  const watcher = chokidar.watch(basePath, {
    ignored: /(^|[/\\])\./, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    depth: 5
  });

  const handleChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        const skills = scanBase(basePath);
        onChange(skills);
      } catch (e) {
        console.error('Watcher scan error:', e.message);
      }
    }, 800);
  };

  watcher
    .on('add', handleChange)
    .on('change', handleChange)
    .on('unlink', handleChange)
    .on('addDir', handleChange)
    .on('unlinkDir', handleChange)
    .on('error', (err) => console.error('Watcher error:', err));

  return watcher;
}

/** Stop a watcher */
export function stopWatcher(watcher) {
  if (watcher) watcher.close();
}

import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { WebSocketServer } from 'ws';
import {
  loadConfig, saveConfig, expandPath, ensureAgentDir,
  generateId, getConfigPath, safeRmSync
} from './config.js';
import { scanBase, computeSkillHash, relativeTime } from './scanner.js';
import {
  syncSkill, unsyncSkill, pushChanges, resolveDrift,
  rollback, computeStatusMatrix, getChanges
} from './syncManager.js';
import { startWatcher, stopWatcher } from './watcher.js';

const app = express();
app.use(express.json());

const PORT = 3001;
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --- State ---
let config = loadConfig();
let statusMatrix = {};
let watcher = null;

// --- WebSocket broadcast ---
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// --- Recompute status and broadcast update ---
function refreshAndBroadcast() {
  statusMatrix = computeStatusMatrix(config);
  broadcast('config_updated', { config, statusMatrix });
}

// --- Start/stop file watcher ---
function ensureWatcher() {
  if (watcher) {
    stopWatcher(watcher);
    watcher = null;
  }
  if (config.base.path) {
    watcher = startWatcher(config.base.path, (newSkills) => {
      // Compare to detect actual changes
      const oldHashes = new Map(config.base.skills.map(s => [s.id, s.contentHash]));
      config.base.skills = newSkills;
      // Update agent link statuses
      const changedSkillIds = newSkills.filter(s => oldHashes.get(s.id) !== s.contentHash).map(s => s.id);
      saveConfig(config);
      refreshAndBroadcast();
      if (changedSkillIds.length > 0) {
        broadcast('change_detected', {
          skills: changedSkillIds,
          message: `检测到 ${changedSkillIds.length} 个 skill 有更新`
        });
      }
    });
  }
}

// --- API Routes ---

// Get config + status
app.get('/api/config', (req, res) => {
  statusMatrix = computeStatusMatrix(config);
  res.json({ config, statusMatrix });
});

// Set/change Base path
app.put('/api/base', (req, res) => {
  const { path: basePath } = req.body;
  if (!basePath) return res.status(400).json({ error: '请提供 Base 路径' });

  const expanded = expandPath(basePath);
  if (!fs.existsSync(expanded)) {
    return res.status(400).json({ error: `路径不存在: ${expanded}` });
  }

  config.base.path = expanded;
  config.base.skills = scanBase(expanded);
  saveConfig(config);
  ensureWatcher();
  refreshAndBroadcast();
  res.json({ config, statusMatrix });
});

// Rescan Base
app.post('/api/base/scan', (req, res) => {
  if (!config.base.path) return res.status(400).json({ error: '未设置 Base 路径' });
  config.base.skills = scanBase(config.base.path);
  saveConfig(config);
  refreshAndBroadcast();
  res.json({ config, statusMatrix });
});

// Browse directories
app.get('/api/browse', (req, res) => {
  const requestedPath = req.query.path || os.homedir();
  const expanded = expandPath(requestedPath);

  try {
    const entries = fs.readdirSync(expanded, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      path: expanded,
      parent: path.dirname(expanded) !== expanded ? path.dirname(expanded) : null,
      entries
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List agents
app.get('/api/agents', (req, res) => {
  res.json(config.agents);
});

// Add agent
app.post('/api/agents', (req, res) => {
  const { name, path: agentPath, color, defaultMode } = req.body;
  if (!name || !agentPath) return res.status(400).json({ error: '请提供名称和路径' });

  const id = generateId('agent');
  const agent = {
    id,
    name,
    displayName: name,
    path: agentPath,
    color: color || '#8B5CF6',
    defaultMode: defaultMode || 'link',
    links: []
  };

  // Check if path exists, offer to create
  const expanded = expandPath(agentPath);
  if (!fs.existsSync(expanded)) {
    try {
      fs.mkdirSync(expanded, { recursive: true });
    } catch (e) {
      return res.status(400).json({ error: `无法创建目录: ${e.message}` });
    }
  }

  config.agents.push(agent);
  saveConfig(config);
  refreshAndBroadcast();
  res.json({ config, statusMatrix });
});

// Update agent
app.put('/api/agents/:id', (req, res) => {
  const agent = config.agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent 不存在' });

  const { name, path: newPath, color, defaultMode } = req.body;
  if (name !== undefined) { agent.name = name; agent.displayName = name; }
  if (newPath !== undefined) agent.path = newPath;
  if (color !== undefined) agent.color = color;
  if (defaultMode !== undefined) agent.defaultMode = defaultMode;

  saveConfig(config);
  refreshAndBroadcast();
  res.json({ config, statusMatrix });
});

// Delete agent
app.delete('/api/agents/:id', (req, res) => {
  const { cleanup } = req.body;
  const idx = config.agents.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Agent 不存在' });

  const agent = config.agents[idx];

  if (cleanup) {
    // Remove synced files from agent directory
    for (const link of agent.links) {
      const agentSkillDir = path.join(expandPath(agent.path), link.skillId);
      if (fs.existsSync(agentSkillDir)) {
        const deleted = safeRmSync(agentSkillDir);
        if (!deleted) {
          console.warn(`[agent-delete] Could not delete ${agentSkillDir}`);
        }
      }
    }
  }

  config.agents.splice(idx, 1);
  saveConfig(config);
  refreshAndBroadcast();
  res.json({ config, statusMatrix });
});

// Sync a skill to an agent
app.post('/api/sync', (req, res) => {
  const { skillId, agentId, mode } = req.body;
  if (!skillId || !agentId) return res.status(400).json({ error: '请提供 skillId 和 agentId' });

  try {
    const result = syncSkill(config, skillId, agentId, mode);
    config = result.config;
    saveConfig(config);
    refreshAndBroadcast();
    res.json({ config, statusMatrix, historyEntry: result.historyEntry });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Batch sync multiple skills to multiple agents
app.post('/api/sync/batch', (req, res) => {
  const { skillIds, agentIds, mode } = req.body;
  const errors = [];

  for (const skillId of skillIds) {
    for (const agentId of agentIds) {
      try {
        const result = syncSkill(config, skillId, agentId, mode);
        config = result.config;
      } catch (e) {
        errors.push({ skillId, agentId, error: e.message });
      }
    }
  }

  saveConfig(config);
  refreshAndBroadcast();
  res.json({ config, statusMatrix, errors });
});

// Unsync a skill from an agent
app.delete('/api/sync', (req, res) => {
  const { skillId, agentId } = req.body;
  if (!skillId || !agentId) return res.status(400).json({ error: '请提供 skillId 和 agentId' });

  try {
    const result = unsyncSkill(config, skillId, agentId);
    config = result.config;
    saveConfig(config);
    refreshAndBroadcast();
    res.json({ config, statusMatrix, historyEntry: result.historyEntry });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Push changes to specific agents
app.post('/api/push', (req, res) => {
  const { skillId, agentId } = req.body;
  try {
    const result = pushChanges(config, skillId, agentId);
    config = result.config;
    saveConfig(config);
    refreshAndBroadcast();
    res.json({ config, statusMatrix });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Resolve drift
app.post('/api/drift/resolve', (req, res) => {
  const { skillId, agentId, action, newSkillName } = req.body;
  try {
    const result = resolveDrift(config, skillId, agentId, action, newSkillName);
    config = result.config;
    // If new skill was saved, rescan base
    if (action === 'save_as_new') {
      config.base.skills = scanBase(config.base.path);
    }
    saveConfig(config);
    refreshAndBroadcast();
    res.json({ config, statusMatrix, newSkillId: result.newSkillId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get history
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const history = config.history.slice(-limit).reverse();
  res.json(history);
});

// Rollback
app.post('/api/history/rollback', (req, res) => {
  const { historyId } = req.body;
  try {
    const result = rollback(config, historyId);
    config = result.config;
    saveConfig(config);
    refreshAndBroadcast();
    res.json({ config, statusMatrix });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get changes (stale + drifted)
app.get('/api/changes', (req, res) => {
  statusMatrix = computeStatusMatrix(config);
  const changes = getChanges(config, statusMatrix);
  res.json(changes);
});

// Open a path in the system file explorer
app.post('/api/open', (req, res) => {
  const { targetPath } = req.body;
  if (!targetPath) return res.status(400).json({ error: '请提供路径' });

  const expanded = expandPath(targetPath);
  if (!fs.existsSync(expanded)) {
    return res.status(400).json({ error: `路径不存在: ${expanded}` });
  }

  let cmd;
  if (process.platform === 'win32') {
    // Use `start` — explorer.exe returns exit code 1 even on success
    cmd = `cmd /c start "" "${expanded}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${expanded}"`;
  } else {
    cmd = `xdg-open "${expanded}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      // On Windows, `start` may still report errors even when it works;
      // try explorer.exe as a fallback
      if (process.platform === 'win32') {
        exec(`explorer "${expanded}"`, () => {});
        return res.json({ ok: true });
      }
      return res.status(500).json({ error: `无法打开: ${err.message}` });
    }
    res.json({ ok: true });
  });
});

// Serve built frontend in production
const distPath = path.join(process.cwd(), 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
}

// --- Start server ---
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  SkillDock 服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`  配置文件: ${getConfigPath()}`);
  console.log(`  Base 路径: ${config.base.path || '(未设置)'}`);
  console.log('');

  // Initial status computation
  statusMatrix = computeStatusMatrix(config);

  // Start watcher if base is set
  ensureWatcher();
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  if (watcher) stopWatcher(watcher);
  process.exit(0);
});

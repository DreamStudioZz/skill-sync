import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const CONFIG_DIR = path.join(os.homedir(), '.skilldock');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const BACKUP_DIR = path.join(CONFIG_DIR, 'backups');

/**
 * Robust directory/symlink deletion that handles sandbox interceptions.
 * Tries multiple strategies in order:
 *   1. fs.rmSync (sandbox may intercept → trash operation)
 *   2. fs.unlinkSync (for symlinks/junctions)
 *   3. Platform-native command (rmdir / Remove-Item / rm)
 * Returns true on success, false if all strategies failed.
 */
export function safeRmSync(targetPath) {
  // Check if path exists (existsSync returns false for broken symlinks,
  // so also check lstatSync which succeeds on the symlink itself)
  let exists = fs.existsSync(targetPath);
  if (!exists) {
    try { fs.lstatSync(targetPath); exists = true; } catch { /* truly doesn't exist */ }
  }
  if (!exists) return true; // Already gone

  // Strategy 1: fs.rmSync with force
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    if (!fs.existsSync(targetPath)) return true;
  } catch { /* continue to next strategy */ }

  // Strategy 2: Check if it's a symlink/junction and use unlinkSync
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(targetPath);
      if (!fs.existsSync(targetPath)) return true;
    }
  } catch { /* continue */ }

  // Strategy 3: Remove files individually, then directories
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isDirectory()) {
      // Remove contents first
      const entries = fs.readdirSync(targetPath);
      for (const entry of entries) {
        const entryPath = path.join(targetPath, entry);
        const entryStat = fs.lstatSync(entryPath);
        if (entryStat.isDirectory()) {
          safeRmSync(entryPath); // recurse
        } else {
          try { fs.unlinkSync(entryPath); } catch { /* skip */ }
        }
      }
      // Try rmdir
      try { fs.rmdirSync(targetPath); } catch { /* skip */ }
      if (!fs.existsSync(targetPath)) return true;
    } else {
      try { fs.unlinkSync(targetPath); } catch { /* skip */ }
      if (!fs.existsSync(targetPath)) return true;
    }
  } catch { /* continue */ }

  // Strategy 4: Platform-native command
  try {
    if (process.platform === 'win32') {
      execSync(`Remove-Item -Path "${targetPath}" -Recurse -Force -ErrorAction SilentlyContinue`,
        { shell: 'powershell', stdio: 'ignore', timeout: 10000 });
    } else {
      execSync(`rm -rf "${targetPath}"`, { stdio: 'ignore', timeout: 10000 });
    }
    if (!fs.existsSync(targetPath)) return true;
  } catch { /* continue */ }

  // All strategies failed
  return false;
}

/** Expand ~ to home directory */
export function expandPath(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Get default empty config */
export function defaultConfig() {
  return {
    base: { path: '', skills: [] },
    agents: [],
    history: []
  };
}

/** Load config from disk */
export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const cfg = JSON.parse(raw);
    // Ensure structure
    if (!cfg.base) cfg.base = { path: '', skills: [] };
    if (!cfg.agents) cfg.agents = [];
    if (!cfg.history) cfg.history = [];
    return cfg;
  } catch {
    return defaultConfig();
  }
}

/** Save config to disk */
export function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/** Get the agent-side path for a skill in an agent directory */
export function getAgentSkillPath(agent, skillId) {
  return path.join(expandPath(agent.path), skillId);
}

/** Ensure agent directory exists, create if needed */
export function ensureAgentDir(agent) {
  const agentPath = expandPath(agent.path);
  if (!fs.existsSync(agentPath)) {
    fs.mkdirSync(agentPath, { recursive: true });
  }
  return agentPath;
}

/** Recursively copy a directory */
export function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Backup agent-side skill files (for rollback) */
export function backupAgentSkill(agentId, skillId, agentSkillDir) {
  if (!fs.existsSync(agentSkillDir)) return null;
  const backupPath = path.join(BACKUP_DIR, agentId, skillId, Date.now().toString());
  copyDirSync(agentSkillDir, backupPath);
  return backupPath;
}

/** Restore from backup */
export function restoreFromBackup(backupPath, agentSkillDir) {
  if (fs.existsSync(agentSkillDir)) {
    safeRmSync(agentSkillDir);
  }
  copyDirSync(backupPath, agentSkillDir);
}

/** Generate a unique agent ID */
export function generateId(prefix = 'agent') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Get config file path (for debugging) */
export function getConfigPath() {
  return CONFIG_FILE;
}

/** Get backup directory */
export function getBackupDir() {
  return BACKUP_DIR;
}

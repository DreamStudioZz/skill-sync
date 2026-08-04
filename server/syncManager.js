import fs from 'fs';
import path from 'path';
import {
  expandPath, getAgentSkillPath, ensureAgentDir,
  copyDirSync, backupAgentSkill, restoreFromBackup, safeRmSync
} from './config.js';
import { computeSkillHash } from './scanner.js';

/**
 * Compute the status matrix for all (skill, agent) pairs.
 * Returns: { [agentId]: { [skillId]: 'synced' | 'stale' | 'drifted' | 'not_synced' } }
 */
export function computeStatusMatrix(config) {
  const matrix = {};

  for (const agent of config.agents) {
    matrix[agent.id] = {};

    for (const skill of config.base.skills) {
      const link = agent.links.find(l => l.skillId === skill.id);

      if (!link) {
        matrix[agent.id][skill.id] = 'not_synced';
        continue;
      }

      const agentSkillDir = getAgentSkillPath(agent, skill.id);

      // Check if the skill exists in the agent directory
      if (!fs.existsSync(agentSkillDir)) {
        matrix[agent.id][skill.id] = 'not_synced';
        continue;
      }

      if (link.mode === 'link') {
        // Link mode: verify the link works by checking content accessibility.
        // A real symlink/junction will show the target's files; a broken/fake one won't.
        try {
          const baseSkillDir = path.join(config.base.path, skill.id);
          const baseSkillMd = path.join(baseSkillDir, 'SKILL.md');
          const agentSkillMd = path.join(agentSkillDir, 'SKILL.md');

          // Check if agent-side SKILL.md exists and matches base
          if (fs.existsSync(agentSkillMd) && fs.existsSync(baseSkillMd)) {
            const baseContent = fs.readFileSync(baseSkillMd, 'utf-8');
            const agentContent = fs.readFileSync(agentSkillMd, 'utf-8');
            if (baseContent === agentContent) {
              // Content matches — link is working (or was created via fallback copy)
              // For link mode, also verify it's actually a link via readlinkSync
              try {
                fs.readlinkSync(agentSkillDir);
                matrix[agent.id][skill.id] = 'synced';
              } catch {
                // Not a real symlink but content matches — treat as synced
                // (this happens when link mode fell back to copy)
                matrix[agent.id][skill.id] = 'synced';
              }
            } else {
              matrix[agent.id][skill.id] = 'drifted';
            }
          } else if (fs.existsSync(agentSkillDir)) {
            // Directory exists but no SKILL.md — broken link
            matrix[agent.id][skill.id] = 'drifted';
          } else {
            matrix[agent.id][skill.id] = 'not_synced';
          }
        } catch {
          if (fs.existsSync(agentSkillDir)) {
            matrix[agent.id][skill.id] = 'drifted';
          } else {
            matrix[agent.id][skill.id] = 'not_synced';
          }
        }
      } else {
        // Copy mode: compare hashes
        const currentAgentHash = computeSkillHash(agentSkillDir);
        const baseHash = skill.contentHash;
        const lastHash = link.lastSyncedHash;

        if (!currentAgentHash) {
          matrix[agent.id][skill.id] = 'not_synced';
        } else if (currentAgentHash !== lastHash && baseHash !== lastHash) {
          // Both sides changed since last sync
          matrix[agent.id][skill.id] = 'drifted';
        } else if (currentAgentHash !== lastHash) {
          // Agent-side was modified manually
          matrix[agent.id][skill.id] = 'drifted';
        } else if (baseHash !== lastHash) {
          // Base changed, agent hasn't been updated
          matrix[agent.id][skill.id] = 'stale';
        } else {
          matrix[agent.id][skill.id] = 'synced';
        }
      }
    }
  }

  return matrix;
}

/**
 * Sync a skill to an agent.
 * Creates a symlink (link mode) or copies files (copy mode).
 */
export function syncSkill(config, skillId, agentId, modeOverride) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Agent 不存在');

  const skill = config.base.skills.find(s => s.id === skillId);
  if (!skill) throw new Error('Skill 不存在');

  const baseSkillDir = path.join(config.base.path, skillId);
  if (!fs.existsSync(baseSkillDir)) throw new Error('Base skill 目录不存在');

  const agentSkillDir = getAgentSkillPath(agent, skillId);
  const syncMode = modeOverride || agent.defaultMode;

  // Ensure agent directory exists
  ensureAgentDir(agent);

  // Backup existing agent-side files (for rollback)
  let beforeHash = null;
  let backupPath = null;

  if (fs.existsSync(agentSkillDir)) {
    try {
      beforeHash = computeSkillHash(agentSkillDir);
    } catch { /* ignore */ }

    if (syncMode === 'copy') {
      backupPath = backupAgentSkill(agent.id, skillId, agentSkillDir);
    }

    // Remove existing (symlink or directory)
    safeRmSync(agentSkillDir);
  }

  // Perform sync
  let actualMode = syncMode;
  if (syncMode === 'link') {
    try {
      // On Windows, use 'junction' type for directories (no admin privileges needed)
      const linkType = process.platform === 'win32' ? 'junction' : undefined;
      fs.symlinkSync(baseSkillDir, agentSkillDir, linkType);

      // Verify the symlink works by computing the agent-side hash.
      // A real symlink/junction will resolve to the base directory and produce the same hash.
      // A broken/fake link will produce a different hash (or null for empty dirs).
      const agentHash = computeSkillHash(agentSkillDir);
      if (agentHash !== skill.contentHash) {
        // Symlink didn't work — clean up and fall back to copy mode
        safeRmSync(agentSkillDir);
        copyDirSync(baseSkillDir, agentSkillDir);
        actualMode = 'copy';
      }
    } catch (e) {
      // Symlink creation failed — fall back to copy mode
      try {
        copyDirSync(baseSkillDir, agentSkillDir);
        actualMode = 'copy';
      } catch (copyErr) {
        throw new Error(`链接模式失败（${e.message}），复制模式也失败（${copyErr.message}）`);
      }
    }
  } else {
    copyDirSync(baseSkillDir, agentSkillDir);
  }

  const afterHash = skill.contentHash;

  // Update or create link record
  let link = agent.links.find(l => l.skillId === skillId);
  if (!link) {
    link = { skillId, mode: actualMode, lastSyncedHash: afterHash, lastSyncedAt: new Date().toISOString() };
    agent.links.push(link);
  } else {
    link.mode = actualMode;
    link.lastSyncedHash = afterHash;
    link.lastSyncedAt = new Date().toISOString();
  }

  // Record history
  const historyEntry = {
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    action: 'sync',
    skillId,
    skillName: skill.name,
    agentId,
    agentName: agent.name,
    mode: actualMode,
    beforeHash,
    afterHash,
    backupPath,
    note: actualMode !== syncMode ? `链接模式不可用，已降级为复制模式` : undefined
  };
  config.history.push(historyEntry);

  return { config, historyEntry };
}

/**
 * Remove a skill sync from an agent (unsync).
 * Deletes the symlink or copied files. Base is never affected.
 */
export function unsyncSkill(config, skillId, agentId) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Agent 不存在');

  const agentSkillDir = getAgentSkillPath(agent, skillId);
  let beforeHash = null;
  let backupPath = null;

  if (fs.existsSync(agentSkillDir)) {
    try {
      beforeHash = computeSkillHash(agentSkillDir);
    } catch { /* ignore */ }

    const link = agent.links.find(l => l.skillId === skillId);
    if (link && link.mode === 'copy') {
      backupPath = backupAgentSkill(agent.id, skillId, agentSkillDir);
    }

    // Remove the synced skill (symlink or directory)
    const deleted = safeRmSync(agentSkillDir);
    if (!deleted) {
      // Files couldn't be deleted (sandbox restriction) — still proceed
      // to remove the link from config so the UI reflects the unsync
      console.warn(`[unsync] Warning: could not delete ${agentSkillDir}, removing link from config only`);
    }
  }

  // Remove link from config
  agent.links = agent.links.filter(l => l.skillId !== skillId);

  const skill = config.base.skills.find(s => s.id === skillId);
  const historyEntry = {
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    action: 'unsync',
    skillId,
    skillName: skill?.name || skillId,
    agentId,
    agentName: agent.name,
    mode: agent.defaultMode,
    beforeHash,
    afterHash: null,
    backupPath
  };
  config.history.push(historyEntry);

  return { config, historyEntry };
}

/**
 * Push updated Base content to a synced agent (copy mode only).
 * Overwrites agent-side files with Base version.
 */
export function pushChanges(config, skillId, agentId) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Agent 不存在');

  const skill = config.base.skills.find(s => s.id === skillId);
  if (!skill) throw new Error('Skill 不存在');

  const link = agent.links.find(l => l.skillId === skillId);
  if (!link || link.mode !== 'copy') {
    // For link mode, no push needed — just re-sync
    return syncSkill(config, skillId, agentId, 'link');
  }

  const baseSkillDir = path.join(config.base.path, skillId);
  const agentSkillDir = getAgentSkillPath(agent, skillId);

  let beforeHash = null;
  let backupPath = null;

  if (fs.existsSync(agentSkillDir)) {
    try { beforeHash = computeSkillHash(agentSkillDir); } catch { /* ignore */ }
    backupPath = backupAgentSkill(agent.id, skillId, agentSkillDir);
    safeRmSync(agentSkillDir);
  }

  copyDirSync(baseSkillDir, agentSkillDir);

  link.lastSyncedHash = skill.contentHash;
  link.lastSyncedAt = new Date().toISOString();

  const historyEntry = {
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    action: 'push',
    skillId,
    skillName: skill.name,
    agentId,
    agentName: agent.name,
    mode: 'copy',
    beforeHash,
    afterHash: skill.contentHash,
    backupPath
  };
  config.history.push(historyEntry);

  return { config, historyEntry };
}

/**
 * Handle drift resolution.
 * action: 'keep' | 'overwrite' | 'save_as_new'
 */
export function resolveDrift(config, skillId, agentId, action, newSkillName) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Agent 不存在');

  if (action === 'keep') {
    // Keep agent-side changes, update lastSyncedHash to current agent hash
    const agentSkillDir = getAgentSkillPath(agent, skillId);
    const currentHash = computeSkillHash(agentSkillDir);
    const link = agent.links.find(l => l.skillId === skillId);
    if (link) {
      link.lastSyncedHash = currentHash;
      link.lastSyncedAt = new Date().toISOString();
    }
    const skill = config.base.skills.find(s => s.id === skillId);
    config.history.push({
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      action: 'drift_keep',
      skillId,
      skillName: skill?.name || skillId,
      agentId,
      agentName: agent.name,
      mode: 'copy',
      beforeHash: link?.lastSyncedHash,
      afterHash: currentHash
    });
    return { config };
  }

  if (action === 'overwrite') {
    return pushChanges(config, skillId, agentId);
  }

  if (action === 'save_as_new') {
    // Copy agent-side files to Base as a new skill
    const agentSkillDir = getAgentSkillPath(agent, skillId);
    const newId = newSkillName || `${skillId}-variant-${Date.now().toString(36)}`;
    const newSkillDir = path.join(config.base.path, newId);

    if (fs.existsSync(newSkillDir)) {
      throw new Error(`目录 ${newId} 已存在于 Base 中`);
    }

    copyDirSync(agentSkillDir, newSkillDir);

    // Update link to synced with current agent hash
    const currentHash = computeSkillHash(agentSkillDir);
    const link = agent.links.find(l => l.skillId === skillId);
    if (link) {
      link.lastSyncedHash = currentHash;
      link.lastSyncedAt = new Date().toISOString();
    }

    config.history.push({
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      action: 'drift_save_new',
      skillId,
      skillName: newId,
      agentId,
      agentName: agent.name,
      mode: 'copy',
      note: `从 ${agent.name} 的漂移版本另存为新 skill`
    });

    return { config, newSkillId: newId };
  }

  throw new Error(`未知的漂移处理动作: ${action}`);
}

/**
 * Rollback a history entry.
 * For sync → unsync, for unsync → re-sync, for push → restore backup.
 */
export function rollback(config, historyId) {
  const idx = config.history.findIndex(h => h.id === historyId);
  if (idx === -1) throw new Error('历史记录不存在');

  const entry = config.history[idx];
  const agent = config.agents.find(a => a.id === entry.agentId);

  if (entry.action === 'sync' || entry.action === 'push') {
    if (entry.backupPath && fs.existsSync(entry.backupPath)) {
      // Restore from backup
      const agentSkillDir = getAgentSkillPath(agent, entry.skillId);
      restoreFromBackup(entry.backupPath, agentSkillDir);
      const restoredHash = computeSkillHash(agentSkillDir);
      const link = agent.links.find(l => l.skillId === entry.skillId);
      if (link) {
        link.lastSyncedHash = restoredHash;
        link.lastSyncedAt = new Date().toISOString();
      }
    } else {
      // No backup — unsync instead
      if (agent) {
        const agentSkillDir = getAgentSkillPath(agent, entry.skillId);
        if (fs.existsSync(agentSkillDir)) {
          safeRmSync(agentSkillDir);
        }
        agent.links = agent.links.filter(l => l.skillId !== entry.skillId);
      }
    }
  } else if (entry.action === 'unsync') {
    // Re-sync
    try {
      syncSkill(config, entry.skillId, entry.agentId, entry.mode);
    } catch (e) {
      throw new Error(`回滚失败: ${e.message}`);
    }
  }

  // Record rollback in history
  config.history.push({
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    action: 'rollback',
    skillId: entry.skillId,
    skillName: entry.skillName,
    agentId: entry.agentId,
    agentName: entry.agentName,
    mode: entry.mode,
    note: `回滚操作: ${entry.action}`
  });

  return { config };
}

/**
 * Get changes (stale skills) — Base skills that have been updated
 * but not yet pushed to synced agents.
 */
export function getChanges(config, statusMatrix) {
  const changes = [];

  for (const skill of config.base.skills) {
    const affectedAgents = [];
    for (const agent of config.agents) {
      const status = statusMatrix[agent.id]?.[skill.id];
      if (status === 'stale' || status === 'drifted') {
        affectedAgents.push({ agentId: agent.id, agentName: agent.name, status });
      }
    }
    if (affectedAgents.length > 0) {
      changes.push({ skill, agents: affectedAgents });
    }
  }

  return changes;
}

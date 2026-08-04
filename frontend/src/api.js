// SkillDock frontend API — uses Wails Go bindings instead of HTTP fetch.
// Each method maps to a Go method on the App struct (window.go.main.App.*).
// Events replace the WebSocket connection.

import { EventsOn, EventsOff } from "../wailsjs/runtime/runtime.js";

const go = () => window.go.main.App;

export const api = {
  getConfig: () => go().GetConfig(),
  setBase: (p) => go().SetBase(p),
  scanBase: () => go().ScanBase(),
  browse: (p) => go().Browse(p || ""),

  getAgents: () => go().GetAgents(),
  addAgent: (d) => go().AddAgent(d.name, d.path, d.color, d.defaultMode),
  updateAgent: (id, d) => go().UpdateAgent(id, d.name || "", d.path || "", d.color || "", d.defaultMode || ""),
  deleteAgent: (id, cleanup = false) => go().DeleteAgent(id, cleanup),

  sync: (skillId, agentId, mode) => go().SyncSkill(skillId, agentId, mode || ""),
  syncBatch: (skillIds, agentIds, mode) => go().SyncBatch(skillIds, agentIds, mode || ""),
  unsync: (skillId, agentId) => go().UnsyncSkill(skillId, agentId),
  push: (skillId, agentId) => go().PushChanges(skillId, agentId),

  resolveDrift: (skillId, agentId, action, newSkillName) =>
    go().ResolveDrift(skillId, agentId, action, newSkillName || ""),

  getHistory: (limit = 50) => go().GetHistory(limit),
  rollback: (historyId) => go().Rollback(historyId),

  getChanges: () => go().GetChanges(),
  openPath: (targetPath) => go().OpenPath(targetPath),
};

// Event-based real-time updates (replaces WebSocket).
// In the Wails app the backend is always available, so onOpen fires immediately
// and onClose is never called.
export function connectWebSocket(onMessage, onOpen, onClose) {
  EventsOn("config_updated", (data) => {
    onMessage({ type: "config_updated", data });
  });
  EventsOn("change_detected", (data) => {
    onMessage({ type: "change_detected", data });
  });
  // Backend is always connected in Wails
  onOpen?.();

  return {
    close() {
      EventsOff("config_updated");
      EventsOff("change_detected");
    },
  };
}

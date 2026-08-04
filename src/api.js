// API client for SkillDock backend

const BASE = '';

async function request(url, options = {}) {
  const res = await fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `请求失败: ${res.status}`);
  return data;
}

export const api = {
  getConfig: () => request('/api/config'),
  setBase: (path) => request('/api/base', { method: 'PUT', body: JSON.stringify({ path }) }),
  scanBase: () => request('/api/base/scan', { method: 'POST' }),
  browse: (path) => request('/api/browse?path=' + encodeURIComponent(path || '')),

  getAgents: () => request('/api/agents'),
  addAgent: (data) => request('/api/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id, data) => request('/api/agents/' + id, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id, cleanup = false) => request('/api/agents/' + id, { method: 'DELETE', body: JSON.stringify({ cleanup }) }),

  sync: (skillId, agentId, mode) => request('/api/sync', { method: 'POST', body: JSON.stringify({ skillId, agentId, mode }) }),
  syncBatch: (skillIds, agentIds, mode) => request('/api/sync/batch', { method: 'POST', body: JSON.stringify({ skillIds, agentIds, mode }) }),
  unsync: (skillId, agentId) => request('/api/sync', { method: 'DELETE', body: JSON.stringify({ skillId, agentId }) }),
  push: (skillId, agentId) => request('/api/push', { method: 'POST', body: JSON.stringify({ skillId, agentId }) }),

  resolveDrift: (skillId, agentId, action, newSkillName) =>
    request('/api/drift/resolve', { method: 'POST', body: JSON.stringify({ skillId, agentId, action, newSkillName }) }),

  getHistory: (limit = 50) => request('/api/history?limit=' + limit),
  rollback: (historyId) => request('/api/history/rollback', { method: 'POST', body: JSON.stringify({ historyId }) }),

  getChanges: () => request('/api/changes'),

  openPath: (targetPath) => request('/api/open', { method: 'POST', body: JSON.stringify({ targetPath }) }),
};

// WebSocket connection with auto-reconnect
export function connectWebSocket(onMessage, onOpen, onClose) {
  let ws = null;
  let reconnectTimer = null;
  let shouldReconnect = true;

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      console.log('[SkillDock] WebSocket connected');
      onOpen?.();
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        onMessage(msg);
      } catch (err) {
        console.error('[SkillDock] WS parse error:', err);
      }
    };

    ws.onclose = () => {
      onClose?.();
      if (shouldReconnect) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    close() {
      shouldReconnect = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    }
  };
}

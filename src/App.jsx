import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Package, PackageCheck, PackagePlus, Truck, RefreshCw, AlertTriangle,
  CheckCircle2, XCircle, Trash2, Plus, Link2, Copy, Palette, ChevronRight,
  Bell, X, Boxes, ArrowRight, Anchor, Ship, Folder, Home as HomeIcon,
  History as HistoryIcon, Edit3, Loader2, RotateCcw, ChevronLeft,
  FileWarning, Eye, Settings, Ship as ShipIcon, Warehouse, Anchor as AnchorIcon,
  FolderOpen
} from "lucide-react";
import { THEMES, AGENT_PRESETS } from "./themes.js";
import { api, connectWebSocket } from "./api.js";

const STATUS_META = {
  synced: { label: "已同步", icon: CheckCircle2 },
  stale: { label: "待更新", icon: Bell },
  drifted: { label: "漂移", icon: AlertTriangle },
  not_synced: { label: "未同步", icon: XCircle },
};

export default function App() {
  // --- Core state ---
  const [config, setConfig] = useState(null);
  const [statusMatrix, setStatusMatrix] = useState({});
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);

  // --- UI state ---
  const [themeKey, setThemeKey] = useState(() => localStorage.getItem("skilldock-theme") || "cargo");
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [toast, setToast] = useState(null);
  const [selectedSkills, setSelectedSkills] = useState({});
  const [selectedAgents, setSelectedAgents] = useState({});
  const [changeNotification, setChangeNotification] = useState(null);

  // --- Modal state ---
  const [modal, setModal] = useState(null); // 'setBase' | 'addAgent' | 'editAgent' | 'history' | 'matrix'
  const [diffAgentId, setDiffAgentId] = useState(null);
  const [driftInfo, setDriftInfo] = useState(null);
  const [editingAgent, setEditingAgent] = useState(null);

  const t = THEMES[themeKey];
  const toastTimer = useRef(null);
  const wsRef = useRef(null);

  // --- Effects ---
  useEffect(() => {
    loadConfig();

    wsRef.current = connectWebSocket(
      (msg) => {
        if (msg.type === "config_updated") {
          setConfig(msg.data.config);
          setStatusMatrix(msg.data.statusMatrix || {});
        } else if (msg.type === "change_detected") {
          setChangeNotification(msg.data);
          showToast(msg.data.message, "warn");
        }
      },
      () => setConnectionError(false),
      () => setConnectionError(true)
    );

    return () => wsRef.current?.close();
  }, []);

  useEffect(() => {
    localStorage.setItem("skilldock-theme", themeKey);
  }, [themeKey]);

  // --- Helpers ---
  const loadConfig = async () => {
    try {
      const data = await api.getConfig();
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      setConnectionError(false);
    } catch (e) {
      setConnectionError(true);
    } finally {
      setLoading(false);
    }
  };

  const showToast = useCallback((msg, type = "info") => {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  const handleOpenPath = useCallback(async (targetPath) => {
    try {
      await api.openPath(targetPath);
    } catch (e) {
      showToast("无法打开路径: " + e.message, "error");
    }
  }, [showToast]);

  const reloadConfig = useCallback(async () => {
    try {
      const data = await api.getConfig();
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
    } catch (e) {
      showToast("刷新失败: " + e.message, "error");
    }
  }, [showToast]);

  // --- Operations ---
  const handleSetBase = async (path) => {
    try {
      const data = await api.setBase(path);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      setModal(null);
      showToast("Base 仓库已设置");
    } catch (e) {
      showToast("设置失败: " + e.message, "error");
    }
  };

  const handleScan = async () => {
    showToast("正在扫描...", "info");
    try {
      const data = await api.scanBase();
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      showToast("扫描完成");
    } catch (e) {
      showToast("扫描失败: " + e.message, "error");
    }
  };

  const handleSync = async (agentId, skillId) => {
    try {
      const data = await api.sync(skillId, agentId);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      const skill = config.base.skills.find(s => s.id === skillId);
      const agent = config.agents.find(a => a.id === agentId);
      showToast(`已把「${skill?.name || skillId}」发往 ${agent?.name || agentId}`);
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  const handleUnsync = async (agentId, skillId) => {
    try {
      const data = await api.unsync(skillId, agentId);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      const skill = config.base.skills.find(s => s.id === skillId);
      const agent = config.agents.find(a => a.id === agentId);
      showToast(`已从 ${agent?.name} 移除「${skill?.name}」（Base 不受影响）`);
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  const handleSyncAll = async (agentId) => {
    const agent = config.agents.find(a => a.id === agentId);
    for (const skill of config.base.skills) {
      try {
        const data = await api.sync(skill.id, agentId);
        setConfig(data.config);
        setStatusMatrix(data.statusMatrix || {});
      } catch (e) {
        showToast(`${skill.name}: ${e.message}`, "error");
      }
    }
    showToast(`已全量同步到 ${agent?.name}`);
  };

  const handleBatchSync = async () => {
    const skillIds = Object.keys(selectedSkills).filter(k => selectedSkills[k]);
    const agentIds = Object.keys(selectedAgents).filter(k => selectedAgents[k]);
    if (skillIds.length === 0 || agentIds.length === 0) {
      showToast("请先勾选 skill 和 agent", "error");
      return;
    }
    try {
      const data = await api.syncBatch(skillIds, agentIds);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      setSelectedSkills({});
      setSelectedAgents({});
      showToast(`已同步 ${skillIds.length} 个 skill 到 ${agentIds.length} 个 agent`);
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  const handlePush = async (agentId, skillId) => {
    try {
      const data = await api.push(skillId, agentId);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      showToast("已推送变更");
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  const handleAddAgent = async (agentData) => {
    try {
      const data = await api.addAgent(agentData);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      setModal(null);
      showToast(`Agent「${agentData.name}」已添加`);
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  const handleUpdateAgent = async (id, agentData) => {
    try {
      const data = await api.updateAgent(id, agentData);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      setModal(null);
      setEditingAgent(null);
      showToast("Agent 已更新");
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  const handleDeleteAgent = async (id, cleanup) => {
    try {
      const data = await api.deleteAgent(id, cleanup);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      setModal(null);
      showToast(cleanup ? "Agent 已删除，同步文件已清理" : "Agent 已删除（文件保留）");
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  const handleRollback = async (historyId) => {
    try {
      const data = await api.rollback(historyId);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      showToast("已回滚");
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  const handleResolveDrift = async (skillId, agentId, action, newSkillName) => {
    try {
      const data = await api.resolveDrift(skillId, agentId, action, newSkillName);
      setConfig(data.config);
      setStatusMatrix(data.statusMatrix || {});
      setDriftInfo(null);
      const labels = { keep: "已保留 Agent 端修改", overwrite: "已覆盖为 Base 版本", save_as_new: "已另存为新 skill" };
      showToast(labels[action] || "操作完成");
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  // --- Computed values ---
  const staleCount = useMemo(() => {
    let n = 0;
    if (statusMatrix) {
      for (const aid in statusMatrix) {
        for (const sid in statusMatrix[aid]) {
          if (statusMatrix[aid][sid] === "stale" || statusMatrix[aid][sid] === "drifted") n++;
        }
      }
    }
    return n;
  }, [statusMatrix]);

  const summarize = useCallback((agent) => {
    const stats = { synced: 0, stale: 0, drifted: 0, not_synced: 0 };
    if (statusMatrix[agent.id]) {
      for (const sid in statusMatrix[agent.id]) {
        const s = statusMatrix[agent.id][sid];
        if (stats[s] !== undefined) stats[s]++;
      }
    }
    return stats;
  }, [statusMatrix]);

  // --- Badge renderer ---
  const badge = (status, size = "sm") => {
    const meta = STATUS_META[status];
    if (!meta) return null;
    const Icon = meta.icon;
    const colorMap = {
      synced: [t.primary, t.primarySoft],
      stale: [t.warn, t.warnSoft],
      drifted: [t.danger, t.dangerSoft],
      not_synced: [t.textMuted, t.surfaceAlt],
    };
    const [fg, bg] = colorMap[status] || [t.textMuted, t.surfaceAlt];
    return (
      <span
        style={{ color: fg, background: bg, borderColor: fg + "33" }}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${size === "xs" ? "text-[10px]" : "text-[11px]"} font-medium whitespace-nowrap`}
      >
        <Icon size={size === "xs" ? 10 : 12} strokeWidth={2.5} />
        {meta.label}
      </span>
    );
  };

  // --- Loading state ---
  if (loading) {
    return (
      <div style={{ background: t.bg, color: t.text }} className="w-full h-screen flex items-center justify-center">
        <Loader2 className="animate-spin" size={32} style={{ color: t.primary }} />
      </div>
    );
  }

  // --- Connection error ---
  if (connectionError && !config) {
    return (
      <div style={{ background: t.bg, color: t.text }} className="w-full h-screen flex flex-col items-center justify-center gap-3">
        <AlertTriangle size={40} style={{ color: t.danger }} />
        <p className="text-lg font-bold">无法连接到 SkillDock 服务</p>
        <p style={{ color: t.textMuted }} className="text-sm">请确认后端服务已启动（端口 3001）</p>
        <button
          onClick={loadConfig}
          style={{ background: t.primary }}
          className="text-white rounded-lg px-4 py-2 text-sm font-medium mt-2"
        >
          重新连接
        </button>
      </div>
    );
  }

  // --- No base set: welcome screen ---
  if (!config || !config.base.path) {
    return (
      <div style={{ background: t.bg, color: t.text, fontFamily: "'Space Grotesk','Inter',sans-serif" }} className="w-full min-h-screen flex items-center justify-center p-5">
        <WelcomeScreen t={t} onSetBase={() => setModal("setBase")} />
        {modal === "setBase" && (
          <SetBaseModal t={t} onClose={() => setModal(null)} onConfirm={handleSetBase} />
        )}
        <Toast toast={toast} t={t} />
      </div>
    );
  }

  // --- Main dashboard ---
  const hasSelection = Object.values(selectedSkills).some(v => v) && Object.values(selectedAgents).some(v => v);

  return (
    <div
      style={{ background: t.bg, color: t.text, fontFamily: "'Space Grotesk','Inter',sans-serif" }}
      className="w-full min-h-screen p-5 md:p-8 transition-colors duration-300"
    >
      {/* === Header === */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div style={{ background: t.primary }} className="w-11 h-11 rounded-2xl flex items-center justify-center rotate-[-6deg] shadow-sm">
            <Boxes color="#fff" size={22} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight leading-none">SkillDock 技能货站</h1>
            <p style={{ color: t.textMuted }} className="text-xs mt-1">Base 是仓库，Agent 是港口，Skill 是货</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {changeNotification && (
            <button
              onClick={() => { setChangeNotification(null); setModal("matrix"); }}
              style={{ background: t.warnSoft, color: t.warn, borderColor: t.warn + "55" }}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold animate-slideUp"
            >
              <Bell size={13} />
              {changeNotification.message}
            </button>
          )}
          {staleCount > 0 && !changeNotification && (
            <button
              onClick={() => setModal("matrix")}
              style={{ background: t.warnSoft, color: t.warn, borderColor: t.warn + "55" }}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold"
            >
              <Bell size={13} />
              检测到 {staleCount} 处更新
            </button>
          )}
          <button
            onClick={() => setModal("history")}
            style={{ background: t.surface, borderColor: t.border, color: t.text }}
            className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold"
          >
            <HistoryIcon size={14} />
            历史
          </button>
          <div className="relative">
            <button
              onClick={() => setShowThemePicker(s => !s)}
              style={{ background: t.surface, borderColor: t.border, color: t.text }}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold"
            >
              <Palette size={14} />
              {t.label}
            </button>
            {showThemePicker && (
              <div style={{ background: t.surface, borderColor: t.border }} className="absolute right-0 mt-2 w-48 rounded-xl border shadow-lg p-1.5 z-20 animate-slideUp">
                {Object.entries(THEMES).map(([key, th]) => (
                  <button
                    key={key}
                    onClick={() => { setThemeKey(key); setShowThemePicker(false); }}
                    className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:opacity-80"
                    style={{ background: key === themeKey ? t.surfaceAlt : "transparent", color: t.text }}
                  >
                    <span style={{ background: th.primary }} className="w-3.5 h-3.5 rounded-full inline-block border" />
                    {th.label}
                    {key === themeKey && <CheckCircle2 size={14} className="ml-auto" style={{ color: t.primary }} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* === Main grid === */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
        {/* --- Base Panel --- */}
        <div>
          {/* Base path + scan */}
          <div style={{ background: t.surface, borderColor: t.border }} className="rounded-2xl border p-4 mb-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Warehouse size={16} style={{ color: t.primary }} />
                <h2 className="font-semibold text-sm">Base 仓库</h2>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleScan} style={{ color: t.textMuted }} className="text-xs flex items-center gap-1 hover:opacity-70">
                  <RefreshCw size={12} /> 重新扫描
                </button>
                <button onClick={() => setModal("setBase")} style={{ color: t.textMuted }} className="text-xs flex items-center gap-1 hover:opacity-70">
                  <Edit3 size={12} /> 更换
                </button>
              </div>
            </div>
            <button
              onClick={() => handleOpenPath(config.base.path)}
              className="flex items-center gap-1 text-[11px] font-mono truncate mb-2 hover:opacity-70 transition-opacity group"
              style={{ color: t.textMuted }}
              title="在文件管理器中打开"
            >
              <FolderOpen size={11} className="flex-shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">{config.base.path}</span>
            </button>
            <p style={{ color: t.textMuted }} className="text-[11px]">{config.base.skills.length} 个 skill</p>
          </div>

          {/* Skill cards */}
          <div className="flex flex-col gap-2">
            {config.base.skills.length === 0 ? (
              <div style={{ borderColor: t.border, background: t.surface }} className="rounded-xl border p-6 text-center">
                <Package size={28} style={{ color: t.textMuted }} className="mx-auto mb-2" />
                <p style={{ color: t.textMuted }} className="text-sm">Base 中暂无 skill</p>
                <p style={{ color: t.textMuted }} className="text-xs mt-1">在 Base 目录下创建含 SKILL.md 的子目录</p>
              </div>
            ) : (
              config.base.skills.map((s) => (
                <div
                  key={s.id}
                  style={{
                    borderColor: selectedSkills[s.id] ? t.primary : t.border,
                    background: selectedSkills[s.id] ? t.primarySoft : t.surface,
                    borderWidth: selectedSkills[s.id] ? 2 : 1
                  }}
                  className="rounded-xl border p-3 transition-all cursor-pointer"
                  onClick={() => setSelectedSkills(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        style={{
                          borderColor: selectedSkills[s.id] ? t.primary : t.border,
                          background: selectedSkills[s.id] ? t.primary : "transparent"
                        }}
                        className="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0"
                      >
                        {selectedSkills[s.id] && <CheckCircle2 size={11} color="#fff" />}
                      </div>
                      <span className="text-sm font-semibold truncate">{s.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleOpenPath(config.base.path + '/' + s.id); }}
                        className="hover:scale-110 transition-transform p-0.5"
                        title="在文件管理器中打开"
                      >
                        <FolderOpen size={12} style={{ color: t.textMuted }} />
                      </button>
                      <span style={{ color: t.textMuted }} className="text-[10px] font-mono">#{s.contentHash?.slice(-6) || '------'}</span>
                    </div>
                  </div>
                  {s.description && (
                    <p style={{ color: t.textMuted }} className="text-[11px] mt-1 leading-snug ml-6">{s.description}</p>
                  )}
                  <p style={{ color: t.textMuted }} className="text-[10px] mt-1.5 ml-6">最近更新：{formatRelative(s.updatedAt)}</p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* --- Agents grid --- */}
        <div>
          {/* Conveyor belt visual */}
          <div className="flex items-center gap-2 mb-4">
            <Truck size={16} style={{ color: t.primary }} />
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: t.surfaceAlt }}>
              <div
                className="h-full conveyor-dots"
                style={{ color: t.primary + "44", width: "100%" }}
              />
            </div>
            <Anchor size={16} style={{ color: t.primary }} />
          </div>

          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <AnchorIcon size={16} style={{ color: t.primary }} />
              <h2 className="font-semibold text-sm">港口 · Agents</h2>
            </div>
            {hasSelection && (
              <button
                onClick={handleBatchSync}
                style={{ background: t.accent, color: t.bg }}
                className="text-xs font-semibold rounded-lg px-3 py-1.5 flex items-center gap-1.5 animate-slideUp"
              >
                <Truck size={13} />
                同步选中项 ({Object.keys(selectedSkills).filter(k => selectedSkills[k]).length}→{Object.keys(selectedAgents).filter(k => selectedAgents[k]).length})
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {config.agents.map((agent) => {
              const sum = summarize(agent);
              const isAgentSelected = selectedAgents[agent.id];

              return (
                <div
                  key={agent.id}
                  style={{
                    background: t.surface,
                    borderColor: isAgentSelected ? t.primary : t.border,
                    borderWidth: isAgentSelected ? 2 : 1
                  }}
                  className="rounded-2xl border p-4 flex flex-col transition-all"
                >
                  {/* Agent header */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      <div
                        style={{ background: agent.color + "22", color: agent.color }}
                        className="w-9 h-9 rounded-xl flex items-center justify-center"
                      >
                        <Ship size={18} />
                      </div>
                      <div>
                        <p className="text-sm font-bold leading-none">{agent.name}</p>
                        <button
                          onClick={() => handleOpenPath(agent.path)}
                          className="flex items-center gap-1 text-[10px] font-mono mt-0.5 truncate max-w-[140px] hover:opacity-70 transition-opacity group"
                          style={{ color: t.textMuted }}
                          title="在文件管理器中打开"
                        >
                          <FolderOpen size={10} className="flex-shrink-0 group-hover:scale-110 transition-transform" />
                          <span className="truncate">{agent.path}</span>
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <span
                        style={{ color: t.textMuted, borderColor: t.border }}
                        className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]"
                      >
                        {agent.defaultMode === "link" ? <Link2 size={10} /> : <Copy size={10} />}
                        {agent.defaultMode === "link" ? "链接" : "复制"}
                      </span>
                      <button
                        onClick={() => { setEditingAgent(agent); setModal("editAgent"); }}
                        style={{ color: t.textMuted }}
                        className="hover:opacity-70 p-1"
                      >
                        <Settings size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Status summary */}
                  <div className="flex gap-1.5 flex-wrap mb-3">
                    {sum.synced > 0 && badge("synced")}
                    {sum.stale > 0 && badge("stale")}
                    {sum.drifted > 0 && badge("drifted")}
                    {sum.not_synced > 0 && (
                      <span style={{ color: t.textMuted }} className="text-[11px] self-center">+{sum.not_synced} 未同步</span>
                    )}
                  </div>

                  {/* Skill list */}
                  <div className="flex flex-col gap-1.5 mb-3 flex-1">
                    {config.base.skills.map((s) => {
                      const status = statusMatrix[agent.id]?.[s.id] || "not_synced";
                      return (
                        <div key={s.id} className="flex items-center justify-between text-xs py-1">
                          <span className="truncate max-w-[100px]" style={{ color: t.text }}>{s.name}</span>
                          <div className="flex items-center gap-1.5">
                            {badge(status, "xs")}
                            {status === "not_synced" ? (
                              <button onClick={() => handleSync(agent.id, s.id)} title="同步这个 skill" className="hover:scale-110 transition-transform">
                                <Truck size={14} style={{ color: t.primary }} />
                              </button>
                            ) : status === "stale" ? (
                              <button onClick={() => handlePush(agent.id, s.id)} title="推送更新" className="hover:scale-110 transition-transform">
                                <ArrowRight size={14} style={{ color: t.warn }} />
                              </button>
                            ) : status === "drifted" ? (
                              <button onClick={() => setDriftInfo({ skillId: s.id, agentId: agent.id })} title="处理漂移" className="hover:scale-110 transition-transform">
                                <FileWarning size={14} style={{ color: t.danger }} />
                              </button>
                            ) : (
                              <button onClick={() => handleUnsync(agent.id, s.id)} title="移除同步" className="hover:scale-110 transition-transform">
                                <Trash2 size={13} style={{ color: t.textMuted }} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Footer actions */}
                  <div className="flex gap-2 mt-auto pt-2" style={{ borderTop: `1px solid ${t.border}` }}>
                    <button
                      onClick={() => handleSyncAll(agent.id)}
                      style={{ background: t.primary }}
                      className="flex-1 text-white text-xs font-semibold rounded-lg py-1.5 flex items-center justify-center gap-1.5"
                    >
                      <Truck size={13} /> 全部同步
                    </button>
                    <button
                      onClick={() => setDiffAgentId(agent.id)}
                      disabled={sum.stale + sum.drifted === 0}
                      style={{
                        borderColor: t.border,
                        color: sum.stale + sum.drifted === 0 ? t.textMuted + "80" : t.text,
                        opacity: sum.stale + sum.drifted === 0 ? 0.5 : 1
                      }}
                      className="flex-1 border text-xs font-semibold rounded-lg py-1.5 flex items-center justify-center gap-1.5"
                    >
                      查看变更 <ChevronRight size={13} />
                    </button>
                    {/* Select for batch */}
                    <button
                      onClick={() => setSelectedAgents(prev => ({ ...prev, [agent.id]: !prev[agent.id] }))}
                      style={{
                        borderColor: isAgentSelected ? t.primary : t.border,
                        background: isAgentSelected ? t.primary : "transparent",
                        color: isAgentSelected ? "#fff" : t.textMuted
                      }}
                      className="border text-xs font-semibold rounded-lg px-2.5 flex items-center"
                    >
                      {isAgentSelected ? "✓" : "+"}
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Add agent card */}
            <button
              onClick={() => setModal("addAgent")}
              style={{ borderColor: t.border, color: t.textMuted }}
              className="rounded-2xl border border-dashed flex flex-col items-center justify-center gap-2 py-10 hover:opacity-70"
            >
              <Plus size={22} />
              <span className="text-xs font-medium">添加一个 Agent</span>
            </button>
          </div>
        </div>
      </div>

      {/* === Modals === */}

      {/* Diff / Changes modal */}
      {diffAgentId && (
        <DiffModal
          t={t}
          agent={config.agents.find(a => a.id === diffAgentId)}
          skills={config.base.skills}
          statusMatrix={statusMatrix}
          onClose={() => setDiffAgentId(null)}
          onSync={handleSync}
          onPush={handlePush}
          badge={badge}
        />
      )}

      {/* Set base modal */}
      {modal === "setBase" && (
        <SetBaseModal
          t={t}
          currentPath={config?.base?.path}
          onClose={() => { setModal(null); setEditingAgent(null); }}
          onConfirm={handleSetBase}
        />
      )}

      {/* Add agent modal */}
      {modal === "addAgent" && (
        <AgentModal
          t={t}
          mode="add"
          onClose={() => setModal(null)}
          onSubmit={handleAddAgent}
        />
      )}

      {/* Edit agent modal */}
      {modal === "editAgent" && editingAgent && (
        <AgentModal
          t={t}
          mode="edit"
          agent={editingAgent}
          onClose={() => { setModal(null); setEditingAgent(null); }}
          onSubmit={(data) => handleUpdateAgent(editingAgent.id, data)}
          onDelete={(cleanup) => handleDeleteAgent(editingAgent.id, cleanup)}
        />
      )}

      {/* History modal */}
      {modal === "history" && (
        <HistoryModal
          t={t}
          onClose={() => setModal(null)}
          onRollback={handleRollback}
        />
      )}

      {/* Matrix modal */}
      {modal === "matrix" && (
        <MatrixModal
          t={t}
          config={config}
          statusMatrix={statusMatrix}
          onClose={() => setModal(null)}
          badge={badge}
        />
      )}

      {/* Drift resolution modal */}
      {driftInfo && (
        <DriftModal
          t={t}
          skillId={driftInfo.skillId}
          agentId={driftInfo.agentId}
          skillName={config.base.skills.find(s => s.id === driftInfo.skillId)?.name || driftInfo.skillId}
          agentName={config.agents.find(a => a.id === driftInfo.agentId)?.name || driftInfo.agentId}
          onClose={() => setDriftInfo(null)}
          onResolve={handleResolveDrift}
        />
      )}

      <Toast toast={toast} t={t} />
    </div>
  );
}

// === Helper: format relative time ===
function formatRelative(isoString) {
  if (!isoString) return "未知";
  const date = new Date(isoString);
  const now = new Date();
  const diff = now - date;
  const min = Math.floor(diff / 60000);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (hr < 24) return `${hr} 小时前`;
  if (day < 7) return `${day} 天前`;
  return date.toLocaleDateString("zh-CN");
}

// === Welcome Screen (no base set) ===
function WelcomeScreen({ t, onSetBase }) {
  return (
    <div className="text-center max-w-md">
      <div style={{ background: t.primary }} className="w-16 h-16 rounded-3xl flex items-center justify-center rotate-[-6deg] shadow-lg mx-auto mb-5">
        <Boxes color="#fff" size={32} />
      </div>
      <h1 className="text-2xl font-bold mb-2">欢迎使用 SkillDock</h1>
      <p style={{ color: t.textMuted }} className="text-sm mb-6">
        Base 是仓库，Agent 是港口，Skill 是货。<br/>
        先指定一个文件夹作为你的 Base 仓库吧。
      </p>
      <button
        onClick={onSetBase}
        style={{ background: t.primary }}
        className="text-white rounded-xl px-6 py-3 text-sm font-semibold flex items-center gap-2 mx-auto"
      >
        <Folder size={18} /> 选择 Base 目录
      </button>
    </div>
  );
}

// === Set Base Modal with Directory Browser ===
function SetBaseModal({ t, currentPath, onClose, onConfirm }) {
  const [browsePath, setBrowsePath] = useState(currentPath || "");
  const [entries, setEntries] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [manualPath, setManualPath] = useState(currentPath || "");

  const browse = async (p) => {
    setLoading(true);
    try {
      const data = await api.browse(p);
      setBrowsePath(data.path);
      setParent(data.parent);
      setEntries(data.entries);
      setManualPath(data.path);
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { browse(""); }, []);

  const handleConfirm = () => {
    if (manualPath.trim()) onConfirm(manualPath.trim());
  };

  return (
    <Modal t={t} onClose={onClose} title="选择 Base 仓库目录" icon={Folder} maxWidth="max-w-lg">
      <div className="mb-3">
        <label className="text-xs font-medium mb-1 block" style={{ color: t.textMuted }}>手动输入路径</label>
        <input
          type="text"
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          placeholder="例如 ~/skills-base 或 /Users/you/skills"
          style={{ background: t.surfaceAlt, borderColor: t.border, color: t.text }}
          className="w-full rounded-lg border px-3 py-2 text-sm font-mono outline-none focus:border-[var(--ring)]"
          onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
        />
      </div>

      <div className="flex items-center gap-2 mb-2">
        <button onClick={() => browse(parent || "")} disabled={!parent} style={{ color: t.textMuted }} className="text-xs flex items-center gap-1 disabled:opacity-30">
          <ChevronLeft size={14} /> 上级
        </button>
        <span style={{ color: t.textMuted }} className="text-xs font-mono truncate flex-1">{browsePath || "/"}</span>
        <button onClick={() => browse("")} style={{ color: t.textMuted }} className="text-xs flex items-center gap-1">
          <HomeIcon size={14} /> 主目录
        </button>
      </div>

      <div style={{ background: t.surfaceAlt, borderColor: t.border }} className="rounded-lg border max-h-60 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin" size={20} style={{ color: t.textMuted }} />
          </div>
        ) : entries.length === 0 ? (
          <p style={{ color: t.textMuted }} className="text-xs text-center py-8">没有子目录</p>
        ) : (
          entries.map((e) => (
            <button
              key={e.name}
              onClick={() => browse(browsePath + "/" + e.name)}
              style={{ borderColor: t.border }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:opacity-70 border-b last:border-0 text-left"
            >
              <Folder size={14} style={{ color: t.primary }} />
              <span className="truncate">{e.name}</span>
            </button>
          ))
        )}
      </div>

      <div className="flex gap-2 mt-4">
        <button onClick={onClose} style={{ borderColor: t.border, color: t.text }} className="flex-1 border rounded-lg py-2 text-sm font-medium">
          取消
        </button>
        <button onClick={handleConfirm} style={{ background: t.primary }} className="flex-1 text-white rounded-lg py-2 text-sm font-semibold flex items-center justify-center gap-1.5">
          <CheckCircle2 size={15} /> 确认
        </button>
      </div>
    </Modal>
  );
}

// === Add/Edit Agent Modal ===
function AgentModal({ t, mode, agent, onClose, onSubmit, onDelete }) {
  const [name, setName] = useState(agent?.name || "");
  const [path, setPath] = useState(agent?.path || "");
  const [color, setColor] = useState(agent?.color || "#8B5CF6");
  const [defaultMode, setDefaultMode] = useState(agent?.defaultMode || "link");
  const [showDelete, setShowDelete] = useState(false);
  const [cleanup, setCleanup] = useState(false);

  const handleSubmit = () => {
    if (!name.trim() || !path.trim()) return;
    onSubmit({ name: name.trim(), path: path.trim(), color, defaultMode });
  };

  return (
    <Modal t={t} onClose={onClose} title={mode === "add" ? "添加 Agent" : "编辑 Agent"} icon={Plus} maxWidth="max-w-md">
      {mode === "add" && (
        <div className="mb-4">
          <label className="text-xs font-medium mb-2 block" style={{ color: t.textMuted }}>快速添加预设</label>
          <div className="grid grid-cols-2 gap-2">
            {AGENT_PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => { setName(p.name); setPath(p.path); setColor(p.color); setDefaultMode(p.defaultMode); }}
                style={{ borderColor: t.border, background: t.surfaceAlt }}
                className="rounded-lg border p-2.5 text-left hover:opacity-70"
              >
                <div className="flex items-center gap-2">
                  <div style={{ background: p.color + "22", color: p.color }} className="w-7 h-7 rounded-lg flex items-center justify-center">
                    <Ship size={14} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold">{p.name}</p>
                    <p style={{ color: t.textMuted }} className="text-[10px] font-mono">{p.path}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: t.textMuted }}>名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Agent"
            style={{ background: t.surfaceAlt, borderColor: t.border, color: t.text }}
            className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
          />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: t.textMuted }}>路径</label>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="~/.my-agent/skills"
            style={{ background: t.surfaceAlt, borderColor: t.border, color: t.text }}
            className="w-full rounded-lg border px-3 py-2 text-sm font-mono outline-none"
          />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: t.textMuted }}>默认同步模式</label>
          <div className="flex gap-2">
            <button
              onClick={() => setDefaultMode("link")}
              style={{
                background: defaultMode === "link" ? t.primary : t.surfaceAlt,
                color: defaultMode === "link" ? "#fff" : t.text,
                borderColor: defaultMode === "link" ? t.primary : t.border
              }}
              className="flex-1 rounded-lg border py-2 text-xs font-semibold flex items-center justify-center gap-1.5"
            >
              <Link2 size={13} /> 链接模式
            </button>
            <button
              onClick={() => setDefaultMode("copy")}
              style={{
                background: defaultMode === "copy" ? t.primary : t.surfaceAlt,
                color: defaultMode === "copy" ? "#fff" : t.text,
                borderColor: defaultMode === "copy" ? t.primary : t.border
              }}
              className="flex-1 rounded-lg border py-2 text-xs font-semibold flex items-center justify-center gap-1.5"
            >
              <Copy size={13} /> 复制模式
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: t.textMuted }}>图标颜色</label>
          <div className="flex gap-2 flex-wrap">
            {["#D97757", "#3E8EED", "#4E9A51", "#A78BFA", "#F59E0B", "#EC4899", "#14B8A6", "#6366F1"].map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{ background: c, borderColor: color === c ? t.text : "transparent", borderWidth: 2 }}
                className="w-7 h-7 rounded-lg border"
              >
                {color === c && <CheckCircle2 size={14} color="#fff" className="mx-auto" />}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-2 mt-4">
        <button onClick={onClose} style={{ borderColor: t.border, color: t.text }} className="flex-1 border rounded-lg py-2 text-sm font-medium">
          取消
        </button>
        <button onClick={handleSubmit} disabled={!name.trim() || !path.trim()} style={{ background: t.primary }} className="flex-1 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-50">
          {mode === "add" ? "添加" : "保存"}
        </button>
      </div>

      {mode === "edit" && (
        <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${t.border}` }}>
          {showDelete ? (
            <div>
              <p className="text-xs font-semibold mb-2" style={{ color: t.danger }}>⚠️ 删除 Agent</p>
              <p style={{ color: t.textMuted }} className="text-xs mb-3">
                删除 Agent 只解除托管关系。是否同时清理 SkillDock 曾同步过去的文件？
              </p>
              <label className="flex items-center gap-2 text-xs mb-3" style={{ color: t.text }}>
                <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} />
                同时清理同步文件
              </label>
              <div className="flex gap-2">
                <button onClick={() => setShowDelete(false)} style={{ borderColor: t.border, color: t.text }} className="flex-1 border rounded-lg py-2 text-xs font-medium">
                  取消
                </button>
                <button onClick={() => onDelete(cleanup)} style={{ background: t.danger }} className="flex-1 text-white rounded-lg py-2 text-xs font-semibold">
                  确认删除
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowDelete(true)} style={{ color: t.danger }} className="text-xs font-medium flex items-center gap-1.5">
              <Trash2 size={13} /> 删除此 Agent
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

// === Diff/Changes Modal ===
function DiffModal({ t, agent, skills, statusMatrix, onClose, onSync, onPush, badge }) {
  const [checked, setChecked] = useState({});
  const items = skills.filter(s => {
    const st = statusMatrix[agent.id]?.[s.id];
    return st === "stale" || st === "drifted" || st === "not_synced";
  });

  const applyChanges = () => {
    items.forEach(s => {
      if (checked[s.id]) {
        const st = statusMatrix[agent.id]?.[s.id];
        if (st === "stale") onPush(agent.id, s.id);
        else onSync(agent.id, s.id);
      }
    });
    onClose();
  };

  return (
    <Modal t={t} onClose={onClose} title={`${agent.name} 的待处理变更`} icon={Bell} maxWidth="max-w-md">
      {items.length === 0 ? (
        <p style={{ color: t.textMuted }} className="text-sm py-6 text-center">没有待处理的变更 🎉</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 mb-4">
            {items.map(s => {
              const st = statusMatrix[agent.id]?.[s.id];
              return (
                <label key={s.id} style={{ borderColor: t.border, background: t.surfaceAlt }} className="flex items-center gap-2.5 rounded-xl border p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!checked[s.id]}
                    onChange={(e) => setChecked(prev => ({ ...prev, [s.id]: e.target.checked }))}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-semibold">{s.name}</p>
                    <p style={{ color: t.textMuted }} className="text-[11px]">
                      {st === "stale" ? "Base 有新版本，待推送" : st === "drifted" ? "Agent 端有手动修改，需处理漂移" : "尚未投递到该 Agent"}
                    </p>
                  </div>
                  {badge(st, "xs")}
                </label>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} style={{ borderColor: t.border, color: t.text }} className="flex-1 border rounded-lg py-2 text-sm font-medium">
              取消
            </button>
            <button
              onClick={applyChanges}
              disabled={!Object.values(checked).some(v => v)}
              style={{ background: t.primary }}
              className="flex-1 text-white rounded-lg py-2 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              应用选中变更 <ArrowRight size={14} />
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// === Drift Resolution Modal ===
function DriftModal({ t, skillId, agentId, skillName, agentName, onClose, onResolve }) {
  const [action, setAction] = useState(null);
  const [newSkillName, setNewSkillName] = useState(`${skillId}-variant`);
  const [showNewName, setShowNewName] = useState(false);

  const options = [
    { value: "keep", label: "保留 Agent 端修改", desc: "跳过本次同步，标记为漂移，等待后续处理", icon: X },
    { value: "overwrite", label: "覆盖为 Base 版本", desc: "放弃 Agent 端的修改，用 Base 版本替换", icon: ArrowRight },
    { value: "save_as_new", label: "另存为新 skill 到 Base", desc: "把 Agent 端的修改导入 Base 作为独立 skill", icon: PackagePlus },
  ];

  const handleResolve = () => {
    if (!action) return;
    onResolve(skillId, agentId, action, action === "save_as_new" ? newSkillName : null);
  };

  return (
    <Modal t={t} onClose={onClose} title="检测到漂移" icon={FileWarning} maxWidth="max-w-md">
      <div style={{ background: t.dangerSoft, borderColor: t.danger + "33" }} className="rounded-xl border p-3 mb-4">
        <p className="text-sm font-semibold" style={{ color: t.danger }}>
          「{skillName}」在 {agentName} 中被手动修改过
        </p>
        <p style={{ color: t.textMuted }} className="text-xs mt-1">
          Agent 端文件内容与上次同步记录不一致，请选择处理方式：
        </p>
      </div>

      <div className="flex flex-col gap-2 mb-4">
        {options.map(opt => {
          const Icon = opt.icon;
          return (
            <button
              key={opt.value}
              onClick={() => { setAction(opt.value); setShowNewName(opt.value === "save_as_new"); }}
              style={{
                borderColor: action === opt.value ? t.primary : t.border,
                background: action === opt.value ? t.primarySoft : t.surfaceAlt,
                borderWidth: action === opt.value ? 2 : 1
              }}
              className="rounded-xl border p-3 text-left transition-all"
            >
              <div className="flex items-center gap-2">
                <Icon size={16} style={{ color: action === opt.value ? t.primary : t.textMuted }} />
                <span className="text-sm font-semibold">{opt.label}</span>
                {action === opt.value && <CheckCircle2 size={16} style={{ color: t.primary }} className="ml-auto" />}
              </div>
              <p style={{ color: t.textMuted }} className="text-xs mt-1 ml-6">{opt.desc}</p>
            </button>
          );
        })}
      </div>

      {showNewName && (
        <div className="mb-4 animate-slideUp">
          <label className="text-xs font-medium mb-1 block" style={{ color: t.textMuted }}>新 skill 名称</label>
          <input
            type="text"
            value={newSkillName}
            onChange={(e) => setNewSkillName(e.target.value)}
            style={{ background: t.surfaceAlt, borderColor: t.border, color: t.text }}
            className="w-full rounded-lg border px-3 py-2 text-sm font-mono outline-none"
          />
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onClose} style={{ borderColor: t.border, color: t.text }} className="flex-1 border rounded-lg py-2 text-sm font-medium">
          取消
        </button>
        <button onClick={handleResolve} disabled={!action} style={{ background: t.primary }} className="flex-1 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-50">
          确认处理
        </button>
      </div>
    </Modal>
  );
}

// === History Modal ===
function HistoryModal({ t, onClose, onRollback }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getHistory(100).then(setHistory).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const actionLabels = {
    sync: "同步", unsync: "移除", push: "推送变更",
    drift_keep: "保留漂移", drift_save_new: "另存为新 skill",
    rollback: "回滚"
  };

  const actionIcons = {
    sync: Truck, unsync: Trash2, push: ArrowRight,
    drift_keep: X, drift_save_new: PackagePlus, rollback: RotateCcw
  };

  const canRollback = (entry) => ["sync", "push", "unsync"].includes(entry.action);

  return (
    <Modal t={t} onClose={onClose} title="操作历史" icon={HistoryIcon} maxWidth="max-w-lg">
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="animate-spin" size={20} style={{ color: t.textMuted }} />
        </div>
      ) : history.length === 0 ? (
        <p style={{ color: t.textMuted }} className="text-sm py-6 text-center">暂无操作历史</p>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-[400px] overflow-y-auto">
          {history.map(h => {
            const Icon = actionIcons[h.action] || HistoryIcon;
            return (
              <div key={h.id} style={{ borderColor: t.border, background: t.surfaceAlt }} className="rounded-lg border p-2.5 flex items-center gap-2.5">
                <div style={{ background: t.surface }} className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Icon size={14} style={{ color: t.primary }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold">{actionLabels[h.action] || h.action}</span>
                    <span style={{ color: t.textMuted }} className="text-[10px]">·</span>
                    <span className="text-xs truncate">{h.skillName}</span>
                    <span style={{ color: t.textMuted }} className="text-[10px]">→</span>
                    <span className="text-xs truncate" style={{ color: t.textMuted }}>{h.agentName}</span>
                  </div>
                  <p style={{ color: t.textMuted }} className="text-[10px] mt-0.5">
                    {formatRelative(h.timestamp)} · {h.mode === "link" ? "链接" : "复制"}
                  </p>
                </div>
                {canRollback(h) && (
                  <button
                    onClick={() => onRollback(h.id)}
                    style={{ color: t.textMuted, borderColor: t.border }}
                    className="border rounded-md px-2 py-1 text-[10px] font-medium flex items-center gap-1 hover:opacity-70 flex-shrink-0"
                  >
                    <RotateCcw size={11} /> 回滚
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// === Matrix Modal (status overview) ===
function MatrixModal({ t, config, statusMatrix, onClose, badge }) {
  const [checked, setChecked] = useState({});
  const [pendingPush, setPendingPush] = useState({});

  const handleApplyAll = async () => {
    for (const key in pendingPush) {
      if (pendingPush[key]) {
        const [agentId, skillId] = key.split("||");
        try {
          const st = statusMatrix[agentId]?.[skillId];
          if (st === "stale") await api.push(skillId, agentId);
          else await api.sync(skillId, agentId);
        } catch (e) { /* ignore individual errors */ }
      }
    }
    onClose();
  };

  return (
    <Modal t={t} onClose={onClose} title="状态总览 · 矩阵视图" icon={Boxes} maxWidth="max-w-2xl">
      {config.base.skills.length === 0 ? (
        <p style={{ color: t.textMuted }} className="text-sm py-6 text-center">Base 中没有 skill</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th style={{ color: t.textMuted, borderColor: t.border }} className="text-left p-2 border-b font-medium">Skill</th>
                {config.agents.map(a => (
                  <th key={a.id} style={{ color: t.textMuted, borderColor: t.border }} className="p-2 border-b font-medium text-center min-w-[80px]">
                    {a.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {config.base.skills.map(s => (
                <tr key={s.id}>
                  <td style={{ borderColor: t.border }} className="p-2 border-b font-semibold truncate max-w-[120px]">{s.name}</td>
                  {config.agents.map(a => {
                    const st = statusMatrix[a.id]?.[s.id] || "not_synced";
                    const key = `${a.id}||${s.id}`;
                    const canPush = st === "stale" || st === "not_synced";
                    return (
                      <td key={a.id} style={{ borderColor: t.border }} className="p-2 border-b text-center">
                        <div className="flex flex-col items-center gap-1">
                          {badge(st, "xs")}
                          {canPush && (
                            <input
                              type="checkbox"
                              checked={!!checked[key]}
                              onChange={(e) => {
                                setChecked(p => ({ ...p, [key]: e.target.checked }));
                                setPendingPush(p => ({ ...p, [key]: e.target.checked }));
                              }}
                            />
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {Object.values(checked).some(v => v) && (
            <div className="mt-4 flex justify-end animate-slideUp">
              <button onClick={handleApplyAll} style={{ background: t.primary }} className="text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-1.5">
                <Truck size={14} /> 应用选中变更
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// === Reusable Modal wrapper ===
function Modal({ t, onClose, title, icon: Icon, children, maxWidth = "max-w-md" }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-30 animate-fadeIn" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: t.surface, borderColor: t.border }}
        className={`w-full ${maxWidth} rounded-2xl border p-5 animate-slideUp max-h-[85vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-sm flex items-center gap-2">
            {Icon && <Icon size={16} style={{ color: t.primary }} />}
            {title}
          </h3>
          <button onClick={onClose}><X size={16} style={{ color: t.textMuted }} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// === Toast ===
function Toast({ toast, t }) {
  if (!toast) return null;
  const colors = {
    info: [t.text, t.bg],
    error: [t.danger, t.bg],
    warn: [t.warn, t.bg],
  };
  const [fg, bg] = colors[toast.type] || colors.info;
  return (
    <div
      style={{ background: fg, color: bg }}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-sm shadow-lg z-40 flex items-center gap-2 animate-slideUp"
    >
      <PackageCheck size={15} />
      {toast.msg}
    </div>
  );
}

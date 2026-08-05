// SkillDock client — lightweight vanilla JS.
// Renders happen server-side (SSR); this script only fetches partials,
// calls the JSON API, wires modals, keeps selection state, shows toasts,
// and listens to SSE for live updates.
(function () {
  "use strict";

  var selectedSkills = new Set();
  var selectedAgents = new Set();
  var selectedColor = "#D97757";
  var selectedDrift = null;
  var toastTimer = null;

  // ---- theme (light / dark) ----
  var THEME_KEY = "skilldock-theme";
  function currentTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    return (t === "dark") ? "dark" : "light";
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    updateThemeIcon();
  }
  function updateThemeIcon() {
    var btn = qs("#sd-theme-toggle");
    if (!btn) return;
    var use = btn.querySelector(".i use");
    if (use) use.setAttribute("href", currentTheme() === "dark" ? "#icon-sun" : "#icon-moon");
  }
  function toggleTheme() { applyTheme(currentTheme() === "dark" ? "light" : "dark"); }

  // ---- helpers ----
  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  async function api(path, method, body) {
    var opt = { method: method, headers: { "Content-Type": "application/json" } };
    if (body) opt.body = JSON.stringify(body);
    var res = await fetch(path, opt);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ("错误 " + res.status));
    return data;
  }

  function toast(msg, type) {
    var root = qs("#toast-root");
    if (!root) return;
    root.innerHTML = "";
    var el = document.createElement("div");
    el.className = "sd-toast" + (type ? " sd-toast-" + type : "");
    el.textContent = msg;
    root.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { root.innerHTML = ""; }, 2800);
  }

  async function loadDashboard() {
    var res = await fetch("/partial/dashboard");
    qs("#app").innerHTML = await res.text();
    afterRender();
  }

  function afterRender() {
    selectedSkills.forEach(function (id) {
      var c = qs('.sd-skill-card[data-skill-id="' + id + '"]');
      if (c) c.classList.add("is-selected");
    });
      selectedAgents.forEach(function (id) {
      var b = qs('.sd-select-agent[data-agent-id="' + id + '"]');
      if (b) { b.classList.add("is-on"); b.textContent = "✓"; }
    });
    updateBatchBtn();
    updateThemeIcon();
  }

  function updateBatchBtn() {
    var btn = qs(".sd-batch-btn");
    if (!btn) return;
    var ns = selectedSkills.size, na = selectedAgents.size;
    var c1 = btn.querySelector(".sd-batch-count");
    var c2 = btn.querySelector(".sd-batch-count-a");
    if (c1) c1.textContent = ns;
    if (c2) c2.textContent = na;
    btn.style.display = (ns > 0 && na > 0) ? "" : "none";
  }

  function toggleSkill(id) {
    if (selectedSkills.has(id)) selectedSkills.delete(id);
    else selectedSkills.add(id);
    var c = qs('.sd-skill-card[data-skill-id="' + id + '"]');
    if (c) c.classList.toggle("is-selected");
    updateBatchBtn();
  }

  // ---- modals ----
  function openModal(name, query) {
    return fetch("/partial/" + name + (query || "")).then(function (r) { return r.text(); }).then(function (html) {
      qs("#modal-root").innerHTML = html;
      if (name === "set-base") { selectedColor = "#D97757"; loadBrowse(""); }
      if (name === "add-agent") { wireAddAgent(); }
    });
  }
  function closeModal() { qs("#modal-root").innerHTML = ""; }

  async function loadBrowse(path) {
    var res = await fetch("/partial/browse?path=" + encodeURIComponent(path || ""));
    var list = qs("#sd-browse-list");
    if (!list) return;
    list.innerHTML = await res.text();
    var inner = list.querySelector(".sd-browse-inner");
    if (inner) {
      var p = inner.getAttribute("data-path");
      var pp = qs("#sd-browse-path");
      if (pp) pp.textContent = p;
      var inp = qs("#sd-base-input");
      if (inp) inp.value = p;
    }
  }

  function selectColor(color, el) {
    selectedColor = color;
    qsa("#sd-color-row .sd-color-dot").forEach(function (d) { d.classList.remove("is-on"); });
    if (el) el.classList.add("is-on");
  }
  function applyPreset(el) {
    var name = el.getAttribute("data-preset");
    var path = el.getAttribute("data-path");
    var color = el.getAttribute("data-color");
    var n = qs("#sd-agent-name"); if (n) n.value = name;
    var p = qs("#sd-agent-path"); if (p) p.value = path;
    selectColor(color, qs('.sd-color-dot[data-color="' + color + '"]'));
  }
  function selectDrift(d) {
    selectedDrift = d;
    qsa(".sd-drift-opt").forEach(function (o) { o.classList.remove("is-on"); });
    var el = qs('.sd-drift-opt[data-drift="' + d + '"]');
    if (el) el.classList.add("is-on");
    var wrap = qs("#sd-newname-wrap");
    if (wrap) wrap.style.display = (d === "save_as_new") ? "" : "none";
  }
  function wireAddAgent() {
    var first = qs("#sd-color-row .sd-color-dot");
    if (first) selectColor(first.getAttribute("data-color"), first);
  }

  // ---- action dispatch ----
  function handleAction(el) {
    var action = el.getAttribute("data-action");
    switch (action) {
      case "close-modal":
        if (el.classList.contains("sd-modal-overlay")) {
          if (el === event_target) closeModal();
        } else {
          closeModal();
        }
        return;
      case "open-set-base":
        openModal("set-base"); return;
      case "scan":
        api("/api/scan", "POST").then(function () { loadDashboard(); toast("扫描完成"); })
          .catch(function (e) { toast(e.message, "error"); }); return;
      case "open":
        api("/api/open", "POST", { path: el.getAttribute("data-path") })
          .catch(function (e) { toast(e.message, "error"); }); return;
      case "toggle-agent": {
        var aid = el.getAttribute("data-agent-id");
        if (selectedAgents.has(aid)) selectedAgents.delete(aid); else selectedAgents.add(aid);
        el.classList.toggle("is-on");
        el.textContent = selectedAgents.has(aid) ? "✓" : "+";
        updateBatchBtn(); return;
      }
      case "batch-sync": {
        var skillIds = Array.from(selectedSkills);
        var agentIds = Array.from(selectedAgents);
        if (!skillIds.length || !agentIds.length) { toast("请先勾选 skill 和 agent", "error"); return; }
        api("/api/sync-batch", "POST", { skillIds: skillIds, agentIds: agentIds, mode: "" })
          .then(function (r) {
            selectedSkills.clear(); selectedAgents.clear();
            loadDashboard();
            var fail = (r.errors || []).length;
            if (fail) toast("同步完成，" + fail + " 个失败", "error");
            else toast("已同步 " + skillIds.length + " 个 skill 到 " + agentIds.length + " 个 agent");
          }).catch(function (e) { toast(e.message, "error"); });
        return;
      }
      case "sync": syncOne(el.getAttribute("data-skill-id"), el.getAttribute("data-agent-id"), "sync"); return;
      case "push": syncOne(el.getAttribute("data-skill-id"), el.getAttribute("data-agent-id"), "push"); return;
      case "unsync":
        api("/api/unsync", "POST", { skillId: el.getAttribute("data-skill-id"), agentId: el.getAttribute("data-agent-id") })
          .then(function () { loadDashboard(); toast("已移除同步（Base 不受影响）"); })
          .catch(function (e) { toast(e.message, "error"); }); return;
      case "open-drift":
        openModal("drift?skillId=" + encodeURIComponent(el.getAttribute("data-skill-id")) + "&agentId=" + encodeURIComponent(el.getAttribute("data-agent-id"))); return;
      case "sync-all": syncAll(el.getAttribute("data-agent-id")); return;
      case "open-diff": openModal("diff?agentId=" + encodeURIComponent(el.getAttribute("data-agent-id"))); return;
      case "open-edit-agent": openModal("edit-agent?agentId=" + encodeURIComponent(el.getAttribute("data-agent-id"))); return;
      case "open-add-agent": openModal("add-agent"); return;
      case "open-history": openModal("history"); return;
      case "toggle-theme": toggleTheme(); return;
      case "confirm-set-base": {
        var p = qs("#sd-base-input").value.trim();
        if (!p) { toast("请输入路径", "error"); return; }
        api("/api/base", "POST", { path: p }).then(function () { closeModal(); loadDashboard(); toast("Base 仓库已设置"); })
          .catch(function (e) { toast(e.message, "error"); }); return;
      }
      case "confirm-add-agent": {
        var name = qs("#sd-agent-name").value.trim();
        var path = qs("#sd-agent-path").value.trim();
        if (!name || !path) { toast("请提供名称和路径", "error"); return; }
        var modeEl = qs("#sd-agent-mode .sd-seg-opt.is-on");
        var mode = modeEl ? modeEl.getAttribute("data-mode") : "copy";
        api("/api/agents", "POST", { name: name, path: path, color: selectedColor, defaultMode: mode })
          .then(function () { closeModal(); loadDashboard(); toast("Agent「" + name + "」已添加"); })
          .catch(function (e) { toast(e.message, "error"); }); return;
      }
      case "confirm-edit-agent": {
        var id = qs("#sd-edit-id").value;
        var modeEl = qs("#sd-agent-mode .sd-seg-opt.is-on");
        var mode = modeEl ? modeEl.getAttribute("data-mode") : "copy";
        api("/api/agents?id=" + encodeURIComponent(id), "PUT", {
          name: qs("#sd-agent-name").value, path: qs("#sd-agent-path").value,
          color: selectedColor, defaultMode: mode
        }).then(function () { closeModal(); loadDashboard(); toast("Agent 已更新"); })
          .catch(function (e) { toast(e.message, "error"); }); return;
      }
      case "confirm-delete-agent": {
        var del = el.getAttribute("data-agent-id");
        var cleanup = qs("#sd-cleanup") ? qs("#sd-cleanup").checked : false;
        api("/api/agents?id=" + encodeURIComponent(del) + "&cleanup=" + (cleanup ? "true" : "false"), "DELETE")
          .then(function () { closeModal(); loadDashboard(); toast(cleanup ? "Agent 已删除，同步文件已清理" : "Agent 已删除（文件保留）"); })
          .catch(function (e) { toast(e.message, "error"); }); return;
      }
      case "apply-diff": applyDiff(el.getAttribute("data-agent-id")); return;
      case "confirm-drift": confirmDrift(el); return;
      case "rollback":
        api("/api/rollback", "POST", { historyId: el.getAttribute("data-history-id") })
          .then(function () { closeModal(); loadDashboard(); toast("已回滚"); })
          .catch(function (e) { toast(e.message, "error"); }); return;
    }
  }

  function syncOne(skillId, agentId, kind) {
    var path = kind === "push" ? "/api/push" : "/api/sync";
    api(path, "POST", { skillId: skillId, agentId: agentId, mode: "" })
      .then(function (r) {
        loadDashboard();
        if (kind === "push") toast("已推送变更");
        else toast("已同步");
      }).catch(function (e) { toast(e.message, "error"); });
  }

  async function syncAll(agentId) {
    var card = qs('.sd-agent-card[data-agent-id="' + agentId + '"]');
    if (!card) return;
    var btns = card.querySelectorAll(".sd-act[data-skill-id]");
    var n = 0;
    for (var i = 0; i < btns.length; i++) {
      var sid = btns[i].getAttribute("data-skill-id");
      try {
        await api("/api/sync", "POST", { skillId: sid, agentId: agentId, mode: "" });
        n++;
      } catch (err) { toast(err.message, "error"); }
    }
    loadDashboard();
    toast(n ? ("已全量同步 " + n + " 个 skill") : "没有可同步的 skill");
  }

  async function applyDiff(agentId) {
    var checks = qsa(".sd-diff-check:checked");
    var n = 0;
    for (var i = 0; i < checks.length; i++) {
      var sid = checks[i].getAttribute("data-skill-id");
      var st = checks[i].getAttribute("data-status");
      try {
        if (st === "stale") await api("/api/push", "POST", { skillId: sid, agentId: agentId, mode: "" });
        else await api("/api/sync", "POST", { skillId: sid, agentId: agentId, mode: "" });
        n++;
      } catch (err) { toast(err.message, "error"); }
    }
    closeModal(); loadDashboard();
    toast(n ? ("已应用 " + n + " 处变更") : "请先勾选要应用的变更");
  }

  function confirmDrift(el) {
    if (!selectedDrift) { toast("请选择处理方式", "error"); return; }
    var skillId = el.getAttribute("data-skill-id");
    var agentId = el.getAttribute("data-agent-id");
    var newName = selectedDrift === "save_as_new" ? qs("#sd-newname").value : "";
    api("/api/drift", "POST", { skillId: skillId, agentId: agentId, action: selectedDrift, newSkillName: newName })
      .then(function () {
        closeModal(); loadDashboard();
        var labels = { keep: "已保留 Agent 端修改", overwrite: "已覆盖为 Base 版本", save_as_new: "已另存为新 skill" };
        toast(labels[selectedDrift] || "操作完成");
      }).catch(function (e) { toast(e.message, "error"); });
  }

  // ---- global click handler ----
  var event_target = null;
  document.addEventListener("click", function (e) {
    event_target = e.target;

    // directory browser navigation
    var browseEl = e.target.closest("[data-browse]");
    if (browseEl) { loadBrowse(browseEl.getAttribute("data-browse")); return; }

    // preset / color / drift pickers
    // NOTE: preset buttons also carry data-color, so they must be matched
    // BEFORE the generic color picker, otherwise only the color gets set.
    var presetEl = e.target.closest("[data-preset]");
    if (presetEl) { applyPreset(presetEl); return; }
    var segOpt = e.target.closest(".sd-seg-opt");
    if (segOpt) {
      var seg = segOpt.parentElement;
      seg.querySelectorAll(".sd-seg-opt").forEach(function (o) { o.classList.remove("is-on"); });
      segOpt.classList.add("is-on");
      return;
    }
    var colorEl = e.target.closest("[data-color]");
    if (colorEl) { selectColor(colorEl.getAttribute("data-color"), colorEl); return; }
    var driftEl = e.target.closest("[data-drift]");
    if (driftEl) { selectDrift(driftEl.getAttribute("data-drift")); return; }

    // skill card selection (ignore clicks on inner action buttons)
    var card = e.target.closest(".sd-skill-card");
    if (card && !e.target.closest("[data-action]")) {
      toggleSkill(card.getAttribute("data-skill-id"));
      return;
    }

    // generic actions
    var actionEl = e.target.closest("[data-action]");
    if (actionEl) { handleAction(actionEl); return; }
  });

  // Enter key confirms base path
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeModal(); }
    if (e.key === "Enter" && e.target && e.target.id === "sd-base-input") {
      handleAction({ getAttribute: function () { return "confirm-set-base"; }, classList: { contains: function () { return false; } } });
    }
  });

  // ---- live updates via SSE ----
  if (typeof EventSource !== "undefined") {
    var es = new EventSource("/api/events");
    es.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === "config_updated") { loadDashboard(); }
        else if (msg.type === "change_detected") { toast(msg.data.message, "warn"); loadDashboard(); }
      } catch (_) {}
    };
  }

  afterRender();
})();

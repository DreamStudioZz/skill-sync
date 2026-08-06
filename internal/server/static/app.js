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
  var skillQuery = "";
  var activeTag = "";
  var focusedSkillId = null;
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
  function iconSvg(name) { return '<svg class="i" aria-hidden="true"><use href="#icon-' + name + '"></use></svg>'; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  // Copy text to clipboard with a graceful fallback for non-secure contexts.
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

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
    wireSkillSearch();
    buildTagFilter();
    updateBatchBtn();
    updateThemeIcon();
    buildSyncBadges();
    wireSyncBadges();
    renderFocus();
  }

  // ---- skill list search (name + description) + tag filter ----
  function applySkillFilter() {
    var q = skillQuery.trim().toLowerCase();
    var tag = activeTag;
    var total = 0, shown = 0;
    qsa(".sd-skill-card").forEach(function (c) {
      total++;
      var matchQ = true, matchT = true;
      if (q) {
        var name = (c.getAttribute("data-name") || "").toLowerCase();
        var desc = (c.getAttribute("data-desc") || "").toLowerCase();
        matchQ = name.indexOf(q) >= 0 || desc.indexOf(q) >= 0;
      }
      if (tag) {
        var tags = (c.getAttribute("data-tags") || "").split(",");
        matchT = tags.indexOf(tag) >= 0;
      }
      if (matchQ && matchT) { c.classList.remove("sd-skill-hidden"); shown++; }
      else c.classList.add("sd-skill-hidden");
    });
    var cnt = qs("#sd-skill-count");
    if (cnt) cnt.textContent = (q || tag) && shown !== total ? (shown + " / " + total) : total;
  }

  // Build the tag filter pills from the currently rendered skills.
  function buildTagFilter() {
    var bar = qs("#sd-tag-filter");
    if (!bar) return;
    var tags = {};
    qsa(".sd-skill-card").forEach(function (c) {
      (c.getAttribute("data-tags") || "").split(",").forEach(function (t) {
        t = t.trim();
        if (t) tags[t] = true;
      });
    });
    var keys = Object.keys(tags).sort();
    if (keys.length === 0) { bar.innerHTML = ""; return; }
    var html = '<button class="sd-tag-pill' + (activeTag === "" ? " is-on" : "") + '" data-tag="">全部</button>';
    keys.forEach(function (t) {
      html += '<button class="sd-tag-pill' + (activeTag === t ? " is-on" : "") + '" data-tag="' + t + '">' + t + "</button>";
    });
    bar.innerHTML = html;
    qsa(".sd-tag-pill", bar).forEach(function (b) {
      b.addEventListener("click", function () {
        activeTag = b.getAttribute("data-tag") || "";
        applySkillFilter();
        qsa(".sd-tag-pill", bar).forEach(function (x) { x.classList.remove("is-on"); });
        b.classList.add("is-on");
      });
    });
  }

  function wireSkillSearch() {
    var sb = qs("#sd-skill-search");
    if (!sb) return;
    sb.value = skillQuery;
    sb.addEventListener("input", function () {
      skillQuery = sb.value;
      applySkillFilter();
    });
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

  // ---- skill-centric focus: click a skill to see which agents it is synced to ----
  function focusSkill(id) {
    focusedSkillId = (focusedSkillId === id) ? null : id;
    renderFocus();
  }
  function renderFocus() {
    var id = focusedSkillId;
    // left: mark focused card
    qsa(".sd-skill-card").forEach(function (c) {
      c.classList.toggle("is-focused", !!id && c.getAttribute("data-skill-id") === id);
    });
    var banner = qs("#sd-focus-banner");
    if (!banner) return;
    // reset right side
    qsa(".sd-agent-card").forEach(function (a) { a.classList.remove("has-focus-skill", "no-focus-skill"); });
    qsa(".sd-skill-row").forEach(function (r) { r.classList.remove("is-focus", "is-dim"); });
    if (!id) { banner.style.display = "none"; banner.innerHTML = ""; return; }

    var nameEl = qs('.sd-skill-card[data-skill-id="' + id + '"] .sd-skill-name');
    var name = nameEl ? nameEl.textContent : id;
    var agents = qsa(".sd-agent-card");
    var total = agents.length, synced = 0, lines = "";
    agents.forEach(function (a) {
      var aname = (a.querySelector(".sd-agent-name") || {}).textContent || a.getAttribute("data-agent-id");
      var row = a.querySelector('.sd-skill-row[data-skill-id="' + id + '"]');
      var present = !!row && row.getAttribute("data-status") && row.getAttribute("data-status") !== "not_synced";
      if (present) synced++;
      a.classList.toggle("has-focus-skill", !!present);
      a.classList.toggle("no-focus-skill", !present);
      if (row) {
        row.classList.add("is-focus");
        Array.prototype.slice.call(a.querySelectorAll(".sd-skill-row")).forEach(function (r) { if (r !== row) r.classList.add("is-dim"); });
      }
      lines += '<span class="sd-focus-line ' + (present ? "is-on" : "is-off") + '"><span class="sd-focus-mark">' +
        (present ? "✔" : "✖") + "</span>" + aname + "</span>";
    });
    banner.style.display = "";
    banner.innerHTML =
      '<div class="sd-focus-head"><b>' + name + '</b>' +
      '<span class="sd-muted sd-small">已同步到 ' + synced + ' / ' + total + ' 个 Agent</span>' +
      '<span class="sd-focus-clear" data-action="clear-focus" title="取消聚焦">✕</span></div>' +
      '<div class="sd-focus-list">' + lines + "</div>";
  }

  // Per-skill badge: "2/3 ✓" — how many agents this skill is synced to.
  function buildSyncBadges() {
    var agents = qsa(".sd-agent-card");
    var total = agents.length;
    qsa(".sd-skill-card").forEach(function (c) {
      var id = c.getAttribute("data-skill-id");
      var synced = 0;
      agents.forEach(function (a) {
        var row = a.querySelector('.sd-skill-row[data-skill-id="' + id + '"]');
        if (row && row.getAttribute("data-status") && row.getAttribute("data-status") !== "not_synced") synced++;
      });
      var badge = c.querySelector(".sd-skill-sync");
      var cnt = c.querySelector(".sd-sync-count");
      var mark = c.querySelector(".sd-sync-mark");
      if (!badge) return;
      if (total === 0) {
        if (cnt) cnt.textContent = "—";
        if (mark) { mark.textContent = ""; mark.className = "sd-sync-mark"; }
        badge.classList.add("is-empty");
      } else if (synced === 0) {
        if (cnt) cnt.textContent = "0/" + total;
        if (mark) { mark.textContent = "✕"; mark.className = "sd-sync-mark off"; }
        badge.classList.remove("is-full"); badge.classList.remove("is-empty");
      } else {
        if (cnt) cnt.textContent = synced + "/" + total;
        if (mark) { mark.textContent = "✓"; mark.className = "sd-sync-mark on"; }
        badge.classList.toggle("is-full", synced === total);
        badge.classList.remove("is-empty");
      }
      badge.setAttribute("title", synced + " / " + total + " 个 Agent 已同步");
    });
  }

  // Hover popover showing the per-agent sync breakdown for one skill.
  var syncPop = null, syncPopTimer = null;
  function hideSyncPop() { if (syncPop) { syncPop.remove(); syncPop = null; } }
  function showSyncPop(badge) {
    clearTimeout(syncPopTimer);
    hideSyncPop();
    var id = badge.getAttribute("data-skill-id");
    var card = badge.closest(".sd-skill-card");
    var name = card ? card.getAttribute("data-name") : id;
    var agents = qsa(".sd-agent-card");
    var onLines = "", offLines = "";
    agents.forEach(function (a) {
      var aname = (a.querySelector(".sd-agent-name") || {}).textContent || a.getAttribute("data-agent-id");
      var row = a.querySelector('.sd-skill-row[data-skill-id="' + id + '"]');
      var present = row && row.getAttribute("data-status") && row.getAttribute("data-status") !== "not_synced";
      var line = '<div class="sd-sync-pop-line ' + (present ? "on" : "off") + '"><span>' + (present ? "✔" : "✕") + "</span>" + esc(aname) + "</div>";
      if (present) onLines += line; else offLines += line;
    });
    var body = "";
    if (onLines) body += '<div class="sd-sync-pop-group">已同步</div>' + onLines;
    if (offLines) body += '<div class="sd-sync-pop-group">未同步</div>' + offLines;
    if (!body) body = '<div class="sd-sync-pop-line off">暂无 Agent</div>';
    syncPop = document.createElement("div");
    syncPop.className = "sd-sync-pop";
    syncPop.innerHTML = '<div class="sd-sync-pop-head">' + esc(name) + " · 同步状态</div>" + body;
    document.body.appendChild(syncPop);
    var r = badge.getBoundingClientRect();
    var top = r.bottom + 6 + window.scrollY;
    var left = r.right - syncPop.offsetWidth + window.scrollX;
    if (left < 8) left = 8;
    syncPop.style.top = top + "px";
    syncPop.style.left = left + "px";
    syncPop.addEventListener("mouseenter", function () { clearTimeout(syncPopTimer); });
    syncPop.addEventListener("mouseleave", function () { syncPopTimer = setTimeout(hideSyncPop, 160); });
  }
  function wireSyncBadges() {
    qsa(".sd-skill-sync").forEach(function (b) {
      b.addEventListener("mouseenter", function () { showSyncPop(b); });
      b.addEventListener("mouseleave", function () { syncPopTimer = setTimeout(hideSyncPop, 160); });
    });
  }

  // Primary action on a skill card: open its detail (info + per-agent sync + actions).
  function openSkillDetail(id) {
    var card = qs('.sd-skill-card[data-skill-id="' + id + '"]');
    if (!card) return;
    var name = card.getAttribute("data-name") || id;
    var desc = card.getAttribute("data-desc") || "";
    var tags = (card.getAttribute("data-tags") || "").split(",").filter(Boolean);
    var openBtn = card.querySelector('[data-action="open"]');
    var openPath = openBtn ? openBtn.getAttribute("data-path") : "";
    var timeEl = card.querySelector(".sd-skill-time");
    var timeTxt = timeEl ? timeEl.textContent.trim() : "";
    var timeAbs = timeEl ? (timeEl.getAttribute("data-abs") || "") : "";
    var hashEl = card.querySelector(".sd-hash");
    var hashTxt = hashEl ? hashEl.textContent.trim() : "";

    var agents = qsa(".sd-agent-card");
    var total = agents.length, synced = 0, rows = "";
    agents.forEach(function (a) {
      var aid = a.getAttribute("data-agent-id");
      var aname = (a.querySelector(".sd-agent-name") || {}).textContent || aid;
      var row = a.querySelector('.sd-skill-row[data-skill-id="' + id + '"]');
      var status = row ? row.getAttribute("data-status") : "not_synced";
      var present = status && status !== "not_synced";
      if (present) synced++;
      var stTxt = status === "synced" ? "已同步" : status === "stale" ? "待更新" : status === "drifted" ? "漂移" : "未同步";
      // Operation column: unsynced = direct prominent sync (most recommended);
      // synced/stale/drifted = "⋯" menu (more actions).
      var opBtn = present
        ? '<button class="sd-row-menu" data-action="row-menu" data-skill-id="' + id + '" data-agent-id="' + aid + '" data-status="' + status + '" title="操作">⋯</button>'
        : '<button class="sd-row-sync" data-action="modal-sync" data-skill-id="' + id + '" data-agent-id="' + aid + '" title="同步到该 Agent">' + iconSvg("sync") + "</button>";
      rows += '<div class="sd-detail-sync-row" data-status="' + status + '">' +
        '<span class="sd-detail-sync-name">' + esc(aname) + "</span>" +
        '<span class="sd-sync-status"><span class="sd-sync-dot ' + (present ? "on" : "off") + '">' + (present ? "✔" : "✕") + "</span>" + stTxt + "</span>" +
        opBtn +
        "</div>";
    });

    var pct = total ? Math.round((synced / total) * 100) : 0;
    var progressWrap = total
      ? '<div class="sd-sync-progress-wrap" data-action="toggle-sync-table" title="点击折叠 / 展开（' + pct + '% 已同步）">' +
          '<div class="sd-sync-progress"><div class="sd-sync-bar" style="width:' + pct + '%"></div></div>' +
          '<span class="sd-sync-count-txt">' + synced + " / " + total + " Agent</span>" +
          '<span class="sd-sync-chevron" id="sd-sync-chevron">' + iconSvg("chevron-down") + "</span>" +
        "</div>"
      : "";

    var infoHtml = '<div class="sd-label">信息</div>' +
      '<div class="sd-detail-meta">' +
      (hashTxt ? '<div class="sd-detail-field"><span class="sd-detail-field-label">Hash</span>' +
        '<span class="sd-detail-field-val sd-mono">' + esc(hashTxt) +
        ' <button class="sd-copy-btn" data-action="copy-hash" data-hash="' + esc(hashTxt) + '" title="复制 Hash">' + iconSvg("copy") + "</button></span></div>" : "") +
      (timeTxt ? '<div class="sd-detail-field"><span class="sd-detail-field-label">更新时间</span>' +
        '<span class="sd-detail-field-val">' + iconSvg("clock") + " " + esc(timeTxt) + "</span>" +
        (timeAbs ? '<span class="sd-detail-abs" title="' + esc(timeAbs) + '">' + esc(timeAbs) + "</span>" : "") + "</div>" : "") +
      "</div>";

    var html =
      '<div class="sd-modal-overlay" data-action="close-modal">' +
        '<div class="sd-modal sd-modal-detail" data-stop="1">' +
          '<div class="sd-modal-head"><h3>' + iconSvg("box") + " " + esc(name) + "</h3>" +
            '<button class="sd-icon-btn" data-action="close-modal">' + iconSvg("close") + "</button></div>" +
          (openPath ? '<div class="sd-detail-actions"><button class="sd-btn sd-btn-outline sd-btn-sm" data-action="open" data-path="' + openPath + '">' + iconSvg("folder-open") + " 在文件管理器中打开</button></div>" : "") +
          (desc ? '<div class="sd-label">描述</div><p class="sd-detail-desc" id="sd-desc-body">' + esc(desc) + "</p>" +
            '<button class="sd-link-btn sd-desc-toggle" data-action="toggle-desc" style="display:none">展开描述</button>' : "") +
          (tags.length ? '<div class="sd-label">标签</div><div class="sd-skill-tags">' + tags.map(function (t) { return "<span class=\"sd-tag\">" + esc(t) + "</span>"; }).join("") + "</div>" : "") +
          infoHtml +
          '<div class="sd-label">同步状态</div>' +
          '<div class="sd-detail-sync">' +
            progressWrap +
            '<div class="sd-detail-sync-table" id="sd-sync-table">' +
              '<div class="sd-detail-sync-h"><span>Agent</span><span>状态</span><span>操作</span></div>' +
              (rows || '<p class="sd-muted sd-small">还没有添加任何 Agent</p>') +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>";
    qs("#modal-root").innerHTML = html;

    // Long-description fold: show the toggle only when it actually overflows.
    var descEl = qs("#sd-desc-body");
    var toggle = qs(".sd-desc-toggle");
    if (descEl && toggle && descEl.scrollHeight > descEl.clientHeight + 2) {
      descEl.classList.add("is-clamped");
      toggle.style.display = "";
    }
  }

  // Per-row "⋯" menu in the skill detail dialog — unifies per-agent actions
  // into one entry point (extensible: 重新同步 / 移除 / 查看差异 …).
  var rowMenuPop = null;
  function closeRowMenu() { if (rowMenuPop) { rowMenuPop.remove(); rowMenuPop = null; } }
  function openRowMenu(btn) {
    closeRowMenu();
    var sid = btn.getAttribute("data-skill-id");
    var aid = btn.getAttribute("data-agent-id");
    var status = btn.getAttribute("data-status");
    var present = status && status !== "not_synced";
    var items = [];
    if (!present) {
      items.push({ label: "同步到该 Agent", action: "modal-sync", icon: "sync" });
    } else {
      items.push({ label: (status === "synced" ? "重新同步" : "推送更新"), action: (status === "synced" ? "modal-sync" : "modal-push"), icon: "sync" });
      items.push({ label: "移除同步", action: "modal-unsync", icon: "trash" });
      if (status === "stale" || status === "drifted") {
        items.push({ label: "查看差异", action: "modal-diff", icon: "drift" });
      }
    }
    var pop = document.createElement("div");
    pop.className = "sd-row-menu-pop";
    pop.innerHTML = items.map(function (it) {
      return '<button class="sd-row-menu-item" data-action="' + it.action + '" data-skill-id="' + sid + '" data-agent-id="' + aid + '">' +
        iconSvg(it.icon) + "<span>" + it.label + "</span></button>";
    }).join("");
    document.body.appendChild(pop);
    rowMenuPop = pop;
    var r = btn.getBoundingClientRect();
    var ph = pop.offsetHeight, pw = pop.offsetWidth;
    var top = r.bottom + 4 + window.scrollY;
    if (top + ph - window.scrollY > window.innerHeight) top = r.top - ph - 4 + window.scrollY;
    var left = r.right - pw + window.scrollX;
    if (left < 8) left = 8;
    pop.style.top = top + "px";
    pop.style.left = left + "px";
  }

  async function modalSkillOne(skillId, agentId, kind) {
    try {
      if (kind === "unsync") await api("/api/unsync", "POST", { skillId: skillId, agentId: agentId });
      else if (kind === "push") await api("/api/push", "POST", { skillId: skillId, agentId: agentId });
      else await api("/api/sync", "POST", { skillId: skillId, agentId: agentId, mode: "" });
      await loadDashboard();
      openSkillDetail(skillId);
      toast(kind === "unsync" ? "已移除同步（Base 不受影响）" : (kind === "push" ? "已推送变更" : "已同步"));
    } catch (e) { toast(e.message, "error"); }
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
    closeRowMenu();
    var action = el.getAttribute("data-action");
    switch (action) {
      case "copy-hash":
        copyText(el.getAttribute("data-hash") || "").then(function () { toast("已复制 Hash"); })
          .catch(function () { toast("复制失败", "error"); });
        return;
      case "toggle-desc": {
        var d = qs("#sd-desc-body");
        if (!d) return;
        var expanded = d.classList.toggle("is-expanded");
        el.textContent = expanded ? "收起描述" : "展开描述";
        return;
      }
      case "toggle-sync-table": {
        var t = qs("#sd-sync-table");
        if (t) t.classList.toggle("is-collapsed");
        var ch = qs("#sd-sync-chevron");
        if (ch) ch.classList.toggle("is-rot");
        return;
      }
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
      case "clear-focus": focusedSkillId = null; renderFocus(); return;
      case "focus-skill": focusSkill(el.getAttribute("data-skill-id")); return;
      case "row-menu": openRowMenu(el); return;
      case "modal-sync": modalSkillOne(el.getAttribute("data-skill-id"), el.getAttribute("data-agent-id"), "sync"); return;
      case "modal-unsync": modalSkillOne(el.getAttribute("data-skill-id"), el.getAttribute("data-agent-id"), "unsync"); return;
      case "modal-push": modalSkillOne(el.getAttribute("data-skill-id"), el.getAttribute("data-agent-id"), "push"); return;
      case "modal-diff": openModal("drift?skillId=" + encodeURIComponent(el.getAttribute("data-skill-id")) + "&agentId=" + encodeURIComponent(el.getAttribute("data-agent-id"))); return;
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

    // close the per-row "⋯" menu when clicking anywhere else
    if (rowMenuPop && !e.target.closest(".sd-row-menu-pop") && !e.target.closest(".sd-row-menu")) closeRowMenu();

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

    // skill card: checkbox = batch select; body = open detail (primary action);
    // the sync badge (data-action="focus-skill") is the dedicated link entry.
    var checkEl = e.target.closest(".sd-check");
    if (checkEl) {
      var cc = checkEl.closest(".sd-skill-card");
      if (cc) { toggleSkill(cc.getAttribute("data-skill-id")); return; }
    }
    var card = e.target.closest(".sd-skill-card");
    if (card && !e.target.closest("[data-action]")) {
      openSkillDetail(card.getAttribute("data-skill-id"));
      return;
    }

    // generic actions
    var actionEl = e.target.closest("[data-action]");
    if (actionEl) { handleAction(actionEl); return; }
  });

  // Enter key confirms base path
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (rowMenuPop) { closeRowMenu(); return; }
      if (focusedSkillId) { focusedSkillId = null; renderFocus(); return; }
      closeModal();
    }
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

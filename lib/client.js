window.__ModuleLoader__.load({ id: "dsh-sev", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_client = require("react-dom/client");
var inject = ["slots", "connection", "locale", "betterSidebar"];
var API = {
  hosts: "/api/dsh-sev/hosts",
  host: "/api/dsh-sev/host",
  tunnel: "/api/dsh-sev/tunnel",
  health: "/api/dsh-sev/health",
  sessions: "/api/dsh-sev/sessions",
  task: "/api/dsh-sev/task",
  archive: "/api/dsh-sev/session-archive"
};
async function json(url, init) {
  const r = await fetch(url, init);
  return r.json();
}
function RemoteHostsPanel() {
  const [hosts, setHosts] = (0, import_react.useState)([]);
  const [loading, setLoading] = (0, import_react.useState)(true);
  const [error, setError] = (0, import_react.useState)(null);
  const [alias, setAlias] = (0, import_react.useState)("");
  const [taskContent, setTaskContent] = (0, import_react.useState)("");
  const [taskResult, setTaskResult] = (0, import_react.useState)(null);
  const [active, setActive] = (0, import_react.useState)(null);
  const [health, setHealth] = (0, import_react.useState)({});
  const [sessions, setSessions] = (0, import_react.useState)({});
  const refresh = (0, import_react.useCallback)(async () => {
    try {
      const data = await json(API.hosts);
      setHosts(data.hosts ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  (0, import_react.useEffect)(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 1e4);
    return () => window.clearInterval(timer);
  }, [refresh]);
  (0, import_react.useEffect)(() => {
    const timer = window.setInterval(async () => {
      for (const h of hosts) {
        if (h.tunnel?.state !== "running") continue;
        try {
          const d = await json(`${API.health}?id=${encodeURIComponent(h.id)}`);
          setHealth((prev) => ({ ...prev, [h.id]: { hostUp: d.hostUp, status: d.status } }));
        } catch {
        }
      }
    }, 5e3);
    return () => window.clearInterval(timer);
  }, [hosts]);
  (0, import_react.useEffect)(() => {
    const fetchSessions = async () => {
      for (const h of hosts) {
        if (h.tunnel?.state !== "running") continue;
        try {
          const d = await json(`${API.sessions}?id=${encodeURIComponent(h.id)}`);
          if (Array.isArray(d.sessions)) {
            setSessions((prev) => ({ ...prev, [h.id]: d.sessions }));
          }
        } catch {
        }
      }
    };
    void fetchSessions();
    const timer = window.setInterval(() => {
      void fetchSessions();
    }, 1e4);
    return () => window.clearInterval(timer);
  }, [hosts]);
  const addHost = async () => {
    if (!alias.trim()) return;
    try {
      const d = await json(API.hosts, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: alias.trim() })
      });
      if (d.host) {
        setAlias("");
        await refresh();
        setActive(d.host.id);
      } else {
        setError(d.error ?? "add failed");
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const toggleTunnel = async (h) => {
    const running = h.tunnel?.state === "running" || h.tunnel?.state === "starting";
    await json(API.tunnel, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: h.id, action: running ? "stop" : "start" })
    });
    await refresh();
  };
  const removeHost = async (h) => {
    if (!window.confirm(`\u5220\u9664\u8FDC\u7A0B\u4E3B\u673A ${h.name || h.alias}\uFF1F
\uFF08\u914D\u7F6E\u4FDD\u5B58\u5728 ~/.dsh/remote-hosts.json\uFF0C\u5220\u9664\u524D\u6709\u81EA\u52A8\u5907\u4EFD .bak\uFF0C\u53EF\u6062\u590D\uFF09`)) return;
    await json(`${API.host}?id=${encodeURIComponent(h.id)}`, { method: "DELETE" });
    if (active === h.id) setActive(null);
    await refresh();
  };
  const archiveSession2 = async (h, s) => {
    if (!window.confirm(`\u5F52\u6863\u8FDC\u7A0B\u4F1A\u8BDD\u300C${friendlyTitle(s)}\u300D\uFF1F
\uFF08\u53EF\u4ECE\u8FDC\u7A0B GUI \u7684\u5F52\u6863\u533A\u627E\u56DE\uFF09`)) return;
    try {
      const d = await json(API.archive, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: h.id, sessionId: s.sessionId })
      });
      if (d.ok) {
        setSessions((prev) => ({ ...prev, [h.id]: (prev[h.id] ?? []).filter((x) => x.sessionId !== s.sessionId) }));
      } else setError(d.error ?? "\u5F52\u6863\u5931\u8D25");
    } catch (e) {
      setError(String(e));
    }
  };
  const pushTask = async () => {
    const target = activeHost ?? hosts.find((h) => h.tunnel?.state === "running") ?? hosts[0];
    if (!target) {
      setTaskResult("\u274C \u6CA1\u6709\u53EF\u7528\u7684\u8FDC\u7A0B\u4E3B\u673A\uFF0C\u5148\u6DFB\u52A0\u4E3B\u673A");
      return;
    }
    if (!taskContent.trim()) return;
    try {
      const d = await json(API.task, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: target.id, content: taskContent.trim() })
      });
      if (d.sessionId) {
        setTaskResult(`\u2705 \u5DF2\u63A8\u9001\u5230 ${target.name || target.alias}\uFF08\u4F1A\u8BDD ${d.sessionId.slice(0, 12)}\u2026\uFF09\uFF0C\u4EFB\u52A1\u5728\u670D\u52A1\u5668\u6267\u884C\u4E2D`);
        setTaskContent("");
        setActive(target.id);
        setTimeout(() => setTaskResult(null), 8e3);
      } else {
        setTaskResult(`\u274C ${d.error ?? "\u63A8\u9001\u5931\u8D25"}`);
      }
    } catch (e) {
      setTaskResult(`\u274C ${String(e)}`);
    }
  };
  const activeHost = hosts.find((h) => h.id === active);
  const styles = {
    wrap: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
    header: { padding: "10px 12px", borderBottom: "1px solid var(--dsh-border, rgba(128,128,128,.2))", display: "flex", gap: 6 },
    input: { flex: 1, minWidth: 0, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,.35)", background: "transparent", color: "inherit" },
    addBtn: { padding: "5px 10px", borderRadius: 6, border: "none", background: "var(--dsh-accent, #4a7dff)", color: "#fff", cursor: "pointer" },
    list: { overflow: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 6 },
    card: { border: "1px solid rgba(128,128,128,.25)", borderRadius: 8, padding: "8px 10px", cursor: "pointer" },
    row: { display: "flex", alignItems: "center", gap: 8 },
    dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
    title: { fontWeight: 600, fontSize: 13 },
    meta: { fontSize: 11, opacity: 0.65, marginTop: 2 },
    actions: { display: "flex", gap: 6, marginTop: 6 },
    btn: { fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(128,128,128,.35)", background: "transparent", color: "inherit", cursor: "pointer" },
    frame: { flex: 1, border: 0, background: "#fff", minHeight: 0 },
    err: { color: "#e07171", fontSize: 12, padding: "0 12px 6px" },
    hint: { fontSize: 11, opacity: 0.55, padding: "0 12px 8px" }
  };
  return (0, import_react.createElement)(
    "div",
    { style: styles.wrap },
    (0, import_react.createElement)(
      "div",
      { style: styles.header },
      (0, import_react.createElement)("input", {
        style: styles.input,
        placeholder: "SSH \u522B\u540D\uFF08\u5982 my-server\uFF09",
        value: alias,
        onChange: (e) => setAlias(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") void addHost();
        }
      }),
      (0, import_react.createElement)("button", { style: styles.addBtn, onClick: () => void addHost() }, "\u6DFB\u52A0")
    ),
    (0, import_react.createElement)(
      "div",
      { style: { ...styles.header, borderBottom: "none", paddingTop: 6 } },
      (0, import_react.createElement)("input", {
        style: styles.input,
        placeholder: "\u65B0\u5EFA\u8FDC\u7A0B\u4EFB\u52A1\uFF1A\u628A\u4EFB\u52A1\u63CF\u8FF0\u63A8\u7ED9\u5728\u7EBF\u4E3B\u673A\uFF08\u957F\u4EFB\u52A1\u5728\u670D\u52A1\u5668\u8DD1\uFF09",
        value: taskContent,
        onChange: (e) => setTaskContent(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") void pushTask();
        }
      }),
      (0, import_react.createElement)("button", {
        style: { ...styles.addBtn, background: "var(--dsh-accent, #2f9e63)", flexShrink: 0 },
        onClick: () => void pushTask(),
        disabled: hosts.length === 0
      }, "\u63A8\u9001\u4EFB\u52A1")
    ),
    taskResult ? (0, import_react.createElement)("div", { style: { ...styles.hint, color: taskResult.startsWith("\u2705") ? "var(--dsw-alias-state-success-primary, #2f9e63)" : "#e07171" } }, taskResult) : null,
    error ? (0, import_react.createElement)("div", { style: styles.err }, error) : null,
    (0, import_react.createElement)("div", { style: styles.hint }, "\u4E3B\u673A\u6CE8\u518C\u5728 ~/.dsh/remote-hosts.json\uFF1B\u70B9\u51FB\u5361\u7247\u6253\u5F00\u8FDC\u7A0B GUI"),
    (0, import_react.createElement)(
      "div",
      { style: styles.list },
      hosts.map((h) => {
        const running = h.tunnel?.state === "running";
        const up = health[h.id]?.hostUp;
        const dotColor = running ? up ? "#3ecf6a" : "#e8b339" : "#9a9a9a";
        const isActive = active === h.id;
        const hostSessions = sessions[h.id] ?? [];
        const runningCount = hostSessions.filter((s) => s.running).length;
        return (0, import_react.createElement)(
          "div",
          { key: h.id, style: { ...styles.card, outline: isActive ? "1px solid var(--dsh-accent, #4a7dff)" : "none" } },
          (0, import_react.createElement)(
            "div",
            { style: styles.row },
            (0, import_react.createElement)("span", { style: { ...styles.dot, background: dotColor } }),
            (0, import_react.createElement)("span", { style: styles.title }, h.name || h.alias),
            (0, import_react.createElement)("span", { style: { fontSize: 11, opacity: 0.5 } }, h.alias)
          ),
          (0, import_react.createElement)(
            "div",
            { style: styles.meta },
            `\u8FDC\u7A0B :${h.port} \u2192 \u672C\u5730 :${h.localPort}`,
            h.tunnel?.state === "running" ? up ? " \xB7 \u5728\u7EBF" : ` \xB7 \u96A7\u9053\u901A\uFF08HTTP ${health[h.id]?.status ?? "\u2026"}\uFF09` : " \xB7 \u96A7\u9053\u672A\u5F00"
          ),
          running ? (0, import_react.createElement)(
            "div",
            { style: styles.meta },
            hostSessions.length > 0 ? `${hostSessions.length} \u4E2A\u8FDC\u7A0B\u4F1A\u8BDD \xB7 ${runningCount} \u8FD0\u884C\u4E2D` : "\u6B63\u5728\u8BFB\u53D6\u8FDC\u7A0B\u4F1A\u8BDD\u2026"
          ) : null,
          running && hostSessions.length > 0 ? (0, import_react.createElement)(
            "div",
            { style: { marginTop: 4, display: "flex", flexDirection: "column", gap: 3 } },
            hostSessions.slice(0, 4).map((s) => (0, import_react.createElement)(
              "div",
              { key: s.sessionId, style: styles.row },
              (0, import_react.createElement)("span", { style: { ...styles.dot, background: s.running ? "#3ecf6a" : "#9a9a9a" } }),
              (0, import_react.createElement)(
                "span",
                { style: { fontSize: 11, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                s.title ?? s.sessionId.slice(0, 12)
              )
            )),
            hostSessions.length > 4 ? (0, import_react.createElement)("div", { style: { fontSize: 10, opacity: 0.5 } }, `\u8FD8\u6709 ${hostSessions.length - 4} \u4E2A\u2026`) : null
          ) : null,
          (0, import_react.createElement)(
            "div",
            { style: styles.actions },
            (0, import_react.createElement)("button", { style: styles.btn, onClick: () => void toggleTunnel(h) }, running ? "\u65AD\u5F00" : "\u8FDE\u63A5"),
            (0, import_react.createElement)("button", { style: styles.btn, onClick: () => setActive(isActive ? null : h.id) }, isActive ? "\u6536\u8D77" : "\u6253\u5F00"),
            (0, import_react.createElement)("button", { style: styles.btn, onClick: () => void removeHost(h) }, "\u5220\u9664")
          )
        );
      }),
      hosts.length === 0 && !loading ? (0, import_react.createElement)("div", { style: { fontSize: 12, opacity: 0.55, padding: 8 } }, "\u8FD8\u6CA1\u6709\u8FDC\u7A0B\u4E3B\u673A\uFF0C\u8F93\u5165 SSH \u522B\u540D\u6DFB\u52A0") : null
    ),
    activeHost && activeHost.tunnel?.state === "running" ? (0, import_react.createElement)("iframe", {
      style: styles.frame,
      src: `http://127.0.0.1:${activeHost.tunnel.localPort}/`,
      title: `${activeHost.name} \u8FDC\u7A0B GUI`
    }) : null
  );
}
var NAV_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M2.5 8h11M8 1.8c1.8 1.9 1.8 10.5 0 12.4M8 1.8c-1.8 1.9-1.8 10.5 0 12.4"/></svg>';
var overlayState = null;
var syncEntryActive = null;
function toggleOverlay(open) {
  if (open && overlayState === null) {
    const el = document.createElement("div");
    el.dataset.dshRemoteHostsOverlay = "";
    el.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-base,#101014);display:flex;flex-direction:column";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid rgba(128,128,128,.22);font-weight:600";
    head.textContent = "\u8FDC\u7A0B\u4E3B\u673A";
    const close = document.createElement("button");
    close.textContent = "\u2715 \u5173\u95ED";
    close.style.cssText = "background:transparent;border:none;color:inherit;font-size:13px;cursor:pointer;padding:4px 10px;border-radius:6px";
    close.addEventListener("click", () => toggleOverlay(false));
    head.appendChild(close);
    const body = document.createElement("div");
    body.style.cssText = "flex:1;min-height:0;overflow:auto";
    el.appendChild(head);
    el.appendChild(body);
    document.body.appendChild(el);
    const root = (0, import_client.createRoot)(body);
    root.render((0, import_react.createElement)(RemoteHostsPanel));
    overlayState = { el, root };
  } else if (!open && overlayState !== null) {
    overlayState.root.unmount();
    overlayState.el.remove();
    overlayState = null;
  }
  if (syncEntryActive !== null) syncEntryActive();
}
function sidebarRoot() {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
  if (column === null) return void 0;
  return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild;
}
function newSessionButton(root) {
  const nested = root.querySelector('button[class*="newSession"]');
  if (nested !== null) return nested;
  for (const child of root.children) if (child.tagName === "BUTTON") return child;
  return void 0;
}
function mountSidebarEntry() {
  if (typeof document === "undefined") return () => {
  };
  if (document.querySelector("[data-dsh-sev-entry]") !== null) return () => {
  };
  const entry = document.createElement("button");
  entry.type = "button";
  entry.dataset.dshRemoteHostsEntry = "";
  entry.setAttribute("aria-label", "\u8FDC\u7A0B");
  entry.style.cssText = "width:100%;height:32px;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:13px;background:transparent;border:none;border-radius:8px;cursor:pointer;color:inherit";
  entry.innerHTML = `<span style="display:inline-flex;flex:none;justify-content:center;align-items:center">${NAV_ICON}</span><span>\u8FDC\u7A0B</span>`;
  entry.addEventListener("click", () => toggleOverlay(overlayState === null));
  let root;
  let placed = false;
  const placeEntry = () => {
    if (root !== void 0 && !root.isConnected) {
      root = void 0;
      placed = false;
    }
    if (placed && document.body.contains(entry)) return;
    root ??= sidebarRoot();
    if (root === void 0) return;
    const button = newSessionButton(root);
    if (button === void 0) return;
    if (entry.parentElement !== root) {
      const anchor = button.nextElementSibling;
      root.insertBefore(entry, anchor);
    }
    placed = true;
  };
  syncEntryActive = () => {
    if (overlayState !== null) entry.dataset.active = "true";
    else delete entry.dataset.active;
  };
  const tryPlace = () => {
    placeEntry();
  };
  const waitObserver = new MutationObserver(() => tryPlace());
  waitObserver.observe(document.body, { childList: true, subtree: true });
  tryPlace();
  syncEntryActive();
  return () => {
    waitObserver.disconnect();
    entry.remove();
    if (syncEntryActive !== null) syncEntryActive = null;
  };
}
function relTime(ts) {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 6e4);
  if (m < 1) return "\u521A\u521A";
  if (m < 60) return `${m}\u5206\u949F\u524D`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}\u5C0F\u65F6\u524D`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}\u5929\u524D`;
  return new Date(ts).toLocaleDateString();
}
function friendlyTitle(s) {
  if (s.title) return s.title;
  if (s.cwd) {
    const base = s.cwd.split("/").filter(Boolean).pop();
    if (base) return base;
  }
  return s.sessionId.slice(0, 8);
}
function RemoteSessionsSection(props) {
  const [hovered, setHovered] = (0, import_react.useState)(null);
  const items = props.hosts.filter((h) => (props.sessions[h.id] ?? []).length > 0);
  if (items.length === 0) return null;
  const total = items.reduce((n, h) => n + (props.sessions[h.id] ?? []).length, 0);
  const running = items.reduce((n, h) => n + (props.sessions[h.id] ?? []).filter((s) => s.running).length, 0);
  const sep = "var(--dsw-alias-separator-primary, rgba(0,0,0,.07))";
  const label = "var(--dsw-alias-label-primary, #131c26)";
  const muted = "var(--dsw-alias-label-tertiary, #8a93a6)";
  const hoverBg = "var(--dsw-specific-sidebar-nav-item-hover, rgba(0,0,0,.05))";
  return (0, import_react.createElement)(
    "div",
    { style: { padding: "8px 8px 6px", borderTop: `1px solid ${sep}` } },
    (0, import_react.createElement)(
      "div",
      {
        style: { display: "flex", alignItems: "center", gap: 6, padding: "3px 6px 6px", borderRadius: 7, cursor: "pointer" },
        onClick: props.onOpen,
        title: "\u6253\u5F00\u8FDC\u7A0B\u4E3B\u673A\u9762\u677F"
      },
      (0, import_react.createElement)("span", { style: { fontSize: 13, fontWeight: 600, color: label } }, "\u8FDC\u7A0B\u4F1A\u8BDD"),
      (0, import_react.createElement)(
        "span",
        { style: { fontSize: 11, color: muted, background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))", borderRadius: 999, padding: "1px 7px" } },
        `${running > 0 ? `\u25CF ${running} \xB7 ` : ""}${total}`
      ),
      (0, import_react.createElement)("span", { style: { marginLeft: "auto", fontSize: 11, color: muted } }, "\u203A")
    ),
    items.map((h) => {
      const list = [...props.sessions[h.id] ?? []].sort((a, b) => Number(b.running) - Number(a.running) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return (0, import_react.createElement)(
        "div",
        { key: h.id },
        (0, import_react.createElement)("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #5d7696)", padding: "2px 8px 3px" } }, `\u{1F310} ${h.name || h.alias}`),
        list.slice(0, 8).map(
          (s) => (0, import_react.createElement)(
            "div",
            {
              key: s.sessionId,
              style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 7, cursor: "pointer", fontSize: 14, color: label, background: hovered === s.sessionId ? hoverBg : void 0 },
              onClick: props.onOpen,
              onMouseEnter: () => setHovered(s.sessionId),
              onMouseLeave: () => setHovered(null),
              title: `${friendlyTitle(s)} \xB7 ${s.running ? "\u8FD0\u884C\u4E2D" : relTime(s.updatedAt)}`
            },
            (0, import_react.createElement)("span", { style: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: s.running ? "#3ecf6a" : muted } }),
            (0, import_react.createElement)("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, friendlyTitle(s)),
            (0, import_react.createElement)("span", { style: { fontSize: 12, fontWeight: 500, color: "#5d7696", flexShrink: 0 } }, s.running ? "\u8FD0\u884C\u4E2D" : relTime(s.updatedAt)),
            (0, import_react.createElement)("button", {
              style: { border: "none", background: "transparent", color: "#e07171", cursor: "pointer", fontSize: 12, padding: "0 2px", flexShrink: 0 },
              title: "\u5F52\u6863\u6B64\u4F1A\u8BDD",
              onClick: (e) => {
                e.stopPropagation();
                void archiveSession(h, s);
              }
            }, "\u{1F5D1}")
          )
        )
      );
    })
  );
}
function mountRemoteSessionsSection() {
  if (typeof document === "undefined") return () => {
  };
  const host = document.createElement("div");
  host.dataset.dshRemoteHostsSessions = "";
  host.style.cssText = "min-width:0";
  const root = (0, import_client.createRoot)(host);
  const place = () => {
    const region = document.querySelector('[class*="regionArea"]');
    if (region === null) return false;
    if (host.parentElement !== region) region.insertBefore(host, region.firstChild);
    return true;
  };
  const poll = async () => {
    try {
      const h = await (await fetch(API.hosts)).json();
      const s = {};
      for (const he of h.hosts ?? []) {
        if (he.tunnel?.state !== "running") continue;
        try {
          const d = await (await fetch(`${API.sessions}?id=${encodeURIComponent(he.id)}`)).json();
          if (Array.isArray(d.sessions)) s[he.id] = d.sessions;
        } catch {
        }
      }
      root.render((0, import_react.createElement)(RemoteSessionsSection, {
        hosts: h.hosts ?? [],
        sessions: s,
        onOpen: () => toggleOverlay(true)
      }));
    } catch {
    }
  };
  const timer = window.setInterval(() => {
    void poll();
  }, 1e4);
  void poll();
  const obs = new MutationObserver(() => {
    place();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  place();
  return () => {
    window.clearInterval(timer);
    obs.disconnect();
    root.unmount();
    host.remove();
  };
}
function apply(ctx) {
  const fail = (phase, error) => {
    console.error(`[dsh-sev] ${phase} error:`, error);
  };
  try {
    ctx.effect(() => mountSidebarEntry(), "dsh-sev: sidebar entry");
    ctx.effect(() => mountRemoteSessionsSection(), "dsh-sev: sidebar sessions");
    ctx.effect(() => {
      const svc = ctx.betterSidebar;
      if (!svc || typeof svc.registerTab !== "function") return void 0;
      try {
        return svc.registerTab({
          id: "remote-hosts",
          title: () => "\u8FDC\u7A0B",
          order: 90,
          single: true,
          component: () => (0, import_react.createElement)(RemoteHostsPanel)
        });
      } catch (error) {
        fail("registerTab", error);
        return void 0;
      }
    }, "dsh-sev: register tab");
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "remote-hosts",
      order: 100,
      label: () => "\u8FDC\u7A0B\u4E3B\u673A",
      inject: () => ({})
    }, RemoteHostsPanel));
  } catch (error) {
    fail("load", error);
  }
}
return module.exports; } });

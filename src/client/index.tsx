/**
 * dsh-sev — Browser half.
 *
 * Registers a "远程" tab into dsh-better-sidebar when that plugin is present
 * (falling back to a Settings section), rendering the remote-host panel:
 * host list (registry from the Node half), tunnel start/stop, health probe,
 * and an iframe view onto the remote dsh GUI once the tunnel is up.
 */
import { createElement, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'

export const inject = ['slots', 'connection', 'locale', 'betterSidebar']

const API = {
  hosts: '/api/dsh-sev/hosts',
  host: '/api/dsh-sev/host',
  tunnel: '/api/dsh-sev/tunnel',
  health: '/api/dsh-sev/health',
  sessions: '/api/dsh-sev/sessions',
  task: '/api/dsh-sev/task',
  archive: '/api/dsh-sev/session-archive',
}

type RemoteSession = {
  sessionId: string
  title: string | null
  running: boolean
  blank: boolean
  updatedAt: number | null
  cwd: string | null
  turns: number | null
}

type RemoteHost = {
  id: string
  alias: string
  name: string
  port: number
  localPort: number
  autoTunnel?: boolean
  tunnel?: { localPort: number; remotePort: number; state: string; exitCode?: number | null } | null
  hostUp?: boolean
  status?: number | string | null
}

async function json(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, init)
  return r.json()
}

// ── panel component ─────────────────────────────────────────────────────────
function RemoteHostsPanel(): ReactNode {
  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [alias, setAlias] = useState('')
  const [taskContent, setTaskContent] = useState('')
  const [taskResult, setTaskResult] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [health, setHealth] = useState<Record<string, { hostUp: boolean; status?: number | string | null }>>({})
  const [sessions, setSessions] = useState<Record<string, RemoteSession[]>>({})

  const refresh = useCallback(async () => {
    try {
      const data = await json(API.hosts)
      setHosts(data.hosts ?? [])
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 10000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const timer = window.setInterval(async () => {
      for (const h of hosts) {
        if (h.tunnel?.state !== 'running') continue
        try {
          const d = await json(`${API.health}?id=${encodeURIComponent(h.id)}`)
          setHealth((prev) => ({ ...prev, [h.id]: { hostUp: d.hostUp, status: d.status } }))
        } catch { /* probe failed; keep last */ }
      }
    }, 5000)
    return () => window.clearInterval(timer)
  }, [hosts])

  // M2: poll remote session summaries for hosts with live tunnels.
  useEffect(() => {
    const fetchSessions = async () => {
      for (const h of hosts) {
        if (h.tunnel?.state !== 'running') continue
        try {
          const d = await json(`${API.sessions}?id=${encodeURIComponent(h.id)}`)
          if (Array.isArray(d.sessions)) {
            setSessions((prev) => ({ ...prev, [h.id]: d.sessions }))
          }
        } catch { /* keep last */ }
      }
    }
    void fetchSessions()
    const timer = window.setInterval(() => { void fetchSessions() }, 10000)
    return () => window.clearInterval(timer)
  }, [hosts])

  const addHost = async () => {
    if (!alias.trim()) return
    try {
      const d = await json(API.hosts, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: alias.trim() }),
      })
      if (d.host) {
        setAlias('')
        await refresh()
        setActive(d.host.id)
      } else {
        setError(d.error ?? 'add failed')
      }
    } catch (e) { setError(String(e)) }
  }

  const toggleTunnel = async (h: RemoteHost) => {
    const running = h.tunnel?.state === 'running' || h.tunnel?.state === 'starting'
    await json(API.tunnel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: h.id, action: running ? 'stop' : 'start' }),
    })
    await refresh()
  }

  const removeHost = async (h: RemoteHost) => {
    if (!window.confirm(`删除远程主机 ${h.name || h.alias}？\n（配置保存在 ~/.dsh/remote-hosts.json，删除前有自动备份 .bak，可恢复）`)) return
    await json(`${API.host}?id=${encodeURIComponent(h.id)}`, { method: 'DELETE' })
    if (active === h.id) setActive(null)
    await refresh()
  }

  // Archive (delete from the active list) a remote session.
  const archiveSession = async (h: RemoteHost, s: RemoteSession) => {
    if (await archiveRemoteSession(h, s)) {
      setSessions((prev) => ({ ...prev, [h.id]: (prev[h.id] ?? []).filter((x) => x.sessionId !== s.sessionId) }))
    }
  }

  // M3: push a long task to an online host (creates a persistent remote session).
  const pushTask = async () => {
    const target = activeHost ?? hosts.find((h) => h.tunnel?.state === 'running') ?? hosts[0]
    if (!target) { setTaskResult('❌ 没有可用的远程主机，先添加主机'); return }
    if (!taskContent.trim()) return
    try {
      const d = await json(API.task, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: target.id, content: taskContent.trim() }),
      })
      if (d.sessionId) {
        setTaskResult(`✅ 已推送到 ${target.name || target.alias}（会话 ${d.sessionId.slice(0, 12)}…），任务在服务器执行中`)
        setTaskContent('')
        setActive(target.id)
        setTimeout(() => setTaskResult(null), 8000)
      } else {
        setTaskResult(`❌ ${d.error ?? '推送失败'}`)
      }
    } catch (e) {
      setTaskResult(`❌ ${String(e)}`)
    }
  }

  const activeHost = hosts.find((h) => h.id === active)

  const styles = {
    wrap: { display: 'flex', flexDirection: 'column' as const, height: '100%', minHeight: 0 },
    header: { padding: '10px 12px', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,.2))', display: 'flex', gap: 6 },
    input: { flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit' },
    addBtn: { padding: '5px 10px', borderRadius: 6, border: 'none', background: 'var(--dsh-accent, #4a7dff)', color: '#fff', cursor: 'pointer' },
    list: { overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column' as const, gap: 6 },
    card: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, padding: '8px 10px', cursor: 'pointer' },
    row: { display: 'flex', alignItems: 'center', gap: 8 },
    dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
    title: { fontWeight: 600, fontSize: 13 },
    meta: { fontSize: 11, opacity: .65, marginTop: 2 },
    actions: { display: 'flex', gap: 6, marginTop: 6 },
    btn: { fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
    frame: { flex: 1, border: 0, background: '#fff', minHeight: 0 },
    err: { color: '#e07171', fontSize: 12, padding: '0 12px 6px' },
    hint: { fontSize: 11, opacity: .55, padding: '0 12px 8px' },
  }

  return createElement('div', { style: styles.wrap },
    createElement('div', { style: styles.header },
      createElement('input', {
        style: styles.input,
        placeholder: 'SSH 别名（如 my-server）',
        value: alias,
        onChange: (e: any) => setAlias(e.target.value),
        onKeyDown: (e: any) => { if (e.key === 'Enter') void addHost() },
      }),
      createElement('button', { style: styles.addBtn, onClick: () => void addHost() }, '添加'),
    ),
    createElement('div', { style: { ...styles.header, borderBottom: 'none', paddingTop: 6 } },
      createElement('input', {
        style: styles.input,
        placeholder: '新建远程任务：把任务描述推给在线主机（长任务在服务器跑）',
        value: taskContent,
        onChange: (e: any) => setTaskContent(e.target.value),
        onKeyDown: (e: any) => { if (e.key === 'Enter') void pushTask() },
      }),
      createElement('button', {
        style: { ...styles.addBtn, background: 'var(--dsh-accent, #2f9e63)', flexShrink: 0 },
        onClick: () => void pushTask(),
        disabled: hosts.length === 0,
      }, '推送任务'),
    ),
    taskResult ? createElement('div', { style: { ...styles.hint, color: taskResult.startsWith('✅') ? 'var(--dsw-alias-state-success-primary, #2f9e63)' : '#e07171' } }, taskResult) : null,
    error ? createElement('div', { style: styles.err }, error) : null,
    createElement('div', { style: styles.hint }, '主机注册在 ~/.dsh/remote-hosts.json；点击卡片打开远程 GUI'),
    createElement('div', { style: styles.list },
      hosts.map((h) => {
        const running = h.tunnel?.state === 'running'
        const up = health[h.id]?.hostUp
        const dotColor = running ? (up ? '#3ecf6a' : '#e8b339') : '#9a9a9a'
        const isActive = active === h.id
        const hostSessions = sessions[h.id] ?? []
        const runningCount = hostSessions.filter((s) => s.running).length
        return createElement('div', { key: h.id, style: { ...styles.card, outline: isActive ? '1px solid var(--dsh-accent, #4a7dff)' : 'none' } },
          createElement('div', { style: styles.row },
            createElement('span', { style: { ...styles.dot, background: dotColor } }),
            createElement('span', { style: styles.title }, h.name || h.alias),
            createElement('span', { style: { fontSize: 11, opacity: .5 } }, h.alias),
          ),
          createElement('div', { style: styles.meta },
            `远程 :${h.port} → 本地 :${h.localPort}`,
            h.tunnel?.state === 'running'
              ? (up ? ' · 在线' : ` · 隧道通（HTTP ${health[h.id]?.status ?? '…'}）`)
              : ' · 隧道未开',
          ),
          running
            ? createElement('div', { style: styles.meta },
                hostSessions.length > 0
                  ? `${hostSessions.length} 个远程会话 · ${runningCount} 运行中`
                  : '正在读取远程会话…',
              )
            : null,
          running && hostSessions.length > 0
            ? createElement('div', { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 } },
                hostSessions.slice(0, 4).map((s) => createElement('div', { key: s.sessionId, style: { ...styles.row, cursor: 'default' } },
                  createElement('span', { style: { ...styles.dot, background: s.running ? '#3ecf6a' : '#9a9a9a' } }),
                  createElement('span', { style: { flex: 1, fontSize: 11, opacity: .8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    friendlyTitle(s),
                  ),
                  createElement('button', {
                    style: { border: 'none', background: 'transparent', color: '#e07171', cursor: 'pointer', fontSize: 12, padding: '0 2px', flexShrink: 0 },
                    title: '归档此会话',
                    onClick: (e: any) => { e.stopPropagation(); void archiveSession(h, s) },
                  }, '🗑'),
                )),
                hostSessions.length > 4
                  ? createElement('div', { style: { fontSize: 10, opacity: .5 } }, `还有 ${hostSessions.length - 4} 个…`)
                  : null,
              )
            : null,
          createElement('div', { style: styles.actions },
            createElement('button', { style: styles.btn, onClick: () => void toggleTunnel(h) }, running ? '断开' : '连接'),
            createElement('button', { style: styles.btn, onClick: () => setActive(isActive ? null : h.id) }, isActive ? '收起' : '打开'),
            createElement('button', { style: styles.btn, onClick: () => void removeHost(h) }, '删除'),
          ),
        )
      }),
      hosts.length === 0 && !loading
        ? createElement('div', { style: { fontSize: 12, opacity: .55, padding: 8 } }, '还没有远程主机，输入 SSH 别名添加')
        : null,
    ),
    activeHost && activeHost.tunnel?.state === 'running'
      ? createElement('iframe', {
          style: styles.frame,
          src: `http://127.0.0.1:${activeHost.tunnel.localPort}/`,
          title: `${activeHost.name} 远程 GUI`,
        })
      : null,
  )
}

// ── left-sidebar nav entry (task-board style DOM injection) ────────────────
// Independent of dsh-better-sidebar: mounts a visible "远程" button in the
// left sidebar that toggles the panel as a full-area overlay, so the feature
// is discoverable even when the side card is closed.
import { createRoot, type Root } from 'react-dom/client'

const NAV_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M2.5 8h11M8 1.8c1.8 1.9 1.8 10.5 0 12.4M8 1.8c-1.8 1.9-1.8 10.5 0 12.4"/></svg>'

let overlayState: { el: HTMLDivElement; root: Root } | null = null
let syncEntryActive: (() => void) | null = null

function toggleOverlay(open: boolean): void {
  if (open && overlayState === null) {
    const el = document.createElement('div')
    el.dataset.dshRemoteHostsOverlay = ''
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-base,#101014);display:flex;flex-direction:column'
    const head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid rgba(128,128,128,.22);font-weight:600'
    head.textContent = '远程主机'
    const close = document.createElement('button')
    close.textContent = '✕ 关闭'
    close.style.cssText = 'background:transparent;border:none;color:inherit;font-size:13px;cursor:pointer;padding:4px 10px;border-radius:6px'
    close.addEventListener('click', () => toggleOverlay(false))
    head.appendChild(close)
    const body = document.createElement('div')
    body.style.cssText = 'flex:1;min-height:0;overflow:auto'
    el.appendChild(head)
    el.appendChild(body)
    document.body.appendChild(el)
    const root = createRoot(body)
    root.render(createElement(RemoteHostsPanel))
    overlayState = { el, root }
  } else if (!open && overlayState !== null) {
    overlayState.root.unmount()
    overlayState.el.remove()
    overlayState = null
  }
  if (syncEntryActive !== null) syncEntryActive()
}

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  return (column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild) as HTMLElement | undefined
}

function newSessionButton(root: HTMLElement): HTMLElement | undefined {
  const nested = root.querySelector('button[class*="newSession"]')
  if (nested !== null) return nested as HTMLElement
  for (const child of root.children) if (child.tagName === 'BUTTON') return child as HTMLElement
  return undefined
}

function mountSidebarEntry(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector('[data-dsh-sev-entry]') !== null) return () => {}
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshRemoteHostsEntry = ''
  entry.setAttribute('aria-label', '远程')
  entry.style.cssText = 'width:100%;height:32px;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:13px;background:transparent;border:none;border-radius:8px;cursor:pointer;color:inherit'
  entry.innerHTML = `<span style="display:inline-flex;flex:none;justify-content:center;align-items:center">${NAV_ICON}</span><span>远程</span>`
  entry.addEventListener('click', () => toggleOverlay(overlayState === null))

  let root: HTMLElement | undefined
  let placed = false
  const placeEntry = (): void => {
    if (root !== undefined && !root.isConnected) { root = undefined; placed = false }
    if (placed && document.body.contains(entry)) return
    root ??= sidebarRoot()
    if (root === undefined) return
    const button = newSessionButton(root)
    if (button === undefined) return
    if (entry.parentElement !== root) {
      const anchor = button.nextElementSibling
      root.insertBefore(entry, anchor)
    }
    placed = true
  }
  syncEntryActive = () => {
    if (overlayState !== null) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const tryPlace = (): void => { placeEntry() }
  const waitObserver = new MutationObserver(() => tryPlace())
  waitObserver.observe(document.body, { childList: true, subtree: true })
  tryPlace()
  syncEntryActive()
  return () => {
    waitObserver.disconnect()
    entry.remove()
    if (syncEntryActive !== null) syncEntryActive = null
  }
}

// ── left-sidebar mixed list: remote sessions shown like local tasks ────────
// Injects a "远程" group into the sidebar's region area (above the workspace
// tree) listing each online host's remote sessions (title + running dot).
// Clicking a row opens the panel (iframe on the remote GUI). Polls the Node
// half's /api on the same cadence as the panel.
function relTime(ts: number | null): string {
  if (!ts) return ''
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}天前`
  return new Date(ts).toLocaleDateString()
}

function friendlyTitle(s: RemoteSession): string {
  if (s.title) return s.title
  if (s.cwd) {
    const base = s.cwd.split('/').filter(Boolean).pop()
    if (base) return base
  }
  return s.sessionId.slice(0, 8)
}

/** Module-level archive helper shared by the panel and the left mixed list.
 *  Confirms, calls the archive route, and notifies listeners so every view
 *  (panel + mixed list) drops the session immediately. */
async function archiveRemoteSession(h: { id: string; name?: string; alias?: string }, s: RemoteSession): Promise<boolean> {
  if (!window.confirm(`归档远程会话「${friendlyTitle(s)}」？\n（可从远程 GUI 的归档区找回）`)) return false
  try {
    const d = await json(API.archive, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: h.id, sessionId: s.sessionId }),
    })
    if (d.ok) {
      window.dispatchEvent(new CustomEvent('dsh-sev:sessions-changed', { detail: { hostId: h.id, sessionId: s.sessionId } }))
      return true
    }
    console.error('[dsh-sev] archive failed:', d.error)
    return false
  } catch (e) {
    console.error('[dsh-sev] archive error:', e)
    return false
  }
}

// Inline styles only — DSH's CSP blocks runtime-injected <style> tags, so any
// styling must ride on React style props (verified in a live GUI).
function RemoteSessionsSection(props: {
  hosts: Array<{ id: string; name?: string; alias?: string }>
  sessions: Record<string, RemoteSession[]>
  onOpen: () => void
}): ReactNode {
  const [hovered, setHovered] = useState<string | null>(null)
  const items = props.hosts.filter((h) => (props.sessions[h.id] ?? []).length > 0)
  if (items.length === 0) return null
  const total = items.reduce((n, h) => n + (props.sessions[h.id] ?? []).length, 0)
  const running = items.reduce((n, h) => n + (props.sessions[h.id] ?? []).filter((s) => s.running).length, 0)
  const sep = 'var(--dsw-alias-separator-primary, rgba(0,0,0,.07))'
  const label = 'var(--dsw-alias-label-primary, #131c26)'
  const muted = 'var(--dsw-alias-label-tertiary, #8a93a6)'
  const hoverBg = 'var(--dsw-specific-sidebar-nav-item-hover, rgba(0,0,0,.05))'
  return createElement('div', { style: { padding: '8px 8px 6px', borderTop: `1px solid ${sep}` } },
    createElement('div', {
      style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px 6px', borderRadius: 7, cursor: 'pointer' },
      onClick: props.onOpen,
      title: '打开远程主机面板',
    },
      createElement('span', { style: { fontSize: 13, fontWeight: 600, color: label } }, '远程会话'),
      createElement('span', { style: { fontSize: 11, color: muted, background: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))', borderRadius: 999, padding: '1px 7px' } },
        `${running > 0 ? `● ${running} · ` : ''}${total}`),
      createElement('span', { style: { marginLeft: 'auto', fontSize: 11, color: muted } }, '›'),
    ),
    items.map((h) => {
      const list = [...(props.sessions[h.id] ?? [])].sort((a, b) => (Number(b.running) - Number(a.running)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)))
      return createElement('div', { key: h.id },
        createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5d7696)', padding: '2px 8px 3px' } }, `🌐 ${h.name || h.alias}`),
        list.slice(0, 8).map((s) =>
          createElement('div', {
            key: s.sessionId,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7, cursor: 'pointer', fontSize: 14, color: label, background: hovered === s.sessionId ? hoverBg : undefined },
            onClick: props.onOpen,
            onMouseEnter: () => setHovered(s.sessionId),
            onMouseLeave: () => setHovered(null),
            title: `${friendlyTitle(s)} · ${s.running ? '运行中' : relTime(s.updatedAt)}`,
          },
            createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: s.running ? '#3ecf6a' : muted } }),
            createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, friendlyTitle(s)),
            createElement('span', { style: { fontSize: 12, fontWeight: 500, color: '#5d7696', flexShrink: 0 } }, s.running ? '运行中' : relTime(s.updatedAt)),
            createElement('button', {
              style: { border: 'none', background: 'transparent', color: '#e07171', cursor: 'pointer', fontSize: 12, padding: '0 2px', flexShrink: 0 },
              title: '归档此会话',
              onClick: (e: any) => { e.stopPropagation(); void archiveRemoteSession(h, s) },
            }, '🗑'),
          ),
        ),
      )
    }),
  )
}

function mountRemoteSessionsSection(): () => void {
  if (typeof document === 'undefined') return () => {}
  const host = document.createElement('div')
  host.dataset.dshRemoteHostsSessions = ''
  host.style.cssText = 'min-width:0'
  const root = createRoot(host)
  const place = (): boolean => {
    const region = document.querySelector('[class*="regionArea"]')
    if (region === null) return false
    if (host.parentElement !== region) region.insertBefore(host, region.firstChild)
    return true
  }
  const poll = async (): Promise<void> => {
    try {
      const h = await (await fetch(API.hosts)).json()
      const s: Record<string, RemoteSession[]> = {}
      for (const he of h.hosts ?? []) {
        if (he.tunnel?.state !== 'running') continue
        try {
          const d = await (await fetch(`${API.sessions}?id=${encodeURIComponent(he.id)}`)).json()
          if (Array.isArray(d.sessions)) s[he.id] = d.sessions
        } catch { /* keep last */ }
      }
      root.render(createElement(RemoteSessionsSection, {
        hosts: h.hosts ?? [],
        sessions: s,
        onOpen: () => toggleOverlay(true),
      }))
    } catch { /* host API unreachable */ }
  }
  const timer = window.setInterval(() => { void poll() }, 10000)
  void poll()
  const onChanged = () => { void poll() }
  window.addEventListener('dsh-sev:sessions-changed', onChanged)
  const obs = new MutationObserver(() => { place() })
  obs.observe(document.body, { childList: true, subtree: true })
  place()
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('dsh-sev:sessions-changed', onChanged)
    obs.disconnect()
    root.unmount()
    host.remove()
  }
}

// ── plugin entry ────────────────────────────────────────────────────────────
export function apply(ctx: any): void {
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-sev] ${phase} error:`, error)
  }
  try {
    // Visible left-sidebar nav entry (independent of better-sidebar).
    ctx.effect(() => mountSidebarEntry(), 'dsh-sev: sidebar entry')

    // Remote sessions mixed into the left-sidebar list (Codex-style).
    ctx.effect(() => mountRemoteSessionsSection(), 'dsh-sev: sidebar sessions')

    // Register a tab into dsh-better-sidebar when available.
    ctx.effect(() => {
      const svc = ctx.betterSidebar
      if (!svc || typeof svc.registerTab !== 'function') return undefined
      try {
        return svc.registerTab({
          id: 'remote-hosts',
          title: () => '远程',
          order: 90,
          single: true,
          component: () => createElement(RemoteHostsPanel),
        })
      } catch (error) {
        fail('registerTab', error)
        return undefined
      }
    }, 'dsh-sev: register tab')

    // Settings section fallback / host management entry.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'remote-hosts',
      order: 100,
      label: () => '远程主机',
      inject: () => ({}),
    }, RemoteHostsPanel))
  } catch (error) {
    fail('load', error)
  }
}

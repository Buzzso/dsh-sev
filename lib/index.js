/**
 * dsh-sev — Node half.
 *
 * Runs inside the local DSH host process. Owns:
 *  - the remote-host registry (~/.dsh/remote-hosts.json under DSH_HOME)
 *  - SSH tunnel lifecycle (spawn `ssh -L` children against ~/.ssh/config aliases)
 *  - the /api/dsh-sev route family (loopback-only fence, mirroring dsh-ssh)
 *  - a thin proxy onto a remote host's /api (M2: session listing etc.)
 *
 * The browser half (lib/client.js) renders the "远程" sidebar panel.
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PLUGIN_ID = 'dsh-sev'

const API = {
  hosts: '/api/dsh-sev/hosts',
  host: '/api/dsh-sev/host',
  tunnel: '/api/dsh-sev/tunnel',
  health: '/api/dsh-sev/health',
  proxy: '/api/dsh-sev/proxy',
  sessions: '/api/dsh-sev/sessions',
  task: '/api/dsh-sev/task',
  archive: '/api/dsh-sev/session-archive',
}

const DEFAULT_REMOTE_PORT = 3080 // dsh web default port
const DEFAULT_LOCAL_PORT = 5636 // + host index → 56361/56362/…
const MAX_JSON_BODY_BYTES = 64 * 1024
const GUIDANCE =
  '本机已安装 dsh-sev 插件（远程 DSH 主机管理）：侧边栏「远程」面板；管理用户自己服务器上的 DSH 分身——注册 SSH 别名（如 my-server）、启停 SSH 隧道、面板内操作远程实例的 GUI、左侧列表混排远程会话。能力：主机注册表存 ~/.dsh/remote-hosts.json；隧道=ssh -L <本地端口>:127.0.0.1:<远程 dsh 端口> <别名>；远程 dsh 默认端口 3080；隧道掉线自动重连（看门狗）；agent 工具 sev_run_task 可经 ssh + `dsh --profile headless` 在远程服务器上跑一次性任务（远程 DSH_HOME 默认 ~/.dsh-headless，可用主机配置 headlessHome 覆盖）。限制：需要 ~/.ssh/config 里已配置目标别名；远程实例需已部署 dsh host（headless `dsh --profile web`）；隧道依赖本机 ssh。用户提到「远程分身 / 远程 dsh / 服务器上跑 dsh / 远程主机 / 在服务器上跑个任务」时即指本插件，请据此协作。'

// ── loopback fence (mirrors dsh-ssh) ────────────────────────────────────────
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === void 0) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return void 0
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : void 0
  } catch { return void 0 }
}

function queryParam(url, name) {
  const value = url.searchParams.get(name)
  return value === null ? void 0 : value
}

// ── registry ────────────────────────────────────────────────────────────────
class Registry {
  constructor(file) {
    this.file = file
    this.hosts = this.load()
  }
  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(raw.hosts) ? raw.hosts : []
    } catch { return [] }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    // Rolling backup so an accidental deletion stays recoverable.
    try {
      const existing = readFileSync(this.file, 'utf8')
      if (existing.length > 0) writeFileSync(`${this.file}.bak`, existing)
    } catch { /* no previous file */ }
    writeFileSync(this.file, JSON.stringify({ hosts: this.hosts }, null, 2))
  }
  find(id) { return this.hosts.find((h) => h.id === id) }
  upsert(host) {
    const i = this.hosts.findIndex((h) => h.id === host.id)
    if (i >= 0) this.hosts[i] = host
    else this.hosts.push(host)
    this.save()
    return host
  }
  remove(id) {
    const before = this.hosts.length
    this.hosts = this.hosts.filter((h) => h.id !== id)
    if (this.hosts.length !== before) this.save()
  }
}

// ── tunnels ─────────────────────────────────────────────────────────────────
/** id -> { proc, localPort, remotePort, alias, state } */
const tunnels = new Map()

function startTunnel(host, localPort) {
  const existing = tunnels.get(host.id)
  if (existing && existing.state === 'running' && (existing.proc === null || existing.proc.exitCode === null)) {
    return existing
  }
  const remotePort = host.port || DEFAULT_REMOTE_PORT
  const proc = spawn('ssh', [
    '-L', `${localPort}:127.0.0.1:${remotePort}`,
    host.alias,
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const record = { proc, localPort, remotePort, alias: host.alias, state: 'starting', startedAt: Date.now() }
  tunnels.set(host.id, record)
  // Readiness is detected by probing the local forward port (ssh -N prints no
  // reliable stderr marker), not by parsing log lines. Probe repeatedly: the
  // tunnel can take >1s to establish over ZeroTier, and a one-shot probe
  // misses it.
  const probe = () => {
    if (record.state !== 'starting') return
    const sock = connect({ port: localPort, host: '127.0.0.1' })
    sock.setTimeout(600)
    sock.once('connect', () => { sock.destroy(); clearTimeout(record.probeTimer); record.state = 'running' })
    sock.once('error', () => sock.destroy())
    sock.once('timeout', () => sock.destroy())
  }
  probe()
  record.probeTimer = setInterval(probe, 400)
  record.probeLimit = setTimeout(() => { clearInterval(record.probeTimer) }, 12000)
  proc.on('exit', (code) => {
    clearInterval(record.probeTimer)
    clearTimeout(record.probeLimit)
    record.state = 'exited'
    record.exitCode = code
    record.exitedAt = Date.now()
  })
  return record
}

// ── tunnel watchdog (auto-reconnect) ────────────────────────────────────────
/** Hosts that want a tunnel right now (autoTunnel hosts + manual starts). */
const desired = new Map()

/** Pure decision helper (exported for tests). */
export function shouldRestartFor(desiredOn, record, now = Date.now()) {
  if (!desiredOn) return false
  if (!record) return true
  if (record.state === 'running') return false
  if (record.state === 'starting') return now - (record.startedAt ?? now) >= 10000
  // exited: cooldown so a flapping ssh does not hammer spawn
  return now - (record.exitedAt ?? 0) >= 5000
}

export function shouldRestart(id, record, now = Date.now()) {
  return shouldRestartFor(desired.get(id) === true, record, now)
}

/** One sweep pass: (re)start tunnels for hosts that want them. */
export function sweepOnce(registry) {
  const now = Date.now()
  for (const id of [...desired.keys()]) {
    if (!desired.get(id)) continue
    const host = registry.find(id)
    if (!host) continue
    if (!shouldRestartFor(true, tunnels.get(id), now)) continue
    startTunnel(host, host.localPort || DEFAULT_LOCAL_PORT)
  }
}

function stopTunnel(id) {
  const record = tunnels.get(id)
  if (!record) return false
  try { if (record.proc) record.proc.kill('SIGTERM') } catch { /* already dead */ }
  tunnels.delete(id)
  return true
}

/**
 * Resume a host's tunnel after a host restart: if the local forward port is
 * already serving (an orphaned ssh from before the restart), adopt it instead
 * of spawning a second ssh (which would fail to bind the port).
 */
function resumeTunnel(host) {
  const localPort = host.localPort || DEFAULT_LOCAL_PORT
  const existing = tunnels.get(host.id)
  if (existing && existing.state === 'running' && (existing.proc === null || existing.proc.exitCode === null)) return existing
  return new Promise((resolve) => {
    const sock = connect({ port: localPort, host: '127.0.0.1' })
    sock.setTimeout(1200)
    sock.once('connect', () => {
      sock.destroy()
      const record = { proc: null, localPort, remotePort: host.port || DEFAULT_REMOTE_PORT, alias: host.alias, state: 'running', adopted: true }
      tunnels.set(host.id, record)
      resolve(record)
    })
    sock.once('error', () => {
      sock.destroy()
      resolve(startTunnel(host, localPort))
    })
    sock.once('timeout', () => {
      sock.destroy()
      resolve(startTunnel(host, localPort))
    })
  })
}

function tunnelStatus(id) {
  const t = tunnels.get(id)
  if (!t) return null
  let state
  if (t.proc === null) {
    // Adopted tunnel (resumed from a pre-restart ssh): trust the record state.
    state = t.state === 'running' ? 'running' : t.state
  } else if (t.proc.exitCode === null) {
    state = t.state === 'running' ? 'running' : 'starting'
  } else {
    state = 'exited'
  }
  return {
    localPort: t.localPort,
    remotePort: t.remotePort,
    alias: t.alias,
    state,
    exitCode: t.exitCode ?? null,
  }
}

/** Upgrade a tunnel record to 'running' when a live probe succeeds. */
function markTunnelRunning(id) {
  const t = tunnels.get(id)
  if (t && t.state === 'starting') t.state = 'running'
}

// ── routes ──────────────────────────────────────────────────────────────────
function makeRoutes({ registry, allocatePort, getTunnel = tunnelStatus, markRunning = markTunnelRunning }) {
  const withFence = (handler) => (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback only' })
    return handler(req, res)
  }

  return [
    {
      path: API.hosts,
      handler: withFence(async (req, res) => {
        if (req.method === 'GET') {
          const hosts = registry.hosts.map((h) => ({ ...h, tunnel: tunnelStatus(h.id) }))
          return writeJson(res, 200, { hosts })
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (!body || typeof body.alias !== 'string' || !body.alias.trim()) {
            return writeJson(res, 400, { error: 'alias required' })
          }
          const host = {
            id: String(body.id ?? body.alias).trim(),
            alias: body.alias.trim(),
            name: typeof body.name === 'string' ? body.name : body.alias.trim(),
            port: Number(body.port) || DEFAULT_REMOTE_PORT,
            localPort: Number(body.localPort) || allocatePort(registry.hosts.length),
            autoTunnel: body.autoTunnel !== false,
          }
          registry.upsert(host)
          if (host.autoTunnel) {
            desired.set(host.id, true)
            startTunnel(host, host.localPort)
          }
          return writeJson(res, 200, { host: { ...host, tunnel: tunnelStatus(host.id) } })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      }),
    },
    {
      path: API.host,
      handler: withFence(async (req, res) => {
        const id = queryParam(new URL(req.url, 'http://dsh.internal'), 'id')
        if (!id || !registry.find(id)) return writeJson(res, 404, { error: 'host not found' })
        if (req.method === 'DELETE') {
          stopTunnel(id)
          registry.remove(id)
          return writeJson(res, 200, { ok: true })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      }),
    },
    {
      path: API.tunnel,
      handler: withFence(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const host = body?.id && registry.find(body.id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (body.action === 'stop') {
          desired.set(host.id, false)
          stopTunnel(host.id)
          return writeJson(res, 200, { ok: true })
        }
        desired.set(host.id, true)
        const record = startTunnel(host, host.localPort || allocatePort(registry.hosts.indexOf(host)))
        return writeJson(res, 200, { tunnel: tunnelStatus(host.id) })
      }),
    },
    {
      path: API.health,
      handler: withFence(async (req, res) => {
        const url = new URL(req.url, 'http://dsh.internal')
        const id = queryParam(url, 'id')
        const host = id && registry.find(id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = getTunnel(host.id)
        let hostUp = false
        let status = null
        if (tunnel && (tunnel.state === 'running' || tunnel.state === 'starting')) {
          try {
            const r = await fetch(`http://127.0.0.1:${tunnel.localPort}/`, { signal: AbortSignal.timeout(5000) })
            status = r.status
            hostUp = r.status < 500
            if (hostUp) markRunning(host.id) // self-heal a stuck 'starting' state
          } catch { status = 'unreachable' }
        }
        return writeJson(res, 200, { id: host.id, tunnel, hostUp, status })
      }),
    },
    {
      path: API.proxy,
      handler: withFence(async (req, res) => {
        // M2: proxy a remote host /api call (e.g. ?id=my-server&path=/api/...).
        const url = new URL(req.url, 'http://dsh.internal')
        const id = queryParam(url, 'id')
        const remotePath = queryParam(url, 'path') ?? '/'
        const host = id && registry.find(id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = getTunnel(host.id)
        if (!tunnel || tunnel.state !== 'running') {
          return writeJson(res, 409, { error: 'tunnel not running', tunnel })
        }
        try {
          const r = await fetch(`http://127.0.0.1:${tunnel.localPort}${remotePath}`, {
            signal: AbortSignal.timeout(10000),
            headers: { accept: 'application/json' },
          })
          const text = await r.text()
          res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json; charset=utf-8' })
          res.end(text)
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
    {
      path: API.sessions,
      handler: withFence(async (req, res) => {
        // M2: remote session summary. Calls the remote host's own
        // /api/session.list (same RPC contract as the local host) through the
        // tunnel and returns a compact per-session view.
        const url = new URL(req.url, 'http://dsh.internal')
        const id = queryParam(url, 'id')
        const host = id && registry.find(id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        const tunnel = getTunnel(host.id)
        if (!tunnel || tunnel.state !== 'running') {
          return writeJson(res, 409, { error: 'tunnel not running', tunnel })
        }
        try {
          const rpcId = `rh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const r = await fetch(`http://127.0.0.1:${tunnel.localPort}/api/session.list`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId,
              method: 'session.list',
              payload: {},
            }),
            signal: AbortSignal.timeout(10000),
          })
          const data = await r.json()
          if (!data || data.result?.ok !== true) {
            return writeJson(res, 502, { error: data?.result?.error ?? 'remote rpc failed' })
          }
          const items = (data.result.value?.items ?? []).map((s) => ({
            sessionId: s.sessionId,
            title: s.projections?.values?.title ?? null,
            running: !!s.running,
            blank: !!s.blank,
            updatedAt: s.updatedAt,
            cwd: s.cwd ?? null,
            turns: s.projections?.values?.sessionStats?.turns ?? null,
          }))
          return writeJson(res, 200, { sessions: items })
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
    {
      path: API.task,
      handler: withFence(async (req, res) => {
        // M3: push a LONG task to the remote instance — creates a persistent
        // session on the remote (via its own /api) and queues the task in it.
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        const content = typeof body?.content === 'string' && body.content.trim() ? body.content.trim() : ''
        const host = id && registry.find(id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (!content) return writeJson(res, 400, { error: 'content required' })
        const tunnel = getTunnel(host.id)
        if (!tunnel || tunnel.state !== 'running') {
          return writeJson(res, 409, { error: 'tunnel not running', tunnel })
        }
        try {
          const base = `http://127.0.0.1:${tunnel.localPort}`
          const rpc = (method, payload) => fetch(`${base}/api/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: `sev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, method, payload }),
            signal: AbortSignal.timeout(20000),
          }).then((r) => r.json())
          const created = await rpc('session.create', typeof body?.cwd === 'string' && body.cwd ? { cwd: body.cwd } : {})
          if (!created?.result?.ok) return writeJson(res, 502, { error: created?.result?.error ?? 'session.create failed' })
          const sessionId = created.result.value.sessionId
          const prompted = await rpc('session.prompt', {
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: content }],
          })
          if (!prompted?.result?.ok) return writeJson(res, 502, { error: prompted?.result?.error ?? 'session.prompt failed' })
          return writeJson(res, 200, { sessionId, accepted: prompted.result.value?.accepted === true, cwd: body?.cwd ?? null })
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
    {
      path: API.archive,
      handler: withFence(async (req, res) => {
        // Archive (delete from the active list) a remote session via the
        // remote host's own workspace.archiveSession API.
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const host = id && registry.find(id)
        if (!host) return writeJson(res, 404, { error: 'host not found' })
        if (!sessionId) return writeJson(res, 400, { error: 'sessionId required' })
        const tunnel = getTunnel(host.id)
        if (!tunnel || tunnel.state !== 'running') {
          return writeJson(res, 409, { error: 'tunnel not running', tunnel })
        }
        try {
          const r = await fetch(`http://127.0.0.1:${tunnel.localPort}/api/workspace.archiveSession`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: `sev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              method: 'workspace.archiveSession',
              payload: { sessionId },
            }),
            signal: AbortSignal.timeout(10000),
          })
          const data = await r.json()
          if (!data?.result?.ok) return writeJson(res, 502, { error: data?.result?.error ?? 'archive failed' })
          return writeJson(res, 200, { ok: true, archivedSessionIds: data.result.value?.archivedSessionIds ?? [] })
        } catch (error) {
          return writeJson(res, 502, { error: String(error) })
        }
      }),
    },
  ]
}

// ── agent tool: run a one-shot task on a remote host via its dsh CLI ────────
import { defineTool } from '@deepseek-ai/dsh-tools'

const HEADLESS_HOME_DEFAULT = '~/.dsh-headless'
const HEADLESS_TIMEOUT_MS = 300 * 1000

/**
 * Run `ssh <alias> dsh --profile headless "<task>"` on the remote host and
 * return the agent's final answer. The task text is piped via stdin to a temp
 * file on the remote side, so arbitrary quoting in the task is safe.
 */
function runRemoteHeadless(alias, task, headlessHome, cwd) {
  return new Promise((resolve) => {
    const cd = cwd ? `cd "${cwd}" && ` : ''
    const remote = `${cd}cat > /tmp/.dsh-sev-task.txt && env DSH_HOME=${headlessHome} dsh --profile headless "$(cat /tmp/.dsh-sev-task.txt)"`
    const proc = spawn('ssh', [alias, remote], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let stderr = ''
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ } }, HEADLESS_TIMEOUT_MS)
    proc.stdout.on('data', (d) => { output += String(d) })
    proc.stderr.on('data', (d) => { stderr += String(d) })
    proc.on('error', (e) => { clearTimeout(timer); resolve({ output: `ssh error: ${e.message}`, exitCode: 1 }) })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      const combined = (output + (stderr ? `\n[stderr] ${stderr.trim()}` : '')).trim()
      resolve({ output: combined, exitCode: code ?? 1 })
    })
    proc.stdin.write(task)
    proc.stdin.end()
  })
}

function sevRunTaskTool(registry) {
  return defineTool({
    name: 'sev_run_task',
    description: 'Run a one-shot task on a registered remote DSH host through its headless CLI (ssh + `dsh --profile headless`). The remote agent executes tools on that server and replies once. Use when the user wants a task executed on a remote server / the remote DSH instance, or a quick check on the remote box. Triggers: 远程跑任务 / 在服务器上执行 / 远程 dsh 控制。Long monitored tasks should use a persistent remote session instead.',
    parameters: {
      host: { type: 'string', description: 'Remote host id or alias registered in dsh-sev (e.g. my-server).' },
      task: { type: 'string', description: 'The task text for the remote agent to perform, e.g. "run uname -a and summarize".' },
      cwd: { type: 'string', description: 'Optional working directory on the server (a "remote project" folder). Task files land here; e.g. ~/projects/my-task.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => `exit ${value.exitCode}\n${value.output}`,
    },
    execute: async (args) => {
      const host = registry.find(args.host) ?? registry.hosts.find((h) => h.alias === args.host)
      if (!host) return { output: `host not found: ${args.host} (register it in the 远程 panel first)`, exitCode: 1 }
      const headlessHome = host.headlessHome ?? HEADLESS_HOME_DEFAULT
      return runRemoteHeadless(host.alias, args.task, headlessHome, args.cwd)
    },
  })
}

// ── plugin entry ────────────────────────────────────────────────────────────
function apply(ctx) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const registry = new Registry(join(dshHome, 'remote-hosts.json'))
  let nextLocalPort = 5636
  const allocatePort = () => { nextLocalPort += 1; return nextLocalPort }

  const routes = makeRoutes({ registry, allocatePort })

  // Resume tunnels for autoTunnel hosts after a host restart (adopts an
  // orphaned ssh on the same port, or spawns a fresh one).
  ctx.effect(() => {
    for (const h of registry.hosts) {
      if (h.autoTunnel !== false) desired.set(h.id, true)
    }
    for (const h of registry.hosts) {
      if (h.autoTunnel !== false) void resumeTunnel(h)
    }
  }, `${PLUGIN_ID}: resume tunnels`)

  // Tunnel watchdog: re-establish dropped tunnels so the remote GUI / API
  // connection self-heals (mirrors Codex app-server's persistent transport).
  const sweeperTimer = setInterval(() => sweepOnce(registry), 15000)
  ctx.effect(() => () => clearInterval(sweeperTimer), `${PLUGIN_ID}: tunnel sweeper`)
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) { try { dispose() } catch { /* noop */ } }
      for (const id of [...tunnels.keys()]) stopTunnel(id)
    }
  }, `${PLUGIN_ID}: routes`)

  ctx.effect(() => {
    try {
      return ctx.systemPrompt.section({
        name: `plugin:${PLUGIN_ID}`,
        order: 160,
        text: GUIDANCE,
      })
    } catch { return undefined }
  }, `${PLUGIN_ID}: guidance`)

  // Agent tool: one-shot remote task via the remote host's dsh CLI.
  ctx.effect(() => {
    const disposers = [ctx.tools.register(sevRunTaskTool(registry))]
    return () => { for (const d of disposers) { try { d() } catch { /* noop */ } } }
  }, `${PLUGIN_ID}: tools`)
}

const inject = ['webServer', 'systemPrompt', 'tools']

// makeRoutes exported for tests (returns a plain array of route objects).
export { apply, inject, API, Registry, makeRoutes, startTunnel, stopTunnel, tunnelStatus, sevRunTaskTool, HEADLESS_HOME_DEFAULT }

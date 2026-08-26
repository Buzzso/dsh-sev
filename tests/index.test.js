/**
 * dsh-sev — Node half tests (node --test).
 *
 * Regression suite for the two bugs that crashed the host on boot:
 *  1. makeRoutes() returns a plain ARRAY — never destructure it as { routes }.
 *  2. apply() must declare every cordis service in `inject` and must NOT use
 *     `export default` (the loader reads module-level apply + inject).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { makeRoutes, apply, inject, API, shouldRestartFor } from '../lib/index.js'

function stubCtx() {
  const registered = []
  const ctx = {
    effect: (fn) => { const off = fn(); return () => { if (typeof off === 'function') off() } },
    webServer: {
      register: (route) => { registered.push(route); return () => {} },
    },
    systemPrompt: {
      section: () => () => {},
    },
    tools: {
      register: (tool) => { registered.push(tool); return () => {} },
    },
  }
  return { ctx, registered }
}

/** Minimal req/res doubles for exercising route handlers directly. */
function fakeReq({ method = 'GET', url = '/', remoteAddress = '127.0.0.1', headers = {}, body } = {}) {
  return {
    method,
    url,
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}
function fakeRes() {
  const out = { status: 0, body: '', headers: {} }
  return {
    writeHead(status, headers) { out.status = status; out.headers = headers ?? {} },
    end(payload) { out.body = typeof payload === 'string' ? payload : String(payload) },
    out,
  }
}

test('makeRoutes returns a plain array (regression: was destructured as { routes })', () => {
  const registry = { hosts: [], find: () => undefined, upsert() {}, remove() {} }
  const routes = makeRoutes({ registry, allocatePort: () => 5637 })
  assert.ok(Array.isArray(routes), 'makeRoutes must return an array')
  assert.ok(routes.length >= 5, `expected >=5 routes, got ${routes.length}`)
  const paths = routes.map((r) => r.path)
  assert.ok(paths.includes(API.hosts), 'hosts route present')
  assert.ok(paths.includes(API.tunnel), 'tunnel route present')
  assert.ok(paths.includes(API.health), 'health route present')
})

test('apply() registers every route with a stub ctx and does not throw', () => {
  const { ctx, registered } = stubCtx()
  apply(ctx)
  assert.ok(registered.length >= 5, `expected >=5 registrations, got ${registered.length}`)
})

test('inject declares every service apply() touches', () => {
  assert.ok(inject.includes('webServer'), 'webServer must be injected')
  assert.ok(inject.includes('systemPrompt'), 'systemPrompt must be injected')
})

test('GET /api/dsh-sev/hosts returns {"hosts":[]} from empty registry', async () => {
  const registry = { hosts: [], find: () => undefined, upsert() {}, remove() {} }
  const routes = makeRoutes({ registry, allocatePort: () => 5637 })
  const hostsRoute = routes.find((r) => r.path === API.hosts)
  const req = fakeReq({ url: API.hosts })
  const res = fakeRes()
  await hostsRoute.handler(req, res)
  assert.equal(res.out.status, 200)
  assert.deepEqual(JSON.parse(res.out.body), { hosts: [] })
})

test('hosts POST adds a host and returns it with tunnel info', async () => {
  const store = { hosts: [], find: (id) => store.hosts.find((h) => h.id === id), upsert(h) { store.hosts.push(h); return h }, remove() {} }
  const routes = makeRoutes({ registry: store, allocatePort: () => 5637 })
  const hostsRoute = routes.find((r) => r.path === API.hosts)
  const req = fakeReq({ method: 'POST', url: API.hosts, body: { alias: 'my-server' } })
  const res = fakeRes()
  await hostsRoute.handler(req, res)
  assert.equal(res.out.status, 200)
  const { host } = JSON.parse(res.out.body)
  assert.equal(host.alias, 'my-server')
  assert.ok(host.id)
})

test('loopback fence rejects non-loopback callers', async () => {
  const registry = { hosts: [], find: () => undefined, upsert() {}, remove() {} }
  const routes = makeRoutes({ registry, allocatePort: () => 5637 })
  const hostsRoute = routes.find((r) => r.path === API.hosts)
  const req = fakeReq({ url: API.hosts, remoteAddress: '203.0.113.1' })
  const res = fakeRes()
  await hostsRoute.handler(req, res)
  assert.equal(res.out.status, 403)
})

test('real HTTP smoke: hosts route answers on a live loopback server', async () => {
  const registry = { hosts: [], find: () => undefined, upsert() {}, remove() {} }
  const routes = makeRoutes({ registry, allocatePort: () => 5637 })
  const server = createServer((req, res) => {
    const route = routes.find((r) => r.path === req.url?.split('?')[0])
    if (route) return void route.handler(req, res)
    res.writeHead(404); res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const r = await fetch(`http://127.0.0.1:${port}${API.hosts}`)
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { hosts: [] })
  } finally {
    // fetch keeps a keep-alive socket open, which would make close() hang.
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('sessions route proxies remote session.list and maps the summary', async () => {
  // Fake remote dsh host: answers the same RPC contract as a real host.
  const remote = createServer((req, res) => {
    if (req.url === '/api/session.list' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const envelope = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: {
            ok: true,
            value: {
              items: [
                {
                  sessionId: 'sess-remote-1',
                  running: true,
                  blank: false,
                  updatedAt: 1787669563000,
                  cwd: '/srv/dsh/workspace',
                  projections: {
                    values: {
                      title: '远程长任务',
                      sessionStats: { turns: 42 },
                    },
                  },
                },
                {
                  sessionId: 'sess-remote-2',
                  running: false,
                  blank: true,
                  updatedAt: 1787669561000,
                  cwd: null,
                  projections: { values: { title: null, sessionStats: null } },
                },
              ],
            },
          },
        }))
      })
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve))
  const remotePort = remote.address().port

  try {
    const registry = { hosts: [{ id: 'uh', alias: 'my-server', port: 3080, localPort: remotePort }], find: (id) => registry.hosts.find((h) => h.id === id), upsert() {}, remove() {} }
    const routes = makeRoutes({
      registry,
      allocatePort: () => 5637,
      getTunnel: () => ({ state: 'running', localPort: remotePort, remotePort: 3080, alias: 'my-server' }),
    })
    const sessionsRoute = routes.find((r) => r.path === API.sessions)
    const req = fakeReq({ url: `${API.sessions}?id=uh` })
    const res = fakeRes()
    await sessionsRoute.handler(req, res)
    assert.equal(res.out.status, 200)
    const { sessions } = JSON.parse(res.out.body)
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].title, '远程长任务')
    assert.equal(sessions[0].running, true)
    assert.equal(sessions[0].turns, 42)
    assert.equal(sessions[1].running, false)
  } finally {
    remote.closeAllConnections()
    await new Promise((resolve) => remote.close(resolve))
  }
})

test('sessions route returns 409 when the tunnel is not running', async () => {
  const registry = { hosts: [{ id: 'uh', alias: 'my-server' }], find: (id) => registry.hosts.find((h) => h.id === id), upsert() {}, remove() {} }
  const routes = makeRoutes({ registry, allocatePort: () => 5637, getTunnel: () => null })
  const sessionsRoute = routes.find((r) => r.path === API.sessions)
  const res = fakeRes()
  await sessionsRoute.handler(fakeReq({ url: `${API.sessions}?id=uh` }), res)
  assert.equal(res.out.status, 409)
})

test('watchdog shouldRestartFor: restarts dropped tunnels but not healthy ones', () => {
  const now = 1_000_000
  // no record + desired → restart
  assert.equal(shouldRestartFor(true, undefined, now), true)
  // not desired → never
  assert.equal(shouldRestartFor(false, undefined, now), false)
  // running → no
  assert.equal(shouldRestartFor(true, { state: 'running' }, now), false)
  // starting, young → wait
  assert.equal(shouldRestartFor(true, { state: 'starting', startedAt: now - 2000 }, now), false)
  // starting, stale (>10s) → restart
  assert.equal(shouldRestartFor(true, { state: 'starting', startedAt: now - 15000 }, now), true)
  // exited, recent → cooldown
  assert.equal(shouldRestartFor(true, { state: 'exited', exitedAt: now - 1000 }, now), false)
  // exited, older than 5s → restart
  assert.equal(shouldRestartFor(true, { state: 'exited', exitedAt: now - 8000 }, now), true)
})

test('Registry.save() keeps a rolling .bak so deletions are recoverable', async () => {
  const { Registry } = await import('../lib/index.js')
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sev-test-'))
  const file = join(dir, 'remote-hosts.json')
  writeFileSync(file, JSON.stringify({ hosts: [{ id: 'a', alias: 'alpha' }] }))
  const r = new Registry(file)
  r.hosts = [{ id: 'a', alias: 'alpha' }, { id: 'b', alias: 'beta' }]
  r.save()
  assert.equal(existsSync(`${file}.bak`), true, '.bak must exist after the second save')
  const bak = JSON.parse(readFileSync(`${file}.bak`, 'utf8'))
  assert.deepEqual(bak.hosts, [{ id: 'a', alias: 'alpha' }], '.bak holds the pre-change state')
  rmSync(dir, { recursive: true, force: true })
})

test('sevRunTaskTool registers with the expected shape (name/parameters/output)', async () => {
  const { sevRunTaskTool } = await import('../lib/index.js')
  const registry = { hosts: [{ id: 'srv', alias: 'my-server' }], find: (id) => registry.hosts.find((h) => h.id === id) }
  const tool = sevRunTaskTool(registry)
  assert.equal(tool.name, 'sev_run_task')
  assert.ok(tool.parameters?.properties?.host && tool.parameters?.properties?.task, 'tool declares host+task parameters')
  assert.ok(tool.output?.schema?.properties?.output, 'tool declares an output schema')
  assert.equal(typeof tool.execute, 'function', 'defineTool normalizes handler -> execute')
  const res = await tool.execute({ host: 'nope', task: 'x' })
  assert.equal(res.exitCode, 1)
  assert.match(res.output, /host not found/)
})

test('task route creates a remote session and queues the task (via fake remote)', async () => {
  const remote = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const env = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/api/session.create') {
        res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: { sessionId: 'sess-pushed-1' } } }))
      } else if (req.url === '/api/session.prompt') {
        assert.equal(env.payload.mode, 'queue')
        assert.equal(env.payload.content[0].text, '做一件长任务')
        res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: { accepted: true } } }))
      } else {
        res.writeHead(404); res.end()
      }
    })
  })
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve))
  const remotePort = remote.address().port
  try {
    const registry = { hosts: [{ id: 'srv', alias: 'my-server' }], find: (id) => registry.hosts.find((h) => h.id === id), upsert() {}, remove() {} }
    const routes = makeRoutes({
      registry,
      allocatePort: () => 5637,
      getTunnel: () => ({ state: 'running', localPort: remotePort, remotePort: 3080, alias: 'my-server' }),
    })
    const taskRoute = routes.find((r) => r.path === API.task)
    const res = fakeRes()
    await taskRoute.handler(fakeReq({ method: 'POST', url: API.task, body: { id: 'srv', content: '做一件长任务' } }), res)
    assert.equal(res.out.status, 200)
    const data = JSON.parse(res.out.body)
    assert.equal(data.sessionId, 'sess-pushed-1')
    assert.equal(data.accepted, true)
  } finally {
    remote.closeAllConnections()
    await new Promise((resolve) => remote.close(resolve))
  }
})

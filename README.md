# dsh-sev

> Remote DSH host management for [DeepSeek Harness](https://github.com/deepseek-ai) — run a headless `dsh` instance on **your own server** and operate it from your local GUI, as if it were a local workspace. Long-running tasks survive your laptop being off.

**中文简介**：把一台服务器变成你的 DSH「分身」——本地 GUI 左侧边栏混排远程会话、一键打开远程 GUI、SSH 隧道掉线自动重连。长任务甩给服务器，关掉 Mac 也不中断。

- **English documentation**: below
- **中文文档**：见文末「中文文档」一节

---

## ✨ Features

- **Dual-channel remote control** — operate the remote dsh both ways: **SSH tunnels + panel** (watch its GUI, browse sessions) *and* **dsh CLI control** (the `sev_run_task` agent tool runs one-shot tasks on the remote via `ssh` + `dsh --profile headless`).
- **Remote projects** — point a task at a server folder (`cwd`); the remote agent works there and task files land on the server, retrievable via Syncthing / scp.
- **Left-sidebar mixed list** — remote sessions appear right next to your local ones (title, running pulse, relative time), Codex-style.
- **One-click remote GUI** — open the remote instance's full web UI inside the panel (iframe) or in a tab.
- **Auto-healing SSH tunnels** — dropped tunnels reconnect automatically (watchdog), and resume on app restart.
- **Remote session API** — session list / health are pulled through the tunnel from the remote host's own API.
- **Recoverable config** — host registry is a plain JSON file with an automatic rolling backup (`.bak`); deletion asks for confirmation.
- **Zero local exposure** — remote host only listens on `127.0.0.1`; you reach it via an SSH tunnel. Loopback-only API fence.

## 🏗 Architecture

```
┌─ your machine (local dsh) ────────────────────────────┐
│  web GUI  ⇄  /api/dsh-sev/*  ⇄  Node half             │
│   · browser half: sidebar entry, mixed session list   │
│   · node half: registry, tunnel lifecycle, watchdog    │
└──────────────┬────────────────────────────────────────┘
               │ ssh -L <local>:127.0.0.1:<remote dsh port> <alias>
               ▼
┌─ your server (headless dsh, systemd) ─────────────────┐
│  dsh --profile web --host 127.0.0.1 --port 3080        │
│  sessions persist here; long tasks survive laptop off  │
└────────────────────────────────────────────────────────┘
```

## 📦 Install

### From npm (recommended)

```bash
# on the machine running the local DSH GUI
npm i -g pnpm                                   # dsh plugin CLI needs pnpm
dsh plugin --profile web add dsh-sev
# restart the DSH host / web GUI to load the plugin
```

### From source

```bash
git clone <this-repo> && cd dsh-sev
npm install && npm run build
dsh plugin --profile web add link:$(pwd)
```

## 🖥 Server setup (the "remote host")

Install a headless DSH on the server (Ubuntu 22.04+ example):

```bash
# 1. Node + dsh (use a mirror if you are in CN)
npm i -g pnpm
npm i -g @deepseek-ai/dsh --registry=https://registry.npmmirror.com

# 2. Model credentials — the remote instance needs its own API keys:
#    ~/.dsh/settings.yaml          (default model / provider)
#    ~/.dsh/.credentials.yaml      (DeepSeek / provider keys)
#    ~/.modlens/config.json        (vision bridge, if used)
#    export ARK_PLAN_API_KEY=...   (env-based providers, if used)

# 3. systemd unit so it survives reboots (adjust paths)
sudo tee /etc/systemd/system/dsh-web.service >/dev/null <<'EOF'
[Unit]
Description=DSH web (remote host)
After=network-online.target

[Service]
Type=simple
User=<your-user>
Environment=DSH_HOME=/home/<your-user>/.dsh
WorkingDirectory=<dsh-install-dir>
ExecStart=/usr/bin/node <dsh-install-dir>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --host 127.0.0.1 --port 3080
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-web
```

> **Tip**: replicate your local `~/.dsh` (settings, credentials, memories, plugin profile) to the server once — the linked plugin sources resolve by relative symlink when kept at the same path. See [docs/server-migration.md](docs/server-migration.md).

## 🌐 Networking

The tunnel uses your normal `ssh` — any reachable address works:

- **Recommended: [ZeroTier](https://www.zerotier.com/)** — a private mesh between your machines, no public ports. Install on both sides, join the same network, and put the server's ZeroTier IP in `~/.ssh/config`.
- Or: LAN IP / VPN / a public IP with keys only.

Example `~/.ssh/config`:

```
Host my-server
    HostName 203.0.113.1          # your server's ZeroTier / LAN IP
    User your-user
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

## 🚀 Usage

1. After installing, refresh the GUI. You'll see:
   - a **远程** entry in the left sidebar nav,
   - a **远程会话** group above the workspace list (once a host is online).
2. Open the **远程** panel, type the SSH alias (e.g. `my-server`), click **添加**.
3. The plugin auto-starts the tunnel (`ssh -L`) and shows the host **在线** with its session list.
4. Click any remote session (or **打开**) to operate the remote GUI inside the panel.

Hosts persist in `~/.dsh/remote-hosts.json` (with a rolling `remote-hosts.json.bak` backup).

## 🔒 Security

- Remote host binds `127.0.0.1` only — never exposed to the network.
- All plugin API routes enforce a **loopback-only** fence (host header + origin checks), mirroring other DSH plugins.
- Your model API keys live only on machines you control (local + server).
- The tunnel is just `ssh` — reuse your existing keys; never commit keys to this repo.

## 🤖 Agent control (one-shot remote tasks)

After install, the local agent gains a **`sev_run_task(host, task)`** tool that runs a task on the remote host through its own headless dsh CLI (`ssh` + `dsh --profile headless`). Just ask: *"run this on the server: …"*.

Server-side headless setup (once):

```bash
# 1. a dedicated DSH_HOME with the plain DeepSeek provider
mkdir -p ~/.dsh-headless
cat > ~/.dsh-headless/settings.yaml <<'CFG'
llm-deepseek:
  baseURL: https://api.deepseek.com
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
CFG
ln -s ~/.dsh/.credentials.yaml ~/.dsh-headless/.credentials.yaml

# 2. enable the built-in (but disabled) DeepSeek provider for the headless profile
dsh plugin --profile headless add @deepseek-ai/dsh-llm-deepseek
mkdir -p ~/.dsh-headless/profiles/headless
cat > ~/.dsh-headless/profiles/headless/cordis.patch.yml <<'CFG'
- enable:
    - id: llm-deepseek
CFG
```

Notes: the provider id is `deepseek-official`; the headless profile ships `llm-deepseek` disabled by default — the patch above enables it. The tool pipes the task via stdin to a temp file (safe for arbitrary quoting) and times out after 5 minutes.

## 🛠 Development

```bash
npm install        # dev deps: esbuild / typescript / @types/react
npm run build      # bundles lib/client.js (browser half)
npm test           # node --test (11 cases: routes, fence, watchdog, sessions proxy, .bak)
npm run typecheck  # optional tsc --noEmit
```

Plugin layout:

```
lib/index.js          # Node half: registry, tunnels, watchdog, /api/dsh-sev routes
src/client/index.tsx  # Browser half: sidebar entry, mixed list, panel, iframe
scripts/build.mjs     # esbuild → lib/client.js (window.__ModuleLoader__.load format)
cordis.patch.yml      # bundle layer manifest (id: sev / name: dsh-sev)
```

## 📦 Publishing

```bash
npm run build && npm test   # prepublishOnly runs this automatically
npm publish                 # requires an npm account; the package is the "installer"
```

For the DSH plugin marketplace: install the published package via `dsh plugin add dsh-sev`; marketplace inclusion follows the DSH plugin registry process.

## 📄 License

MIT

---

# 中文文档

## ✨ 功能特性

- **双通道远程控制** — 两种方式操控远程 dsh：**SSH 隧道 + 面板**（看远程 GUI、浏览会话）与 **dsh CLI 控制**（`sev_run_task` agent 工具经 `ssh` + `dsh --profile headless` 在远程跑一次性任务）。
- **远程项目** — 给任务指定服务器文件夹（`cwd`），远程 agent 就在那里工作，任务文件落在服务器上，可经 Syncthing / scp 取回。
- **左侧会话混排** — 远程会话直接显示在左侧边栏，跟本地任务并列（标题、运行态呼吸点、相对时间），Codex 同款体验。
- **一键远程 GUI** — 面板内以 iframe 打开远程实例的完整网页界面（也可在标签页打开）。
- **隧道自动自愈** — SSH 隧道意外断开自动重连（看门狗），App 重启后自动恢复。
- **远程会话 API** — 会话列表 / 健康状态经隧道调用远程实例自身的 API。
- **配置可恢复** — 主机注册表是纯 JSON 文件，每次保存前自动写滚动备份（`.bak`）；删除前有确认弹窗。
- **零暴露** — 远程实例只监听 `127.0.0.1`，本机经 SSH 隧道访问；插件 API 全部 loopback 围栏。

## 🏗 架构

```
┌─ 本机（本地 dsh）──────────────────────────────┐
│  web GUI  ⇄  /api/dsh-sev/*  ⇄  Node 半         │
│   · 浏览器半：侧边栏入口、混排会话列表            │
│   · Node 半：注册表、隧道生命周期、看门狗         │
└──────────────┬──────────────────────────────────┘
               │ ssh -L <本地端口>:127.0.0.1:<远程 dsh 端口> <别名>
               ▼
┌─ 服务器（headless dsh，systemd）─────────────────┐
│  dsh --profile web --host 127.0.0.1 --port 3080   │
│  会话持久在服务器；长任务不因本机关机而中断        │
└──────────────────────────────────────────────────┘
```

## 📦 安装

### 从 npm 安装（推荐）

```bash
# 在本机（运行 DSH GUI 的机器）
npm i -g pnpm                                   # dsh 插件 CLI 需要 pnpm
dsh plugin --profile web add dsh-sev
# 重启 DSH host / web GUI 使插件生效
```

### 从源码安装

```bash
git clone <本仓库> && cd dsh-sev
npm install && npm run build
dsh plugin --profile web add link:$(pwd)
```

## 🖥 服务器部署（「远程分身」）

在服务器上装 headless DSH（Ubuntu 22.04+ 示例）：

```bash
# 1. Node + dsh（国内可用镜像加速）
npm i -g pnpm
npm i -g @deepseek-ai/dsh --registry=https://registry.npmmirror.com

# 2. 模型凭据——远程实例需要自己的 API key：
#    ~/.dsh/settings.yaml          （默认模型 / 提供商）
#    ~/.dsh/.credentials.yaml      （DeepSeek / 各厂商 key）
#    ~/.modlens/config.json        （视觉桥，如使用）
#    export ARK_PLAN_API_KEY=...   （基于环境变量的提供商，如使用）

# 3. systemd 守护，重启不丢（按需改路径）
sudo tee /etc/systemd/system/dsh-web.service >/dev/null <<'EOF'
[Unit]
Description=DSH web (remote host)
After=network-online.target

[Service]
Type=simple
User=<你的用户名>
Environment=DSH_HOME=/home/<你的用户名>/.dsh
WorkingDirectory=<dsh 安装目录>
ExecStart=/usr/bin/node <dsh 安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --host 127.0.0.1 --port 3080
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-web
```

> **提示**：可以把本机 `~/.dsh`（settings、credentials、memories、插件 profile）一次性复制到服务器——link 插件按相对路径解析，保持同路径即可。详见 [docs/server-migration.md](docs/server-migration.md)。

## 🌐 组网

隧道用你现有的 `ssh`，任何可达地址都行：

- **推荐 [ZeroTier](https://www.zerotier.com/)** — 设备间私有组网，无需公网端口。两端安装、加入同一网络，把服务器的 ZeroTier IP 写进 `~/.ssh/config`。
- 或者：局域网 IP / VPN / 仅密钥认证的公网 IP。

`~/.ssh/config` 示例：

```
Host my-server
    HostName 203.0.113.1          # 你的服务器 ZeroTier / 局域网 IP
    User your-user
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

## 🚀 使用

1. 安装后刷新 GUI，你会看到：
   - 左侧导航栏的 **远程** 入口，
   - 工作区列表上方的 **远程会话** 分组（主机在线后出现）。
2. 打开 **远程** 面板，输入 SSH 别名（如 `my-server`），点 **添加**。
3. 插件自动建立隧道（`ssh -L`）并显示主机 **在线** 与会话列表。
4. 点任意远程会话（或 **打开**）即可在面板内操作远程 GUI。

主机配置持久化在 `~/.dsh/remote-hosts.json`（每次保存自动留 `remote-hosts.json.bak` 备份）。

## 🔒 安全

- 远程实例只监听 `127.0.0.1`，不暴露到网络。
- 插件所有 API 路由带 **loopback-only** 围栏（host 头 + origin 校验），与其它 DSH 插件一致。
- 模型 API key 只存在于你控制的机器（本机 + 服务器）。
- 隧道就是 `ssh`——复用你现有的密钥；**永远不要把密钥提交进本仓库**。

## 🤖 Agent 控制（一次性远程任务）

安装后，本地 agent 会获得 **`sev_run_task(host, task)`** 工具——通过远程主机自己的 headless dsh CLI（`ssh` + `dsh --profile headless`）跑任务。直接说「帮我在服务器上跑：…」即可。

服务器端 headless 一次性配置：

```bash
# 1. 独立 DSH_HOME + 原生 DeepSeek 提供商
mkdir -p ~/.dsh-headless
cat > ~/.dsh-headless/settings.yaml <<'CFG'
llm-deepseek:
  baseURL: https://api.deepseek.com
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
CFG
ln -s ~/.dsh/.credentials.yaml ~/.dsh-headless/.credentials.yaml

# 2. 启用 headless 内置（默认禁用）的 DeepSeek 提供商
dsh plugin --profile headless add @deepseek-ai/dsh-llm-deepseek
mkdir -p ~/.dsh-headless/profiles/headless
cat > ~/.dsh-headless/profiles/headless/cordis.patch.yml <<'CFG'
- enable:
    - id: llm-deepseek
CFG
```

注意：provider id 是 `deepseek-official`；headless profile 默认禁用了 `llm-deepseek`，上面的 patch 即启用它。任务文本经 stdin 写入临时文件（任意引号都安全），5 分钟超时。

## 🛠 开发

```bash
npm install        # devDeps: esbuild / typescript / @types/react
npm run build      # 打包 lib/client.js（浏览器半）
npm test           # node --test（11 用例：路由/围栏/看门狗/会话代理/.bak）
npm run typecheck  # 可选 tsc --noEmit
```

插件结构：

```
lib/index.js          # Node 半：注册表、隧道、看门狗、/api/dsh-sev 路由
src/client/index.tsx  # 浏览器半：侧边栏入口、混排列表、面板、iframe
scripts/build.mjs     # esbuild → lib/client.js（window.__ModuleLoader__.load 格式）
cordis.patch.yml      # bundle 层清单（id: sev / name: dsh-sev）
```

## 📦 发布

```bash
npm run build && npm test   # prepublishOnly 会自动执行
npm publish                 # 需要 npm 账号；发布的包就是「安装包」
```

接入 DSH 插件市场：用 `dsh plugin add dsh-sev` 安装已发布包；市场收录按 DSH 插件注册流程。

## 📄 License / 许可证

MIT

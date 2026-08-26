# Server migration / 服务器迁移

> English below · 中文见文末

The remote host needs its own `~/.dsh` (models, credentials, memories, plugins). The simplest path is to replicate your local setup once:

```bash
# on your server (paths are examples — adjust)
mkdir -p ~/.dsh ~/.modlens ~/dsh-sources

# 1. config + credentials (NEVER commit these — they live on your machines only)
rsync -az ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml ~/.dsh/.anonymous-user-id user@server:~/.dsh/
rsync -az ~/.dsh/memories/ user@server:~/.dsh/memories/
rsync -az ~/.modlens/config.json user@server:~/.modlens/

# 2. plugin profile (config + node_modules; keep linked plugin sources at the
#    same relative path so relative symlinks resolve)
rsync -az ~/.dsh/profiles/web/ user@server:~/.dsh/profiles/web/
rsync -az ~/dsh-sources/ user@server:~/dsh-sources/

# 3. platform fixes on the server (native modules are per-OS):
cd ~/.dsh/profiles/web && npm rebuild node-pty --build-from-source
```

Notes:

- Do **not** sync `~/.dsh/sessions` — the remote instance keeps its own sessions.
- Remote model providers need their own keys (settings.yaml, .credentials.yaml, `~/.modlens/config.json`, env-based keys like `ARK_PLAN_API_KEY`).
- Sessions, memories and registry paths are the same as the local host, so the plugin works identically on both sides.

## Recovery / 配置恢复

- Host registry: `~/.dsh/remote-hosts.json` — plain JSON, easy to back up/restore.
- The plugin writes a rolling backup `remote-hosts.json.bak` before every save, so an accidental host deletion is one copy away: `cp ~/.dsh/remote-hosts.json.bak ~/.dsh/remote-hosts.json` (restart the host afterwards).
- The panel asks for confirmation before deleting a host.

---

# 中文

远程实例需要自己的 `~/.dsh`（模型配置、凭据、记忆、插件）。最简单的方式是把本机的配置一次性复制过去：

```bash
# 在服务器上执行（路径是示例，按需调整）
mkdir -p ~/.dsh ~/.modlens ~/dsh-sources

# 1. 配置 + 凭据（永远不要提交进仓库——它们只存在于你自己的机器上）
rsync -az ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml ~/.dsh/.anonymous-user-id user@server:~/.dsh/
rsync -az ~/.dsh/memories/ user@server:~/.dsh/memories/
rsync -az ~/.modlens/config.json user@server:~/.modlens/

# 2. 插件 profile（配置 + node_modules；link 插件源码保持相同相对路径，符号链接才能解析）
rsync -az ~/.dsh/profiles/web/ user@server:~/.dsh/profiles/web/
rsync -az ~/dsh-sources/ user@server:~/dsh-sources/

# 3. 服务器端平台适配（原生模块按操作系统编译）：
cd ~/.dsh/profiles/web && npm rebuild node-pty --build-from-source
```

注意事项：

- **不要**同步 `~/.dsh/sessions`——远程实例保留自己的会话。
- 远程模型提供商需要自己的 key（settings.yaml、.credentials.yaml、`~/.modlens/config.json`、环境变量型如 `ARK_PLAN_API_KEY`）。
- 会话、记忆、注册表路径与本机一致，插件两端行为完全相同。

## 配置恢复

- 主机注册表：`~/.dsh/remote-hosts.json` —— 纯 JSON，易备份易恢复。
- 插件每次保存前自动写滚动备份 `remote-hosts.json.bak`，误删主机后一条命令即可恢复：
  `cp ~/.dsh/remote-hosts.json.bak ~/.dsh/remote-hosts.json`（之后重启 host）。
- 面板删除主机前有确认弹窗。

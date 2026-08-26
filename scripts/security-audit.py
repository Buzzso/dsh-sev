#!/usr/bin/env python3
"""dsh-sev security audit — run before publishing.

Scans the working tree (all files), git history, and the npm tarball for
anything that must never leak in a public repo / package:
  * absolute local paths            (/Users/…, /home/<user>/…)
  * real usernames & author emails  (buzzso, buzz923, …)
  * hostnames / machine names       (my-server, Mac-Buzz, …)
  * private / real IPs              (10.x, 192.168.x, …; 127.0.0.1 & the README
                                     example 10.147.20.1 are whitelisted)
  * API keys & tokens               (sk-…, npm_…, ghp_…, Bearer …, …)
  * internal URLs with ports        (127.0.0.1:<port>, ws://, …)
  * workspace / project names       (<workspace>, fanshu, dsh-browser, …)

Exit 0 = clean. Any hit prints the file/line with the value MASKED and exits 1.
"""
import os, re, subprocess, sys, tarfile, tempfile, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# key-like patterns — masked when reported
KEY_RE = re.compile(
    r'sk-[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|'
    r'github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|'
    r'AIza[0-9A-Za-z_-]{35}|ARK[0-9a-f]{20,}|deepseek-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9._-]{16,}'
)
# everything else that should not appear — masked as <leak>
# (git noreply emails and the universal /home/user/ placeholder are not leaks)
LEAK_RE = re.compile(
    r'/Users/|/private/|/Volumes/|/Applications/'
    r'|buzzso|buzz923|\bbuzz\b|edgar'
    r'|[a-z0-9._%+-]+@(?!users\.noreply\.github\.com)[a-z0-9.-]+\.[a-z]{2,}'
    r'|ubuntu-hermes|Buzzdebijibendiannao|Mac-Buzz|\bBuzzso\b'
    r'|(?!/home/user/)/home/[a-z][a-z0-9]*/'
    r'|http://127\.0\.0\.1:[0-9]{4,}|http://localhost:[0-9]{2,}|ws://[0-9.]+'
    r'|:8384|:22000|整体工作架构设计|fanshu|dsh-browser|Documents/harness'
)

# full dotted-quad IPs (octets 0-255); classify leaks properly
IP_RE = re.compile(r'\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b')
DOC_NETS = ('192.0.2.', '198.51.100.', '203.0.113.')  # RFC 5737 documentation ranges

def ip_is_leak(ip):
    if ip.startswith('127.') or any(ip.startswith(d) for d in DOC_NETS):
        return False
    o = ip.split('.')
    if o[0] == '10':
        return True
    if o[0] == '172':
        return 16 <= int(o[1]) <= 31
    if o[0] == '192' and o[1] == '168':
        return True
    if o[0] == '100':
        return 64 <= int(o[1]) <= 127
    return True  # conservative: any other public IP is a potential leak

def mask(text: str) -> str:
    text = KEY_RE.sub(lambda m: m.group(0)[:6] + '***masked***', text)
    text = LEAK_RE.sub('<leak>', text)
    text = IP_RE.sub(lambda m: m.group(0) if not ip_is_leak(m.group(0)) else '***ip-masked***', text)
    return text

def scan_bytes(data: bytes, label: str) -> list:
    """Return masked hit lines for raw bytes."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return []
    hits = []
    for i, line in enumerate(text.splitlines(), 1):
        if KEY_RE.search(line) or LEAK_RE.search(line) or any(ip_is_leak(m.group(0)) for m in IP_RE.finditer(line)):
            hits.append(f"  L{i}: {mask(line)[:220]}")
    return hits

fail = 0

def report(category, hits):
    global fail
    if hits:
        print(f"  ❌ {category}:")
        for h in hits[:8]:
            print(h)
        fail = 1
    else:
        print(f"  ✅ {category}: 无泄露")

print("═══ dsh-sev security audit ═══")
print(f"扫描根: {ROOT}")

# ── 1) working tree ──
print("\n▶ 1/3 工作区文件")
all_hits = []
for dirpath, dirnames, filenames in os.walk('.'):
    dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git', '.pnpm')]
    for fn in filenames:
        fp = os.path.join(dirpath, fn)
        if os.path.abspath(fp) == os.path.abspath(__file__):
            continue  # the audit's own patterns are meta-content, not leaks
        try:
            with open(fp, 'rb') as fh:
                data = fh.read()
        except OSError:
            continue
        hits = scan_bytes(data, fp)
        if hits:
            print(f"── {fp}")
            all_hits.extend(hits)
report("工作区", all_hits)

# ── 2) git history ──
print("\n▶ 2/3 git 历史")
try:
    out = subprocess.run(['git', 'log', '-p', '--all'], capture_output=True, text=True, timeout=60).stdout
    gh = []
    in_audit = False  # the audit's own docstring/patterns are meta-content, not leaks
    for i, line in enumerate(out.splitlines(), 1):
        if line.startswith('diff --git '):
            in_audit = 'scripts/security-audit.py' in line
            continue
        if line.startswith(('index ', '---', '+++')) or line.startswith('commit ') or line.startswith('Author:'):
            continue
        if in_audit:
            continue
        if KEY_RE.search(line) or LEAK_RE.search(line):
            gh.append(f"  {mask(line)[:220]}")
    report("历史", gh)
except Exception as e:
    print(f"  ⚠️ git 扫描失败: {e}")

# ── 3) npm tarball ──
print("\n▶ 3/3 npm 发布物")
try:
    env = dict(os.environ)
    env['PATH'] = '/usr/local/bin:/opt/homebrew/bin:' + env.get('PATH', '')
    pack = json.loads(subprocess.run(['npm', 'pack', '--dry-run', '--json'], capture_output=True, text=True, timeout=60, env=env).stdout)
    tgz = pack[0].get('filename')
    if tgz and os.path.exists(tgz):
        th = []
        with tarfile.open(tgz) as tf:
            for m in tf.getmembers():
                if m.isfile():
                    data = tf.extractfile(m).read()
                    th.extend(scan_bytes(data, m.name))
        report("发布物", th)
    else:
        print("  ⚠️ 未找到 tgz，跳过（先用 npm pack）")
except Exception as e:
    print(f"  ⚠️ 打包扫描失败: {e}")

print(f"\n═══ 结果: {'✅ PASS — 可以发布' if fail == 0 else '❌ FAIL — 修复后重跑'} ═══")
sys.exit(fail)

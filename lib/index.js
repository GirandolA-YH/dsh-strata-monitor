// strata-monitor 宿主端（Node / ESM，Cordis 插件）
//
// 职责：
//   1) 给浏览器提供一个同源代理 /strata-monitor/api/*，避免 CORS（浏览器不能直连 :8080）
//   2) 只有宿主端能开进程：启动 / 停止 Strata
//   3) 调 Strata 的 /load、/unload（必须 JSON、且不能带外部 Origin 头）
//
// 不修改 DSH 源码，也不修改 Strata 源码。

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'strata-monitor';
export const inject = ['webServer'];

// ---- 默认值：都可以用 profile 里的 config 覆盖（见下面的 Config）----
const DEFAULT_BASE = 'http://127.0.0.1:8080'; // Strata 服务地址
const DEFAULT_DIR = 'D:\\Strata'; // Strata 安装目录（里面有 run-*.bat 与 strata-*.json）
const DEFAULT_SCRIPT = 'run-swift-iq2_xs.bat'; // 面板默认启动的 run-*.bat；留空则用清单里第一个
const PREFIX = '/strata-monitor/api';

/**
 * 插件配置。在 profile 的 cordis.patch.yml 里给这条 insert 加 config 即可，例如：
 *
 *   - insert:
 *       - id: strata-monitor
 *         name: 'strata-monitor'
 *         config:
 *           strataDir: 'E:\AI\Strata'
 *           defaultScript: 'run-iq3_xxs.bat'
 *
 * 三个字段都能省略，省略时用上面的默认值。DSH 的设置页也能直接编辑这几个字段。
 */
export const Config = z.object({
  strataDir: z.string().default(DEFAULT_DIR).description('Strata 安装目录（里面有 run-*.bat 和 strata-*.json）'),
  strataBase: z.string().default(DEFAULT_BASE).description('Strata 服务地址，默认 http://127.0.0.1:8080'),
  defaultScript: z.string().default(DEFAULT_SCRIPT).description('面板默认启动的 run-*.bat；留空则用清单里第一个'),
});

// 生效中的配置：apply 时按 profile 里的 config 覆盖。插件是单例，用模块级变量即可。
let CFG = { base: DEFAULT_BASE, port: 8080, dir: DEFAULT_DIR, script: DEFAULT_SCRIPT };

// 启动超过这么久还连不上，就允许用户再点一次「启动 Strata」
const START_GIVEUP_MS = 10 * 60 * 1000;

// 已知模型名的友好显示（其余按原名显示）
const MODEL_LABELS = {
  'swift-1.5-iq2_xs': 'Swift 1.5 IQ2_XS',
  'swift-1.5-iq3_xxs': 'Swift 1.5 IQ3_XXS',
  'qwen3.8-flash-next-iq3_xxs': 'Qwen3.8-Flash-Next IQ3_XXS',
  'qwen3.8-flash-next-iq2_xs': 'Qwen3.8-Flash-Next IQ2_XS',
  'qwen3.8-flash-next-q2_0': 'Qwen3.8-Flash-Next Q2_0',
  'qwen3.8-flash-next-iq3_s': 'Qwen3.8-Flash-Next IQ3_S',
  'qwen3.8-flash-next-coder-iq1_m': 'Coder IQ1_M',
};

let launcherPid = null; // 启动脚本（cmd.exe）的进程号
let startedAt = 0; // 本次启动时间戳
let lastStartError = '';
let launcherScript = ''; // 本次启动用的脚本名（面板显示用）

// ---------------- 小工具 ----------------

function writeJson(res, code, obj) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(obj), 'utf8');
  } catch (e) {
    body = Buffer.from('{"error":"serialize failed"}', 'utf8');
    code = 500;
  }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 65536) req.destroy();
    });
    req.on('end', () => resolve(s));
    req.on('error', () => resolve(''));
  });
}

function errText(e) {
  if (!e) return String(e);
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return '请求超时';
  return String(e.message || e);
}

/** 服务端探测：绝不抛异常 */
async function probe(path, ms = 1500) {
  try {
    const r = await fetch(CFG.base + path, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) {
      return { reachable: true, httpStatus: r.status, data: null };
    }
    return { reachable: true, httpStatus: r.status, data: await r.json() };
  } catch (e) {
    return { reachable: false, error: errText(e) };
  }
}

/** 调 Strata 的控制接口：Content-Type: application/json，且不带 Origin 头 */
async function control(path, ms = 15000) {
  try {
    const r = await fetch(CFG.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(ms),
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, body: text.slice(0, 400) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 跑一条命令并抓 stdout（不弹窗，超时即杀） */
function runCapture(cmd, args, ms = 4000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (e) {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (e) {
        /* ignore */
      }
    }, ms);
    child.stdout.on('data', (c) => {
      out += c;
      if (out.length > 1_000_000) {
        try {
          child.kill();
        } catch (e) {
          /* ignore */
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** 找出正在 LISTENING :8080 的进程号（不依赖是谁启动的 Strata） */
async function findListenerPids() {
  const out = await runCapture('netstat', ['-ano', '-p', 'tcp']);
  const pids = new Set();
  for (const raw of String(out).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes('LISTENING')) continue;
    const parts = line.split(/\s+/);
    // TCP  127.0.0.1:8080  0.0.0.0:0  LISTENING  12345
    if (parts.length < 5) continue;
    if (parts[3] !== 'LISTENING') continue;
    if (!parts[1].endsWith(':' + CFG.port)) continue;
    const pid = Number(parts[4]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (pid === 4 || pid === process.pid) continue;
    pids.add(pid);
  }
  return [...pids];
}

function killTree(pid) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      resolve({ ok: false, pid, error: errText(e) });
      return;
    }
    child.on('error', () => resolve({ ok: false, pid, error: 'taskkill 无法启动' }));
    child.on('exit', (code) => resolve({ ok: code === 0, pid, code }));
  });
}

// ---------------- 可启动的模型清单 ----------------

function readTextSafe(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    return '';
  }
}

/** 把 model_name 变成中文面板上好看的标签：Swift 1.5 IQ2_XS · 256K */
function labelFor(model, context) {
  const base = MODEL_LABELS[model] || model || '';
  const ctx = context ? Math.round(context / 1024) + 'K' : '';
  if (base && ctx) return base + ' · ' + ctx;
  return base || ctx || '';
}

/**
 * 扫描 D:\Strata\run-*.bat，并从每个脚本引用的 strata-*.json 里读出
 * 模型名与上下文长度，组成面板下拉菜单的选项。
 * 默认脚本（CFG.script）排最前；其余按名字排序。
 */
function listModels() {
  let files = [];
  try {
    files = readdirSync(CFG.dir);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of files) {
    if (!/^run-.*\.bat$/i.test(name)) continue;
    const text = readTextSafe(join(CFG.dir, name));
    const m = text.match(/(strata-[A-Za-z0-9_.-]+\.json)/);
    let model = '';
    let context = null;
    if (m) {
      try {
        const cfg = JSON.parse(readTextSafe(join(CFG.dir, m[1])));
        model = typeof cfg.model_name === 'string' ? cfg.model_name : '';
        const args = Array.isArray(cfg.args) ? cfg.args : [];
        const i = args.indexOf('--max-context');
        if (i >= 0) context = Number(args[i + 1]) || null;
      } catch (e) {
        /* 配置读不了就只显示脚本名 */
      }
    }
    out.push({ script: name, model, context, label: labelFor(model, context) || name });
  }
  out.sort(function (a, b) {
    if (a.script === CFG.script) return -1;
    if (b.script === CFG.script) return 1;
    return a.script.localeCompare(b.script);
  });
  return out;
}

/** 只允许启动清单里真实存在的脚本（防路径注入），否则回落到默认 */
function resolveScript(wanted) {
  const scripts = listModels().map(function (m) {
    return m.script;
  });
  if (typeof wanted === 'string' && scripts.indexOf(wanted) >= 0) return wanted;
  if (scripts.indexOf(CFG.script) >= 0) return CFG.script;
  return scripts[0] || CFG.script;
}

// ---------------- 启动 / 停止 ----------------

function startStrata(script) {
  const bat = resolveScript(script);
  if (launcherPid) {
    return { state: 'starting', pid: launcherPid, startedAt, script: launcherScript, note: 'already starting' };
  }
  let child;
  try {
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', bat], {
      cwd: CFG.dir,
      detached: true, // 脱离 DSH 进程组：DSH 重载/重启插件也不影响它
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (e) {
    lastStartError = errText(e);
    return { state: 'error', error: lastStartError, script: bat };
  }
  if (!child) {
    lastStartError = 'spawn 返回空';
    return { state: 'error', error: lastStartError, script: bat };
  }
  child.on('error', (e) => {
    lastStartError = errText(e);
  });
  child.unref();
  launcherPid = child.pid || null;
  startedAt = Date.now();
  launcherScript = bat;
  lastStartError = '';
  return { state: 'starting', pid: launcherPid, startedAt, script: bat };
}

async function stopStrata() {
  const targets = new Set();
  if (launcherPid) targets.add(launcherPid);
  for (const pid of await findListenerPids()) targets.add(pid);
  targets.delete(0);
  targets.delete(process.pid);

  const killed = [];
  const failed = [];
  for (const pid of targets) {
    const r = await killTree(pid);
    if (r.ok) killed.push(pid);
    else failed.push(r);
  }

  // taskkill 的退出码不可靠（进程已消失时会返回非 0），以“端口是否还在监听”为准
  let remaining = await findListenerPids();
  for (let round = 0; round < 2 && remaining.length; round++) {
    await new Promise((r) => setTimeout(r, 900));
    for (const pid of remaining) {
      const r = await killTree(pid);
      if (r.ok) killed.push(pid);
    }
    remaining = await findListenerPids();
  }

  launcherPid = null;
  startedAt = 0;
  launcherScript = '';
  return {
    state: 'stopped',
    portFree: remaining.length === 0,
    stillListening: remaining,
    killed: [...new Set(killed)],
    failed,
    attempted: [...targets],
  };
}

/** 引擎正忙时 /unload 会返回 409 {"status":"busy"}，重试几次 */
async function unloadWithRetry(attempts = 8, gapMs = 1200) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await control('/unload', 8000);
    if (last.ok) return { ...last, attempts: i + 1 };
    if (last.status !== 409) return { ...last, attempts: i + 1 };
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return { ...last, attempts, busy: true };
}

function launcherInfo() {
  if (launcherPid && startedAt && Date.now() - startedAt > START_GIVEUP_MS) {
    // 启动太久还没起来：放开，允许用户重新点「启动 Strata」
    launcherPid = null;
    startedAt = 0;
  }
  return {
    pid: launcherPid,
    starting: !!launcherPid,
    startingForS: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    script: launcherScript,
    lastStartError,
  };
}

// ---------------- 精简 /metrics（原始约 12 KB，面板只要这些）----------------

function trimMetrics(m) {
  if (!m || typeof m !== 'object') return null;
  const history = {};
  if (m.history && typeof m.history === 'object') {
    for (const k of ['gpu_util', 'tok_s', 'gpu_mem_used', 'cpu']) {
      if (Array.isArray(m.history[k])) history[k] = m.history[k].slice(-40);
    }
  }
  return {
    engine: m.engine || null,
    live: m.live || null,
    hardware: m.hardware || null,
    hardware_static: m.hardware_static || null,
    totals: m.totals || null,
    requests_kept: m.requests_kept ?? null,
    time: m.time ?? null,
    history,
  };
}

// ---------------- 路由 ----------------

/** 把 profile 里的 config 合并进 CFG；空串/空白都回落到默认值 */
function applyConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const base = str(c.strataBase) || DEFAULT_BASE;
  let port = 8080;
  try {
    const u = new URL(base);
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch (e) {
    port = 8080;
  }
  CFG = {
    base: base.replace(/\/+$/, ''),
    port,
    dir: str(c.strataDir) || DEFAULT_DIR,
    script: str(c.defaultScript), // 显式留空 = 用清单里第一个
  };
}

export function apply(ctx, config) {
  applyConfig(config);
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://dsh.local');
          const action = url.pathname.slice(PREFIX.length) || '/';

          // ---- 面板每 2 秒轮询这里 ----
          if (action === '/summary' && req.method === 'GET') {
            let launcher = launcherInfo();
            const health = await probe('/health');
            if (!health.reachable || !health.data) {
              writeJson(res, 200, { reachable: false, launcher, dir: CFG.dir, base: CFG.base });
              return;
            }
            // 服务已经起来了：启动器只是还挂着的 cmd.exe，不再算“正在启动”
            if (health.data.loaded) {
              launcher = { pid: launcherPid, starting: false, startingForS: 0, lastStartError };
            }
            const metrics = await probe('/metrics', 2500);
            writeJson(res, 200, {
              reachable: true,
              dir: CFG.dir,
              base: CFG.base,
              loaded: !!health.data.loaded,
              model: health.data.model ?? null,
              maxContext: health.data.max_context ?? null,
              images: !!health.data.images,
              service: health.data.service ?? null,
              metrics: trimMetrics(metrics.data),
              metricsOk: metrics.reachable,
              launcher,
            });
            return;
          }

          // ---- 可启动的模型清单（面板下拉菜单）----
          if (action === '/models' && req.method === 'GET') {
            writeJson(res, 200, { models: listModels(), default: resolveScript(CFG.script), dir: CFG.dir, base: CFG.base });
            return;
          }

          // ---- 启动：连不上就开进程；连得上但没加载模型就 /load ----
          if (action === '/start' && req.method === 'POST') {
            const raw = await readBody(req);
            let wanted = '';
            try {
              const j = JSON.parse(raw || '{}');
              if (j && typeof j.script === 'string') wanted = j.script;
            } catch (e) {
              /* 空 body 或非 JSON：用默认脚本 */
            }
            const health = await probe('/health');
            if (!health.reachable || !health.data) {
              writeJson(res, 200, startStrata(wanted));
              return;
            }
            if (!health.data.loaded) {
              // Strata 的 /load 会阻塞到模型真正载入（1~3 分钟）才回响应：
              // 这里只负责把请求发出去，不等它返回，面板靠轮询 /health 自己翻到「运行中」
              control('/load', 180000).catch(() => {});
              writeJson(res, 200, { state: 'loading', ok: true, note: '已发送加载请求，模型载入约需 1~3 分钟' });
              return;
            }
            writeJson(res, 200, { state: 'running' });
            return;
          }

          // ---- 卸载模型：服务留着，显存/内存释放 ----
          if (action === '/unload' && req.method === 'POST') {
            await readBody(req);
            writeJson(res, 200, await unloadWithRetry());
            return;
          }

          // ---- 加载模型 ----
          if (action === '/load' && req.method === 'POST') {
            await readBody(req);
            control('/load', 180000).catch(() => {});
            writeJson(res, 200, { state: 'loading', ok: true, note: '已发送加载请求，模型载入约需 1~3 分钟' });
            return;
          }

          // ---- 停止整个服务 ----
          if (action === '/stop' && req.method === 'POST') {
            await readBody(req);
            await control('/unload', 5000);
            const r = await stopStrata();
            writeJson(res, 200, r);
            return;
          }

          if (action === '/pids' && req.method === 'GET') {
            writeJson(res, 200, { launcher: launcherInfo(), listeners: await findListenerPids() });
            return;
          }

          writeJson(res, 404, { error: 'unknown action' });
        },
      }),
    'strata-monitor: /strata-monitor/api routes',
  );
}

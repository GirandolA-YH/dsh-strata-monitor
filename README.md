# strata-monitor

> 在 **DSH 右侧栏**加一个中文的「Strata 监控」面板：实时看本机 Strata 推理服务的性能，并直接在里面**启动 / 加载 / 卸载 / 停止** Strata。
> 不修改 DSH 源码，不修改 Strata 源码，纯插件实现。

---

## ⚠️ 开发者声明（请先阅读）

> 本插件制作者没有程序开发背景，使用 **Codex** 与 **DSH** 共同构建了该插件。
> 代码内容**仅通过 Agent 审计**，**未经过专业开发者的人工代码审计**。
> 对于后续发现的 bug 及 GitHub Issues，**建议使用者自行使用 Agent 进行修改和开发**。

由此带来几点实际影响，请自行评估后再使用：

- **本插件会操作你本机的进程**：它可以启动 `strataDir` 下的 `run-*.bat`，也可以 `taskkill` 掉占用 `127.0.0.1:8080` 的进程。请确认你清楚这一点再点按钮。
- 仓库维护者**不承诺**及时修复问题、提供技术支持或合并 PR；Issue 与 PR 可能长期无人处理。
- 提 Issue 前建议先让 Agent 读一遍 `lib/index.js`（约 500 行，纯 JS，无构建步骤），多数问题能自行定位。
- 报告问题时请附上：DSH 版本、插件版本、`curl "$env:DSH_WEB_URL/strata-monitor/api/summary"` 的返回、浏览器控制台报错。

---

## 目录

- [1. 能做什么](#1-能做什么)
- [2. 安装](#2-安装)
- [3. 配置](#3-配置)
- [4. 使用说明](#4-使用说明)
- [5. 工作原理](#5-工作原理)
- [6. 宿主端接口](#6-宿主端接口)
- [7. 卸载与回滚](#7-卸载与回滚)
- [8. 已知边界](#8-已知边界)
- [9. 授权](#9-授权)

---

## 1. 能做什么

一个右侧栏标签 **「Strata 监控」**，面板内容与 Strata 自带的监控页对齐（连字体和配色都是从 Strata 的 `serve/web/` 里搬过来的），刷新周期 **2 秒**；标签不在前台时**自动暂停轮询**，不产生后台请求。

| 区块 | 显示内容 |
| --- | --- |
| 顶部状态条 | 品牌「Strata 本机推理监控」+ 状态胶囊（空闲 / 读提示 · N% / 生成中 · N tok/s / N 个请求排队 / 模型未加载 / 正在启动 / Strata 未运行）+ 深浅色切换按钮 |
| 模型状态卡 | 5 个状态徽章（空闲 / 读提示 / 生成中 / 排队 / 出错，当前项高亮）+ 状态说明 + 进度条（读提示按 token 进度，生成中按已生成 / 上限） |
| 指标网格（8 块） | 速度（当前解码 + 平均预填充，双折线）、GPU 负载、显存、GPU 温度、功耗、PCIe、CPU、磁盘读取，每块带小趋势图 |
| 上下文占用卡 | 环形仪表（百分比 + 已用 / 上限）+ 3 条进度条：显存中的专家、系统内存（>92% 变红）、GPU 温度 |
| 引擎与累计卡 | 模型、引擎版本、上下文上限、KV 缓存、专家缓存、投机解码 MTP + 接受率、请求数、输入 tokens、前缀复用、输出 tokens、统计窗口 |
| 最近请求表 | 宿主转发 `requests` 时出现：时间 / 状态 / 输入 / 复用 / 输出 / Tok-s / 显存命中率 / 耗时 |

它还能**替你操作 Strata**，这是它存在的另一个理由 —— 不用再去翻那个命令行窗口：

| 当前状态 | 面板显示 | 可用按钮 |
| --- | --- | --- |
| `strataBase` 连不上，且没有正在启动的进程 | **Strata 未运行** | **模型下拉菜单** + 「启动 Strata」 |
| 已点过启动、端口还没起来 | **正在启动**（显示已 N 秒） | 「停止 Strata」 |
| 服务在跑但 `/health` 返回 `loaded:false` | **模型未加载** | 「加载模型」「停止 Strata」 |
| 服务在跑且模型已加载 | **运行中** + 全部指标 | 「卸载模型」「停止 Strata」 |

冷启动约 **1.5–3.5 分钟**（要把几十 GB 的专家权重读进内存），期间面板显示「正在启动 / 正在加载」而不是报错，并继续轮询。

---

## 2. 安装

### 2.1 前置依赖：`dsh-better-sidebar`

**面板是通过 `dsh-better-sidebar` 提供的 `sidebarRight` 服务注册到 DSH 右侧栏的**，所以它必需。

已在 `package.json` 的 `peerDependencies` 里声明（`">=0.19.0"`）。pnpm 默认的 `auto-install-peers` 会自动装上；如果你们的 profile 关掉了它，手动装：

```powershell
dsh plugin --profile <你的 profile> add dsh-better-sidebar@0.24.1
```

**万一缺了它会怎样**：右侧栏不会出现「Strata 监控」标签（宿主端路由 `/strata-monitor/api/*` 照常工作）。插件不会静默消失，它会主动提示你：

- 浏览器控制台打印一条带安装命令的警告
- **DSH 设置里出现一个「Strata 监控」分区**，写明缺什么、怎么装、以及宿主端不受影响

> 为什么提醒放在设置页：面板的显示本身就需要 better-sidebar 提供的插槽，所以提醒必须落在**不依赖它**的位置；DSH 自带的 `settings.section` 插槽正好满足。

### 2.2 安装插件（推荐：bundle 方式）

包内声明了 `dsh.bundle.patch`，所以 CLI 安装后会**自动**把它写进 profile 的 `dsh.profile.bundles` 并启用 —— **不需要手写任何 `insert`**：

```powershell
dsh plugin --profile <你的 profile> add github:<用户名>/<仓库>
```

也可以走界面：侧边栏 **Plugins** 页 → **Add plugins** → 填地址。

装完后：

- **Plugins** 页出现带开关的插件卡片（因为它是一个正规 bundle 了）
- **刷新页面（F5）**，右侧栏「+」菜单里出现「Strata 监控」

### 2.3 本机开发调试（手动挂载，可选）

只想在本机试、不走 CLI 时：

1. 把整个 `strata-monitor` 目录放进 profile 的 `node_modules`（**不要跑 `pnpm install`**）：

   ```powershell
   # desktop 换成你自己的 profile 名；<插件源码目录> 换成你 clone 下来的位置
   $profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
   $dst     = Join-Path $profile 'node_modules\strata-monitor'
   Copy-Item -Recurse -Force '<插件源码目录>\strata-monitor' $dst
   ```

   `package.json` 必须正好在 `node_modules\strata-monitor\package.json`，**不能多套一层同名目录**。

2. 在 profile 的 `cordis.patch.yml` 末尾追加（改前先备份）：

   ```yaml
   - insert:
       - id: strata-monitor
         name: 'strata-monitor'
   ```

   ⚠️ **手动 insert 和 bundle 挂载二选一**：包名已经在 `dsh.profile.bundles` 里时再写这段，同一个 id 会挂载两次而报错。

3. 自测（约 3–6 秒后生效）：

   ```powershell
   curl.exe -s "$env:DSH_WEB_URL/strata-monitor/api/summary"
   ```

   然后 **F5 刷新页面**，在右侧栏「+」菜单里选「Strata 监控」。

### 2.4 改完代码怎么生效

| 改了什么 | 怎么生效 |
| --- | --- |
| `lib/client.js`（客户端） | **F5 刷新页面**即可 |
| `lib/index.js`（宿主端） | **必须重启 DSH** —— HMR 不会重新导入宿主模块。实测：只改注释、只 bump 版本号、甚至改 `cordis.patch.yml` 触发 HMR，`/models` 仍是旧响应 |
| 插件的 `config`（见第 3 节） | 同上，**重启 DSH** |
| `package.json` 的 `dsh.profile.bundles` | HMR 监听 profile 清单，通常热生效；异常时重启 |

---

## 3. 配置

面板依赖的三个位置都能在 **profile 的 `cordis.patch.yml`** 里覆盖，**不需要改源码**：

```yaml
- insert:
    - id: strata-monitor
      name: 'strata-monitor'
      config:
        strataDir: 'E:\AI\Strata'            # Strata 装在哪
        strataBase: 'http://127.0.0.1:8080'  # 服务地址
        defaultScript: 'run-iq3_xxs.bat'     # 面板默认启动哪个
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `strataDir` | `D:\Strata` | Strata 安装目录。面板在这里找 `run-*.bat` / `strata-*.json`，起停进程时也用它 |
| `strataBase` | `http://127.0.0.1:8080` | Strata 服务地址。改端口就改这里（宿主会自己从 URL 推出端口号，用于 `netstat` 定位进程） |
| `defaultScript` | `run-swift-iq2_xs.bat` | 面板默认选中的启动脚本。**填 `''`（空字符串）** 则用清单里第一个 |

三个字段都可以省略，省略即用默认值。字段用 schemastery 声明，所以 **DSH 的设置页也能直接编辑**（属于这条插件行自己的配置）。

> **最需要改的场景**：Strata 装在别的盘或别的目录。不改 `strataDir` 的话，面板扫不到 `run-*.bat` → 下拉菜单为空、宿主启动进程失败（宿主路由本身仍然正常）。

---

## 4. 使用说明

### 4.1 打开面板

右侧栏「+」菜单（或按钮面板的加号）→ 选 **Strata 监控**。标签标题栏右键/拖动可以和其他标签并排或拆分。

### 4.2 四种状态与对应按钮

见 [第 1 节](#1-能做什么) 的状态表。要点：

- **「启动 Strata」**：连不上 `strataBase` 时出现。点击后宿主会 `cmd /c <你选的脚本>`（`detached` + `unref`，脱离 DSH 进程组），面板随即进入「正在启动」并显示已等待秒数。
- **「加载模型」**：服务在跑但模型被卸载过（`loaded:false`）时出现，等价于调 Strata 的 `POST /load`。
- **「卸载模型」**：调 `POST /unload`，把显存和专家缓存还给系统，**服务进程不退出**，所以面板指标还在。
- **「停止 Strata」**：先 `POST /unload`，再按 PID 杀进程树；**以 `netstat` 里端口是否还在监听为准**收尾。

> 如果你启动超过 10 分钟端口仍未起来，面板会放开「启动 Strata」按钮，允许你重试。

### 4.3 选择要启动的模型

Strata 装了多个模型时，「Strata 未运行」卡片会多一个**下拉菜单**，列出 `strataDir` 下全部 `run-*.bat`，并从每个脚本引用的 `strata-*.json` 里读出模型名和上下文，显示成 `Swift 1.5 IQ2_XS · 256K` 这样的标签。

- 默认选中 `defaultScript`（见第 3 节），它在清单里排第一
- 你的选择记在浏览器 `localStorage` 的 `strata-monitor.script`，下次打开还是它
- 只有**一个**启动脚本时不显示下拉，直接显示该模型名
- 宿主只接受清单里真实存在的脚本名（`resolveScript()` 会校验），带路径的字符串会被拒回默认值

**模型清单是动态扫描的**：以后用 `START-HERE.bat --setup` 加装了新模型，`run-*.bat` 一出现，刷新页面就能在下拉里看到，不用改插件代码。

> 注意：Strata 生成的启动脚本都带 `--open` 参数，所以每次从面板启动都会弹出一个 Strata 浏览器窗口 —— 和你手动双击脚本的行为一致。

### 4.4 常见操作

| 想做的事 | 怎么做 |
| --- | --- |
| 换模型启动 | 「停止 Strata」→ 下拉选另一个 → 「启动 Strata」 |
| 临时把显存让给游戏/剪辑 | 点「卸载模型」（服务留着，随时「加载模型」回来） |
| 完全释放内存 | 点「停止 Strata」 |
| 看某次请求的细节 | 面板的「最近请求表」（需要宿主转发 `requests`） |
| 排查面板本身的问题 | 看浏览器控制台 + `curl.exe -s "$env:DSH_WEB_URL/strata-monitor/api/pids"` |

---

## 5. 工作原理

```
浏览器面板  ──同源──>  $env:DSH_WEB_URL/strata-monitor/api/*   （DSH 宿主 Node 进程）
                                  │
                                  └──>  http://127.0.0.1:8080   /health  /metrics  /load  /unload
```

**为什么必须有宿主端代理**（浏览器不能直连 `:8080`）：

1. Strata 只对 `/v1/*` 且配置了 `cors_origins` 时才发 CORS 头，`/metrics` **永远没有** CORS 头 → 浏览器 `fetch` 必被拦。
2. `/load`、`/unload` 要求请求是 JSON 且**不能带外部 `Origin` 头**，浏览器直接调会 403。
3. **只有宿主端能开进程** —— 浏览器沙箱里没法 spawn。

所以浏览器只访问同源的 `/strata-monitor/api/*`，由宿主端 Node 用 `fetch()`（不发 `Origin`）代转，并负责开 / 杀进程。

路由前缀必须是 `/strata-monitor`：DSH 自己占用了 `/api`、`/plugins`、`/sidebar`，路由表不允许重复，冲突会直接抛错。

### 文件结构

```
strata-monitor/
├── package.json            name/version/license/exports + dsh.bundle.patch + dsh.client
├── cordis.patch.yml        bundle 补丁：插入插件自己的那一行
├── LICENSE                 MIT
├── THIRD-PARTY-NOTICES.md  内嵌字体的授权说明
├── licenses/
│   └── OFL-Outfit.txt      Outfit 字体的 SIL OFL 1.1 全文
└── lib/
    ├── index.js            宿主端（Node/ESM）：路由代理 + 起停进程 + 配置
    └── client.js           客户端（手写 bundle）：注册右侧栏标签并渲染面板
```

客户端 bundle 是**手写的，不需要构建工具链**：

```js
window.__ModuleLoader__.load({ id: 'strata-monitor', factory: (require) => { ... } });
```

- `id` 必须等于包名
- 只 `require('react')`；只用 `React.createElement`，不用 JSX
- 除了 `lib/`，没有任何编译产物

---

## 6. 宿主端接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/strata-monitor/api/summary` | 聚合 `/health` + `/metrics`（精简后约 2.7 KB），含 `reachable / dir / base / loaded / model / maxContext / metrics / launcher` |
| GET | `/strata-monitor/api/models` | 扫描 `strataDir` 下的 `run-*.bat`，从各自引用的 `strata-*.json` 读出模型名与上下文，返回 `{ models: [{script, model, context, label}], default, dir, base }`；默认脚本排最前 |
| GET | `/strata-monitor/api/pids` | 调试用：启动器 PID + 当前监听端口的 PID |
| POST | `/strata-monitor/api/start` | body 可带 `{"script":"run-xxx.bat"}`（只接受清单里真实存在的脚本）。连不上 → `cmd.exe /c <script>`；连得上但 `loaded:false` → 发出 `POST /load` 后**立即**返回 `{"state":"loading"}` |
| POST | `/strata-monitor/api/load` | 同 `/start` 的加载分支（发出请求即返回，不等 Strata 回包） |
| POST | `/strata-monitor/api/unload` | `POST /unload`；遇 `409 busy` 自动重试 8 次（间隔 1.2 s），仍失败返回 `{ok:false, status:409, attempts, busy:true}` |
| POST | `/strata-monitor/api/stop` | 先 `POST /unload`，再 `taskkill /PID <pid> /T /F` 杀进程树；以端口是否释放为准收尾，返回 `portFree / stillListening` |

**「停止」是怎么找到进程的**：优先用面板自己记录的启动器 PID；同时用 `netstat -ano -p tcp` 找出正在 `LISTENING <端口>` 的 PID 一并杀掉 —— 所以**你手动双击 bat 启动的 Strata，面板也停得掉**。

---

## 7. 卸载与回滚

**bundle 方式安装的（推荐路径）** —— 用 CLI 卸载最干净：

```powershell
dsh plugin --profile <你的 profile> remove strata-monitor
```

顺序是：从 `dsh.profile.bundles` 移除 → 卸载运行时贡献 → `pnpm remove`。

**手动挂载的**：

```powershell
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'   # 换成你的 profile 名

# 1) 从 package.json 的 dsh.profile.bundles 里删掉 "strata-monitor"（或恢复备份）
# 2) 删掉插件目录
Remove-Item -Recurse -Force (Join-Path $profile 'node_modules\strata-monitor')

# 3) 刷新页面
```

回滚后：右侧栏没有「Strata 监控」，`/strata-monitor/api/*` 返回 404，**DSH 与 Strata 均不受任何影响**。

---

## 8. 已知边界

- **依赖 `dsh-better-sidebar`**：缺了它客户端插件仍会激活，但只做两件事 —— 控制台警告 + 在设置页注册提醒分区；右侧栏标签不会出现，宿主端路由不受影响。
- **只监控一个实例**：一个 `strataBase`（默认 `127.0.0.1:8080`）。多开 Strata 需要装多份插件并配不同的 `strataBase`。
- **改宿主端必须重启 DSH**（见 2.4），这是 DSH 的模块加载机制，不是插件的选择。
- 标签不在前台时自动暂停轮询；启动超过 10 分钟端口仍连不上时放开「启动 Strata」允许重试。
- 卸载模型后**服务进程仍在**（`/health` 返回 `loaded:false`），显存与专家缓存内存会回落。
- **引擎正在生成时 `/unload` 会返回 `409 {"status":"busy"}`** —— 这是 Strata 的行为，不是插件的 bug。面板会提示「引擎一直在处理请求，N 次卸载都被拒」；等对话空闲再点。
- Strata 的 `/load` 会**阻塞到模型真正载入才回包**（实测约 90 秒），所以 `/api/start`、`/api/load` 都是「发出请求即返回」，面板靠 2 秒轮询自己翻回「运行中」。
- 实测时序（16 GB 显存的显卡 + 48 GB 内存，权重已在系统文件缓存中）：停止 → 再启动到 `loaded:true` 约 **99 秒**；卸载 → 重新加载约 **90 秒**。冷启动（文件缓存冷）更久，1.5–3.5 分钟是合理区间。
- 面板只读 Strata 的公开 HTTP 接口，**不读也不写** Strata 的模型文件。

---

## 9. 授权

**本插件以 MIT 授权发布**，见 [LICENSE](LICENSE)。

⚠️ 但 `lib/client.js` 里**内嵌了一份第三方字体**，它**不适用 MIT**：

| 组件 | 授权 | 说明 |
| --- | --- | --- |
| Outfit 字体（`FONT_B64`） | **SIL OFL 1.1** | Copyright 2021 The Outfit Project Authors；OFL 要求授权文本随字体分发 |

`licenses/OFL-Outfit.txt`（OFL 全文）与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 是**必需文件，不要删**。

如果你把内嵌字体换成系统字体（删掉 `FONT_B64`），就可以一并删掉这两个文件，届时整个包是纯 MIT。

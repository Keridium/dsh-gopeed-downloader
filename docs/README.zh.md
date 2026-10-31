# dsh-gopeed

[English](../README.md) | 中文

> 本文档面向中文用户；agent 请阅读英文版 [README.md](../README.md)。

把本机 **Gopeed** 下载器变成 **DeepSeek Harness (DSH)** 的 agent 工具，并在**插件配置页**里
提供可填写的「地址 / 端口 / Token」（外加一个可选的程序路径）。

- **6 个工具**：`gopeed_add` / `gopeed_list` / `gopeed_status` / **`gopeed_control`**（暂停/继续/删除）/
  **`gopeed_process`**（进程+API 诊断+版本）/ **`gopeed_launch`**（启动/重启）
- **进 system prompt 的常驻开销只有约 1100 字符**（约 270 token）：工具名 + 一行英文描述 + 极简参数；
  返回正文仍是中文。合并与精简过程见「六、实测记录」
- **工具自己会找人**：检测到 Gopeed 没装/没配好时，会直接在会话里追加一条中文分步说明
  （`deferContext`），不依赖用户去翻文档，也只发一次
- 只走回环（默认 `127.0.0.1:9999`），鉴权头 `X-Api-Token`，出网下载由 Gopeed 自己负责
- 实测环境：Gopeed **1.9.3**、DSH **web** profile（已装好并在运行）、DSH 自带 Node **v24**
- **不依赖用户机器上的 Node**：插件作为 cordis 插件跑在 DSH 主进程里，由 DSH 自带的运行时执行；
  子进程只用 Windows 自带的 `tasklist` / `taskkill` / `powershell.exe`（Windows PowerShell 5.1 即可，**不需要 pwsh 7**），
  全程 0 处调用 `node` / `npm` / `npx` / `pnpm`

---

## 一、目录结构

```
dsh-gopeed/
├─ package.json          # bundle 清单：dsh.bundle.patch + dsh.client（Web 端）
├─ cordis.patch.yml      # 往 profile 组合里插入一行 id=gopeed、name=dsh-gopeed
├─ index.js              # Host 半：Config + 注册 6 个工具
├─ client.js             # Web 半：配置表单（地址/端口/Token/程序路径）
├─ lib/api.js            # REST 客户端 + 任务归一化 + 进程探测/启动（不 import 任何 DSH 包）
├─ locale/{zh,en}.json   # 插件页显示用的标题与说明
├─ icon.svg
└─ node_modules/         # ⚠️ 只为本机 link: 安装准备的依赖副本，见「七」
   └─ @deepseek-ai/{schemastery,cosmokit}
```

配置项写在 **`index.js` 的 `Config`**（schemastery schema）里，五个字段全部 `.volatile()`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `host` | string | `127.0.0.1` | Gopeed 设置 → 高级 → 协议（TCP）的监听地址 |
| `port` | number | `9999` | 同上，端口 |
| `token` | string | `deepseek` | Gopeed 设置 → 高级 → Token |
| `timeoutMs` | number | `20000` | 单次 HTTP 请求超时（毫秒） |
| `exePath` | string | **空** | 可执行文件路径。**一般不用填**：留空时先找 Gopeed 默认安装路径，找不到再自动发现（见「五」）；只有绿色版/非标准安装才需要手填 |

`.volatile()` 是关键：**只有 volatile 字段才会出现在设置表单里，并且改完即时生效（不重挂插件、不用重启 DSH）**。
`token` 还带 `role('secret')`，读取链路里会被抹掉，前端只能看到「已设置 / 未设置」，不会回显明文。

---

## 二、安装

**不需要命令行、不需要 pnpm、也不需要本机装 Node**，全部用一个 DSH 工具完成：

1. 在任意会话里对 agent 说：「用 plugin_manager 安装这个 bundle，target 填插件目录的绝对路径」
   （对应 `install_bundle`，例如 `D:\path\to\dsh-plugin-gopeed`）
2. 重启 DSH

`install_bundle` 的 `target` 还可以填 **git URL**（如 `https://github.com/owner/dsh-gopeed`，
需要机器上有 `git`，装前会先跑一次 `git ls-remote` 探活）或 **tarball URL**
（如 `.../archive/refs/tags/v0.1.0.tar.gz`，走压缩包、**不需要 git**）。相对路径会被拒绝，必须是绝对路径。

卸载同理：`plugin_manager` 的 `remove_bundle`，`target` 填 `dsh-gopeed`，然后重启 DSH。

> 为什么强调这个：`pnpm` 是靠全局 Node 装的，换一台没装 Node 的机器就跑不了。
> `plugin_manager` 是 DSH 自带的能力，机器上只要有 DSH 就能用。

> **一个小技巧**：改完插件源码如果不想重启 DSH，可以调
> `plugin_manager` 的 `set_plugin`，对 `include:gopeed` 先 `enabled:false` 再 `enabled:true`。
> 实测这会让插件**重新执行 `apply()`**，工具描述、render 文案这类写在 `apply` 里的改动会立即更新。
> 但**模块顶层状态不保证重置**（模块级变量、顶层 import 可能保持原样），所以改了 `lib/` 下的模块、
> 顶层常量或 Config 之外的东西，仍以**重启 DSH** 为准。改了前端 `client.js` 则要刷新浏览器页面。

---

## 三、配置项在哪里填

**侧栏「插件」→「已安装」→ `Gopeed 下载器` → 行 `gopeed` → 「配置」**

| 界面标签 | 字段 | 填什么 |
|---|---|---|
| **地址** | `host` | `127.0.0.1` |
| **端口** | `port` | `9999` |
| **Token** | `token` | `deepseek`（和 Gopeed 里一致；密码框，留空 = 不修改） |
| **程序路径（可选）** | `exePath` | **留空即可**，插件会自动找到 Gopeed.exe |

Token 框留空就不会写回，旧 Token 保持有效。上方有实时的 `当前请求地址 http://host:port` 预览。
点保存立即生效。写入位置是 `profiles/web/cordis.patch.yml` 里 `id: gopeed` 的 `config`。

---

## 四、工具一览

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `gopeed_add` | `url` 必填，`path`/`name` 可选 | `taskId`、`url`、`name`、`path`、`baseUrl` | 新建下载任务 |
| `gopeed_list` | `status` 可选（`ready`/`running`/`pause`/`wait`/`error`/`done`） | `count` + 任务数组 | 列出所有任务 |
| `gopeed_status` | `id` | 单个任务 | 查进度 |
| `gopeed_control` | `id` + `action`（`pause`/`resume`/`remove`），`remove` 可带 `force` | `{ok,id,action,status,message}` | 暂停 / 继续 / 删除 |
| **`gopeed_process`** | 无 | 诊断结论 + 版本 + 安装路径 | **进程 + API 双重诊断；也是连通性/版本检查的入口** |
| **`gopeed_launch`** | `restart` 默认 false | `{launched,alreadyRunning,restarted,pid,apiState,message}` | **启动 / 强制重启** |

> `gopeed_control` 的 `force` **默认 `true`**：直接删会连已下载的文件一起删；
> 想保留文件要显式传 `force: false`。

任务对象是归一化后的扁平结构：

```json
{ "id":"0n37…", "name":"a.iso", "status":"running", "protocol":"http",
  "sizeBytes":11857955, "downloadedBytes":4200000, "percent":35.4, "sizeKnown":true,
  "speedBytesPerSec":1048576, "path":"D:\\Downloads", "createdAt":"…" }
```

---

## 五、Gopeed 卡了怎么办

先让 agent 跑 **`gopeed_process`**，它给五种结论：

| verdict | 含义 | 该怎么办 |
|---|---|---|
| `running` | API 正常响应 | 没事，正常用 |
| `unresponsive` | **端口通但没响应**（进程活着但卡住） | `gopeed_launch` 加 `restart=true` |
| `stopped` | 连接被拒绝（没启动） | `gopeed_launch`（等价双击图标） |
| `unauthorized` | 进程好的，Token 不对 | 去配置页改 Token |
| `unknown` | 端口/地址不对 | 检查地址、端口、Gopeed 的协议设置 |

`gopeed_process` 会同时给进程信息：能不能查到进程、pid、内存占用。**注意区分**：
`processProbe` 为 `unavailable` 时表示当前环境拿不到进程列表（权限受限），
这时 `processFound:false` **不代表进程没起**，必须以 API 结论为准——插件就是这么设计的，不会谎报。

### 启动 / 重启

```
gopeed_launch                 # 没在跑就启动；在跑就什么都不做
gopeed_launch {restart:true}  # 先结束进程再启动（救卡死）
```

**不用配路径**。启动前按下面顺序自动找 `Gopeed.exe`，找到第一个就停：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | 配置项 `exePath` | 只有手填过才用；用来覆盖绿色版/非标准安装 |
| 2 | **Gopeed 默认安装路径** | `%LOCALAPPDATA%\Programs\Gopeed\Gopeed.exe`、`%LOCALAPPDATA%\Gopeed\Gopeed.exe`。纯本地文件判断，**不启动任何子进程**，所以正常情况下零开销 |
| 3 | 正在运行的进程的 `Path` | 进程在跑就一定问得到真实路径（绿色版/自定义目录靠它兜底） |
| 4 | 注册表卸载项 | `DisplayIcon` / `InstallLocation` |
| 5 | 开始菜单 / 桌面 `Gopeed.lnk` | 解析快捷方式的 `TargetPath` |
| 6 | 其它常见路径 | `Program Files`、`Program Files (x86)`、`D:\Program Files` 等 |

3~5 步合并成**一次** PowerShell 调用（`Get-Process` + `Get-ItemProperty` + `WScript.Shell`），
只有第 2 步没命中时才会跑。结果缓存到进程内存（路径被删掉就自动重算）。

**全都找不到时**，不会瞎猜：`gopeed_process` 的 `advice` 和 `gopeed_launch` 的 `message` 会明确提示
「**请确认 Gopeed 是否已经安装；如果已安装（绿色版/非标准目录），请在插件设置页把「程序路径」填成 Gopeed.exe 的完整路径**」，
并把尝试过的位置一并列出来，方便你判断到底是没装还是路径特殊。

- 启动方式：`spawn(exePath, {detached:true, stdio:'ignore'}).unref()`，独立进程、不占终端、不阻塞，
  **效果等同双击图标**；启动后会轮询 API 最多 10 秒确认就绪。
- 重启方式：先 `taskkill /PID`（先礼后兵，失败再 `/F`），等 900ms 释放端口，再启动。
  会硬杀，未完成的下载靠 Gopeed 自己的断点续传恢复。
- **拿不到 pid 时不会假装成功**：会明确告诉你「重启需要 pid，但当前环境查不到进程列表」，
  并给出人工步骤（任务栏右键退出 Gopeed 后再 `gopeed_launch`）。

---

## 六、实测记录

### 已实测通过（2026-10-31）

**6 个工具全部真实调用过**，其中进程/启动相关：

```
gopeed_process → verdict=running  API: ok(5ms)  Gopeed 1.9.3 正常响应
                 进程: Gopeed.exe 在跑, pid 已脱敏, 内存 136 MB   ← probe=ok，真的查到了
                 可执行文件: %LOCALAPPDATA%\Programs\Gopeed\Gopeed.exe（默认安装路径）
                                                                 ← exePath 配的是空，全靠自动查找
gopeed_launch  → alreadyRunning=true, launched=false
                 "Gopeed 已经在运行，没有重复启动。要救卡死的进程请加 restart=true。"
```

其余：`gopeed_process`（返回 1.9.3 / windows / amd64 + 安装路径）、`gopeed_list`（正确读 `meta.res.size` 算进度）、
`gopeed_add` → `gopeed_status` → `gopeed_control`（pause / resume / remove）完整闭环，
`code:1000 task not found` 被识别成「无需暂停」而不抛错，错路径启动报 `ENOENT`，空端口报 `stopped`。

### 工具常驻开销：2714 → 1096 字符（约 1140 → 270 token）

DSH 每轮都会把每个工具的 `{name, description, parameters}` 投影进 system prompt（`output.schema`
和 render 不进），所以这部分是纯常驻成本。优化前后：

| 工具（合并前） | 字符 | 工具（合并后） | 字符 |
|---|---:|---|---:|
| `gopeed_add` | 508 | `gopeed_add` | 239 |
| `gopeed_list` | 311 | `gopeed_list` | 187 |
| `gopeed_status` | 232 | `gopeed_status` | 145 |
| `gopeed_pause` + `gopeed_resume` + `gopeed_remove` | 728 | `gopeed_control`（合并） | 283 |
| `gopeed_info` + `gopeed_process` | 581 | `gopeed_process`（合并） | 105 |
| `gopeed_launch` | 354 | `gopeed_launch` | 137 |
| **合计 9 个工具** | **2714** | **合计 6 个工具** | **1096（−60%）** |

做法：9 → 6 个工具（`pause/resume/remove` 合并成一个带 `action` 枚举的 `gopeed_control`，
`info` 并入 `gopeed_process`）、描述压成一行英文、参数描述几乎全删（靠名字和枚举自解释）、
参数 schema 不写 `additionalProperties:false`（与 DSH 原生 `defineTool` 产出的形状一致，
校验改在 `execute` 里做）。**功能没有删减**：所有能力都还在，只是入口收敛了。
上表左列的 `gopeed_pause` / `gopeed_resume` / `gopeed_remove` / `gopeed_info` 是历史工具名，现在已不存在。

### 检测到未就绪时，工具会主动找用户

用户不一定会去翻文档。所以任何工具在遇到「连不上 / 超时 / Token 不对」时，
会在结果之后用 `ToolRunContext.deferContext` 往会话里追加一条**中文分步说明**
（装 Gopeed → 开 TCP 协议 → 对 Token），全生命周期**只发一次**，且注入失败不影响工具本身的报错。
任务级错误（比如对不存在的 id 操作，`code:1000`）**不会**触发这条提示，避免打扰。

### 一个必须知道的坑：沙箱 vs 插件运行环境

| 环境 | `tasklist` | `Get-Process` | WMI |
|---|---|---|---|
| DSH 的 pwsh 工具（沙箱内） | ❌ Access denied | 只能看到少量进程 | ❌ 拒绝访问 |
| **插件（DSH 主进程内）** | ✅ 可用 | — | — |

也就是说：**用 `pwsh` 工具查进程查不到 Gopeed，不代表它没跑**。插件本身跑在 Host 主进程里，
权限正常，`tasklist` 能拿到真实 pid 和内存。所以进程诊断放在插件里做是对的，别用 shell 工具去判。

### 设置表单链路

复用 `dsh-settings` 的 `redactSecrets()` 验证过：字段是 `host/port/token/timeoutMs/exePath`（全部 volatile），
`token` 被标记为 `{"path":["token"],"set":true}` 且不出现在表单值里。

---

## 七、关于 `node_modules/`

`@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit` 按 `peerDependencies` 声明。
用 `link:` 方式安装时，Node 解析裸模块名看的是插件**真实路径**（即插件目录本身，通常在 profile 之外），
找不到 profile 的 `node_modules`，所以这里放了两份**同版本副本**（3.18.5 / 1.8.6，拷自 DSH 自带的）。
这两份副本**不进 Git 仓库**（已写进 `.gitignore`），它们只是本地 link 安装的解析补丁。

跨副本安全：cosmokit 的 volatile 标记用全局符号 `Symbol.for("cosmokit.volatile.write")`，
两份副本拿的是同一个 symbol，Host 的 `isVolatile()` 依然认。

这纯粹是 **ESM 模块解析**问题（插件的真实路径在 profile 外，裸模块名找不到），
**与用户机器上装没装 Node 无关**：运行时始终是 DSH 进程自己在执行这段代码。

若改成从 npm 正式安装，删掉这个 `node_modules/` 即可。

---

## 八、已知限制 / 没确认的部分

1. **`restart=true` 没做真机实测**：杀进程会中断你正在用的 Gopeed，所以没有擅自跑。
   已经把它的失败路径都测了（探测不可用时拒绝、ENOENT、无 pid），成功路径需要用户同意后再验一次。
2. **配置页的视觉排版没截图确认**：数据链路（slot key、`form.state/mutate`、字段投影、token 脱敏）都验过，
   但样式只是内联 CSS，没在浏览器里看过实际效果。
3. **BT / 磁力任务没实测**：代码按 `protocol` 透传，`meta.res` 缺失时降级为 `sizeKnown=false`。
4. **`gopeed_control` 的 `remove` 是幂等的**：Gopeed 1.9.3 对不存在的 id 执行 `DELETE` 也回成功，所以重复删除显示「已删除」。
5. **重启后"已就绪"是轮询 API 判断的**，如果 Gopeed 在加载界面时 API 已通，会提前报就绪（不影响使用）。

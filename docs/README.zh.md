# dsh-gopeed

[English](../README.md) | 中文

> 本文档面向中文用户；agent 请阅读英文版 [README.md](../README.md)。

把本机 **Gopeed** 下载器变成 **DeepSeek Harness (DSH)** 的 agent 工具，并在**插件配置页**里
提供可填写的「地址 / 端口 / Token」（外加程序路径、端口扫描与下载完成推送）。

- **7 个工具**：`gopeed_add` / `gopeed_list` / `gopeed_status` / **`gopeed_control`**（暂停/继续/删除）/
  **`gopeed_process`**（进程 + API 诊断 + 版本 + Webhook 状态）/ **`gopeed_launch`**（只在没跑时启动）/
  **`gopeed_events`**（读下载完成事件；auto 模式下可写 Webhook 配置）
- **进 system prompt 的常驻开销只有 1217 字符**（约 305 token，按 4 字符/token 粗略折算）：7 个工具的「名字 + 一段英文短语描述 + 极简参数」；
  工具返回的正文同样是英文（工具输出也属于 agent 可见内容）。合并与精简过程见「七、实测记录」
- **下载完成推送（Webhook）三模式**：`off`（默认，不监听）/ `manual`（插件监听，地址由你手动填进 Gopeed）/
  `auto`（插件监听，且允许 `gopeed_events action=apply` 把地址写进 Gopeed 配置）。详见「五」
- **通知不进对话**：右下角 toast（6 秒自动消失）+ `Agent.inject`（只进下一轮模型上下文，**不唤醒 agent**）。
  插件**不会**再往对话里发消息：旧的 `followup` / `deferContext` 已移除，那种做法会冒充用户发言
- **工具自己会找人**：检测到 Gopeed 没装/没配好时，会直接把英文分步说明写进**本次工具输出**（错误信息或
  `gopeed_process.advice`），不依赖用户去翻文档，也只发一次；它不是聊天消息
- 只走回环（端口**默认自动检测**：向 Windows 询问正在运行的 Gopeed 实际占用的端口；Gopeed 桌面版出厂是
  `127.0.0.1:0`，即每次启动随机端口，所以没有「默认端口」这回事，文中出现的任何具体数字都只是示例）；
  也可以先在 Gopeed 里钉死一个固定端口再在插件里填同一个数；鉴权头 `X-Api-Token`（Token 出厂为空 = 不鉴权），
  出网下载由 Gopeed 自己负责
- 实测环境：Gopeed **1.9.3**、DSH **web** profile（已装好并在运行）、DSH 自带 Node **v24**
- **不依赖用户机器上的 Node**：插件作为 cordis 插件跑在 DSH 主进程里，由 DSH 自带的运行时执行；
  子进程只用 Windows 自带的 `tasklist` / `taskkill` / `powershell.exe` / `netstat` / `netsh`
  （Windows PowerShell 5.1 即可，**不需要 pwsh 7**），全程 0 处调用 `node` / `npm` / `npx` / `pnpm`

---

## 一、目录结构

```
dsh-gopeed/
├─ package.json          # bundle 清单：dsh.bundle.patch + dsh.client（Web 端）
├─ cordis.patch.yml      # 往 profile 组合里插入一行 id=gopeed、name=dsh-gopeed
├─ index.js              # Host 半：Config + 注册 7 个工具 + Webhook 接收器 + 重启路由
├─ client.js             # Web 半：配置表单（地址/端口/Token/程序路径/Webhook）+ 右下角通知 + 重启按钮
├─ lib/api.js            # REST 客户端 + 任务归一化 + 进程探测/启动（不 import 任何 DSH 包）
├─ lib/webhook.js        # 回环 Webhook 接收器 + 50 条环形缓冲（同样不 import DSH）
├─ locale/{zh,en}.json   # 插件页显示用的标题与说明
├─ icon.svg
└─ node_modules/         # ⚠️ 只为本机 link: 安装准备的依赖副本，见「八」
   └─ @deepseek-ai/{schemastery,cosmokit}
```

配置项写在 **`index.js` 的 `Config`**（schemastery schema）里，九个字段全部 `.volatile()`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `host` | string | `127.0.0.1` | Gopeed 设置 → 高级 → 协议（TCP）的监听地址 |
| `port` | number | `0` | `0` = 自动检测：向 Windows 问出正在运行的 Gopeed 实际占用的端口。填数字才是钉死，且要先去 Gopeed 里把端口改成同一个数（Gopeed 新装是端口 `0`，每次启动随机，所以它没有「默认端口」） |
| `token` | string | **空** | Gopeed 的 API Token。Gopeed 出厂为空（不鉴权），所以默认留空；你在 Gopeed 里设了什么，这里就填一模一样的 |
| `timeoutMs` | number | `20000` | 单次 HTTP 请求超时（毫秒） |
| `exePath` | string | **空** | 可执行文件路径。**一般不用填**：留空时先找 Gopeed 默认安装路径，找不到再自动发现（见「六」）；只有绿色版/非标准安装才需要手填 |
| `portScan` | boolean | `false` | **默认关闭**。打开后允许插件扫本机动态端口范围来定位 Gopeed（Windows 不肯透露别的进程的端口时用得上）。会碰到无关软件的端口，属于有侵入性的可选项，接受才开 |
| `webhookMode` | enum `off` / `manual` / `auto` | `off` | 下载完成推送模式。`off` = 不监听任何端口；`manual` = 插件监听并显示地址，由你手动填进 Gopeed；`auto` = 同样监听，另外允许 `gopeed_events action=apply` 把地址写进 Gopeed 配置。详见「五」 |
| `webhookPort` | number | `0` | `manual` / `auto` 使用的回环端口，范围 0–65535。`0` = 由系统分配空闲端口（重启后地址会变）；填具体数字才能让地址固定，也才适合「一次填进 Gopeed 长期用」 |
| `webhookNotify` | boolean | `true` | 下载完成时显示右下角 toast，并给 agent 留一行上下文。需要 `manual` 或 `auto` 才有事件；**不会**写进对话，也**不会**唤醒空闲的 agent。设为 `false` 则事件只进缓存 |

`.volatile()` 是关键：**只有 volatile 字段才会出现在设置表单里，并且改完即时生效（不重挂插件、不用重启 DSH）**。
`token` 还带 `role('secret')`，读取链路里会被抹掉，前端只能看到「已设置 / 未设置」，不会回显明文。
配置页顶部还有一个版本徽标：如果它低于 `gopeed_process` 返回的 `pluginVersion`，说明浏览器还在用旧前端，需要重启 DSH。

---

## 二、安装

**不需要命令行、不需要 pnpm、也不需要本机装 Node**，全部用一个 DSH 工具完成：

1. 在任意会话里对 agent 说：「用 plugin_manager 安装这个 bundle，target 填插件目录的绝对路径」
   （对应 `install_bundle`，例如 `D:\path\to\dsh-plugin-gopeed`）
2. 重启 DSH

`install_bundle` 的 `target` 还可以填 **git URL**（如 `https://github.com/owner/dsh-gopeed`，
需要机器上有 `git`，装前会先跑一次 `git ls-remote` 探活）或 **tarball URL**
（如 `.../archive/refs/tags/v0.1.1.tar.gz`，走压缩包、**不需要 git**）。相对路径会被拒绝，必须是绝对路径。

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

> ⚠️ **端口的两种走法。** Gopeed 桌面版出厂监听 `127.0.0.1:0`——端口 `0` 表示**每次启动随机分配一个端口**。
> 插件默认端口也是 `0`，意思是「自己去问 Windows 现在这个 Gopeed 占的是哪个端口」，通常不用配就能通。
> 如果自动检测拿不到（权限受限，或进程探测不可用），就打开 Gopeed 的 **设置 → 高级 → 协议**，
> 把地址改成固定值（例如 `127.0.0.1:9999`），再在插件里填同一个端口数字。
> （1.9.3 的协议选项只有 **TCP** / **Unix socket**，没有 HTTP；也没有「启用 API」开关，API 一直开着。）

| 界面标签 | 字段 | 填什么 |
|---|---|---|
| **地址** | `host` | `127.0.0.1` |
| **端口** | `port` | `0`（**默认，自动检测**）；或在 Gopeed 里钉了固定端口时，填**同一个数字**（例如 `9999`） |
| **Token** | `token` | **留空即可**（Gopeed 出厂不鉴权）；若你在 Gopeed 里设过 Token，就填一模一样的值（密码框，留空 = 不修改） |
| **程序路径（可选）** | `exePath` | **留空即可**，插件会自动找到 Gopeed.exe |
| **Webhook 推送（下载完成通知）** | `webhookMode` | 三选一：`off`（默认，不启用）/ `manual`（手动配置）/ `auto`（自动配置）。详见「五」 |
| **Webhook 监听端口** | `webhookPort` | `0` = 系统分配（每次可能不同）；想让地址固定下来、方便一次填进 Gopeed，就填一个具体数字（例如随机生成的 2 万多端口） |
| （同属 Webhook 区块） | `webhookNotify` | 默认开：下载完成时弹右下角通知，并给 agent 留一行上下文。关掉则只缓存事件 |

Token 框留空就不会写回，旧 Token 保持有效。上方有实时的 `当前请求地址 http://host:port` 预览。
点保存立即生效。写入位置是 `profiles/web/cordis.patch.yml` 里 `id: gopeed` 的 `config`。

---

## 四、工具一览

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `gopeed_add` | `url` 必填，`path` 可选，`name` 可选 | `taskId`、`url`、`name`、`path`、`baseUrl` | 新建下载任务。`path` 是保存目录；`name` 是可选的显示名（不填则由 Gopeed 从链接推导） |
| `gopeed_list` | `status` 可选（`ready`/`running`/`pause`/`wait`/`error`/`done`） | `count` + 任务数组 | 列出所有任务 |
| `gopeed_status` | `id` | 单个任务 | 查进度 |
| `gopeed_control` | `id` + `action`（`pause`/`resume`/`remove`），`remove` 可带 `force` | `{ok,id,action,status,message}` | 暂停 / 继续 / 删除 |
| **`gopeed_process`** | 无 | 插件版本 + 诊断结论 + 版本 + 安装路径 + Webhook 状态 | **进程 + API 双重诊断；也是连通性/版本检查的入口** |
| **`gopeed_launch`** | **无（空参数 `{}`）** | `{launched,alreadyRunning,pid,apiState,message}` | **只在没跑时启动**。它不能重启，也不能杀进程 |
| **`gopeed_events`** | `since` 可选时间戳、`unreadOnly` 可选布尔、`action`（**只有 `apply`**） | `mode`、`listener`、`count`、`unread`、`events[]`、`applied`、`message` | 读 `DOWNLOAD_DONE` / `DOWNLOAD_ERROR` 事件；**仅 auto 模式**下 `action:"apply"` 会把监听地址写进 Gopeed 配置 |

> `gopeed_control` 的 `force` **默认 `true`**：直接删会连已下载的文件一起删；
> 想保留文件要显式传 `force: false`。

> `action` 只接受 `apply`。任何别的值（包括旧版本里那种「应用并重启」的组合词）都会被明确拒绝并说明原因——**没有哪个工具能重启或杀 Gopeed**。

任务对象是归一化后的扁平结构：

```json
{ "id":"0n37…", "name":"a.iso", "status":"running", "protocol":"http",
  "sizeBytes":11857955, "downloadedBytes":4200000, "percent":35.4, "sizeKnown":true,
  "speedBytesPerSec":1048576, "path":"D:\\Downloads", "createdAt":"…" }
```

---

## 五、下载完成推送（Webhook）与重启

Gopeed 在任务**完成或失败**时会主动 **POST** 一个事件（`DOWNLOAD_DONE` / `DOWNLOAD_ERROR`）到 Webhook 地址。
这是**推送**，不是插件轮询——插件不会去猜「下载好了没有」。

| 模式 | 监听 | 谁把地址填进 Gopeed |
|---|---|---|
| `off`（默认） | 不监听任何端口 | 没人；只能自己用 `gopeed_list` / `gopeed_status` 查 |
| `manual` | 监听 `127.0.0.1:<webhookPort>` | **你本人**在 Gopeed 里手动填 |
| `auto` | 同样监听 | 你明确要求时，由 `gopeed_events action=apply` 写入 |

监听地址固定是 `http://127.0.0.1:<port>/webhook`，只绑回环。

### `manual`：Gopeed 里必须做两件事，不是一件

配置页在 `webhookPort` **大于 0** 时会显示完整地址，并提供「复制」按钮。填 `0` 时页面**不显示地址**：
端口由系统随机分配，页面会提示你保存后用 `gopeed_events` 查看实际地址。想让地址固定下来、一次填进 Gopeed 长期用，
就在上面填一个具体端口。

拿到地址后，在 Gopeed 打开 **设置 → 开发者 → Webhook 推送**，**两件事都要做**：

1. 打开 **「启用 Webhook」** 开关；
2. 点 **「添加」**，把地址粘进去。

**只加地址、不打开开关，推送不会发出来。** 这是实测踩过的坑：列表里看起来已经配好了，插件却一条事件都收不到。
`manual` 模式下插件**绝不**去改 Gopeed 的设置，这两步只能由你完成。

### `auto`：插件替你写地址

`gopeed_events` 传 `action:"apply"` 是插件里**唯一**会写 Gopeed 配置的代码路径，并且**只有 `auto` 模式允许**。它会：

1. 先读当前配置（`GET /api/v1/config`）——读失败就什么都不写；
2. 只改 Webhook 字段：`webhook.enable = true`，并把监听地址**合并**进 `webhook.urls`（保留你已有的地址）；
3. 把整个配置写回（`PUT /api/v1/config`）；
4. **回读确认**：只有地址真的在配置里，才返回 `applied: true`。

`apply` 只写配置，**不会顺手重启 Gopeed**。

### 改完 Webhook 配置，必须「完全重启」Gopeed 才生效

Gopeed 只在**完全重启**后才会应用 Webhook 配置。**关窗口到托盘不算重启**——进程还在，用的还是旧配置。
GUI 里也可能一直显示旧值，所以「设置页看起来没变」并不代表写入失败。

**唯一的重启入口**是配置页上红色的 **「重启 Gopeed」** 按钮，它只做「杀掉并重新启动 Gopeed」这一件事：

1. **强制杀进程**（`taskkill /F`），并等到那个 pid 真的从进程表里消失；
2. 重新启动 Gopeed；
3. 轮询它的 API 最多 10 秒，确认真的回来了。

**这个按钮不写 Webhook 配置。** 把监听地址写进 Gopeed 是另一件事：`auto` 模式下由
`gopeed_events action=apply` 完成，`manual` 模式下由你手动添加。

按钮是红色、点击前有二次确认（会中断正在进行的下载）。

**为什么必须强制杀**：`taskkill` 不带 `/F` 只是「请求关闭」，Gopeed 收到后的反应是**最小化到托盘**——进程根本没死，
命令却返回成功。旧版本因此出现过「报告重启成功、实际什么都没重启」的假阳性。现在不带 `/F` 的软关闭不再使用，
并且以 pid 消失为唯一成功标准。

**任何 agent 工具都不能重启或杀进程**：`gopeed_launch` 没有 `restart` 参数，`gopeed_events` 只接受 `apply`。
这是故意的——杀下载器应该是用户的手动决定。

### 读事件

事件存在**内存环形缓冲，最多 50 条**，超出丢最旧的；插件重载或 DSH 重启后清空。`gopeed_events` 支持：

- `since`：时间戳，只返回更新的；
- `unreadOnly`：只返回还没被读过的。

**返回即标记已读**，所以连着调两次 `unreadOnly:true`，第二次通常为空。`gopeed_process` 也会报告 Webhook 状态，
不读缓冲也能判断链路通没通。

### 两个通知通道，都不进对话

`webhookNotify` 默认开着时，一条被接收的事件会走两条路：

- **右下角 toast**：由插件自己的前端渲染，6 秒自动消失。页面通过需要鉴权的
  `GET /api/dsh-gopeed/notifications` 轮询；这个通道**不会**把事件标记为已读，所以之后 `gopeed_events`
  看到的 unread 数仍然是对的。
- **`Agent.inject`**：同一份摘要作为模型可见上下文排进 agent 的**下一轮**。它**不唤醒 agent**，也不会渲染成聊天消息。

**插件不再往对话里发消息。** 旧的 `Agent.followup` 和 `ToolRunContext.deferContext` 都已移除：两者都会以
`role: 'user'` 的身份把插件文字送进会话，看起来就像用户自己说的。现在引导文字只出现在**工具自己的输出**里，
下载通知只走 toast 与 `inject`。把 `webhookNotify` 设为 `false`，事件就只进缓存。

---

## 六、Gopeed 卡了怎么办

先让 agent 跑 **`gopeed_process`**，它给六种结论：

| verdict | 含义 | 该怎么办 |
|---|---|---|
| `running` | API 正常响应 | 没事，正常用 |
| `unresponsive` | **端口通但没响应**（进程活着但卡住） | 点配置页的 **「重启 Gopeed」** 按钮（唯一的重启入口，会中断下载） |
| `misconfigured` | **进程在跑，但当前端口上没人应答**：程序没问题，端口不对 | 去 Gopeed「设置 → 高级 → 协议」看固定端口，填进插件配置；或把插件端口填 `0` 让插件自动检测 |
| `stopped` | 连接被拒绝，且进程确实没查到（没启动） | `gopeed_launch`（等价双击图标） |
| `unauthorized` | 进程好的，Token 不对 | 去配置页改 Token |
| `unknown` | 端口/地址不对，**或进程表读不出来** | 检查地址、端口、Gopeed 的协议设置；`processProbe` 为 `unavailable` 时不要当成 `stopped` |

`misconfigured` 是为了修掉过去的误判：进程明明在跑、只是端口对不上时，报 `stopped` 会让你去启动一个已经启动的程序。
它只在**进程探测确实能看到进程**时才会出现；探测被环境挡住时，结论仍以 API 证据为准。

**端口自动检测与 `portScan`**：端口填 `0` 时，插件先向 Windows 问「这个 `Gopeed.exe` 占用了哪些端口」
（`netstat -ano`，不行再用 `Get-NetTCPConnection`）。两条路都拿不到时，自检会如实说明端口无法确定并让你手填。
配置项 `portScan`（**默认关闭**）就是为这种情况准备的：打开后插件会扫本机动态端口范围，逐个用 `/api/v1/info` 探测。
因为它会连到与本插件无关的软件端口，属于**有侵入性的可选项**，默认不开。**检测失败时插件不会去猜一个端口**：
它如实报告端口未知，并请你在 Gopeed 里查到那个端口填进来。

> 0.2.0 修掉了一个会让「端口未知」永远不可达的 bug：旧代码 `Number(port) || 9999` 会把 `0` 当成假值变成 `9999`，
> 于是自动检测失败时悄悄去探测 9999，而不是坦白说端口没解析出来。现在没有这个 9999 兜底了。

`gopeed_process` 会同时给进程信息：能不能查到进程、pid、内存占用。**注意区分**：
`processProbe` 为 `unavailable` 时表示当前环境拿不到进程列表（权限受限），
这时 `processFound:false` **不代表进程没起**，必须以 API 结论为准——插件就是这么设计的，不会谎报。
PowerShell 探测现在会先自检「能不能看见自己的进程」：看不见就报 `unavailable`，而不是把空列表当成「Gopeed 没运行」。

### 启动 Gopeed

```
gopeed_launch    # 没在跑就启动；在跑就什么都不做
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
- **启动前探测的是「解析后的端口」，不是配置里那个原始值。** 旧版本在 `port=0` 时拿 `0` 去探测，必然误判「没运行」，
  然后重复启动第二个 Gopeed；已修。现在已经在跑就不会再启动。
- **它不会重启任何东西。** 没有 `restart` 参数了；进程卡死请引导用户去配置页点「重启 Gopeed」。
- **拿不到 pid 时不会假装成功**：重启路径会明确告诉你「重启需要 pid，但当前环境查不到进程列表」，并给出人工步骤。

---

## 七、实测记录

### 已实测通过（0.1.x 时期，2026-10-31）

当时那一版的所有工具都真实调用过，其中进程/启动相关：

```
gopeed_process -> verdict=running  API: ok(5ms)  Gopeed 1.9.3 responded normally
                  Process: Gopeed.exe is running, pid <hidden>, 136 MB   <- probe=ok，真的查到了
                  Executable: %LOCALAPPDATA%\Programs\Gopeed\Gopeed.exe (default install path)
                                                                         <- exePath 留空，全靠自动查找
gopeed_launch  -> alreadyRunning=true, launched=false
                  "Gopeed is already running (...); not starting it again."
```

（上面的输出原文是英文——工具返回文本属于 agent 可见内容，按语言策略一律英文。）

其余：`gopeed_process`（返回 1.9.3 / windows / amd64 + 安装路径）、`gopeed_list`（正确读 `meta.res.size` 算进度）、
`gopeed_add` → `gopeed_status` → `gopeed_control`（pause / resume / remove）完整闭环，
`code:1000 task not found` 被识别成「无需暂停」而不抛错，错路径启动报 `ENOENT`，空端口报 `stopped`。

0.2.0 的新增能力（Webhook 三模式、`gopeed_events`、通知通道、重启按钮）与修复项见 [CHANGELOG](../CHANGELOG.md)；
本轮的字符数则是直接在 0.2.0 代码上量出来的（见下表）。

### 工具常驻开销：2714 → 1217 字符（约 679 → 305 token，按 4 字符/token 粗略折算）

DSH 每轮都会把每个工具的 `{name, description, parameters}` 投影进 system prompt（`output.schema`
和 render 不进），所以这部分是纯常驻成本。9 个历史入口收敛成 7 个工具后：

| 工具（合并前） | 字符 | 工具（现在） | 字符 |
|---|---:|---|---:|
| `gopeed_add` | 508 | `gopeed_add` | 214 |
| `gopeed_list` | 311 | `gopeed_list` | 180 |
| `gopeed_status` | 232 | `gopeed_status` | 139 |
| `gopeed_pause` + `gopeed_resume` + `gopeed_remove` | 728 | `gopeed_control`（合并） | 268 |
| `gopeed_info` + `gopeed_process` | 581 | `gopeed_process`（合并） | 82 |
| `gopeed_launch` | 354 | `gopeed_launch` | 109 |
| — | — | `gopeed_events`（新增） | 225 |
| **合计 9 个工具** | **2714** | **合计 7 个工具** | **1217（−55%）** |

做法：`pause/resume/remove` 合并成一个带 `action` 枚举的 `gopeed_control`，`info` 并入 `gopeed_process`，
`gopeed_launch` 去掉 `restart` 参数，描述压成不重复 `gopeed_` 前缀的短语，参数描述只保留 `path`
（否则容易把「目录」误传成「文件路径」），参数 schema 不写 `additionalProperties:false`
（与 DSH 原生 `defineTool` 产出的形状一致，校验改在 `execute` 里做）。唯一不能靠参数名表达的语义
——`force` 会连文件一起删——写在 `gopeed_control` 的描述里。名字、`required` 数组、枚举值这些 schema 骨架刻意没动：
那才是 DSH 校验的东西，再压就只能删参数。**下载能力没有删减**。实测合计 **1217 字符，比最早的 1100 目标多 117**：
其中 `gopeed_events` 占 225，其余超支是刻意的取舍——保留 `name` 参数、两个枚举和 `required` 数组，
因为把真实存在的参数或合法取值藏起来，比这些字符省下的代价更大（模型会传错）。
上表左列的 `gopeed_pause` / `gopeed_resume` / `gopeed_remove` / `gopeed_info` 是历史工具名，现在已不存在。

### 检测到未就绪时，工具会主动找用户

用户不一定会去翻文档。所以任何工具在遇到「连不上 / 超时 / Token 不对」时，会把一条**英文分步说明**写进
**本次工具自己的输出**（异常信息，或 `gopeed_process.advice`），内容是「装 Gopeed → 在协议里固定端口 → 对齐 Token」
（英文是因为这段文字进的是 agent 上下文）。全生命周期**只发一次**，且拼装失败不影响工具本身的报错。
任务级错误（比如对不存在的 id 操作，`code:1000`）**不会**触发这条提示，避免打扰。

注意它**不是聊天消息**：`deferContext` 已被移除，插件不会以用户身份说话。

### 一个必须知道的坑：沙箱 vs 插件运行环境

| 环境 | `tasklist` | `Get-Process` | WMI |
|---|---|---|---|
| DSH 的 pwsh 工具（沙箱内） | ❌ Access denied | 只能看到少量进程 | ❌ 拒绝访问 |
| **插件（DSH 主进程内）** | ✅ 可用 | — | — |

也就是说：**用 `pwsh` 工具查进程查不到 Gopeed，不代表它没跑**。插件本身跑在 Host 主进程里，
权限正常，`tasklist` 能拿到真实 pid 和内存。所以进程诊断放在插件里做是对的，别用 shell 工具去判。

### 设置表单链路

复用 `dsh-settings` 的 `redactSecrets()` 验证过：字段是
`host/port/token/timeoutMs/exePath/portScan/webhookMode/webhookPort/webhookNotify`（全部 volatile），
`token` 被标记为 `{"path":["token"],"set":true}` 且不出现在表单值里。

---

## 八、关于 `node_modules/`

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

## 九、已知限制 / 没确认的部分

1. **强制重启会中断正在进行的下载**，所以它只做成配置页上的用户按钮，不开放给任何工具。
   失败路径会按阶段报告（`probe` / `not-running` / `executable` / `stop` / `launch` / `api`）；
   成功路径也不承诺保住下载进度。
2. **Webhook 能否送达，取决于 Gopeed 是否在完全重启后应用了配置。** 在那之前 GUI 可能显示旧值，
   事件一条也不会来；插件无法区分「Gopeed 里没开」和「开了但没重启」，两者看起来都是零事件。
3. **事件只在内存里**：环形缓冲 50 条，插件重载或 DSH 重启即清空，不落盘。
4. **配置页的视觉排版没截图确认**：数据链路（slot key、`form.state/mutate`、字段投影、token 脱敏）都验过，
   但样式只是内联 CSS，没在浏览器里看过实际效果。
5. **BT / 磁力任务没实测**：代码按 `protocol` 透传，`meta.res` 缺失时降级为 `sizeKnown=false`。
6. **`gopeed_control` 的 `remove` 是幂等的**：Gopeed 1.9.3 对不存在的 id 执行 `DELETE` 也回成功，所以重复删除显示「已删除」。
7. **重启后「已就绪」是轮询 API 判断的**，如果 Gopeed 在加载界面时 API 已通，会提前报就绪（不影响使用）。
8. **Webhook 监听只绑回环**：Gopeed 跑在 Docker 里或另一台机器上时，不额外做网络映射就推不过来。

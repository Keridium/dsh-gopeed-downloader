<p align="center">
  <img src="../icon.svg" width="88" height="88" alt="dsh-gopeed">
</p>

<h1 align="center">dsh-gopeed</h1>

<p align="center">
  <a href="../README.md">English</a> | 中文
</p>

> 本文档面向中文用户；agent 请阅读英文版 [README.md](../README.md)。

把本机 **Gopeed** 下载器变成 **DeepSeek Harness (DSH)** 的 agent 工具：新建和管理下载任务、
探测或启动 Gopeed 进程、接收下载完成事件（还能通过后台任务唤醒空闲的 agent）。
REST 类工具跨平台，进程控制仅支持 Windows。

- **7 个工具**：`gopeed_add` / `gopeed_list` / `gopeed_status` / **`gopeed_control`**（暂停/继续/删除）/
  **`gopeed_process`**（进程 + API 诊断 + 版本 + Webhook 状态）/ **`gopeed_launch`**（只在没跑时启动）/
  **`gopeed_events`**（读下载完成事件；auto 模式下可保存 Webhook 配置）
- **进 system prompt 的常驻开销只有 1452 字符**（约 363 token，按 4 字符/token 粗略折算）：7 个工具的「名字 + 一段英文短语描述 + 极简参数」；
  工具返回的正文同样是英文（工具输出也属于 agent 可见内容）。合并与精简过程见「七、实测记录」
- **下载保存位置可选，不是藏起来的默认值**：`downloadTarget` 三选一——`workspace`（默认，当前会话的工作区目录）/
  `gopeed`（交给 Gopeed 自己的下载目录）/ `custom`（用 `customDownloadPath`）。agent 显式传 `path` 时永远以它为准。
  目标目录解析不出来时会回落到 Gopeed 的目录，并在 `gopeed_add` 返回的 `jobNote` 里说明；任务创建后还会回读一次，
  因此返回的 `path` 是**实际落盘目录**，不是把入参原样抄回来
- **下载完成推送（Webhook）三模式**：`off`（默认，不监听）/ `manual`（插件监听，地址由你手动填进 Gopeed）/
  `auto`（插件监听，且允许 `gopeed_events action=apply` 把地址保存进 Gopeed 配置）。详见「五」
- **下载完成自动唤醒（0.3.0）**：`gopeed_add` 会把这次下载注册成 **DSH 后台任务**（`kind: "gopeed"`），
  下载结束时任务 settle，由 DSH 官方 `dsh-tool-jobs` 发出**它自己的**完成通知：agent 忙就下一轮读到，
  agent 空闲就**开新一轮把它唤醒**。通知文字属于 harness，插件不写任何用户身份的消息
- **通知不进对话**：右下角 toast（6 秒自动消失）+ `Agent.inject`（只进下一轮模型上下文，**不唤醒 agent**，
  现在只作为「没有后台任务覆盖」时的降级通道）。插件**不会**再往对话里发消息：
  旧的 `followup` / `deferContext` 已移除，那种做法会冒充用户发言
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
├─ client.js             # Web 半：配置表单（下载位置/地址/端口/Token/程序路径/Webhook）+ 右下角通知 + 重启按钮
├─ lib/api.js            # REST 客户端 + 任务归一化 + 进程探测/启动（不 import 任何 DSH 包）
├─ lib/webhook.js        # 回环 Webhook 接收器 + 50 条环形缓冲（同样不 import DSH）
├─ locale/{zh,en}.json   # 插件页显示用的标题与说明
├─ icon.svg
└─ node_modules/         # ⚠️ 只为本机 link: 安装准备的依赖副本，见「八」
   └─ @deepseek-ai/{schemastery,cosmokit}
```

配置项写在 **`index.js` 的 `Config`**（schemastery schema）里，十二个字段全部 `.volatile()`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `downloadTarget` | enum `workspace` / `gopeed` / `custom` | `workspace` | `gopeed_add` 把文件存到哪里。`workspace` = 当前会话自己的工作区目录；`gopeed` = 不传路径，让 Gopeed 用它在自己设置里配的下载目录；`custom` = 用 `customDownloadPath`。agent 显式传 `path` 时永远优先 |
| `customDownloadPath` | string | **空** | `downloadTarget` 为 `custom` 时使用的绝对目录，首尾空白会被裁掉。默认空，为空时回落到 Gopeed 自己的目录（配置页在输入框下方常驻说明这一点，placeholder 也写「留空 = Gopeed 默认目录」）；其它 target 下忽略 |
| `host` | string | `127.0.0.1` | Gopeed 监听地址（Gopeed 设置 → 高级 → 协议（TCP）里的那个地址）。**只填 IP 或主机名**：粘成 `http://…` 或 `127.0.0.1:9999` 会被当场拒绝；裸 IPv6 要写成方括号形式 `[::1]` |
| `port` | number | `0` | `0` = 自动检测：向 Windows 问出正在运行的 Gopeed 实际占用的端口。填数字才是钉死，且要先去 Gopeed 里把端口改成同一个数（Gopeed 新装是端口 `0`，每次启动随机，所以它没有「默认端口」） |
| `token` | string | **空** | Gopeed 的 API Token。Gopeed 出厂为空（不鉴权），所以默认留空；你在 Gopeed 里设了什么，这里就填一模一样的 |
| `timeoutMs` | number | `20000` | 单次 HTTP 请求超时（毫秒）。**配置页不渲染**，改 profile 的 `cordis.patch.yml` |
| `exePath` | string | **空** | 可执行文件路径。**一般不用填**：留空时先找 Gopeed 默认安装路径，找不到再自动发现（见「六」）；只有绿色版/非标准安装才需要手填。必须指向真正的 `.exe` 文件，填目录或 `.ini` 之类会被拒绝并回落到自动发现 |
| `portScan` | boolean | `false` | **配置页不渲染这个开关**。默认关闭；在 profile 配置里打开后，允许插件扫本机动态端口范围来定位 Gopeed（Windows 不肯透露别的进程的端口时用得上）。会碰到无关软件的端口，属于有侵入性的可选项，接受才开 |
| `webhookMode` | enum `off` / `manual` / `auto` | `off` | 下载完成推送模式。`off` = 不监听任何端口；`manual` = 插件监听并显示地址，由你手动填进 Gopeed；`auto` = 同样监听，另外允许 `gopeed_events action=apply` 把地址保存进 Gopeed 配置。详见「五」 |
| `webhookPort` | number | `0` | `manual` / `auto` 使用的回环端口，范围 0–65535。`0` = 由系统分配空闲端口（重启后地址会变）；填具体数字才能让地址固定，也才适合「一次填进 Gopeed 长期用」 |
| `webhookNotify` | boolean | `true` | **配置页没有这个开关**。有监听时，下载完成会给 agent 留一行上下文；`webhookToast` 打开时还会弹右下角 toast。需要 `manual` 或 `auto` 才有事件；**不会**写进对话，也**不会**唤醒空闲的 agent。设为 `false` 则事件只进缓存（需改 profile 配置） |
| `webhookToast` | boolean | `false` | 弹插件自己的右下角通知。**默认关闭**：Gopeed 自己已经会在 Windows 通知中心弹一条，插件再弹就是重复；想要更详细的信息（名称 / 大小 / 路径）才打开。它只影响给用户看的 toast——job 唤醒、`Agent.inject` 兜底和 `gopeed_events` 事件缓存都不受影响 |

`.volatile()` 是关键：**改完即时生效（不重挂插件、不用重启 DSH）**；但注意，并不是所有 volatile 字段都会被当前这张自定义表单渲染（见下）。
`token` 还带 `role('secret')`，读取链路里会被抹掉，前端只能看到「已设置 / 未设置」，不会回显明文。
配置页顶部还有一个版本徽标：如果它低于 `gopeed_process` 返回的 `pluginVersion`，说明浏览器还在用旧前端，需要重启 DSH。

> ⚠️ **三个没有表单控件的字段**：`timeoutMs`、`portScan` 和 `webhookNotify` 在 schema 里存在，但当前配置页**不渲染**它们。
> 需要改时，在对应 profile 的 `cordis.patch.yml` 里 `id: gopeed` 的 `config` 下直接写（例如 `portScan: true`），
> 再让配置重新加载 / 重启 DSH。普通用户一般不用动这几项。

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
| **下载位置** | `downloadTarget` | 三选一：**工作区**（默认，当前会话目录）/ **Gopeed 默认目录** / **自定义**。选「自定义」时下面会多出「自定义路径」输入框（`customDownloadPath`） |
| **自定义路径** | `customDownloadPath` | 只有选「自定义」时才出现。默认空；留空 = 回落到 Gopeed 自己的目录，填一个绝对目录（例如 `D:\Downloads`）才是真正的自定义路径。输入框下方和 placeholder 都会写明这一点 |
| **Gopeed 监听地址** | `host` | 默认 `127.0.0.1`，**必填**（留空会被拒绝保存）。**只填 IP 或主机名**，不要带 `http://`，也不要带端口；裸 IPv6 要写成 `[::1]` |
| **端口** | `port` | 默认 `0` = **自动检测**；留空会被拒绝保存（要自动检测就填 `0`），在 Gopeed 里钉了固定端口时则填**同一个数字**（例如 `9999`） |
| **Token** | `token` | 默认空 = 不发送 Token（Gopeed 出厂不鉴权）；若你在 Gopeed 里设过 Token，就填一模一样的值（密码框，留空 = 不修改已保存的 Token，这个表单也没有清空入口） |
| **程序路径（可选）** | `exePath` | 默认空 = 自动查找，插件会自动找到 Gopeed.exe；手填时必须是 `.exe` 文件，不能是目录 |
| **Webhook 推送（下载完成通知）** | `webhookMode` | 三选一：`off`（默认，不启用）/ `manual`（手动配置）/ `auto`（自动配置）。整块收在一个**默认折叠的抽屉**里，摘要行显示当前模式 |
| **Webhook 监听端口** | `webhookPort` | 默认 `0` = 系统分配空闲端口（每次可能不同），留空会被拒绝保存；想让地址固定下来、方便一次填进 Gopeed，就填一个具体数字（例如随机生成的 2 万多端口）。只在 `manual` 模式下显示 |
| （表单无此控件） | `webhookNotify` | 默认开，但配置页上**没有开关**；要关闭只能改 profile 配置。它控制下载完成时给 agent 留不留上下文（toast 另有 `webhookToast`） |
| （同属 Webhook 区块） | `webhookToast` | 默认关：打开后才会弹插件自己的右下角通知。只影响给人看的 toast，不影响 job 唤醒 |

Token 框留空就不会写回，旧 Token 保持有效。上方有实时的 `当前请求地址 http://host:port` 预览。
点保存立即生效。写入位置是 `profiles/web/cordis.patch.yml` 里 `id: gopeed` 的 `config`。

> 用户可见文案里不再出现「API」字样：字段叫「Gopeed 监听地址 / 端口 / Token」，Token 的提示只说「放在请求头里」。
> 它们仍然对应原来的 `host` / `port` / `token`，只是说法对人更友好。

---

## 四、工具一览

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `gopeed_add` | `url` 必填，`path` 可选，`name` 可选 | `taskId`、`url`、`name`、`path`、`baseUrl`、`jobId`、`jobNote` | 新建下载任务。`path` 是**可选的显式保存目录**；不传时由 `downloadTarget` 决定（见「下载保存到哪里」）。`name` 是可选的显示名（不填则由 Gopeed 从链接推导）。返回的 `path` 是回读到的**实际保存目录**。`jobId` 是跟踪这次下载的后台任务（宿主不支持时为空），`jobNote` 说明为什么没有，同时也承载保存路径的回落说明 |
| `gopeed_list` | `status` 可选（`ready`/`running`/`pause`/`wait`/`error`/`done`） | `count` + 任务数组 | 列出所有任务 |
| `gopeed_status` | `id` | 单个任务 | 查进度 |
| `gopeed_control` | `id` + `action`（`pause`/`resume`/`remove`），`remove` 可带 `force` | `{ok,id,action,status,message}` | 暂停 / 继续 / 删除 |
| **`gopeed_process`** | 无 | 插件版本 + 诊断结论 + 版本 + 安装路径 + Webhook 状态 | **进程 + API 双重诊断；也是连通性/版本检查的入口** |
| **`gopeed_launch`** | **无（空参数 `{}`）** | `{launched,alreadyRunning,pid,apiState,message}` | **只在没跑时启动**。它不能重启，也不能杀进程 |
| **`gopeed_events`** | `since` 可选时间戳、`unreadOnly` 可选布尔、`action`（**只有 `apply`**） | `mode`、`listener`、`count`、`unread`、`events[]`、`applied`、`message` | 读 `DOWNLOAD_DONE` / `DOWNLOAD_ERROR` 事件；**仅 auto 模式**下 `action:"apply"` 会把监听地址保存进 Gopeed 配置 |

> `gopeed_control` 的 `force` **默认 `true`**：直接删会连已下载的文件一起删；
> 想保留文件要显式传 `force: false`。

> `action` 只接受 `apply`。任何别的值（包括旧版本里那种「应用并重启」的组合词）都会被明确拒绝并说明原因——**没有哪个工具能重启或杀 Gopeed**。

任务对象是归一化后的扁平结构：

```json
{ "id":"0n37…", "name":"a.iso", "status":"running", "protocol":"http",
  "sizeBytes":11857955, "downloadedBytes":4200000, "percent":35.4, "sizeKnown":true,
  "speedBytesPerSec":1048576, "path":"D:\\Downloads", "createdAt":"…" }
```

### 下载保存到哪里

保存目录按下面的顺序决定，命中即停：

1. `gopeed_add` 显式传入的 `path`；
2. `downloadTarget` 为 `workspace`（默认）时，调用方会话自己的工作区目录；
3. `downloadTarget` 为 `custom` 且 `customDownloadPath` 非空时，用这个目录；
4. 否则不传路径，由 **Gopeed** 用它自己设置里的下载目录。

回落不会静默发生：会话工作区取不到（宿主没有暴露 `session.header.cwd`），或者选了 `custom` 但路径为空时，
下载仍然会落到 Gopeed 的目录，同时 `jobNote` 明确写出用了哪个回落。

`gopeed_add` 还会在创建成功后回读一次任务：即使没传路径，Gopeed 也会把实际目录填进 `meta.opts.path`。
所以返回里的 `path` 是文件真正落盘的位置，而不是把调用方的入参（可能为空）原样抄回去。这次回读是尽力而为——
读失败不会把 Gopeed 已经接受的任务判成失败。

---

## 五、下载完成推送（Webhook）与重启

Gopeed 在任务**完成或失败**时会主动 **POST** 一个事件（`DOWNLOAD_DONE` / `DOWNLOAD_ERROR`）到 Webhook 地址。
这是**推送**，不是插件轮询——插件不会去猜「下载好了没有」。

| 模式 | 监听 | 谁把地址填进 Gopeed |
|---|---|---|
| `off`（默认） | 不监听任何端口 | 没人；只能自己用 `gopeed_list` / `gopeed_status` 查 |
| `manual` | 监听 `127.0.0.1:<webhookPort>` | **你本人**在 Gopeed 里手动填 |
| `auto` | 同样监听 | 你明确要求时，由 `gopeed_events action=apply` 保存 |

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

### `auto`：插件替你保存地址

`gopeed_events` 传 `action:"apply"` 是插件里**唯一**会保存 Gopeed 配置的代码路径，并且**只有 `auto` 模式允许**。它会：

1. 先读当前配置（`GET /api/v1/config`）——读失败就什么都不保存；
2. 只改 Webhook 字段：`webhook.enable = true`，并把监听地址**合并**进 `webhook.urls`（保留你已有的地址）；
3. 把整个配置写回（`PUT /api/v1/config`）；
4. **回读确认**：只有地址真的在配置里，才返回 `applied: true`。

`apply` 只保存配置，**不会顺手重启 Gopeed**。

### 改完 Webhook 配置，必须「完全重启」Gopeed 才生效

Gopeed 只在**完全重启**后才会应用 Webhook 配置。**关窗口到托盘不算重启**——进程还在，用的还是旧配置。
GUI 里也可能一直显示旧值，所以「设置页看起来没变」并不代表保存失败。

**唯一的重启入口**是配置页上红色的 **「重启 Gopeed」** 按钮，它只做「杀掉并重新启动 Gopeed」这一件事：

1. **强制杀进程**（`taskkill /F`），并等到那个 pid 真的从进程表里消失；
2. 重新启动 Gopeed；
3. 轮询它的 API 最多 15 秒（期间不断重新检测端口），确认真的回来了。

**这个按钮不保存 Webhook 配置。** 把监听地址保存进 Gopeed 是另一件事：`auto` 模式下由
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

### 三个通知通道，都不进对话

一次下载完成最多走三条路，**都不会**往对话里写消息：

1. **后台任务（主通道，也是唯一能唤醒 agent 的通道）**：`gopeed_add` 会把它刚创建的任务注册成 DSH 后台任务，
   任务结束时由 DSH 自己的 `dsh-tool-jobs` 发出会话内完成通知——agent 忙就在下一步读到，空闲就被开新轮唤醒。
   通知文字属于 harness，插件不冒充用户。详见下面「下载完成自动唤醒」。
2. **右下角 toast（默认关闭，给人看）**：`webhookToast` 默认关，因为 Gopeed 自己已经会在 Windows 通知中心
   弹一条，插件的 toast 会和它重复；打开后由插件自己的前端渲染，6 秒自动消失。页面通过需要鉴权的
   `GET /api/dsh-gopeed/notifications` 轮询；这个通道**不会**把事件标记为已读，所以之后 `gopeed_events`
   看到的 unread 数仍然是对的。
3. **`Agent.inject`（降级通道）**：只用于**没有后台任务覆盖**的完成——你在 Gopeed 界面里自己加的下载、
   别的客户端加的下载，或宿主根本没装 `ctx.jobs`。同一份摘要作为模型可见上下文排进 agent 的**下一轮**，
   它**不唤醒 agent**，也不会渲染成聊天消息。**后台任务已经覆盖的任务不会再 inject**：两条通道说的是同一件事，
   实测中发现模型会因此读到两遍。

`webhookNotify`（默认开）管第 2、3 条，但第 2 条还需要 `webhookToast` 也打开；第 1 条由 `gopeed_add` 触发，
不依赖 Webhook，所以 `webhookMode: off` 时 agent 自己发起的下载照样有完成通知。

Webhook 整块在配置页里收进一个**默认折叠的抽屉**，摘要行显示当前模式；抽屉外常驻一段职责说明：
「下载完成自动唤醒」由 DSH 后台任务负责，**不依赖 webhook**，webhook 只是可选增强。

**插件不再往对话里发消息。** 旧的 `Agent.followup` 和 `ToolRunContext.deferContext` 都已移除：两者都会以
`role: 'user'` 的身份把插件文字送进会话，看起来就像用户自己说的。现在引导文字只出现在**工具自己的输出**里，
下载通知只走上面三条通道，而「唤醒」这一条是 DSH 官方的，不是插件伪造的。把 `webhookNotify` 设为 `false`，
Webhook 事件就只进缓存（第 1 条不受影响）。

### 下载完成自动唤醒（DSH 后台任务）

拿 `gopeed_status` 一轮一轮查进度是错的做法：每查一次烧一步，文件真下完时 agent 也没有可回应的东西。
所以 `gopeed_add` 同时把这次下载注册成 **DSH 后台任务**（`kind: "gopeed"`，id 形如 `gopeed-<16 位十六进制>`），
下载结束时由 DSH 通知 agent。

实际行为：

- `gopeed_add` 返回 `jobId`，工具描述里就写明它跑在**后台**、结束时会给本会话发通知；它自己的输出里也会写明
  `Tracking job: gopeed-…` 和对应的 `job_output` 调用，并明确说**不要轮询、也不用等**（通知到了再读）；
  只有没拿到 job 的分支才会建议改用 `gopeed_status` 查；
- 任务每 **3 秒**查一次 Gopeed；任务处于 `pause` / `wait` 时放慢到 **30 秒**一次——暂停的下载不是进展，
  全速轮询毫无收益；
- 下载完成 → settle 为 `completed`，detail 带文件大小；Gopeed 报 `error` → `failed`；
  任务从 Gopeed 里消失 → `killed`；
- 随后 `dsh-tool-jobs` 发出**它自己的**完成通知 `background job gopeed-… (gopeed: download x.iso) finished
  [status: completed, …]`：agent 忙就在下一步读到，空闲就被**开新一轮唤醒**。这是 DSH 官方机制
  （`ctx.jobs` + `dsh-tool-jobs` 的 completion notice），**不是**插件伪造的用户消息，插件也不会往对话里加东西；
- `gopeed_control action:"remove"` 会取消对应的跟踪任务，删掉的下载不会留下野轮询；
- `job_output <jobId>`（可加 `wait: true`）读取任务，最多阻塞到配置的超时。最终回答前用它收任务，别轮询。

**降级一定说出来。** 宿主没有 `ctx.jobs`，或没有 controller 服务于调用方 session 时，`gopeed_add` 照样能用：
`jobId` 为 `""`，`jobNote` 说明原因，也就是不会有完成通知。这种情况用 `gopeed_status` 或 Webhook 通道跟进。

**暂停不是失败。** 任务连续 24 小时停在 `pause` / `wait` 就停止跟踪，并以 `killed` +「task still pause,
download NOT cancelled」结束——`failed` 只留给 API 连不上或 Gopeed 报 `error` 的情况。一直在动的下载同样在
24 小时后停止跟踪，detail 也会说明下载本身没被动过。

**插件重载与 DSH 重启：**

- **插件重载（或 profile 重新挂载）**会停掉所有跟踪器。每个都 settle 成 `killed`，detail 明确写「插件已卸载、
  下载状态未知、Gopeed 里的任务可能还在下」。这样措辞是因为插件确实再也看不到这次下载了，而 DSH 的结果词汇里
  没有「未知」这个状态，detail 是唯一诚实的位置。
- **DSH 重启会彻底丢失跟踪**：后台任务活在 DSH 进程里。下载本身继续在 Gopeed 里跑，`gopeed_status` 依旧看得到。
  见「九、已知限制」。

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
配置项 `portScan`（**默认关闭**，配置页不渲染，需改 profile 的 `cordis.patch.yml`）就是为这种情况准备的：打开后插件会扫本机动态端口范围，逐个用 `/api/v1/info` 探测。
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
  **效果等同双击图标**；启动后会轮询 API 最多 15 秒确认就绪。
- **启动确认会边等边重新检测端口。** 新启动的 Gopeed 会换一个新的随机端口，而这个端口要等进程真正开始监听后才存在；
  如果整个等待期只探测一个旧端口，就会把启动成功报成失败。现在 15 秒预算内每约 700 毫秒重新检测并探测一次，
  和重启路径用的是同一套修法。
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
本轮的字符数则是直接在 **0.3.0** 代码上量出来的（见下表）。

0.3.0 补充实测：

- **BT / 磁力做了浅测**：用 Debian 13.7 netinst ISO 的官方磁力链接端到端验证——metadata 解析出 756 MB、
  开始下载约 4 MB/s、跟踪 job 能正常跟上结束。没有 peers 的磁力、只靠 DHT、私有 tracker、重启后继续
  磁力任务这些更难的场景仍未验证。

### 工具常驻开销：2714 → 1452 字符（约 679 → 363 token，按 4 字符/token 粗略折算）

DSH 每轮都会把每个工具的 `{name, description, parameters}` 投影进 system prompt（`output.schema`
和 render 不进），所以这部分是纯常驻成本。9 个历史入口收敛成 7 个工具后（当前工作树实测，未发布）：

| 工具（合并前） | 字符 | 工具（现在） | 字符 |
|---|---:|---|---:|
| `gopeed_add` | 508 | `gopeed_add` | 359 |
| `gopeed_list` | 311 | `gopeed_list` | 191 |
| `gopeed_status` | 232 | `gopeed_status` | 155 |
| `gopeed_pause` + `gopeed_resume` + `gopeed_remove` | 728 | `gopeed_control`（合并） | 268 |
| `gopeed_info` + `gopeed_process` | 581 | `gopeed_process`（合并） | 110 |
| `gopeed_launch` | 354 | `gopeed_launch` | 134 |
| — | — | `gopeed_events`（新增） | 235 |
| **合计 9 个工具** | **2714** | **合计 7 个工具** | **1452（−47%）** |

做法：`pause/resume/remove` 合并成一个带 `action` 枚举的 `gopeed_control`，`info` 并入 `gopeed_process`，
`gopeed_launch` 去掉 `restart` 参数，描述压成不重复 `gopeed_` 前缀的短语，参数描述只保留 `path`
（否则容易把「目录」误传成「文件路径」），参数 schema 不写 `additionalProperties:false`
（与 DSH 原生 `defineTool` 产出的形状一致，校验改在 `execute` 里做）。唯一不能靠参数名表达的语义
——`force` 会连文件一起删——写在 `gopeed_control` 的描述里。名字、`required` 数组、枚举值这些 schema 骨架刻意没动：
那才是 DSH 校验的东西，再压就只能删参数。**下载能力没有删减**。实测合计 **1452 字符，比最早的 1100 目标多 352**：
其中 `gopeed_events` 净增 117（235 减去其余六个工具原本比 1100 目标少的 118），0.3.0 重写五条描述又加了 122（早期误记为 126，重新实测后修正），后续的背景任务措辞修订又加了 39，保存目录参数的说明又加了 37，文件名参数的说明又加了 37，117 + 122 + 39 + 37 + 37 = 352。其余取舍是刻意的——保留 `name` 参数、两个枚举和
`required` 数组，因为把真实存在的参数或合法取值藏起来，比这些字符省下的代价更大（模型会传错）。
上表左列的 `gopeed_pause` / `gopeed_resume` / `gopeed_remove` / `gopeed_info` 是历史工具名，现在已不存在。

0.3.0 的「下载完成自动唤醒」**本身没有增加常驻开销**：`gopeed_add` 只在 `output.schema` 里多了 `jobId` / `jobNote`，
而 `output.schema` 不进 system prompt；`parameters` 一个字没动。真正让总数从 **1217 涨到 1339** 的是另一项 0.3.0 改动（后续措辞修订又加到 1452）：
`gopeed_add` / `gopeed_list` / `gopeed_status` / `gopeed_process` / `gopeed_launch` 五条描述从原来的极短片段
（如 `Create task.`）改成了说清「能做什么 + 边界」的一句话，合计 +122 字符。保存路径、host 校验、启动重探测和
toast 开关都没有新增 prompt 文本。

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
`downloadTarget/customDownloadPath/host/port/token/timeoutMs/exePath/portScan/webhookMode/webhookPort/webhookNotify/webhookToast`（全部 volatile），
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
5. **BT / 磁力任务只做了浅测**：用一个 Debian 13.7 netinst ISO 的官方磁力链接端到端验证过——metadata 解析出 756 MB、开始下载约 4 MB/s、跟踪 job 正常。更少见的场景（没有 peers、只靠 DHT、私有 tracker、重启后继续磁力任务）仍未验证。`meta.res` 缺失时会降级为 `sizeKnown=false`，而不是编一个百分比。
6. **`gopeed_control` 的 `remove` 是幂等的**：Gopeed 1.9.3 对不存在的 id 执行 `DELETE` 也回成功，所以重复删除显示「已删除」。
7. **重启后「已就绪」是轮询 API 判断的**，如果 Gopeed 在加载界面时 API 已通，会提前报就绪（不影响使用）。
8. **Webhook 监听只绑回环**：Gopeed 跑在 Docker 里或另一台机器上时，不额外做网络映射就推不过来。
9. **下载跟踪不能跨 DSH 重启存活**：跟踪任务是 DSH 进程内的后台任务，DSH 重启（或插件升级）就全丢了；
   下载本身继续在 Gopeed 里进行，`gopeed_status` 仍能看到。没有持久化、也没有「重新接管」——那需要可持久化的
   job 后端，超出本插件的范围。插件重载至少会如实报告：每个还活着的跟踪器 settle 成 `killed`，detail 写明
   下载状态未知。

---

## 十、致谢与非官方声明

本插件是一个**独立的、非官方的**集成。它通过 REST API 与本地运行的
[Gopeed](https://github.com/GopeedLab/gopeed)（一个支持 HTTP / BitTorrent / 磁力 / ed2k 的现代下载器）通信，
**不打包、不链接、不修改、也不分发** Gopeed 的任何代码：两者是各自独立的进程，唯一的契约就是那条回环 HTTP API。

- **Gopeed** 版权归 GopeedLab 作者所有，采用 **GPL-3.0** 许可。按它自己的许可证使用、安装和分发 Gopeed，
  本插件不改变这一点。
- **本插件**采用 MIT 许可，**不是** GopeedLab 项目的产物，也未经其背书或支持。关于 Gopeed 本身的
  bug 请提到 Gopeed 的仓库，而不是这里。

如果这个插件对你有用，功劳大部分在上游：是 Gopeed 团队做出了这个程序，以及让这一切成为可能的 API。

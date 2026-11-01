# 交接：DSH web 启动时 gopeed 插件加载失败（2026-11-01）

## 一句话结论

插件包从 `dsh-gopeed` 改名为 `dsh-gopeed-downloader` 后，`client.js` 里两处**硬编码的旧包名**没有跟着改，导致 DSH web 的客户端模块加载器认为"脚本加载了但没有注册对应模块"，于是启动时报插件加载失败。宿主侧（`index.js`）没有问题。

## 证据链

### 1. 加载器认的是"包名"，不是包里的任意 id

DSH 客户端模块系统按 `/plugins/<id>/client.js` 提供每个插件的浏览器脚本，`id` 就是 **package name**。脚本执行后，加载器要求它通过 `__ModuleLoader__.load({ id })` 注册的 id 与清单里的行 id 完全相等：

- `@deepseek-ai/dsh-client-modules/lib/client.js:743` `arrive(row)`：
  - 加载成功后若 `this.factories.has(id)` 为假 → `failures.push(\`${url}: loaded without registering "${id}" via __ModuleLoader__.load\`)`，判定 `not-registered`；
  - 最终抛 `client-modules: could not load "<id>": <失败详情>`。
- 同文件 `:503` / `:552`：行没有 fiber 时抛 `client-modules: ${id} import failed (see console)`。

### 2. 本插件的 id 还是旧名

- `package.json` → `"name": "dsh-gopeed-downloader"`
- `client.js:20` → `window.__ModuleLoader__.load({ id: 'dsh-gopeed', ... })`

两者不一致 ⇒ 每次 web 启动都必然 `not-registered`。

横向对比（同一 profile 下其它插件，id 全部等于包名）：

| 包名 | `__ModuleLoader__.load` 的 id |
| --- | --- |
| `dsh-mnemon` | `dsh-mnemon` |
| `dsh-free-search` | `dsh-free-search` |
| `dshmarket` | `dshmarket` |
| `@weibaohui/dsh-file-share` | `@weibaohui/dsh-file-share` |
| `@michengai/dsh-archive-manager` | `@michengai/dsh-archive-manager` |
| `dsh-gopeed-downloader` | ~~`dsh-gopeed`~~ ← 唯一不匹配的 |

### 3. 还有第二处旧名：配置页的 slot key

- `client.js:30` → `const KEY = 'dsh-gopeed#gopeed'`
- 插件管理页的规则：`@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:25` `rowConfigKey(bundle, rowId)` 返回 `` `${bundle}#${rowId}` ``，其中 `bundle` 是**包名**，`rowId` 是 `cordis.patch.yml` 里声明的行 id（这里是 `gopeed`）。

也就是说正确的 key 是 `dsh-gopeed-downloader#gopeed`。现在的写法即使修好 id、插件能加载，配置页也只会显示"不可用"（`form.state` 拿不到），不会渲染表单。

`cordis.patch.yml` 顶部注释里"the Web configuration page must register the slot key `dsh-gopeed#gopeed`"这句同样过期。

### 4. 已排除的方向

- 宿主侧模块本身没问题：`node -e "import('dsh-gopeed-downloader')"` 成功，导出 `Config / apply / inject / jobOps / processOps` 齐全。
- `inject` 只有 `['tools']`，`ctx.sandbox` / `ctx.jobs` 都是可选降级，不会造成加载期报错。
- `dsh --profile web --dump-config` 退出码 0，配置树合成正常，gopeed 行存在且字段完整。
- 3080 端口和 webserver 正常（curl 返回 401 unauthorized，说明服务在跑，身份验证在生效）。
- 昨天的 `~/.dsh/logs/startup-*.log` 里的报错是 `EADDRINUSE 10.193.114.34:3080`，属于旧问题，与本次无关。

## 复现与确认方法

1. 打开 DSH web，F12 控制台应能看到形如
   `client-modules: could not load "dsh-gopeed-downloader": .../plugins/dsh-gopeed-downloader/client.js?rev=...: loaded without registering "dsh-gopeed-downloader" via __ModuleLoader__.load`
   的错误；插件页里该条目会带失败标记（`failures` 由模块系统 `publish` 出来）。
2. 修好后重开页面，控制台无该错误，插件页 Settings → 该插件 → `gopeed` 行能渲染出表单。

## 修复清单（留给改代码的人）

- [ ] `client.js:20` `id: 'dsh-gopeed'` → `id: 'dsh-gopeed-downloader'`（**必改**，就是启动失败的直接原因）
- [ ] `client.js:30` `KEY = 'dsh-gopeed#gopeed'` → `KEY = 'dsh-gopeed-downloader#gopeed'`（**必改**，否则配置页空白）
- [ ] `client.js:26` `NS = 'dsh-gopeed'`：客户端 locale 命名空间自成体系（register 和 bind 用的是同一个常量），不改也能跑；要统一就一起改。
- [ ] 宿主路由 `api/dsh-gopeed/notifications`、`api/dsh-gopeed/restart`、CSS 类名 `dsh-gopeed-num` 等：只要前后端常量一致就无需改，纯命名问题。
- [ ] `cordis.patch.yml` 注释里的 slot key 说明、`README.md` 里残留的 12 处 `dsh-gopeed` 字样一并订正。
- [ ] 重新打包 tgz 并按原来的方式安装（`file:D:/Workspace/dsh-plugin-gopeed/...tgz`）。

## 本机当前状态（本次操作）

已按要求卸载，环境干净可回滚：

- 执行：`node <npm>/@deepseek-ai/dsh/lib/bin.js plugin --profile web remove dsh-gopeed-downloader`
  - `package.json`：`dependencies` 与 `dsh.profile.bundles` 两处均已移除；`node_modules` 与 `node_modules/.pnpm` 无残留；`pnpm-lock.yaml` 无残留。
  - `dsh-gopeed`（旧名）本来就不在 profile 里，无需处理。
- 手工删除 `cordis.patch.yml` 末尾的 `- id: gopeed / name: dsh-gopeed-downloader` 行（2830 行处，含 `customDownloadPath: D:\Workspace\dl-test`、`token: deepseek` 等），否则包删了配置还指向它，下次启动会变成"模块找不到"。
- 校验：`dsh --profile web --dump-config` 退出码 0，输出中 gopeed 出现 0 次。
- 备份（同目录）：`package.json.bak-gopeed-20261101`、`pnpm-lock.yaml.bak-gopeed-20261101`、`cordis.patch.yml.bak-gopeed-20261101`。
- 正在运行的实例（PID 36388）内存里还挂着旧插件，**重启后才会真正消失**；不重启也不影响，只是插件页那条报错还在。

## 恢复（修好后再装回来）

1. 改完 `client.js` 两处 id/key，重新 `npm pack` 出 tgz。
2. `dsh plugin --profile web add file:D:/Workspace/dsh-plugin-gopeed/dsh-gopeed-downloader-0.3.x.tgz`
3. `package.json` 的 `dsh.profile.bundles` 里补回包名（`add` 通常会自动追加，确认一下）。
4. 重启 web 再进插件页填 Gopeed 地址/Token（旧配置已随 cordis.patch.yml 一起删除：下载目录 `D:\Workspace\dl-test`、`127.0.0.1:0`、token `deepseek`、webhook off/12345 —— 需要的话照这些填回）。

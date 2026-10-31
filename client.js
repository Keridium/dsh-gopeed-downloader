/**
 * Web half of dsh-gopeed: renders the configuration page for the `gopeed`
 * row of this bundle (Plugins -> Installed -> dsh-gopeed -> row gopeed),
 * where the user fills in the Gopeed API host / port / token.
 *
 * Configuration is read and written by the Plugins page itself: the owner
 * props of the `plugins.row.config` slot carry `form` ({ state, mutate }),
 * writes go through the Host `settings` service and land in this plugin's
 * row inside the active profile's cordis.patch.yml. Every Config field is
 * volatile, so saving applies immediately without restarting DSH.
 *
 * Only `require('react')` (provided by the browser module table); no DSH
 * package is imported.
 *
 * The zh/en dictionaries below are UI copy for the human reading this page;
 * they are not documentation and never reach the model. All plugin text that
 * is model-facing is English.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gopeed',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client locale namespace owned by this plugin. */
    const NS = 'dsh-gopeed'
    /** Slot that renders one plugin row's configuration page. */
    const SLOT = 'plugins.row.config'
    /** Key rule: `<package name>#<row id declared in cordis.patch.yml>`. */
    const KEY = 'dsh-gopeed#gopeed'
    /**
     * Global overlay slot: every app-wide transient notice (toasts, dialogs) mounts here.
     * This is how a download-complete notice reaches the user WITHOUT writing into the chat.
     */
    const OVERLAY_SLOT = 'shell.overlay'
    /**
     * Host routes owned by this plugin, registered in index.js on Connection's authenticated
     * exact Fetch registry. They are document-relative on purpose (the other UI plugins do the
     * same): the app may be mounted below a directory, and the HttpOnly session cookie is sent
     * automatically, so no token ever has to travel through the config form.
     */
    const NOTIFY_ROUTE = 'api/dsh-gopeed/notifications'
    const RESTART_ROUTE = 'api/dsh-gopeed/restart'
    /** How often the page asks the Host for download notices while it is visible. */
    const NOTIFY_POLL_MS = 5000
    /** How long one overlay notice stays on screen before it dismisses itself. */
    const NOTIFY_HOLD_MS = 6000
    /** Maximum notices stacked at once; older ones scroll out. */
    const NOTIFY_MAX_VISIBLE = 4

    const zh = {
      summary: 'Gopeed 下载器：新建 / 列表 / 查进度 / 暂停 / 继续 / 删除，地址与 Token 可在这里配置。',
      title: '连接设置',
      host: '地址',
      hostHint: 'Gopeed 设置 → 高级 → 协议（TCP）里的监听地址，一般就是 127.0.0.1。',
      port: '端口',
      portHint: '默认 0：由插件自动检测正在运行的 Gopeed 占用的端口；如果在 Gopeed 里固定了端口，这里就填同一个数字（例如 9999）。',
      token: 'Token',
      tokenHint: 'Gopeed 设置 → 高级 → Token，插件会把它放在 X-Api-Token 请求头里。',
      exe: '程序路径（可选）',
      exeHint: '留空即可：插件先找 Gopeed 的默认安装路径，找不到再依次从「运行中的进程 → 注册表 → 开始菜单/桌面快捷方式 → 常见路径」自动查找。都没有才需要手填（绿色版/非标准安装）。',
      exePlaceholder: '留空 = 自动查找（推荐）',
      tokenSet: '已设置（留空表示不修改）',
      tokenUnset: '未设置',
      base: '当前请求地址',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，配置即时生效（volatile 字段，无需重启）。',
      noChanges: '没有改动。',
      rejected: 'DSH 拒绝了这次写入，请刷新页面后重试。',
      failed: '保存失败',
      hostRequired: '地址不能为空。',
      portInvalid: '端口必须是 0–65535 之间的整数（0 = 自动检测）。',
      loading: '正在读取配置…',
      unavailable: '配置表单当前不可用（Host 没有暴露这个插件的设置）。',
      verify: '保存后可以让 agent 调用 gopeed_process 确认连通性。',
      webhook: 'Webhook 推送（下载完成通知）',
      webhookHint: '下载完成后由 Gopeed 推送到插件；插件只在本地监听端口，不会主动发起网络请求。',
      webhookPushOptional: 'Webhook 推送（可选）',
      webhookDrawerExpand: '展开',
      webhookDrawerCollapse: '收起',
      webhookDutyTitle: 'Webhook 负责什么：',
      webhookDutyWake: '「下载完成自动唤醒 agent」不依赖 webhook：它由 DSH 的后台任务每 3 秒轮询一次 Gopeed API 完成，不配 webhook 也照样能用。',
      webhookDutyPush: 'webhook 只是可选增强：不配也能自动唤醒、也能用 gopeed_list 查任务；配了才有推送类能力——右下角 toast 通知、gopeed_events 的事件缓存，以及某个下载没有被 job 跟踪时的 Agent.inject 兜底。',
      webhookDutySlower: '它不会让唤醒更快：唤醒走的是轮询，和 webhook 无关。',
      webhookDutyRestart: '配置后必须完全退出并重启 Gopeed 才生效（只把窗口关到托盘不算重启）。',
      webhookModeOff: 'off — 默认，不启用',
      webhookModeOffHint: '不监听任何端口；下载完成后需要你自己调用 gopeed_list 查询状态。',
      webhookModeManual: 'manual — 手动配置',
      webhookModeManualHint: '插件在本地监听端口；把下方状态区显示的完整地址添加到 Gopeed 的「设置 → 开发者 → Webhook 推送」，并确认「启用 Webhook」开关已打开。',
      webhookModeAuto: 'auto — 自动配置',
      webhookModeAutoHint: '插件会自动把监听地址写进 Gopeed 的配置；写入后要重启 Gopeed 才会生效。',
      webhookPort: 'Webhook 监听端口',
      webhookPortHint: '填一个 0–65535 的整数：0 = 由系统自动分配空闲端口（每次可能不同），填具体数字则固定使用它。',
      webhookPortRandom: '随机生成',
      webhookToast: '右下角通知',
      webhookToastHint: 'Gopeed 自己会在 Windows 通知中心弹一条。这里打开的话插件也会弹一条内容更详细的（名称 / 大小 / 路径），但会和 Gopeed 那条重复：想要详细信息就打开，嫌吵就关着。这个开关只影响给用户看的 toast，不影响 job 唤醒（轮询）、Agent.inject 兜底和 gopeed_events 事件缓存。',
      webhookPortInvalid: 'Webhook 端口必须是 0–65535 之间的整数（0 = 自动分配）。',
      webhookStatus: 'Webhook 状态',
      webhookStatusMode: '当前模式',
      webhookUrl: 'Webhook 地址',
      webhookCopy: '复制',
      webhookCopied: '已复制',
      webhookUrlUnfixed: '端口填 0 时由系统随机分配，保存后请用 gopeed_events 查看实际地址；想让地址固定下来，就在上面填一个具体端口。',
      webhookManualStep: '把上面的地址添加到 Gopeed → 设置 → 开发者 → Webhook 推送，然后确认这一页的「启用 Webhook」开关已经打开（只加地址不打开开关，推送不会发出来）。',
      webhookNeedPeer: '只有 Gopeed 那边也添加了同一个 URL，推送才会真的到达插件。',
      webhookOffWarning: '未启用：下载完成后收不到推送，只能主动查询（gopeed_list）。',
      webhookAutoNote: '插件会自动写入，无需手动填地址。',
      webhookRestartWarning: 'auto 写入后需要重启 Gopeed 才会生效（GUI 里可能仍显示旧配置）。重启会中断正在进行的下载。',
      restart: '重启 Gopeed',
      restartHint: '会中断正在进行的下载',
      restartConfirm: '重启 Gopeed 会中断正在进行的下载，确定继续吗？',
      restarting: '重启中…',
      restartOk: '重启成功，Gopeed API 已就绪。',
      restartFail: '重启失败：',
      restartUnavailable: '页面无法调用重启接口（Connection 通道不可用）。',
      notifyDone: '下载完成',
      notifyFailed: '下载失败',
      notifyDismiss: '关闭通知',
      versionHint: '若界面版本低于 gopeed_process 返回的 pluginVersion，说明浏览器仍在用旧界面，请重启 DSH。',
    }

    const en = {
      summary: 'Gopeed downloader: add / list / status / pause / resume / remove, with editable host and token.',
      title: 'Connection',
      host: 'Host',
      hostHint: 'The listen address from Gopeed -> Settings -> Advanced -> Protocol (TCP); usually 127.0.0.1.',
      port: 'Port',
      portHint: 'Defaults to 0: the plugin auto-detects the port the running Gopeed holds. Enter the same fixed number you pinned in Gopeed (for example 9999) only if you pinned one.',
      token: 'Token',
      tokenHint: 'Gopeed -> Settings -> Advanced -> Token, sent as the X-Api-Token header.',
      exe: 'Executable (optional)',
      exeHint: 'Leave blank: the plugin tries the default Gopeed install path first, then the running process, the registry, Start Menu/Desktop shortcuts, and common paths. Fill it only for portable or unusual installs.',
      exePlaceholder: 'Blank = auto-detect (recommended)',
      tokenSet: 'Already set (leave blank to keep it)',
      tokenUnset: 'Not set',
      base: 'Request base URL',
      save: 'Save',
      saving: 'Saving...',
      saved: 'Saved. Volatile fields apply immediately, no restart needed.',
      noChanges: 'No changes.',
      rejected: 'The host rejected this write; refresh the page and try again.',
      failed: 'Save failed',
      hostRequired: 'Host must not be empty.',
      portInvalid: 'Port must be an integer between 0 and 65535 (0 = auto-detect).',
      loading: 'Reading configuration...',
      unavailable: 'The configuration form is unavailable: the host exposes no settings for this plugin.',
      verify: 'After saving, ask the agent to call gopeed_process to verify connectivity.',
      webhook: 'Webhook push (download finished notifications)',
      webhookHint: 'Gopeed pushes status to the plugin when a download finishes; the plugin only listens on a local port and never starts a network request.',
      webhookPushOptional: 'Webhook push (optional)',
      webhookDrawerExpand: 'Expand',
      webhookDrawerCollapse: 'Collapse',
      webhookDutyTitle: 'What the webhook is for:',
      webhookDutyWake: 'Automatic agent wake-up on download complete does NOT depend on the webhook: a DSH background task polls the Gopeed API every 3 seconds, so wake-up works with the webhook off.',
      webhookDutyPush: 'The webhook is an optional enhancement only: wake-up and gopeed_list queries work without it; only push-based extras need it - the bottom-right toast notices, the gopeed_events event cache, and the Agent.inject fallback for a download no job is tracking.',
      webhookDutySlower: 'It never makes wake-up faster: wake-up is polling, unrelated to the webhook.',
      webhookDutyRestart: 'Once configured, Gopeed must be fully quit and restarted for it to take effect (closing the window to the tray does not count).',
      webhookModeOff: 'off - disabled (default)',
      webhookModeOffHint: 'Listen on no port; after a download finishes you have to ask gopeed_list yourself.',
      webhookModeManual: 'manual - configure by hand',
      webhookModeManualHint: 'The plugin listens on a local port; add the full address shown in the status block below in Gopeed -> Settings -> Developer -> Webhook push, and confirm the "Enable webhook" switch on that page is ON.',
      webhookModeAuto: 'auto - configure automatically',
      webhookModeAutoHint: 'The plugin writes the listen address into the Gopeed configuration automatically; Gopeed must be restarted before it takes effect.',
      webhookPort: 'Webhook listen port',
      webhookPortHint: 'An integer from 0 to 65535: 0 lets the system pick a free port (it may differ each time), any number is pinned as-is.',
      webhookPortRandom: 'Random port',
      webhookToast: 'Corner toast',
      webhookToastHint: 'Gopeed already posts its own notification through the Windows notification center. Enabling this makes the plugin show its own toast with more detail (name / size / path), which duplicates the Gopeed one: turn it on for the detail, leave it off to stay quiet. This switch only affects user-facing toasts; it does not affect job wake-up (polling), the Agent.inject fallback, or the gopeed_events event cache.',
      webhookPortInvalid: 'Webhook port must be an integer between 0 and 65535 (0 = auto-assign).',
      webhookStatus: 'Webhook status',
      webhookStatusMode: 'Current mode',
      webhookUrl: 'Webhook URL',
      webhookCopy: 'Copy',
      webhookCopied: 'Copied',
      webhookUrlUnfixed: 'Port 0 is assigned randomly by the system, so check the actual address with gopeed_events after saving; enter a concrete port above to pin it.',
      webhookManualStep: 'Add the address above in Gopeed -> Settings -> Developer -> Webhook push, then confirm the "Enable webhook" switch on that page is ON (an address alone sends nothing).',
      webhookNeedPeer: 'Pushes only arrive when the same URL is also added on the Gopeed side.',
      webhookOffWarning: 'Not enabled: the plugin receives no push after a download finishes, so you can only poll it yourself (gopeed_list).',
      webhookAutoNote: 'The plugin writes the address automatically; no manual entry needed.',
      webhookRestartWarning: 'The auto write takes effect only after restarting Gopeed (the GUI may still show the old configuration). Restarting interrupts downloads in progress.',
      restart: 'Restart Gopeed',
      restartHint: 'Interrupts downloads in progress',
      restartConfirm: 'Restarting Gopeed interrupts downloads in progress. Continue?',
      restarting: 'Restarting...',
      restartOk: 'Restarted. The Gopeed API is ready.',
      restartFail: 'Restart failed: ',
      restartUnavailable: 'This page cannot reach the restart route (Connection channel unavailable).',
      notifyDone: 'Download finished',
      notifyFailed: 'Download failed',
      notifyDismiss: 'Dismiss notification',
      versionHint: 'If this UI version is lower than the pluginVersion returned by gopeed_process, the browser is still running the old UI; restart DSH.',
    }

    const styles = {
      wrap: { display: 'grid', gap: '14px', color: 'inherit', font: 'inherit', fontSize: '13px' },
      head: { display: 'flex', alignItems: 'baseline', gap: '8px' },
      title: { fontWeight: 600, fontSize: '13.5px' },
      base: { opacity: 0.62, fontSize: '12px' },
      field: { display: 'grid', gap: '5px' },
      label: { fontWeight: 600, fontSize: '12.5px' },
      hint: { opacity: 0.62, fontSize: '12px', lineHeight: 1.5, margin: 0 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.38)',
        background: 'rgba(127,127,127,0.06)',
        color: 'inherit',
        font: 'inherit',
        outline: 'none',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      button: {
        padding: '6px 16px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.42)',
        background: 'rgba(127,127,127,0.14)',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      note: { fontSize: '12px', lineHeight: 1.5, margin: 0 },
      // Selectable monospace line for the generated webhook URL, so the text
      // can still be copied by hand when the clipboard API is unavailable.
      url: {
        fontSize: '12px',
        lineHeight: 1.5,
        margin: 0,
        padding: '5px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.32)',
        background: 'rgba(127,127,127,0.08)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        wordBreak: 'break-all',
        userSelect: 'all',
        WebkitUserSelect: 'all',
      },
      okNote: { fontSize: '12px', lineHeight: 1.5, margin: 0, color: '#1a7f4b' },
      errNote: { fontSize: '12px', lineHeight: 1.5, margin: 0, color: '#c0392b' },
      warnNote: { fontSize: '12px', lineHeight: 1.5, margin: 0, color: '#b26a00', fontWeight: 600 },
      // Destructive action: red outline and text, used only by "Restart Gopeed".
      danger: {
        padding: '6px 16px',
        borderRadius: '8px',
        border: '1px solid rgba(192,57,43,0.62)',
        background: 'rgba(192,57,43,0.12)',
        color: '#c0392b',
        font: 'inherit',
        fontWeight: 600,
        cursor: 'pointer',
      },
      dangerBusy: { opacity: 0.55, cursor: 'default' },
      // Overlay stack for download notices; bottom-right, above page content, never in the chat.
      toasts: {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: 2147483000,
        display: 'grid',
        gap: '8px',
        width: 'min(340px, calc(100vw - 36px))',
      },
      toast: {
        position: 'relative',
        display: 'grid',
        gap: '3px',
        padding: '10px 34px 10px 12px',
        borderRadius: '10px',
        border: '1px solid rgba(127,127,127,0.4)',
        background: 'rgba(32,32,32,0.94)',
        color: '#f2f2f2',
        fontSize: '12.5px',
        lineHeight: 1.5,
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
      },
      toastTitle: { fontWeight: 600, fontSize: '12.5px' },
      toastText: { wordBreak: 'break-word' },
      toastPath: { opacity: 0.68, fontSize: '11.5px', wordBreak: 'break-all' },
      toastClose: {
        position: 'absolute',
        top: '4px',
        right: '4px',
        width: '24px',
        height: '24px',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.7,
        cursor: 'pointer',
        font: 'inherit',
      },
      muted: { opacity: 0.62, fontSize: '12.5px', lineHeight: 1.6, margin: 0 },
      option: {
        display: 'grid',
        gap: '3px',
        padding: '7px 9px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.22)',
        background: 'rgba(127,127,127,0.04)',
      },
      optionHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      optionLabel: { fontWeight: 600, fontSize: '12.5px' },
      version: {
        fontSize: '11.5px',
        fontWeight: 600,
        letterSpacing: '0.02em',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.42)',
        background: 'rgba(127,127,127,0.10)',
        whiteSpace: 'nowrap',
      },
      panel: {
        display: 'grid',
        gap: '6px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px dashed rgba(127,127,127,0.42)',
        background: 'rgba(127,127,127,0.05)',
      },
      // Collapsible webhook drawer: the button carries the expand/collapse word (no arrow
      // glyph, so this file stays ASCII outside the zh dictionary), the summary line keeps
      // the live mode readable while the body is collapsed.
      drawerToggle: {
        padding: '4px 12px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.42)',
        background: 'rgba(127,127,127,0.10)',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12.5px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      drawerSummary: { fontWeight: 600, fontSize: '12.5px' },
      drawerBody: { display: 'grid', gap: '12px' },
      // Always-visible responsibility block: rendered outside the collapsible body.
      duty: {
        display: 'grid',
        gap: '4px',
        padding: '9px 11px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'rgba(127,127,127,0.04)',
      },
    }

    /** Radio order and the dictionary keys describing each webhook mode. */
    const WEBHOOK_MODES = ['off', 'manual', 'auto']
    const WEBHOOK_MODE_LABEL = {
      off: 'webhookModeOff',
      manual: 'webhookModeManual',
      auto: 'webhookModeAuto',
    }
    const WEBHOOK_MODE_HINT = {
      off: 'webhookModeOffHint',
      manual: 'webhookModeManualHint',
      auto: 'webhookModeAutoHint',
    }

    /** The plugin always receives pushes on this path; the port is the free variable. */
    const WEBHOOK_PATH = '/webhook'
    /** The plugin listens on loopback only, so the URL is always built from this host. */
    const WEBHOOK_LOCAL_HOST = '127.0.0.1'

    /**
     * Ports already produced by the "random" button, kept at module scope so
     * the sequence does not restart when Fields remounts after a save. It only
     * guarantees distinct values within one page session; nothing is persisted.
     */
    const pickedWebhookPorts = new Set()

    /**
     * Class applied to the numeric inputs. Pseudo-elements such as
     * ::-webkit-inner-spin-button cannot be targeted from an inline style
     * object, so the rule is injected as a stylesheet instead. Both numeric
     * inputs are type="text" with inputMode="numeric" (see the comment on the
     * API port input), and this class is a safety net for builds that paint a
     * spinner anyway.
     */
    const PORT_CLASS = 'dsh-gopeed-num'
    const PORT_CSS =
      '.dsh-gopeed-num::-webkit-outer-spin-button,' +
      '.dsh-gopeed-num::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}' +
      '.dsh-gopeed-num{-moz-appearance:textfield;}'

    /**
     * Version of this browser bundle. The Host only loads client.js at DSH
     * startup, so a refreshed page can still run an older UI after an upgrade;
     * showing this constant lets the user compare it with the pluginVersion
     * reported by gopeed_process and restart DSH when they differ.
     */
    const CLIENT_VERSION = '0.3.0'

    /** One line of small inline hint text. */
    function note(style, text) {
      return h('p', { style }, text)
    }

    /** Compact byte count for an overlay notice (base 1024); '' when unknown. */
    function formatBytes(bytes) {
      const n = Number(bytes)
      if (!Number.isFinite(n) || n <= 0) return ''
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let value = n
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${unit === 0 ? String(Math.round(value)) : value.toFixed(2)} ${units[unit]}`
    }

    /**
     * Last-resort copy that must never throw: it stages the text in a hidden
     * textarea, selects it, and asks the browser to copy the selection.
     * Insecure origins expose no navigator.clipboard, and execCommand may also
     * be refused or undefined, so every failure path is silent.
     * @param {string} text
     * @returns {boolean} whether the browser reported success
     */
    function copyBySelection(text) {
      try {
        if (typeof document === 'undefined' || !document.body) return false
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.left = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        let done = false
        try {
          done = typeof document.execCommand === 'function' && document.execCommand('copy')
        } catch (ignored) {
          done = false
        }
        document.body.removeChild(area)
        return done === true
      } catch (ignored) {
        return false
      }
    }

    /**
     * The actual form. Mounted with key=revision so it re-seeds its initial
     * values every time the Host rewrites the configuration.
     * @param {{ form: any, state: any, t: (key: string) => string }} props
     */
    function Fields(props) {
      const { form, state, t } = props
      const value = state.value && typeof state.value === 'object' ? state.value : {}
      const secrets = Array.isArray(state.secrets) ? state.secrets : []
      const tokenSet =
        secrets.some((entry) => {
          const path = Array.isArray(entry?.path) ? entry.path.join('.') : ''
          return path === 'token' && entry?.set === true
        }) || typeof value.token === 'string'

      const [host, setHost] = React.useState(typeof value.host === 'string' ? value.host : '127.0.0.1')
      const [port, setPort] = React.useState(value.port === undefined || value.port === null ? '0' : String(value.port))
      const [token, setToken] = React.useState('')
      const [exePath, setExePath] = React.useState(
        typeof value.exePath === 'string' ? value.exePath : '',
      )
      const initialWebhookMode =
        value.webhookMode === 'manual' || value.webhookMode === 'auto' ? value.webhookMode : 'off'
      const [webhookMode, setWebhookMode] = React.useState(initialWebhookMode)
      const [webhookPort, setWebhookPort] = React.useState(
        value.webhookPort === undefined || value.webhookPort === null ? '0' : String(value.webhookPort),
      )
      // Boolean, default off: Gopeed already shows its own Windows notification, so the plugin
      // toast is opt-in. Only a strict `true` enables it; legacy strings must never coerce on.
      const [webhookToast, setWebhookToast] = React.useState(value.webhookToast === true)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')
      // Briefly true after a successful copy so the button can say "Copied".
      const [copied, setCopied] = React.useState(false)
      const copiedTimer = React.useRef(null)
      // Restart is a destructive user action: it has its own busy flag and its own result line.
      const [restarting, setRestarting] = React.useState(false)
      const [restartResult, setRestartResult] = React.useState(null)
      // The webhook section is collapsed by default: the page leads with the four connection
      // fields, and the push machinery is opt-in detail most users never need.
      const [webhookOpen, setWebhookOpen] = React.useState(false)
      React.useEffect(
        () => () => {
          if (copiedTimer.current) clearTimeout(copiedTimer.current)
        },
        [],
      )

      // Any port already present in the form counts as spent, so the random
      // button never hands back a value the user is already looking at.
      const storedWebhookPort = Number(value.webhookPort)
      if (Number.isInteger(storedWebhookPort) && storedWebhookPort > 0) {
        pickedWebhookPorts.add(storedWebhookPort)
      }

      const baseUrl = `http://${host.trim() || '?'}:${port.trim() || '?'}`
      const webhookPortNumber = Number(webhookPort.trim())
      /** The status panel only shows a URL when the port is actually pinned. */
      const webhookPortFixed = Number.isInteger(webhookPortNumber) && webhookPortNumber > 0
      /** Only manual mode exposes the port controls and a copyable URL. */
      const webhookPortFieldVisible = webhookMode === 'manual'
      const webhookUrl = `http://${WEBHOOK_LOCAL_HOST}:${webhookPortNumber}${WEBHOOK_PATH}`

      /** Flip the button label to "Copied" for about 1.5 seconds. */
      const markCopied = () => {
        setCopied(true)
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(false), 1500)
      }

      /**
       * Copy the generated webhook URL. navigator.clipboard does not exist on
       * insecure origins, so a missing API degrades to a selection copy and
       * then to doing nothing; clicking must never raise.
       */
      const copyWebhookUrl = () => {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clipboard && typeof clipboard.writeText === 'function') {
          try {
            const pending = clipboard.writeText(webhookUrl)
            if (pending && typeof pending.then === 'function') {
              pending.then(markCopied, () => copyBySelection(webhookUrl))
              return
            }
            markCopied()
            return
          } catch (ignored) {
            // Fall through to the selection-based copy below.
          }
        }
        copyBySelection(webhookUrl)
      }

      /** Fill in a random free-looking port from 20000-65000, never a repeat. */
      const randomWebhookPort = () => {
        const low = 20000
        const high = 65000
        let candidate = low + Math.floor(Math.random() * (high - low + 1))
        let steps = 0
        while (pickedWebhookPorts.has(candidate) && steps < high - low + 1) {
          candidate = candidate === high ? low : candidate + 1
          steps += 1
        }
        pickedWebhookPorts.add(candidate)
        setWebhookPort(String(candidate))
      }

      /**
       * Restart Gopeed through the authenticated Host route. The Host does the killing and the
       * launching; this handler only asks (after a native confirmation) and reports the result.
       * Restarting is deliberately unavailable to the agent: this button is the only entry point.
       */
      const restartGopeed = async () => {
        setRestartResult(null)
        try {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            if (!window.confirm(t('restartConfirm'))) return
          }
        } catch (ignored) {
          // A host environment without window.confirm must not block the action silently.
        }
        setRestarting(true)
        try {
          const response = await fetch(RESTART_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ confirm: true }),
          })
          let payload = null
          try {
            payload = await response.json()
          } catch (ignored) {
            payload = null
          }
          if (response.ok && payload && payload.ok === true) {
            setRestartResult({ ok: true, message: t('restartOk') })
          } else {
            const reason =
              response.status === 404
                ? t('restartUnavailable')
                : (payload && payload.message) || `HTTP ${response.status}`
            setRestartResult({ ok: false, message: `${t('restartFail')}${reason}` })
          }
        } catch (failure) {
          setRestartResult({
            ok: false,
            message: `${t('restartFail')}${failure && failure.message ? failure.message : String(failure)}`,
          })
        } finally {
          setRestarting(false)
        }
      }

      const save = async () => {
        setNotice('')
        setError('')
        const nextHost = host.trim()
        if (!nextHost) {
          setError(t('hostRequired'))
          return
        }
        const portText = port.trim()
        const portNumber = Number(portText)
        if (portText === '' || !Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
          setError(t('portInvalid'))
          return
        }
        const webhookPortText = webhookPort.trim()
        const webhookPortValue = Number(webhookPortText)
        if (
          webhookPortText === '' ||
          !Number.isInteger(webhookPortValue) ||
          webhookPortValue < 0 ||
          webhookPortValue > 65535
        ) {
          setError(t('webhookPortInvalid'))
          return
        }
        const nextWebhookMode =
          webhookMode === 'manual' || webhookMode === 'auto' ? webhookMode : 'off'
        const ops = []
        if (nextHost !== String(value.host ?? '')) ops.push({ op: 'set', path: ['host'], value: nextHost })
        if (portNumber !== Number(value.port ?? 0)) ops.push({ op: 'set', path: ['port'], value: portNumber })
        const nextToken = token.trim()
        if (nextToken.length > 0) ops.push({ op: 'set', path: ['token'], value: nextToken })
        const nextExe = exePath.trim()
        if (nextExe !== String(value.exePath ?? '')) ops.push({ op: 'set', path: ['exePath'], value: nextExe })
        const storedWebhookMode =
          value.webhookMode === 'manual' || value.webhookMode === 'auto' ? value.webhookMode : 'off'
        if (nextWebhookMode !== storedWebhookMode) {
          ops.push({ op: 'set', path: ['webhookMode'], value: nextWebhookMode })
        }
        if (webhookPortValue !== Number(value.webhookPort ?? 0)) {
          ops.push({ op: 'set', path: ['webhookPort'], value: webhookPortValue })
        }
        // Boolean op: no numeric conversion and no validation, only the change check.
        const nextWebhookToast = webhookToast === true
        if (nextWebhookToast !== (value.webhookToast === true)) {
          ops.push({ op: 'set', path: ['webhookToast'], value: nextWebhookToast })
        }
        if (ops.length === 0) {
          setNotice(t('noChanges'))
          return
        }
        setBusy(true)
        try {
          const accepted = await form.mutate(ops, state.revision)
          if (accepted) {
            setNotice(t('saved'))
            setToken('')
          } else {
            setError(t('rejected'))
          }
        } catch (failure) {
          setError(`${t('failed')}: ${failure && failure.message ? failure.message : String(failure)}`)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: styles.wrap },
        h('style', { key: 'dsh-gopeed-port-css' }, PORT_CSS),
        h(
          'div',
          { style: styles.head },
          h('span', { style: styles.title }, t('title')),
          h('span', { style: styles.version, title: `dsh-gopeed client ${CLIENT_VERSION}` }, `v${CLIENT_VERSION}`),
          h('span', { style: styles.base }, `${t('base')} ${baseUrl}`),
        ),
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'dsh-gopeed-host' }, t('host')),
          h('input', {
            id: 'dsh-gopeed-host',
            style: styles.input,
            type: 'text',
            value: host,
            spellCheck: false,
            disabled: busy || state.writable === false,
            onChange: (event) => setHost(event.target.value),
          }),
          note(styles.hint, t('hostHint')),
        ),
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'dsh-gopeed-port' }, t('port')),
          h('input', {
            id: 'dsh-gopeed-port',
            className: PORT_CLASS,
            style: styles.input,
            // Deliberately a text input with a numeric keyboard hint instead of type="number":
            // type="number" always grows a native up/down spinner, which cannot be removed with
            // inline styles (it is a ::-webkit-inner-spin-button pseudo-element, see PORT_CSS)
            // and still renders in the dark theme on some builds. A text input has no spinner to
            // begin with, and `inputMode` keeps the numeric keypad on mobile. Validation happens
            // in save() anyway.
            type: 'text',
            inputMode: 'numeric',
            autoComplete: 'off',
            value: port,
            disabled: busy || state.writable === false,
            onChange: (event) => setPort(event.target.value),
          }),
          note(styles.hint, t('portHint')),
        ),
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'dsh-gopeed-token' }, t('token')),
          h('input', {
            id: 'dsh-gopeed-token',
            style: styles.input,
            type: 'password',
            autoComplete: 'off',
            value: token,
            placeholder: tokenSet ? t('tokenSet') : t('tokenUnset'),
            disabled: busy || state.writable === false,
            onChange: (event) => setToken(event.target.value),
          }),
          note(styles.hint, t('tokenHint')),
        ),
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'dsh-gopeed-exe' }, t('exe')),
          h('input', {
            id: 'dsh-gopeed-exe',
            style: styles.input,
            type: 'text',
            spellCheck: false,
            value: exePath,
            placeholder: t('exePlaceholder'),
            disabled: busy || state.writable === false,
            onChange: (event) => setExePath(event.target.value),
          }),
          note(styles.hint, t('exeHint')),
        ),
        // Webhook drawer. Collapsing is React state, not <details> and not display:none:
        // while collapsed the inner controls are not rendered at all, so no hidden webhook
        // input can be submitted or mistaken for a real one. The mode stays readable in the
        // summary line, which is why the reader can tell off/manual/auto without opening it.
        h(
          'div',
          { style: styles.field },
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              {
                type: 'button',
                id: 'dsh-gopeed-webhook-toggle',
                style: styles.drawerToggle,
                'aria-expanded': webhookOpen ? 'true' : 'false',
                'aria-controls': 'dsh-gopeed-webhook-drawer',
                onClick: () => setWebhookOpen((open) => !open),
              },
              webhookOpen ? t('webhookDrawerCollapse') : t('webhookDrawerExpand'),
            ),
            h(
              'span',
              { style: styles.drawerSummary },
              `${t('webhookPushOptional')} - ${t('webhookStatusMode')}: ${webhookMode}`,
            ),
          ),
          // Responsibility block. Deliberately OUTSIDE the collapsible body: this is the answer
          // to "what does the webhook actually do", and it has to be readable while collapsed.
          h(
            'div',
            { style: styles.duty },
            h('span', { style: styles.label }, t('webhookDutyTitle')),
            note(styles.note, t('webhookDutyWake')),
            note(styles.note, t('webhookDutyPush')),
            note(styles.note, t('webhookDutySlower')),
            note(styles.note, t('webhookDutyRestart')),
          ),
          h(
            'div',
            { id: 'dsh-gopeed-webhook-drawer', style: styles.drawerBody },
            webhookOpen
              ? [
                  h(
                    'div',
                    { key: 'modes', style: styles.field },
                    note(styles.hint, t('webhookHint')),
                    WEBHOOK_MODES.map((mode) =>
                      h(
                        'label',
                        { key: mode, style: styles.option },
                        h(
                          'span',
                          { style: styles.optionHead },
                          h('input', {
                            type: 'radio',
                            name: 'dsh-gopeed-webhook-mode',
                            value: mode,
                            checked: webhookMode === mode,
                            disabled: busy || state.writable === false,
                            onChange: () => setWebhookMode(mode),
                          }),
                          h('span', { style: styles.optionLabel }, t(WEBHOOK_MODE_LABEL[mode])),
                        ),
                        h(
                          'span',
                          { style: { ...styles.hint, display: 'block' } },
                          t(WEBHOOK_MODE_HINT[mode]),
                        ),
                      ),
                    ),
                  ),
                  // Toast switch: user-facing notification only. It never changes wake-up,
                  // the Agent.inject fallback, or the events cache, so it lives beside the mode
                  // radios instead of pretending to be a transport setting.
                  h(
                    'label',
                    { key: 'toast', style: styles.option },
                    h(
                      'span',
                      { style: styles.optionHead },
                      h('input', {
                        type: 'checkbox',
                        id: 'dsh-gopeed-webhook-toast',
                        checked: webhookToast === true,
                        disabled: busy || state.writable === false,
                        onChange: (event) => setWebhookToast(event.target.checked === true),
                      }),
                      h('span', { style: styles.optionLabel }, t('webhookToast')),
                    ),
                    h(
                      'span',
                      { style: { ...styles.hint, display: 'block' } },
                      t('webhookToastHint'),
                    ),
                  ),
                  webhookPortFieldVisible
                    ? h(
                        'div',
                        { key: 'port', style: styles.field },
                        h(
                          'label',
                          { style: styles.label, htmlFor: 'dsh-gopeed-webhook-port' },
                          t('webhookPort'),
                        ),
                        h(
                          'div',
                          { style: styles.row },
                          h('input', {
                            id: 'dsh-gopeed-webhook-port',
                            className: PORT_CLASS,
                            // Same reasoning as the Gopeed API port above: a text input plus
                            // inputMode avoids the native spinner entirely.
                            style: { ...styles.input, flex: '1 1 140px', width: 'auto', minWidth: 0 },
                            type: 'text',
                            inputMode: 'numeric',
                            autoComplete: 'off',
                            value: webhookPort,
                            disabled: busy || state.writable === false,
                            onChange: (event) => setWebhookPort(event.target.value),
                          }),
                          h(
                            'button',
                            {
                              type: 'button',
                              style: styles.button,
                              disabled: busy || state.writable === false,
                              onClick: randomWebhookPort,
                            },
                            t('webhookPortRandom'),
                          ),
                        ),
                        note(styles.hint, t('webhookPortHint')),
                      )
                    : null,
                  h(
                    'div',
                    { key: 'status', style: styles.panel },
                    h('span', { style: styles.label }, t('webhookStatus')),
                    note(styles.note, `${t('webhookStatusMode')}: ${t(WEBHOOK_MODE_LABEL[webhookMode])}`),
                    // Each mode says only what applies to it: off is a warning, manual
                    // shows the concrete URL (or why there is none yet), auto explains
                    // that the plugin writes it and that Gopeed must restart.
                    webhookMode === 'off' ? note(styles.errNote, t('webhookOffWarning')) : null,
                    webhookMode === 'manual' && webhookPortFixed
                      ? h(
                          'div',
                          { style: styles.field },
                          h('span', { style: styles.label }, t('webhookUrl')),
                          h(
                            'div',
                            { style: styles.row },
                            h('code', { style: styles.url }, webhookUrl),
                            h(
                              'button',
                              {
                                type: 'button',
                                style: styles.button,
                                title: webhookUrl,
                                onClick: copyWebhookUrl,
                              },
                              copied ? t('webhookCopied') : t('webhookCopy'),
                            ),
                          ),
                        )
                      : null,
                    webhookMode === 'manual' && !webhookPortFixed
                      ? note(styles.warnNote, t('webhookUrlUnfixed'))
                      : null,
                    webhookMode === 'manual' && webhookPortFixed
                      ? note(styles.hint, t('webhookManualStep'))
                      : null,
                    webhookMode === 'manual' ? note(styles.warnNote, t('webhookNeedPeer')) : null,
                    webhookMode === 'auto' ? note(styles.note, t('webhookAutoNote')) : null,
                    webhookMode === 'auto'
                      ? note(styles.warnNote, t('webhookRestartWarning'))
                      : null,
                    // The only restart entry point in the whole plugin. It is a user gesture by
                    // design: no tool and no agent call can reach the Host restart route.
                    h(
                      'div',
                      { style: styles.row },
                      h(
                        'button',
                        {
                          type: 'button',
                          style: restarting ? { ...styles.danger, ...styles.dangerBusy } : styles.danger,
                          disabled: restarting,
                          onClick: restartGopeed,
                          title: t('restartHint'),
                        },
                        restarting ? t('restarting') : t('restart'),
                      ),
                      note(styles.hint, t('restartHint')),
                    ),
                    restartResult
                      ? note(restartResult.ok ? styles.okNote : styles.errNote, restartResult.message)
                      : null,
                  ),
                ]
              : null,
          ),
        ),
        h(
          'div',
          { style: styles.row },
          h(
            'button',
            { type: 'button', style: styles.button, disabled: busy || state.writable === false, onClick: save },
            busy ? t('saving') : t('save'),
          ),
          notice ? note(styles.okNote, notice) : null,
          error ? note(styles.errNote, error) : null,
          !notice && !error ? note(styles.hint, t('verify')) : null,
        ),
        // Outside the webhook status panel on purpose: this is about the page itself (a stale
        // browser bundle), not about the webhook mode, so it must not look like part of that box.
        note(styles.hint, t('versionHint')),
      )
    }

    /**
     * App-wide download notice. Mounted in `shell.overlay`, i.e. outside the conversation, so it
     * never appears as a chat message. It polls the Host feed only while the page is visible; when
     * notifications are disabled, or the Host has no Connection route, it renders nothing.
     * @param {{ i18n?: (key: string) => string }} props
     */
    function NotificationOverlay(props) {
      const t = typeof props.i18n === 'function' ? props.i18n : (key) => zh[key] || key
      const [items, setItems] = React.useState([])
      const cursor = React.useRef(0)
      React.useEffect(() => {
        let alive = true
        let timer = null
        // The first successful poll only positions the cursor: events that arrived before this
        // page was opened are history, and replaying them as a stack of toasts would be noise.
        let primed = false
        const timers = new Set()
        const dismiss = (id) => {
          if (alive) setItems((list) => list.filter((item) => item.id !== id))
        }
        const poll = async () => {
          if (typeof document !== 'undefined' && document.hidden) return
          try {
            const response = await fetch(`${NOTIFY_ROUTE}?since=${cursor.current}`, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return
            const data = await response.json()
            if (!data || data.enabled !== true || !Array.isArray(data.events)) return
            if (!primed) {
              primed = true
              cursor.current = typeof data.latest === 'number' ? data.latest : 0
              return
            }
            if (typeof data.latest === 'number' && data.latest < cursor.current) {
              // The Host restarted and reset its counter: accept everything it has again.
              cursor.current = 0
            }
            const fresh = data.events.filter(
              (entry) => entry && typeof entry.seq === 'number' && entry.seq > cursor.current,
            )
            if (fresh.length === 0) return
            cursor.current = fresh[fresh.length - 1].seq
            const added = fresh.map((entry) => ({
              id: `${entry.seq}-${entry.at}`,
              failed: entry.event === 'DOWNLOAD_ERROR',
              name: entry.name || entry.taskId || '',
              size: formatBytes(entry.sizeBytes),
              path: entry.path || '',
            }))
            if (!alive) return
            setItems((list) => [...list, ...added].slice(-NOTIFY_MAX_VISIBLE))
            for (const item of added) {
              const hold = setTimeout(() => {
                timers.delete(hold)
                dismiss(item.id)
              }, NOTIFY_HOLD_MS)
              timers.add(hold)
            }
          } catch (ignored) {
            // Route absent (no Connection carrier) or a transient failure: stay silent.
          }
        }
        const tick = () => {
          poll().finally(() => {
            if (alive) timer = setTimeout(tick, NOTIFY_POLL_MS)
          })
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          for (const hold of timers) clearTimeout(hold)
        }
      }, [])
      if (items.length === 0) return null
      return h(
        'div',
        { style: styles.toasts },
        items.map((item) =>
          h(
            'div',
            { key: item.id, style: styles.toast, role: 'status' },
            h('div', { style: styles.toastTitle }, item.failed ? t('notifyFailed') : t('notifyDone')),
            h('div', { style: styles.toastText }, item.size ? `${item.name} (${item.size})` : item.name),
            item.path ? h('div', { style: styles.toastPath }, item.path) : null,
            h(
              'button',
              {
                type: 'button',
                style: styles.toastClose,
                title: t('notifyDismiss'),
                'aria-label': t('notifyDismiss'),
                onClick: () => dismiss(item.id),
              },
              'x',
            ),
          ),
        ),
      )
    }

    /**
     * Slot entry point: `summary` is the one-liner, `page` renders the form.
     * @param {{ view?: string, form?: any, i18n?: (key: string) => string }} props
     */
    function GopeedConfig(props) {
      const t = typeof props.i18n === 'function' ? props.i18n : (key) => zh[key] || key
      if (props.view === 'summary') return t('summary')
      const form = props.form
      const state = form && form.state
      if (!form || !state) return note(styles.muted, t('unavailable'))
      if (state.status === 'loading') return note(styles.muted, t('loading'))
      if (state.status !== 'ready') return note(styles.muted, t('unavailable'))
      return h(Fields, {
        key: `${String(state.revision)}:${JSON.stringify(state.value ?? {})}`,
        form,
        state,
        t,
      })
    }

    const inject = ['slots', 'locale']

    /**
     * @param {any} ctx Browser-side plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gopeed: locale')
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          { name: SLOT, key: KEY, locale: NS, inject: () => ({ i18n: t }) },
          GopeedConfig,
        ),
      )
      // App-wide overlay notice for finished downloads. Registered in the global overlay slot so
      // the notice is never rendered inside the conversation or as one of the user's messages.
      ctx.slots.inject(OVERLAY_SLOT, () =>
        ctx.slots.register(
          { name: OVERLAY_SLOT, id: 'dsh-gopeed.notifications', locale: NS, inject: () => ({ i18n: t }) },
          NotificationOverlay,
        ),
      )
    }

    return { inject, apply }
  },
})

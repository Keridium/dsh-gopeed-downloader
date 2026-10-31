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
      okNote: { fontSize: '12px', lineHeight: 1.5, margin: 0, color: '#1a7f4b' },
      errNote: { fontSize: '12px', lineHeight: 1.5, margin: 0, color: '#c0392b' },
      muted: { opacity: 0.62, fontSize: '12.5px', lineHeight: 1.6, margin: 0 },
    }

    /**
     * Class applied only to the port input. Pseudo-elements such as
     * ::-webkit-inner-spin-button cannot be targeted from an inline style
     * object, so the rule is injected as a stylesheet instead. The input
     * keeps type="number" (numeric keypad and browser validation still
     * work); only the native spinner is hidden.
     */
    const PORT_CLASS = 'dsh-gopeed-num'
    const PORT_CSS =
      '.dsh-gopeed-num::-webkit-outer-spin-button,' +
      '.dsh-gopeed-num::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}' +
      '.dsh-gopeed-num{-moz-appearance:textfield;}'

    /** One line of small inline hint text. */
    function note(style, text) {
      return h('p', { style }, text)
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
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')

      const baseUrl = `http://${host.trim() || '?'}:${port.trim() || '?'}`

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
        const ops = []
        if (nextHost !== String(value.host ?? '')) ops.push({ op: 'set', path: ['host'], value: nextHost })
        if (portNumber !== Number(value.port ?? 0)) ops.push({ op: 'set', path: ['port'], value: portNumber })
        const nextToken = token.trim()
        if (nextToken.length > 0) ops.push({ op: 'set', path: ['token'], value: nextToken })
        const nextExe = exePath.trim()
        if (nextExe !== String(value.exePath ?? '')) ops.push({ op: 'set', path: ['exePath'], value: nextExe })
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
    }

    return { inject, apply }
  },
})

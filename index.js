/**
 * dsh-gopeed - exposes the Gopeed downloader REST API as DSH agent tools.
 *
 * Layout:
 * - Config: host / port / token / timeoutMs / exePath, all `.volatile()`, so edits in the DSH
 *   settings UI (Plugins -> Installed -> dsh-gopeed -> Config) take effect immediately.
 * - apply: registers six tools on ctx.tools (add / list / status / control / process / launch).
 * - lib/api.js: HTTP and process-probing layer without any DSH dependency, so it also runs
 *   standalone under plain node.
 *
 * Tool definitions are plain ToolDefinition objects (what defineTool compiles to), so the plugin
 * does not need to import @deepseek-ai/dsh-tools at runtime - one less resolution dependency.
 *
 * Language: every string an agent can read is English - tool name / description, parameter and
 * output.schema descriptions, render() text, execute() fields and error messages. Chinese
 * documentation lives in the repository (docs/README.zh.md, docs/GETTING-STARTED.md), not in code.
 *
 * Tool definitions are also kept minimal: DSH projects {name, description, parameters} into the
 * system prompt on every turn, so descriptions are fragments that never repeat the `gopeed_`
 * prefix, and parameter descriptions are omitted entirely. The only meaning that cannot live in a
 * parameter name - `force` deletes files - is carried by gopeed_control's description.
 *
 * Newcomer guidance (installing Gopeed, setting up the protocol and token) must never enter the
 * tool definitions: those stay in the system prompt for every turn. It only appears at runtime -
 * in the failure branch's return value (SETUP_GUIDE -> advice / message), or as a single
 * SETUP_NOTICE user message injected through deferContext.
 *
 * Encoding: this file must stay UTF-8 without BOM. Do not batch-edit it in PowerShell 5.1:
 * Get-Content -Raw / Set-Content decode UTF-8 as GBK and destroy non-ASCII characters such as
 * -> - [!] (recovering requires a full rewrite). Use an editor or Node's fs instead.
 */
import z from '@deepseek-ai/schemastery'
import {
  createGopeedClient,
  describeTask,
  discoverApiPort,
  findListeningPorts,
  findProcess,
  formatBytes,
  isTaskGoneError,
  launchProcess,
  normalizeTask,
  probeApi,
  resolveExecutable,
  stopProcess,
  waitForApi,
} from './lib/api.js'

/** Plugin name used by the Loader for diagnostics. */
export const name = 'dsh-gopeed'

/** Required Host service: the tool registry. */
export const inject = ['tools']

/**
 * Plugin configuration.
 *
 * Note `.volatile()`: only volatile fields show up in the DSH settings form, and writing them
 * back does not remount the plugin (changes apply immediately). `role('secret')` makes the token
 * read back as set/unset instead of echoing it to the frontend.
 */
export const Config = z.object({
  host: z
    .string()
    .default('127.0.0.1')
    .description(
      'Gopeed REST API address. This is the listen address from Gopeed Settings -> Advanced -> Protocol (TCP); use 127.0.0.1 when it only listens locally.',
    )
    .volatile(),
  port: z
    .number()
    .step(1)
    .min(0)
    .max(65535)
    .default(0)
    .description(
      'Gopeed API port. 0 (default) = auto-detect: Gopeed\'s desktop build listens on 127.0.0.1:0, a random ' +
        'port per launch, so the plugin asks Windows which port the running process actually holds. Set a ' +
        'number only to pin a specific port.',
    )
    .volatile(),
  token: z
    .string()
    .role('secret')
    .default('')
    .description(
      'Gopeed API token, sent as X-Api-Token. Gopeed ships with an EMPTY token, which disables auth; ' +
        'leave this blank to match. If you set a token in Gopeed -> Settings -> Advanced, enter the exact ' +
        'same value here.',
    )
    .volatile(),
  timeoutMs: z
    .number()
    .step(1000)
    .min(1000)
    .max(120000)
    .default(20000)
    .description('Timeout for a single HTTP request in milliseconds, default 20000.')
    .volatile(),
  exePath: z
    .string()
    .default('')
    .description(
      'Path to Gopeed.exe; **usually leave empty**. The plugin tries, in order: this value -> default install paths ' +
        '(%LOCALAPPDATA%\\Programs\\Gopeed\\Gopeed.exe, %LOCALAPPDATA%\\Gopeed\\Gopeed.exe) -> auto-discovery ' +
        '(running process -> registry -> Start Menu/desktop shortcuts -> common install paths). Set it only when a ' +
        'portable or non-standard install makes auto-discovery fail.',
    )
    .volatile(),
  portScan: z
    .boolean()
    .default(false)
    .description(
      'Off by default. When true, the plugin may sweep the local dynamic port range to locate Gopeed when Windows ' +
        'will not disclose another process sockets. That touches ports belonging to unrelated software, so enable it ' +
        'only if you accept that; otherwise enter the fixed port Gopeed shows under Settings -> Advanced -> Protocol.',
    )
    .volatile(),
})

/** Output schema of a normalized task (descriptions stay English, matching the tool definitions). */
const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'status',
    'protocol',
    'sizeBytes',
    'downloadedBytes',
    'percent',
    'sizeKnown',
    'speedBytesPerSec',
    'uploadedBytes',
    'uploadSpeedBytesPerSec',
    'path',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', description: 'Task id.' },
    name: { type: 'string', description: 'Task name from Gopeed.' },
    status: { type: 'string', description: 'ready | running | pause | wait | error | done.' },
    protocol: { type: 'string', description: 'http or bt.' },
    sizeBytes: { type: 'integer', description: 'Total bytes (meta.res.size); 0 when unknown.' },
    downloadedBytes: { type: 'integer', description: 'Bytes downloaded.' },
    percent: { type: 'number', description: 'Progress percent; 0 when total size is unknown.' },
    sizeKnown: { type: 'boolean', description: 'Whether the total size is known.' },
    speedBytesPerSec: { type: 'integer', description: 'Current download speed in bytes/s.' },
    uploadedBytes: { type: 'integer', description: 'Bytes uploaded (BT tasks).' },
    uploadSpeedBytesPerSec: { type: 'integer', description: 'Current upload speed in bytes/s.' },
    path: { type: 'string', description: 'Download directory (meta.opts.path); may be empty.' },
    createdAt: { type: 'string', description: 'Creation time as returned by Gopeed.' },
  },
}

/** Result envelope for a single task. */
const TASK_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['task'],
  properties: {
    task: TASK_SCHEMA,
    baseUrl: { type: 'string', description: 'Base URL used for this request.' },
  },
}

/** Result of a control action (pause / resume / remove). */
const ACTION_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'id', 'action', 'status', 'message'],
  properties: {
    ok: { type: 'boolean', description: 'Whether Gopeed accepted the action.' },
    id: { type: 'string', description: 'Task id.' },
    action: { type: 'string', description: 'pause | resume | remove.' },
    status: { type: 'string', description: 'Task status after the action; empty when unreadable.' },
    message: { type: 'string', description: 'Human-readable result (including tolerated errors).' },
  },
}

/** Shared text rendering: join lines into one text block. */
function textBlock(lines) {
  return [{ type: 'text', text: lines.filter((line) => line !== undefined).join('\n') }]
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {any} config Resolved config (volatile fields are read live through .get()).
 */
export function apply(ctx, config) {
  // Gopeed listens on 127.0.0.1:0 by default, so both its pid AND its port change on every
  // launch. Nothing here caches the pid: each detection re-reads it from the live process.
  let autoPort = 0
  let autoPortPid = 0
  let autoPortAt = 0

  const client = createGopeedClient({
    resolve: () => ({
      host: config.host.get(),
      // A detected port wins over the configured one: the configured value may be stale after
      // Gopeed restarted on a new random port.
      port: autoPort > 0 ? autoPort : Number(config.port.get()) || 0,
      token: config.token.get(),
      timeoutMs: config.timeoutMs.get(),
    }),
  })

  /**
   * Resolve the port to talk to: the configured one, or the port the running process actually
   * holds. Returns 0 when detection is impossible (no process, or the OS view is restricted).
   * @param {boolean} [force] Skip the configured value and detect even when a port is configured.
   */
  const ensureApiPort = async (force = false) => {
    const configured = Number(config.port.get())
    // The cache is keyed by pid: Gopeed picks a new pid and a new random port on every launch, so
    // a cached port is only valid while the same process is still alive.
    if (!force && autoPort > 0 && Date.now() - autoPortAt < 60000) {
      const live = await findProcess(config.exePath.get() || 'Gopeed.exe')
      if (live.found && live.pid === autoPortPid) return autoPort
    }
    if (configured > 0 && !force) return configured
    const proc = await findProcess(config.exePath.get() || 'Gopeed.exe')
    if (!proc.found) return configured > 0 ? configured : 0
    const found = await discoverApiPort({
      pid: proc.pid,
      host: config.host.get(),
      token: config.token.get(),
      timeoutMs: Math.min(3000, config.timeoutMs.get()),
      // Sweeping every loopback port is opt-in only; see Config.portScan.
      scan: config.portScan.get() === true,
    })
    if (!found) return configured > 0 ? configured : 0
    autoPort = found.port
    autoPortPid = proc.pid
    autoPortAt = Date.now()
    return autoPort
  }

  /**
   * One-off user-facing notice: when Gopeed is not installed or not configured, append a message
   * to the conversation instead of expecting the user to read the README.
   *
   * `ToolRunContext.deferContext` appends a user message after the tool result: the user sees it
   * in the chat and the next turn's model is guaranteed to read it. It is sent at most once, and
   * a failed injection never breaks the tool's own error path.
   */
  const SETUP_NOTICE = [
    '[!] Gopeed is not ready yet, so this downloader plugin cannot be used. Three steps fix it - no command line needed:',
    '1) Install Gopeed: open https://gopeed.com, download the Windows build, double-click the installer, then open Gopeed.',
    '2) Pin the API port: in Gopeed open Settings -> Advanced -> Protocol, keep TCP and set the address to a fixed port, for example 127.0.0.1:9999. Gopeed defaults to port 0, a random port on every launch; the plugin can usually detect it, but pinning removes the guesswork.',
    '3) Token (optional): if you set a token on that same page, enter the same value in DSH -> Plugins -> Installed -> Gopeed downloader -> row gopeed -> Config, with address 127.0.0.1 and the same port, then save.',
    'Tell me when that is done and I will check again.',
  ].join('\n')

  let setupNoticeSent = false

  /** Only connection / timeout / token failures are worth interrupting the user; task errors are not. */
  const isSetupProblem = (error) => {
    const code = Number(error?.code)
    return code === -1 || code === 401 || code === 403
  }

  const notifySetupNeeded = (exec) => {
    if (setupNoticeSent) return
    setupNoticeSent = true
    if (!exec || typeof exec.deferContext !== 'function') return
    try {
      exec.deferContext({
        id: `dsh-gopeed-setup-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: SETUP_NOTICE }],
        source: { kind: 'user' },
      })
    } catch {
      // A failed injection must not break the tool's own error path.
    }
  }

  /** Turn any error into a readable exception for the model. */
  const fail = (action, error, exec) => {
    if (isSetupProblem(error)) notifySetupNeeded(exec)
    const detail = error?.message || String(error)
    throw new Error(`gopeed_${action} failed: ${detail}`)
  }

  /** Argument fallback: the model may pass an empty or non-string value. */
  const reqString = (value, field) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw new Error(`Missing required parameter: ${field}`)
    return text
  }

  /** Optional string argument. */
  const optString = (value) => {
    if (typeof value !== 'string') return ''
    return value.trim()
  }

  ctx.tools.register({
    name: 'gopeed_add',
    description: 'Create task.',
    // Note: parameters omits additionalProperties. A defineTool-compiled parameter schema is
    // only {type, properties, required}; adding additionalProperties:false would cost about 170
    // characters across six tools on every turn. Validation lives in execute (reqString /
    // whitelists) instead. Parameter descriptions are dropped too, because the name plus the
    // one-line tool description already pin the value down - except `path`, where "save
    // directory" versus "file path" is a silent, wrong-download kind of mistake.
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        path: { type: 'string', description: 'Save dir' },
        name: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'url', 'name', 'path', 'baseUrl'],
        properties: {
          taskId: { type: 'string', description: 'Task id returned by Gopeed.' },
          url: { type: 'string', description: 'Submitted URL.' },
          name: { type: 'string', description: 'Task name; empty when not given.' },
          path: { type: 'string', description: 'Download directory; empty when not given.' },
          baseUrl: { type: 'string', description: 'Base URL used for this request.' },
        },
      },
      render: (_args, value) =>
        textBlock([
          `Submitted download task: ${value.taskId}`,
          `URL: ${value.url}`,
          value.name ? `Name: ${value.name}` : undefined,
          value.path ? `Save dir: ${value.path}` : undefined,
          `Check progress with gopeed_status (${value.baseUrl}).`,
        ]),
      presentationMeta: (_args, value) => ({ taskId: value.taskId }),
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: 'New Gopeed download',
      kind: 'fetch',
      rawInput: args,
    }),
    timeoutMs: 25000,
    async execute(args, exec) {
      await ensureApiPort()
      const url = reqString(args?.url, 'url')
      const path = optString(args?.path)
      const taskName = optString(args?.name)
      try {
        const taskId = await client.create({ url, path: path || undefined, name: taskName || undefined })
        return { taskId, url, name: taskName, path, baseUrl: client.baseUrl() }
      } catch (error) {
        fail('add', error, exec)
      }
    },
  })

  ctx.tools.register({
    name: 'gopeed_list',
    description: 'List tasks.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ready', 'running', 'pause', 'wait', 'error', 'done'],
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'tasks', 'baseUrl'],
        properties: {
          count: { type: 'integer', description: 'Number of tasks returned.' },
          tasks: { type: 'array', items: TASK_SCHEMA },
          baseUrl: { type: 'string', description: 'Base URL used for this request.' },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return textBlock([`Gopeed has no matching tasks. (${value.baseUrl})`])
        return textBlock([
          `Gopeed: ${value.count} task${value.count === 1 ? '' : 's'} (${value.baseUrl}):`,
          ...value.tasks.map((task) => `- ${describeTask(task)}`),
        ])
      },
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Gopeed tasks', kind: 'other' }),
    timeoutMs: 25000,
    async execute(args, exec) {
      await ensureApiPort()
      const filter = optString(args?.status).toLowerCase()
      try {
        const raw = await client.list()
        const tasks = (Array.isArray(raw) ? raw : []).map(normalizeTask)
        const filtered = filter ? tasks.filter((task) => task.status === filter) : tasks
        return { count: filtered.length, tasks: filtered, baseUrl: client.baseUrl() }
      } catch (error) {
        fail('list', error, exec)
      }
    },
  })

  ctx.tools.register({
    name: 'gopeed_status',
    description: 'Task by id.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
    output: {
      schema: TASK_RESULT_SCHEMA,
      render: (_args, value) => textBlock([describeTask(value.task), `(${value.baseUrl})`]),
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Gopeed task status', kind: 'other' }),
    timeoutMs: 25000,
    async execute(args, exec) {
      await ensureApiPort()
      const id = reqString(args?.id, 'id')
      try {
        const task = normalizeTask(await client.get(id))
        return { task, baseUrl: client.baseUrl() }
      } catch (error) {
        fail('status', error, exec)
      }
    },
  })

  /**
   * Newcomer guidance: only spliced into the return value of failure branches (cannot connect /
   * cannot find the program), so it costs nothing at rest. It must never enter the tool
   * definitions - those live in the system prompt on every turn.
   */
  const SETUP_GUIDE =
    'Steps: 1) If it is not installed, download and open Gopeed from https://gopeed.com. ' +
    '2) In Gopeed open Settings -> Advanced -> Protocol, keep TCP and pin the address to a fixed port such as ' +
    '127.0.0.1:9999 (Gopeed defaults to port 0, a random port per launch; the plugin can usually detect it, but ' +
    'pinning removes the guesswork). ' +
    '3) If you set a Token on the same page, copy it into the DSH plugin config (Plugins -> Installed -> dsh-gopeed -> Config). ' +
    '4) Call this tool again to retry.'

  /** Actions supported by gopeed_control: verb drives the English text, run sends the request. */
  const CONTROL_ACTIONS = {
    pause: { verb: 'pause', done: 'Paused', run: (id) => client.pause(id) },
    resume: { verb: 'resume', done: 'Resumed', run: (id) => client.resume(id) },
    remove: { verb: 'remove', done: 'Removed', run: (id, args) => client.remove(id, args?.force !== false) },
  }

  ctx.tools.register({
    name: 'gopeed_control',
    description: 'Pause/resume/remove; force deletes files.',
    parameters: {
      type: 'object',
      required: ['id', 'action'],
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['pause', 'resume', 'remove'] },
        force: { type: 'boolean' },
      },
    },
    output: {
      schema: ACTION_RESULT_SCHEMA,
      render: (_args, value) => textBlock([`${value.id} ${value.action}: ${value.message}`]),
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `Gopeed ${CONTROL_ACTIONS[args?.action]?.verb ?? 'action'}`,
      kind: 'other',
    }),
    timeoutMs: 25000,
    async execute(args, exec) {
      await ensureApiPort()
      const id = reqString(args?.id, 'id')
      const action = reqString(args?.action, 'action').toLowerCase()
      const spec = CONTROL_ACTIONS[action]
      if (!spec) throw new Error(`Unsupported action: ${action} (expected pause, resume or remove)`)
      try {
        await spec.run(id, args)
      } catch (error) {
        // Gopeed 1.9.3 answers code:1000 task not found for a finished or removed task.
        // That is normal rather than a tool error, so report it as-is.
        if (isTaskGoneError(error)) {
          return {
            ok: false,
            id,
            action,
            status: '',
            message: `Gopeed no longer has this task (usually finished or removed, code=${error.code}); nothing to ${spec.verb}.`,
          }
        }
        fail('control', error, exec)
      }
      // After a successful action, try to read the status once; unreadable status stays empty.
      let status = ''
      try {
        status = normalizeTask(await client.get(id)).status
      } catch {
        status = ''
      }
      return { ok: true, id, action, status, message: `${spec.done}.${status ? ` Current status: ${status}.` : ''}` }
    },
  })

  ctx.tools.register({
    name: 'gopeed_process',
    description: 'Diagnose.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'verdict',
          'apiState',
          'apiLatencyMs',
          'apiDetail',
          'version',
          'os',
          'arch',
          'runtime',
          'inDocker',
          'processProbe',
          'processFound',
          'pid',
          'memoryMB',
          'image',
          'exePath',
          'exeSource',
          'baseUrl',
          'advice',
        ],
        properties: {
          verdict: {
            type: 'string',
            enum: ['running', 'unresponsive', 'stopped', 'misconfigured', 'unauthorized', 'unknown'],
            description: 'Overall verdict.',
          },
          apiState: {
            type: 'string',
            enum: ['ok', 'refused', 'timeout', 'unauthorized', 'error'],
            description: 'HTTP API probe result.',
          },
          apiLatencyMs: { type: 'integer', description: 'API latency in ms.' },
          apiDetail: { type: 'string', description: 'API probe detail.' },
          version: { type: 'string', description: 'Gopeed version; empty when unreachable.' },
          os: { type: 'string', description: 'Host OS reported by Gopeed.' },
          arch: { type: 'string', description: 'Host architecture reported by Gopeed.' },
          runtime: { type: 'string', description: 'Go runtime version.' },
          inDocker: { type: 'boolean', description: 'Whether Gopeed runs in Docker.' },
          processProbe: {
            type: 'string',
            enum: ['ok', 'unavailable'],
            description: 'Process probe availability; processFound is unreliable when unavailable.',
          },
          processFound: { type: 'boolean', description: 'Whether a Gopeed process was found.' },
          pid: { type: 'integer', description: 'Process pid; 0 when unknown or not running.' },
          memoryMB: { type: 'number', description: 'Working set in MB; 0 when unknown.' },
          image: { type: 'string', description: 'Matched process image name.' },
          exePath: { type: 'string', description: 'Resolved executable path; empty when not found.' },
          exeSource: { type: 'string', description: 'Where the path came from, or why it was not found.' },
          baseUrl: { type: 'string', description: 'Base URL used for this request.' },
          advice: { type: 'string', description: 'Suggested next step.' },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Status: ${value.verdict}`,
          `API: ${value.apiState} (${value.apiLatencyMs}ms) - ${value.apiDetail}`,
        ]
        if (value.version) {
          lines.push(
            `Version: ${value.version} (${value.os}/${value.arch}, ${value.runtime || '?'}, docker=${value.inDocker})`,
          )
        }
        if (value.processProbe === 'ok') {
          lines.push(
            value.processFound
              ? `Process: ${value.image} is running, pid ${value.pid}, ${value.memoryMB} MB`
              : `Process: no ${value.image} found (it may have just exited; this does not mean launching will fail)`,
          )
        } else {
          lines.push('Process: process list unavailable here (permission restricted); the verdict relies on the API')
        }
        lines.push(
          value.exePath
            ? `Executable: ${value.exePath} (${value.exeSource})`
            : `Executable: not found (${value.exeSource})`,
        )
        lines.push(`Endpoint: ${value.baseUrl}`)
        lines.push(`Advice: ${value.advice}`)
        return textBlock(lines)
      },
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Gopeed diagnostics', kind: 'other' }),
    timeoutMs: 30000,
    async execute(_args, exec) {
      let detectedPort = await ensureApiPort()
      const options = {
        host: config.host.get(),
        port: detectedPort || Number(config.port.get()) || 0,
        token: config.token.get(),
        timeoutMs: Math.min(4000, config.timeoutMs.get()),
      }
      let api = await probeApi(options)
      // The configured port may be stale (Gopeed listens on a random port after a restart).
      // When nothing answers there, ask the OS which port the live process actually holds and
      // retry once. This is what makes "zero configuration" work despite a stale patch value.
      if (api.state === 'refused') {
        const probed = await ensureApiPort(true)
        if (probed > 0 && probed !== options.port) {
          detectedPort = probed
          options.port = probed
          api = await probeApi(options)
        }
      }
      // Process probing, executable resolution and /info are independent, so run them in
      // parallel to keep total latency down. /info is only asked for when the API already
      // answers (this is where the old gopeed_info version data comes from).
      const [resolved, proc, info] = await Promise.all([
        resolveExecutable(config.exePath.get()),
        findProcess(config.exePath.get() || 'Gopeed.exe'),
        api.state === 'ok' ? client.info().catch(() => ({})) : Promise.resolve({}),
      ])
      const meta = info && typeof info === 'object' ? info : {}

      /** The API verdict wins; process data only supplements it. */
      let verdict = 'unknown'
      let advice = ''
      if (api.state === 'ok') {
        verdict = 'running'
        advice = 'Everything looks fine; you can create tasks and check progress normally.'
      } else if (api.state === 'timeout') {
        verdict = 'unresponsive'
        advice =
          'The port is reachable but the process is not responding, so Gopeed is probably stuck: call gopeed_launch with restart=true to force a restart.'
      } else if (api.state === 'refused') {
        // A refused connection has two very different causes. When the process is verifiably
        // alive, telling the user "Gopeed is not running" sends them to the wrong fix: the real
        // problem is the port. Gopeed defaults to address `127.0.0.1:0`, i.e. a random port per
        // launch, so an untouched install is never reachable on a fixed port.
        if (proc.probe === 'ok' && proc.found) {
          verdict = 'misconfigured'
          const scanHint = config.portScan.get() === true
            ? 'The optional port scan is enabled but nothing that answers like Gopeed was found.'
            : 'Windows will not let this process read another process sockets, and the optional port scan is off by design.'
          advice =
            `Gopeed is running (pid ${proc.pid}) but its API port could not be determined: ${api.baseUrl} does not answer. ` +
            `${scanHint} Open Gopeed -> Settings -> Advanced -> Protocol, read the fixed port shown there ` +
            '(Gopeed uses a random port by default), then set "port" in the plugin config to that value.'
        } else {
          verdict = 'stopped'
          advice = 'Gopeed is not running: use gopeed_launch to start it (same as double-clicking the icon).'
        }
      } else if (api.state === 'unauthorized') {
        verdict = 'unauthorized'
        advice = 'The process is fine, the token is wrong: set the plugin config token to the one configured in Gopeed.'
      } else {
        advice = `Cannot reach ${api.baseUrl}: check the host/port, or confirm the protocol in Gopeed settings is set to TCP.`
      }
      if (verdict === 'unresponsive' && proc.probe === 'ok' && proc.found) {
        advice += ` (process pid ${proc.pid} is confirmed alive)`
      }
      // When even the executable cannot be located, the next step is needed whatever the API
      // state is: first confirm whether it is installed, then point at the plugin settings page
      // for a manual path. The API-level advice is kept after it.
      if (!resolved.path) {
        advice =
          'Could not find the Gopeed installation: if it is installed (for example a portable build), ' +
          'set "Executable path" in the plugin settings to the full path of Gopeed.exe.' +
          (advice ? ` (Also: ${advice})` : '')
      }
      // Newcomer guidance only appears in failure branches (API unreachable = not installed /
      // not started / protocol not TCP). The success path stays short.
      if (api.state === 'refused' || api.state === 'error') {
        advice += `\nIf Gopeed is not installed or not configured yet: ${SETUP_GUIDE}`
      }
      // A diagnosis that ends in "not usable" is exactly when the person needs the notice, so
      // the diagnostic tool raises it too; notifySetupNeeded de-duplicates per plugin instance.
      if (verdict !== 'running' && verdict !== 'unauthorized') notifySetupNeeded(exec)

      return {
        verdict,
        apiState: api.state,
        apiLatencyMs: Math.max(0, Math.round(api.latencyMs || 0)),
        apiDetail: api.detail,
        version: String(api.version || meta.version || ''),
        os: String(meta.os ?? ''),
        arch: String(meta.arch ?? ''),
        runtime: String(meta.runtime ?? ''),
        inDocker: Boolean(meta.inDocker),
        processProbe: proc.probe,
        processFound: Boolean(proc.found),
        pid: Number(proc.pid) || 0,
        memoryMB: Number(proc.memoryMB) || 0,
        image: String(proc.image ?? ''),
        exePath: resolved.path,
        exeSource: resolved.path
          ? resolved.source
          : `not found (tried: ${
              resolved.tried.length > 0
                ? resolved.tried.join('; ')
                : 'configured path, default install path, running process / registry / shortcuts, common install paths'
            })`,
        baseUrl: api.baseUrl || client.baseUrl(),
        advice,
      }
    },
  })

  ctx.tools.register({
    name: 'gopeed_launch',
    description: 'Start/restart.',
    parameters: {
      type: 'object',
      properties: {
        restart: { type: 'boolean' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['launched', 'alreadyRunning', 'restarted', 'pid', 'apiState', 'message'],
        properties: {
          launched: { type: 'boolean', description: 'Whether a start was actually attempted.' },
          alreadyRunning: { type: 'boolean', description: 'Whether Gopeed was running before the call.' },
          restarted: { type: 'boolean', description: 'Whether it was killed and started again.' },
          pid: { type: 'integer', description: 'Pid of the new process; 0 when nothing started.' },
          apiState: {
            type: 'string',
            enum: ['ok', 'refused', 'timeout', 'unauthorized', 'error'],
            description: 'Last API probe result after launching.',
          },
          message: { type: 'string', description: 'Human-readable result.' },
        },
      },
      render: (_args, value) => textBlock([value.message]),
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: args?.restart ? 'Restart Gopeed' : 'Start Gopeed',
      kind: 'execute',
    }),
    timeoutMs: 40000,
    async execute(args, exec) {
      await ensureApiPort()
      const restart = args?.restart === true
      const base = {
        host: config.host.get(),
        port: config.port.get(),
        token: config.token.get(),
        timeoutMs: 3000,
      }
      // Ask the API first: when it is already running, skip pointless path detection (saves one
      // PowerShell invocation).
      const before = await probeApi(base)
      const alreadyRunning = before.state === 'ok'

      if (alreadyRunning && !restart) {
        return {
          launched: false,
          alreadyRunning: true,
          restarted: false,
          pid: 0,
          apiState: before.state,
          message: `Gopeed is already running (${before.detail}); not starting it again. Add restart=true to recover a stuck process.`,
        }
      }

      // Look for the executable only when a start is really needed (the result is cached in-process).
      const resolved = await resolveExecutable(config.exePath.get())
      const exePath = resolved.path

      if (restart) {
        // Restarting needs the pid; when it cannot be read, say so instead of faking success.
        const proc = await findProcess(exePath)
        if (proc.probe !== 'ok') {
          return {
            launched: false,
            alreadyRunning,
            restarted: false,
            pid: 0,
            apiState: before.state,
            message: `A restart needs the process pid, but the process list is unavailable here (${proc.detail}). End Gopeed manually and call gopeed_launch, or double-click the icon.`,
          }
        }
        if (!proc.found) {
          return {
            launched: false,
            alreadyRunning: false,
            restarted: false,
            pid: 0,
            apiState: before.state,
            message: `No ${proc.image} process found, so there is nothing to restart. To start it use restart=false (or just call gopeed_launch).`,
          }
        }
        const stopped = await stopProcess(proc.pid)
        if (!stopped.ok) {
          return {
            launched: false,
            alreadyRunning,
            restarted: false,
            pid: 0,
            apiState: before.state,
            message: stopped.message,
          }
        }
        // Give the port and file handles a moment to be released.
        await new Promise((resolve) => setTimeout(resolve, 900))
      }

      if (!exePath) {
        return {
          launched: false,
          alreadyRunning,
          restarted: false,
          pid: 0,
          apiState: before.state,
          message:
            'Cannot start Gopeed: Gopeed.exe was not found. Confirm it is installed; ' +
            'if it is (for example a portable build), set "Executable path" in the plugin settings to the full path of Gopeed.exe. ' +
            `Tried: ${resolved.tried.join('; ') || 'configured path, default install path, running process / registry / shortcuts, common install paths'}. ` +
            'You can also start it by double-clicking the icon.' +
            // Newcomer guidance only appears on this "program not found" path; the success path
            // carries no extra context.
            `\nIf Gopeed is not installed or not configured yet: ${SETUP_GUIDE}`,
        }
      }

      const launch = await launchProcess(exePath)
      if (!launch.ok) {
        return {
          launched: false,
          alreadyRunning,
          restarted: false,
          pid: 0,
          apiState: before.state,
          message: `Launch failed: ${launch.message}. Used ${exePath} (source: ${resolved.source}). You can change it under "Executable path" in the plugin config.`,
        }
      }

      const after = await waitForApi({ ...base, waitMs: 10000 })
      const ok = after.state === 'ok'
      return {
        launched: true,
        alreadyRunning,
        restarted: restart,
        pid: Number(launch.pid) || 0,
        apiState: after.state,
        message: ok
          ? `${restart ? 'Restarted' : 'Started'} Gopeed (pid ${launch.pid}); API ready: ${after.detail}.`
          : `${restart ? 'Restarted' : 'Started'} Gopeed (pid ${launch.pid}), but the API was not ready within 10s (${after.state}: ${after.detail}). Gopeed may still be loading; check again with gopeed_process later.`,
      }
    },
  })

  ctx.logger?.info?.(`dsh-gopeed: registered 6 tools, endpoint ${client.baseUrl()}`)
}

/** Exported for debugging / reuse: format a byte count as readable text. */
export { formatBytes }

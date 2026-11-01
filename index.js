/**
 * dsh-gopeed-downloader - exposes the Gopeed downloader REST API as DSH agent tools.
 *
 * Layout:
 * - Config: downloadTarget / customDownloadPath / host / port / token / timeoutMs / exePath /
 *   portScan / webhookMode / webhookPort / webhookNotify / webhookToast, all `.volatile()`, so edits
 *   in the DSH settings UI (Plugins -> Installed -> dsh-gopeed-downloader -> Config) take effect immediately.
 * - apply: registers six tools on ctx.tools (add / list / status / control / process / launch) plus
 *   gopeed_events, and starts the loopback webhook receiver when webhookMode is manual or auto.
 *   With webhookNotify on, an accepted event is delivered through up to THREE channels, none of
 *   which writes a chat bubble: a DSH background job (only for a download gopeed_add started, see
 *   below) whose settlement becomes the harness's own completion notice, Agent.inject as the
 *   fallback that queues one model-facing context line for the next pre-step when no job tracks
 *   the download (it never wakes the driver and is never rendered as a user message), and a small
 *   GET route feeding the plugin's own overlay toast, so the human still sees a notice outside
 *   the chat.
 *   Agent.followup is deliberately not used: it opens a reply turn and renders as if the user had
 *   typed the plugin's text, which is exactly the intrusion this plugin must not commit. A WeakRef
 *   keeps no session alive.
 * - Download wake-up: gopeed_add registers a DSH background job (kind 'gopeed') that polls the
 *   Gopeed task every 3s (30s while the task is paused or waiting) and settles when it ends.
 *   dsh-tool-jobs turns that settlement into its own in-session notice, so a busy agent reads it in
 *   its next step and an idle agent is woken by a follow-up turn - the official channel, with no
 *   user-role text authored by this plugin. The registry is optional: without ctx.jobs, gopeed_add
 *   still works and says why there is no job. A job-tracked download also suppresses the inject
 *   channel for that task id, because both channels carry the same completion fact.
 * - lib/api.js: HTTP and process-probing layer without any DSH dependency, so it also runs
 *   standalone under plain node.
 * - lib/webhook.js: loopback webhook receiver + ring buffer, also with no DSH dependency.
 *
 * Sandbox policy (strategy 3): the two actions that change the machine - starting Gopeed and
 * stopping it - go through the optional `ctx.sandbox` service and obey the session's file policy;
 * every read-only diagnostic (process table, sockets, executable lookup, loopback API probe) stays
 * direct, because a restricted token routinely cannot see another process and a blind diagnosis is
 * worse than an honestly labelled one. Both outcomes are reported, never silently degraded: a
 * sandbox that refuses fails the action, and a host without a sandbox runs it and says so.
 * `lib/` stays free of DSH imports: confinement is injected as a plain function per call.
 *
 * Hard rule for Gopeed config: exactly one code path may write it (PUT /api/v1/config) - the
 * `action` branch of gopeed_events, which first refuses unless webhookMode is auto. Nothing in
 * apply(), in a timer, or on any automatic path writes config: `off` and `manual` never do, and
 * `auto` only writes when the user explicitly calls that action. Reading config (GET) is allowed
 * anywhere.
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
 * tool definitions: those stay in the system prompt for every turn. It only appears at runtime,
 * inside the tool's own output - the failure branch's return value (SETUP_GUIDE -> advice /
 * message) or one longer SETUP_NOTICE appended to an error / the diagnostic advice. Nothing the
 * plugin says is ever posted as a chat message on the user's behalf: no followup, no deferContext.
 *
 * Encoding: this file must stay UTF-8 without BOM. Do not batch-edit it in PowerShell 5.1:
 * Get-Content -Raw / Set-Content decode UTF-8 as GBK and destroy non-ASCII characters such as
 * -> - [!] (recovering requires a full rewrite). Use an editor or Node's fs instead.
 */
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
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
import { createWebhookReceiver, mergeWebhookUrls } from './lib/webhook.js'

/** Plugin name used by the Loader for diagnostics. */
export const name = 'dsh-gopeed-downloader'

/** Required Host service: the tool registry. */
export const inject = ['tools']

/**
 * Version of the installed plugin package, read once from this plugin's own package.json.
 * The browser half of the plugin is only loaded when DSH starts, so after an upgrade the page can
 * still run an older UI bundle. gopeed_process reports this backend version so the agent can tell
 * the user they are seeing a stale UI and need to restart DSH - without this field there is nothing
 * to compare against. A missing or unreadable package.json falls back to the constant below.
 */
const FALLBACK_VERSION = '0.3.3'

const PLUGIN_VERSION = (() => {
  try {
    const raw = readFileSync(new URL('./package.json', import.meta.url), 'utf8')
    const version = JSON.parse(raw)?.version
    if (typeof version === 'string' && version.trim()) return version.trim()
  } catch {
    // A packaged or partially copied install may not expose package.json; keep the constant.
  }
  return FALLBACK_VERSION
})()

/**
 * Test seam for the restart path: the process helpers are looked up at call time so a test can
 * replace them with counting stubs and exercise a restart without touching a real Gopeed process.
 * Production code never reassigns these.
 */
export const processOps = { findProcess, stopProcess, launchProcess, waitForApi, resolveExecutable }

/**
 * Cadence and hard limits of the download-tracking background job, exported as a test seam so a
 * stub can drive the poller without waiting three seconds per tick. Production never reassigns it.
 *
 * A running download is polled at `pollIntervalMs`. A task in `pause` or `wait` is NOT moving, so
 * it is polled at the much slower `slowPollIntervalMs` instead: waking the agent about a paused
 * download every three seconds buys nothing and burns a request per tick.
 *
 * `maxPolls` / `maxAgeMs` are the "do not run forever" bound for a moving download (28800 polls =
 * 24h at 3s). A stalled task is never reported as `failed`: pausing is not failing, so it gets its
 * own budget (`maxSlowPolls` = 24h at 30s) and its own honest terminal outcome (killed, "still
 * paused", download NOT cancelled) instead of a false failure.
 *
 * `maxConsecutiveFailures` is deliberately much shorter: if the Gopeed API stays unreachable for a
 * minute, the job cannot observe the download any more, and a wake-up that says so is better than
 * one that never arrives.
 */
export const jobOps = {
  pollIntervalMs: 3000,
  slowPollIntervalMs: 30000,
  maxPolls: 28800,
  maxSlowPolls: 2880,
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxConsecutiveFailures: 20,
}

/** Producer kind of the tracking job; also the id prefix (`gopeed-<short-uuid>`). */
const TRACKED_KIND = 'gopeed'

/** Statuses that mean "the download is not moving right now" - not an error, just stalled. */
const SLOW_STATUSES = new Set(['pause', 'wait'])

/**
 * Plugin configuration.
 *
 * Note `.volatile()`: only volatile fields show up in the DSH settings form, and writing them
 * back does not remount the plugin (changes apply immediately). `role('secret')` makes the token
 * read back as set/unset instead of echoing it to the frontend.
 */
export const Config = z.object({
  downloadTarget: z
    .union(['workspace', 'gopeed', 'custom'])
    .default('workspace')
    .description(
      'Where a gopeed_add download is saved. workspace (default) = the current session workspace directory; ' +
        'gopeed = leave the path unset so Gopeed uses the download directory from its own settings; ' +
        'custom = use customDownloadPath. An explicit path argument to gopeed_add always wins over this.',
    )
    .volatile(),
  customDownloadPath: z
    .string()
    .default('')
    .description(
      'Absolute download directory used when downloadTarget is custom. Leading and trailing whitespace is ' +
        'trimmed. When it is empty, the download falls back to the Gopeed default directory. Ignored for the ' +
        'other targets.',
    )
    .volatile(),
  host: z
    .string()
    .default('127.0.0.1')
    .description(
      'Gopeed listen address: the IP or host name only, from Gopeed Settings -> Advanced -> Protocol (TCP). ' +
        'Use 127.0.0.1 when it only listens locally. Do not add a scheme or a port (the port has its own field). ' +
        'The settings form requires it and rejects an empty value.',
    )
    .volatile(),
  port: z
    .number()
    .step(1)
    .min(0)
    .max(65535)
    .default(0)
    .description(
      'Gopeed listen port. 0 (default) = auto-detect: Gopeed\'s desktop build listens on 127.0.0.1:0, a random ' +
        'port per launch, so the plugin asks Windows which port the running process actually holds. Set a ' +
        'number only to pin a specific port. An empty port field in the settings form is rejected; type 0 explicitly ' +
        'for auto-detect.',
    )
    .volatile(),
  token: z
    .string()
    .role('secret')
    .default('')
    .description(
      'Gopeed token, sent as a request header. Gopeed ships with an EMPTY token, which disables auth; ' +
        'leave this blank to match. If you set a token in Gopeed -> Settings -> Advanced, enter the exact ' +
        'same value here. An empty field in the settings form keeps the saved token instead of clearing it.',
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
  webhookMode: z
    .union(['off', 'manual', 'auto'])
    .default('off')
    .description(
      'Download-complete push events. off (default) = listen on no port at all. manual = listen and show the URL, ' +
        'which you then add yourself in Gopeed -> Settings -> Developer -> Webhook push. auto = listen too, and the ' +
        'gopeed_events action=apply step may save that URL into Gopeed config when you explicitly ask for it.',
    )
    .volatile(),
  webhookPort: z
    .number()
    .step(1)
    .min(0)
    .max(65535)
    .default(0)
    .description(
      'Loopback port used by webhookMode manual/auto. 0 (default) = a free port chosen by the system; the real ' +
        'listener URL is always reported by gopeed_events. If the port is already taken the listener fails loudly.',
    )
    .volatile(),
  webhookNotify: z
    .boolean()
    // On by default again: every delivery channel stays outside the chat transcript. The Web UI
    // shows a transient overlay toast, and a completion no background job covers is queued as
    // model-facing context through Agent.inject (never a user chat bubble, never a waking
    // follow-up). A gopeed_add download is announced by its background job instead, which is also
    // the only channel that can wake an idle agent.
    .default(true)
    .description(
      'Show a small overlay notice in the Web UI and add a one-line context note for the agent when a download ' +
        'finishes. Needs a webhook listener (webhookMode manual or auto). A download started by gopeed_add is ' +
        'announced by its background job instead, so it is not repeated here. Nothing is ever posted into the ' +
        'chat, and this setting itself never wakes an idle agent. Set false to keep events cache-only.',
    )
    .volatile(),
  webhookToast: z
    .boolean()
    // Off by default: Gopeed already posts its own notification through the Windows notification
    // center, so a second toast is noise unless the user explicitly wants the extra detail.
    .default(false)
    .description(
      'Show the plugin own bottom-right toast when a download finishes. Gopeed already posts its own ' +
        'Windows notification, so this duplicates it - enable it only for the extra detail (name, size, ' +
        'path). Affects user-facing toasts only; job wake-up (polling), the Agent.inject fallback and the ' +
        'gopeed_events cache are unaffected.',
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

/** Status values the gopeed_list filter accepts. Kept out of the tool schema: the definition
 * budget is hard, and execute() validates and reports the full list on a typo. */
const TASK_STATUSES = ['ready', 'running', 'pause', 'wait', 'error', 'done']

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

/** One event accepted from a Gopeed webhook push. */
const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['event', 'at', 'taskId', 'name', 'status', 'path', 'sizeBytes'],
  properties: {
    event: { type: 'string', enum: ['DOWNLOAD_DONE', 'DOWNLOAD_ERROR'], description: 'Event type.' },
    at: { type: 'integer', description: 'Event time in ms since epoch.' },
    taskId: { type: 'string', description: 'Gopeed task id.' },
    name: { type: 'string', description: 'Task name.' },
    status: { type: 'string', description: 'Task status carried by the event.' },
    path: { type: 'string', description: 'Save directory; may be empty.' },
    sizeBytes: { type: 'integer', description: 'Total bytes; 0 when unknown.' },
  },
}

/** Result of gopeed_events: either the recent events, or the outcome of the config-write action. */
const EVENTS_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'action', 'listener', 'listening', 'count', 'unread', 'events', 'applied', 'message'],
  properties: {
    mode: { type: 'string', enum: ['off', 'manual', 'auto'], description: 'Webhook mode in effect.' },
    action: { type: 'string', description: 'apply (config save); empty for a read.' },
    listener: { type: 'string', description: 'Listener URL; empty when nothing is listening.' },
    listening: { type: 'boolean', description: 'Whether the receiver is listening right now.' },
    count: { type: 'integer', description: 'Events returned by this call.' },
    unread: { type: 'integer', description: 'Events that were unread before this call.' },
    events: { type: 'array', items: EVENT_SCHEMA },
    applied: { type: 'boolean', description: 'Whether Gopeed webhook config was saved by this call.' },
    listenerUrl: { type: 'string', description: 'URL saved into Gopeed config (apply only).' },
    message: { type: 'string', description: 'Human-readable result, or why nothing was done.' },
  },
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
   * gopeed_add's own client: the same connection parameters as `client` above (a detected port
   * still wins over the configured one), plus a per-call request timeout that gopeed_add squeezes
   * into its internal budget. 0 means "use Config.timeoutMs", which is what every other tool keeps
   * doing through `client`. A separate instance keeps one call's squeeze away from the others.
   */
  let addRequestTimeoutMs = 0
  const addClient = createGopeedClient({
    resolve: () => {
      const budget = Number(addRequestTimeoutMs)
      const configured = config.timeoutMs.get()
      return {
        host: config.host.get(),
        port: autoPort > 0 ? autoPort : Number(config.port.get()) || 0,
        token: config.token.get(),
        // Only ever shorten: a generous budget must not extend a deliberately short config value.
        timeoutMs: budget > 0 ? Math.min(budget, configured) : configured,
      }
    },
  })

  // ---------------------------------------------------------------------------------------------
  // Sandbox seam (strategy 3): actions go through the sandbox, diagnostics stay direct.
  //
  // `ctx.sandbox` is an OPTIONAL dependency. It is mounted by the profile's `include:sandbox`
  // row, but a host without it must still load this plugin and register all seven tools, so the
  // service is resolved through ctx.inject and its absence is a reported fact, not a load error.
  //
  // What is confined: the exact argv that starts Gopeed and the `taskkill` that stops it. Both
  // write to the machine, so the session's file policy governs them. What is NOT confined: the
  // read-only diagnostics (tasklist / powershell Get-Process / netstat / Get-NetTCPConnection /
  // netsh / existsSync / the loopback fetch). A restricted token often cannot see another
  // process's entry or sockets, which would turn "I cannot see it" into the false verdict
  // "Gopeed is not running" - and every gopeed_process result says so explicitly.
  //
  // The policy rides the call: `ctx.sandboxPolicy.resolve({ session })` is re-read per action, so
  // a runtime mode switch applies without remounting anything. When no policy service is composed
  // the policy package's own fail-safe defaults are used (read-only, process.cwd()).
  // ---------------------------------------------------------------------------------------------

  /** Live optional services; null while the corresponding dependency is absent. */
  const sandboxRuntime = { sandbox: null, policy: null }

  /** ASCII guard: the seam's own error text carries non-ASCII punctuation, ours must not. */
  const asciiText = (value) => String(value ?? '').replace(/[^\x20-\x7e]/g, '-')

  /** Strip trailing sentence punctuation so composed messages never end in "..". */
  const trimPeriod = (value) => String(value ?? '').replace(/[\s.]+$/, '')

  /** Look a service up without assuming the Context exposes a property getter for it. */
  const lookupService = (scoped, name) => {
    try {
      if (scoped && typeof scoped.get === 'function') {
        const found = scoped.get(name)
        if (found) return found
      }
      const direct = scoped?.[name]
      return direct || null
    } catch {
      return null
    }
  }

  /**
   * Resolve the file policy for one action. The calling session makes its own cwd the
   * workspace-write boundary; a call without a session (the config-page restart button) falls back
   * to the deployment policy, exactly as the official consumers do.
   * @param {any} exec Tool run context, or undefined for a browser-route action.
   */
  const resolveSandboxPolicy = (exec) => {
    const service = sandboxRuntime.policy
    const session = exec?.agent?.session
    if (service && typeof service.resolve === 'function') {
      try {
        const resolved = service.resolve(session === undefined ? {} : { session })
        if (resolved && typeof resolved === 'object' && typeof resolved.mode === 'string') {
          return {
            mode: resolved.mode,
            workspaceRoot:
              typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot
                ? resolved.workspaceRoot
                : process.cwd(),
            ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-gopeed-downloader: sandbox policy resolution failed: ${asciiText(error?.message || error)}`)
      }
    }
    // No policy service: mirror the policy package's documented fail-safe defaults instead of
    // guessing a wider mode. The action then honestly fails if that mode denies it.
    return { mode: 'read-only', workspaceRoot: process.cwd() }
  }

  /**
   * Build the per-call confinement function handed to lib/api.js. It never throws for a policy
   * refusal: a refusal is a `blocked` decision, because lib/ has no DSH types to catch.
   *
   * Outcomes:
   * - `status: 'confined'`     argv wrapped, execution obeys the sandbox;
   * - `status: 'unavailable'`  no sandbox service on this host: run, but report it;
   * - `status: 'full-access'`  the user's policy is danger-full-access: run unconfined by policy;
   * - `status: 'denied'`       sandbox present but cannot confine: block, report, never run.
   * @param {any} exec Tool run context, or undefined for a browser-route action.
   */
  const makeConfiner = (exec) => async (argv, purpose) => {
    const sandbox = sandboxRuntime.sandbox
    const policy = resolveSandboxPolicy(exec)
    const action = purpose === 'stop' ? 'stopping Gopeed' : 'starting Gopeed'
    if (!sandbox || typeof sandbox.confine !== 'function') {
      return {
        argv,
        sandboxed: false,
        status: 'unavailable',
        // No policy governed this execution, so reporting a mode here would be a lie.
        mode: '',
        enforcement: '',
        detail:
          `No sandbox service is available on this host, so ${action} ran with the DSH host's own ` +
          'permissions and was NOT confined by any file policy.',
      }
    }
    if (policy.mode === 'danger-full-access') {
      // The official consumers never consult the provider under danger-full-access.
      return {
        argv,
        sandboxed: false,
        status: 'full-access',
        mode: policy.mode,
        enforcement: '',
        detail:
          `The file policy in effect is danger-full-access, so ${action} ran without confinement ` +
          'by that policy.',
      }
    }
    try {
      const confined = await sandbox.confine(argv, policy, exec?.signal)
      const wrapped = Array.isArray(confined?.argv) ? confined.argv : null
      if (!wrapped || wrapped.length === 0) {
        return {
          argv,
          sandboxed: false,
          blocked: true,
          status: 'denied',
          mode: policy.mode,
          enforcement: '',
          detail:
            `The sandbox returned no runnable command for ${action}, so nothing was executed. ` +
            'Retry after the sandbox backend is repaired, or use the plugin config page manually.',
        }
      }
      return {
        argv: wrapped,
        sandboxed: true,
        status: 'confined',
        mode: policy.mode,
        enforcement: String(confined?.enforcement ?? ''),
        detail:
          `${action} ran confined by the sandbox under the "${policy.mode}" file policy ` +
          `(enforcement: ${String(confined?.enforcement ?? 'unknown')}).`,
      }
    } catch (error) {
      const code = asciiText(error?.code ?? error?.name ?? 'unknown')
      const unavailable = String(error?.code ?? '') === 'SANDBOX_UNAVAILABLE'
      const manual =
        purpose === 'stop'
          ? 'stop Gopeed yourself with Task Manager'
          : 'start Gopeed yourself by double-clicking its icon'
      const detail = unavailable
        ? `The sandbox refused to run ${action}: the "${policy.mode}" mode has no usable backend on ` +
          `this host (SANDBOX_UNAVAILABLE). Nothing was started or stopped. Repair the sandbox ` +
          `backend (or switch the file policy to danger-full-access) and retry, or ${manual}. ` +
          'The config-page Restart button is a user action and is NOT confined by this sandbox, so it can still restart Gopeed.'
        : `The sandbox refused to run ${action} (${code}): ${asciiText(error?.message || error)}. ` +
          `Nothing was started or stopped. Retry after the sandbox backend is repaired, or ${manual}.`
      return {
        argv,
        sandboxed: false,
        blocked: true,
        status: 'denied',
        mode: policy.mode,
        enforcement: '',
        detail,
      }
    }
  }

  /**
   * Project confinement facts into the flat fields gopeed_launch and the restart route report.
   * A branch that never reached the sandbox passes no facts and gets an explicit empty answer.
   * @param {object} [sandbox] Facts returned by lib/api.js.
   */
  const sandboxReport = (sandbox) => ({
    launchSandboxed: Boolean(sandbox?.sandboxed),
    sandboxMode: String(sandbox?.mode ?? ''),
    sandboxDetail: String(sandbox?.detail ?? ''),
  })

  /** Facts for a branch that did not attempt a process action at all. */
  const NO_LAUNCH_SANDBOX = sandboxReport({
    sandboxed: false,
    mode: '',
    detail: 'No launch was attempted, so the sandbox made no decision.',
  })

  /**
   * Track the optional sandbox dependency. The callback runs when `ctx.sandbox` appears and its
   * effect cleanup clears the reference when the service goes away (plugin unload or profile
   * reload), so a stale provider is never called. `ctx.sandboxPolicy` is looked up separately and
   * may be absent without disabling confinement.
   * @param {any} scoped Context that resolved the sandbox service.
   */  const installSandbox = (scoped) => {
    sandboxRuntime.sandbox = scoped?.sandbox ?? null
    sandboxRuntime.policy = lookupService(scoped, 'sandboxPolicy')
    const detail = sandboxRuntime.policy ? 'policy service available' : 'no policy service, read-only default'
    ctx.logger?.info?.(`dsh-gopeed-downloader: sandbox available (${detail}); launch and stop are confined`)
    scoped?.effect?.(() => () => {
      sandboxRuntime.sandbox = null
      sandboxRuntime.policy = null
    })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['sandbox'], installSandbox)
  } else {
    // Simplified hosts / tests without Cordis injection: use a direct lookup once.
    const sandbox = lookupService(ctx, 'sandbox')
    if (sandbox) installSandbox({ sandbox, effect: (fn) => ctx.effect?.(fn) })
    else ctx.logger?.info?.('dsh-gopeed-downloader: no sandbox service; launch and stop will be reported as unconfined')
  }

  /** The one rule this plugin contributes to the system prompt; empty string means "do not inject". */
  const GOPEED_PROMPT_TEXT =
    'Use gopeed_add as the default download tool (background job, notifies on completion, ' +
    'no polling).'

  // The agent-facing contract lives in docs/AGENTS.md, and nothing loads that file automatically: an
  // agent that never opens it behaves as if the contract did not exist. This section puts the one rule
  // that prevents the most common wrong call into the system prompt itself. It sits right after the
  // shell tools on purpose -- the moment to read it is just before reaching for a shell.
  const installPromptSection = (scoped) => {
    const prompt = scoped?.systemPrompt
    if (!prompt || typeof prompt.section !== 'function') return
    const webOrder = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_WEB_SEARCH') : undefined
    prompt.section({
      name: 'tool:gopeed',
      // Next to the other "fetch something from the network" tools, not next to the shell tools: the
      // rule is about downloading a file, and sitting right against pwsh made it read like a general
      // warning about using a shell at all.
      order: Number.isFinite(webOrder) ? webOrder - 10 : 1990,
      // Same contract as the official dsh-tool-web sections: `text` is a function of the assembly,
      // and a scope that does not expose gopeed_add gets an empty string instead of being told to
      // use a tool it cannot see. `tools.get(name, scope)` is the exact lookup the harness itself
      // uses for that decision. A simplified host without that lookup keeps the static text, so a
      // missing service degrades to the old guidance rather than throwing during prompt assembly.
      text: ({ scope } = {}) => {
        const tools = lookupService(scoped, 'tools') ?? ctx.tools
        if (!tools || typeof tools.get !== 'function') return GOPEED_PROMPT_TEXT
        try {
          return tools.get('gopeed_add', scope) === undefined ? '' : GOPEED_PROMPT_TEXT
        } catch {
          return GOPEED_PROMPT_TEXT
        }
      },
    })
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], installPromptSection)
  } else if (lookupService(ctx, 'systemPrompt')) {
    installPromptSection(ctx)
  }

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

  // ---------------------------------------------------------------------------------------------
  // Proactive notice path. The webhook receiver runs with no tool call attached, so "a download
  // finished" can only be surfaced if the plugin remembers an Agent. Three channels are used and
  // none of them writes a chat bubble:
  //
  // 1) The DSH background job registered by gopeed_add (see the next section). Its settlement
  //    becomes dsh-tool-jobs' own completion notice - the harness text, delivered in-session, with
  //    a follow-up turn on an idle owner. This is the only channel that can WAKE an agent, and it
  //    only exists for downloads this plugin started itself.
  // 2) Agent.inject: queues one line of model-facing context for the next pre-step. It does NOT
  //    wake the driver and is not rendered as a user message. Nothing appears in the chat. It is
  //    the FALLBACK for a completion no job covers: a download started in the Gopeed UI or by
  //    another client, or any download on a host without ctx.jobs. When a job does cover the task
  //    id, this channel stays silent for it - both would otherwise say the same thing twice.
  // 3) A GET route (registered on ctx.connection when the Web carrier is available) feeds a
  //    transient overlay toast rendered by client.js, so the human still gets a visible notice
  //    outside the conversation. The toast is independent of both agent channels above.
  //
  // Agent.followup is deliberately absent: it opens a reply turn and renders as a message the user
  // supposedly wrote. That is the plugin occupying the user's seat, and it is forbidden here.
  //
  // The reference is a WeakRef: the plugin must never keep a finished session alive. Every write
  // path below is wrapped in try/catch - a disposed agent, an expired WeakRef or a throwing
  // inject must never reach the webhook receiver, which has to keep accepting events.
  // ---------------------------------------------------------------------------------------------

  /** Most recent Agent seen by a tool execute(), or null before any gopeed tool has run. */
  let lastAgentRef = null
  /** When the reference above was refreshed (ms epoch); diagnostics only. */
  let lastAgentAt = 0

  /**
   * Remember the calling Agent. One line per execute() and never throws: a missing exec or an
   * unusable Agent simply leaves notifications disabled.
   * @param {any} exec Tool run context.
   */
  const rememberAgent = (exec) => {
    try {
      const agent = exec?.agent
      // inject() is the non-waking context channel; a followup-only Agent is useless here and is
      // therefore not remembered (it would lead straight back to a chat bubble).
      if (agent && typeof agent === 'object' && typeof agent.inject === 'function') {
        lastAgentRef = new WeakRef(agent)
        lastAgentAt = Date.now()
      }
    } catch {
      // A host that does not hand out Agents, or no WeakRef support: stay silent, tools still work.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Download-completion background job.
  //
  // A download is long-running work with a natural end, which is exactly what the DSH job registry
  // models. Registering one buys the only official "wake the agent" channel this plugin has: when
  // the job settles, dsh-tool-jobs emits its own in-session notice, so a BUSY owner reads it in its
  // next step and an IDLE owner is woken by a follow-up turn. The notice text belongs to the
  // harness; nothing here writes a user-role message, so no chat bubble is drawn and the user is
  // not impersonated.
  //
  // Channel ownership: a job covers exactly the downloads gopeed_add started. The webhook toast
  // stays independent (it is human-facing and also covers downloads this plugin did not start),
  // and the inject channel stays as the fallback for a completion no job covers. The webhook
  // inject path checks `jobCoversTask` below and stays silent for a task id a job owns, because a
  // real session proved that both channels otherwise deliver the same completion twice.
  //
  // ctx.jobs is an OPTIONAL service. A host that composes no jobs provider (or no controller that
  // serves this owner's session) must still run every gopeed tool, so resolution happens per call
  // and every failure degrades to "no jobId plus a note", never to a failed gopeed_add.
  //
  // Ownership: the job is registered for the calling agent's session, which is what routes the
  // completion notice back to that agent. Without a session id there is no owner and the registry
  // would create an unowned job that no notice ever mentions, so that case is treated as degraded.
  //
  // The job polls Gopeed through the SAME client the tools use, so it inherits the token, timeout
  // and auto-detected-port handling. It owns one timer, settles exactly once, and is cancelled from
  // gopeed_control remove, from the age/poll cap, and from plugin unload - a removed download can
  // never leave an orphan poller behind. Timers are unref'ed so a pending job cannot keep the DSH
  // process alive.
  // ---------------------------------------------------------------------------------------------

  /** taskId -> tracking record for downloads this plugin is following right now. */
  const downloadJobs = new Map()

  /**
   * taskId -> epoch ms until which the webhook inject channel must stay silent for that task.
   *
   * A finished download reaches this plugin twice: the job poller observes the terminal state and
   * dsh-tool-jobs emits its own notice, and Gopeed's webhook posts DOWNLOAD_DONE at the same moment.
   * Delivering both put the same sentence into the model context twice. The job notice is the
   * richer and the only waking channel, so it wins for a task a job ever covered; the inject
   * channel then only serves completions no job can see. The window covers the webhook's own
   * latency and the merge debounce, and costs nothing after it expires.
   */
  const jobCoveredTasks = new Map()
  /** How long a tracked task id keeps the inject channel silent, measured from its last update. */
  const JOB_DEDUP_WINDOW_MS = 10 * 60 * 1000

  /** Remember that a job owns this task id, and prune expired entries while doing it. */
  const markJobCovered = (taskId) => {
    if (!taskId) return
    try {
      const now = Date.now()
      for (const [id, until] of jobCoveredTasks) {
        if (until <= now) jobCoveredTasks.delete(id)
      }
      jobCoveredTasks.set(String(taskId), now + JOB_DEDUP_WINDOW_MS)
    } catch {
      // Bookkeeping only: never let it break a job or the receiver.
    }
  }

  /** Whether a background job covers this task id, so inject must not repeat its completion. */
  const jobCoversTask = (taskId) => {
    if (!taskId) return false
    const until = jobCoveredTasks.get(String(taskId))
    if (until === undefined) return false
    if (until <= Date.now()) {
      jobCoveredTasks.delete(String(taskId))
      return false
    }
    return true
  }

  /** Resolve ctx.jobs without assuming the Context exposes a property getter for it. */
  const resolveJobService = () => lookupService(ctx, 'jobs')

  /** Session id of the calling agent, or '' when this host hands out no usable Agent. */
  const sessionIdOf = (exec) => {
    try {
      const id = exec?.agent?.session?.id
      return typeof id === 'string' ? id : ''
    } catch {
      return ''
    }
  }

  /** One-line label fragment: names arrive from Gopeed and may contain newlines or runs of spaces. */
  const labelText = (value, limit = 80) => {
    const text = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length > limit ? `${text.slice(0, limit - 1)}...` : text
  }

  /** File name of a URL path, without the query string; '' when the URL cannot be parsed. */
  const urlBasename = (url) => {
    try {
      const last = new URL(String(url)).pathname.split('/').filter(Boolean).pop() || ''
      return decodeURIComponent(last)
    } catch {
      return ''
    }
  }

  /**
   * Producer body: follow one Gopeed task until it is done, failed, gone, or out of budget.
   * Called synchronously by the registry inside start(); everything after the first tick runs on
   * its own timer, and `done` settles exactly once.
   * @param {any} job JobHandle (id, append, updateProgress).
   * @param {{taskId: string, name: string, url: string}} task Download accepted by Gopeed.
   * @param {{jobId: string, owner: string, cancel?: Function}} tracking Record shared with the map.
   */
  const runTrackedDownload = (job, task, tracking) => {
    // Gopeed may not have assigned a display name yet on the very first ticks, so fall back to the
    // URL's file name (the same fragment the job label uses) before the bare task id.
    const displayName = () => labelText(task.name || urlBasename(task.url) || task.taskId, 120)
    let settled = false
    let timer = null
    /** Status reads at full cadence; the moving-download budget counts these. */
    let fastPolls = 0
    /** Status reads at the slow cadence (task paused or waiting); counted against its own budget. */
    let slowPolls = 0
    let failures = 0
    const startedAt = Date.now()
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })

    /** Stop the pending tick, if any. */
    const stopTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    /** Settle once: forget the map entry, stop polling, hand the terminal outcome to the registry. */
    const finish = (outcome) => {
      if (settled) return
      settled = true
      stopTimer()
      if (downloadJobs.get(task.taskId) === tracking) downloadJobs.delete(task.taskId)
      // Keep the inject channel silent for this task after settlement too: the webhook that reports
      // the same completion can arrive seconds later, and a just-deleted map entry would let it
      // through as a duplicate.
      markJobCovered(task.taskId)
      resolveDone(outcome)
    }

    /** Append one model-facing line to the ring, then settle. A closed ring must not break this. */
    const settleWithLine = (outcome, line) => {
      try {
        job.append(`${line}\n`)
      } catch {
        // The registry already closed the ring (teardown race); the outcome still has to land.
      }
      finish(outcome)
    }

    /**
     * Arm the next tick. unref() keeps a pending download from pinning the DSH process open.
     * `intervalMs` defaults to the moving-cadence; a paused/waiting task passes the slow one.
     * @param {number} [intervalMs] Delay before the next status read.
     */
    const schedule = (intervalMs = jobOps.pollIntervalMs) => {
      if (settled) return
      timer = setTimeout(() => {
        timer = null
        poll().catch(() => {})
      }, intervalMs)
      timer.unref?.()
    }

    /** One status read. Every exit either settles or re-arms the timer. */
    const poll = async () => {
      if (settled) return
      let snapshot = null
      let failure = ''
      try {
        snapshot = normalizeTask(await client.get(task.taskId))
      } catch (error) {
        // A removed task is normal rather than an error: the download was cancelled outside this
        // plugin (Gopeed UI, gopeed_control) and the job must converge instead of polling to the cap.
        if (isTaskGoneError(error)) {
          settleWithLine(
            { status: 'killed', detail: `Gopeed no longer has task ${task.taskId} (removed)` },
            `Download cancelled: ${displayName()} - Gopeed no longer has task ${task.taskId}.`,
          )
          return
        }
        failure = asciiText(error?.message || error)
      }

      if (failure) {
        failures += 1
        if (failures >= jobOps.maxConsecutiveFailures) {
          settleWithLine(
            {
              status: 'failed',
              detail: `Gopeed unreachable ${failures} times: ${labelText(failure, 200)}`,
            },
            `Download tracking failed: ${displayName()} - Gopeed was unreachable ${failures} times (${labelText(failure, 200)}). ` +
              'The download itself was NOT cancelled; check Gopeed and gopeed_status.',
          )
          return
        }
        // A Gopeed restart can move the auto-detected port. Re-detect at the first failure and then
        // sparsely (a process probe spawns tasklist, so it must not run on every tick); a configured
        // fixed port needs no re-detection at all.
        if (Number(config.port.get()) === 0 && (failures === 1 || failures % 20 === 0)) {
          try {
            await ensureApiPort(true)
          } catch {
            // Detection failure only delays the next attempt; the failure counter still applies.
          }
        }
      } else {
        failures = 0
        if (snapshot.status === 'done') {
          const size = formatBytes(snapshot.sizeBytes)
          settleWithLine(
            { status: 'completed', detail: `downloaded ${size}` },
            `Download finished: ${labelText(snapshot.name || task.taskId, 120)} (${size}) -> ${snapshot.path || '(no path)'}`,
          )
          return
        }
        if (snapshot.status === 'error') {
          settleWithLine(
            { status: 'failed', detail: 'Gopeed reported status error' },
            `Download failed: ${labelText(snapshot.name || task.taskId, 120)} (${formatBytes(snapshot.sizeBytes)}) -> ` +
              `${snapshot.path || '(no path)'}. Gopeed reported status error.`,
          )
          return
        }
        try {
          job.updateProgress(
            `${snapshot.status}${snapshot.sizeKnown ? ` ${snapshot.percent}%` : ''} ` +
              `${formatBytes(snapshot.downloadedBytes)}${snapshot.sizeKnown ? ` / ${formatBytes(snapshot.sizeBytes)}` : ''}`,
          )
        } catch {
          // Progress is cosmetic; a rejected update must not stop the poll loop.
        }
      }

      // A paused or waiting task is not moving: poll it far less often, and keep those reads out of
      // the moving-download budget. A failed read has no status, so it stays on the fast cadence,
      // where noticing a recovery quickly is what matters.
      const stalled = snapshot !== null && SLOW_STATUSES.has(snapshot.status)
      if (stalled) slowPolls += 1
      else fastPolls += 1

      // Hard budget: 24h of age, or the poll budget matching the cadence in use. A moving download
      // that hits it settles as failed; a stalled one settles as killed with an explicit "still
      // paused" detail, because a paused download is NOT a failed download. Either way the Gopeed
      // task keeps running independently of this job.
      const ageMs = Date.now() - startedAt
      const budgetSpent = stalled ? slowPolls >= jobOps.maxSlowPolls : fastPolls >= jobOps.maxPolls
      if (budgetSpent || ageMs >= jobOps.maxAgeMs) {
        const stage = snapshot ? snapshot.status : 'unknown'
        const polled = stalled ? slowPolls : fastPolls
        if (stalled) {
          settleWithLine(
            {
              status: 'killed',
              detail: `stopped tracking after ${polled} slow polls; task still ${stage}, download NOT cancelled`,
            },
            `Download tracking stopped: ${displayName()} - still ${stage} after ${polled} slow polls. ` +
              'The download was NOT cancelled; it is still paused and can be resumed with gopeed_control.',
          )
        } else {
          settleWithLine(
            {
              status: 'failed',
              detail: `gave up after ${polled} polls (last status ${stage})`,
            },
            `Download still ${stage} after ${polled} polls, so tracking stopped. The download itself was NOT cancelled; check gopeed_status.`,
          )
        }
        return
      }

      schedule(stalled ? jobOps.slowPollIntervalMs : jobOps.pollIntervalMs)
    }

    schedule()

    return {
      /**
       * Stop polling and settle as killed.
       *
       * The registry's kill() calls this with the reason alone and then appends that same reason to
       * the terminal detail itself, so this hook must not repeat it - the default detail is generic
       * and the reason lives in the model-facing ring line. A direct caller (plugin unload, or the
       * fallback when the registry refuses to kill) passes its own detail, and no reason is
       * appended anywhere, so the two paths never produce "because X; because X".
       * @param {string} reason Short reason, also used for the ring line.
       * @param {string} [detail] Terminal detail; overrides the generic "stopped at the plugin's request".
       */
      cancel(reason, detail) {
        const why = labelText(reason || 'cancelled', 160)
        const terminal =
          detail === undefined ? "stopped at the plugin's request" : labelText(detail, 240)
        settleWithLine(
          { status: 'killed', detail: terminal },
          `Download tracking stopped: ${displayName()} - ${why}.`,
        )
      },
      done,
    }
  }

  /**
   * Register the background job that follows one freshly created Gopeed task.
   * @param {any} exec Tool run context (owning session + creating call id).
   * @param {{taskId: string, name: string, url: string}} task Download just accepted by Gopeed.
   * @returns {{jobId: string, note: string}} `jobId` is '' when this host cannot host a job, and
   *   `note` then says why in one ASCII sentence.
   */
  const startDownloadJob = (exec, task) => {
    const jobs = resolveJobService()
    if (!jobs || typeof jobs.start !== 'function') {
      return {
        jobId: '',
        note:
          'No background-job service is available on this host, so this download is not tracked and no ' +
          'completion notice will wake the agent. Use gopeed_status, or the webhook notice when Gopeed posts one.',
      }
    }
    const owner = sessionIdOf(exec)
    if (!owner) {
      return {
        jobId: '',
        note:
          'The calling agent exposes no session id, so an owned job could not be registered and no ' +
          'completion notice would reach it. Use gopeed_status to follow this download.',
      }
    }

    const tracking = { jobId: '', owner, cancel: null, taskId: task.taskId }
    const label = labelText(`download ${task.name || urlBasename(task.url) || task.taskId}`)
    // JobSpec.toolCall is optional; attach the real call identity only when the dispatch provides it.
    const toolCall =
      typeof exec?.callId === 'string' && typeof exec?.rootCallId === 'string'
        ? { callId: exec.callId, rootCallId: exec.rootCallId }
        : null

    try {
      const jobId = jobs.start({
        kind: TRACKED_KIND,
        label,
        owner,
        ...(toolCall ? { toolCall } : {}),
        run: (job) => {
          const hooks = runTrackedDownload(job, task, tracking)
          tracking.cancel = hooks.cancel
          return hooks
        },
      })
      tracking.jobId = String(jobId ?? '')
      if (!tracking.jobId) {
        return {
          jobId: '',
          note:
            'The job registry returned no id, so this download is not tracked and no completion notice ' +
            'will wake the agent. Use gopeed_status to follow it.',
        }
      }
      downloadJobs.set(task.taskId, tracking)
      // Ownership starts now, not at settlement: the toast stays, but the inject copy of this
      // download's completion is suppressed from the first tick onward.
      markJobCovered(task.taskId)
      return { jobId: tracking.jobId, note: '' }
    } catch (error) {
      // Most commonly the registry has no attached controller for this owner. gopeed_add must keep
      // working, so this is a reported degradation, not a thrown tool error.
      return {
        jobId: '',
        note:
          `A background job could not be started (${labelText(asciiText(error?.message || error), 200)}), so no ` +
          'completion notice will wake the agent. Use gopeed_status, or the webhook notice when Gopeed posts one.',
      }
    }
  }

  /**
   * Stop tracking one Gopeed task, if this plugin is tracking it.
   * The registry's kill() is preferred because it records cause 'kill' and forwards the reason to
   * the producer; a registry that refuses (or is gone) falls back to the producer's own cancel so
   * the timer still stops.
   * @param {string} taskId Gopeed task id.
   * @param {string} reason Human-readable reason, forwarded to the job.
   * @param {any} exec Tool run context of the caller (its session authorizes kill()).
   * @returns {string} The job id that was cancelled, or '' when nothing was tracked.
   */
  const cancelDownloadJob = (taskId, reason, exec) => {
    const tracking = downloadJobs.get(taskId)
    if (!tracking) return ''
    let killed = false
    try {
      const jobs = resolveJobService()
      const owner = sessionIdOf(exec) || tracking.owner
      if (jobs && typeof jobs.kill === 'function' && tracking.jobId) {
        jobs.kill(tracking.jobId, owner, reason)
        killed = true
      }
    } catch {
      killed = false
    }
    if (!killed) {
      try {
        tracking.cancel?.(reason)
      } catch {
        // The producer may already be gone; dropping the record is still the right cleanup.
      }
    }
    downloadJobs.delete(taskId)
    return tracking.jobId
  }

  // Unloading (a profile reload, or a config remount) must not leave pollers behind: the registry
  // outlives this plugin, so stopping every timer is this plugin's own responsibility. Each live
  // record is settled as killed.
  //
  // Why settle at all, rather than just dropping the timers: an abandoned record would stay
  // `running` in job_list for the rest of the session and the agent's own job guidance tells it to
  // collect exactly that kind of record. Why the explicit detail rather than the registry's kill():
  // a plugin unload says NOTHING about the download. The Gopeed task keeps downloading while this
  // plugin is gone, so a bare "killed" would tell the agent a download failed when it did not. The
  // JobOutcome vocabulary has no "unknown" status (only completed / killed / failed), so the
  // honest place to say it is the terminal detail. dsh-jobs offers no way for a producer to settle
  // without announcing it - it only skips cause 'teardown', which belongs to owner/service
  // disposal, not to a producer stopping - so the wording carries the meaning instead.
  const UNLOAD_STOP_REASON = 'plugin unloaded, so tracking stopped; the download state is now unknown'
  const UNLOAD_STOP_DETAIL =
    'plugin unloaded: tracking stopped, download state unknown (the Gopeed task may still be running; check gopeed_status)'

  ctx.effect?.(() => () => {
    const live = Array.from(downloadJobs.values())
    downloadJobs.clear()
    for (const tracking of live) {
      try {
        tracking.cancel?.(UNLOAD_STOP_REASON, UNLOAD_STOP_DETAIL)
      } catch {
        // One broken producer must not keep the others' timers alive.
      }
    }
  })

  /** Merge window: events accepted within this window are delivered as one message. */
  const NOTIFY_DEBOUNCE_MS = 3000
  /** Cap on events merged into one message; the rest are counted, not buffered forever. */
  const MAX_NOTIFY_EVENTS = 20

  /** Events accepted but not yet delivered. */
  let pendingNotifications = []
  /** Events dropped because the batch was full. */
  let pendingOverflow = 0
  /** Pending debounce timer, or null. */
  let notifyTimer = null

  /** webhookNotify in effect. Volatile, so it is read when an event arrives, not at start. */
  const notifyEnabled = () => config.webhookNotify?.get?.() !== false

  /**
   * webhookToast in effect. Off by default because Gopeed posts its own Windows notification, so a
   * second toast is noise unless the user asks for the extra detail. This gates the user-facing
   * overlay only: the job wake-up and the Agent.inject fallback are deliberately not affected.
   */
  const toastEnabled = () => config.webhookToast?.get?.() === true

  /** The remembered Agent when it is still alive and usable, otherwise undefined. */
  const liveAgent = () => {
    try {
      const agent = lastAgentRef ? lastAgentRef.deref() : undefined
      return agent && typeof agent.inject === 'function' ? agent : undefined
    } catch {
      return undefined
    }
  }

  /** "name (size)" fragment shared by the single and the merged formats. */
  const notificationItem = (event) =>
    `${event.name || event.taskId || 'untitled'} (${formatBytes(event.sizeBytes)})`

  /**
   * Build the plain-ASCII message the model reads. One line per outcome keeps the merged form as
   * compact as the single form; the `[dsh-gopeed-downloader]` prefix marks it as plugin push, not user speech.
   * @param {object[]} batch Accepted events to merge.
   * @param {number} overflow Events dropped from the batch.
   */
  const buildNotificationText = (batch, overflow) => {
    const finished = batch.filter((event) => event.event !== 'DOWNLOAD_ERROR')
    const failed = batch.filter((event) => event.event === 'DOWNLOAD_ERROR')
    const lines = []
    if (finished.length === 1) {
      lines.push(
        `[dsh-gopeed-downloader] Download finished: ${notificationItem(finished[0])} -> ${finished[0].path || '(no path)'}`,
      )
    } else if (finished.length > 1) {
      lines.push(`[dsh-gopeed-downloader] ${finished.length} downloads finished: ${finished.map(notificationItem).join('; ')}`)
    }
    if (failed.length === 1) {
      lines.push(`[dsh-gopeed-downloader] Download failed: ${notificationItem(failed[0])} -> ${failed[0].path || '(no path)'}`)
    } else if (failed.length > 1) {
      lines.push(`[dsh-gopeed-downloader] ${failed.length} downloads failed: ${failed.map(notificationItem).join('; ')}`)
    }
    if (overflow > 0) {
      lines.push(`[dsh-gopeed-downloader] ${overflow} more download event(s) not listed; call gopeed_events for the full list.`)
    }
    return lines.join('\n')
  }

  /** Drop the pending timer and queue (plugin unload, receiver stop). */
  const clearNotifications = () => {
    if (notifyTimer) {
      clearTimeout(notifyTimer)
      notifyTimer = null
    }
    pendingNotifications = []
    pendingOverflow = 0
  }

  /**
   * Queue the merged batch as model-facing context with Agent.inject. Never throws: the event is
   * already in the ring buffer, so a failed injection must stay a silent miss rather than an HTTP
   * error at the receiver.
   *
   * This is the fallback channel, not the primary one: a download started through gopeed_add is
   * owned by its background job, whose settlement dsh-tool-jobs announces itself (and which can
   * wake an idle agent). Inject only covers what that job cannot: downloads started elsewhere and
   * hosts without ctx.jobs. queueNotification() enforces the split per task id.
   *
   * Why inject and not followup: inject is documented as "queue model-facing context for the next
   * pre-step without waking the driver". It does not open a turn and is never rendered as a chat
   * message from the user. The user-role shape is the only prompt-shaped wire format available for
   * an injected item, but it stays in context, not in the conversation.
   */
  const flushNotifications = () => {
    notifyTimer = null
    const batch = pendingNotifications
    const overflow = pendingOverflow
    pendingNotifications = []
    pendingOverflow = 0
    if (batch.length === 0) return
    try {
      const agent = liveAgent()
      if (!agent) return
      agent.inject({
        id: `dsh-gopeed-downloader-notify-${Date.now()}`,
        // Agent.inject only accepts a UserMessage, so role stays 'user'; the source is what names
        // the real producer. dsh-agent's README documents exactly this: followup uses
        // source { kind: 'user' } while a plugin's own input uses { kind: 'my-plugin' }. Using
        // 'user' here is what made the notice render as if the user had typed it.
        role: 'user',
        content: [{ type: 'text', text: buildNotificationText(batch, overflow) }],
        source: { kind: 'dsh-gopeed-downloader' },
      })
      ctx.logger?.debug?.(
        `dsh-gopeed-downloader: injected ${batch.length} download event(s) as context; last agent seen ${Date.now() - lastAgentAt}ms ago`,
      )
    } catch {
      // Disposed agent / throwing inject: swallow. The events stay cached and readable.
    }
  }

  /**
   * Queue one accepted event and arm the debounce timer. Called after the event is already stored,
   * so every early return here means "cache only": the event stays stored and readable, it just
   * never reaches the model.
   *
   * A task id a background job covers returns early: that job's settlement already becomes the
   * harness's completion notice, which reaches the same agent with more detail and is the only one
   * that can wake an idle owner. Injecting here as well would put the same download into the model
   * context twice. The overlay toast is recorded before this call, so the human still sees it.
   * @param {object} event Public event record from the receiver.
   */
  const queueNotification = (event) => {
    try {
      if (!notifyEnabled()) return
      // The job channel owns this download; do not repeat it as injected context.
      if (jobCoversTask(event.taskId)) return
      // No agent has used a gopeed tool yet (or it is gone): degrade to silent caching.
      if (!liveAgent()) return
      if (pendingNotifications.length < MAX_NOTIFY_EVENTS) pendingNotifications.push(event)
      else pendingOverflow += 1
      // One timer for the whole burst, so N events in 3s become one injected context note.
      if (notifyTimer) return
      notifyTimer = setTimeout(flushNotifications, NOTIFY_DEBOUNCE_MS)
      // A pending notification must never be the reason the process stays alive.
      notifyTimer.unref?.()
    } catch {
      // Never let bookkeeping break the receiver.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Notice feed for the Web UI overlay. This is a separate delivery cursor from the agent channel:
  // while the page is open, client.js polls GET /api/dsh-gopeed-downloader/notifications?since=<seq> and shows
  // a transient toast. It never marks the receiver buffer as read, so a later gopeed_events call
  // still reports the same unread count. The route is only reachable through the authenticated
  // Connection fetch registry (owner browser Peer); it is not part of the loopback webhook port.
  // ---------------------------------------------------------------------------------------------

  /** Paths owned by this plugin on the authenticated Connection fetch registry. */
  const NOTIFICATIONS_PATH = '/api/dsh-gopeed-downloader/notifications'
  const RESTART_PATH = '/api/dsh-gopeed-downloader/restart'

  /** How many recent notices stay available to the page. */
  const MAX_UI_NOTICES = 20
  /** Recent notices, oldest first. `seq` is plugin-local and monotonic. */
  let uiNotices = []
  let uiNoticeSeq = 0

  /** Keep one compact record for the overlay toast. Never throws. */
  const recordUiNotice = (event) => {
    try {
      uiNoticeSeq += 1
      uiNotices.push({
        seq: uiNoticeSeq,
        event: event.event,
        at: event.at,
        taskId: event.taskId,
        name: event.name,
        path: event.path,
        sizeBytes: event.sizeBytes,
      })
      while (uiNotices.length > MAX_UI_NOTICES) uiNotices.shift()
    } catch {
      // Never let bookkeeping break the receiver.
    }
  }

  /**
   * One accepted webhook event: feed the overlay, then optionally inject agent context.
   * The overlay is independent of whether an Agent was ever seen, so a user who only enabled
   * notifications still sees them.
   * @param {object} event Public event record from the receiver.
   */
  const handleWebhookEvent = (event) => {
    try {
      if (!notifyEnabled()) return
      // The toast is opt-in: Gopeed already posts its own Windows notification.
      if (toastEnabled()) recordUiNotice(event)
      queueNotification(event)
    } catch {
      // Never let notification bookkeeping break the receiver.
    }
  }

  /**
   * JSON body of the notice feed for one poll.
   * @param {string} rawUrl Request URL carrying the caller's `since` cursor.
   */
  const notificationFeed = (rawUrl) => {
    // `enabled` drives whether the client renders anything at all, so it must include the toast
    // switch: with the toast off there is nothing to show even though events still land in the
    // gopeed_events cache for the agent.
    const enabled = notifyEnabled() && toastEnabled() && webhookMode() !== 'off'
    let since = 0
    try {
      since = Number(new URL(rawUrl).searchParams.get('since')) || 0
    } catch {
      since = 0
    }
    return {
      enabled,
      latest: uiNoticeSeq,
      events: enabled ? uiNotices.filter((entry) => entry.seq > since) : [],
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Webhook receiver. This section only ever LISTENS. The single Gopeed config save in this
  // plugin lives in gopeed_events' action branch below, and it refuses to run outside mode auto.
  // ---------------------------------------------------------------------------------------------

  /** webhookMode in effect; an unknown stored value degrades to 'off' so a typo cannot open a port. */
  const webhookMode = () => {
    const raw = String(config.webhookMode?.get?.() ?? 'off').trim().toLowerCase()
    return raw === 'manual' || raw === 'auto' ? raw : 'off'
  }

  /** Requested listener port; 0 means "let the OS pick a free one". */
  const webhookPortSetting = () => {
    const port = Number(config.webhookPort?.get?.() ?? 0)
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0
  }

  let receiver = null
  let receiverFailure = ''
  let receiverStarting = null

  /** Start (or reuse) the listener for the current mode. Concurrent callers share one attempt. */
  const startReceiver = async () => {
    const mode = webhookMode()
    if (mode === 'off') {
      // webhookMode is volatile: switching it off at runtime must also close the port opened
      // earlier, otherwise "off" would keep listening until the plugin unloads.
      if (receiver) {
        await receiver.stop()
        receiver = null
        receiverFailure = ''
      }
      // No listener means no new events, so a queued wake-up would be stale.
      clearNotifications()
      return null
    }
    const port = webhookPortSetting()
    if (receiver && receiver.status === 'listening' && receiver.requestedPort === port) return receiver
    // The port setting is volatile, so an edit moves the listener instead of leaving a stale one.
    if (receiver) {
      await receiver.stop()
      receiver = null
    }
    // Moving the listener drops any batch that was waiting for delivery.
    clearNotifications()
    const next = createWebhookReceiver({
      port,
      onEvent: (event) => {
        ctx.logger?.debug?.(`dsh-gopeed-downloader: webhook ${event.event} for task ${event.taskId || '(no id)'}`)
        // The event is already stored at this point; this only decides who gets told about it.
        handleWebhookEvent(event)
      },
    })
    const started = await next.start()
    if (!started.ok) {
      // Never pretend to listen: keep the reason for diagnostics and retry on the next call,
      // because the conflicting port may have been released in the meantime.
      receiverFailure = `${started.reason}: ${started.message}`
      ctx.logger?.warn?.(`dsh-gopeed-downloader: webhook listener failed: ${receiverFailure}`)
      return null
    }
    receiver = next
    receiverFailure = ''
    ctx.logger?.info?.(`dsh-gopeed-downloader: webhook listening at ${next.url}`)
    return receiver
  }

  const ensureReceiver = () => {
    if (receiverStarting) return receiverStarting
    receiverStarting = startReceiver().finally(() => {
      receiverStarting = null
    })
    return receiverStarting
  }

  // Registered even when the mode is off: webhookMode is volatile and can be switched on without
  // a remount, so unloading the plugin must stop a listener that was started later.
  ctx.effect?.(() => () => {
    // Unloading must not leave a timer behind that wakes an agent of an already closed session.
    clearNotifications()
    const current = receiver
    receiver = null
    return current ? current.stop() : undefined
  })

  if (webhookMode() !== 'off') {
    ensureReceiver().catch((error) => {
      receiverFailure = String(error?.message || error)
      ctx.logger?.warn?.(`dsh-gopeed-downloader: webhook listener failed: ${receiverFailure}`)
    })
  }

  /**
   * Stop the running Gopeed, start it again, then wait for its API.
   *
   * This is NOT an agent capability. The only entry point is the authenticated POST route
   * registered below, which the "Restart Gopeed" button on the plugin config page calls. No tool
   * (gopeed_launch included) can reach this function any more, so an agent cannot kill the
   * downloader. The process helpers are read from processOps at call time so a test can substitute
   * counting stubs.
   * @param {number} apiPort Port resolved before the restart, used when re-detection fails.
   */
  const restartGopeed = async (apiPort) => {
    // The config-page restart is a USER gesture, not an agent action. The sandbox bounds what the
    // agent may do; applying the deployment default to a button the human just pressed produced a
    // confined taskkill that could not end a same-user process, so the button silently failed.
    // This path therefore runs unconfined and says so in its result.
    const confine = async (argv) => ({
      argv,
      sandboxed: false,
      status: 'user-action',
      mode: '',
      enforcement: '',
      detail:
        'Started or stopped from the settings-page button by the user, not by an agent tool; ' +
        'no sandbox policy applies to a human-triggered action.',
    })
    const giveUp = (stage, message, sandbox) => ({
      ok: false,
      launched: false,
      restarted: false,
      pid: 0,
      apiState: '',
      stage,
      message,
      launchSandboxed: Boolean(sandbox?.sandboxed),
      sandboxMode: String(sandbox?.mode ?? ''),
      sandboxDetail: String(sandbox?.detail ?? ''),
    })
    const resolved = await processOps.resolveExecutable(config.exePath.get())
    const proc = await processOps.findProcess(resolved.path || config.exePath.get() || 'Gopeed.exe')
    if (proc.probe !== 'ok') {
      return giveUp(
        'probe',
        `Could not restart Gopeed: the process list is unavailable here (${proc.detail}). End Gopeed manually and start it again, or double-click the icon.`,
      )
    }
    if (!proc.found) {
      return giveUp(
        'not-running',
        `Could not restart Gopeed: no ${proc.image} process found, so there was nothing to restart. Use gopeed_launch to start it.`,
      )
    }
    // Resolve the executable BEFORE stopping: killing a process that cannot be started again would
    // leave the user without a downloader.
    if (!resolved.path) {
      return giveUp(
        'executable',
        'Could not restart Gopeed: Gopeed.exe was not found, so it was NOT stopped. Set "Executable path" in the plugin config, or start it by double-clicking the icon.',
      )
    }
    const stopped = await processOps.stopProcess(proc.pid, { confine })
    if (!stopped.ok) return giveUp('stop', `Could not restart Gopeed: ${trimPeriod(stopped.message)}.`, stopped.sandbox)
    // Give the API port and the file handles a moment to be released.
    await new Promise((resolve) => setTimeout(resolve, 900))
    const launch = await processOps.launchProcess(resolved.path, { confine })
    if (!launch.ok) {
      return giveUp(
        'launch',
        `Gopeed was stopped but could not be started again: ${trimPeriod(launch.message)}. Start it manually, press "Restart Gopeed" again, or call gopeed_launch.`,
        launch.sandbox,
      )
    }
    // An unpinned Gopeed comes back on a new random port, and that port only becomes visible once
    // the relaunched process starts listening. Detect and probe in a loop: a single detection right
    // after launch usually runs before the socket exists and would leave us probing a stale port for
    // the whole budget.
    autoPort = 0
    autoPortAt = 0
    const probeStartedAt = Date.now()
    const deadline = probeStartedAt + 15000
    let port = apiPort || Number(config.port.get()) || 0
    let after = { state: 'unknown', detail: 'not probed yet' }
    for (;;) {
      // Same two rules as gopeed_launch: check the budget BEFORE an iteration, and treat
      // 'unauthorized' as terminal. A trailing check must not be used: it runs one more
      // detect+probe after the deadline has passed. This runner has no DSH tool timeout behind
      // it, so the wasted time here is spent in front of a human who just pressed "Restart Gopeed".
      if (Date.now() >= deadline) break
      const detected = await ensureApiPort(true)
      if (detected > 0) port = detected
      if (port > 0) {
        after = await processOps.waitForApi({
          host: config.host.get(),
          port,
          token: config.token.get(),
          timeoutMs: 2000,
          waitMs: 1800,
        })
        if (after.state === 'ok') break
        if (after.state === 'unauthorized') break
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    // How long the readiness probe actually ran, for the failure text below: a fixed "15s" would
    // be a lie once the loop exits early on a terminal state.
    const probedMs = Date.now() - probeStartedAt
    const pid = Number(launch.pid) || 0
    const sandboxFacts = {
      launchSandboxed: Boolean(launch.sandbox?.sandboxed),
      sandboxMode: String(launch.sandbox?.mode ?? ''),
      sandboxDetail: String(launch.sandbox?.detail ?? ''),
    }
    const pidNote = launch.sandbox?.sandboxed ? ' (pid is the sandbox runner; Gopeed pid is detected separately)' : ''
    if (after.state !== 'ok') {
      return {
        ok: false,
        launched: true,
        restarted: false,
        pid,
        apiState: after.state,
        stage: 'api',
        message: `Gopeed was restarted (pid ${pid})${pidNote} but it did not become ready (last state: ${after.state} after ${probedMs}ms: ${after.detail}). It may still be loading; check gopeed_process in a moment.`,
        ...sandboxFacts,
      }
    }
    return {
      ok: true,
      launched: true,
      restarted: true,
      pid,
      apiState: after.state,
      stage: 'done',
      detail: after.detail,
      message: `Restarted Gopeed (pid ${pid})${pidNote}; ready: ${after.detail}. Running downloads may have been interrupted.`,
      ...sandboxFacts,
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Browser routes. These are the only browser-facing entry points of the plugin, and both are
  // registered on Connection's exact Fetch registry, NOT on the loopback webhook port:
  // - GET  /api/dsh-gopeed-downloader/notifications : authenticated feed for the overlay toast.
  // - POST /api/dsh-gopeed-downloader/restart       : the "Restart Gopeed" button on the config page.
  //
  // Access control is provided by Connection, not by hand-rolled tokens: an exact route is only
  // dispatched after the Host/Origin trust fence and browser/API authentication succeed, and its
  // shared handler answers 403 to any non-owner Peer. A random external process cannot reach it
  // (no cookie, untrusted Host is refused), and an agent tool has no way to call it at all.
  // `connection` is optional: in a deployment without the Web carrier the plugin still works.
  // ---------------------------------------------------------------------------------------------

  /** Serialize restart clicks so two tabs cannot stop/start the process twice. */
  let restartInFlight = null

  /** Run at most one restart at a time, always resolving to a reportable outcome. */
  const runRestartOnce = () => {
    if (restartInFlight) return restartInFlight
    const task = (async () => restartGopeed(await ensureApiPort()))()
      .catch((error) => ({
        ok: false,
        launched: false,
        restarted: false,
        pid: 0,
        apiState: '',
        stage: 'internal',
        message: `Restart failed unexpectedly: ${error?.message || String(error)}`,
        launchSandboxed: false,
        sandboxMode: '',
        sandboxDetail: '',
      }))
      .finally(() => {
        restartInFlight = null
      })
    restartInFlight = task
    return task
  }

  /** Small JSON response helper shared by the two routes. */
  const jsonResponse = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })

  /**
   * Register both browser routes on whichever Context provides Connection. Using `ctx.inject`
   * keeps Connection an OPTIONAL dependency: a headless deployment without the Web carrier still
   * loads the plugin and its tools, and the routes appear whenever Connection becomes available.
   * @param {any} routeCtx Context that resolved the `connection` service.
   */
  const registerBrowserRoutes = (routeCtx) => {
    const connection = routeCtx?.connection
    if (!connection || typeof connection.fetch?.register !== 'function') return
    routeCtx.effect(
      () =>
        connection.fetch.register({
          path: NOTIFICATIONS_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async (request) => jsonResponse(200, notificationFeed(request.url)),
        }),
      'dsh-gopeed-downloader: notification feed route',
    )
    routeCtx.effect(
      () =>
        connection.fetch.register({
          path: RESTART_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            // Defense in depth behind Connection's authentication: a same-origin script still has
            // to send an explicit confirmation, so a stray fetch cannot kill the downloader.
            let body = null
            try {
              body = await request.json()
            } catch {
              body = null
            }
            if (!body || body.confirm !== true) {
              return jsonResponse(400, {
                ok: false,
                restarted: false,
                message: 'Restart refused: an explicit POST with {"confirm":true} is required.',
              })
            }
            const outcome = await runRestartOnce()
            return jsonResponse(outcome.ok ? 200 : 500, outcome)
          },
        }),
      'dsh-gopeed-downloader: restart route',
    )
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], registerBrowserRoutes)
  } else {
    // No Cordis injection on this Context (tests / simplified hosts): use a direct lookup and
    // present the same small shape registerBrowserRoutes expects.
    try {
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (connection) {
        registerBrowserRoutes({
          connection,
          effect: (fn, label) => ctx.effect?.(fn, label),
        })
      }
    } catch {
      // Without Connection the plugin is still fully usable; only the two browser routes are gone.
    }
  }

  /**
   * Newcomer guidance: when Gopeed is not installed or not configured, explain the fix. This text
   * is appended to the TOOL's own output (an exception message or the diagnostic `advice`), which
   * renders as a tool card. It is deliberately NOT sent through `deferContext` any more: that adds
   * a user-role message to the conversation, i.e. exactly the plugin-impersonating-the-user
   * behaviour this plugin must not have. It is delivered at most once.
   */
  const SETUP_NOTICE = [
    '[!] Gopeed is not reachable, so this downloader plugin cannot work yet. Three checks fix it - no command line needed:',
    '1) Gopeed must be running. If it is installed but not running (it may have crashed or been closed), start it by double-clicking its icon. Only if it is not installed at all, download the Windows build from https://gopeed.com and install it.',
    '2) Pin the port: in Gopeed open Settings -> Advanced -> Protocol, keep TCP and set the address to a fixed port, for example 127.0.0.1:9999. Gopeed defaults to port 0, a random port on every launch; the plugin can usually detect it, but pinning removes the guesswork.',
    '3) Token (optional): if you set a token on that same page, enter the same value in DSH -> Plugins -> Installed -> Gopeed downloader -> row gopeed -> Config, with address 127.0.0.1 and the same port, then save.',
    'Tell me when that is done and I will check again.',
  ].join('\n')

  let setupNoticeSent = false

  /** Only connection / timeout / token failures are worth interrupting the user; task errors are not. */
  const isSetupProblem = (error) => {
    const code = Number(error?.code)
    return code === -1 || code === 401 || code === 403
  }

  /** The one-off setup text, or '' when it was already delivered in an earlier tool result. */
  const takeSetupNotice = () => {
    if (setupNoticeSent) return ''
    setupNoticeSent = true
    return SETUP_NOTICE
  }

  /** Turn any error into a readable exception for the model (setup guidance rides in the error). */
  const fail = (action, error) => {
    const notice = isSetupProblem(error) ? takeSetupNotice() : ''
    const detail = error?.message || String(error)
    throw new Error(`gopeed_${action} failed: ${detail}${notice ? `\n\n${notice}` : ''}`)
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

  /**
   * Directory the workspace download target saves into, or '' when this host/session exposes none.
   *
   * `session.header.cwd` is the directory the session was CREATED in (persisted as
   * record.identity.cwd), so it never moves: after "working_directory cd D:\projects\foo" a
   * download still landed in the creation-time project. The live value is the `workingDirectory`
   * service's projection, which starts at the header and is updated by every
   * `working-directory/change` event - exactly the directory the `working_directory` tool
   * reports, and the one the fs tools resolve relative paths against. Reading it is synchronous
   * (`Service.get(session)` folds the in-memory session log, no filesystem I/O), so the download
   * path stays a synchronous decision. The header remains the fallback for a host that composes no
   * workingDirectory service.
   * @param {any} exec Tool run context.
   * @returns {string} Absolute directory, or '' when neither source has one.
   */
  const sessionWorkspaceOf = (exec) => {
    try {
      const session = exec?.agent?.session
      const directories = lookupService(ctx, 'workingDirectory')
      if (session && directories && typeof directories.get === 'function') {
        const live = directories.get(session)
        if (typeof live === 'string' && live.trim()) return live.trim()
      }
    } catch {
      // No projection (or no such service): fall through to the creation-time header.
    }
    try {
      const cwd = exec?.agent?.session?.header?.cwd
      return typeof cwd === 'string' ? cwd.trim() : ''
    } catch {
      return ''
    }
  }

  /**
   * Decide the save directory for gopeed_add.
   *
   * An explicit `path` argument always wins, so a caller that names a directory keeps the existing
   * behavior. Otherwise Config.downloadTarget decides: workspace uses the calling session's own
   * directory, custom uses customDownloadPath, and gopeed (or any unknown/fallback value) leaves
   * the path unset so Gopeed fills in the download directory from its own settings.
   * @param {unknown} requested Raw `path` argument.
   * @param {any} exec Tool run context.
   * @returns {{ path: string | undefined, note: string }} Path to pass to Gopeed (undefined = let
   *   Gopeed choose) and a one-line ASCII note when a fallback happened.
   */
  const resolveDownloadPath = (requested, exec) => {
    const explicit = optString(requested)
    if (explicit) return { path: explicit, note: '' }
    let target = ''
    try {
      target = String(config.downloadTarget.get() ?? '')
    } catch {
      target = ''
    }
    if (target === 'custom') {
      let custom = ''
      try {
        custom = String(config.customDownloadPath.get() ?? '').trim()
      } catch {
        custom = ''
      }
      if (custom) return { path: custom, note: '' }
      return {
        path: undefined,
        note:
          'The download target is custom but customDownloadPath is empty, so this download uses the ' +
          'Gopeed default directory.',
      }
    }
    if (target === 'workspace') {
      const cwd = sessionWorkspaceOf(exec)
      if (cwd) return { path: cwd, note: '' }
      return {
        path: undefined,
        note:
          'The current session workspace path is unavailable, so this download falls back to the ' +
          'Gopeed default directory.',
      }
    }
    return { path: undefined, note: '' }
  }

  // ---------------------------------------------------------------------------------------------
  // gopeed_add's own time budget.
  //
  // timeoutMs below is the DSH TOOL timeout: when it expires DSH kills the call and the tool never
  // gets to answer, so a cold start must not surface as "timed out" instead of a real result.
  // Unbounded waits overrun it easily: ensureApiPort alone may spend ~32s (tasklist 4s +
  // Get-Process 8s + netstat 8s + Get-NetTCPConnection 12s, plus up to 3s per probed port), and
  // the create request and its read-back each allow Config.timeoutMs (up to 120000).
  //
  // So: one internal budget, derived from the tool timeout, bounds EVERY wait, and each phase
  // that runs out reports what to do instead of running into the outer kill. Worst case:
  //   port phase  <= ADD_PORT_BUDGET_MS (12000)
  //   create      <= remaining - ADD_REQUEST_RESERVE_MS (10500 at worst)
  //   read-back   <= remaining (3000 at worst)
  //   total       <= ADD_BUDGET_MS (22500) < ADD_TOOL_TIMEOUT_MS (25000)
  // ---------------------------------------------------------------------------------------------

  /** DSH tool timeout for gopeed_add; the same number is declared on the tool below. */
  const ADD_TOOL_TIMEOUT_MS = 25000
  /** Head room kept for wrapping up and returning, so the call ends before DSH kills it. */
  const ADD_BUDGET_MARGIN_MS = 2500
  /** Internal budget: every wait inside gopeed_add derives from it. */
  const ADD_BUDGET_MS = ADD_TOOL_TIMEOUT_MS - ADD_BUDGET_MARGIN_MS
  /** Hard slice for finding the API port, the only phase that can spend tens of seconds. */
  const ADD_PORT_BUDGET_MS = 12000
  /** Kept back from the port phase so a port that IS found still gets a real create request. */
  const ADD_REQUEST_RESERVE_MS = 3000

  /**
   * Await `promise`, but stop waiting after `ms` and throw `message` instead.
   *
   * The abandoned promise is deliberately left running: it is a read-only probe that publishes the
   * detected port into the process cache, so finishing later only makes the next call faster. Its
   * rejection is swallowed here so it can never surface as an unhandled rejection.
   * @param {Promise<any>} promise Work to bound.
   * @param {number} ms Maximum time to wait for it.
   * @param {string} message Error text used when the bound is hit.
   */
  const cappedAwait = async (promise, ms, message) => {
    promise.catch(() => {})
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms))
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Time budget for the READ-ONLY tools.
  //
  // gopeed_list / gopeed_status / gopeed_control / gopeed_process used to call ensureApiPort()
  // unbounded. That probe can spend ~32s on a cold host (tasklist, Get-Process, netstat,
  // Get-NetTCPConnection, plus up to 3s per probed port), which is past the DSH tool timeout: the
  // call was killed by the host and its real error was lost. They now reuse the same cappedAwait()
  // bound as gopeed_add: the port phase gives up with an actionable message well before the tool
  // timeout, and a normal 1-2s call never touches the bound.
  // ---------------------------------------------------------------------------------------------

  /** DSH tool timeout for gopeed_list, gopeed_status and gopeed_control; declared on each tool. */
  const READ_TOOL_TIMEOUT_MS = 25000
  /** DSH tool timeout for gopeed_process; it does more probes, so DSH gives it longer. */
  const PROCESS_TOOL_TIMEOUT_MS = 30000
  /** Head room kept for wrapping up and returning, so the call ends before DSH kills it. */
  const READ_BUDGET_MARGIN_MS = 2500
  /** Whole-call budget for the 25s read-only tools. */
  const READ_BUDGET_MS = READ_TOOL_TIMEOUT_MS - READ_BUDGET_MARGIN_MS
  /** Whole-call budget for gopeed_process (30s tool timeout). */
  const PROCESS_BUDGET_MS = PROCESS_TOOL_TIMEOUT_MS - READ_BUDGET_MARGIN_MS
  /** Hard slice for the port phase, the only phase that can spend tens of seconds. */
  const READ_PORT_BUDGET_MS = 12000

  /**
   * `ensureApiPort`, bounded by both the port slice and what is left of the call's own budget.
   *
   * On timeout it throws a message that says which tool gave up and what to do instead, rather than
   * letting the DSH tool timeout kill the call with nothing to show.
   * @param {string} tool Tool name used in the error text.
   * @param {number} deadline Date.now() value at which the whole call must be done.
   * @param {boolean} [force] Skip the configured/cached port and detect even when one is configured.
   */
  const ensureApiPortWithin = (tool, deadline, force = false) => {
    const slice = Math.max(500, Math.min(READ_PORT_BUDGET_MS, deadline - Date.now()))
    return cappedAwait(
      ensureApiPort(force),
      slice,
      `gave up detecting the Gopeed API port after ${slice}ms, so ${tool} did not run. ` +
        'Retry in a moment - a cold Gopeed may still be starting - or set "port" in the plugin ' +
        'config to the fixed port shown under Gopeed -> Settings -> Advanced -> Protocol.',
    )
  }

  ctx.tools.register({
    name: 'gopeed_add',
    description: 'Download a URL through Gopeed. Returns a background job that notifies when it ends.',
    // Note: parameters omits additionalProperties. A defineTool-compiled parameter schema is
    // only {type, properties, required}; adding additionalProperties:false would cost about 170
    // characters across the tools on every turn. Validation lives in execute (reqString /
    // whitelists) instead, which is also why `required` is omitted and why value lists that the
    // tool description already spells out (gopeed_control verbs) are not repeated as enums.
    // Parameter descriptions are dropped too, because the name plus the one-line tool description
    // already pin the value down - except `path`, where "save directory" versus "file path" is a
    // silent, wrong-download kind of mistake.
    //
    // Budget note: the seven tool definitions total 1452 characters, 352 over the original 1100
    // target. `name` and the value enums stay deliberately - a shorter schema that hides
    // a real parameter or a legal value costs more in wrong calls than the characters save. See
    // the footprint section of README.md for the measured per-tool breakdown.
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        path: { type: 'string', description: 'Save dir (omit = use the configured location)' },
        name: { type: 'string', description: 'File name (optional)' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        // jobId / jobNote describe the optional background tracking job. They live in output.schema
        // only, which is never projected into the system prompt, so the 1452-character tool
        // definition budget is untouched, because output.schema adds nothing to parameters.
        required: ['taskId', 'url', 'name', 'path', 'baseUrl', 'jobId', 'jobNote'],
        properties: {
          taskId: { type: 'string', description: 'Task id returned by Gopeed.' },
          url: { type: 'string', description: 'Submitted URL.' },
          name: { type: 'string', description: 'Task name; empty when not given.' },
          path: { type: 'string', description: 'Download directory; empty when not given.' },
          baseUrl: { type: 'string', description: 'Base URL used for this request.' },
          jobId: { type: 'string', description: 'Background job id; empty when none could be started.' },
          jobNote: {
            type: 'string',
            description:
              'Why no job tracks this download, plus any download-path fallback note; empty on success.',
          },
        },
      },
      render: (_args, value) =>
        textBlock([
          `Submitted download task: ${value.taskId}`,
          `URL: ${value.url}`,
          value.name ? `Name: ${value.name}` : undefined,
          value.path ? `Save dir: ${value.path}` : undefined,
          value.jobId
            ? `Tracking job: ${value.jobId} runs in the background. A completion notice arrives in this session when the download ends - do not poll and do not wait for it. Read the result with job_output ${value.jobId} after the notice.`
            : value.jobNote,
          // jobNote also carries a path fallback (for example an unavailable session workspace),
          // which matters even when the tracking job started successfully.
          value.jobId && value.jobNote ? value.jobNote : undefined,
          value.jobId
            ? undefined
            : `No tracking job is available here, so poll gopeed_status (${value.baseUrl}) if you need the outcome.`,
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
    timeoutMs: ADD_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      rememberAgent(exec)
      const url = reqString(args?.url, 'url')
      const saveTarget = resolveDownloadPath(args?.path, exec)
      const taskName = optString(args?.name)
      const deadline = Date.now() + ADD_BUDGET_MS
      const remaining = () => deadline - Date.now()
      try {
        // The port phase gets a hard slice instead of its own worst case, and gives up with an
        // actionable message rather than letting the DSH timeout kill the call.
        const portSlice = Math.min(
          ADD_PORT_BUDGET_MS,
          Math.max(1000, remaining() - ADD_REQUEST_RESERVE_MS),
        )
        await cappedAwait(
          ensureApiPort(),
          portSlice,
          `gave up detecting the Gopeed API port after ${portSlice}ms, so nothing was submitted. ` +
            'Retry in a moment - a cold Gopeed may still be starting - or set "port" in the plugin ' +
            'config to the fixed port shown under Gopeed -> Settings -> Advanced -> Protocol.',
        )
        // Every request below is capped by what is left of the budget, so Config.timeoutMs (up to
        // 120000) cannot push the whole call past the DSH timeout.
        addRequestTimeoutMs = Math.max(1000, remaining() - 1500)
        const taskId = await addClient.create({ url, path: saveTarget.path, name: taskName || undefined })
        // Read the task back: when `path` is omitted, Gopeed does NOT leave the save dir empty -- it
        // fills meta.opts.path with the downloadDir from its own settings. Reporting the caller's
        // empty argument would leave the agent with no idea where the file landed. One loopback GET.
        let resolvedPath = saveTarget.path || ''
        let resolvedName = taskName
        try {
          // Best-effort read-back; it gets only what is left of the budget (>= 500ms), never the
          // full Config.timeoutMs.
          addRequestTimeoutMs = Math.max(500, remaining())
          const created = normalizeTask(await addClient.get(taskId))
          if (created && created.path) resolvedPath = created.path
          if (!resolvedName && created && created.name) resolvedName = created.name
        } catch {
          // Read-back is best-effort: the add itself already succeeded.
        }
        // Registration happens AFTER Gopeed accepted the task, so a rejected add never leaves a job
        // tracking a download that does not exist. A missing/unusable job service degrades to
        // jobId '' plus the one-line note, and gopeed_add still succeeds.
        const tracked = startDownloadJob(exec, { taskId, name: resolvedName, url })
        return {
          taskId,
          url,
          name: resolvedName,
          path: resolvedPath,
          baseUrl: addClient.baseUrl(),
          jobId: tracked.jobId,
          // Path fallback facts share the one additive note field: the output schema is fixed, and
          // a note the agent can read is better than a silently redirected download.
          jobNote: [saveTarget.note, tracked.note].filter(Boolean).join(' '),
        }
      } catch (error) {
        fail('add', error, exec)
      } finally {
        // Never let one call's squeeze leak into another call's requests.
        addRequestTimeoutMs = 0
      }
    },
  })

  ctx.tools.register({
    name: 'gopeed_list',
    description: 'List Gopeed downloads.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ready', 'running', 'pause', 'wait', 'error', 'done'] },
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
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      rememberAgent(exec)
      // Bounded port phase: it ends with an explained error instead of the DSH kill (see above).
      await ensureApiPortWithin('gopeed_list', Date.now() + READ_BUDGET_MS)
      const filter = optString(args?.status).toLowerCase()
      // The status list lives here instead of in the tool schema (see gopeed_add's note): a wrong
      // filter would otherwise return "no tasks" and look like an empty downloader.
      if (filter && !TASK_STATUSES.includes(filter)) {
        throw new Error(`Unsupported status filter: ${filter} (expected ${TASK_STATUSES.join(', ')})`)
      }
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
    description: 'One download details by id.',
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
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      rememberAgent(exec)
      await ensureApiPortWithin('gopeed_status', Date.now() + READ_BUDGET_MS)
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
    'Steps: 1) Make sure Gopeed is running: start it if it is installed, or download and install it from ' +
    'https://gopeed.com if it is not. ' +
    '2) In Gopeed open Settings -> Advanced -> Protocol, keep TCP and pin the address to a fixed port such as ' +
    '127.0.0.1:9999 (Gopeed defaults to port 0, a random port per launch; the plugin can usually detect it, but ' +
    'pinning removes the guesswork). ' +
    '3) If you set a Token on the same page, copy it into the DSH plugin config (Plugins -> Installed -> dsh-gopeed-downloader -> Config). ' +
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
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      rememberAgent(exec)
      await ensureApiPortWithin('gopeed_control', Date.now() + READ_BUDGET_MS)
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
          // The task is already gone, so a tracking job for it can never observe a transition:
          // converge it now instead of letting it poll to the cap.
          const cancelled = cancelDownloadJob(id, 'Gopeed no longer has this task', exec)
          return {
            ok: false,
            id,
            action,
            status: '',
            message:
              `Gopeed no longer has this task (usually finished or removed, code=${error.code}); nothing to ${spec.verb}.` +
              (cancelled ? ` Tracking job ${cancelled} cancelled.` : ''),
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
      // A removed download has no future settlement to observe, so its tracking job is cancelled
      // here. pause/resume leave the job alone: the download may still finish later.
      let jobNote = ''
      if (action === 'remove') {
        const cancelled = cancelDownloadJob(id, 'removed by gopeed_control', exec)
        if (cancelled) jobNote = ` Tracking job ${cancelled} cancelled.`
      }
      return {
        ok: true,
        id,
        action,
        status,
        message: `${spec.done}.${status ? ` Current status: ${status}.` : ''}${jobNote}`,
      }
    },
  })

  ctx.tools.register({
    name: 'gopeed_process',
    description: 'Diagnose Gopeed: running, which port.',
    parameters: { type: 'object' },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'pluginVersion',
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
          'webhookMode',
          'webhookListening',
          'webhookUrl',
          'webhookReceived',
          'webhookUnread',
          'webhookError',
          'diagnosticsSandboxed',
          'diagnosticsSandboxNote',
          'advice',
        ],
        properties: {
          pluginVersion: {
            type: 'string',
            description:
              'Backend version of this plugin. Compare it with the version shown in the settings UI: a lower UI version means the browser bundle is stale and DSH must be restarted.',
          },
          verdict: {
            type: 'string',
            enum: ['running', 'unresponsive', 'stopped', 'misconfigured', 'unauthorized', 'unknown'],
            description: 'Overall verdict.',
          },
          apiState: {
            type: 'string',
            enum: ['ok', 'refused', 'timeout', 'unauthorized', 'error'],
            description: 'HTTP probe result.',
          },
          apiLatencyMs: { type: 'integer', description: 'Endpoint latency in ms.' },
          apiDetail: { type: 'string', description: 'Endpoint probe detail.' },
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
          webhookMode: {
            type: 'string',
            enum: ['off', 'manual', 'auto'],
            description: 'Configured webhook mode; off means the plugin listens on no port.',
          },
          webhookListening: { type: 'boolean', description: 'Whether the webhook listener is running.' },
          webhookUrl: {
            type: 'string',
            description: 'URL to register in Gopeed; empty when nothing is listening.',
          },
          webhookReceived: {
            type: 'integer',
            description: 'Events pushed to the plugin since it started; 0 means Gopeed is not pushing here.',
          },
          webhookUnread: { type: 'integer', description: 'Events not yet read by gopeed_events.' },
          webhookError: { type: 'string', description: 'Why the listener is not running; empty when healthy.' },
          diagnosticsSandboxed: {
            type: 'boolean',
            description:
              'Whether the subprocesses behind this diagnosis were run under the sandbox. Always false: process, socket and executable probes run with host permissions so they can actually see Gopeed.',
          },
          diagnosticsSandboxNote: {
            type: 'string',
            description:
              'Plain note that this diagnosis ran outside the sandbox and that only starting or stopping Gopeed is confined.',
          },
          advice: { type: 'string', description: 'Suggested next step.' },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Plugin: ${value.pluginVersion}`,
          `Status: ${value.verdict}`,
          `Probe: ${value.apiState} (${value.apiLatencyMs}ms) - ${value.apiDetail}`,
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
          lines.push(
            'Process: this host cannot enumerate processes, so "no process found" is unknown rather than ' +
              'evidence; the verdict relies on the HTTP probe',
          )
        }
        lines.push(
          value.exePath
            ? `Executable: ${value.exePath} (${value.exeSource})`
            : `Executable: not found (${value.exeSource})`,
        )
        lines.push(`Endpoint: ${value.baseUrl}`)
        // Strategy 3 disclosure: the reads above were NOT sandboxed. Saying so keeps a diagnosis
        // that relied on host-only visibility from being mistaken for a policy-governed one.
        lines.push(
          'Sandbox: diagnostics ran outside the sandbox (host permissions) - only starting or stopping Gopeed is confined.',
        )
        // Webhook status answers "is the push channel wired up?" - the question that otherwise
        // needs two tools to answer.
        if (value.webhookMode === 'off') {
          lines.push('Webhook: off (no port is being listened on; use gopeed_list to poll)')
        } else if (value.webhookListening) {
          lines.push(
            `Webhook: ${value.webhookMode}, listening at ${value.webhookUrl}, ` +
              `${value.webhookReceived} event(s) received, ${value.webhookUnread} unread`,
          )
        } else {
          lines.push(
            `Webhook: ${value.webhookMode} but NOT listening${value.webhookError ? ` (${value.webhookError})` : ''}`,
          )
        }
        lines.push(`Advice: ${value.advice}`)
        return textBlock(lines)
      },
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Gopeed diagnostics', kind: 'other' }),
    timeoutMs: PROCESS_TOOL_TIMEOUT_MS,
    async execute(_args, exec) {
      rememberAgent(exec)
      // One budget for the whole diagnosis: both port phases and the probe fan-out below draw from
      // it, so a cold host ends with an explained error instead of the DSH kill.
      const deadline = Date.now() + PROCESS_BUDGET_MS
      let detectedPort = await ensureApiPortWithin('gopeed_process', deadline)
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
        const probed = await ensureApiPortWithin('gopeed_process', deadline, true)
        if (probed > 0 && probed !== options.port) {
          detectedPort = probed
          options.port = probed
          api = await probeApi(options)
        }
      }
      // Process probing, executable resolution and /info are independent, so run them in
      // parallel to keep total latency down. /info is only asked for when the API already
      // answers, and its /info payload supplies the `version` field. The whole fan-out shares the
      // call budget: each probe shells out, so on a slow host this is the last phase that can
      // overrun the DSH tool timeout.
      const [resolved, proc, info] = await cappedAwait(
        Promise.all([
          resolveExecutable(config.exePath.get()),
          findProcess(config.exePath.get() || 'Gopeed.exe'),
          api.state === 'ok' ? client.info().catch(() => ({})) : Promise.resolve({}),
        ]),
        Math.max(500, deadline - Date.now()),
        `gave up on the process and executable probes after the ${PROCESS_BUDGET_MS}ms budget for ` +
          'gopeed_process, so no diagnosis was produced. Retry in a moment.',
      )
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
          'The port is reachable but the process is not responding, so Gopeed is probably stuck: ask the user to press "Restart Gopeed" on the plugin config page, which is the only restart path (it interrupts running downloads).'
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
            `Gopeed is running (pid ${proc.pid}) but its port could not be determined: ${api.baseUrl} does not answer. ` +
            `${scanHint} Open Gopeed -> Settings -> Advanced -> Protocol, read the fixed port shown there ` +
            '(Gopeed uses a random port by default), then set "port" in the plugin config to that value.'
        } else if (proc.probe === 'unavailable') {
          // The process table could not be read, so "not running" is an unverified guess. Saying it
          // would send the user to launch a second instance; report the uncertainty instead.
          verdict = 'unknown'
          advice =
            `Cannot reach ${api.baseUrl} and this host cannot enumerate processes, so whether Gopeed ` +
            'is running is unknown. Check Gopeed yourself, or set a fixed port in the plugin config to ' +
            'the one shown under Gopeed -> Settings -> Advanced.'
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
      // A missing executable is a FALLBACK note, never a verdict. It used to overwrite the advice
      // unconditionally, so a fully healthy Gopeed (verdict "running") was reported as "Could not
      // find the Gopeed installation" whenever auto-discovery failed or "exePath" was left empty --
      // a lie that sent the user to a settings page for a problem they did not have. It now appears
      // only where the missing path actually changes the next step (the API is not usable, so
      // gopeed_launch may have nothing to start), and it is appended AFTER the real diagnosis, so
      // the more important advice always survives.
      if (!resolved.path && verdict !== 'running' && verdict !== 'unauthorized') {
        const exeNote =
          'Could not find the Gopeed installation: if it is installed (for example a portable build), ' +
          'set "Executable path" in the plugin settings to the full path of Gopeed.exe.'
        advice = advice ? `${advice}\n${exeNote}` : exeNote
      }
      // Newcomer guidance only appears in failure branches (API unreachable = not installed /
      // not started / protocol not TCP). The success path stays short.
      if (api.state === 'refused' || api.state === 'error') {
        advice += `\nIf Gopeed is not installed or not configured yet: ${SETUP_GUIDE}`
      }
      // A diagnosis that ends in "not usable" is exactly when the notice helps. It rides in the
      // tool result's advice (a tool card), never as a chat message, and is sent at most once.
      if (verdict !== 'running' && verdict !== 'unauthorized') {
        const notice = takeSetupNotice()
        if (notice) advice += `\n\n${notice}`
      }

      // Retry the listener on every diagnosis: a port that was busy earlier may be free now, and
      // this tool is where the user looks to find out whether pushes are arriving at all. Calling
      // it in every mode also lets a runtime switch to off close an already open port.
      await ensureReceiver().catch(() => null)

      return {
        pluginVersion: PLUGIN_VERSION,
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
        webhookMode: webhookMode(),
        webhookListening: Boolean(receiver && receiver.status === 'listening'),
        webhookUrl: receiver && receiver.status === 'listening' ? receiver.url : '',
        webhookReceived: receiver ? receiver.received : 0,
        webhookUnread: receiver ? receiver.unreadCount() : 0,
        webhookError: receiver && receiver.status === 'listening' ? '' : receiverFailure,
        diagnosticsSandboxed: false,
        diagnosticsSandboxNote:
          'Read-only diagnosis only: the process table, socket listing, executable lookup and loopback probe ran directly with DSH host permissions and are NOT confined by any file policy. Starting or stopping Gopeed is the confined part, so a sandbox denial never hides the process from this diagnosis.',
        advice,
      }
    },
  })

  ctx.tools.register({
    name: 'gopeed_launch',
    // Starting is safe to expose as a tool; KILLING the process is not. Restarting is offered only
    // by the "Restart Gopeed" button on the plugin config page.
    description: 'Start the Gopeed process if it is not running.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'launched',
          'alreadyRunning',
          'pid',
          'apiState',
          'message',
          'launchSandboxed',
          'sandboxMode',
          'sandboxDetail',
        ],
        properties: {
          launched: { type: 'boolean', description: 'Whether a start was actually attempted.' },
          alreadyRunning: { type: 'boolean', description: 'Whether Gopeed was running before the call.' },
          pid: { type: 'integer', description: 'Pid of the process this call started; 0 when nothing started.' },
          apiState: {
            type: 'string',
            enum: ['ok', 'refused', 'timeout', 'unauthorized', 'error'],
            description: 'Last probe result after launching.',
          },
          message: { type: 'string', description: 'Human-readable result.' },
          launchSandboxed: {
            type: 'boolean',
            description: 'Whether the start command was wrapped and confined by the sandbox.',
          },
          sandboxMode: {
            type: 'string',
            description:
              'File policy the start ran under: read-only, workspace-write, danger-full-access, or empty when no start was attempted.',
          },
          sandboxDetail: {
            type: 'string',
            description:
              'Why the start was confined or not: sandbox unavailable, policy allows full access, or the sandbox refused it.',
          },
        },
      },
      render: (_args, value) => textBlock([value.message]),
    },
    isConcurrencySafe: () => false,
    presentCall: () => ({
      card: 'generic',
      title: 'Start Gopeed',
      kind: 'execute',
    }),
    timeoutMs: 40000,
    async execute(_args, exec) {
      rememberAgent(exec)
      const apiPort = await ensureApiPort()
      const base = {
        host: config.host.get(),
        // Use the RESOLVED port, not the raw config value: with port=0 (auto-detect) the raw
        // value is 0, probeApi cannot dial it, and this tool would conclude "not running" and
        // launch a second instance.
        port: apiPort || Number(config.port.get()) || 0,
        token: config.token.get(),
        timeoutMs: 3000,
      }
      // Ask the API first: when it is already running, skip pointless path detection (saves one
      // PowerShell invocation).
      const before = await probeApi(base)
      // 'unauthorized' also proves a Gopeed is listening on that port -- only the token is wrong.
      // Treating it as "not running" started a second instance (Gopeed is single-instance, so the
      // new one just exits) and then reported "Started Gopeed", which was false and hid the real
      // problem: a wrong token, which starting anything cannot fix.
      const alreadyRunning = before.state === 'ok' || before.state === 'unauthorized'

      if (alreadyRunning) {
        const tokenProblem = before.state === 'unauthorized'
        return {
          launched: false,
          alreadyRunning: true,
          pid: 0,
          apiState: before.state,
          message: tokenProblem
            ? `Gopeed is already running (${before.detail}); the token is wrong, so this session ` +
              'cannot use it yet. Set the token in the plugin settings to the one configured in Gopeed. ' +
              'Do not start another instance -- that cannot help.'
            : `Gopeed is already running (${before.detail}); not starting it again. If it is stuck, ` +
              'the user can press "Restart Gopeed" on the plugin config page.',
          ...NO_LAUNCH_SANDBOX,
        }
      }

      // Look for the executable only when a start is really needed (the result is cached in-process).
      const resolved = await resolveExecutable(config.exePath.get())
      const exePath = resolved.path

      if (!exePath) {
        return {
          launched: false,
          alreadyRunning,
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
          ...NO_LAUNCH_SANDBOX,
        }
      }

      // Starting is a write action: hand the exact argv to the optional sandbox seam. The confiner
      // resolves the session's own policy per call, so a runtime mode switch needs no remount.
      const launch = await launchProcess(exePath, { confine: makeConfiner(exec) })
      const launchSandbox = sandboxReport(launch.sandbox)
      if (!launch.ok) {
        const detail = String(launch.sandbox?.detail ?? '')
        // The refusal text already carries the reason; do not print it twice.
        const sandboxSuffix = detail && !launch.message.includes(detail) ? ` Sandbox: ${detail}` : ''
        return {
          launched: false,
          alreadyRunning,
          pid: 0,
          apiState: before.state,
          message:
            `Launch failed: ${trimPeriod(launch.message)}. Used ${exePath} (source: ${resolved.source}).` +
            `${sandboxSuffix} You can change the path under "Executable path" in the plugin config, or start Gopeed yourself.`,
          ...launchSandbox,
        }
      }

      // A freshly started Gopeed comes up on a NEW random port (the config default is 0), and that
      // port only appears once the process starts listening. Probing one fixed port for the whole
      // budget therefore reports a false failure -- the same trap the restart path already fixes.
      // Detect and probe in a loop instead.
      autoPort = 0
      autoPortAt = 0
      const probeStartedAt = Date.now()
      const deadline = probeStartedAt + 15000
      let port = Number(config.port.get()) || 0
      let after = { state: 'unknown', detail: 'not probed yet' }
      for (;;) {
        // Check the budget BEFORE an iteration, not after it: a trailing check runs one more full
        // detect+probe (plus one more 700ms sleep) after the deadline has already passed.
        if (Date.now() >= deadline) break
        const detected = await ensureApiPort(true)
        if (detected > 0) port = detected
        if (port > 0) {
          after = await waitForApi({
            host: config.host.get(),
            port,
            token: config.token.get(),
            timeoutMs: 2000,
            waitMs: 1800,
          })
          if (after.state === 'ok') break
          // 'unauthorized' is a terminal answer, not a transient one: the port already proved alive
          // with an HTTP 401, and a wrong token cannot become right by waiting. Retrying it burned
          // the whole 15s budget to reach a diagnosis the first probe already had. Only
          // 'refused' / 'timeout' / 'error' are worth another round.
          if (after.state === 'unauthorized') break
        }
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
      // How long the readiness probe actually ran. Used in the messages below: a fixed "15s" is a
      // lie once the loop exits early, which is now the normal case for a wrong token.
      const probedMs = Date.now() - probeStartedAt
      // The loop's placeholder state is 'unknown', which is NOT in the output schema's enum. When
      // the port cannot be determined at all (process table invisible, portScan off) the placeholder
      // would survive to the return value and DSH would reject the whole tool call as invalid output,
      // turning a successful launch into a fake failure. Normalise it before returning.
      if (after.state === 'unknown') {
        after = {
          state: 'error',
          detail: `Gopeed was started (pid ${launch.pid || launch.pid === 0 ? launch.pid : 'unknown'}) but its listening port could not be determined within ${probedMs}ms`,
        }
      }
      const ok = after.state === 'ok'
      const pidNote = launch.sandbox?.sandboxed
        ? ' (pid is the sandbox runner; the confined Gopeed pid is detected separately)'
        : ''
      const confineText = launch.sandbox?.sandboxed
        ? ` Start was confined by the sandbox under "${launch.sandbox.mode}" mode (enforcement: ${launch.sandbox.enforcement || 'unknown'}).`
        : ` Start was NOT confined: ${launch.sandbox?.detail || 'no sandbox applied.'}`
      return {
        launched: true,
        alreadyRunning,
        pid: Number(launch.pid) || 0,
        apiState: after.state,
        message: ok
          ? `Started Gopeed (pid ${launch.pid})${pidNote}; ready: ${after.detail}.${confineText}`
          : `Started Gopeed (pid ${launch.pid})${pidNote}, but it did not become ready (last state: ${after.state} after ${probedMs}ms: ${after.detail}). Gopeed may still be loading; check again with gopeed_process later.${confineText}`,
        ...launchSandbox,
      }
    },
  })

  // ---------------------------------------------------------------------------------------------
  // gopeed_events: read the event buffer, or (mode auto only) register this listener in Gopeed.
  // ---------------------------------------------------------------------------------------------

  /**
   * Save the listener URL into Gopeed config. This is the ONLY config save in the plugin and it
   * is reachable only through gopeed_events with an explicit action= argument, after the mode check.
   * Restarting is intentionally NOT part of this tool: it would let an agent kill the downloader.
   * The config page's "Restart Gopeed" button owns that action now.
   * @param {object} args Tool arguments (only opts into the write).
   * @param {any} exec Tool run context, used to surface setup problems.
   */
  const applyWebhookConfig = async (args, exec) => {
    const mode = webhookMode()
    const action = 'apply'
    if (mode !== 'auto') {
      throw new Error(
        `Refused: action=${action} saves Gopeed config and is only allowed in webhookMode auto (current mode: ${mode}). ` +
          'In manual mode you add the listener URL to Gopeed yourself under Settings -> Developer -> Webhook push; ' +
          'off mode listens on no port at all. Nothing was saved.',
      )
    }
    const active = await ensureReceiver()
    if (!active) {
      throw new Error(
        `Cannot register the webhook URL: the listener is not running (${receiverFailure || 'unknown reason'}). ` +
          'Fix webhookPort and retry; nothing was saved to Gopeed.',
      )
    }
    const listenerUrl = active.url
    let current
    try {
      // GET only: a failed read leaves Gopeed untouched.
      current = await client.config()
    } catch (error) {
      fail('events', error, exec)
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(
        'Cannot register the webhook URL: Gopeed returned no usable config object, so nothing was saved.',
      )
    }
    const previous = current.webhook && typeof current.webhook === 'object' ? current.webhook : {}
    // The whole config is PUT back, so start from what was read and change only webhook: the user's
    // other webhook URLs (and every unrelated setting) survive untouched.
    const next = {
      ...current,
      webhook: { ...previous, enable: true, urls: mergeWebhookUrls(previous.urls, listenerUrl) },
    }
    try {
      await client.updateConfig(next)
    } catch (error) {
      throw new Error(
        `Saving Gopeed config failed: ${error?.message || String(error)}. ` +
          'Treat Gopeed config as unchanged unless you check it; nothing else was modified.',
      )
    }
    // Read back instead of trusting the response: applied=true must mean "it is really in the file".
    let applied = false
    let readBack = ''
    try {
      const after = await client.config()
      applied =
        after?.webhook?.enable === true && mergeWebhookUrls(after?.webhook?.urls, '').includes(listenerUrl)
    } catch (error) {
      readBack = error?.message || String(error)
    }
    const result = {
      mode,
      action,
      listener: listenerUrl,
      listening: true,
      count: 0,
      unread: active.unreadCount(),
      events: [],
      applied,
      listenerUrl,
      message: '',
    }
    if (!applied) {
      result.message =
        'Gopeed accepted the save but reading the config back did not show this URL' +
        (readBack ? ` (read-back failed: ${readBack})` : '') +
        '. Treat the change as unconfirmed and check Gopeed -> Settings -> Advanced manually.'
      return result
    }
    result.message =
      'Changed Gopeed webhook config: webhook.enable=true and this listener URL is in webhook.urls ' +
      '(other URLs were kept). Gopeed was NOT restarted, so its settings screen may still show the old ' +
      'values. To reload them, open this plugin\'s config page and press "Restart Gopeed" there: ' +
      'restarting is a user action and interrupts running downloads, so no agent tool performs it.'
    return result
  }

  /** Read the retained events without touching Gopeed config. */
  const readEvents = async (args) => {
    const mode = webhookMode()
    // Called even when the mode is off so a runtime switch to off closes any open port.
    const active = await ensureReceiver()
    if (mode === 'off' || !active) {
      return {
        mode,
        action: '',
        listener: '',
        listening: false,
        count: 0,
        unread: 0,
        events: [],
        applied: false,
        message:
          mode === 'off'
            ? 'Webhook receiving is OFF: this plugin listens on no port, so Gopeed cannot push download events to it. ' +
              'Either set webhookMode to manual (then add the listener URL in Gopeed -> Settings -> Advanced -> ' +
              'Webhook push) or to auto (then call gopeed_events with action=apply), or keep polling with ' +
              'gopeed_list / gopeed_status.'
            : `Webhook mode is ${mode} but the listener is not running (${receiverFailure || 'unknown reason'}), ` +
              'so no events can arrive. Check webhookPort and retry; gopeed_process reports the same status.',
      }
    }
    const sinceRaw = Number(args?.since)
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0
    const unread = active.unreadCount()
    const events = active.list({ since, unreadOnly: args?.unreadOnly === true })
    // Returning events is what acknowledges them; without this the unread counter could only grow.
    active.markRead()
    return {
      mode,
      action: '',
      listener: active.url,
      listening: true,
      count: events.length,
      unread,
      events,
      applied: false,
      message:
        `Listening at ${active.url} (mode ${mode}): ${events.length} event(s) returned, ${unread} were unread ` +
        'before this call. Events are kept in a 50-entry buffer and are marked read once returned. If nothing ' +
        'arrives, confirm that URL is registered in Gopeed -> Settings -> Developer -> Webhook push.',
    }
  }

  ctx.tools.register({
    name: 'gopeed_events',
    // Definition budget (see gopeed_add's note): this description is deliberately terse.
    // `apply` only saves the webhook fields; restarting Gopeed is not available to any tool.
    description: 'Events; action=apply saves the webhook config.',
    // `since` / `unreadOnly` filter the read. `action` is the explicit, user-initiated save.
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'number' },
        unreadOnly: { type: 'boolean' },
        action: { type: 'string', enum: ['apply'] },
      },
    },
    output: {
      schema: EVENTS_RESULT_SCHEMA,
      render: (_args, value) => {
        if (value.action) {
          return textBlock([
            `Gopeed webhook config saved: ${value.applied ? 'yes' : 'no'}`,
            `Listener: ${value.listener || '(none)'}`,
            value.message,
          ])
        }
        if (value.mode === 'off') {
          return textBlock([
            '[!] Webhook receiving is OFF: no port is being listened on, so Gopeed push events never reach this plugin.',
            value.message,
            'Polling alternative: gopeed_list (all tasks) or gopeed_status (one task).',
          ])
        }
        if (!value.listening) {
          return textBlock([`[!] Webhook mode ${value.mode} but NOT listening.`, value.message])
        }
        const lines = [
          `Webhook ${value.mode}: listening at ${value.listener} - ${value.count} event(s), ` +
            `${value.unread} unread before this call.`,
        ]
        for (const event of value.events) {
          const size = event.sizeBytes > 0 ? `, ${formatBytes(event.sizeBytes)}` : ''
          const when = new Date(event.at).toISOString()
          lines.push(
            `- ${event.event} ${event.name || event.taskId} (${event.status || '?'}${size}) at ${when}` +
              (event.path ? ` in ${event.path}` : ''),
          )
        }
        if (value.count === 0) {
          lines.push(
            'No events yet. Confirm the listener URL above is added in Gopeed -> Settings -> Developer -> Webhook push.',
          )
        }
        lines.push('Returned events are marked read.')
        return textBlock(lines)
      },
    },
    // Saves Gopeed config on the action branch and marks events read, so never concurrent.
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: args?.action ? 'Gopeed webhook config' : 'Gopeed events',
      kind: args?.action ? 'execute' : 'other',
    }),
    timeoutMs: 45000,
    async execute(args, exec) {
      rememberAgent(exec)
      const action = optString(args?.action).toLowerCase()
      // Restarting is deliberately not an action: only the config page button may kill Gopeed.
      if (action && action !== 'apply') {
        throw new Error(
          `Unsupported action: ${action} (expected apply). Restarting Gopeed is a user action: ` +
            'press "Restart Gopeed" on the plugin config page.',
        )
      }
      if (action) return applyWebhookConfig({ ...args, action }, exec)
      return readEvents(args)
    },
  })

  ctx.logger?.info?.(
    `dsh-gopeed-downloader: registered 7 tools, endpoint ${client.baseUrl()}, webhook mode ${webhookMode()}`,
  )
}

/** Exported for debugging / reuse: format a byte count as readable text. */
export { formatBytes }

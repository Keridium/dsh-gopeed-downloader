/**
 * Gopeed REST API client (no third-party dependencies, only Node's built-in fetch).
 *
 * Design notes:
 * - Only the loopback address is used. The configured port defaults to 0 (auto-detect), because
 *   Gopeed's desktop build ships with 127.0.0.1:0 - a random port per launch; 9999 is only the
 *   conventional last-resort fallback below. Requests are authenticated with X-Api-Token when a
 *   token is configured.
 * - Every response is an envelope { code, msg, data }; code !== 0 throws GopeedApiError
 *   (note the field is msg, not message).
 * - Gopeed 1.9.3 task objects have no top-level size: the total lives in meta.res.size, and
 *   progress.used is in nanoseconds (not bytes).
 * - pause/continue on a finished task answers code:1000 task not found, which is normal; the
 *   caller tolerates it.
 *
 * This file imports nothing from DSH/cordis, so it can be tested with plain `node`.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { Socket } from 'node:net'
import { basename } from 'node:path'

/** Error thrown when Gopeed answers with code !== 0. */
export class GopeedApiError extends Error {
  /**
   * @param {number} code Code returned by Gopeed.
   * @param {string} msg Msg returned by Gopeed (the field really is named msg).
   * @param {string} route API route that failed.
   */
  constructor(code, msg, route) {
    // code -1 is synthesized locally (transport/timeout/parse failure), not an answer from
    // Gopeed, so the envelope wording would only add noise.
    const raw = code === -1 ? String(msg) : `Gopeed ${route} returned code=${code} msg=${msg || '(empty)'}`
    // A wrong token is the single most common failure, and the bare envelope ("code=1001
    // msg=unauthorized") tells the caller neither the cause nor the fix. Gopeed answers 1001/401 on
    // 1.9.3 and 403 on other builds; the message text is checked too, because the code is not
    // stable across versions.
    const wrongToken =
      code === 401 || code === 403 || code === 1001 || /unauthor|forbidden/i.test(String(msg ?? ''))
    super(
      wrongToken
        ? `${raw} -- the token is wrong; set it in the plugin settings (gopeed_process explains it)`
        : raw,
    )
    this.name = 'GopeedApiError'
    this.code = code
    this.msg = msg || ''
    this.route = route
  }
}

/** Whether this is a "task already gone / finished" business error that can be tolerated. */
export function isTaskGoneError(error) {
  return error instanceof GopeedApiError && (error.code === 1000 || /not\s*found/i.test(error.msg))
}

/**
 * Unwrap the Gopeed response envelope.
 * @param {string} route API route (for error messages).
 * @param {Response} response fetch Response.
 * @returns {Promise<unknown>} The data field.
 */
async function unwrap(route, response) {
  const text = await response.text()
  let payload
  try {
    payload = text.length === 0 ? {} : JSON.parse(text)
  } catch {
    throw new GopeedApiError(-1, `response is not valid JSON (HTTP ${response.status}): ${text.slice(0, 200)}`, route)
  }
  if (payload && typeof payload === 'object' && 'code' in payload && payload.code !== 0) {
    throw new GopeedApiError(Number(payload.code), String(payload.msg ?? ''), route)
  }
  if (!response.ok) {
    throw new GopeedApiError(Number(payload?.code ?? response.status), String(payload?.msg ?? response.statusText), route)
  }
  return payload?.data
}

/**
 * Create a Gopeed client bound to a given host/port/token.
 * Settings are read through a getter, so edits in the settings UI apply without a restart.
 *
 * @param {object} options
 * @param {() => { host: string, port: number, token: string, timeoutMs?: number }} options.resolve
 *   Called before each request; returns the connection parameters currently in effect.
 * @returns A set of API methods.
 */
export function createGopeedClient({ resolve }) {
  /** Read the current connection parameters, with basic fallbacks. */
  function settings() {
    const raw = resolve() || {}
    const rawHost = String(raw.host || '127.0.0.1').trim() || '127.0.0.1'
    // Reject the two shapes people actually paste into this field, because both otherwise fail
    // much later with a misleading "cannot reach Gopeed":
    //   "http://127.0.0.1"  -> http://http://127.0.0.1:9999  (DNS lookup of the host name "http")
    //   "127.0.0.1:9999"    -> http://127.0.0.1:9999:9999    (ERR_INVALID_URL)
    // A bare IPv6 literal also has to be bracketed for the URL to parse.
    if (rawHost.includes('://')) {
      throw new GopeedApiError(
        -1,
        `host must be a bare IP or hostname, not a URL (got "${rawHost}"). Put the address in host and the number in port.`,
        '/',
      )
    }
    // A bracketed IPv6 literal ("[::1]") is already valid for a URL; only a bare one needs help.
    const bracketed = rawHost.startsWith('[') && rawHost.endsWith(']')
    if (!bracketed) {
      const hostParts = rawHost.split(':')
      if (hostParts.length === 2 && /^\d+$/.test(hostParts[1])) {
        throw new GopeedApiError(
          -1,
          `host must not include a port (got "${rawHost}"). Put the address in host and the number in port.`,
          '/',
        )
      }
      if (hostParts.length > 2) {
        throw new GopeedApiError(
          -1,
          `a bare IPv6 address cannot be used directly (got "${rawHost}"). Wrap it in brackets, e.g. "[::1]".`,
          '/',
        )
      }
    }
    const host = rawHost
    // 0 is a meaningful value here ("port unknown, auto-detection found nothing"), so it must
    // NOT be coerced to a default: `Number(x) || 9999` would silently turn 0 into 9999 and make
    // the "no port" diagnostics unreachable.
    const configuredPort = Number(raw.port)
    const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 0
    const token = String(raw.token ?? '')
    const timeoutMs = Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 20000
    return { host, port, token, timeoutMs, baseUrl: `http://${host}:${port}` }
  }

  /** Current base URL, for errors and display. */
  function baseUrl() {
    return settings().baseUrl
  }

  /**
   * Send one request and unwrap the envelope.
   * @param {string} method HTTP method.
   * @param {string} route API route (including query).
   * @param {unknown} [body] JSON body; undefined means no body.
   */
  async function request(method, route, body) {
    const { baseUrl: base, token, timeoutMs, port } = settings()
    if (!port) {
      // Never guess a default port: report that the port is unknown so the caller can tell the
      // user to pin one in Gopeed or to run gopeed_process for a diagnosis.
      throw new GopeedApiError(
        -1,
        `cannot reach Gopeed: the listen port is unknown (the configured port is 0 and auto-detection found nothing). ` +
          'Set "port" in the plugin config to the fixed port shown under Gopeed -> Settings -> Advanced.',
        route,
      )
    }
    const headers = {}
    if (token) headers['X-Api-Token'] = token
    let payload
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      payload = JSON.stringify(body)
    }
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), timeoutMs)
    let response
    try {
      response = await fetch(base + route, {
        method,
        headers,
        body: payload,
        signal: timer.signal,
      })
    } catch (error) {
      const reason = error?.name === 'AbortError' ? `request timed out (${timeoutMs}ms)` : describeLinkError(error)
      throw new GopeedApiError(
        -1,
        `cannot reach Gopeed (${base}): ${reason}. Make sure Gopeed is running and Settings -> Advanced -> Protocol is TCP on that port.`,
        route,
      )
    } finally {
      clearTimeout(timeout)
    }
    return unwrap(route, response)
  }

  return {
    baseUrl,
    settings,

    /** GET /api/v1/info */
    info() {
      return request('GET', '/api/v1/info')
    },

    /**
     * GET /api/v1/config
     * Read-only: used by gopeed_events to show what Gopeed currently has. Never call this from a
     * polling or startup path just to "check" something - reads are cheap but pointless there.
     */
    config() {
      return request('GET', '/api/v1/config')
    },

    /**
     * PUT /api/v1/config
     * Replaces the whole config, so callers MUST send back the object they read (with only the
     * intended field changed). Only an explicitly invoked tool may call this.
     */
    updateConfig(body) {
      return request('PUT', '/api/v1/config', body)
    },

    /** GET /api/v1/tasks */
    list() {
      return request('GET', '/api/v1/tasks')
    },

    /** GET /api/v1/tasks/{id} */
    get(id) {
      return request('GET', `/api/v1/tasks/${encodeURIComponent(id)}`)
    },

    /**
     * POST /api/v1/tasks
     * @param {{url: string, path?: string, name?: string}} input
     * @returns {Promise<string>} taskId
     */
    async create(input) {
      const opts = {}
      if (input.path) opts.path = input.path
      if (input.name) opts.name = input.name
      const body = { req: { url: input.url } }
      if (Object.keys(opts).length > 0) body.opts = opts
      const id = await request('POST', '/api/v1/tasks', body)
      return String(id ?? '')
    },

    /** PUT /api/v1/tasks/{id}/pause */
    pause(id) {
      return request('PUT', `/api/v1/tasks/${encodeURIComponent(id)}/pause`)
    },

    /** PUT /api/v1/tasks/{id}/continue */
    resume(id) {
      return request('PUT', `/api/v1/tasks/${encodeURIComponent(id)}/continue`)
    },

    /** DELETE /api/v1/tasks/{id}?force=true */
    remove(id, force = true) {
      return request('DELETE', `/api/v1/tasks/${encodeURIComponent(id)}${force ? '?force=true' : ''}`)
    },
  }
}

/**
 * Normalize a raw Gopeed task into the flat shape the model reads.
 *
 * Supports 1.9.3 (no top-level size) and 2.x (top-level size).
 * @param {any} task Gopeed task object.
 * @returns {object} Normalized task.
 */
export function normalizeTask(task) {
  const raw = task && typeof task === 'object' ? task : {}
  const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {}
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  const res = meta.res && typeof meta.res === 'object' ? meta.res : {}
  const opts = meta.opts && typeof meta.opts === 'object' ? meta.opts : {}

  const size = toNumber(res.size) || toNumber(raw.size) || 0
  const downloaded = toNumber(progress.downloaded) || 0
  const speed = toNumber(progress.speed) || 0
  const uploaded = toNumber(progress.uploaded) || 0
  const uploadSpeed = toNumber(progress.uploadSpeed) || 0
  const percent = size > 0 ? Math.min(100, Math.round((downloaded / size) * 1000) / 10) : 0
  const status = String(raw.status ?? 'unknown')
  // Gopeed keeps the last instantaneous speed on finished or failed tasks; zero it so it is not
  // misread as a live transfer.
  const liveSpeed = status === 'done' || status === 'error' ? 0 : speed

  const path = typeof opts.path === 'string' ? opts.path : ''
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? opts.name ?? ''),
    status,
    protocol: String(raw.protocol ?? 'http'),
    sizeBytes: Math.max(0, Math.round(size)),
    downloadedBytes: Math.max(0, Math.round(downloaded)),
    percent,
    sizeKnown: size > 0,
    speedBytesPerSec: Math.max(0, Math.round(liveSpeed)),
    uploadedBytes: Math.max(0, Math.round(uploaded)),
    uploadSpeedBytesPerSec: Math.max(0, Math.round(uploadSpeed)),
    path,
    createdAt: String(raw.createdAt ?? ''),
  }
}

/** Lenient number conversion: anything non-numeric becomes 0. */
function toNumber(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Node fetch hides the connection failure in the cause chain; turn it into one plain sentence. */
function describeLinkError(error) {
  const code =
    error?.cause?.code ||
    error?.cause?.errors?.[0]?.code ||
    error?.code ||
    error?.cause?.cause?.code ||
    ''
  const explain = {
    ECONNREFUSED: 'connection refused; Gopeed may not be running or the port is wrong',
    ECONNRESET: 'connection reset',
    ENOTFOUND: 'DNS lookup failed; wrong host',
    EAI_AGAIN: 'DNS lookup failed; wrong host',
    ETIMEDOUT: 'connection timed out',
    EHOSTUNREACH: 'host unreachable',
  }
  if (code && explain[code]) return `${code} (${explain[code]})`
  if (code) return String(code)
  // Node's fetch only throws "fetch failed"; the real reason is in cause.message (e.g. "bad port").
  return error?.cause?.message || error?.message || String(error)
}

/** Human-readable size in base 1024. */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
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
 * One human-readable task line, used by the tools' render().
 * @param {ReturnType<typeof normalizeTask>} task Normalized task.
 */
export function describeTask(task) {
  const parts = [`${task.status}`]
  if (task.sizeKnown) parts.push(`${task.percent}%`)
  parts.push(`${formatBytes(task.downloadedBytes)}${task.sizeKnown ? ` / ${formatBytes(task.sizeBytes)}` : ''}`)
  if (task.speedBytesPerSec > 0) parts.push(`${formatBytes(task.speedBytesPerSec)}/s`)
  if (task.path) parts.push(task.path)
  return `[${task.id}] ${task.name || '(unnamed)'} - ${parts.join(' ')}`
}

// ---------------------------------------------------------------------------
// Process probing and launching
//
// Why the API probe leads and the process probe only follows:
// measured on this machine (2026-10-31) under DSH's restricted execution environment,
// Get-Process could only see a dozen processes, tasklist answered Access denied and WMI refused
// access - while Gopeed was clearly running. So "process not found" does not mean "process not
// started". Hence:
//   - a verdict is only drawn when the API gives a definite answer (ok / refused / timeout);
//   - a failed process probe always returns probe:'unavailable' and never lies with found:false.
// ---------------------------------------------------------------------------
// Optional sandbox seam
//
// This file imports nothing from DSH/cordis, so confinement is INJECTED as a
// plain function instead of a service. A caller passes
//   { confine: async (argv, purpose) => decision }
// to launchProcess / stopProcess, where purpose is 'launch' or 'stop'. Without
// it every helper behaves exactly as before, which keeps the file runnable
// under plain node.
//
// Decision contract for the injected function:
//   - { argv, sandboxed: true, ... }        execute the wrapped argv;
//   - { argv, sandboxed: false,
//       status: 'unavailable' | 'full-access' } execute unwrapped, report why;
//   - { blocked: true, detail } or
//     { status: 'denied', detail }          refuse: nothing is executed;
//   - throwing is also a refusal. Fail closed: a sandbox that cannot confine
//     must never silently degrade to an unconfined execution.
//
// The facts returned next to a result are always shaped the same way, so the
// tool layer can label an outcome without knowing which branch produced it.
// ---------------------------------------------------------------------------

/** Facts for a call made with no confinement seam injected at all. */
const UNCONFINED_FACTS = Object.freeze({
  sandboxed: false,
  mode: '',
  enforcement: '',
  detail: 'Executed without a sandbox: no confinement seam was provided at this call site.',
})

/**
 * Ask the injected confiner how one exact argv must run.
 *
 * @param {string[]} argv Exact argv about to be executed.
 * @param {'launch'|'stop'} purpose What the argv does (used in failure text).
 * @param {((argv: string[], purpose: string) => Promise<object>) | undefined} confine
 *   Injected confinement function, or undefined to run unwrapped.
 * @returns {Promise<{argv: string[], sandboxed: boolean, blocked: boolean, facts: object, message: string}>}
 *   A refused decision carries blocked:true and an agent-readable message.
 */
async function planExecution(argv, purpose, confine) {
  if (typeof confine !== 'function') {
    return { argv, sandboxed: false, blocked: false, facts: UNCONFINED_FACTS, message: '' }
  }
  let decision
  try {
    decision = await confine(argv, purpose)
  } catch (error) {
    // A throwing confiner is a refusal, never a reason to run unconfined.
    const message = `Refusing to run unconfined: the sandbox call failed (${String(error?.message || error)})`
    return {
      argv,
      sandboxed: false,
      blocked: true,
      facts: { sandboxed: false, mode: '', enforcement: '', detail: message },
      message,
    }
  }
  const wrapped = Array.isArray(decision?.argv) ? decision.argv.map(String) : []
  const claimsSandbox = decision?.sandboxed === true
  const facts = {
    sandboxed: claimsSandbox && wrapped.length > 0,
    mode: typeof decision?.mode === 'string' ? decision.mode : '',
    enforcement: typeof decision?.enforcement === 'string' ? decision.enforcement : '',
    detail: typeof decision?.detail === 'string' ? decision.detail : '',
  }
  if (decision?.blocked === true || decision?.status === 'denied') {
    return {
      argv,
      sandboxed: false,
      blocked: true,
      facts,
      message: facts.detail || `refused by the sandbox before ${purpose}`,
    }
  }
  if (claimsSandbox && wrapped.length === 0) {
    // "Sandboxed" without a wrapped argv would execute the original command
    // unconfined while claiming confinement. Treat it as a broken sandbox.
    return {
      argv,
      sandboxed: false,
      blocked: true,
      facts,
      message: 'the sandbox reported a confined execution but returned no argv; refusing to run unconfined',
    }
  }
  if (facts.sandboxed) return { argv: wrapped, sandboxed: true, blocked: false, facts, message: '' }
  // Allowed but unconfined: status 'unavailable' (no sandbox on this host) or
  // 'full-access' (the caller's own policy is unrestricted).
  return { argv: wrapped.length > 0 ? wrapped : argv, sandboxed: false, blocked: false, facts, message: '' }
}

/**
 * Run a child process with a timeout and capture its output.
 * Under the sandbox piped stdio may fail with EPERM; that is swallowed into {ok:false} and the
 * caller degrades.
 */
function execCapture(file, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            code: error?.code,
            message: error?.message || '',
            stdout: stdout || '',
            stderr: stderr || '',
          })
        },
      )
    } catch (error) {
      resolve({ ok: false, code: error?.code, message: error?.message || String(error), stdout: '' })
    }
  })
}

/**
 * Probe Gopeed's HTTP API. This is the main evidence for "alive / stuck / not started".
 * @param {{host:string, port:number, token:string, timeoutMs?:number}} options
 */
export async function probeApi(options) {
  const host = String(options?.host || '127.0.0.1').trim()
  // Keep 0 as 0: it means "no port resolved", which the guard below turns into an explicit,
  // honest diagnostic instead of silently probing a default port.
  const rawPort = Number(options?.port)
  const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 0
  const token = String(options?.token ?? '')
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000
  const baseUrl = `http://${host}:${port}`
  if (!Number.isInteger(port) || port <= 0) {
    return {
      state: 'error',
      latencyMs: 0,
      baseUrl,
      detail: 'no port: the configured port is 0 (auto-detect) and no live port could be detected',
      version: '',
    }
  }
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {}
    if (token) headers['X-Api-Token'] = token
    const response = await fetch(`${baseUrl}/api/v1/info`, { headers, signal: controller.signal })
    const latencyMs = Date.now() - startedAt
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    if (payload && payload.code === 0) {
      return {
        state: 'ok',
        latencyMs,
        baseUrl,
        detail: `Gopeed ${payload.data?.version ?? '?'} responded normally`,
        version: String(payload.data?.version ?? ''),
      }
    }
    // Gopeed answers 401 for a bad token on 1.9.3 and 403 on some other builds; both mean "a
    // Gopeed lives here, the token is wrong". Treating only 403 as unauthorized also broke port
    // discovery: discoverApiPort keeps a port whose probe says `unauthorized`, so a 401 that fell
    // through to `error` made auto-detection give up on the one port that was actually right.
    if (
      response.status === 401 ||
      response.status === 403 ||
      payload?.code === 401 ||
      payload?.code === 403
    ) {
      return {
        state: 'unauthorized',
        latencyMs,
        baseUrl,
        detail: `wrong token (HTTP ${response.status})`,
        version: '',
      }
    }
    return {
      state: 'error',
      latencyMs,
      baseUrl,
      detail: `HTTP ${response.status} ${payload?.msg ?? ''}`.trim(),
      version: '',
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const code = error?.cause?.code || error?.cause?.errors?.[0]?.code || ''
    if (error?.name === 'AbortError') {
      return {
        state: 'timeout',
        latencyMs,
        baseUrl,
        detail: `no response within ${timeoutMs}ms (port open, the process may be stuck)`,
        version: '',
      }
    }
    if (code === 'ECONNREFUSED') {
      return {
        state: 'refused',
        latencyMs,
        baseUrl,
        detail: 'connection refused (process not running, or not this port)',
        version: '',
      }
    }
    return { state: 'error', latencyMs, baseUrl, detail: describeLinkError(error), version: '' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Find the Gopeed process.
 *
 * The returned `probe` says how trustworthy `found` is:
 * - `'ok'`: the probing method works, so `found` is reliable;
 * - `'unavailable'`: the process list is unreachable (sandbox/permissions); `found` is
 *   meaningless and the API verdict should be trusted instead.
 *
 * @param {string} executablePath Absolute path of Gopeed.exe (matched by file name); leave empty
 *   to match Gopeed.exe.
 */
export async function findProcess(executablePath) {
  const image = basename(String(executablePath || 'Gopeed.exe')) || 'Gopeed.exe'
  const reasons = []

  // Option 1: tasklist (fastest, CSV is easy to parse).
  const tasklist = await execCapture(
    'tasklist',
    ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'],
    4000,
  )
  if (tasklist.ok || (typeof tasklist.stdout === 'string' && tasklist.stdout.includes('","'))) {
    const rows = String(tasklist.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"'))
      .map((line) => line.slice(1, -1).split('","'))
      .filter((cells) => cells.length >= 2)
    if (rows.length === 0)
      return { probe: 'ok', found: false, pid: 0, image, memoryMB: 0, detail: `process ${image} is not running` }
    const [name, pidText, , , memText] = rows[0]
    const memoryKB = Number(String(memText || '').replace(/[^\d]/g, '')) || 0
    return {
      probe: 'ok',
      found: true,
      pid: Number(pidText) || 0,
      image,
      memoryMB: Math.round((memoryKB / 1024) * 10) / 10,
      detail: `${name} is running (pid ${pidText})`,
    }
  }
  reasons.push(`tasklist: ${tasklist.message || tasklist.code || 'failed'}`)

  // Option 2: powershell Get-Process (covers the case where tasklist is unavailable).
  // -Name is wrapped in single quotes; PowerShell escapes a quote by doubling it, which keeps the
  // script skeleton intact when the file name contains one.
  //
  // The command also reports whether PowerShell can see its own process. A restricted token can run
  // this and exit 0 while the process list it sees is empty; treating that as "not running" would
  // turn "I cannot see" into "it is not there" and send the user to launch a second instance.
  const processName = image.replace(/\.exe$/i, '').replace(/'/g, "''")
  const ps = await execCapture(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$self = $null -ne (Get-Process -Id $PID -ErrorAction SilentlyContinue); ` +
        `$list = @(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$([math]::Round($_.WorkingSet64/1MB,1))" }) -join ','; ` +
        `"$self|$list"`,
    ],
    8000,
  )
  if (ps.ok) {
    const raw = String(ps.stdout).trim()
    const sep = raw.indexOf('|')
    const seesSelf = sep >= 0 ? raw.slice(0, sep).trim().toLowerCase() === 'true' : false
    const listed = sep >= 0 ? raw.slice(sep + 1).trim() : ''
    if (!listed && seesSelf) {
      return { probe: 'ok', found: false, pid: 0, image, memoryMB: 0, detail: `process ${image} is not running` }
    }
    if (listed) {
      const [pidText, memText] = listed.split(',').filter(Boolean)[0].split('|')
      return {
        probe: 'ok',
        found: true,
        pid: Number(pidText) || 0,
        image,
        memoryMB: Number(memText) || 0,
        detail: `${image} is running (pid ${pidText})`,
      }
    }
    reasons.push('powershell: empty process view that cannot even see its own process')
  } else {
    reasons.push(`powershell: ${ps.message || ps.code || 'failed'}`)
  }

  return {
    probe: 'unavailable',
    found: false,
    pid: 0,
    image,
    memoryMB: 0,
    detail: `process list unavailable (${reasons.join('; ')})`,
  }
}

// ---------------------------------------------------------------------------
// Executable resolution (the goal: the user fills in nothing)
//
// Lookup order, most precise first:
//   1. an explicitly configured path (only used when it exists; supports portable/custom installs)
//   2. the default install locations of Gopeed's official installer
//      (%LOCALAPPDATA%\Programs\Gopeed etc.) - a pure existsSync check, so the common case needs
//      no PowerShell at all
//   3. auto-discovery (only when 1 and 2 both fail):
//      running process Path -> uninstall registry key -> shortcuts -> other common install paths
//      (Program Files, Program Files (x86), D:\Program Files, ...)
// In step 3, "process Path -> registry -> shortcuts" is a single powershell call to avoid several
// process spawns; the result is cached in-process.
// ---------------------------------------------------------------------------

/** Resolution cache; recomputed automatically when the path disappears. */
let resolvedExecutable = null

/**
 * Default install locations of the official Windows installer.
 *
 * Measured on this machine (2026-10-31): `%LOCALAPPDATA%\Programs\Gopeed\Gopeed.exe`. The
 * directory may be spelled gopeed on disk; Windows paths are case-insensitive, so Gopeed is
 * used consistently. `%LOCALAPPDATA%\Gopeed\Gopeed.exe` is added as a reasonable fallback.
 * @returns {string[]} Candidate paths, in priority order.
 */
function defaultInstallCandidates() {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return []
  return [
    `${localAppData}\\Programs\\Gopeed\\Gopeed.exe`,
    `${localAppData}\\Gopeed\\Gopeed.exe`,
  ]
}

/** PowerShell discovery script: prints one "source|path" per line. */
const DISCOVER_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$out=@()',
  "$p=Get-Process -Name Gopeed -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1",
  "if($p){ $out += ('process|' + $p.Path) }",
  "$keys=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
  "$u=Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Gopeed*' } | Select-Object -First 1",
  "if($u -and $u.DisplayIcon){ $out += ('registry|' + $u.DisplayIcon) }",
  "if($u -and $u.InstallLocation){ $out += ('installloc|' + $u.InstallLocation) }",
  '$lnks=@("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Gopeed.lnk","$env:USERPROFILE\\Desktop\\Gopeed.lnk","$env:PUBLIC\\Desktop\\Gopeed.lnk")',
  '$lnk=$lnks | Where-Object { Test-Path $_ } | Select-Object -First 1',
  "if($lnk){ try { $sh=New-Object -ComObject WScript.Shell; $out += ('shortcut|' + $sh.CreateShortcut($lnk).TargetPath) } catch { } }",
  "$out -join ';;'",
].join('; ')

/**
 * Step 3 fallback: only list common directories outside the default location.
 * Default locations (e.g. %LOCALAPPDATA%\Programs\Gopeed) are handled in step 2 by
 * defaultInstallCandidates() and are not repeated here.
 */
function commonCandidates() {
  const env = process.env
  const list = []
  for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (!root) continue
    list.push(`${root}\\Gopeed\\Gopeed.exe`)
    list.push(`${root}\\gopeed\\Gopeed.exe`)
  }
  list.push('D:\\Program Files\\Gopeed\\Gopeed.exe')
  // Deduplicate while keeping order.
  return [...new Set(list)]
}

/** Turn a raw registry/shortcut string into an executable path. */
function normalizeCandidate(raw, kind) {
  let text = String(raw || '').trim()
  if (!text) return ''
  text = text.replace(/^"+|"+$/g, '').trim()
  // DisplayIcon commonly looks like C:\path\Gopeed.exe,0
  text = text.replace(/,\s*-?\d+$/, '').trim()
  if (kind === 'installloc') return text ? `${text.replace(/[\\/]+$/, '')}\\Gopeed.exe` : ''
  if (!/\.exe$/i.test(text)) return ''
  return text
}

/**
 * Run PowerShell once and collect candidate executables in priority order.
 * @returns {Promise<{hits: string[], tried: string[]}>} hits are ordered by priority.
 */
async function discoverExecutables() {
  const result = await execCapture(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', DISCOVER_SCRIPT],
    12000,
  )
  const tried = []
  if (!result.ok) {
    tried.push(`powershell discovery failed: ${result.message || result.code || 'unknown reason'}`)
    return { hits: [], tried }
  }
  const hits = []
  for (const line of String(result.stdout).split(';;')) {
    const text = line.trim()
    if (!text) continue
    const barrier = text.indexOf('|')
    if (barrier <= 0) continue
    const kind = text.slice(0, barrier)
    const candidate = normalizeCandidate(text.slice(barrier + 1), kind)
    if (candidate && !hits.includes(candidate)) hits.push(candidate)
  }
  if (hits.length === 0) tried.push('running process / registry / shortcuts returned no usable path')
  return { hits, tried }
}

/**
 * Resolve the Gopeed executable location without requiring user configuration.
 *
 * Order: configured value -> default install path -> auto-discovery (process/registry/shortcuts/
 * other common paths). Step 2 must run before discoverExecutables(): a normally running Gopeed
 * sits in the default location, so a hit returns immediately and saves a PowerShell spawn.
 *
 * @param {string} [configuredPath] Explicitly configured path (may be empty).
 * @returns {Promise<{path: string, source: string, tried: string[]}>} path is '' when not found.
 */
export async function resolveExecutable(configuredPath) {
  const tried = []
  const configured = String(configuredPath || '').trim()
  if (configured) {
    // A bare existsSync accepts a directory or any file, which then skips the auto-discovery that
    // might have found the real executable and fails later with a raw spawn ENOENT/EFTYPE. Only a
    // real .exe file counts as "configured".
    if (existsSync(configured)) {
      let isExe = false
      try {
        isExe = statSync(configured).isFile() && /\.exe$/i.test(configured)
      } catch {
        isExe = false
      }
      if (isExe) return { path: configured, source: 'configured path', tried }
      tried.push(`configured path is not a .exe file: ${configured}`)
    } else {
      tried.push(`configured path does not exist: ${configured}`)
    }
  }

  if (resolvedExecutable && existsSync(resolvedExecutable.path)) {
    return { path: resolvedExecutable.path, source: `${resolvedExecutable.source} (cached)`, tried }
  }

  // Step 2: default install paths. Pure local file checks, no child process needed.
  for (const candidate of defaultInstallCandidates()) {
    if (existsSync(candidate)) {
      resolvedExecutable = { path: candidate, source: 'default install path' }
      return { path: candidate, source: 'default install path', tried }
    }
    tried.push(`default install path does not exist: ${candidate}`)
  }

  // Step 3: auto-discovery. A failure in step 2 must not cause an early return here: when the
  // process is running, its own Path is the only accurate source (portable/custom locations).
  const discovered = await discoverExecutables()
  tried.push(...discovered.tried)
  for (const hit of discovered.hits) {
    if (!existsSync(hit)) {
      tried.push(`discovered but missing: ${hit}`)
      continue
    }
    resolvedExecutable = { path: hit, source: 'auto-discovered' }
    return { path: hit, source: 'auto-discovered', tried }
  }

  for (const candidate of commonCandidates()) {
    if (existsSync(candidate)) {
      resolvedExecutable = { path: candidate, source: 'auto-discovered' }
      return { path: candidate, source: 'auto-discovered', tried }
    }
  }
  tried.push('no Gopeed.exe under common install paths (Program Files / Program Files (x86) / D:\\Program Files)')

  return { path: '', source: '', tried }
}

/**
 * Find the TCP ports a process is listening on.
 *
 * Gopeed's desktop build defaults to address `127.0.0.1:0`, so the OS picks a random port on
 * every launch and nothing outside the process knows it. Reading it back from the OS is the only
 * way to make a "zero configuration" setup work.
 *
 * Two sources, in order: `netstat -ano` (cheap, but a sandboxed token may see only its own
 * sockets) and `Get-NetTCPConnection -OwningProcess` (slower, wider visibility). Returns null
 * when neither can see anything, which must be reported as "unknown", never as "no port".
 *
 * @param {number} pid Target process id.
 * @returns {Promise<number[] | null>} Listening ports, or null when probing is unavailable.
 */
export async function findListeningPorts(pid) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) return null

  const netstat = await execCapture('netstat', ['-ano'], 8000)
  if (netstat.ok) {
    const ports = []
    for (const line of String(netstat.stdout).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 5) continue
      if (cols[cols.length - 1] !== String(target)) continue
      // Which local port does this row belong to? Harvest every row of this pid, not only the
      // LISTENING ones: a restricted token often cannot see another process's LISTENING rows
      // while it *can* see that process's ESTABLISHED rows - and a listening port shows up there
      // too as soon as the app talks to itself. Non-listening candidates simply fail the probe.
      const port = Number((cols[1].match(/:(\d+)$/) || [])[1])
      if (port > 0 && port < 65536 && !ports.includes(port)) ports.push(port)
    }
    if (ports.length > 0) return ports
  }

  const ps = await execCapture(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq ${target} } | ForEach-Object { $_.LocalPort }`,
    ],
    12000,
  )
  if (ps.ok) {
    const ports = [...new Set(
      String(ps.stdout).split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536),
    )]
    if (ports.length > 0) return ports
  }

  return null
}

/**
 * Read the OS dynamic port range, which is where a `bind(0)` listener lands.
 * @returns {Promise<{from:number,to:number} | null>} Range, or null when it cannot be read.
 */
async function dynamicPortRange() {
  const result = await execCapture('netsh', ['int', 'ipv4', 'show', 'dynamicport', 'tcp'], 5000)
  if (!result.ok) return null
  // Locale-independent: the two values are the only ": <number>" occurrences.
  const numbers = [...String(result.stdout).matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]))
  if (numbers.length < 2) return null
  const [start, count] = numbers
  if (!start || !count) return null
  return { from: start, to: start + count - 1 }
}

/**
 * Whether a TCP port accepts a connection on the loopback address.
 * @param {string} host Target host.
 * @param {number} port Target port.
 * @param {number} timeoutMs Connect timeout.
 */
function isPortOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    try {
      socket.connect(port, host)
    } catch {
      done(false)
    }
  })
}

/**
 * Scan the dynamic port range for ports that accept connections.
 * @param {{host:string, from:number, to:number, concurrency?:number, timeoutMs?:number}} input
 * @returns {Promise<number[]>} Open ports, ascending.
 */
async function scanOpenPorts(input) {
  const host = input.host || '127.0.0.1'
  const from = Number(input.from)
  const to = Number(input.to)
  const concurrency = Math.max(1, Math.min(Number(input.concurrency) || 700, 1200))
  const timeoutMs = Number(input.timeoutMs) || 180
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return []

  const found = []
  let next = from
  const worker = async () => {
    for (;;) {
      const port = next
      next += 1
      if (port > to) return
      if (await isPortOpen(host, port, timeoutMs)) found.push(port)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, to - from + 1) }, worker))
  return found.sort((a, b) => a - b)
}

/**
 * Probe the candidate ports of a process and return the first one that answers like Gopeed.
 *
 * Two strategies, because Windows does not always let one process list another process's sockets:
 * 1. Ask the OS for the ports this pid listens on (cheap, but often permission-blocked).
 * 2. When that is unavailable, scan the dynamic port range for open ports on loopback and probe
 *    each one with /api/v1/info. The range holds ~14k ports on a stock Windows box and loopback
 *    connects resolve in milliseconds, so a bounded concurrent scan finishes in a few seconds.
 *
 * @param {{pid?:number, host:string, token:string, timeoutMs?:number, scan?:boolean, range?:{from:number,to:number}}} input
 *   `scan` defaults to false: enumerating the process's own sockets is fair game, sweeping every
 *   loopback port is not, so the caller has to opt in explicitly.
 * @returns {Promise<{port: number, state: string} | null>} The matching port, or null.
 */
export async function discoverApiPort(input) {
  const host = input.host || '127.0.0.1'
  const probeTimeout = Math.min(Number(input.timeoutMs) || 3000, 3000)

  const tryPorts = async (ports) => {
    for (const port of ports) {
      const result = await probeApi({ host, port, token: input.token, timeoutMs: probeTimeout })
      // `ok` is a confirmed Gopeed; `unauthorized` means a Gopeed lives there but the token differs.
      if (result.state === 'ok' || result.state === 'unauthorized') return { port, state: result.state }
    }
    return null
  }

  // Strategy 1: ask the OS about this pid.
  const listed = input.pid ? await findListeningPorts(input.pid) : null
  if (listed !== null && listed.length > 0) {
    const hit = await tryPorts(listed)
    if (hit) return hit
  }

  // Strategy 2: bounded scan of the dynamic range. OFF unless the caller explicitly opts in:
  // touching every loopback port is outside what a downloader plugin should do on its own, and
  // Gopeed's random-port default is a deliberate choice, not an obstacle to route around.
  if (input.scan !== true) return null
  const range = input.range || (await dynamicPortRange())
  if (!range) return null
  const open = await scanOpenPorts({ host, from: range.from, to: range.to })
  if (open.length === 0) return null
  return tryPorts(open)
}

/**
 * Launch Gopeed exactly like double-clicking the icon: a detached process, no console window,
 * and the caller does not wait for it.
 *
 * Starting Gopeed is a WRITE action, so this is one of the two entry points that may be wrapped
 * by the optional sandbox seam. Diagnostics stay unconfined on purpose - see findProcess.
 *
 * @param {string} executablePath Absolute path of Gopeed.exe.
 * @param {object} [options]
 * @param {(argv: string[], purpose: string) => Promise<object>} [options.confine]
 *   Optional confinement runner; when omitted the executable is spawned directly.
 * @returns {Promise<{ok: boolean, pid: number, message: string, sandbox: object}>}
 *   On a sandbox refusal ok is false and nothing is spawned.
 */
export async function launchProcess(executablePath, options = {}) {
  const exe = String(executablePath || '').trim()
  if (!exe) {
    return { ok: false, pid: 0, message: 'no Gopeed executable path configured', sandbox: UNCONFINED_FACTS }
  }
  const plan = await planExecution([exe], 'launch', options?.confine)
  const facts = { ...plan.facts, sandboxed: plan.sandboxed }
  if (plan.blocked) {
    // The confiner's detail is already a complete sentence naming the refusal and
    // stating that nothing ran; do not wrap it in a second refusal phrase.
    return { ok: false, pid: 0, message: plan.message, sandbox: facts }
  }
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(plan.argv[0], plan.argv.slice(1), {
        // An unconfined launch keeps the historical detached spawn. A confined
        // launch must NOT detach: the Windows restricted-token runner shares
        // the caller console (a console-less child dies during DLL init), so
        // the runner stays attached and is unref'd once it has settled.
        detached: !plan.sandboxed,
        stdio: 'ignore',
        windowsHide: false,
        cwd: exe.replace(/[\\/][^\\/]+$/, '') || undefined,
      })
      const successMessage = plan.sandboxed
        ? `started ${exe} under the sandbox runner (runner pid ${child.pid}); the confined Gopeed pid is reported by gopeed_process`
        : `started ${exe} (pid ${child.pid})`
      child.once('error', (error) =>
        // No "launch failed:" prefix here: the caller already prefixes its own message, and two
        // prefixes produced "Launch failed: launch failed: ...".
        settle({ ok: false, pid: 0, message: String(error?.message || error), sandbox: facts }),
      )
      child.once('spawn', () => {
        if (!plan.sandboxed) {
          child.unref()
          settle({ ok: true, pid: child.pid || 0, message: successMessage, sandbox: facts })
          return
        }
        // The runner can fail before the wrapped command exists (bad args,
        // token/grant failure, spawn failure): it prints its signature to
        // stderr and exits 127. Never report a launch for a runner that is
        // already gone - give it a short grace window, then declare success.
        const grace = setTimeout(() => {
          child.unref()
          settle({ ok: true, pid: child.pid || 0, message: successMessage, sandbox: facts })
        }, 1500)
        grace.unref?.()
        child.once('exit', (code, signal) => {
          clearTimeout(grace)
          settle({
            ok: false,
            pid: 0,
            message:
              `the sandbox runner exited within 1.5s of starting (code ${code}${signal ? `, signal ${signal}` : ''}); ` +
              'Gopeed may not be running. Check gopeed_process before retrying',
            sandbox: facts,
          })
        })
      })
      // Fallback: never hang forever when neither error nor spawn fires.
      setTimeout(
        () => settle({ ok: false, pid: 0, message: 'launch timed out (no spawn event)', sandbox: facts }),
        5000,
      )
    } catch (error) {
      settle({ ok: false, pid: 0, message: error?.message || String(error), sandbox: facts })
    }
  })
}

/**
 * Wait until a pid is gone. `taskkill` without /F only posts a close message, and a desktop app
 * like Gopeed answers that by minimizing to the tray: the command succeeds while the process keeps
 * running. Treating that as "stopped" makes a restart launch a second instance and then report
 * success against the OLD process's API, so every stop must be confirmed by the process table.
 * @param {number} pid Target process.
 * @param {number} timeoutMs How long to wait.
 */
export async function waitForProcessExit(pid, timeoutMs = 6000) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) return { ok: false, verifiable: false, message: 'no usable pid' }
  const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : 6000)
  for (;;) {
    const current = await findProcess()
    if (current.probe !== 'ok') {
      return { ok: true, verifiable: false, message: 'process table unavailable; exit not verifiable' }
    }
    const stillThere = current.found && Number(current.pid) === target
    if (!stillThere) return { ok: true, verifiable: true, message: `pid ${target} exited` }
    if (Date.now() >= deadline) {
      return { ok: false, verifiable: true, message: `pid ${target} is still running` }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  }
}

/**
 * Stop the Gopeed process. Kill it outright: a soft `taskkill` only posts a close message, which a
 * desktop app turns into "hide to the tray", and the process survives while the command reports
 * success. Success here means the pid is actually gone.
 *
 * Stopping is the second WRITE action of this plugin, so the kill may be wrapped by the optional
 * sandbox seam. The confirmation probe below stays direct on purpose: it only reads the process
 * table, and a confined token often cannot see it.
 *
 * @param {number} pid Target process.
 * @param {object} [options]
 * @param {(argv: string[], purpose: string) => Promise<object>} [options.confine]
 *   Optional confinement runner; when omitted the kill runs directly.
 */
export async function stopProcess(pid, options = {}) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) {
    return { ok: false, message: 'no usable pid', sandbox: UNCONFINED_FACTS }
  }
  const plan = await planExecution(['taskkill', '/PID', String(target), '/F'], 'stop', options?.confine)
  const facts = { ...plan.facts, sandboxed: plan.sandboxed }
  if (plan.blocked) {
    return { ok: false, forced: true, message: plan.message, sandbox: facts }
  }
  const forced = await execCapture(plan.argv[0], plan.argv.slice(1), 5000)
  const exited = await waitForProcessExit(target, 5000)
  if (exited.ok) {
    return { ok: true, forced: true, message: `killed pid ${target}`, taskkill: forced.message, sandbox: facts }
  }
  // Last resort with node itself - only for an UNCONFINED attempt. When this
  // kill was supposed to run under the sandbox, a second unconfined kill would
  // bypass exactly the policy the caller asked for, so report the failure.
  if (!plan.sandboxed) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      /* fall through to the failure below */
    }
    const lastExit = await waitForProcessExit(target, 2000)
    if (lastExit.ok) {
      return { ok: true, forced: true, message: `sent SIGKILL to pid ${target}`, taskkill: forced.message, sandbox: facts }
    }
  }
  return {
    ok: false,
    forced: true,
    message: plan.sandboxed
      ? `pid ${target} did not exit after a confined taskkill (${exited.message}); the sandbox may have denied the kill. Stop Gopeed yourself, then retry`
      : `pid ${target} did not exit after a forced kill (${exited.message}). ` +
        'Gopeed may be running from another user or protected by security software; stop it yourself, then retry.',
    sandbox: facts,
  }
}

/**
 * Poll the API until it is ready or the wait budget runs out (used to confirm a launch).
 * @param {object} options Same as probeApi, plus `waitMs` total budget (default 10000).
 */
export async function waitForApi(options) {
  const deadline = Date.now() + (Number(options?.waitMs) > 0 ? Number(options.waitMs) : 10000)
  let last = await probeApi(options)
  while (Date.now() < deadline) {
    if (last.state === 'ok') return last
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700))
    last = await probeApi(options)
  }
  return last
}

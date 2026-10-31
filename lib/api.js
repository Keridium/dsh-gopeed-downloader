/**
 * Gopeed REST API client (no third-party dependencies, only Node's built-in fetch).
 *
 * Design notes:
 * - Only the loopback address is used (default 127.0.0.1:9999), authenticated with X-Api-Token.
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
import { existsSync } from 'node:fs'
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
    super(code === -1 ? String(msg) : `Gopeed API ${route} returned code=${code} msg=${msg || '(empty)'}`)
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
    const host = String(raw.host || '127.0.0.1').trim() || '127.0.0.1'
    const port = Number(raw.port) || 9999
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
    const { baseUrl: base, token, timeoutMs } = settings()
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
  const port = Number(options?.port) || 9999
  const token = String(options?.token ?? '')
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000
  const baseUrl = `http://${host}:${port}`
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
    if (response.status === 403 || payload?.code === 403) {
      return { state: 'unauthorized', latencyMs, baseUrl, detail: 'wrong token (HTTP 403)', version: '' }
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
  const processName = image.replace(/\.exe$/i, '').replace(/'/g, "''")
  const ps = await execCapture(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$([math]::Round($_.WorkingSet64/1MB,1))" }) -join ','`,
    ],
    8000,
  )
  if (ps.ok) {
    const text = String(ps.stdout).trim()
    if (!text)
      return { probe: 'ok', found: false, pid: 0, image, memoryMB: 0, detail: `process ${image} is not running` }
    const [pidText, memText] = text.split(',').filter(Boolean)[0].split('|')
    return {
      probe: 'ok',
      found: true,
      pid: Number(pidText) || 0,
      image,
      memoryMB: Number(memText) || 0,
      detail: `${image} is running (pid ${pidText})`,
    }
  }
  reasons.push(`powershell: ${ps.message || ps.code || 'failed'}`)

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
    if (existsSync(configured)) return { path: configured, source: 'configured path', tried }
    tried.push(`configured path does not exist: ${configured}`)
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
 * Launch Gopeed exactly like double-clicking the icon: a detached process, no console window,
 * and the caller does not wait for it.
 * @param {string} executablePath Absolute path of Gopeed.exe.
 */
export function launchProcess(executablePath) {
  const exe = String(executablePath || '').trim()
  if (!exe) return Promise.resolve({ ok: false, pid: 0, message: 'no Gopeed executable path configured' })
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(exe, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: exe.replace(/[\\/][^\\/]+$/, '') || undefined,
      })
      child.once('error', (error) => settle({ ok: false, pid: 0, message: error?.message || String(error) }))
      child.once('spawn', () => {
        child.unref()
        settle({ ok: true, pid: child.pid || 0, message: `started ${exe} (pid ${child.pid})` })
      })
      // Fallback: never hang forever when neither error nor spawn fires.
      setTimeout(() => settle({ ok: false, pid: 0, message: 'launch timed out (no spawn event)' }), 5000)
    } catch (error) {
      settle({ ok: false, pid: 0, message: error?.message || String(error) })
    }
  })
}

/**
 * Stop the Gopeed process. Softly first: taskkill without /F lets the window receive a close
 * message; if that fails, force it.
 * @param {number} pid Target process.
 */
export async function stopProcess(pid) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) return { ok: false, message: 'no usable pid' }
  const graceful = await execCapture('taskkill', ['/PID', String(target)], 5000)
  if (graceful.ok) return { ok: true, forced: false, message: `requested pid ${target} to close` }
  const forced = await execCapture('taskkill', ['/PID', String(target), '/F'], 5000)
  if (forced.ok) return { ok: true, forced: true, message: `force-killed pid ${target}` }
  // Last resort with node itself (some environments block taskkill by policy).
  try {
    process.kill(target)
    return { ok: true, forced: true, message: `sent a termination signal to pid ${target}` }
  } catch (error) {
    return {
      ok: false,
      forced: false,
      message: `cannot stop pid ${target}: ${forced.message || graceful.message || error?.message || 'unknown reason'}`,
    }
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

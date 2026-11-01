/**
 * Loopback webhook receiver for Gopeed push notifications (no DSH/cordis imports, plain node).
 *
 * Gopeed POSTs { event, time, payload: { task } } to the configured URL when a task finishes or
 * fails. This module listens on 127.0.0.1, validates that shape, and keeps the last 50 accepted
 * events in a ring buffer. It never touches Gopeed config: writing config is the caller's job and
 * belongs to an explicitly invoked tool (see index.js, applyWebhookConfig).
 *
 * Design notes:
 * - Binding 127.0.0.1 keeps the listener off the network; only the local Gopeed process can push.
 * - port 0 asks the OS for a free port; the real port is read back from server.address().port,
 *   because the configured 0 is not a port anything can dial.
 * - A port that is already taken fails loudly (EADDRINUSE) instead of pretending to listen.
 * - Bodies are capped at 256 KB and only POST /webhook is accepted: this port is also reachable
 *   by any other local process, so it must not become a memory sink.
 * - Every string here is plain ASCII: the tool output built from it is read by the model.
 */
import { createServer } from 'node:http'

/** Only route the receiver answers. */
export const WEBHOOK_PATH = '/webhook'

/** Ring buffer size: the most recent events kept in memory. */
export const MAX_EVENTS = 50

/** Hard cap on a single request body. */
export const MAX_BODY_BYTES = 256 * 1024

/** The only event types Gopeed emits. */
export const EVENT_TYPES = ['DOWNLOAD_DONE', 'DOWNLOAD_ERROR']

/** Lenient port normalization; anything unusable becomes 0 (let the OS choose). */
function normalizePort(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return 0
  return n
}

/**
 * Add our listener URL to a user's existing webhook URL list without dropping the others.
 * Order is preserved and duplicates are not introduced; a blank URL changes nothing.
 * @param {unknown} existing URLs currently stored in Gopeed config.
 * @param {string} url URL to add (for example http://127.0.0.1:12345/webhook).
 * @returns {string[]} New list.
 */
export function mergeWebhookUrls(existing, url) {
  const urls = Array.isArray(existing)
    ? existing.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : []
  const ours = typeof url === 'string' ? url.trim() : ''
  if (ours && !urls.includes(ours)) urls.push(ours)
  return urls
}

/**
 * Validate and flatten a raw Gopeed webhook body.
 * @param {unknown} body Parsed JSON body.
 * @returns {{ok: true, event: string, at: number, task: any} | {ok: false, reason: string}}
 */
export function normalizeWebhookBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body must be a JSON object' }
  }
  const event = typeof body.event === 'string' ? body.event.trim().toUpperCase() : ''
  if (!event) return { ok: false, reason: 'missing event' }
  if (!EVENT_TYPES.includes(event)) {
    return { ok: false, reason: `unsupported event: ${event} (expected ${EVENT_TYPES.join(' or ')})` }
  }
  const task = body.payload && typeof body.payload === 'object' ? body.payload.task : undefined
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return { ok: false, reason: 'missing payload.task' }
  }
  const rawTime = Number(body.time)
  const at = Number.isFinite(rawTime) && rawTime > 0 ? rawTime : Date.now()
  return { ok: true, event, at, task }
}

/**
 * Read a request body up to `limit` bytes without buffering more than that.
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {number} limit Byte cap.
 * @returns {Promise<{tooLarge: boolean, text: string}>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        // Keep consuming without storing: the connection still drains, memory stays bounded.
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ tooLarge, text: tooLarge ? '' : Buffer.concat(chunks).toString('utf8') }))
    req.on('error', reject)
  })
}

/**
 * Create a webhook receiver. It listens only while started.
 * @param {object} options
 * @param {number} [options.port] Loopback port; 0 (default) = OS-assigned free port.
 * @param {string} [options.host] Bind address; defaults to 127.0.0.1.
 * @param {(entry: object) => void} [options.onEvent] Called after an event is accepted and stored.
 */
export function createWebhookReceiver({ port = 0, host = '127.0.0.1', onEvent } = {}) {
  const requestedPort = normalizePort(port)
  const boundHost = String(host || '127.0.0.1')
  let server = null
  let boundPort = 0
  let state = 'stopped'
  let lastError = ''
  let starting = null
  /** Accepted events, oldest first; length never exceeds MAX_EVENTS. */
  const events = []
  /** Monotonic sequence per accepted event, used for unread tracking. */
  let seq = 0
  let readSeq = 0
  let received = 0

  /** Current listener URL, or '' when nothing is listening. */
  function urlOf() {
    return state === 'listening' && boundPort > 0 ? `http://${boundHost}:${boundPort}${WEBHOOK_PATH}` : ''
  }

  /** Public copy of a stored event (internal bookkeeping stays hidden). */
  function publicEvent(entry) {
    return {
      event: entry.event,
      at: entry.at,
      taskId: entry.taskId,
      name: entry.name,
      status: entry.status,
      path: entry.path,
      sizeBytes: entry.sizeBytes,
    }
  }

  /** Flatten a Gopeed task into the compact record the tool returns. */
  function toEvent(event, at, task) {
    const meta = task.meta && typeof task.meta === 'object' ? task.meta : {}
    const opts = meta.opts && typeof meta.opts === 'object' ? meta.opts : {}
    const res = meta.res && typeof meta.res === 'object' ? meta.res : {}
    const size = Number(res.size ?? task.size)
    return {
      event,
      at,
      taskId: String(task.id ?? ''),
      name: String(task.name ?? opts.name ?? ''),
      status: String(task.status ?? ''),
      path: typeof opts.path === 'string' ? opts.path : '',
      sizeBytes: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
    }
  }

  /** Append to the ring buffer, evicting the oldest entry. */
  function push(event, at, task) {
    const entry = toEvent(event, at, task)
    Object.defineProperty(entry, 'seq', { value: ++seq, enumerable: false })
    events.push(entry)
    while (events.length > MAX_EVENTS) events.shift()
    received += 1
    return entry
  }

  /** HTTP handler: one route, one method, one bounded body. */
  function handle(req, res) {
    const send = (status, payload) => {
      if (res.headersSent) return
      const text = JSON.stringify(payload)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
      })
      res.end(text)
    }
    const path = String(req.url || '').split('?')[0]
    if (path !== WEBHOOK_PATH) {
      send(404, { ok: false, error: 'not found' })
      return
    }
    if (req.method !== 'POST') {
      send(405, { ok: false, error: 'method not allowed; use POST' })
      return
    }
    readBody(req, MAX_BODY_BYTES)
      .then(({ tooLarge, text }) => {
        if (tooLarge) {
          send(413, { ok: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` })
          return
        }
        let body
        try {
          body = JSON.parse(text)
        } catch {
          send(400, { ok: false, error: 'body is not valid JSON' })
          return
        }
        const normalized = normalizeWebhookBody(body)
        if (!normalized.ok) {
          send(400, { ok: false, error: normalized.reason })
          return
        }
        const entry = push(normalized.event, normalized.at, normalized.task)
        try {
          if (typeof onEvent === 'function') onEvent(publicEvent(entry))
        } catch {
          // A failing observer must never turn an accepted event into an HTTP error.
        }
        send(200, { ok: true, event: entry.event, taskId: entry.taskId })
      })
      .catch((error) => {
        send(400, { ok: false, error: String(error?.message || error) })
      })
  }

  /**
   * Start listening (idempotent; concurrent calls share one attempt).
   * @returns {Promise<{ok: true, port: number, url: string} | {ok: false, reason: string, message: string}>}
   */
  function start() {
    if (state === 'listening' && server) {
      return Promise.resolve({ ok: true, port: boundPort, url: urlOf() })
    }
    if (starting) return starting
    state = 'starting'
    lastError = ''
    starting = new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        starting = null
        resolve(value)
      }
      const srv = createServer(handle)
      // A stalled client must not hold this socket open forever.
      srv.requestTimeout = 15000
      srv.headersTimeout = 10000
      srv.once('error', (error) => {
        const code = String(error?.code || error?.message || 'ERROR')
        state = 'error'
        lastError = code
        try {
          srv.close()
        } catch {
          // Already closed or never listening; nothing to release.
        }
        finish({
          ok: false,
          reason: code === 'EADDRINUSE' ? 'EADDRINUSE' : code,
          message: `cannot listen on ${boundHost}:${requestedPort}: ${code}`,
        })
      })
      srv.listen(requestedPort, boundHost, () => {
        server = srv
        boundPort = Number(srv.address()?.port) || 0
        state = 'listening'
        finish({ ok: true, port: boundPort, url: urlOf() })
      })
    })
    return starting
  }

  /**
   * Stop listening gracefully. Safe to call twice and safe to call before start.
   * @returns {Promise<{ok: true}>}
   */
  function stop() {
    const srv = server
    server = null
    state = 'stopped'
    boundPort = 0
    if (!srv) return Promise.resolve({ ok: true })
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve({ ok: true })
      }
      try {
        srv.close(finish)
        // Keep-alive connections would otherwise delay close indefinitely.
        srv.closeAllConnections?.()
      } catch {
        finish()
      }
      setTimeout(finish, 2000).unref?.()
    })
  }

  return {
    start,
    stop,
    /** 'stopped' | 'starting' | 'listening' | 'error'. */
    get status() {
      return state
    },
    /** Real bound port once listening; the requested port before that. */
    get port() {
      return boundPort > 0 ? boundPort : requestedPort
    },
    /** Listening URL, or '' when not listening. */
    get url() {
      return urlOf()
    },
    /** Configured port (0 when the OS chooses). */
    get requestedPort() {
      return requestedPort
    },
    /** Last listen error code, or ''. */
    get error() {
      return lastError
    },
    /** Total events accepted over this receiver lifetime (not limited by the ring buffer). */
    get received() {
      return received
    },
    /** Number of unread events currently retained. */
    unreadCount() {
      let count = 0
      for (const entry of events) if (entry.seq > readSeq) count += 1
      return count
    },
    /** Mark every retained event as read. */
    markRead() {
      readSeq = seq
      return readSeq
    },
    /**
     * Recent events, oldest first.
     * @param {{since?: number, unreadOnly?: boolean}} [options] `since` keeps events with
     *   at >= since (ms epoch); `unreadOnly` keeps events not yet marked read.
     */
    list(options) {
      const since = Number(options?.since)
      const unreadOnly = options?.unreadOnly === true
      return events
        .filter((entry) => {
          if (Number.isFinite(since) && since > 0 && entry.at < since) return false
          if (unreadOnly && entry.seq <= readSeq) return false
          return true
        })
        .map(publicEvent)
    },
  }
}

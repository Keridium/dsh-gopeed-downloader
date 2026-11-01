# Changelog

All notable changes to `dsh-gopeed-downloader` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries are English because
this file is part of the repository that both people and agents read; the Chinese edition of the
project README lives in [docs/README.zh.md](https://github.com/Keridium/dsh-gopeed-downloader/blob/main/docs/README.zh.md).

## [0.3.2] - 2026-11-01

### Fixed

- **The rename to `dsh-gopeed-downloader` broke the web client on startup.** Two constants in `client.js`
  still carried the old package name. The client-module loader requires the id passed to
  `__ModuleLoader__.load({ id })` to equal the package name, so every page boot reported the plugin as
  `not-registered` and the whole client half never loaded. The settings slot key is
  `${package}#${rowId}`, so the row would also have lost its configuration entry even after the module
  started loading. Both constants now use the new name.

### Changed

- **The notification and restart routes moved to `/api/dsh-gopeed-downloader/...`**, matching the package
  name that the client half and the documented URLs already used.
- **Version bumped in all three hand-written places**: `package.json`, `CLIENT_VERSION` in `client.js`
  and `FALLBACK_VERSION` in `index.js`. The published 0.3.1 assets were built before this fix, so every
  release up to 0.3.1 is marked pre-release.

### Notes

- The DOM ids, `htmlFor` targets and CSS class names still say `dsh-gopeed`. They are paired only inside
  `client.js`, so renaming them would mean touching nineteen coordinated places for no functional gain.

## [0.3.1] - 2026-11-01

### Fixed

- **The `workspace` download target saved into the directory the session was created in.** The target read
  `session.header.cwd`, which is the persisted creation-time directory and never moves, so after a
  `working_directory` call had moved the session (`cd`) the download still landed in the old project. It now
  asks the `workingDirectory` service for its running projection first (`Service.get(session)`: synchronous,
  folds the in-memory session log, no filesystem I/O) and falls back to `header.cwd` only when the host composes
  no such service. Measured in one session: `header.cwd` was `D:\path\to\project-a` while the
  `working-directory/change` event had already moved the session to `D:\path\to\project-b`, and
  the POST body's `opts.path` carries the second one after the fix. This is also the directory the
  `working_directory` tool reports and the one the filesystem tools resolve relative paths against.
- **A wrong token made `gopeed_launch` and the settings-page restart wait out the whole readiness budget.**
  The re-probe loop treated `unauthorized` as transient and checked its 15-second deadline only *after* a full
  detect-and-probe round, so a token that can never become right burned the budget and then produced a
  timeout-shaped failure. `unauthorized` is now terminal -- a 401 already proved something is listening there
  -- the deadline is checked before each round, and `waitForApi` in `lib/api.js` treats it as terminal too.
  Both call sites only branch on `ok`, so no contract changed. Measured on the same host: `gopeed_launch`
  17,621 ms / 6 rounds / 30 probes became 210-2,337 ms / 1 round / 2-5 probes, and a single `waitForApi`
  2,136 ms became 24 ms. The successful path did not regress (175 ms against 189 ms). The failure text no
  longer hardcodes "within 15s" and reports what actually happened: `last state: unauthorized after 210ms`.
- **`gopeed_add` could be killed by its own DSH tool timeout before it could explain anything.** The port
  probe had no bound of its own (about 32 seconds at worst: 4 s `tasklist`, 8 s `Get-Process`, 8 s
  `netstat`, 12 s `Get-NetTCPConnection`, plus up to 3 s per probed port), and the create request and its
  read-back were each allowed `Config.timeoutMs` (20,000 by default, 120,000 at the cap) -- far past the
  25-second tool timeout, at which point DSH ends the call and the tool never returns a result at all. The
  whole path now runs inside one 22.5-second internal budget derived from that timeout: the port phase gets a
  hard 12 seconds, the create request gets what is left minus a 3-second reserve, and the read-back gets the
  remainder. Per-call request timeouts come from a separate client instance, so one call's squeeze cannot
  affect another tool, and they only ever shorten the configured value, never extend it. Worst case is now
  22.5 seconds, under the 25-second tool timeout. Verified against a local TCP black hole with
  `Config.timeoutMs` at 120,000: the old code ran the full 120 seconds, the fixed one fails cleanly at
  21.0 seconds with a message that says what was submitted and what was not.

- **`gopeed_launch` started a second instance when the token was merely wrong.** It counted only an
  `ok` probe as "already running", so a 401 -- which proves a Gopeed is listening on that port --
  fell through to the launch path. The new process exited immediately because Gopeed is
  single-instance, and the tool then reported "Started Gopeed", which was false and hid the actual
  problem. `unauthorized` now counts as running, and the message says the token is wrong instead of
  claiming a start.

### Documentation

- **Development history now lives only in this file.** Thirty-two places across the README, the agent
  contract and the Chinese docs described what the code *used to* do -- "used to be", "is gone",
  "0.3.0 called it", the before/after footprint table with nine historical tool names. A rule whose
  only justification is "we got it wrong once" teaches the next reader nothing, so each one now states
  the current consequence. Eight code comments were rewritten the same way: "the old trailing check ran
  one more probe" became "a trailing check must not be used: it runs one more probe after the
  deadline".
- **Four statements no longer matched the code.** `FALLBACK_VERSION` still said 0.3.0 while the
  package is 0.3.1, so `gopeed_process` reported the wrong plugin version when it could not read the
  real one; `lib/api.js` still described a silent 9999 fallback port that the code no longer has;
  `lib/webhook.js` pointed at a function name that does not exist; `docs/GETTING-STARTED.md` was
  pinned to 0.3.0.
- **The Chinese README follows the same structure as the English one.** Nine numbered sections and the
  same eight collapsible blocks, while keeping the deeper material the English landing page does not
  carry: the twelve-field config table, the settings-form label mapping, the sandbox-versus-plugin
  table. Its agent hand-off now points at `docs/AGENTS.md`, where it used to point at the English
  README.
- **A Design notes section explains the tool shape.** One tool per HTTP endpoint, 1,452 characters in
  total and about 207 per tool. That is a deliberate deviation from the wider "one tool, many actions"
  style used elsewhere in the ecosystem, and the section also says where it stops being the right
  trade.

### Known limitations

- **The read-only tools still have an unbounded port phase behind the same tool timeout.** `gopeed_list`,
  `gopeed_status` and `gopeed_control` (25,000 ms) and `gopeed_process` (30,000 ms) still call
  `ensureApiPort()` unconditionally, so a cold Gopeed can trip the DSH tool timeout there too and end the call
  with no explanation. Only the write path (`gopeed_add`) got a budget this round, because a killed write
  risks an unaccounted download; a failed read is cheap to retry, so the same treatment is deferred.

## [0.3.0] - 2026-10-31

### Added

- **Download wake-up through DSH background jobs.** `gopeed_add` now registers the task it just created as a
  DSH background job (`kind: "gopeed"`, id `gopeed-<16 hex>`), which polls Gopeed every 3 seconds and settles
  when the download ends (`completed` with the file size, `failed` on a Gopeed `error` status or an unreachable
  API, `killed` when the task disappears). The settlement is consumed by DSH's `dsh-tool-jobs`, which emits its
  own in-session completion notice: a **busy** agent reads it in its next step, an **idle** agent is woken with a
  follow-up turn. This is the harness's notice, not plugin-authored user text -- the plugin never impersonates
  the user, and no chat bubble is drawn. It is the difference between this channel and the two older ones:
  `Agent.followup` (removed) would have opened a turn with a user-role message, and `Agent.inject` (kept as a
  fallback) queues context for the next step but cannot wake an idle agent.
- **`jobId` / `jobNote` on `gopeed_add`.** `jobId` names the tracking job, and the tool's own output points at
  `job_output <jobId>`, tells the agent **not to poll** for progress, and only suggests polling `gopeed_status`
  when no job could be started. They live in `output.schema` only, which DSH does not project into the system
  prompt, so these fields add **zero** prompt characters; `parameters` are unchanged.
- **A three-way download location policy.** Two new volatile settings decide where a `gopeed_add` download is
  saved: `downloadTarget` (`workspace` default / `gopeed` / `custom`) and `customDownloadPath`. An explicit
  `path` argument always wins, then the calling session's workspace directory (`session.header.cwd`), then
  `customDownloadPath`, otherwise the path is left unset and Gopeed uses its own configured download directory.
  A fallback is reported in `jobNote` rather than happening silently: an unresolvable workspace, or `custom`
  with an empty path, falls back to Gopeed's directory and says so.
- **`gopeed_add` reports the directory that was actually used.** After Gopeed accepts the task, the plugin reads
  it back once and takes `meta.opts.path`, so an add without `path` returns the real save directory instead of
  an empty string, and a derived name when none was supplied.
- **Optional plugin toast: `webhookToast`.** Off by default, because Gopeed already posts its own Windows
  notification and a second toast duplicates it. It gates the user-facing overlay only -- job wake-up,
  `Agent.inject` and the `gopeed_events` cache are unaffected.
- **Graceful degradation.** Without a `ctx.jobs` service, or without a controller serving the calling session,
  `gopeed_add` still works: `jobId` is `""` and `jobNote` says why no completion notice will arrive. A rejected
  job never fails the download.
- **Cancellation on removal.** `gopeed_control action: "remove"` cancels the tracking job, and a task reachable
  no longer (Gopeed answers `code: 1000`) converges the same way instead of polling to the cap.

### Changed

- **Three notification channels instead of two, with no duplicate delivery.** The overlay toast is still
  independent of the agent, but it is now opt-in (`webhookToast`, off by default). `Agent.inject`
  (`source: { kind: "dsh-gopeed-downloader" }`, no chat bubble) is now the **fallback**, used only for a completion no job
  covers -- a download started in the Gopeed UI or by another client, or any download on a host without
  `ctx.jobs`. A task a background job owns is deliberately **not** injected, because the job notice already
  carries the same completion and a real session showed the model reading it twice. `webhookNotify` now gates
  the inject fallback and the toast, while `webhookToast` gates the toast alone.
- **Tool descriptions state capability instead of terse fragments.** `gopeed_add`, `gopeed_list`,
  `gopeed_status`, `gopeed_process` and `gopeed_launch` were rewritten (for example `Create task.` became
  a one-line capability statement), taking the seven tool definitions from
  **1217 to 1339 characters** (+122). The job fields from 0.3.0 add nothing because they only live in
  `output.schema`. The README and `package.json` openers were also changed to describe capabilities and
  boundaries rather than "open the config page and enter the address and port".
- **The settings page no longer exposes API vocabulary.** The visible labels are now **Gopeed listen address /
  Port / Token** (the Chinese UI uses the equivalent translated labels); the token hint says "request header"
  instead of `X-Api-Token`; the restart success line says "Gopeed is ready" instead of "the Gopeed API is
  ready". The fields are still the same settings.
- **The webhook block is a collapsed drawer.** It starts collapsed and its summary line shows the current mode;
  the duty note stays visible and states plainly that wake-up is handled by a DSH background task and does not
  depend on the webhook. `webhookPort` is shown only for `manual`, and the toast switch sits inside the drawer.
- **Gopeed attribution.** The READMEs now state that this is an independent, unofficial integration, that
  Gopeed is GPL-3.0, and that no Gopeed code is bundled, linked or redistributed.
- **Paused tasks are polled slowly.** A task in `pause` or `wait` is polled every 30 seconds instead of every 3,
  and those reads are counted against their own budget, not the moving-download one.
- **Version badges report 0.3.0.** The browser bundle constant and the packaged `version` moved together, so the
  settings-page badge still matches `gopeed_process.pluginVersion` and does not tell users to restart DSH for no
  reason.
- **A failed call now says what a wrong token means.** Gopeed answers `code=1001 msg=unauthorized`, which
  names neither the cause nor the fix, so a `gopeed_add` against a mis-set token produced one opaque line.
  `GopeedApiError` now appends "-- the token is wrong; set it in the plugin settings (gopeed_process explains
  it)" for 401, 403, 1001 and for any message that mentions unauthorized or forbidden. Task-gone (1000) and
  transport failures (-1) are untouched, because their wording is already actionable.
- **Five user-facing string sites still said "API".** The project keeps that word out of anything a person or a
  model reads, but the task-error envelope still said `Gopeed API /api/v1/tasks returned ...`, the "port unknown"
  error said `the API port is unknown`, the `apiLatencyMs` and `apiDetail` output-schema descriptions said "API
  latency" and "API probe", and one diagnosis line in `gopeed_process` said `the verdict relies on the API`. They
  now say `Gopeed <route> returned ...`, "listen port", "Endpoint latency" / "Endpoint probe" and "HTTP probe".
  Found by a blind test that only saw the tool definitions and the resulting error text.
- **`gopeed_add.path` says what happens when it is omitted.** The parameter description was `Save dir`,
  which named the unit but not the consequence: a model reading only the tool definition had no way to know
  that leaving `path` out uses the configured save location, or that passing it wins over that setting. It is
  now `Save dir (omit = use the configured location)` (+37 characters). This matters because the tool
  definition is usually the only thing an agent reads -- the full precedence order lives in
  `docs/AGENTS.md`, which a model calling the tool does not necessarily open. Its sibling `name` gained
  `File name (optional)` for the same reason (+37 characters), so a model reading only the schema knows a
  file name is optional and that omitting it is safe.
- **The settings form now states every default and what an empty field means.** Each hint leads with the real
  default from the `Config` schema: save location `Workspace`, host `127.0.0.1` (and required), port `0` =
  auto-detect, token empty = nothing sent, executable path empty = auto-detect, webhook port `0` = system-assigned.
  The custom path field gained a permanent hint plus an `Empty = Gopeed default directory` placeholder, because
  emptying it used to save fine and then quietly download into Gopeed's own directory. The port fields also say
  that an empty box is rejected on save, so auto-detect means typing `0`, not clearing the field; the token hint
  says empty keeps the stored token unchanged. Both dictionaries changed together.
- **The webhook auto mode says "save", not "write".** "Write" was not understood as an action a user takes, so
  every user-facing string about the automatic webhook configuration now says "save" (the Chinese strings use
  the equivalent verb): the mode hint, the
  drawer note, the restart warning, the runtime messages (`nothing was saved`, `Saving Gopeed config failed`) and
  the same wording in both READMEs. Nothing about the mechanism changed -- the plugin still PUTs the address into
  Gopeed's configuration and Gopeed still applies it only on a full restart.
- **`gopeed_events` reads better.** `Events; apply saves webhook config.` became
  `Events; action=apply saves the webhook config.` (+10 characters), naming the parameter value so the sentence
  parses.
- **`gopeed_add` says the job runs in the background.** Its description is now
  `Download a URL through Gopeed. Returns a background job that notifies when it ends.` (+29 characters), and the
  output note says the job *runs in the background*, to *not poll and not wait*, and to read the result *after
  the notice* -- the previous "Read it with job_output" read like an instruction to block on it.

### Fixed

- **A paused download could be reported as failed.** A task that stayed `pause` / `wait` used to consume the
  full-speed poll budget and settle as `failed` after 24 hours, although nothing had failed. Stalled tasks now
  settle as `killed` with an explicit "task still pause, download NOT cancelled" detail, keeping `failed` for an
  unreachable API or a Gopeed `error` status.
- **A plugin reload reported downloads as failed.** Unloading cancels every tracker, and the settled jobs said
  only "cancelled", which reads like the download died. The detail now states that the plugin unloaded, that the
  download state is unknown, and that the Gopeed task may still be running. DSH's job outcome vocabulary has no
  "unknown" status and offers no way for a producer to settle silently (it skips only `cause: "teardown"`, which
  belongs to owner/service disposal), so the detail carries the truth. A DSH **restart** still loses tracking
  entirely; that is documented in Known limitations rather than papered over.
- **The terminal detail repeated its own reason.** A `kill()` forwards the reason to the producer, and the
  registry appends it again, so the detail read "removed by gopeed_control; removed by gopeed_control". The
  producer now contributes a generic detail on that path and the reason appears once.
- **`gopeed_add` echoed the caller's path instead of the real one.** An add without `path` reported an empty
  save directory even though Gopeed had already filled `meta.opts.path` with its configured download directory,
  so the agent could not say where the file went. The task is now read back and the resolved directory reported.
- **`gopeed_launch` could report a freshly started Gopeed as not ready.** It probed one port for the whole
  readiness budget, but a newly started desktop Gopeed comes up on a new random port that only exists once the
  process listens, so a successful launch was reported as a failure. Detection and probing now run in a loop for
  up to 15 seconds, the same fix the restart path already had.
- **Setup guidance blamed a missing install for a crashed program.** `SETUP_GUIDE` and `SETUP_NOTICE` said
  "install Gopeed" even when Gopeed was installed but closed or crashed; both now say to start it first and to
  install only when it is really absent.
- **A pasted `host:port` or URL failed with a misleading error.** The `host` field had no format check, so
  the two shapes people actually paste -- `127.0.0.1:9999` and `http://127.0.0.1` -- became
  `http://127.0.0.1:9999:9999` (ERR_INVALID_URL) or `http://http://127.0.0.1:9999` (a DNS lookup of the name
  "http"), and the failure surfaced as "cannot reach Gopeed; check host/port". Both are now rejected up front
  with a message saying to put the address in `host` and the number in `port`; a bare IPv6 literal is told to
  use brackets.
- **`exePath` accepted a directory or any file.** A plain `existsSync` treated `C:\Windows` or a `.ini` as a
  valid executable, which skipped the auto-discovery that would have found the real Gopeed and then failed
  with a raw `spawn ENOENT`/`EFTYPE`. Only a real `.exe` file now counts as configured, so a wrong path falls
  back to discovery.
- **`Launch failed: launch failed: ...`** -- the producer's message carried its own prefix on top of the
  caller's. The prefix now lives in one place.
- **A wrong token was reported as a generic error instead of as a wrong token.** Gopeed 1.9.3 answers HTTP
  401 when the token is wrong; the probe only treated 403 as `unauthorized` and let 401 fall through to
  `error`. That broke two things: `gopeed_process` could not reach its `unauthorized` verdict, so the advice
  pointed at the port rather than the token, and `discoverApiPort` -- which deliberately keeps a port whose
  probe says `unauthorized`, because that proves a Gopeed is listening there -- gave up on the one port that
  was actually right. Both status codes now map to `unauthorized`.

### Documentation

- README gained **Download wake-up (background jobs)** and **Where a download is saved**, and the notification
  section became **Three notification channels, none in the conversation**; `docs/README.zh.md` mirrors all of
  them. Known limitations gained the "tracking does not survive a DSH restart" entry.
- **BT / magnet is documented as lightly tested.** A Debian 13.7 netinst ISO magnet was verified end to end:
  metadata resolved to 756 MB, the transfer started at about 4 MB/s, and the tracking job followed it. Harder
  cases (no peers, DHT-only discovery, a private tracker, resuming after a restart) are still unverified, and
  the limitation says so instead of claiming full support.
- `docs/GETTING-STARTED.md` was updated for the new fields: the **download location** dropdown sits above the
  listen address, the address field is **Gopeed listen address** and takes only the IP, and the three save
  targets are explained.
- **Config-only fields are now labelled as such.** `timeoutMs`, `portScan` and `webhookNotify` exist in the
  schema but the custom settings form does not render controls for them; the docs earlier implied they were on
  the page. They are now marked config-only, with `cordis.patch.yml` (`id: gopeed`) named as where to set them.
  This was a documentation bug, not a code change.
- **The README states which link types work.** Direct HTTP/HTTPS links, magnet links and remote `.torrent`
  URLs all work; a local `.torrent` file does not, because the plugin has no upload path -- pass the URL it
  came from. BitTorrent detail (peers, DHT, trackers, seeding) stays with Gopeed, which is worth saying because
  "downloader" otherwise suggests the plugin manages the transfer itself.
- **The documentation is split in two, and the README is a landing page again.** `README.md` keeps the first
  screen -- what the plugin is, what it cannot do, installation, the settings defaults and the numbered
  known limitations -- and folds the design argument, the prompt-footprint measurement, the implementation
  notes and the development instructions into `<details>` blocks, so the repository page can be skimmed at a
  glance instead of at 500 lines. The agent-facing material moved to a new **`docs/AGENTS.md`**: the tool
  table with the result fields DSH validates, the do-not-poll rule, the save-location order, an error
  playbook and an explicit do-not list. `README.md` points at it in a notice at the top rather than
  repeating it. It deliberately stays in `docs/` and out of the published `files`, because it is written for
  a model reading the repository, not for the installed plugin; `README.md` links to it on GitHub. No
  behaviour, no tool definition and no prompt character changed.
- **Prompt footprint re-measured: 1339 to 1452 characters** (+113: the two descriptions above, plus 37 for
  the save-directory hint and 37 for the file-name hint). The figure previously recorded in this entry as
  1343 was 4 characters high because `gopeed_process` measured 114 instead of its real 110; every baseline
  is now taken from a fresh measurement of the loaded tools.

## [0.2.1] - 2026-10-31

### Fixed

- **The config-page "Restart Gopeed" button was killed by the sandbox.** That route has no agent
  session, so the policy resolved to the deployment default (`workspace-write`) and `taskkill` was
  wrapped in a restricted token, which cannot end a same-user process: the button always failed with
  `the sandbox may have denied the kill`. The button is a user gesture, not an agent action, so it now
  runs unconfined and reports that honestly (`launchSandboxed: false`, `sandboxMode: ""`,
  `sandboxDetail` saying it was user-triggered). `gopeed_launch` keeps using the calling session's
  policy.
- **A successful restart reported failure.** Gopeed returns on a new random port, and the port was
  detected once, immediately after launch -- before the relaunched process started listening. The
  plugin then probed that stale port for the full budget and reported
  `its API was not ready within 10s` although the restart had worked. Detection and probing now run
  in a loop for up to 15 seconds, switching to the newly detected port as soon as it appears.

### Changed

- The README sandbox table now states that only `gopeed_launch` is confined, and that the restart
  button is a user action.

## [0.2.0] - 2026-10-31

### Added

- **Download-complete push, in three modes.** Gopeed can POST `DOWNLOAD_DONE` / `DOWNLOAD_ERROR` to a
  URL; the plugin now runs a loopback listener for it. `webhookMode` selects the behaviour:
  - `off` (default) - no listener, nothing is opened on the machine
  - `manual` - the plugin listens and shows the exact URL to add in Gopeed
    (Settings -> Developer -> Webhook push). The plugin never saves Gopeed's settings; note that
    Gopeed also has an **"Enable webhook" switch** there, and an address alone sends nothing.
  - `auto` - same listener, plus `gopeed_events action=apply`, which saves the URL into Gopeed's
    config after reading it, preserving any URLs you already had and verifying the result by reading
    the config back.
- **Two notification channels, neither of which writes a chat message.** A finished download produces
  a bottom-right toast rendered by the plugin's own client half (fed by an authenticated
  `GET /api/dsh-gopeed-downloader/notifications` route), and the same summary is handed to the agent as
  model-facing context (`Agent.inject`, which does not wake the driver). `webhookNotify` (default on)
  controls both.
- **`webhookPort`** - `0` lets the system pick a free port; the settings form has a random-port button
  for people who want a reproducible number. A fixed port is what makes the URL stable across DSH
  restarts, which matters in `manual` mode where you paste it into Gopeed once.
- **`gopeed_events` tool** - reads the events the listener collected (`since`, `unreadOnly`), and in
  `auto` mode `action=apply` saves the webhook config. Events are kept in a 50-entry ring buffer in
  memory and marked read once returned.
- **Sandbox strategy: act confined, look unconfined, and say which.** Starting or stopping Gopeed
  (`gopeed_launch`, the Restart button) now runs through `ctx.sandbox.confine` under the session's
  file policy, while read-only diagnosis (process and port probing) stays direct, because a confined
  shell often cannot see other processes at all. Every result states which happened:
  `launchSandboxed` / `sandboxMode` / `sandboxDetail` on launch and restart, and
  `diagnosticsSandboxed` / `diagnosticsSandboxNote` on `gopeed_process`. A policy refusal
  (`SANDBOX_UNAVAILABLE`) stops the action and says so; the plugin never silently runs unconfined.
- **"Restart Gopeed" button on the settings page** - the only restart path. It saves the webhook
  config first, then **force-kills** the process, waits for it to actually exit, relaunches it, and
  waits for the API to answer. It is destructive (interrupts running downloads) so it sits behind
  `window.confirm`.
- **`pluginVersion`** in `gopeed_process`, plus a version badge on the settings page. The browser half
  of a plugin is only loaded at DSH startup, so after an update the badge is how you tell whether the
  UI you are looking at is the new one.

### Fixed

- **A restart that reported success without restarting anything.** `taskkill` without `/F` only posts a
  close message, and Gopeed answers that by **minimizing to the tray** - the process survives while
  the command exits 0. The plugin then launched a second instance (which exits on its own, Gopeed
  being single-instance) and probed the API of the *original* process, so it reported
  `restarted: true`. Stopping now force-kills and is only successful once the pid is actually gone
  from the process table.
- **`gopeed_launch` no longer starts a second Gopeed instance.** It probed the raw configured port,
  which is `0` under the auto-detect default, concluded "not running", and launched anyway. It now
  probes the resolved port.
- **The silent `9999` fallback is gone.** `Number(port) || 9999` turned `0` into `9999`, so
  auto-detection failures quietly probed port 9999 and the "port unknown" diagnostics were
  unreachable. An unresolved port is now reported as unknown, and you are asked to enter the port
  Gopeed shows.
- **A process probe that could report "not running" when it simply could not see.** PowerShell's
  `Get-Process` exits 0 with an empty list when its token cannot see other processes, which used to be
  indistinguishable from "no Gopeed process exists". The command now also checks whether PowerShell
  can see its own process; if it cannot, the probe reports `unavailable` instead of claiming a
  negative. `gopeed_process` likewise reports `verdict: unknown` rather than `stopped` when the
  process table is unreadable.

### Changed

- **The plugin no longer posts messages into the conversation.** Both earlier mechanisms
  (`Agent.followup` and `ToolRunContext.deferContext`) delivered plugin output as a `role: 'user'`
  message, i.e. it looked like the user said it. Both are removed; guidance now travels inside the
  tool's own output, and download notices use the toast and `inject` channels above.
- **No agent tool can restart or kill Gopeed.** `gopeed_events` accepts only `apply`, and
  `gopeed_launch` no longer has a `restart` parameter. Killing a process is a user action, reachable
  only from the settings-page button.
- **No default port is claimed anywhere.** The port is auto-detected by default; any concrete number
  in the documentation (such as `9999`) is only an example, and the plugin never guesses one.

## [0.1.1] - 2026-10-31

### Added

- **Automatic port detection.** Gopeed's desktop build listens on `127.0.0.1:0`, so the port changes
  on every launch. With `port` at `0` the plugin reads the ports the running process holds
  (`netstat -ano`, then `Get-NetTCPConnection`) and probes `/api/v1/info` on each candidate. Detecting
  the port from the process's *connections* rather than its `LISTENING` rows is what makes this work
  under a restricted token.
- **`misconfigured` verdict.** A refused connection while the process is confirmed alive now reports
  "running but wrong port" with guidance, instead of the misleading "not running, launch it".
- **`portScan`** (opt-in, default off) - sweeps the local dynamic port range when Windows will not
  disclose the process sockets. Off by default because it touches unrelated software.

### Changed

- **`token` defaults to empty**, matching Gopeed's factory state (an empty token means no auth).
- Documentation corrected on three points: `9999` / `deepseek` are not Gopeed defaults; Gopeed 1.9.3
  offers only TCP and Unix socket (no HTTP); and there is no "enable API" switch - the API is on by
  default.

### Fixed

- Executable discovery now tries the default install path before anything else, and reports which
  source the path came from.

## [0.1.0] - 2026-10-31

### Added

- Initial release: a Cordis bundle that exposes a local Gopeed downloader as agent tools.
- Six tools: `gopeed_add`, `gopeed_list`, `gopeed_status`, `gopeed_control`
  (`pause` / `resume` / `remove`), `gopeed_process`, `gopeed_launch`.
- Settings page for API host, port, token, request timeout and an optional executable path.
- One-time setup notice appended to the conversation (`ToolRunContext.deferContext`) when Gopeed
  cannot be reached, so a first-time user is told what to install and configure without reading the
  documentation first.
- Model-facing tool definitions kept small (about 1 KB of system prompt for all tools) with English
  descriptions and English runtime text.

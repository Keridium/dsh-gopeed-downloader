# dsh-gopeed

English | [Chinese](docs/README.zh.md)

Turn a local **[Gopeed](https://gopeed.com/)** downloader into agent tools inside **DeepSeek Harness (DSH)**, with a settings page for the API host, port and token.

Downloads never pass through the model or a shell: the agent hands a URL to Gopeed over its loopback REST API (the port is auto-detected from the running process by default, and a token is sent as the `X-Api-Token` header when one is set), and Gopeed owns all outbound traffic and the files on disk.

> **The port is auto-detected; there is no default port to memorise.** The Windows desktop build of Gopeed ships
> with address `127.0.0.1:0` -- port **0**, meaning a random port on every launch -- and an empty token. Leave the
> plugin's `port` at `0` and it reads the live port from the running process; or pin a fixed port in Gopeed
> (Settings -> Advanced -> Protocol) and enter the same number here. Any concrete number in this README (such as
> `9999`) is only an example. See [Configuration](#configuration).

`dsh-gopeed` is a [Cordis](https://github.com/deepseek-ai/deepseek-harness) bundle: a host half that registers seven tools, plus a web half that renders the configuration form and the download toasts.

## Features

- **Seven tools** -- `gopeed_add`, `gopeed_list`, `gopeed_status`, `gopeed_control` (pause / resume / remove through an `action` enum), `gopeed_process` (is Gopeed alive, stuck or misconfigured -- also reports the version and webhook status), `gopeed_launch` (start it if it is not running), and `gopeed_events` (read the download-complete events Gopeed pushed, or write the webhook config in `auto` mode). No tool can restart or kill Gopeed.
- **Small system-prompt footprint** -- the model-facing `{name, description, parameters}` of all seven tools is 1217 characters (roughly 305 tokens at about 4 characters per token), down from 2714 across nine tools. See [System-prompt footprint](#system-prompt-footprint).
- **Settings page in the DSH Web UI** -- host, port, token, request timeout, an optional executable path, the port scan switch and the three webhook fields. Every field is *volatile*: saving applies immediately, with no plugin remount and no DSH restart. The token is a secret field, so the browser only ever sees "set" / "not set", never the value back. A version badge shows the loaded browser bundle next to the backend version reported by `gopeed_process`.
- **Download-complete notifications** -- Gopeed pushes `DOWNLOAD_DONE` / `DOWNLOAD_ERROR` to a loopback listener, which feeds a bottom-right toast and a one-line context note for the agent. Neither channel writes a chat message, and neither wakes an idle agent. See [Download notifications](#download-notifications-webhook).
- **One restart path, and it belongs to the user** -- the red **Restart Gopeed** button on the settings page. It force-kills the process, waits until the pid is really gone, starts Gopeed again and waits for its API. It does not touch the webhook config. No agent tool can reach it.
- **Honest diagnostics instead of guesses** -- `gopeed_process` returns one of `running`, `unresponsive`, `misconfigured`, `stopped`, `unauthorized` or `unknown`, and never reports "not running" when the process probe itself was blocked.
- **Reachable without reading docs** -- when a tool hits a connection, timeout or token failure, it appends a one-time setup notice to **its own output** (see [Guiding the user](#guiding-the-user)), instead of assuming anyone opened this file. Nothing is ever posted into the conversation on the user's behalf.
- **Normalized tasks** -- one flat shape with `percent`, `sizeKnown`, speed and directory, so a task of unknown total size is never rendered as "0%".

## Language policy

The split is deliberate, and worth knowing before editing any string:

- **The plugin itself carries no Chinese.** Every string inside `index.js` and `lib/` is English:
  tool names, tool and parameter descriptions, output-schema field descriptions, `render()` output,
  `message` / `advice` / error text, the webhook event text, code comments, and the one-time setup
  notice appended to a tool's output. Tool descriptions sit in the system prompt on every turn,
  which is also why they are kept terse.
- **Chinese lives only in the docs** -- [docs/README.zh.md](docs/README.zh.md) and
  [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) are written for Chinese-speaking humans.
  They are reading material, not agent input.
- **One deliberate exception**: `client.js` ships a `zh` / `en` dictionary for the settings
  form and the toasts, because that interface is read by the person configuring the plugin. It is
  UI copy, not documentation.

When editing a string, ask who reads it: model context -> English; a human in the Web UI or on
GitHub -> follow the row above.

## Requirements

- **DSH**, installed and running, with a profile that can install bundles (the `plugin_manager` tool, or the Web **Plugins** page).
- **[Gopeed](https://gopeed.com/) 1.9.3 or newer**, with its REST API reachable on `host:port`. Verified against Gopeed 1.9.3.
- **No Node.js, npm or pnpm is needed on your machine to *run* this plugin.** It is a Cordis plugin executing inside the DSH host process on DSH's own runtime, and it never shells out to `node`, `npm`, `npx` or `pnpm`.
- **Windows PowerShell 5.1 is enough** -- the process helpers only call `tasklist`, `taskkill`, `powershell.exe`, `netstat` and `netsh`, all shipped with Windows; `pwsh` 7 is not required.
- `gopeed_process`, `gopeed_launch`, the restart button and executable auto-discovery are **Windows-only**. The REST tools work wherever Gopeed runs.
- The webhook listener (when enabled) binds `127.0.0.1` on a local port only. It needs no inbound internet access and no firewall rule.

## Installation

There is nothing to `pnpm add` by hand. Ask the agent, in any DSH session:

> Install the `dsh-gopeed` bundle from its Git URL.

That maps to `plugin_manager` with `action: "install_bundle"` and the repository URL as `target`. DSH parses the spec, checks reachability, installs it through its own package manager, then enables the bundle. Restart DSH when it asks you to. Uninstall with `action: "remove_bundle"` and `target: "dsh-gopeed"`, then restart. The Web UI equivalent of both is **Plugins -> Installed**.

### Accepted `target` forms

Read from the DSH source (`@deepseek-ai/dsh-plugin-manager`), so the list is exhaustive:

| `target` | Accepted | Notes |
|---|---|---|
| `github:owner/repo` | yes | pnpm's Git host shorthand. |
| `git+https://github.com/owner/repo.git` | yes | Standard Git URL; `git+` is stripped before the reachability check. |
| `https://github.com/owner/repo` | yes | A hosted-repository URL is treated as a Git spec, not a plain web URL. |
| `github:owner/repo#v0.1.1` | yes | Pin a tag or commit after `#`. |
| `https://.../repo/archive/refs/tags/v0.1.1.tar.gz` | yes | A `.tgz` / `.tar.gz` URL is a tarball spec and skips Git entirely. |
| `D:\path\to\dsh-plugin-gopeed` | yes | An **absolute** local directory (development installs). |
| a relative path | **no** | Refused: "a local path must be absolute". |

For GitHub Git specs the manager runs `git ls-remote` (5 s default) before installing, and only a network failure or timeout aborts it. **So `git` must be installed for a Git-URL install**; with no `git`, install from a release tarball URL instead. A package installed from a Git URL is checked against its DSH version requirements only after installation, because its manifest is not known earlier.

Installing an absolute directory records a `link:` dependency, so the profile's `node_modules/dsh-gopeed` is a junction back to your working tree and source edits are picked up on restart. See [Development](#development) for the one extra step link installs need.

## Configuration

Open the sidebar **Plugins -> Installed -> Gopeed Downloader -> row `gopeed` -> Configure**.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `host` | string | `127.0.0.1` | Listen address from Gopeed -> Settings -> Advanced -> Protocol (TCP). |
| `port` | number | `0` | `0` = auto-detect: ask Windows which port the running Gopeed process holds. Set a number only to pin one, and pin the same fixed port in Gopeed first (see below). |
| `token` | string (secret) | *(empty)* | Gopeed ships with an empty token (= auth disabled), so the default matches. If you set one in Gopeed, enter the identical value here. |
| `timeoutMs` | number | `20000` | Per-request HTTP timeout, in milliseconds. |
| `exePath` | string | *(empty)* | Leave blank in almost every case; only portable or non-standard installs need it. See [Launching Gopeed](#launching-gopeed). |
| `portScan` | boolean | `false` | Off by default. When enabled, the plugin may sweep the local dynamic port range to find Gopeed when Windows refuses to reveal another process's sockets. That touches ports owned by unrelated software, so it is opt-in only. |
| `webhookMode` | enum `off` / `manual` / `auto` | `off` | Download-complete push. `off` listens on no port; `manual` listens and shows the URL you add in Gopeed yourself; `auto` listens too, and lets `gopeed_events action=apply` write that URL into Gopeed's config. See [Download notifications](#download-notifications-webhook). |
| `webhookPort` | number | `0` | Loopback port for `manual` / `auto`, range 0-65535. `0` = the system picks a free port (the URL then changes across restarts); a concrete number keeps the URL stable, which is what makes a one-time paste into Gopeed work. |
| `webhookNotify` | boolean | `true` | When a download finishes, show the bottom-right toast and queue one line of context for the agent. Needs `manual` or `auto`. It never posts into the chat and never wakes an idle agent; set it to `false` to keep events cache-only. |

### The port: pin it in Gopeed, or let the plugin detect it

Gopeed 1.9.3 (Windows desktop) starts its REST API on **`127.0.0.1:0`** -- port **0**, i.e. a random port that
changes on every launch and cannot be discovered from outside. The API is on by default and there is no
"enable API" switch. Two ways to reach it:

- **Leave `port` at `0` (the plugin default).** The plugin asks Windows which port the live `Gopeed.exe` holds and
  retries when the API was first probed on a stale value. Nothing to configure, unless Windows hides the sockets
  (then `portScan`, described under [Diagnostics and launching](#diagnostics-and-launching)).
- **Pin a fixed port** (recommended if the automatic route fails):
  1. In Gopeed open **Settings -> Advanced -> Protocol**. The choices are **TCP** (or Unix socket on Linux/macOS/Android);
     there is no HTTP option.
  2. Set the address to a fixed value such as **`127.0.0.1:9999`**.
  3. Set an API token if you want auth (the field is empty by default), and enter the same value in the plugin form.

Source of these defaults, for the record: `app_controller.dart#L476-L491` hardcodes
`network="tcp"`, `address="127.0.0.1:0"`, `apiToken=""`, and `pkg/rest/server.go#L189` binds it with
`net.Listen`. The `9999` in Gopeed's OpenAPI document and JS SDK is a **client-side convention** (the CLI/`gopeed-web`
build defaults `-P` to 9999); the desktop app itself never listens there unless you set it.

A live "request base URL" preview shows `http://host:port` above the form. Saving writes the values into the current profile's `cordis.patch.yml` under `id: gopeed` and takes effect immediately. An empty token field does **not** clear the stored token -- it keeps the previous value, so retype the token whenever you are unsure.

## Tools

| Tool | Parameters | Returns | Purpose |
|---|---|---|---|
| `gopeed_add` | `url` (required), `path`, `name` | `taskId`, `url`, `name`, `path`, `baseUrl` | Create a download task. `path` is the save directory; `name` is an optional display name (Gopeed otherwise derives one from the URL). |
| `gopeed_list` | `status` (optional: `ready`/`running`/`pause`/`wait`/`error`/`done`) | `count` + normalized task array | List all tasks, optionally filtered. |
| `gopeed_status` | `id` | one normalized task | Progress of a single task. |
| `gopeed_control` | `id` + `action` (`pause`/`resume`/`remove`), optional `force` | `{ ok, id, action, status, message }` | Pause, resume or delete. |
| `gopeed_process` | none | plugin version, verdict, API probe, pid, memory, version, executable path, webhook status, advice | Process **and** API diagnosis; also the connectivity/version check. |
| `gopeed_launch` | none (`{}`) | `{ launched, alreadyRunning, pid, apiState, message }` | Start Gopeed if it is not running. It cannot restart or kill it. |
| `gopeed_events` | `since` (optional timestamp), `unreadOnly` (optional boolean), `action` (`apply` only) | `mode`, `listener`, `count`, `unread`, `events[]`, `applied`, `message` | Read buffered `DOWNLOAD_DONE` / `DOWNLOAD_ERROR` events; in `auto` mode, `action: "apply"` writes the listener URL into Gopeed's config. |

**`gopeed_control`'s `force` defaults to `true`** for `remove`, which deletes the downloaded files along with the task. Pass `force: false` explicitly to keep the files.

**`gopeed_launch` has no parameters.** Starting Gopeed is safe to expose to an agent; killing it is not. Restarting is a user action with its own button (see [Restarting Gopeed](#restarting-gopeed)).

A normalized task looks like this:

```json
{ "id": "0n37...", "name": "a.iso", "status": "running", "protocol": "http",
  "sizeBytes": 11857955, "downloadedBytes": 4200000, "percent": 35.4,
  "sizeKnown": true, "speedBytesPerSec": 1048576,
  "path": "D:\\Downloads", "createdAt": "..." }
```

## Download notifications (webhook)

Gopeed can **POST** an event to a URL when a task finishes or fails. This is push, not polling: Gopeed sends
`DOWNLOAD_DONE` / `DOWNLOAD_ERROR`; the plugin never guesses that a download ended.

Three modes, selected by `webhookMode`:

| Mode | Listener | Who registers the URL in Gopeed |
|---|---|---|
| `off` (default) | none -- no port is opened | nobody; poll with `gopeed_list` / `gopeed_status` |
| `manual` | yes, on `127.0.0.1:<webhookPort>` | **you**, by hand, in Gopeed |
| `auto` | yes, on the same listener | `gopeed_events action=apply`, on your explicit request |

The listener URL always has the form `http://127.0.0.1:<port>/webhook`, and the listener binds `127.0.0.1`
only.

### `manual` mode: two steps in Gopeed, not one

The settings page shows the full URL and a copy button when `webhookPort` is above `0`. With `webhookPort: 0`
the page shows no address at all -- the port is system-assigned, and it tells you to read the real URL from
`gopeed_events` after saving; enter a concrete port if you want a copyable, stable URL.

In Gopeed open **Settings -> Developer -> Webhook push** and do **both** of these:

1. Turn the **"Enable webhook"** switch **on**.
2. Click **"Add"** and paste the listener URL.

**An address alone sends nothing.** Adding the URL without enabling the switch is the trap that was hit in
practice: the list looks configured, and the plugin still receives zero events. In `manual` mode the plugin never
writes Gopeed's settings, so these two steps are yours.

### `auto` mode: the plugin writes the URL

`gopeed_events` with `action: "apply"` is the only code path in the plugin that writes Gopeed config, and it is
refused unless `webhookMode` is `auto`. It:

1. reads the current config (`GET /api/v1/config`) -- a failed read leaves Gopeed untouched;
2. changes **only** the webhook fields: `webhook.enable = true`, and the listener URL is **merged** into
   `webhook.urls`, keeping every URL you already had;
3. writes the whole config back (`PUT /api/v1/config`);
4. reads it back and reports `applied: true` only if the URL is really there.

`action` accepts `apply` and nothing else. Any other value -- including a combined "apply and restart" verb --
is rejected with an explanation, because no agent tool may restart or kill Gopeed. It never restarts Gopeed by
itself.

### A full restart is required after changing Gopeed's webhook config

Gopeed applies the webhook settings only after a **complete restart**. Closing the window is not a restart --
Gopeed minimizes to the tray and keeps running with the old settings. The GUI may keep showing the old values in
the meantime, so "the settings screen looks unchanged" does not mean the write failed.

The only restart entry point is the **Restart Gopeed** button on the plugin settings page (see below). No agent
tool can restart or kill the process: `gopeed_launch` has no `restart` parameter, and `gopeed_events` accepts only
`apply`.

### Reading events

Events are kept in a **50-entry ring buffer in memory**; the oldest are dropped, and the buffer is empty after a
plugin or DSH restart. `gopeed_events` filters them by:

- `since` -- a timestamp; only newer events are returned;
- `unreadOnly` -- only events not yet returned by a previous call.

**Returning events marks them read**, so a second call with `unreadOnly: true` returns nothing until new events
arrive. `gopeed_process` also reports the webhook status, so the wiring can be checked without reading the buffer.

### Two notification channels, neither in the conversation

With `webhookNotify` on (the default), an accepted event is delivered twice:

- **A bottom-right toast** rendered by the plugin's own client half. The page polls an authenticated
  `GET /api/dsh-gopeed/notifications` route; each toast disappears after 6 seconds. It never marks the receiver
  buffer as read, so `gopeed_events` still reports the same unread count.
- **`Agent.inject`**: the same summary is queued as model-facing context for the agent's **next** turn. It does
  **not** wake the agent and is never rendered as a chat message.

**The plugin no longer posts messages into the conversation.** The old `Agent.followup` and
`ToolRunContext.deferContext` paths are gone: both delivered plugin text as a `role: 'user'` message, which made it
look as if the user had typed it. Guidance now travels inside the tool's own output, and download notices use the
toast and `inject` channels only. Set `webhookNotify: false` to keep events cache-only.

### Restarting Gopeed

Press the red **Restart Gopeed** button on the settings page. It asks for confirmation first, because a restart
interrupts downloads in progress. It only stops and starts the process:

1. force-kill the running Gopeed (`taskkill /F`) and wait until its pid is actually gone from the process table;
2. start Gopeed again;
3. wait up to 10 seconds for its API to answer.

**The button does not write webhook config.** Registering the listener URL is a separate step: `gopeed_events`
with `action: "apply"` in `auto` mode, or your own manual entries in `manual` mode.

A plain `taskkill` (without `/F`) only posts a close message, which Gopeed answers by minimizing to the tray; the
process survives and the command still exits 0. That is why stopping is always forced here.

## Diagnostics and launching

Run **`gopeed_process`** first; it classifies the situation into one of six verdicts.

| Verdict | Meaning | What to do |
|---|---|---|
| `running` | The API answers normally. | Nothing -- it works. |
| `unresponsive` | The port accepts connections but nothing replies; the process is alive but stuck. | Press **Restart Gopeed** on the plugin settings page -- the only restart path (it interrupts running downloads). |
| `misconfigured` | The process is running, but nothing answers on the port in use: Gopeed is fine, the port is not. | Read the fixed port under Gopeed -> Settings -> Advanced -> Protocol and enter it in the plugin config, or leave `port` at `0` so the plugin detects it. |
| `stopped` | Connection refused and no live process was found: Gopeed is not running. | `gopeed_launch` -- the equivalent of double-clicking the icon. |
| `unauthorized` | The process is fine, the token is wrong. | Fix the token in the plugin settings page. |
| `unknown` | The port or address is wrong, or the process table could not be read. | Check host, port and Gopeed's protocol setting; if the process probe is `unavailable`, the plugin refuses to call it `stopped`. |

`misconfigured` is the verdict that used to be reported as `stopped`: telling someone to launch a program that is already running sends them to the wrong fix. It only appears when the process probe can actually see the process; when the probe is blocked the plugin stays with the API evidence instead of guessing.

**Automatic port detection.** With `port` at `0` the plugin asks Windows for the ports the running `Gopeed.exe` holds (`netstat -ano`, then `Get-NetTCPConnection`). When neither discloses them, the self-check says so and points at the fixed port in Gopeed. The `portScan` setting exists for that case: enabled, the plugin may sweep the dynamic port range and probe each open port with `/api/v1/info`. It is **off by default** because probing every loopback port touches software that has nothing to do with Gopeed. When detection fails the plugin **does not guess a port**: it reports that the port is unknown and asks you to enter the one Gopeed shows. The old silent `9999` fallback (`Number(port) || 9999`, which turned `0` into `9999`) is gone, because it made the honest "port unknown" diagnosis unreachable.

The same call reports process information: whether a process was found, its pid, its memory. **Read `processProbe` before you believe `processFound`** -- when it is `unavailable` the environment would not hand over the process list, so `processFound: false` does **not** mean Gopeed is down, and the API verdict is the one that counts. The PowerShell probe checks whether it can see its own process first; if it cannot, it reports `unavailable` instead of an empty list that looks like "Gopeed is not running". The plugin is built to say so rather than lie.

### Launching Gopeed

```
gopeed_launch    # start it if stopped; do nothing if already running
```

**No path has to be configured.** Before launching, the plugin looks for `Gopeed.exe` in this order and stops at the first hit:

| Step | Source | Notes |
|---|---|---|
| 1 | the `exePath` setting | Only when filled in; overrides everything for portable or custom installs. |
| 2 | **Gopeed's default install locations** (`%LOCALAPPDATA%\Programs\Gopeed\Gopeed.exe`, `%LOCALAPPDATA%\Gopeed\Gopeed.exe`) | A pure filesystem check that starts **no subprocess**, so it is free in the normal case. |
| 3 | the running process's image path | A running process always knows its real path, covering portable and custom installs. |
| 4 | registry uninstall entries | `DisplayIcon` / `InstallLocation`. |
| 5 | Start Menu or Desktop `Gopeed.lnk` | Resolves the shortcut's `TargetPath`. |
| 6 | other common directories | `Program Files`, `Program Files (x86)`, `D:\Program Files`, and similar. |

Steps 3-5 share **one** PowerShell call (`Get-Process` plus `Get-ItemProperty` plus `WScript.Shell`) and only run when step 2 missed. The result is cached in process memory and recomputed if the cached path disappears.

- **Nothing found?** The tools do not guess: `gopeed_process.advice` and `gopeed_launch.message` list every location that was tried and ask you to either install Gopeed or set the executable path for a portable build.
- **Launch** uses `spawn(exePath, { detached: true, stdio: 'ignore' }).unref()` -- a detached process with no console and no blocking, effectively a double-click. Afterwards the plugin polls the API for up to 10 seconds to confirm readiness.
- **It probes the resolved port, not the raw config value.** With `port` at `0` the raw value is not a dialable port; probing it used to conclude "not running" and launch a second instance. The check now uses the port detection result, so an already-running Gopeed is left alone.
- **No pid, no pretence.** If the process list cannot be read, the restart path says that it needs a pid it cannot obtain and gives manual steps instead of reporting success.
- **It cannot restart anything.** There is no `restart` parameter any more. For a stuck process, send the user to the settings page's **Restart Gopeed** button.

### Guiding the user

Users do not read documentation before trying a tool. So when any tool hits a connection failure, a timeout or a bad token, it appends a short English step-by-step notice to **that tool's own result** (an error message, or `gopeed_process.advice`): install Gopeed, open its protocol settings and pin the port, match the token. It is appended **at most once per plugin lifetime**, and a failure to build it never masks the tool's own error. Task-level errors -- an unknown id, for example -- deliberately do **not** trigger the notice.

Nothing the plugin says is written into the conversation as a user message. The earlier `followup` / `deferContext` mechanisms are removed for that reason; see [Two notification channels](#two-notification-channels-neither-in-the-conversation).

### Sandbox vs. plugin runtime

The plugin runs inside the DSH host process, so it has three different relationships with the
file-access sandbox. Which one applied is always reported, never assumed:

| Action | Confined? |
|---|---|
| Read-only diagnosis: `tasklist`, `Get-Process`, `netstat`, `Get-NetTCPConnection`, `netsh`, reading files, calling Gopeed's loopback API | **No** -- it only looks. A confined shell often cannot see other processes at all, which would make the diagnosis worthless |
| Starting or stopping Gopeed: `gopeed_launch` and the config-page **Restart Gopeed** button | **Yes** -- through `ctx.sandbox.confine`, under the session's file policy |

Every result says which one happened:

- `diagnosticsSandboxed: false` plus `diagnosticsSandboxNote` -- the diagnosis ran with host
  permissions. This says nothing about whether Gopeed is running; only the API verdict does
- `launchSandboxed` / `sandboxMode` / `sandboxDetail` on `gopeed_launch` and on the restart route

Three cases for start and stop:

| Case | Behaviour |
|---|---|
| No sandbox service on this host | Runs unconfined and says so (`sandboxMode: ""`) |
| The session policy is `danger-full-access` | Runs unconfined and reports exactly that |
| The policy restricts it and the backend refuses (`SANDBOX_UNAVAILABLE`) | **Nothing is started or stopped.** The tool reports the refusal and the next step. The plugin never silently falls back to an unconfined run |

A sandboxed shell failing to find Gopeed proves nothing about Gopeed -- that is why process
diagnosis lives in the plugin rather than in a shell command.

## Troubleshooting

- **`verdict: stopped`** -- Gopeed is not running, or listens elsewhere. Start it with `gopeed_launch`, then confirm Gopeed -> Settings -> Advanced -> Protocol (TCP) matches the plugin's `host` and `port` exactly.
- **`verdict: unknown`** -- either the host/port is wrong, or the process table is unreadable on this host. Check `processProbe`: when it is `unavailable`, do not conclude that Gopeed stopped.
- **`verdict: unauthorized`** -- copy the token from Gopeed -> Settings -> Advanced -> Token into the plugin settings page and save. Leaving the field blank keeps the old value.
- **`verdict: misconfigured`** -- Gopeed is running but nothing answers on the port in use. Read the fixed port under Gopeed -> Settings -> Advanced -> Protocol, enter it as `port` in the plugin config, or keep `port` at `0` so the plugin detects it. If Windows will not disclose the process's sockets, enable `portScan` only if you accept that it probes unrelated local ports.
- **`verdict: unresponsive`** -- Gopeed is alive but stuck. Press **Restart Gopeed** on the plugin settings page; no tool can do it, and the restart interrupts running downloads.
- **The restart button reported success but Gopeed never came back** -- this was a real bug: `taskkill` without `/F` only requests a close, Gopeed minimizes to the tray, and the old plugin then reported success while the original process was still running. Stopping is now forced and only counts as success once the pid is gone. If a restart still fails, the message names the stage (`probe`, `not-running`, `executable`, `stop`, `launch`, `api`).
- **`gopeed_events` returns no events** -- in `manual` mode, check both Gopeed steps: the **"Enable webhook"** switch must be ON *and* the URL must be in the list. An address alone sends nothing. In `auto` mode, call `gopeed_events` with `action: "apply"` and then press **Restart Gopeed**; the webhook config only takes effect after a full restart.
- **The Gopeed GUI still shows the old webhook values** -- expected: the settings screen is not re-read from disk until Gopeed restarts. Confirm the values with `gopeed_events` (read-back) and restart Gopeed.
- **The settings page shows a lower version than `gopeed_process.pluginVersion`** -- the browser is still running the previous bundle. Restart DSH, then refresh the page.
- **A task was created but never moves** -- check the same URL in a browser; slow or seedless torrents legitimately report no speed for a long time. That is Gopeed's behaviour, not the plugin's.
- **`gopeed_launch` cannot find `Gopeed.exe`** -- portable build or custom directory: set the full path to `Gopeed.exe` in the plugin settings page.
- **"Port unknown" and `9999` in old notes** -- ignore the `9999`: it was a fabricated fallback, removed in 0.2.0. The plugin now reports the port as unknown and asks for the one Gopeed shows.

## Development

A local checkout installs as a directory spec (an **absolute** path, as shown above). DSH records it as a `link:` dependency, and edits are then picked up by a DSH restart -- or, for changes that live inside `apply()`, by calling `plugin_manager`'s `set_plugin` on `include:gopeed` with `enabled: false` and then `enabled: true`. That re-runs `apply()`, so tool descriptions and render strings update immediately. Module-level state is **not** guaranteed to reset, so changes to `lib/` or to top-level constants still call for a full restart. Front-end changes in `client.js` need a browser page refresh.

**One manual step for link installs.** Node resolves the bare imports `@deepseek-ai/schemastery` and `@deepseek-ai/cosmokit` relative to the plugin's *real* path. When that path sits outside the profile, the profile's `node_modules` is not on the resolution chain, so a local checkout needs those two packages next to `index.js`. They are declared as optional peer dependencies and are **not** vendored here -- copy them from your DSH installation (matching versions) into a local `node_modules/`, which `.gitignore` keeps out of the repository. Installing from npm, a Git URL or a tarball does not need this, because the package then lives inside the profile and resolves normally.

Layout: `package.json` (bundle manifest), `cordis.patch.yml` (inserts one row, `id: gopeed`), `index.js` (host half: Config and the seven tools), `client.js` (web half: the form, the toast overlay and the restart button), `lib/api.js` (REST client, task normalization, process probing and launching), `lib/webhook.js` (loopback webhook receiver and the 50-entry ring buffer), `locale/` and `icon.svg`. Neither `lib/` module imports anything from DSH, so both can be exercised with plain Node.

### System-prompt footprint

DSH projects every tool's `{name, description, parameters}` into the system prompt on each turn (`output.schema` and `render` do not), so that text is a permanent cost. Measured on the 0.2.0 build, nine historical entry points having become seven tools:

| Tool (before) | Characters | Tool (after) | Characters |
|---|---:|---|---:|
| `gopeed_add` | 508 | `gopeed_add` | 214 |
| `gopeed_list` | 311 | `gopeed_list` | 180 |
| `gopeed_status` | 232 | `gopeed_status` | 139 |
| `gopeed_pause` + `gopeed_resume` + `gopeed_remove` | 728 | `gopeed_control` (merged) | 268 |
| `gopeed_info` + `gopeed_process` | 581 | `gopeed_process` (merged) | 82 |
| `gopeed_launch` | 354 | `gopeed_launch` | 109 |
| -- | -- | `gopeed_events` (new) | 225 |
| **9 tools total** | **2714** | **7 tools total** | **1217 (-55%)** |

What changed: three verbs collapsed into one `action` enum, `gopeed_info` folded into `gopeed_process`, `gopeed_launch` lost its `restart` parameter, descriptions cut to a fragment that never repeats the `gopeed_` prefix, parameter descriptions dropped except `path` (a wrong "file instead of directory" would silently download to the wrong place), and `additionalProperties: false` left out of the parameter schemas to match the shape `defineTool` produces (validation happens in `execute` instead). The one piece of meaning that cannot live in a name -- `force` deletes files -- is carried by `gopeed_control`'s description. The schema skeleton (names, `required` arrays, enum values) is deliberately untouched: it is what DSH validates, so shrinking it further would drop parameters, not characters. **No download capability was removed** -- only the entry points were consolidated. The measured total is **1217 characters, 117 over the original 1100 target**: `gopeed_events` accounts for 225 of them, and the rest of the overage is the deliberate decision to keep `name`, both value enums and the `required` arrays, because hiding a real parameter or a legal value costs more in wrong calls than those characters save. The names in the left column (`gopeed_pause`, `gopeed_resume`, `gopeed_remove`, `gopeed_info`) are historical and no longer exist as tools.

## Known limitations

1. **A forced restart interrupts downloads.** That is why it is a user-triggered button and not a tool. The failure paths are reported by stage; the success path must not be expected to preserve in-flight progress.
2. **Webhook delivery depends on Gopeed applying its config after a full restart.** Until then the GUI may show stale values, and no event will arrive. The plugin cannot tell "not enabled in Gopeed" apart from "enabled but not restarted"; both look like zero events received.
3. **Events are in-memory.** The ring buffer holds 50 entries and is emptied by a plugin reload or a DSH restart. Nothing is written to disk.
4. **The settings form's visual layout is unverified.** The data path (slot key, `form.state` / `mutate`, field projection, token redaction) is tested; the styling is inline CSS nobody has looked at in a browser.
5. **BT / magnet tasks are untested.** The protocol is passed through, and a missing `meta.res` degrades to `sizeKnown: false` rather than an invented percentage.
6. **`remove` is idempotent.** Gopeed 1.9.3 answers a `DELETE` for an unknown id with success, so deleting twice still reports "removed".
7. **Readiness after a restart is inferred by polling the API,** so a Gopeed that already serves requests while still showing a loading screen is reported ready early. Harmless.
8. **The webhook listener binds loopback only.** A Gopeed running in Docker, or on another machine, cannot push to it without extra networking.

## See also

- [CHANGELOG.md](CHANGELOG.md) -- what changed in each released version.
- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) -- a click-by-click Chinese walkthrough: install Gopeed, pin the API port in its protocol settings, install the bundle, configure it, verify with a real download.
- [docs/README.zh.md](docs/README.zh.md) -- the Chinese edition of this document.

> The two `docs/` files are **excluded from `files`**, so an installed plugin directory carries no
> user-facing documentation -- just code, the English README, the changelog, and the licence.

## License

[MIT](LICENSE)

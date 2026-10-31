# dsh-gopeed

English | [中文](docs/README.zh.md)

Turn a local **[Gopeed](https://gopeed.com/)** downloader into agent tools inside **DeepSeek Harness (DSH)**, with a settings page for the API host, port and token.

Downloads never pass through the model or a shell: the agent hands a URL to Gopeed over its loopback REST API (default `127.0.0.1:9999`, authenticated with the `X-Api-Token` header), and Gopeed owns all outbound traffic and the files on disk.

`dsh-gopeed` is a [Cordis](https://github.com/deepseek-ai/deepseek-harness) bundle: a host half that registers six tools, plus a web half that renders the configuration form.

## Features

- **Six tools** — `gopeed_add`, `gopeed_list`, `gopeed_status`, `gopeed_control` (pause / resume / remove through an `action` enum), and two diagnostics helpers: `gopeed_process` (is Gopeed alive, stuck or misconfigured — also reports the version) and `gopeed_launch` (start it, or force-restart a hung process).
- **Small system-prompt footprint** — the model-facing `{name, description, parameters}` of all six tools is 1096 characters (~270 tokens), down from 2714 across nine tools. See [System-prompt footprint](#system-prompt-footprint).
- **Settings page in the DSH Web UI** — host, port, token, request timeout and an optional executable path. Every field is *volatile*: saving applies immediately, with no plugin remount and no DSH restart. The token is a secret field, so the browser only ever sees "set" / "not set", never the value back.
- **Honest diagnostics instead of guesses** — `gopeed_process` returns one of `running`, `unresponsive`, `stopped`, `unauthorized` or `unknown`, and never reports "not running" when the process probe itself was blocked.
- **Reachable without reading docs** — when a tool hits a connection, timeout or token failure, it appends a one-time setup notice to the conversation (see [Guiding the user](#guiding-the-user)), instead of assuming anyone opened this file.
- **Normalized tasks** — one flat shape with `percent`, `sizeKnown`, speed and directory, so a task of unknown total size is never rendered as "0%".

## Language policy

The split is deliberate, and worth knowing before editing any string:

- **The plugin itself carries no Chinese.** Every string inside `index.js` and `lib/api.js` is
  English: tool names, tool and parameter descriptions, output-schema field descriptions,
  `render()` output, `message` / `advice` / error text, code comments, and the one-time setup
  notice appended through `ToolRunContext.deferContext`. Tool descriptions sit in the system
  prompt on every turn, which is also why they are kept terse.
- **Chinese lives only in the docs** — [docs/README.zh.md](docs/README.zh.md) and
  [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) are written for Chinese-speaking humans.
  They are reading material, not agent input.
- **One deliberate exception**: `client.js` ships a `zh` / `en` dictionary for the settings
  form, because that interface is read by the person configuring the plugin. It is UI copy,
  not documentation.

When editing a string, ask who reads it: model context → English; a human in the Web UI or on
GitHub → follow the row above.

## Requirements

- **DSH**, installed and running, with a profile that can install bundles (the `plugin_manager` tool, or the Web **Plugins** page).
- **[Gopeed](https://gopeed.com/) 1.9.3 or newer**, with its REST API reachable on `host:port`. Verified against Gopeed 1.9.3.
- **No Node.js, npm or pnpm is needed on your machine to *run* this plugin.** It is a Cordis plugin executing inside the DSH host process on DSH's own runtime, and it never shells out to `node`, `npm`, `npx` or `pnpm`.
- **Windows PowerShell 5.1 is enough** — the process helpers only use `tasklist`, `taskkill` and `powershell.exe`, all shipped with Windows; `pwsh` 7 is not required.
- `gopeed_process`, `gopeed_launch` and executable auto-discovery are **Windows-only**. The REST tools work wherever Gopeed runs.

## Installation

There is nothing to `pnpm add` by hand. Ask the agent, in any DSH session:

> Install the `dsh-gopeed` bundle from its Git URL.

That maps to `plugin_manager` with `action: "install_bundle"` and the repository URL as `target`. DSH parses the spec, checks reachability, installs it through its own package manager, then enables the bundle. Restart DSH when it asks you to. Uninstall with `action: "remove_bundle"` and `target: "dsh-gopeed"`, then restart. The Web UI equivalent of both is **Plugins → Installed**.

### Accepted `target` forms

Read from the DSH source (`@deepseek-ai/dsh-plugin-manager`), so the list is exhaustive:

| `target` | Accepted | Notes |
|---|---|---|
| `github:owner/repo` | yes | pnpm's Git host shorthand. |
| `git+https://github.com/owner/repo.git` | yes | Standard Git URL; `git+` is stripped before the reachability check. |
| `https://github.com/owner/repo` | yes | A hosted-repository URL is treated as a Git spec, not a plain web URL. |
| `github:owner/repo#v0.1.0` | yes | Pin a tag or commit after `#`. |
| `https://…/repo/archive/refs/tags/v0.1.0.tar.gz` | yes | A `.tgz` / `.tar.gz` URL is a tarball spec and skips Git entirely. |
| `D:\path\to\dsh-plugin-gopeed` | yes | An **absolute** local directory (development installs). |
| a relative path | **no** | Refused: "a local path must be absolute". |

For GitHub Git specs the manager runs `git ls-remote` (5 s default) before installing, and only a network failure or timeout aborts it. **So `git` must be installed for a Git-URL install**; with no `git`, install from a release tarball URL instead. A package installed from a Git URL is checked against its DSH version requirements only after installation, because its manifest is not known earlier.

Installing an absolute directory records a `link:` dependency, so the profile's `node_modules/dsh-gopeed` is a junction back to your working tree and source edits are picked up on restart. See [Development](#development) for the one extra step link installs need.

## Configuration

Open the sidebar **Plugins → Installed → Gopeed Downloader → row `gopeed` → Configure**.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `host` | string | `127.0.0.1` | Listen address from Gopeed → Settings → Advanced → Protocol (TCP). |
| `port` | number | `9999` | The TCP port on the same page. |
| `token` | string (secret) | `deepseek` | Gopeed's API token. `deepseek` is Gopeed's own shipped default — change it in Gopeed and here together. |
| `timeoutMs` | number | `20000` | Per-request HTTP timeout, in milliseconds. |
| `exePath` | string | *(empty)* | Leave blank in almost every case; only portable or non-standard installs need it. See [Launching Gopeed](#launching-gopeed). |

A live "request base URL" preview shows `http://host:port` above the form. Saving writes the values into the current profile's `cordis.patch.yml` under `id: gopeed` and takes effect immediately. An empty token field does **not** clear the stored token — it keeps the previous value, so retype the token whenever you are unsure.

## Tools

| Tool | Parameters | Returns | Purpose |
|---|---|---|---|
| `gopeed_add` | `url` (required), `path`, `name` | `taskId`, `url`, `name`, `path`, `baseUrl` | Create a download task. |
| `gopeed_list` | `status` (optional: `ready`/`running`/`pause`/`wait`/`error`/`done`) | `count` + normalized task array | List all tasks, optionally filtered. |
| `gopeed_status` | `id` | one normalized task | Progress of a single task. |
| `gopeed_control` | `id` + `action` (`pause`/`resume`/`remove`), optional `force` | `{ ok, id, action, status, message }` | Pause, resume or delete. |
| `gopeed_process` | — | verdict, API probe, pid, memory, version, executable path, advice | Process **and** API diagnosis; also the connectivity/version check. |
| `gopeed_launch` | `restart` (default `false`) | `{ launched, alreadyRunning, restarted, pid, apiState, message }` | Start Gopeed, or force-restart it. |

**`gopeed_control`'s `force` defaults to `true`** for `remove`, which deletes the downloaded files along with the task. Pass `force: false` explicitly to keep the files.

A normalized task looks like this:

```json
{ "id": "0n37…", "name": "a.iso", "status": "running", "protocol": "http",
  "sizeBytes": 11857955, "downloadedBytes": 4200000, "percent": 35.4,
  "sizeKnown": true, "speedBytesPerSec": 1048576,
  "path": "D:\\Downloads", "createdAt": "…" }
```

## Diagnostics and launching

Run **`gopeed_process`** first; it classifies the situation into one of five verdicts.

| Verdict | Meaning | What to do |
|---|---|---|
| `running` | The API answers normally. | Nothing — it works. |
| `unresponsive` | The port accepts connections but nothing replies; the process is alive but stuck. | `gopeed_launch` with `restart: true`. |
| `stopped` | Connection refused: Gopeed is not running. | `gopeed_launch` — the equivalent of double-clicking the icon. |
| `unauthorized` | The process is fine, the token is wrong. | Fix the token in the plugin settings page. |
| `unknown` | The port or address is wrong. | Check host, port and Gopeed's protocol setting. |

The same call reports process information: whether a process was found, its pid, its memory. **Read `processProbe` before you believe `processFound`** — when it is `unavailable` the environment would not hand over the process list, so `processFound: false` does **not** mean Gopeed is down, and the API verdict is the one that counts. The plugin is built to say so rather than lie.

### Launching Gopeed

```
gopeed_launch                 # start it if stopped; do nothing if already running
gopeed_launch {restart:true}  # kill and relaunch (rescues a hung process)
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

Steps 3–5 share **one** PowerShell call (`Get-Process` plus `Get-ItemProperty` plus `WScript.Shell`) and only run when step 2 missed. The result is cached in process memory and recomputed if the cached path disappears.

- **Nothing found?** The tools do not guess: `gopeed_process.advice` and `gopeed_launch.message` list every location that was tried and ask you to either install Gopeed or set the executable path for a portable build.
- **Launch** uses `spawn(exePath, { detached: true, stdio: 'ignore' }).unref()` — a detached process with no console and no blocking, effectively a double-click. Afterwards the plugin polls the API for up to 10 seconds to confirm readiness.
- **Restart** runs `taskkill /PID` first and falls back to `/F`, waits ~900 ms for the port to be released, then launches. The kill is hard; unfinished downloads recover through Gopeed's own checkpointing.
- **No pid, no pretence.** If the process list cannot be read, the tool says that a restart needs a pid it cannot obtain, and gives manual steps instead of reporting success.

### Guiding the user

Users do not read documentation before trying a tool. So when any tool hits a connection failure, a timeout or a bad token, it uses `ToolRunContext.deferContext` to append a short Chinese step-by-step notice to the conversation (install Gopeed, switch the protocol to TCP, match the token). It is appended **at most once per plugin lifetime**, and a failure to inject it never masks the tool's own error. Task-level errors — an unknown id, for example — deliberately do **not** trigger the notice.

### Sandbox vs. plugin runtime

The plugin runs inside the DSH host process with ordinary user permissions, whereas a sandboxed shell tool may be restricted:

| Environment | `tasklist` | `Get-Process` | WMI |
|---|---|---|---|
| DSH's `pwsh` tool (sandboxed) | access denied | sees only a handful of processes | access denied |
| **The plugin (inside the DSH host process)** | works | — | — |

So a sandboxed shell failing to find Gopeed proves nothing. Process diagnosis belongs in the plugin, not in a shell command.

## Troubleshooting

- **`verdict: stopped`** — Gopeed is not running, or listens elsewhere. Start it with `gopeed_launch`, then confirm Gopeed → Settings → Advanced → Protocol (TCP) matches the plugin's `host` and `port` exactly.
- **`verdict: unauthorized`** — copy the token from Gopeed → Settings → Advanced → Token into the plugin settings page and save. Leaving the field blank keeps the old value.
- **`verdict: unresponsive`** — restart with `restart: true`, as described above.
- **A task was created but never moves** — check the same URL in a browser; slow or seedless torrents legitimately report no speed for a long time. That is Gopeed's behaviour, not the plugin's.
- **`gopeed_launch` cannot find `Gopeed.exe`** — portable build or custom directory: set the full path to `Gopeed.exe` in the plugin settings page.

## Development

A local checkout installs as a directory spec (an **absolute** path, as shown above). DSH records it as a `link:` dependency, and edits are then picked up by a DSH restart — or, for changes that live inside `apply()`, by calling `plugin_manager`'s `set_plugin` on `include:gopeed` with `enabled: false` and then `enabled: true`. That re-runs `apply()`, so tool descriptions and render strings update immediately. Module-level state is **not** guaranteed to reset, so changes to `lib/` or to top-level constants still call for a full restart. Front-end changes in `client.js` need a browser page refresh.

**One manual step for link installs.** Node resolves the bare imports `@deepseek-ai/schemastery` and `@deepseek-ai/cosmokit` relative to the plugin's *real* path. When that path sits outside the profile, the profile's `node_modules` is not on the resolution chain, so a local checkout needs those two packages next to `index.js`. They are declared as optional peer dependencies and are **not** vendored here — copy them from your DSH installation (matching versions) into a local `node_modules/`, which `.gitignore` keeps out of the repository. Installing from npm, a Git URL or a tarball does not need this, because the package then lives inside the profile and resolves normally.

Layout: `package.json` (bundle manifest), `cordis.patch.yml` (inserts one row, `id: gopeed`), `index.js` (host half: Config and the six tools), `client.js` (web half: the form), `lib/api.js` (REST client, task normalization, process probing and launching), `locale/` and `icon.svg`. `lib/api.js` imports nothing from DSH, so it can be exercised with plain Node.

### System-prompt footprint

DSH projects every tool's `{name, description, parameters}` into the system prompt on each turn (`output.schema` and `render` do not), so that text is a permanent cost. Measured during the nine-to-six-tool consolidation:

| Tool (before) | Characters | Tool (after) | Characters |
|---|---:|---|---:|
| `gopeed_add` | 508 | `gopeed_add` | 239 |
| `gopeed_list` | 311 | `gopeed_list` | 187 |
| `gopeed_status` | 232 | `gopeed_status` | 145 |
| `gopeed_pause` + `gopeed_resume` + `gopeed_remove` | 728 | `gopeed_control` (merged) | 283 |
| `gopeed_info` + `gopeed_process` | 581 | `gopeed_process` (merged) | 105 |
| `gopeed_launch` | 354 | `gopeed_launch` | 137 |
| **nine tools total** | **2714** | **six tools total** | **1096 (−60%)** |

What changed: three verbs collapsed into one `action` enum, `gopeed_info` folded into `gopeed_process`, descriptions cut to one English sentence, parameter descriptions dropped where the name and enum are self-explanatory, and `additionalProperties: false` left out of the parameter schemas to match the shape `defineTool` produces (validation happens in `execute` instead). **No capability was removed** — only the entry points were consolidated. The names in the left column (`gopeed_pause`, `gopeed_resume`, `gopeed_remove`, `gopeed_info`) are historical and no longer exist as tools.

## Known limitations

1. **A real `restart: true` has not been exercised end to end.** Killing a live Gopeed interrupts downloads, so the success path awaits explicit approval. Every failure path is covered: probe unavailable, `ENOENT`, missing pid. Its success path needs one more verification with consent.
2. **The settings form's visual layout is unverified.** The data path (slot key, `form.state` / `mutate`, field projection, token redaction) is tested; the styling is inline CSS nobody has looked at in a browser.
3. **BT / magnet tasks are untested.** The protocol is passed through, and a missing `meta.res` degrades to `sizeKnown: false` rather than an invented percentage.
4. **`remove` is idempotent.** Gopeed 1.9.3 answers a `DELETE` for an unknown id with success, so deleting twice still reports "removed".
5. **Readiness after a restart is inferred by polling the API,** so a Gopeed that already serves requests while still showing a loading screen is reported ready early. Harmless.

## See also

- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) — a click-by-click Chinese walkthrough: install Gopeed, enable its API, install the bundle, configure it, verify with a real download.
- [docs/README.zh.md](docs/README.zh.md) — the Chinese edition of this document.

> Both live under `docs/`, which is **excluded from `files`**, so an installed plugin
> directory carries no user-facing documentation — just code, the English README, and
> the licence.

## License

[MIT](LICENSE)

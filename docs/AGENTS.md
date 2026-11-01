# dsh-gopeed: the agent contract

Agent-facing contract for **`dsh-gopeed`**, a DSH bundle that drives a local
[Gopeed](https://gopeed.com/) download manager. This file is for the model that calls the tools. Human
documentation -- install, settings page, design notes -- is in [README.md](../README.md); read it only when a
human-facing detail is needed, not for instructions.

The plugin talks to a Gopeed process on the local machine. Downloads are owned by Gopeed: they never pass
through your output, a shell, or the model.

## When to use these tools

Use them when the user:

- asks to download something -- a direct HTTP/HTTPS URL, a magnet link, or a remote `.torrent` URL;
- asks about the progress, speed or location of a download;
- asks to pause, resume or cancel a download;
- asks whether Gopeed is installed, running, or reachable, or why a download did not start.

Do **not** use them to read a downloaded file, to fetch a web page for context, or as a general HTTP client.
`gopeed_add` starts a real download to disk; it is not a probe.

## The seven tools

| Tool | Use it for | Parameters | Result fields (DSH validates this shape) |
|---|---|---|---|
| `gopeed_add` | Start a download. | `url` (required), `path`, `name` | `taskId`, `url`, `name`, `path` (real save directory), `baseUrl`, `jobId`, `jobNote` |
| `gopeed_list` | List tasks, optionally filtered. | `status` (optional: `ready` / `running` / `pause` / `wait` / `error` / `done`) | `count`, `tasks[]`, `baseUrl` |
| `gopeed_status` | One task by id. | `id` (required) | `task`, `baseUrl` |
| `gopeed_control` | Pause, resume or remove. | `id`, `action` (`pause` / `resume` / `remove`), `force` | `ok`, `id`, `action`, `status`, `message` |
| `gopeed_process` | Diagnose: is Gopeed alive, which port, is the token right. Also the version check. | none | `verdict`, `processProbe`, `processFound`, `pid`, `version`, `pluginVersion`, `exePath`, `baseUrl`, webhook fields, `advice` |
| `gopeed_launch` | Start Gopeed if it is not running. | none (`{}`) | `launched`, `alreadyRunning`, `pid`, `message`, `sandboxMode` |
| `gopeed_events` | Read download-complete events, or save the webhook address into Gopeed. | `since`, `unreadOnly`, `action: "apply"` | `mode`, `listener`, `listening`, `count`, `unread`, `events[]`, `applied`, `message` |

Parameter notes that prevent wrong calls:

- **`gopeed_add.path` is a DIRECTORY, not a file path.** A filename belongs in `name`.
  Omitting `path` uses the configured save location (an explicit one wins over it); omitting `name` lets
  Gopeed derive the name from the link.
- **`gopeed_control.action` is a closed set**; any other verb is rejected. There is no "cancel" and no
  "restart".
- **`gopeed_control.force` defaults to `true` for `remove`**, which deletes the downloaded files along with the
  task. Pass `force: false` explicitly when the user wants to keep the files.
- **`gopeed_launch` takes no parameters.** It cannot restart or kill anything.
- **`gopeed_events.action` accepts only `apply`.**
- `gopeed_add` and `gopeed_control` are **not concurrency-safe**. Do not fire them in the same batch as each
  other; run one, read the result, then continue.

A normalized task uses `percent`, `sizeKnown`, `speedBytesPerSec`, `sizeBytes`, `downloadedBytes`, `status`,
`path`, `protocol`. When `sizeKnown` is `false` the total size is unknown -- report "unknown size", never "0%"
and never an estimated percentage.

## The rule that matters most: do not poll

`gopeed_add` registers the download as a **DSH background job** and returns its `jobId`. When the download
ends, **DSH itself** sends the completion notice: a busy agent reads it in its next step, an idle agent is woken
with a follow-up turn. The plugin does not impersonate the user and never writes a chat message.

Therefore:

1. After `gopeed_add`, **stop**. Do not poll, do not sleep, do not call `gopeed_status` in a loop, and do not
   block on `job_output`.
2. When the completion notice arrives, call `job_output` with that `jobId` to read the outcome.
3. Poll `gopeed_status` **only** when `jobId` is `""` (no job could be started -- `jobNote` says why), or when
   the user asks for progress *right now* on a download that is not yours.

If the user says "wait for it", say that the notice will arrive on its own; do not burn turns polling.

## Where a download is saved

First match wins:

1. an explicit `path` argument to `gopeed_add`;
2. the session's **current working directory**, when `downloadTarget` is `workspace` (the **default**);
3. `customDownloadPath`, when `downloadTarget` is `custom` and the field is not empty;
4. otherwise the path is left unset and **Gopeed's own configured download directory** is used.

**"Current" means live, not creation time:** this is the directory the `working_directory` tool reports, so it
follows a `cd`; creation time plays no part.

Fallbacks are reported in `jobNote` and never happen silently. The returned `path` is read back from Gopeed, so
it is where the file actually landed -- quote it to the user rather than repeating your own argument.

## Reading the returned fields

- **`baseUrl`** -- the Gopeed endpoint actually used, for example `http://127.0.0.1:53217`. Useful when a
  connection problem needs explaining; do not derive a port from it for any other purpose.
- **`jobId`** -- the id of the background tracking job. Empty means no job.
- **`jobNote`** -- why no job tracks this download, plus any save-path fallback note. Empty on success. Read it
  before concluding anything about tracking.
- **`path`** -- the save directory Gopeed reports.
- **`verdict`** -- `running` / `unresponsive` / `misconfigured` / `stopped` / `unauthorized` / `unknown`.
- **`processProbe`** -- **read it before believing `processFound`**. When it is `unavailable` the host could not
  enumerate processes, so `processFound: false` does **not** mean Gopeed is down; only `verdict` counts then.
- **`advice`** -- the next step in English. Relay it to the user; it is written to be read by them.

## Error playbook

| Symptom | What it means | What to do |
|---|---|---|
| `verdict: "stopped"` | Gopeed is not running (or listens elsewhere). | `gopeed_process`, then `gopeed_launch`. Re-run `gopeed_process` to confirm `verdict: "running"`, then retry the original tool once. |
| `verdict: "misconfigured"` | The process is alive but nothing answers on the configured port. | Do **not** launch another instance. Ask the user to read the fixed port under Gopeed -> Settings -> Advanced -> Protocol and enter it on the plugin settings page, or to keep the plugin `port` at `0` so it auto-detects. |
| `verdict: "unresponsive"` | The port accepts connections but nothing replies. | Gopeed is stuck. There is no tool for this: ask the user to press **Restart Gopeed** on the plugin settings page (it interrupts running downloads). |
| `verdict: "unauthorized"` | The token is wrong, and the port is NOT the problem: Gopeed answers HTTP 401 (403 on some builds) with `code=1001 msg=unauthorized`, and port auto-detection deliberately keeps a port whose probe says `unauthorized`, because a Gopeed that answers proves the port. | Ask the user to copy the token from Gopeed -> Settings -> Advanced -> Token into the plugin settings page. Never guess or fabricate one. A `gopeed_add` that fails this way reads: `Error: gopeed_add failed: Gopeed /api/v1/tasks returned code=1001 msg=unauthorized -- the token is wrong; set it in the plugin settings (gopeed_process explains it)`. Relay that wording, leave the port alone, and do not retry until the token is fixed. |
| `verdict: "unknown"` / connection refused, `processProbe: "unavailable"` | The environment is opaque, so "not running" is unverified. | Report the uncertainty; ask the user to check Gopeed. Never claim Gopeed is down. |
| `code: 1000` or "task not found" | Gopeed no longer has that task -- it finished, or it was already removed. This is normal, not a failure. | Report it as-is. Any tracking job for it was cancelled. Do not retry the id. |
| Connection failure or timeout on any tool | First-time setup is probably incomplete. | The tool appends a numbered English setup notice to its own result (and `gopeed_process.advice`). Relay that notice to the user verbatim-ish, then retry once after they act. |
| Any call whose error ends with `-- the token is wrong; set it in the plugin settings` | The port is proven: a Gopeed answered there, only the token differs. This sentence is the whole message: the numbered setup notice targets an unreachable Gopeed, so do not walk the user through the install steps here. | Send the user straight to the token (row above), not through the install steps, and do not treat the sentence as a port or connection problem. |
| Webhook mode `manual` and zero events | The user must enable **and** add the URL in Gopeed. | Point at Gopeed -> Settings -> Developer -> Webhook push: the "Enable webhook" switch must be ON **and** the address must be in the list. An address alone sends nothing. |

## Things not to do

- **Do not restart or kill Gopeed.** No tool can, by design. A restart is the user's button.
- **Do not guess, invent or ask for a token**, and never echo a token into your reply.
- **Do not change Gopeed's configuration in `manual` webhook mode.** That mode is the user's to configure; in
  `auto` mode only `gopeed_events action=apply` may save it, and only on an explicit request. Either way, the
  new config takes effect only after the user fully restarts Gopeed -- closing the window is not a restart.
- **Do not describe a download as failed because it is slow.** Slow or seedless torrents legitimately report no
  speed for a long time; a task that stays `pause` / `wait` is stalled, not failed.
- **Do not remove a task to "clean up"** unless the user asked. `remove` deletes the files.
- **Do not retry an add with the same URL** because the first one looked slow: you will start a duplicate
  download. Check `gopeed_list` first.

## Terminology

- **task** -- a download inside Gopeed, identified by `taskId` / `id`.
- **job** -- a DSH background job tracking one task; id `gopeed-<16 hex>`. Lives in the DSH process, so a DSH
  restart drops it while the download keeps running in Gopeed.
- **`cfg`** -- the plugin's own settings (save target, host, port, token, webhook mode). Not a tool.
- **listen address / port / token** -- Gopeed's own settings. The desktop build defaults to a random port per
  launch, so the plugin's default `port: 0` means "ask the running process".
- **webhook** -- an optional outbound push from Gopeed to `http://127.0.0.1:<port>/webhook` when a task ends.
  An enhancement, not a requirement: the tracking job works with the webhook `off`.

Full human documentation: [README.md](../README.md). Change history: [CHANGELOG.md](../CHANGELOG.md).

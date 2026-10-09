# dsh-olivia-bridge

[English](README.md) | [简体中文](README.zh-CN.md)

Wire the *BSide: Olivia Lin* client (miHoYo's 林离) into DSH — letters written in the game are answered by a DSH agent session.

## What it does

After the official servers shut down on 2026-08-31, the client was left with nothing but local performance playback and wallpapers. This plugin starts an HTTP server on the loopback address, impersonating the backend the client used to talk to, then feeds every incoming letter into a persistent DSH agent session; her replies are written back to the local letter store and the client displays them as usual.

```
Olivia.exe 0.0.9.627
   │  POST /toy/letter/send · GET /toy/letter/list|detail|unread_count
   ▼
dsh-olivia-bridge   127.0.0.1:8791
   │  letter store <DSH_HOME>\olivia-bridge\letters.json
   ▼
DSH agent session (preset: 林离)
   │  ctx.agents.create → followup → whenIdle
   ▼
Session history is her memory: every letter goes into the same session, no separate memory store needed
```

The session id is fixed to `olivia-letterbox`, and the plugin calls `agents.resume()` on startup to reattach to the same session, so she still remembers every previous letter after a DSH restart — this is what sets this approach apart from other local implementations.

## Installation

Requires DSH desktop 0.2.x (Windows) and game client `0.0.9.627`.

```powershell
# 1. Mount the plugin into the desktop profile (existing files are backed up to *.bak-olivia-<timestamp> first)
.\tools\install-desktop.ps1

# 2. Patch the game's frontend bundle (the original is backed up to feapp.dat.orig-backup first)
.\tools\patch-feapp.ps1 -GameDir 'X:\SteamLibrary\steamapps\common\BSide Olivia Lin Test'

# 3. Restart DSH
```

`install-desktop.ps1` does three things: adds a `file:` dependency and a bundle entry to the profile's `package.json`,
creates a `node_modules\dsh-olivia-bridge` junction pointing at this repository, and appends
`preset-olivia` to the end of `cordis.patch.yml` (the 林离 persona, `complete: true`, no tools attached).

The game directory can also be set once as an environment variable, after which neither of the two game-side scripts needs it passed in again:

```powershell
[Environment]::SetEnvironmentVariable('BSIDE_GAME_DIR', 'X:\SteamLibrary\steamapps\common\BSide Olivia Lin Test', 'User')
```

The patch anchors were written against the `0.0.9.627` frontend bundle. Every step verifies that its anchor is unique; on a different version the script aborts with an error instead of writing corrupt files.

## Game-side patches

`tools/patch-feapp.ps1` changes fifteen places in the frontend bundle (every run starts over from `feapp.dat.orig-backup`, so it is idempotent):

| # | Patch site | Purpose |
|---|---|---|
| 1 | `Te.defaults.baseURL` inside `jl()` | Pin the axios base URL to local |
| 2 | `N=j(()=>d.value.offlineMode===!0)` → `!1` | Turn off the offline gate (when true, the request interceptor throws on its first line) |
| 3 | `setClientConfig` override | `offlineMode=false` + `toyApiUrl` pointing local + `appInfo.Channel="demo"`, bypassing the shut-down miHoYo account login |
| 4 | `baseURL:""` at instance creation | The offline `conf.app.dat` has no `appConfig` section, so both paths 1 and 3 short-circuit |
| 5 | `tools/inject.js` injected into `index.html` | Probe plus request rewriting at the XHR/fetch layer (must be inserted before `</head>`) |
| 6 | the `m()` function | Call `toggleLetterEntry` to tell the native layer to show the entry point (the native layer ignores it; kept as a second safeguard) |
| 7 | `N3=!1,Ss=!1,wa=({onComplete` → `N3=!0,Ss=!0` | **Key**: lift the offline gating — `N3` controls the "write letter" button and `Ss` controls the MIDI upload entry; enabling only the former leaves you with "letters can be written, songs cannot be uploaded" |
| 8 | the empty tour anchor in the App template | **Left as is**: navigation has moved to each page's title bar (patch 14), so nothing is touched here |
| 9 | `disabled:a.remainingCount<=0` plus the quota copy | The write-letter button no longer depends on the quota, and the copy becomes "∞ letters left today" |
| 10 | `Yn().load()` appended at the end of `handleToyLoginSuccess` | Trigger the offline song library load and report the result (the native bridge's reply never goes over HTTP, so the probe cannot see it) |
| 11 | `N=b(0),$=b(3)` → `b(9999)` plus copy | Remove the frontend's hard-coded cap of "3 custom songs per day"; the copy shows ∞ |
| 12 | the `syncLocalStatus` / `startDownload` block | Bypass the native download state machine (the native side does not respond) and mark self-uploaded songs as already downloaded (only the "my uploads" site is changed; the official library site is left alone) |
| 13 | the "share letter" button in the mailbox header component | Replaced with "delete", calling `window.__oliviaDeleteMail(mail.id)` → the bridge's `/toy/letter/delete`. The frontend store only splices its own cache, so without the server call the letter is back after a refresh |
| 14 | the `h1` in the title bar of the library / mailbox pages | Replaced with two parallel entries, "library" and "letters", in a **fixed order** (the library is always on the left); the current page is fully lit and the other sits at `opacity:.5`, switching through `window.__oliviaNav()` |
| 15 | the "beta" label in the top-right user menu | Removed from the container's child nodes |

```powershell
.\tools\patch-feapp.ps1              # apply the patches (idempotent, repeated runs give the same result)
.\tools\patch-feapp.ps1 -Port 8800   # use a different port
.\tools\patch-feapp.ps1 -Restore     # restore the original in one step
.\tools\verify-patches.ps1           # read-only check that every patch landed (all PASS or it is not in place)
```

The patches are **blind replacements**; breaking the syntax leaves the game on a black screen with an unresponsive window. So before writing back, the script hands the modified bundle to
`node --check` for one parse and aborts on failure — at that point `feapp.dat` is still the original copied over from the backup, and the game starts as usual.

## Custom performances (MIDI upload → generate → playback)

The game originally uploaded MIDI to the official server to get a performance back; the bridge implements the whole chain locally:

```
genObjectUploadUrl → PUT /toy/midi/upload/<key> → midi/generate → poll getGenerateResult
                                                                        ↓
                                              WAV (preview) + MP4 (performance, requires ffmpeg)
```

- MIDI parsing and WAV synthesis are **pure JS, zero dependencies** (ported from `midi-manifest.js` / `audio-renderer.js` in [Comma0103/Linli-Nocturne](https://github.com/Comma0103/Linli-Nocturne), MIT).
- The native WebPlayer on the performance side is a `<video>` and **cannot play WAV**, so when ffmpeg is present the audio is wrapped into an audio-only MP4.
  It still works without ffmpeg installed: jobs complete normally and previews play as usual, only the performance makes no sound, and the log says so.
  ffmpeg is discovered in the order `config → OLIVIA_FFMPEG → <DSH_HOME>\olivia-bridge\ffmpeg\ → PATH`, with no path hard-coded.
- The upload is a `PUT`, which counts as a non-simple request, so the browser sends an `OPTIONS` preflight first. One missing `PUT` in
  `Access-Control-Allow-Methods` and the request is rejected before it ever leaves the browser — while command-line `curl` / `Invoke-WebRequest` **does not go through CORS**
  and hides this whole class of problem. The tests keep a dedicated preflight assertion watching for it.
- Storage: `<DSH_HOME>\olivia-bridge\midi\` (`jobs.json` + `<key>.mid` + `<jobId>.wav|.mp4`).
- Playlists ("add to playlist" / "music desktop") use the local `<DSH_HOME>\olivia-bridge\playlist.json`.
- Deletion really deletes: removing a song from "my uploads" goes through `POST /toy/deleteUserSong` (`userSongId`) and clears the WAV/MP4 along with it;
  a letter goes through `POST /toy/letter/delete` (`letter_id`), which deletes her reply as well and is idempotent (a repeat delete returns `deleted:false`).
  Both endpoints used to fall through to the catch-all branch at the end of `lib/index.js`, returning `code:0` plus an empty envelope —
  the UI looked like it deleted and the item came back on refresh, a textbook silent failure. There is also `POST /toy/letter/clear` to wipe all correspondence (not wired up in the frontend yet).

## Configuration

The `config` on the `olivia-bridge` line in `cordis.patch.yml`:

| Field | Default | Description |
|---|---|---|
| `port` | `8791` | Listen port; changing it means re-patching the game too |
| `presetId` | `olivia` | Agent preset used for replies (the line id is `preset-olivia`) |
| `provider` / `model` | empty | Leave empty to follow the DSH default model |
| `maxDailyLetters` | `1000000` | Daily letter cap; the client reads it from `remainingToday` in `list` |
| `llmFallback` | `true` | Fall back to generating replies directly through the LLM service when the agent path does not work |
| `ffmpegPath` | empty | Leave empty for auto-discovery (see above): `OLIVIA_FFMPEG` → `<DSH_HOME>\olivia-bridge\ffmpeg\ffmpeg.exe` → `PATH` |

## Observability and troubleshooting

```powershell
# bridge log (every request and the generation time of every letter lands here)
$dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
Get-Content "$dsh\olivia-bridge\bridge.log" -Tail 40

# letter store
Get-Content "$dsh\olivia-bridge\letters.json" -Raw

# manually confirm the service is alive
Invoke-RestMethod http://127.0.0.1:8791/toy/letter/unread_count

# static diagnostics: whether the preset resolves, how far session creation got, inbox / phase / message count
Invoke-RestMethod http://127.0.0.1:8791/olivia/diag

# run one real agent turn and report before/after snapshots (to pin down "the session was created but nothing ran")
Invoke-RestMethod -Method Post http://127.0.0.1:8791/olivia/agent-test

# hit the LLM once directly and take the real underlying error. By default it reproduces the agent route: tools / reasoningEffort /
# maxTokens come from the session's most recent request headers — these three are exactly what distinguishes the agent path from a bare call
# (measured: under the same provider/model a bare call succeeds while the agent path always fails). The errorChain in the
# response is expanded along cause (≤6 levels); the real reason behind the TRANSPORT line is always at level 2 or deeper.
Invoke-RestMethod -Method Post http://127.0.0.1:8791/olivia/llm-test -ContentType 'application/json' -Body '{"text":"ping"}'

# control / single variable: {"plain":true} falls back to sending provider/model only; you can also override one thing,
# e.g. {"plain":true,"reasoningEffort":"high"} or hand it {"tools":[],"maxTokens":4096}

# re-submit one failed letter
Invoke-RestMethod -Method Post http://127.0.0.1:8791/olivia/retry -Body '{"letterId":"3"}' -ContentType 'application/json'

# end to end: submit a letter and wait for the reply
node tools\verify.mjs

# four self-test groups: contract layer / response shape / full MIDI chain / profile YAML (each uses a temporary DSH_HOME and never touches real letters)
node test\contract.test.mjs
node test\response-shape.test.mjs
node test\midi-flow.test.mjs
node test\validate-profile-yaml.mjs

# unpack the events of her session (zstd JSONL)
node tools\dump-session.mjs
```

The client polls `letter/list` + `unread_count` every 60 seconds, so a finished reply shows up in the game within a minute.

### Four hard requirements of the agent path

Every one of these was learned the hard way from real runs, and they are written down here so nobody steps on them again while changing the code (parts of the `dsh-agent` README examples are outdated v3 syntax):

1. **Messages must carry an `id`**. `UserMessage.id` is a readonly required field, generated by the official `createMessage` through `brandString(randomUUID())`; without it the inbox **silently drops** the message.
2. **`source.kind` cannot be a bare `"plugin"`**. The v4 session format rejects it outright (the `source()` validation in `dsh-session-format-v3-to-v4`); the valid shape is `plugin:<plugin name>`.
3. **`agentOptions` must give a provider/model**. Left empty, the session is created and `presetActive` is true as well, but the turn spins immediately and the session log holds zero events. When nothing is configured, fall back to `ctx.agentDefaultModel.currentSelection()`.
4. **`followup()` must not be followed immediately by `whenIdle()`**. It only queues the work and asynchronously wakes the driver, so calling it right afterwards returns before the agent is awake (measured at 146-174 ms). Poll first and wait for the assistant message to land.

Two more: presets are indexed by **`config.id`** (the line id convention is `preset-<config.id>`); the sessionId is fixed to `olivia-letterbox` with `agents.resume()` on startup, otherwise she loses her memory every time DSH restarts.

## Known limits

- The client-server contract comes from reverse-engineering the 0.0.9.627 frontend bundle (`assets/main-*.js`) plus cross-checking against community implementations. Endpoints that are not implemented fall through to the catch-all branch at the end of `lib/index.js`, which returns a **fully-populated empty envelope** — not `{}`: 33 call sites in the frontend call array methods directly on fields of `data`, and a missing field throws a TypeError, rejects the promise, and leaves the skeleton screen spinning forever.
- Only text replies are implemented. Video/voice replies would need the client to take an absolute URL from `detail.replyVideoUrl` and the server to deliver an MP4 with an audio track, which is not done.
- **The official offline song library ("built-in tracks") does not work**: it does not go over HTTP but through the native bridge action `getOfflineSongList`, and that action does not respond at all on the post-shutdown client; `songlist.dat` is encrypted and the track media files are not present locally either. The only way to hear songs is to upload your own MIDI.
- MIDI share codes are an official server-side capability, and the bridge does not fake success locally (it returns 409).
- The plugin only listens on `127.0.0.1` and is not exposed to the network; the server validates no token, so any process on this machine can read and write these letters.
- Only the frontend bundle is touched; no native DLL is modified.

## Uninstalling

```powershell
.\tools\install-desktop.ps1 -Uninstall   # remove the junction
.\tools\patch-feapp.ps1 -Restore         # restore the game files
# then restore the profile's package.json / cordis.patch.yml
# from <DSH_HOME>\profiles\desktop\*.bak-olivia-<timestamp>, and restart DSH
```

## References

Community implementations of the same thing, useful for cross-checking patch sites:

- [Comma0103/Linli-Nocturne](https://github.com/Comma0103/Linli-Nocturne) — the most complete patch table, covering both the frontend and the native DLL
- [AETAVK/linli-local-mail](https://github.com/AETAVK/linli-local-mail) — a local letter service
- [2962152120/oliviaproxy](https://github.com/2962152120/oliviaproxy) — a proxy-style implementation

## License

MIT

# Player

Terminal-first media player with a fast TUI, a CLI mode, local progress tracking, and optional ArvanCloud S3 sync.

## Features

- TUI with keyboard-first navigation and search
- CLI mode for quick play and management
- Auto resume per series/episode or movie
- Series directory scraping with episode ordering
- Manual URL lists (paste multiple episode URLs)
- Local caching and background prefetch of next episode
- Download resume with exponential-backoff retry on partial transfers
- Cache progress shown in mpv OSD (desktop)
- Delete local cache files after watching
- Hardsub export helper (if  [stoh](https://github.com/Mobinshahidi/stoh) + `ffprobe` are installed)
- Import/export to the series-project JSON format
- Deduplicate series-project JSON files
- Optional ArvanCloud S3 sync across devices
- Termux/VLC support on Android (GrapheneOS compatible)

## Requirements

### Desktop

- Node.js 18+ (tested on Node 22)
- `mpv`
- `curl`
- Optional: [stoh](https://github.com/Mobinshahidi/stoh) + `ffprobe` for hardsub export
- Optional: Kitty terminal for detached TUI window

### Android / Termux

- Termux (F-Droid build recommended)
- Termux:API (F-Droid) — needed for `termux-am` intent launching
- Node.js via Termux: `pkg install nodejs`
- `curl` via Termux: `pkg install curl`
- VLC for Android (F-Droid or Play Store)

## Install

```bash
# Clone or copy the project, then:
npm install

# tsx is required to run .ts files directly:
npm install -g tsx
```

## Run (TUI) — Desktop only

```bash
npx tsx tui.ts
```

Detach into a new Kitty window:

```bash
npx tsx tui.ts --detach
```

## Run (CLI)

```bash
npx tsx player.ts
```

List, export, import from the command line:

```bash
npx tsx player.ts list
npx tsx player.ts export
npx tsx player.ts import /path/to/series.json
```

## TUI Keys

| Key | Action |
|-----|--------|
| `j` / `k` or arrows | Move up/down |
| `Enter` | Play selected |
| `/` | Search |
| `n` | New entry |
| `e` | Edit entry |
| `f` | Toggle finished |
| `r` | Rename |
| `d` | Delete |
| `D` | Multi-delete |
| `i` | Import |
| `x` | Export |
| `u` | Dedupe series JSON file |
| `s` | Force sync to ArvanCloud |
| `q` | Quit |

## Android / Termux Setup

### Initial setup

```bash
# Allow Termux to access shared storage (required for VLC to open files)
termux-setup-storage

# Install dependencies
pkg install nodejs curl

# Install tsx globally
npm install -g tsx
```

### Running on Termux

```bash
cd ~/player
npx tsx player.ts
```

The TUI (`tui.ts`) is desktop-only. On Termux, use the CLI (`player.ts`).

### How playback works on Android

When you play an episode:

1. VLC is launched via Android Intent pointing at the **remote HTTP URL** directly — this means seeking works freely at any position without buffering issues.
2. `curl` downloads the episode to `/storage/emulated/0/player-cache/<series>/` in the background as a cache for next time.
3. The terminal shows: `Press Enter when you have closed VLC…`
4. Close VLC, switch back to Termux, press Enter.
5. The player asks: `Did you finish the episode? [Y/n]`
6. If you answer no, it asks where you stopped (e.g. `32:10`) so your position is saved.

### GrapheneOS notes

- `file://` URIs are blocked across apps by GrapheneOS — the player always passes the HTTP URL to VLC instead of a local file path, which avoids this restriction entirely.
- `termux-am` (from Termux:API) is used to fire the Intent. If Termux:API is not installed, it falls back to bare `am start`.
- `dumpsys` is not available without `DUMP` permission, so the player does not use it.

### Video cache location

On Termux, videos are cached to `/storage/emulated/0/player-cache/` by default (so VLC can access them via shared storage). Override with:

```bash
export PLAYER_TERMUX_VIDEO_DIR=/storage/emulated/0/MyFolder
```

## Data & Files

| Path | Purpose |
|------|---------|
| `<project>/.mpv-web-player/progress.json` | Watch progress store |
| `<project>/.mpv-web-player/cache/` | Episode list cache (1 h TTL) |
| `<project>/video-cache/` | Downloaded video files (desktop) |
| `/storage/emulated/0/player-cache/` | Downloaded video files (Termux) |

Override the config root:

```bash
export PLAYER_CONFIG_DIR=/path/to/dir
```

## ArvanCloud S3 Sync

Progress can be synced across devices (e.g. desktop ↔ phone) via an ArvanCloud S3 bucket. The sync file is stored as `mpv-progress.json` in the bucket.

### Setup

Create a bucket in the [ArvanCloud console](https://panel.arvancloud.ir), then set these environment variables:

```bash
export PLAYER_ARVAN_ACCESS_KEY="your-access-key"
export PLAYER_ARVAN_SECRET_KEY="your-secret-key"
export PLAYER_ARVAN_BUCKET="your-bucket-name"
export PLAYER_ARVAN_REGION="ir-thr-at1"   # default, change if needed
```

Put these in your shell RC file (`~/.bashrc`, `~/.zshrc`, or Termux's `~/.bashrc`) so they are set on every session.

### How sync works

- **On startup:** the player pulls the remote progress file and merges it with the local store. Remote entries only win if they are further ahead (higher season/episode/timestamp, or marked finished).
- **During playback:** progress is saved locally after every episode and pushed to ArvanCloud with a 30-second debounce.
- **On exit:** any pending push is flushed before the process ends.
- **Deletions** are tracked in a deletion log so removed entries are not re-imported from the remote.
- **Force sync** from the TUI: press `s`.

### Merge rules

The merge is one-way-wins-if-ahead: whichever side (local or remote) is further along in the series keeps its value. Progress is never rolled back by a sync.

### Conflict between devices

If you watch on two devices without syncing in between, the one that is further ahead wins on the next pull. No manual conflict resolution needed.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYER_ARVAN_ACCESS_KEY` | — | ArvanCloud access key (enables sync) |
| `PLAYER_ARVAN_SECRET_KEY` | — | ArvanCloud secret key |
| `PLAYER_ARVAN_BUCKET` | — | S3 bucket name |
| `PLAYER_ARVAN_REGION` | `ir-thr-at1` | ArvanCloud region |
| `PLAYER_CONFIG_DIR` | `<project>/.mpv-web-player` | Override config/progress directory |
| `PLAYER_TERMUX_VIDEO_DIR` | `/storage/emulated/0/player-cache` | Override video cache dir on Termux |
| `PLAYER_CURL_CONNECT_TIMEOUT` | `20` | curl connect timeout in seconds |
| `PLAYER_CURL_RETRY` | `5` | curl built-in retry count |
| `PLAYER_CURL_RETRY_DELAY` | `3` | Seconds between curl retries |
| `PLAYER_CURL_DISABLE_RANGE` | `0` | Set to `1` to disable Range requests (some CDNs) |
| `PLAYER_MIN_BUFFER_KB` | `256` | Minimum KB on disk before mpv starts (desktop) |
| `PLAYER_MPV_NO_TERMINAL` | `1` | Set to `0` to show mpv's own terminal output |
| `PLAYER_STREAM_FALLBACK` | `1` | Set to `0` to disable HTTP fallback if cache is empty |
| `PLAYER_DISABLE_SEEK_AHEAD` | `0` | Set to `1` to disable curl seek-ahead on resume |

## Import/Export

The series-project JSON format is an array of objects, each with:

- `id` — e.g. `player_my_show`
- `title`, `year`, `rating`
- `isMovie`
- `playerData` — the full `SeriesProgress` object (`url`, `season`, `episode`, `timestamp`, `finished`, `manualUrls`, etc.)

Use TUI `i` / `x` to import and export, or CLI:

```bash
npx tsx player.ts import /path/to/file.json
npx tsx player.ts export
```

Use TUI `u` to deduplicate a series JSON file (removes entries with duplicate IDs, keeping the one further ahead).

## How Caching and Resume Work

### Progress model

Each entry in the progress store contains:

- `url` — series directory URL or direct episode/movie URL
- `season`, `episode` — 0-based episode index within the season
- `timestamp` — playback position in seconds
- `finished` — true when the series or movie is fully watched
- `manualUrls` — optional ordered list of episode URLs for manual sources

Progress is saved after every key event: episode start, episode end, position poll during playback, and on exit.

### Episode resolution

When you play a series the player resolves the episode list in this order:

1. If `manualUrls` are saved, use them directly — no network request.
2. Otherwise fetch the directory listing at the season URL, scrape video links, and sort by episode number.

If no episodes are found, you are prompted to paste URLs manually. These are saved as `manualUrls` for future runs.

### Desktop: local file caching

On desktop, playback always runs from a local file in `video-cache/`:

- `curl` starts downloading immediately.
- mpv starts only after at least 256 KB (configurable) is on disk so the container header is valid.
- mpv reads from the growing local file while curl keeps writing.
- If playback is about to outrun the download, mpv is paused and resumed once enough data is buffered.
- Cache state (MB downloaded, percent, state) is shown as an OSD message in mpv.
- If a partial file exists from a previous run, the download resumes from the current file size.

### Android/Termux: remote streaming

On Termux, VLC is given the **remote HTTP URL** directly rather than a local file. VLC handles its own streaming and seeking natively. `curl` still downloads the file in the background as a cache for the next time the same episode is played, but playback does not depend on it.

### Resume behavior

- When you stop, the current timestamp is saved.
- On the next run, playback resumes from that timestamp (`--start=<seconds>` for mpv, position Intent extra for VLC).
- When an episode ends within 60 seconds of the end (or past 95% of duration), the player automatically advances to the next episode and resets the timestamp to 0.

### Download retries

`curl` retries automatically on partial transfers (exit code 18 — server closed early) and connection errors (exit codes 6, 7, 28), up to 20 attempts with exponential backoff. The player keeps playing from the local file uninterrupted while retries happen in the background.

### Prefetch

While you watch episode N, the player prefetches episode N+1 in the background so the next episode is ready (or partially downloaded) when you continue.

### Deleting cache

After playback ends you are offered the option to delete the local cache file. This removes only the video file — your watch progress is unaffected.

## Notes

- TLS certificate verification is disabled (`-k` in curl, `NODE_TLS_REJECT_UNAUTHORIZED=0`) to handle self-signed or misconfigured CDN hosts common in the target use case.
- If a URL is unreachable, playback will fail with a curl or mpv error. Check the link or the server.
- The episode list cache has a 1-hour TTL. If a server updates its episode list, use TUI `e` → change URL to force a refresh, or wait for the TTL to expire.

## Thanks

Thanks to [Narixius](https://github.com/Narixius/) for having this idea and help me through that.
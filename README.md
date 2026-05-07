# Player

Terminal-first media player with a fast TUI, a CLI mode, local progress tracking, and optional ArvanCloud S3 sync.

## Features

- TUI with keyboard-first navigation and search
- CLI mode for quick play and management
- Auto resume per series/episode or movie
- Series directory scraping with episode ordering
- Manual URL lists (paste multiple episode URLs)
- Local caching and background prefetch
- Download resume with retry on partial transfers
- Delete local cache files
- Hardsub export helper (if `stoh` + `ffprobe` are installed)
- Import/export to the series-project JSON format
- Deduplicate series-project JSON files
- Optional ArvanCloud S3 sync
- Termux/VLC support on Android

## Requirements

- Node.js 18+ (tested on Node 22)
- `mpv` for desktop playback
- `curl` for downloads
- Optional: `stoh` + `ffprobe` for hardsub

## Install

```bash
npm i
# or
npm i -g tsx
```

## Run (TUI)

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

List, export, import:

```bash
npx tsx player.ts list
npx tsx player.ts export
npx tsx player.ts import /path/to/series.json
```

## TUI Keys

- `j`/`k` or arrows: move
- `enter`: play selected
- `/`: search
- `n`: new entry
- `e`: edit entry
- `f`: toggle finished
- `r`: rename
- `d`: delete
- `D`: multi-delete
- `i`: import
- `x`: export
- `u`: dedupe series JSON file
- `s`: force sync
- `q`: quit

## Mobile / Termux

When the terminal is narrow (e.g. Termux), the UI switches to a single-column layout:

- The list fills the screen
- `Tab` toggles between list and detail panels
- All actions still work, just in a stacked view

## Data & Files

- Progress is stored in `~/.mpv-web-player/progress.json`
- Cache directory: `~/.mpv-web-player/cache`
- Video cache: `video-cache/` in the project folder
- Import/export uses the series-project JSON array format

## Import/Export

The series-project JSON format is an array of entries, each containing:

- `id` (e.g. `player_my_show`)
- `title`, `year`, `rating`
- `playerData` with `url`, `season`, `episode`, `timestamp`, `finished`, etc.

Use TUI `i` to import and `x` to export. Use `u` to dedupe a series JSON file.

## ArvanCloud S3 Sync (Optional)

Set the following environment variables:

- `PLAYER_ARVAN_ACCESS_KEY`
- `PLAYER_ARVAN_SECRET_KEY`
- `PLAYER_ARVAN_BUCKET`
- `PLAYER_ARVAN_REGION` (default: `ir-thr-at1`)

When configured, progress is pulled at startup and pushed periodically.

## Notes

- If a URL is unreachable, playback will fail (curl/mpv error). Check the host or link.
- TLS warnings appear because the app disables certificate verification for some hosts.

## How Caching and Resume Work (Detailed)

### Progress model

Each entry stores:

- `url`: base series directory URL or a direct episode/movie URL
- `season` and `episode`: 0-based episode index
- `timestamp`: current playback position in seconds
- `finished`: true when a series or movie is completed
- `manualUrls` (optional): a full list of episode URLs for manual sources

Progress is saved to `~/.mpv-web-player/progress.json` after key events and during playback.

### Episode resolution

When playing a series, the app resolves a list of episode URLs in this order:

1. If `manualUrls` exist, use them directly (no network request).
2. Otherwise, fetch the directory listing at the season URL, scrape links, and sort by episode number.

If no episodes are found, playback is aborted and you can provide manual URLs in the CLI or edit the entry in the TUI.

### Local file caching

Playback is always done from a local file in `video-cache/` (project folder). The file is created by `curl` while playback is running:

- The download starts immediately.
- Playback starts only after a small buffer is present on disk so the container header is valid.
- The file grows as `curl` downloads more data.

If the local file already exists, the player uses it and reports how many MB are already on disk.

### Resume behavior

Resume is driven by `timestamp` in the progress store:

- When you stop playback, the current time is saved.
- On the next run, mpv is started with `--start=timestamp` so playback resumes.

For series, the current episode index and timestamp are saved. When an episode ends near the end (within the threshold), the player advances to the next episode and resets timestamp to 0.

### Download retries and buffer control

The downloader uses `curl` and retries on partial transfers (exit 18):

- If the server drops the connection, `curl` restarts from the current file size.
- The player keeps playing from the same local file while downloads resume.

The TUI/CLI polling loop checks how many seconds are downloaded versus current playback time. If playback is about to outrun the download, it pauses mpv and resumes once enough data is buffered.

### Prefetch

While you are watching episode N, the player prefetches episode N+1 in the background to reduce wait time for the next episode.

### Deleting cache

After playback ends, you can delete the local cache file. This only removes the local file, not your progress.

## Thanks

Thanks to [Narixius](https://github.com/Narixius/) for making this idea alive.

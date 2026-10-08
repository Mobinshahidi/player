#!/usr/bin/env node
// player/tui.ts — full-screen blessed TUI for media player
// NOTE: Does NOT import from player.ts (it calls main() at module level and
//       would immediately launch the CLI). Playback uses player-core directly.

import blessed from "blessed";
import { execSync, spawn } from "child_process";
import * as readline from "readline";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import {
  store,
  initStore,
  saveProgress,
  removeEntry,
  flushSync,
  schedulePush,
  storeEmitter,
  syncStatus,
  findMpv,
  renderProgress,
  formatTime,
  fuzzyMatch,
  sanitiseKey,
  importFromFile,
  applyImport,
  exportToFile,
  CLOUD_SYNC,
  getStorageBootstrapState,
  getPreferredSecretsPath,
  setStorageModeChoice,
  IS_TERMUX,
  CONFIG_DIR,
  deleteVideoCache,
  isDirectVideoUrl,
  isYouTubeUrl,
  playWithMpv,
  resolveEpisodes,
  getSeasonUrl,
  splitUrlBlock,
  extractEpisodeNumber,
  getEpisodeTimestamp,
  setEpisodePosition,
  seriesHasMultipleSeasons,
  mergeEpisodeTimestamps,
  ensureSeriesSource,
  refreshSeriesSource,
  scrapeSeriesSource,
  resolveSeriesPage,
  isSeriesPageHtml,
  episodeKeyFromUrl,
} from "./player-core.js";
import type {
  SeriesProgress,
  ScrapeResult,
  ImportPreview,
  SeriesProjectEntry,
  VlcPrompts,
} from "./player-core.js";

// ─── COLOR PALETTE ────────────────────────────────────────────────────────────

// ─── COLOR PALETTE ────────────────────────────────────────────────────────────
// Termux's default terminal doesn't advertise COLORTERM=truecolor, so blessed
// maps 24-bit hex values to the nearest xterm-256 color — which turns #d57455
// into bright red. Detect truecolor support and fall back to named colors.
const hasTruecolor =
  process.env.COLORTERM === "truecolor" ||
  process.env.COLORTERM === "24bit";

const BG          = hasTruecolor ? "#1e1e1d" : "black";
const BORDER      = hasTruecolor ? "#3a3a38" : "grey";
const SELECTED_BG = hasTruecolor ? "#d57455" : "yellow";
const SELECTED_FG = hasTruecolor ? "#1e1e1d" : "black";
const FINISHED_FG = hasTruecolor ? "#6b6b64" : "grey";
const WATCHING_FG = hasTruecolor ? "#d57455" : "yellow";
const NEUTRAL     = hasTruecolor ? "#c3c2b7" : "white";
const HINT        = hasTruecolor ? "#6b6b64" : "grey";
const HEADER_BG   = hasTruecolor ? "#161615" : "black";
const ACCENT      = hasTruecolor ? "#d57455" : "yellow";
const LOG_PATH    = join(CONFIG_DIR, "player-tui.log");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function prettifyKey(key: string): string {
  return key.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function parseUrlInput(raw: string): string[] {
  const urls = splitUrlBlock(raw)
    .map((u) => u.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  if (out.length > 1) {
    out.sort((a, b) => extractEpisodeNumber(a) - extractEpisodeNumber(b));
  }
  return out;
}

function ensureLogDir(): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {}
}

function logToFile(msg: string): void {
  try {
    ensureLogDir();
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function promptOnce(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function maybeRunStorageSetupTui(): Promise<void> {
  const bootstrap = getStorageBootstrapState();
  if (!bootstrap.needsPrompt) return;
  console.log(
    "\nDo you want to store your data locally only, or sync to a cloud provider (Arvan, AWS S3, Cloudflare R2, etc.)?",
  );
  const ans = (await promptOnce("Choose [local/cloud]: ")).toLowerCase();
  const mode = ans.startsWith("c") ? "cloud" : "local";
  if (mode === "local") {
    setStorageModeChoice("local");
    console.log("✓ Using local-only storage.");
    return;
  }
  setStorageModeChoice("cloud");
  console.log(
    "\nCloud sync selected. You can keep using local mode until the secrets file is present.",
  );
  console.log("Steps to enable cloud sync:");
  console.log("  1) Create an account and a bucket with your provider.");
  console.log("  2) Generate an access key and secret key.");
  console.log(
    `  3) Create a secrets file at: ${getPreferredSecretsPath()}`,
  );
  console.log("  4) Restart the app.\n");
}

function sortEpisodeUrls(urls: string[]): string[] {
  return [...urls].sort((a, b) => {
    const ka = episodeKeyFromUrl(a);
    const kb = episodeKeyFromUrl(b);
    if (ka && kb) {
      const [sa, ea] = ka.split(":").map(Number);
      const [sb, eb] = kb.split(":").map(Number);
      return sa! - sb! || ea! - eb!;
    }
    return extractEpisodeNumber(a) - extractEpisodeNumber(b);
  });
}

async function offerHardsubTui(localPath: string): Promise<void> {
  if (!existsSync(localPath)) return;
  try {
    execSync("which stoh", { stdio: "ignore" });
  } catch {
    return;
  }
  const want = await confirmDialog("Create hardsub from this episode?", "Create");
  if (!want) return;
  const rawDir = await promptText("Hardsub", "Output folder:", join(localPath, ".."));
  if (rawDir === null) return;
  const outputDir = rawDir || join(localPath, "..");
  const displayName = localPath.split("/").pop() ?? localPath;
  showInfo(`Hardsub started: ${displayName}`);
  let totalSeconds = 0;
  try {
    const probe = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "${localPath}"`,
      { encoding: "utf-8" },
    ).trim();
    totalSeconds = parseFloat(probe) || 0;
  } catch {}
  const proc = spawn("stoh", [localPath, "-t", "0", "-d", outputDir], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  function parseFfmpegTime(line: string): number | null {
    const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return null;
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  }
  let hadProgress = false;
  function handleOutput(data: Buffer) {
    for (const line of data.toString().split(/[\r\n]+/)) {
      const t = parseFfmpegTime(line);
      if (t === null) continue;
      const pct =
        totalSeconds > 0
          ? ` (${Math.min(100, Math.round((t / totalSeconds) * 100))}%)`
          : "";
      showInfo(`Hardsub ${displayName} ${formatTime(Math.round(t))}${pct}`);
      hadProgress = true;
    }
  }
  proc.stdout?.on("data", handleOutput);
  proc.stderr?.on("data", handleOutput);
  proc.on("exit", (code) => {
    if (!hadProgress) return;
    if (code === 0) showInfo(`Hardsub done: ${displayName}`);
    else showError(`Hardsub failed (exit ${code}): ${displayName}`);
  });
}

async function promptAfterFinishedTui(key: string, p: SeriesProgress): Promise<void> {
  if (p.isOnetime) {
    removeEntry(key);
    showInfo(`Removed: ${prettifyKey(key)}`);
    return;
  }
  const ans = await promptText(
    "Finished",
    "Choose: r=remove, f=mark finished, Enter=keep",
    "f",
  );
  if (ans === null) return;
  const v = ans.trim().toLowerCase();
  if (v === "r") {
    removeEntry(key);
    showInfo(`Removed: ${prettifyKey(key)}`);
  } else if (v === "" || v === "f") {
    saveProgress(key, { ...p, finished: true });
    showInfo(`Marked finished: ${prettifyKey(key)}`);
  }
}

function wrapText(text: string, max: number): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let line = "";
  for (const w of words) {
    if (!line) {
      line = w;
      continue;
    }
    if ((line + " " + w).length > max) {
      out.push(line);
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [text];
}

function hasKitty(): boolean {
  try {
    execSync("which kitty", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shouldPlayInKitty(): boolean {
  return !IS_TERMUX && hasKitty() && process.env.PLAYER_PLAY_IN_KITTY === "1";
}

function showCacheHelp(): void {
  modalOpen = true;
  const box = makeModal({ title: "Cache Help", width: "70%", height: 18 });
  const lines = [
    "",
    "  Common fixes:",
    "  - Slow start: set PLAYER_MIN_BUFFER_KB=128",
    "  - Timeouts: set PLAYER_CURL_CONNECT_TIMEOUT=30",
    "  - CDN range bugs: set PLAYER_CURL_DISABLE_RANGE=1",
    "  - Seek stalls: set PLAYER_DISABLE_SEEK_AHEAD=1",
    "",
    "  Current settings:",
    `  PLAYER_MIN_BUFFER_KB=${process.env.PLAYER_MIN_BUFFER_KB ?? "(default 256)"}`,
    `  PLAYER_CURL_CONNECT_TIMEOUT=${process.env.PLAYER_CURL_CONNECT_TIMEOUT ?? "(default 20)"}`,
    `  PLAYER_CURL_RETRY=${process.env.PLAYER_CURL_RETRY ?? "(default 5)"}`,
    `  PLAYER_CURL_DISABLE_RANGE=${process.env.PLAYER_CURL_DISABLE_RANGE ?? "(default 0)"}`,
    `  PLAYER_DISABLE_SEEK_AHEAD=${process.env.PLAYER_DISABLE_SEEK_AHEAD ?? "(default 0)"}`,
    "",
    `  Log file: ${LOG_PATH}`,
    "",
    "  Press any key to close",
  ];
  box.setContent(lines.join("\n"));
  const close = () => { box.destroy(); modalOpen = false; listBox.focus(); screen.render(); };
  setTimeout(() => {
    screen.once("keypress", close);
    box.key(["escape", "q", "enter", "space"], close);
    box.focus();
    screen.render();
  }, 0);
}

const tuiVlcPrompts: VlcPrompts = {
  yn: async (question: string) => {
    return confirmDialog(question, "Yes");
  },
  ask: async (question: string) => {
    const ans = await promptText("VLC", question, "");
    return ans ?? "";
  },
};

// ─── STATE ────────────────────────────────────────────────────────────────────

let displayItems: (string | null)[] = []; // null = divider row
let currentIdx = 0;
let focusedPanel: "list" | "detail" = "list";
let modalOpen = false;
let errorTimer: ReturnType<typeof setTimeout> | null = null;
let MPV = "";
let tuiActive = false;
let ignoreEnterUntil = 0;
let lastKeyShift = false;
let layoutMode: "wide" | "narrow" = "wide";
let showDetailInNarrow = false;
let cacheStatus = "";
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

// ─── WIDGETS ──────────────────────────────────────────────────────────────────

let screen: blessed.Widgets.Screen;
let headerBox: blessed.Widgets.BoxElement;
let listBox: blessed.Widgets.ListElement;
let detailBox: blessed.Widgets.BoxElement;
let footerBox: blessed.Widgets.BoxElement;
let errorBar: blessed.Widgets.BoxElement;

// ─── DISPLAY ITEMS ────────────────────────────────────────────────────────────

function buildDisplayItems(): (string | null)[] {
  const regular: string[] = [];
  const onetime: string[] = [];
  for (const key of Object.keys(store)) {
    (store[key].isOnetime ? onetime : regular).push(key);
  }
  const cmp = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
  regular.sort(cmp);
  onetime.sort(cmp);
  const out: (string | null)[] = [...regular];
  if (onetime.length > 0) { out.push(null); out.push(...onetime); }
  return out;
}

// ─── LIST FORMATTING ──────────────────────────────────────────────────────────

function formatListItem(key: string | null): string {
  if (key === null) return `{${HINT}-fg}  ── one-time ──{/}`;
  const p = store[key];
  if (!p) return `  ${key}`;
  const maxName = layoutMode === "narrow" ? 20 : 26;
  const name = prettifyKey(key).padEnd(maxName).slice(0, maxName);
  const prog = renderProgress(p);
  const badge = p.newEpisodeCount && p.newEpisodeCount > 0
    ? ` {${ACCENT}-fg}+${p.newEpisodeCount} new{/}`
    : "";
  const spacer = layoutMode === "narrow" ? " " : "  ";
  const text = `  ${name}${spacer}${prog}${badge}`;
  if (p.finished) return `{${FINISHED_FG}-fg}${text}{/}`;
  if (p.episode > 0 || p.timestamp > 0) return `{${WATCHING_FG}-fg}${text}{/}`;
  return `{${NEUTRAL}-fg}${text}{/}`;
}

// ─── REFRESH LIST ─────────────────────────────────────────────────────────────

function refreshList(): void {
  const prevKey = displayItems[currentIdx] ?? null;
  displayItems = buildDisplayItems();

  let idx = prevKey ? displayItems.indexOf(prevKey) : -1;
  if (idx === -1) idx = displayItems.findIndex((k) => k !== null);
  if (idx === -1) idx = 0;
  currentIdx = idx;

  (listBox as any).setItems(displayItems.map((k) => formatListItem(k)));
  listBox.select(currentIdx);
  updateDetail();
}

// ─── APPLY SELECTION (moves cursor + redraws list items) ──────────────────────

function applySelect(idx: number): void {
  currentIdx = idx;
  listBox.select(currentIdx);
  updateDetail();
  screen.render();
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

function moveUp(): void {
  let i = currentIdx - 1;
  while (i >= 0 && displayItems[i] === null) i--;
  if (i >= 0) applySelect(i);
}
function moveDown(): void {
  let i = currentIdx + 1;
  while (i < displayItems.length && displayItems[i] === null) i++;
  if (i < displayItems.length) applySelect(i);
}
function goTop(): void {
  const i = displayItems.findIndex((k) => k !== null);
  if (i !== -1) applySelect(i);
}
function goBottom(): void {
  let i = displayItems.length - 1;
  while (i >= 0 && displayItems[i] === null) i--;
  if (i >= 0) applySelect(i);
}
function selectedKey(): string | null {
  return displayItems[currentIdx] ?? null;
}

// ─── HEADER / FOOTER / DETAIL ─────────────────────────────────────────────────

function updateHeader(): void {
  let sync = "";
  if (CLOUD_SYNC) {
    const s = syncStatus as string;
    const sym = s === "ok" ? "✓" : s === "syncing" ? "↻" : s === "error" ? "✗" : "·";
    const col = s === "ok" ? "#5faf5f" : s === "error" ? "#cf6679" : HINT;
    sync = `  {${col}-fg}[sync: ${sym}]{/}`;
  }
  const total = Object.keys(store).length;
  if (layoutMode === "narrow") {
    headerBox.setContent(
      `{bold}{${ACCENT}-fg} player{/}{/}  {${HINT}-fg}[${total}]{/}${sync}`,
    );
    return;
  }
  headerBox.setContent(
    `{bold}{${ACCENT}-fg}  🎬  player{/}{/}${sync}   {${HINT}-fg}[total: ${total}]  [/] Search  [?] Help{/}`
  );
}

function updateFooter(): void {
  if (layoutMode === "narrow") {
    const cacheHint = cacheStatus ? `  ${cacheStatus}` : "";
    footerBox.setContent(
      `{${HINT}-fg}  [t] Detail  [/] Search  [n] New  [q] Quit{/}\n` +
      `{${HINT}-fg}  [c] Cache help${cacheHint}{/}`
    );
    return;
  }
  const cacheHint = cacheStatus ? `  ${cacheStatus}` : "";
  footerBox.setContent(
    `{${HINT}-fg}  [n] New   [/] Search   [i] Import   [x] Export   [u] Dedupe file   [c] Cache help   [D] Multi-delete   [q] Quit${cacheHint}{/}`
  );
}

function updateDetail(): void {
  const key = displayItems[currentIdx];
  if (!key) { detailBox.setContent(""); return; }
  const p = store[key];
  if (!p) { detailBox.setContent(""); return; }

  const type   = p.isMovie ? "Movie" : p.isOnetime ? "One-time" : "Series";
  const ts     = p.timestamp > 0 ? formatTime(p.timestamp) : "—";
  const maxUrl = Math.max(10, (detailBox.width as number) - 6);
  const url    = p.url.length > maxUrl ? p.url.slice(0, maxUrl - 1) + "…" : p.url;
  const maxText = Math.max(10, (detailBox.width as number) - 6);
  const genres = p.genres && p.genres.length > 0 ? p.genres.join(", ") : "";
  const overview = p.overview ?? "";
  const upd    = relativeTime(p.updatedAt);
  const fStr   = p.finished
    ? `{${FINISHED_FG}-fg}✓ Finished{/}`
    : `{${WATCHING_FG}-fg}● Watching{/}`;

  const lines = [
    "",
    `  {bold}{${ACCENT}-fg}${prettifyKey(key)}{/}{/}`,
    `  {${NEUTRAL}-fg}${renderProgress(p)}{/}`,
    "",
    `  {${HINT}-fg}Type    {/}  ${type}`,
    `  {${HINT}-fg}Status  {/}  ${fStr}`,
    ...(!p.isMovie && !p.isOnetime
      ? [`  {${HINT}-fg}Season  {/}  ${p.season}`, `  {${HINT}-fg}Episode {/}  ${p.episode + 1}`]
      : []),
    `  {${HINT}-fg}Time    {/}  ${ts}`,
    `  {${HINT}-fg}URL     {/}  {${NEUTRAL}-fg}${url}{/}`,
    ...(genres
      ? [`  {${HINT}-fg}Genres  {/}  {${NEUTRAL}-fg}${genres}{/}`]
      : []),
    ...(overview
      ? [
          `  {${HINT}-fg}Overview{/}  {${NEUTRAL}-fg}${wrapText(overview, maxText)[0]}{/}`,
          ...wrapText(overview, maxText).slice(1).map(
            (line) => `  {${NEUTRAL}-fg}${line}{/}`,
          ),
        ]
      : []),
    ...(p.manualUrls?.length ? [`  {${HINT}-fg}URLs    {/}  ${p.manualUrls.length} manual`] : []),
    ...(upd ? [`  {${HINT}-fg}Updated {/}  ${upd}`] : []),
    "",
    `  {${HINT}-fg}[Enter] Play  [e] Edit  [f] Finish  [d] Delete{/}`,
  ];
  detailBox.setContent(lines.join("\n"));
}

// ─── ERROR / INFO BAR ─────────────────────────────────────────────────────────

function showMessage(msg: string, isInfo = false): void {
  const col = isInfo ? "#5faf5f" : "#cf6679";
  errorBar.setContent(`  {${col}-fg}${isInfo ? "✓" : "✗"} ${msg}{/}`);
  errorBar.show();
  screen.render();
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { errorBar.hide(); screen.render(); }, 5000);
}
const showError = (msg: string) => showMessage(msg, false);
const showInfo  = (msg: string) => showMessage(msg, true);

function forceRefresh(): void {
  updateHeader();
  refreshList();
  screen.render();
  setTimeout(() => screen.render(), 0);
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")
    .slice(0, 240);
}

function formatCacheStatus(info: {
  state: string;
  downloadedBytes: number;
  totalBytes: number;
}): string {
  const mb = (info.downloadedBytes / 1_048_576).toFixed(1);
  const pct =
    info.totalBytes > 0
      ? ` ${(info.downloadedBytes / info.totalBytes * 100).toFixed(1)}%`
      : "";
  const state = info.state === "downloading" ? "dl" : info.state;
  return `Cache:${mb}MB${pct} ${state}`;
}

function setCacheStatusLine(text: string): void {
  cacheStatus = text;
  updateFooter();
  screen.render();
}

function appRootDir(): string {
  const script = process.argv[1];
  return script ? dirname(resolve(script)) : process.cwd();
}

function resolveInAppPath(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath.startsWith("/")) return inputPath;
  if (inputPath.startsWith("~")) return join(homedir(), inputPath.slice(1));
  return join(appRootDir(), inputPath);
}

function shouldIgnoreEnter(): boolean {
  return Date.now() < ignoreEnterUntil;
}

function isNarrowLayout(): boolean {
  const w = Number(screen?.width ?? 0);
  return w > 0 && w < 90;
}

function applyLayout(): void {
  if (!screen || !listBox || !detailBox) return;
  const narrow = isNarrowLayout();
  layoutMode = narrow ? "narrow" : "wide";

  footerBox.height = (narrow ? 2 : 1) as any;
  listBox.bottom = (narrow ? 3 : 2) as any;
  detailBox.bottom = (narrow ? 3 : 2) as any;

  (listBox as any).border = { type: narrow ? "none" : "line" };
  (detailBox as any).border = { type: narrow ? "none" : "line" };

  if (narrow) {
    listBox.width = "100%" as any;
    detailBox.left = 0 as any;
    detailBox.right = 0 as any;
    detailBox.width = "100%" as any;
    if (showDetailInNarrow) {
      listBox.hide();
      detailBox.show();
      focusedPanel = "detail";
      detailBox.focus();
    } else {
      detailBox.hide();
      listBox.show();
      focusedPanel = "list";
      listBox.focus();
    }
  } else {
    showDetailInNarrow = false;
    listBox.show();
    detailBox.show();
    listBox.width = "40%" as any;
    detailBox.left = "40%" as any;
    detailBox.right = 0 as any;
    focusedPanel = "list";
    listBox.focus();
  }
  updateHeader();
  updateFooter();
  updateDetail();
  screen.render();
}

function hookConsole(): void {
  console.log = (...args: unknown[]) => {
    if (tuiActive) showInfo(formatConsoleArgs(args));
    else originalConsole.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (tuiActive) showError(formatConsoleArgs(args));
    else originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (tuiActive) showError(formatConsoleArgs(args));
    else originalConsole.error(...args);
  };
}

function setTuiActive(active: boolean): void {
  tuiActive = active;
}

function tryDetachToKitty(scriptPath: string, extraArgs: string[]): boolean {
  if (!hasKitty()) return false;
  try {
    const child = spawn(
      "kitty",
      [
        "--title",
        "player",
        "--directory",
        process.cwd(),
        "npx",
        "tsx",
        scriptPath,
        "--detached",
        ...extraArgs,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ─── PLAYBACK ─────────────────────────────────────────────────────────────────

async function playSelected(): Promise<void> {
  const key = selectedKey();
  if (!key) return;
  const p = store[key];
  if (!p) return;

  if (p.newEpisodeCount && p.newEpisodeCount > 0) {
    saveProgress(key, { ...p, newEpisodeCount: 0 });
  }

  let playError: string | null = null;
  const playInKitty = shouldPlayInKitty();
  const vlcPrompts = IS_TERMUX ? tuiVlcPrompts : undefined;
  let isYouTubeVideo = isYouTubeUrl(p.url);
  
  // Handle YouTube proxy restart
  if (isYouTubeVideo && p.overview?.includes("VPN/proxy enabled")) {
    const restartTui = await confirmDialog(
      "YouTube video finished. Should we restart TUI with proxy disabled to sync with Arvan?",
      "Restart"
    );
    if (restartTui) {
      setTuiActive(false);
      if (IS_TERMUX) {
        screen.program.showCursor();
        screen.program.normalBuffer();
        process.stdout.write("\x1b[2J\x1b[H");
      } else {
        (screen as any).leave?.();
      }
      // Restart TUI without proxy for next session
      process.env.PLAYER_YOUTUBE_PROXY = "disabled";
      setTimeout(() => {
        require('./tui.js');
      }, 1000);
      return;
    }
  }
  
  if (!playInKitty) {
    setTuiActive(false);
    if (IS_TERMUX) {
      // screen.leave() does not exist on blessed's Screen object — it's a no-op.
      // Use the Program-level buffer switch so the terminal is clean for VLC.
      screen.program.showCursor();
      screen.program.normalBuffer();
      process.stdout.write("\x1b[2J\x1b[H");
    } else {
      (screen as any).leave?.();
    }
  }
  try {
    if ((p.isMovie || isDirectVideoUrl(p.url)) && !p.manualUrls?.length) {
      if (playInKitty) setCacheStatusLine("Cache: starting");
      const startTime = getEpisodeTimestamp(p, p.url, p.season, p.episode);
      const result = await playWithMpv(
        MPV, p.url, startTime,
        (time) => {
          const cur = store[key] ?? p;
          saveProgress(key, setEpisodePosition(cur, p.url, p.season, p.episode, time));
        },
        key,
        vlcPrompts,
        {
          cacheOffsetHint: p.cacheOffset ?? 0,
          onCache: playInKitty
            ? (info) => setCacheStatusLine(formatCacheStatus(info))
            : undefined,
        },
      );
      if (result.finalPosition) {
        const cur = store[key] ?? p;
        saveProgress(key, setEpisodePosition(cur, p.url, p.season, p.episode, result.finalPosition.time));
      }
      await offerHardsubTui(result.localPath);
      if (await confirmDialog("Delete local cache file?", "Delete")) {
        deleteVideoCache(p.url, key);
      }
      if (result.endReason === "near_end") {
        await promptAfterFinishedTui(key, store[key] ?? p);
      }
    } else {
      if (!p.manualUrls?.length) {
        showInfo("Fetching series episodes...");
        await ensureSeriesSource(p);
        if (p.manualUrls?.length) saveProgress(key, p);
      }
      const seasonRaw = await promptText(
        "Start",
        "Season (Enter = keep):",
        String(p.season),
      );
      if (seasonRaw === null) return;
      const seasonVal = parseInt(seasonRaw.trim(), 10);
      let season = !isNaN(seasonVal) && seasonVal > 0 ? seasonVal : p.season;

      const epRaw = await promptText(
        "Start",
        "Episode (1-based, Enter = keep):",
        String(p.episode + 1),
      );
      if (epRaw === null) return;
      const epVal = parseInt(epRaw.trim(), 10);
      let episode = !isNaN(epVal) && epVal > 0 ? epVal - 1 : p.episode;

      if (season !== p.season || episode !== p.episode) {
        saveProgress(key, { ...(store[key] ?? p), season, episode, timestamp: 0 });
      }

      const canIterateSeasons =
        (!isDirectVideoUrl(p.url) && getSeasonUrl(p.url, 1) !== getSeasonUrl(p.url, 2)) ||
        seriesHasMultipleSeasons(p);

      while (true) {
        let episodes: string[] = [];
        const manualUrls = p.manualUrls ?? [];
        if (manualUrls.length > 0) {
          const tagged = manualUrls.filter((u) => /[Ss]\d+[Ee]\d+/.test(u));
          const seasonUrls = tagged.length
            ? manualUrls.filter((u) => {
                const m = (u.split("/").pop() ?? "").match(/[Ss](\d+)[Ee]\d+/);
                return m ? parseInt(m[1]!, 10) === season : false;
              })
            : season === 1 ? manualUrls : [];
          episodes = sortEpisodeUrls(seasonUrls);
        } else {
          const seasonUrl = getSeasonUrl(p.url, season);
          episodes = await resolveEpisodes(seasonUrl, p.manualUrls);
        }

        if (episodes.length === 0) {
          if (canIterateSeasons) {
            if (!(await confirmDialog(`No episodes for S${season}. Try next season?`, "Next"))) {
              return;
            }
            season += 1;
            episode = 0;
            continue;
          }
          showError("No episodes found. Check the URL or add manual URLs.");
          return;
        }

        if (episode >= episodes.length) episode = 0;

        while (episode < episodes.length) {
          const epUrl = episodes[episode] ?? p.url;
          const label = key;
          const cur = store[key] ?? p;
          const startTime = getEpisodeTimestamp(cur, epUrl, season, episode);
          const cacheOffsetHint =
            cur.season === season && cur.episode === episode
              ? cur.cacheOffset ?? 0
              : 0;
          if (playInKitty) setCacheStatusLine("Cache: starting");
          const result = await playWithMpv(
            MPV, epUrl, startTime,
            (time) => saveProgress(
              key,
              setEpisodePosition(store[key] ?? p, epUrl, season, episode, time),
            ),
            label,
            vlcPrompts,
            {
              nextEpisodeUrl: episode + 1 < episodes.length
                ? episodes[episode + 1]!
                : undefined,
              cacheOffsetHint,
              onCache: playInKitty
                ? (info) => setCacheStatusLine(formatCacheStatus(info))
                : undefined,
            },
          );
          if (result.finalPosition) {
            saveProgress(
              key,
              setEpisodePosition(store[key] ?? p, epUrl, season, episode, result.finalPosition.time),
            );
          }
          await offerHardsubTui(result.localPath);
          if (await confirmDialog("Delete local cache file?", "Delete")) {
            deleteVideoCache(epUrl, key);
          }

          if (result.endReason !== "near_end") {
            if (episode + 1 < episodes.length) {
              if (await confirmDialog(`Play S${season}E${episode + 2} next?`, "Play")) {
                episode += 1;
                saveProgress(key, {
                  ...(store[key] ?? p),
                  season,
                  episode,
                  timestamp: 0,
                  cacheOffset: 0,
                });
                continue;
              }
            } else {
              await promptAfterFinishedTui(key, store[key] ?? p);
            }
            return;
          }

          episode += 1;
          if (episode >= episodes.length) {
            if (canIterateSeasons && (!p.manualUrls?.length || seriesHasMultipleSeasons(p))) {
              const next = await confirmDialog(`Season ${season} done. Continue to Season ${season + 1}?`, "Continue");
              if (!next) {
                await promptAfterFinishedTui(key, store[key] ?? p);
                return;
              }
              season += 1;
              episode = 0;
              saveProgress(key, {
                ...(store[key] ?? p),
                season,
                episode,
                timestamp: 0,
                cacheOffset: 0,
              });
              break;
            }
            await promptAfterFinishedTui(key, store[key] ?? p);
            return;
          }

          saveProgress(key, {
            ...(store[key] ?? p),
            season,
            episode,
            timestamp: 0,
            cacheOffset: 0,
          });
          if (!(await confirmDialog(`Play S${season}E${episode + 1} next?`, "Play"))) {
            return;
          }
        }
      }
    }
    schedulePush();
  } catch (e) {
    playError = (e as Error).message || "Playback failed";
  }

  if (!playInKitty) {
    if (IS_TERMUX) {
      screen.program.alternateBuffer();
      screen.program.hideCursor();
    } else {
      (screen as any).enter?.();
    }
  }
  refreshList();
  listBox.focus();
  if (!playInKitty) setTuiActive(true);
  if (playInKitty) setCacheStatusLine("");
  if (playError) showError(playError);
  screen.render();
}

// ─── MODAL FACTORY ────────────────────────────────────────────────────────────

function makeModal(opts: { title: string; width?: number | string; height?: number | string }):
    blessed.Widgets.BoxElement {
  const box = blessed.box({
    top: "center", left: "center",
    width: opts.width ?? "50%",
    height: opts.height ?? 10,
    border: { type: "line" },
    label: ` ${opts.title} `,
    tags: true, keys: true, mouse: true,
    style: { bg: BG, fg: NEUTRAL, border: { fg: ACCENT } },
  });
  screen.append(box);
  return box;
}

function closeModal(box: blessed.Widgets.BoxElement): void {
  box.destroy();
  modalOpen = false;
  listBox.focus();
  screen.render();
}

// ─── TEXT PROMPT ──────────────────────────────────────────────────────────────

// blessed's textbox cannot edit mid-line (its textarea appends at the end and
// has no cursor position), so this is a self-contained line editor driven by
// screen-level keypress events — the same pattern showSearchModal uses.
function promptText(title: string, label: string, def = ""): Promise<string | null> {
  return new Promise((resolve) => {
    modalOpen = true;
    const narrow = isNarrowLayout();
    const box = makeModal({
      title,
      width: narrow ? "94%" : "56%",
      height: narrow ? 9 : 8,
    });

    blessed.text({ parent: box, top: 1, left: 2,
      content: label, tags: true, style: { bg: BG, fg: NEUTRAL } });

    const inp = blessed.box({ parent: box, top: 3, left: 2, right: 2, height: 1,
      tags: true, style: { bg: "#2a2a29", fg: NEUTRAL } });

    blessed.text({ parent: box, bottom: 1, left: 2,
      content: `{${HINT}-fg}Enter: ok  Esc: cancel  C-u: clear  C-←/→: word  Home/End{/}`,
      tags: true, style: { bg: BG } });

    let value = def;
    let pos = value.length;
    let lastPrintableAt = 0;

    const esc = (s: string) =>
      s.replace(/\{/g, "{open}").replace(/\}/g, "{close}");

    const render = () => {
      const w = Math.max(4, typeof inp.width === "number" ? inp.width : 40);
      // horizontal scroll window that keeps the cursor visible
      let start = 0;
      if (pos >= w - 1) start = pos - w + 2;
      const view = value.slice(start, start + w - 1);
      const rel = pos - start;
      const at = view.slice(rel, rel + 1);
      inp.setContent(
        `${esc(view.slice(0, rel))}{inverse}${at ? esc(at) : " "}{/inverse}${esc(view.slice(rel + 1))}`,
      );
      screen.render();
    };

    const insert = (s: string) => {
      value = value.slice(0, pos) + s + value.slice(pos);
      pos += s.length;
      render();
    };

    // URLs have no spaces, so treat separators as word boundaries too
    const BOUNDARY = /[\s/=&?._-]/;
    const wordLeft = () => {
      let i = pos;
      while (i > 0 && BOUNDARY.test(value[i - 1]!)) i--;
      while (i > 0 && !BOUNDARY.test(value[i - 1]!)) i--;
      pos = i;
    };
    const wordRight = () => {
      let i = pos;
      while (i < value.length && BOUNDARY.test(value[i]!)) i++;
      while (i < value.length && !BOUNDARY.test(value[i]!)) i++;
      pos = i;
    };

    const pathPrompt = /path|folder/i.test(label);
    const completePath = () => {
      const trimmed = value.trim();
      if (!trimmed) return;
      const expanded = trimmed.startsWith("~")
        ? join(homedir(), trimmed.slice(1))
        : trimmed;
      const lastSlash = expanded.lastIndexOf("/");
      const baseDir = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : "";
      const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;
      const dirPath = baseDir
        ? (baseDir.startsWith("/") ? baseDir : join(appRootDir(), baseDir))
        : appRootDir();

      let entries: string[] = [];
      try {
        entries = readdirSync(dirPath)
          .filter((n) => n.startsWith(prefix))
          .sort((a, b) => a.localeCompare(b));
      } catch {
        return;
      }
      if (entries.length === 0) return;

      const pick = entries[0]!;
      let suffix = "";
      try {
        const st = statSync(join(dirPath, pick));
        if (st.isDirectory()) suffix = "/";
      } catch {}

      const rawBase = trimmed.startsWith("~")
        ? "~" + (baseDir.replace(homedir(), "") || "/")
        : baseDir;
      value = (rawBase || "") + pick + suffix;
      pos = value.length;
      render();
      if (entries.length > 1) {
        showInfo(`Matches: ${entries.slice(0, 6).join(", ")}${entries.length > 6 ? " …" : ""}`);
      }
    };

    const done = (v: string | null) => {
      screen.removeListener("keypress", onKey);
      ignoreEnterUntil = Date.now() + 300;
      closeModal(box);
      resolve(v);
    };

    const onKey = (ch: string | undefined, key: any) => {
      if (!key) return;
      const name: string = key.name ?? "";
      if (name === "return") return; // program re-emits '\r' as a second 'enter' event

      if (name === "escape" || (key.ctrl && name === "c")) return done(null);
      if (name === "enter") {
        // a newline mid-burst is a pasted line break, not a submit — keep it
        // as a separator so multi-URL pastes stay in this field
        if (Date.now() - lastPrintableAt < 15) return insert(" ");
        return done(value.trim());
      }

      if (key.ctrl) {
        switch (name) {
          case "u": value = ""; pos = 0; break;          // clear whole line
          case "k": value = value.slice(0, pos); break;  // kill to end
          case "w": {                                     // delete word left
            const from = pos;
            wordLeft();
            value = value.slice(0, pos) + value.slice(from);
            break;
          }
          case "a": pos = 0; break;
          case "e": pos = value.length; break;
          case "left": wordLeft(); break;
          case "right": wordRight(); break;
          default: return;
        }
        return render();
      }
      if (key.meta) {
        if (name === "left" || name === "b") { wordLeft(); return render(); }
        if (name === "right" || name === "f") { wordRight(); return render(); }
        return;
      }

      switch (name) {
        case "left": if (pos > 0) pos--; return render();
        case "right": if (pos < value.length) pos++; return render();
        case "home": pos = 0; return render();
        case "end": pos = value.length; return render();
        case "backspace":
          if (pos > 0) { value = value.slice(0, pos - 1) + value.slice(pos); pos--; }
          return render();
        case "delete":
          if (pos < value.length) value = value.slice(0, pos) + value.slice(pos + 1);
          return render();
        case "tab":
          if (pathPrompt) completePath();
          return;
      }

      if (ch && ch >= " " && ch !== "\x7f") {
        lastPrintableAt = Date.now();
        insert(ch);
      }
    };

    screen.on("keypress", onKey);
    box.focus();
    render();
  });
}

function parseOptionalBool(input: string, current: boolean): boolean | null {
  const v = input.trim().toLowerCase();
  if (!v) return null;
  if (["y", "yes", "true", "1"].includes(v)) return true;
  if (["n", "no", "false", "0"].includes(v)) return false;
  return current;
}

// ─── CONFIRM DIALOG ───────────────────────────────────────────────────────────

function confirmDialog(msg: string, yesLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    modalOpen = true;
    const w = Math.min(Math.max(msg.length + 12, 44), 74);
    const box = makeModal({ title: "Confirm", width: w, height: 8 });

    blessed.text({ parent: box, top: 1, left: 2,
      content: `{${NEUTRAL}-fg}${msg}{/}`, tags: true, style: { bg: BG } });

    const yes = blessed.button({ parent: box, bottom: 1, left: 2,
      width: yesLabel.length + 4, height: 1, content: ` ${yesLabel} `, align: "center",
      mouse: true, keys: true,
      style: { bg: "#8b2020", fg: "#fff", focus: { bg: "#c03030" } } });

    const no = blessed.button({ parent: box, bottom: 1, left: yesLabel.length + 8,
      width: 10, height: 1, content: " Cancel ", align: "center",
      mouse: true, keys: true,
      style: { bg: "#333331", fg: NEUTRAL, focus: { bg: "#444442" } } });

    const escHandler = () => done(false);
    const done = (v: boolean) => {
      (screen as any).unkey?.(["escape"], escHandler);
      closeModal(box);
      resolve(v);
    };
    yes.on("press", () => done(true));
    no.on("press",  () => done(false));
    yes.key(["enter"], () => done(true));
    no.key(["enter"], () => done(false));
    box.key(["enter"], () => {
      const focused = screen.focused;
      if (focused === no) done(false);
      else done(true);
    });
    (screen as any).key?.(["escape"], escHandler);
    box.key(["escape", "C-c", "q", "n", "N"], () => done(false));
    box.key(["y", "Y"], () => done(true));
    yes.focus();
    screen.render();
  });
}

// ─── NEW ENTRY ────────────────────────────────────────────────────────────────

async function showNewEntryModal(): Promise<void> {
  const urlRaw = await promptText("New Entry", "URL (optional — video/episode/directory):");
  if (urlRaw === null) return;
  const urls = parseUrlInput(urlRaw);
  const firstUrl = urls[0] ?? "";

  const pageUrlRaw = await promptText("New Entry", "Series page URL (optional):");
  if (pageUrlRaw === null) return;
  const pageUrl = pageUrlRaw.trim() || "";

  if (!firstUrl && !pageUrl) {
    showError("Provide at least one URL");
    return;
  }

  let useProxy = false;
  if (firstUrl && isYouTubeUrl(firstUrl)) {
    const proxyRequired = await confirmDialog(
      "YouTube URL detected: Do you have VPN/proxy enabled? (Required for access)",
      "Yes"
    );
    if (!proxyRequired) {
      const proxyWarning = await confirmDialog(
        "Warning: YouTube videos may not play properly without VPN/proxy.\nContinue anyway?",
        "Continue"
      );
      if (!proxyWarning) return;
    }
    useProxy = proxyRequired;
  }

  let scrapeResult: ScrapeResult | null = null;
  if (pageUrl) {
    showInfo("Scraping series page...");
    scrapeResult = await scrapeSeriesSource(pageUrl);
    if (scrapeResult.ok) {
      showInfo(`Found ${scrapeResult.episodes.length} episodes`);
    } else {
      const fallback = await confirmDialog(
        "Could not parse series page. Continue anyway?",
        "Continue"
      );
      if (!fallback) return;
    }
  }

  let name = "";
  while (true) {
    const defaultName = scrapeResult?.title ?? "";
    const entered = await promptText("New Entry", "Name (required):", defaultName);
    if (entered === null) return;
    if (/^https?:\/\//i.test(entered.trim())) {
      showError("That looks like a URL — enter a name for the entry");
      continue;
    }
    if (entered.trim()) { name = entered.trim(); break; }
    showError("Name is required");
  }
  const key = (sanitiseKey(name) || name).trim();
  if (!key) { showError("Could not determine entry name"); return; }
  if (store[key]) {
    const ok = await confirmDialog(`"${key}" already exists. Overwrite?`, "Overwrite");
    if (!ok) return;
  }

  const isMovie = !pageUrl && (urls.length > 1 ? false : isDirectVideoUrl(firstUrl));

  const p: SeriesProgress = {
    url: scrapeResult?.episodes[0] ?? firstUrl,
    season: 1,
    episode: 0,
    timestamp: 0,
    isMovie,
    manualUrls: scrapeResult?.episodes ?? (urls.length > 1 ? urls : undefined),
    ...(pageUrl && {
      sourceUrl: pageUrl,
      source: scrapeResult?.source ?? { kind: "series-page", variant: "hardsub", quality: "720p" },
      knownEpisodes: scrapeResult?.episodes ?? [],
      newEpisodeCount: 0,
      lastEpisodeCheckAt: new Date().toISOString(),
    }),
    ...(useProxy && { overview: "YouTube - VPN/proxy enabled" })
  };
  saveProgress(key, p);
  schedulePush();
  forceRefresh();
  const i = displayItems.indexOf(key);
  if (i !== -1) applySelect(i);
}

// ─── EDIT ENTRY ───────────────────────────────────────────────────────────────

async function showEditModal(): Promise<void> {
  const key = selectedKey();
  if (!key) return;
  const orig = store[key];
  if (!orig) return;
  const p = { ...orig };

  const newName = await promptText("Edit — Name", "Name:", key);
  if (newName === null) return;
  const newUrl = await promptText("Edit — URL", "URL:", p.url);
  if (newUrl === null) return;
  if (newUrl.trim()) {
    const urls = parseUrlInput(newUrl);
    if (urls.length > 0) {
      if (urls[0] !== p.url) {
        p.timestamp = 0;
        p.cacheOffset = 0;
        p.newEpisodeCount = 0;
      }
      p.url = urls[0];
      if (urls.length > 1) {
        p.manualUrls = urls;
        p.isMovie = false;
      } else {
        p.manualUrls = undefined;
        p.isMovie = isDirectVideoUrl(urls[0]);
      }
    }
  }

  const pageUrlPrompt = await promptText("Edit — Series Page URL", "Series page URL (Enter = keep):", p.sourceUrl ?? "");
  if (pageUrlPrompt === null) return;
  const newPageUrl = pageUrlPrompt.trim();
  if (newPageUrl !== (p.sourceUrl ?? "")) {
    if (newPageUrl) {
      showInfo("Scraping series page...");
      const result = await scrapeSeriesSource(newPageUrl);
      if (result.ok) {
        p.sourceUrl = newPageUrl;
        p.source = result.source;
        p.manualUrls = result.episodes;
        p.knownEpisodes = result.episodes;
        p.url = result.episodes[0] ?? p.url;
        p.newEpisodeCount = 0;
        p.lastEpisodeCheckAt = new Date().toISOString();
        p.isMovie = false;
        showInfo(`Found ${result.episodes.length} episodes`);
      } else {
        showInfo("Could not parse series page — keeping existing data");
      }
    } else {
      p.sourceUrl = undefined;
      p.source = undefined;
      p.knownEpisodes = undefined;
    }
  }

  if (!p.isMovie && !p.isOnetime) {
    const sv = await promptText("Edit — Season", "Season:", String(p.season));
    if (sv === null) return;
    const sn = parseInt(sv, 10);
    if (!isNaN(sn) && sn > 0) p.season = sn;

    const ev = await promptText("Edit — Episode", "Episode (1-based):", String(p.episode + 1));
    if (ev === null) return;
    const en = parseInt(ev, 10);
    if (!isNaN(en) && en >= 1) p.episode = en - 1;
  }

  const finishedRaw = await promptText(
    "Edit — Finished",
    `Finished? (y/n, Enter = keep ${p.finished ? "yes" : "no"}):`,
    "",
  );
  if (finishedRaw === null) return;
  const finishedVal = parseOptionalBool(finishedRaw, !!p.finished);
  if (finishedVal !== null) p.finished = finishedVal;

  const movieRaw = await promptText(
    "Edit — Movie",
    `Is movie? (y/n, Enter = keep ${p.isMovie ? "yes" : "no"}):`,
    "",
  );
  if (movieRaw === null) return;
  const movieVal = parseOptionalBool(movieRaw, !!p.isMovie);
  if (movieVal !== null) p.isMovie = movieVal;

  const newKey = newName.trim() ? (sanitiseKey(newName) || key) : key;
  if (newKey !== key) removeEntry(key);
  saveProgress(newKey, p);
  schedulePush();
  forceRefresh();
  const i = displayItems.indexOf(newKey);
  if (i !== -1) applySelect(i);
}

// ─── TOGGLE FINISHED ──────────────────────────────────────────────────────────

function toggleFinished(): void {
  const key = selectedKey();
  if (!key) return;
  const p = store[key];
  if (!p) return;
  saveProgress(key, { ...p, finished: !p.finished });
  schedulePush();
  forceRefresh();
}

// ─── DEDUPE SERIES-PROJECT JSON ──────────────────────────────────────────────

function progressAhead(a: SeriesProgress, b: SeriesProgress): boolean {
  return (
    a.season > b.season ||
    (a.season === b.season && a.episode > b.episode) ||
    (a.season === b.season && a.episode === b.episode && a.timestamp > b.timestamp) ||
    (b.finished !== true && a.finished === true)
  );
}

function entryKey(e: SeriesProjectEntry): string {
  if (typeof e.id === "string" && e.id.startsWith("player_")) {
    return sanitiseKey(e.id.slice(7));
  }
  if (typeof e.title === "string" && e.title.trim()) return sanitiseKey(e.title);
  return sanitiseKey(String(e.id ?? "unknown"));
}

function mergeEntryFields(keep: SeriesProjectEntry, other: SeriesProjectEntry): SeriesProjectEntry {
  const kp = keep.playerData as SeriesProgress;
  const op = other.playerData as SeriesProgress;

  if (!kp.url && op.url) kp.url = op.url;
  if (!kp.sourceUrl && op.sourceUrl) kp.sourceUrl = op.sourceUrl;
  if (!kp.source && op.source) kp.source = op.source;
  if ((!kp.manualUrls || kp.manualUrls.length === 0) && op.manualUrls?.length) {
    kp.manualUrls = op.manualUrls;
  }
  if (kp.isMovie === undefined && op.isMovie !== undefined) kp.isMovie = op.isMovie;
  if (kp.isOnetime === undefined && op.isOnetime !== undefined) kp.isOnetime = op.isOnetime;

  if (!keep.title && other.title) keep.title = other.title;
  if (!keep.year && other.year) keep.year = other.year;
  if (!keep._tmdbId && other._tmdbId) keep._tmdbId = other._tmdbId;
  if (!keep.poster && other.poster) keep.poster = other.poster;
  if (!keep._overview && other._overview) keep._overview = other._overview;
  if (!keep._genreIds && other._genreIds) keep._genreIds = other._genreIds;
  if (!keep._category && other._category) keep._category = other._category;
  if (!keep.genres && other.genres) keep.genres = other.genres;

  if (op.episodeTimestamps) {
    kp.episodeTimestamps = mergeEpisodeTimestamps(kp.episodeTimestamps, op.episodeTimestamps);
  }
  if (op.knownEpisodes) {
    const known = new Set([...(kp.knownEpisodes ?? []), ...op.knownEpisodes]);
    kp.knownEpisodes = [...known];
  }

  keep.playerData = kp;
  return keep;
}

function dedupeSeriesProject(entries: SeriesProjectEntry[]): {
  deduped: SeriesProjectEntry[];
  removed: number;
  groups: number;
} {
  const map = new Map<string, SeriesProjectEntry>();
  let removed = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || !raw.playerData) continue;
    const key = entryKey(raw);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, JSON.parse(JSON.stringify(raw)) as SeriesProjectEntry);
      continue;
    }
    const a = raw.playerData as SeriesProgress;
    const b = existing.playerData as SeriesProgress;
    if (progressAhead(a, b)) {
      const merged = mergeEntryFields(JSON.parse(JSON.stringify(raw)), existing);
      map.set(key, merged);
    } else {
      map.set(key, mergeEntryFields(existing, raw));
    }
    removed++;
  }

  const deduped = [...map.entries()].map(([key, entry]) => {
    entry.id = `player_${key}`;
    if (!entry.title) entry.title = prettifyKey(key);
    return entry;
  });
  return { deduped, removed, groups: map.size };
}

async function showDedupeModal(): Promise<void> {
  const root = appRootDir();
  const defaultPath = existsSync(join(root, "backups", "series.json"))
    ? join(root, "backups", "series.json")
    : join(root, "series.json");
  const src = await promptText("Dedupe", "Series JSON path:", defaultPath);
  if (!src) return;
  const resolved = resolveInAppPath(src);
  if (!existsSync(resolved)) {
    showError(`File not found: ${src}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf-8"));
  } catch (e: any) {
    showError(`Parse error: ${e.message}`);
    return;
  }
  if (!Array.isArray(parsed)) {
    showError("Not a series-project JSON array");
    return;
  }

  const { deduped, removed, groups } = dedupeSeriesProject(parsed as SeriesProjectEntry[]);
  if (removed === 0) {
    showInfo("No duplicates found");
    return;
  }

  const base = basename(resolved, ".json");
  const out = join(dirname(resolved), `${base}.deduped.json`);
  const ok = await confirmDialog(
    `Duplicates removed: ${removed}  Groups: ${groups} — Write to ${basename(out)}?`,
    "Write",
  );
  if (!ok) return;

  try {
    writeFileSync(out, JSON.stringify(deduped, null, 2));
    showInfo(`Wrote: ${out}`);
  } catch (e: any) {
    showError(`Write failed: ${e.message}`);
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

async function showDeleteModal(): Promise<void> {
  const key = selectedKey();
  if (!key) return;
  const ok = await confirmDialog(`Remove "${prettifyKey(key)}"?`, "Delete");
  if (!ok) return;
  removeEntry(key);
  schedulePush();
  forceRefresh();
  showInfo(`Deleted: ${prettifyKey(key)}`);
}

// ─── MULTI-DELETE ─────────────────────────────────────────────────────────────

async function showMultiDeleteModal(): Promise<void> {
  const keys = displayItems.filter((k): k is string => k !== null);
  if (keys.length === 0) return;
  return new Promise((resolve) => {
    modalOpen = true;
    const h = Math.min(keys.length + 7, Math.floor((screen.height as number) * 0.75));
    const box = makeModal({ title: "Multi-Delete", width: "64%", height: h });

    blessed.text({ parent: box, top: 1, left: 2,
      content: `{${HINT}-fg}Space: toggle  a: all/none  Enter: confirm  Esc: cancel{/}`,
      tags: true, style: { bg: BG } });

    const selected = new Set<string>();
    const countTxt = blessed.text({ parent: box, bottom: 1, left: 2,
      content: "", tags: true, style: { bg: BG } });

    const list = blessed.list({ parent: box, top: 3, left: 2, right: 2, bottom: 2,
      keys: true, vi: true, mouse: true, tags: true,
      style: {
        bg: BG, fg: NEUTRAL,
        selected: { bg: SELECTED_BG, fg: SELECTED_FG, bold: true },
        item: { bg: BG, fg: NEUTRAL },
      },
    });

    const render = () => {
      (list as any).setItems(keys.map((k) => {
        const chk = selected.has(k) ? `{${ACCENT}-fg}[✓]{/}` : `{${HINT}-fg}[ ]{/}`;
        const prog = store[k] ? renderProgress(store[k]) : "";
        return `  ${chk} ${prettifyKey(k).padEnd(24).slice(0, 24)}  {${HINT}-fg}${prog}{/}`;
      }));
      countTxt.setContent(
        selected.size > 0 ? `{${ACCENT}-fg}${selected.size} selected{/}` : `{${HINT}-fg}none selected{/}`
      );
      screen.render();
    };

    list.key(["space"], () => {
      const k = keys[(list as any).selected as number];
      if (!k) return;
      selected.has(k) ? selected.delete(k) : selected.add(k);
      render();
    });
    list.key(["a"], () => {
      selected.size === keys.length ? selected.clear() : keys.forEach((k) => selected.add(k));
      render();
    });

    async function cleanup(del: boolean) {
      box.destroy(); modalOpen = false; listBox.focus(); screen.render();
      if (del && selected.size > 0) {
        const ok = await confirmDialog(
          `Delete ${selected.size} entr${selected.size === 1 ? "y" : "ies"}?`, "Delete"
        );
        if (ok) {
          for (const k of selected) removeEntry(k);
          schedulePush(); forceRefresh();
          showInfo(`Deleted ${selected.size} entr${selected.size === 1 ? "y" : "ies"}`);
        }
      }
      resolve();
    }

    list.key(["enter", "return"], () => cleanup(true));
    list.key(["escape", "C-c", "q"], () => cleanup(false));
    box.key(["enter", "return"], () => cleanup(true));
    box.key(["escape", "C-c"], () => cleanup(false));
    render();
    list.focus();
  });
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

async function showSearchModal(): Promise<void> {
  return new Promise((resolve) => {
    modalOpen = true;
    const box = makeModal({ title: "Search", width: "62%", height: "55%" });

    blessed.text({ parent: box, top: 1, left: 2,
      content: `{${HINT}-fg}Type to filter  ↑↓ navigate  Enter: select  Esc: cancel{/}`,
      tags: true, style: { bg: BG } });

    const queryBar = blessed.box({ parent: box, top: 3, left: 2, right: 2, height: 1,
      tags: true, style: { bg: "#2a2a29", fg: NEUTRAL } });

    const resultList = blessed.list({ parent: box, top: 5, left: 2, right: 2, bottom: 1,
      keys: true, mouse: true, tags: true,
      style: {
        bg: BG, fg: NEUTRAL,
        selected: { bg: SELECTED_BG, fg: SELECTED_FG, bold: true },
        item: { bg: BG, fg: NEUTRAL },
      },
    });

    let query = "";
    let results: string[] = [];

    const updateResults = () => {
      const all = displayItems.filter((k): k is string => k !== null);
      results = query.trim() ? fuzzyMatch(query, all) : [...all];
      (resultList as any).setItems(results.map((k) => {
        const p = store[k];
        const col = p?.finished ? FINISHED_FG : (p?.episode ?? 0) > 0 ? WATCHING_FG : NEUTRAL;
        return `  {${col}-fg}${prettifyKey(k).padEnd(26).slice(0, 26)}{/}  {${HINT}-fg}${p ? renderProgress(p) : ""}{/}`;
      }));
      if (results.length > 0) resultList.select(0);
      queryBar.setContent(`  {${NEUTRAL}-fg}${query || " "}{/}{${ACCENT}-fg}▌{/}`);
      screen.render();
    };

    const cleanup = (chosen: string | null) => {
      screen.removeListener("keypress", onKey);
      box.destroy(); modalOpen = false;
      if (chosen !== null) {
        const i = displayItems.indexOf(chosen);
        if (i !== -1) applySelect(i);
      }
      ignoreEnterUntil = Date.now() + 300;
      listBox.focus(); screen.render(); resolve();
    };

    const onKey = (ch: string | undefined, key: any) => {
      if (!key) return;
      const name: string = key.name ?? "";
      if ((key.ctrl && (name === "c" || name === "q")) || name === "escape") { cleanup(null); return; }
      if (name === "enter") { cleanup(results[(resultList as any).selected as number] ?? null); return; }
      if (name === "up")    { resultList.up(1); screen.render(); return; }
      if (name === "down")  { resultList.down(1); screen.render(); return; }
      if (name === "backspace") { query = query.slice(0, -1); updateResults(); return; }
      if (ch && ch.length === 1 && !key.ctrl && !key.meta) { query += ch; updateResults(); }
    };

    screen.on("keypress", onKey);
    box.focus();
    updateResults();
    screen.render();
  });
}

// ─── RENAME ───────────────────────────────────────────────────────────────────

async function renameSelected(): Promise<void> {
  const key = selectedKey();
  if (!key) return;
  const newName = await promptText("Rename", "New name:", key);
  if (!newName || newName === key) return;
  const newKey = (sanitiseKey(newName) || newName.trim());
  if (!newKey || newKey === key) return;
  const p = { ...store[key] } as SeriesProgress;
  removeEntry(key);
  saveProgress(newKey, p);
  schedulePush();
  forceRefresh();
  const i = displayItems.indexOf(newKey);
  if (i !== -1) applySelect(i);
}

// ─── IMPORT ───────────────────────────────────────────────────────────────────

async function showImportModal(): Promise<void> {
  const root = appRootDir();
  const defaultPath = existsSync(join(root, "backups", "series.json"))
    ? join(root, "backups", "series.json")
    : root + "/";
  const path = await promptText("Import", "File path:", defaultPath);
  if (!path) return;
  const p = resolveInAppPath(path);
  let preview: ImportPreview;
  try { preview = await importFromFile(p); }
  catch (e: any) { showError(`Import error: ${e.message}`); return; }
  const { newEntries: ne, updatedEntries: ue, skippedEntries: se } = preview;
  const ok = await confirmDialog(
    `New: ${ne.length}  Updated: ${ue.length}  Skipped: ${se.length} — Apply?`, "Apply"
  );
  if (!ok) return;
  await applyImport(preview, { ignoreDeletions: true });
  schedulePush(); forceRefresh();
  showInfo(`Imported ${ne.length + ue.length} entries`);
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────

async function showExportModal(): Promise<void> {
  const path = await promptText("Export", "Destination path:", "progress-export.json");
  if (!path) return;
  try { await exportToFile(path); showInfo(`Exported to: ${path}`); }
  catch (e: any) { showError(`Export error: ${e.message}`); }
}

// ─── SYNC ─────────────────────────────────────────────────────────────────────

function forceSync(): void {
  if (!CLOUD_SYNC) {
    showError(
      `Sync not configured (create secrets file at ${getPreferredSecretsPath()})`,
    );
    return;
  }
  schedulePush(true);
  showInfo("Sync triggered");
}

async function checkNewEpisodes(): Promise<void> {
  const entries = Object.keys(store).filter((k) => {
    const p = store[k];
    return p && p.source?.kind === "series-page" && !p.finished;
  });
  if (entries.length === 0) {
    showInfo("No series-page entries to check");
    return;
  }
  showInfo(`Checking ${entries.length} series for new episodes...`);
  let totalNew = 0;
  for (const k of entries) {
    const p = store[k]!;
    try {
      const count = await refreshSeriesSource(p);
      if (count > 0) {
        saveProgress(k, p);
        totalNew += count;
      }
    } catch {}
  }
  if (totalNew > 0) {
    showInfo(`Found ${totalNew} new episode(s) across ${entries.length} series`);
    forceRefresh();
  } else {
    showInfo("No new episodes found");
  }
}

async function runStartupChecks(): Promise<void> {
  const entries = Object.keys(store).filter((k) => {
    const p = store[k];
    return p && p.source?.kind === "series-page" && !p.finished;
  });
  if (entries.length === 0) return;
  for (const k of entries) {
    const p = store[k]!;
    try {
      const count = await refreshSeriesSource(p);
      if (count > 0) saveProgress(k, p);
    } catch {}
  }
  forceRefresh();
}

// ─── HELP ─────────────────────────────────────────────────────────────────────

function showHelp(): void {
  modalOpen = true;
  const box = makeModal({ title: "Help", width: "52%", height: 28 });
  box.setContent([
    "",
    `  {${ACCENT}-fg}Navigation{/}`,
    `  {${HINT}-fg}↑ / k{/}       Move up`,
    `  {${HINT}-fg}↓ / j{/}       Move down`,
    `  {${HINT}-fg}g{/}           Go to top`,
    `  {${HINT}-fg}G{/}           Go to bottom`,
    `  {${HINT}-fg}Tab{/}         Switch list ↔ detail`,
    `  {${HINT}-fg}t{/}           Toggle detail (narrow)`,
    "",
    `  {${ACCENT}-fg}Actions{/}`,
    `  {${HINT}-fg}Enter{/}       Play selected`,
    `  {${HINT}-fg}n{/}           New entry`,
    `  {${HINT}-fg}/{/}           Search`,
    `  {${HINT}-fg}e{/}           Edit (name, URL, episode…)`,
    `  {${HINT}-fg}f{/}           Toggle finished`,
    `  {${HINT}-fg}r{/}           Rename`,
    `  {${HINT}-fg}d{/}           Delete`,
    `  {${HINT}-fg}D{/}           Multi-delete  (Space toggle, a = all)`,
    `  {${HINT}-fg}i{/}           Import from file`,
    `  {${HINT}-fg}x{/}           Export to file`,
    `  {${HINT}-fg}u{/}           Dedupe series JSON file`,
    `  {${HINT}-fg}c{/}           Cache help`,
    `  {${HINT}-fg}s{/}           Force sync`,
    `  {${HINT}-fg}C{/}           Check for new episodes`,
    `  {${HINT}-fg}q / Esc{/}     Quit`,
    "",
    `  {${HINT}-fg}Press any key to close{/}`,
  ].join("\n"));

  const close = () => { box.destroy(); modalOpen = false; listBox.focus(); screen.render(); };
  setTimeout(() => {
    screen.once("keypress", close);
    box.key(["escape", "q", "?", "enter", "space"], close);
    box.focus();
    screen.render();
  }, 0);
}

// ─── GUARD ────────────────────────────────────────────────────────────────────

function guard(fn: () => void | Promise<void>): () => void {
  return () => {
    if (modalOpen) return;
    const r = fn();
    if (r && typeof (r as any).catch === "function") {
      (r as Promise<void>).catch((e) => showError(String(e)));
    }
  };
}

// ─── KEY BINDINGS ─────────────────────────────────────────────────────────────

function bindKeys(): void {
  screen.key(["up", "k"], guard(() => {
    if (focusedPanel === "list") moveUp();
  }));
  screen.key(["down", "j"], guard(() => {
    if (focusedPanel === "list") moveDown();
  }));
  screen.key(["g"], guard(() => {
    if (focusedPanel === "list") goTop();
  }));
  screen.key(["G"], guard(() => {
    if (focusedPanel === "list") goBottom();
  }));

  screen.key(["enter"], guard(() => {
    if (shouldIgnoreEnter()) return;
    if (focusedPanel === "detail" || focusedPanel === "list") return playSelected();
  }));
  screen.key(["n"],     guard(showNewEntryModal));
  screen.key(["/"],     guard(showSearchModal));
  screen.key(["e"],     guard(showEditModal));
  screen.key(["f"],     guard(toggleFinished));
  screen.key(["r"],     guard(renameSelected));
  const handleDeleteKey = guard(() => {
    if (lastKeyShift) return showMultiDeleteModal();
    return showDeleteModal();
  });
  screen.on("keypress", (_ch: string | undefined, key: any) => {
    if (!key || key.name !== "d") return;
    lastKeyShift = !!key.shift;
    handleDeleteKey();
  });
  screen.key(["i"],     guard(showImportModal));
  screen.key(["x"],     guard(showExportModal));
  screen.key(["u"],     guard(showDedupeModal));
  screen.key(["c"],     guard(showCacheHelp));
  screen.key(["s"],     guard(forceSync));
  screen.key(["C"],     guard(checkNewEpisodes));
  screen.key(["?"],     guard(showHelp));
  screen.key(["t"], guard(() => {
    if (layoutMode !== "narrow") return;
    showDetailInNarrow = !showDetailInNarrow;
    applyLayout();
  }));

  screen.key(["tab"], guard(() => {
    if (layoutMode === "narrow") {
      showDetailInNarrow = !showDetailInNarrow;
      applyLayout();
      return;
    }
    if (focusedPanel === "list") {
      focusedPanel = "detail";
      (detailBox as any).style.border.fg = ACCENT;
      (listBox  as any).style.border.fg = BORDER;
      detailBox.focus();
    } else {
      focusedPanel = "list";
      (listBox  as any).style.border.fg = ACCENT;
      (detailBox as any).style.border.fg = BORDER;
      listBox.focus();
    }
    screen.render();
  }));

  listBox.on("select item", (_: any, index: number) => {
    if (displayItems[index] === null) {
      let next = index + 1;
      while (next < displayItems.length && displayItems[next] === null) next++;
      if (next >= displayItems.length) {
        next = index - 1;
        while (next >= 0 && displayItems[next] === null) next--;
      }
      if (next >= 0 && next < displayItems.length) applySelect(next);
      return;
    }
    currentIdx = index;
    updateDetail();
    screen.render();
  });

  screen.key(["q"], guard(async () => {
    if (modalOpen) return;
    const ok = await confirmDialog("Quit player?", "Quit");
    if (!ok) return;
    await flushSync();
    process.exit(0);
  }));
}

// ─── LAYOUT ───────────────────────────────────────────────────────────────────

function buildLayout(): void {
  headerBox = blessed.box({
    top: 0, left: 0, width: "100%", height: 1,
    tags: true, style: { bg: HEADER_BG, fg: NEUTRAL },
  });
  listBox = blessed.list({
    top: 1, left: 0, width: "40%", bottom: 2,
    border: { type: "line" },
    scrollbar: { ch: "▐", style: { bg: BORDER } },
    tags: true, keys: false, vi: false, mouse: true,
    style: {
      bg: BG, fg: NEUTRAL,
      border: { fg: ACCENT },
      selected: { bg: SELECTED_BG, fg: SELECTED_FG, bold: true },
      item: { bg: BG, fg: NEUTRAL },
    },
  });
  detailBox = blessed.box({
    top: 1, left: "40%", right: 0, bottom: 2,
    border: { type: "line" },
    scrollable: true, alwaysScroll: true,
    keys: true, vi: true, mouse: true, tags: true,
    style: { bg: BG, fg: NEUTRAL, border: { fg: BORDER } },
    scrollbar: { ch: "▐", style: { bg: BORDER } },
  });
  footerBox = blessed.box({
    bottom: 1, left: 0, width: "100%", height: 1,
    tags: true, style: { bg: HEADER_BG, fg: HINT },
  });
  errorBar = blessed.box({
    bottom: 0, left: 0, width: "100%", height: 1,
    tags: true, hidden: true,
    style: { bg: "#2a0a0a", fg: "#cf6679" },
  });

  screen.append(headerBox);
  screen.append(listBox);
  screen.append(detailBox);
  screen.append(footerBox);
  screen.append(errorBar);
  screen.on("resize", () => applyLayout());
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (IS_TERMUX) {
    console.error("Termux detected — the full-screen TUI is not supported on Termux.");
    console.error("Use the CLI instead: `npx tsx player.ts` — it provides the same features and a cleaner mobile experience.");
    process.exit(1);
  }
  process.on("uncaughtException", (err) => {
    logToFile(`uncaughtException: ${err?.stack || err}`);
  });
  process.on("unhandledRejection", (err) => {
    logToFile(`unhandledRejection: ${String(err)}`);
  });
  logToFile("TUI start");
  const args = process.argv.slice(2);
  const isDetached = args.includes("--detached") || process.env.PLAYER_TUI_DETACHED === "1";
  // Detach into a Kitty window by default; --no-detach keeps it in this terminal.
  const wantsDetach =
    !isDetached &&
    !args.includes("--no-detach") &&
    process.stdout.isTTY &&
    hasKitty();

  if (wantsDetach) {
    process.env.PLAYER_PLAY_IN_KITTY = "1";
    process.env.PLAYER_MPV_NO_TERMINAL = "1";
    const scriptPath = resolve(process.argv[1] ?? "tui.ts");
    const extraArgs = args.filter((a) => a !== "--detach" && a !== "--no-detach");
    const ok = tryDetachToKitty(scriptPath, extraArgs);
    if (ok) process.exit(0);
  }
  await maybeRunStorageSetupTui();

  // The storage-setup prompt above uses node's readline, which leaves a
  // keypress decoder armed on stdin even after rl.close(). blessed installs
  // its own decoder, and with both active every keystroke is emitted twice
  // ("s" types "ss"). Strip stdin's listeners so blessed starts clean.
  process.stdin.removeAllListeners("keypress");
  process.stdin.removeAllListeners("newListener");
  process.stdin.removeAllListeners("data");
  // Silence console output during store init (sync logs, TLS warnings, etc.)
  const origLog  = console.log;
  const origWarn = console.warn;
  console.log  = () => {};
  console.warn = () => {};

  try { MPV = findMpv(); } catch { MPV = "mpv"; }

  await initStore();

  console.log  = origLog;
  console.warn = origWarn;

  try {
    screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: "player",
      input:  process.stdin,
      output: process.stdout,
      keys: true,
    });
  } catch {
    console.error("Terminal does not support TUI. Use `npx tsx player.ts` for CLI mode.");
    process.exit(1);
  }

  buildLayout();
  bindKeys();
  hookConsole();
  setTuiActive(true);
  applyLayout();

  storeEmitter.on("change", () => { refreshList();   screen.render(); });
  storeEmitter.on("sync",   () => { updateHeader();  screen.render(); });

  updateHeader();
  updateFooter();
  refreshList();
  listBox.focus();
  screen.render();

  runStartupChecks().catch(() => {});
}

main().catch((e) => {
  logToFile(`main.catch: ${e?.stack || e}`);
  console.error("TUI error:", e);
  process.exit(1);
});
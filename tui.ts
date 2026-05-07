#!/usr/bin/env node
// player/tui.ts — full-screen blessed TUI for media player
// NOTE: Does NOT import from player.ts (it calls main() at module level and
//       would immediately launch the CLI). Playback uses player-core directly.

import blessed from "blessed";
import { spawn } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
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
  ARVAN_SYNC,
  isDirectVideoUrl,
  playWithMpv,
  resolveEpisodes,
  getSeasonUrl,
} from "./player-core.js";
import type { SeriesProgress, ImportPreview, SeriesProjectEntry } from "./player-core.js";

// ─── COLOR PALETTE ────────────────────────────────────────────────────────────

const BG          = "#1e1e1d";
const BORDER      = "#3a3a38";
const SELECTED_BG = "#d57455";
const SELECTED_FG = "#1e1e1d";
const FINISHED_FG = "#6b6b64";
const WATCHING_FG = "#d57455";
const NEUTRAL     = "#c3c2b7";
const HINT        = "#6b6b64";
const HEADER_BG   = "#161615";
const ACCENT      = "#d57455";

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
  const name = prettifyKey(key).padEnd(26).slice(0, 26);
  const prog = renderProgress(p);
  const text = `  ${name}  ${prog}`;
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
  if (ARVAN_SYNC) {
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
    footerBox.setContent(
      `{${HINT}-fg}  [t] Detail  [/] Search  [n] New  [D] Multi  [q] Quit{/}`
    );
    return;
  }
  footerBox.setContent(
    `{${HINT}-fg}  [n] New   [/] Search   [i] Import   [x] Export   [u] Dedupe file   [D] Multi-delete   [q] Quit{/}`
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
  setImmediate(() => screen.render());
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")
    .slice(0, 240);
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
  if (process.env.TERM !== "xterm-kitty" && !process.env.KITTY_PID) return false;
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

  let playError: string | null = null;
  setTuiActive(false);
  (screen as any).leave?.();
  try {
    if (p.isMovie || isDirectVideoUrl(p.url)) {
      const result = await playWithMpv(
        MPV, p.url, p.timestamp,
        (time) => saveProgress(key, { ...(store[key] ?? p), timestamp: time }),
        key,
      );
      const cur = store[key] ?? p;
      if (result.endReason === "near_end") {
        saveProgress(key, { ...cur, finished: true, timestamp: 0 });
      } else if (result.finalPosition) {
        saveProgress(key, { ...cur, timestamp: result.finalPosition.time });
      }
    } else {
      // Series: resolve episode list for current season
      let episodes: string[] = [];
      if (isDirectVideoUrl(p.url)) episodes = [p.url];
      else {
        const seasonUrl = getSeasonUrl(p.url, p.season);
        episodes = await resolveEpisodes(seasonUrl, p.manualUrls);
      }
      if (episodes.length === 0) {
        showError("No episodes found. Check the URL or add manual URLs.");
        return;
      }
      const epIdx     = p.episode; // 0-based
      const epUrl     = episodes[epIdx] ?? episodes[0] ?? p.url;
      const label     = `${prettifyKey(key)} S${p.season}E${String(epIdx + 1).padStart(2, "0")}`;
      const result    = await playWithMpv(
        MPV, epUrl, p.timestamp,
        (time) => saveProgress(key, { ...(store[key] ?? p), timestamp: time }),
        label,
      );
      const cur = store[key] ?? p;
      if (result.endReason === "near_end") {
        const nextEp = epIdx + 1;
        if (nextEp < episodes.length) {
          saveProgress(key, { ...cur, episode: nextEp, timestamp: 0 });
        } else {
          // Try next season
          saveProgress(key, { ...cur, season: cur.season + 1, episode: 0, timestamp: 0 });
        }
      } else if (result.finalPosition) {
        saveProgress(key, { ...cur, timestamp: result.finalPosition.time });
      }
    }
    schedulePush();
  } catch (e) {
    playError = (e as Error).message || "Playback failed";
  }

  (screen as any).enter?.();
  refreshList();
  listBox.focus();
  setTuiActive(true);
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

    const inp = blessed.textbox({ parent: box, top: 3, left: 2, right: 2, height: 1,
      inputOnFocus: true, value: def, keys: true, vi: true, mouse: true, cursors: true,
      style: { bg: "#2a2a29", fg: NEUTRAL, focus: { bg: "#383836" } } });

    blessed.text({ parent: box, bottom: 1, left: 2,
      content: `{${HINT}-fg}Enter: confirm  Esc: cancel{/}`,
      tags: true, style: { bg: BG } });

    const done = (v: string | null) => { closeModal(box); resolve(v); };
    inp.on("submit", (v: string) => done(v.trim()));
    inp.on("cancel", () => done(null));
    inp.key(["escape", "C-c"], () => done(null));
    box.key(["escape", "C-c"], () => done(null));

    const pathPrompt = /path/i.test(label);
    if (pathPrompt) {
      inp.key(["tab"], () => {
        const raw = ((inp as any).getValue?.() ?? (inp as any).value ?? "") as string;
        const trimmed = raw.trim();
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
        const newVal = (rawBase || "") + pick + suffix;
        (inp as any).setValue?.(newVal);
        screen.render();
        if (entries.length > 1) {
          showInfo(`Matches: ${entries.slice(0, 6).join(", ")}${entries.length > 6 ? " …" : ""}`);
        }
      });
    }

    inp.focus();
    screen.render();
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
  const url = await promptText("New Entry", "URL:");
  if (!url) return;
  const suggested = sanitiseKey(url.split("\n")[0].trim());
  const name = await promptText("New Entry", "Name:", suggested);
  if (name === null) return;
  const key = (sanitiseKey(name) || suggested).trim();
  if (!key) { showError("Could not determine entry name"); return; }
  if (store[key]) {
    const ok = await confirmDialog(`"${key}" already exists. Overwrite?`, "Overwrite");
    if (!ok) return;
  }
  const urls    = url.split("\n").map((u) => u.trim()).filter(Boolean);
  const firstUrl = urls[0];
  const p: SeriesProgress = {
    url: firstUrl, season: 1, episode: 0, timestamp: 0,
    isMovie: isDirectVideoUrl(firstUrl),
    manualUrls: urls.length > 1 ? urls : undefined,
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
  if (newUrl) p.url = newUrl;

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
  if (!ARVAN_SYNC) { showError("Sync not configured (set PLAYER_ARVAN_* env vars)"); return; }
  schedulePush(true);
  showInfo("Sync triggered");
}

// ─── HELP ─────────────────────────────────────────────────────────────────────

function showHelp(): void {
  modalOpen = true;
  const box = makeModal({ title: "Help", width: "52%", height: 27 });
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
    `  {${HINT}-fg}s{/}           Force sync`,
    `  {${HINT}-fg}q / Esc{/}     Quit`,
    "",
    `  {${HINT}-fg}Press any key to close{/}`,
  ].join("\n"));

  const close = () => { box.destroy(); modalOpen = false; listBox.focus(); screen.render(); };
  setImmediate(() => {
    screen.once("keypress", close);
    box.key(["escape", "q", "?", "enter", "space"], close);
    box.focus();
    screen.render();
  });
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
  screen.key(["s"],     guard(forceSync));
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
  const args = process.argv.slice(2);
  const wantsDetach = args.includes("--detach");
  const isDetached = args.includes("--detached") || process.env.PLAYER_TUI_DETACHED === "1";
  if (wantsDetach && !isDetached) {
    const scriptPath = resolve(process.argv[1] ?? "tui.ts");
    const extraArgs = args.filter((a) => a !== "--detach");
    const ok = tryDetachToKitty(scriptPath, extraArgs);
    if (ok) process.exit(0);
  }
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
}

main().catch((e) => {
  console.error("TUI error:", e);
  process.exit(1);
});

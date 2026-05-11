// player-core.ts — pure logic extracted from player.ts
// No readline imports. No process.exit calls. Everything exported.

import { EventEmitter } from "events";
import { spawn, execSync, type ChildProcess } from "child_process";
import { createHash, createHmac } from "crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  statSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import net from "net";
import { CacheManager } from "./cache-manager.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (
    w.name !== "DeprecationWarning" ||
    !w.message.includes("NODE_TLS_REJECT_UNAUTHORIZED")
  )
    console.warn(w);
});

// ─── STORE EMITTER ───────────────────────────────────────────────────────────

export const storeEmitter = new EventEmitter();

// ─── SYNC STATUS ─────────────────────────────────────────────────────────────

export type SyncStatus = "idle" | "syncing" | "ok" | "error";
export let syncStatus: SyncStatus = "idle";
export let syncError = "";

export function setSyncStatus(s: SyncStatus, err = "") {
  syncStatus = s;
  syncError = err;
  storeEmitter.emit("sync", s);
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────

export interface SeriesProgress {
  url: string;
  season: number;
  episode: number;
  timestamp: number;
  updatedAt?: string;
  finished?: boolean;
  manualUrls?: string[];
  isMovie?: boolean;
  isOnetime?: boolean;
  overview?: string;
  genres?: string[];
  cacheOffset?: number;
}

export type ProgressStore = Record<string, SeriesProgress>;
export type DeletionLog = Record<string, string>;

export const ARVAN_ACCESS = process.env.PLAYER_ARVAN_ACCESS_KEY || "";
export const ARVAN_SECRET = process.env.PLAYER_ARVAN_SECRET_KEY || "";
export const ARVAN_BUCKET = process.env.PLAYER_ARVAN_BUCKET || "";
export const ARVAN_REGION = process.env.PLAYER_ARVAN_REGION || "ir-thr-at1";
export const ARVAN_FILE = "mpv-progress.json";
export const ARVAN_SYNC = !!(ARVAN_ACCESS && ARVAN_SECRET && ARVAN_BUCKET);

export const SCRIPT_DIR = (() => {
  try {
    const p = process.argv[1];
    if (p && existsSync(p)) return join(p, "..");
  } catch {}
  try {
    return __dirname;
  } catch {}
  return process.cwd();
})();
export const CONFIG_DIR =
  process.env.PLAYER_CONFIG_DIR || join(SCRIPT_DIR, ".mpv-web-player");
export const CACHE_DIR = join(CONFIG_DIR, "cache");
export const PROGRESS_FILE = join(CONFIG_DIR, "progress.json");
export const VIDEO_DIR = join(SCRIPT_DIR, "video-cache");
export const MPV_SOCKET = join(CONFIG_DIR, "mpv.sock");

export const IS_TERMUX =
  process.env.PREFIX?.includes("com.termux") ||
  existsSync("/data/data/com.termux");
export const TERMUX_VIDEO_DIR = IS_TERMUX
  ? process.env.PLAYER_TERMUX_VIDEO_DIR ||
    (existsSync("/storage/emulated/0")
      ? "/storage/emulated/0/player-cache"
      : existsSync("/sdcard")
        ? "/sdcard/player-cache"
        : VIDEO_DIR)
  : VIDEO_DIR;
export const END_THRESHOLD_SECONDS = 60;
export const END_THRESHOLD_RATIO = 0.95;

// ─── QUIT SENTINEL ───────────────────────────────────────────────────────────

export class QuitToMenu extends Error {
  constructor() {
    super("quit-to-menu");
  }
}

// ─── SERIES KEY ──────────────────────────────────────────────────────────────

export const SKIP_SEGMENTS = new Set([
  "soft.sub",
  "softsub",
  "hard.sub",
  "hardsub",
  "dubbed",
  "dub",
  "sub",
  "subtitle",
  "subtitles",
  "720p",
  "1080p",
  "480p",
  "4k",
  "2160p",
  "720p.bluray",
  "1080p.bluray",
  "bluray",
  "blu-ray",
  "web-dl",
  "webrip",
  "hdtv",
  "dvdrip",
  "x264",
  "x265",
  "hevc",
  "avc",
  "h264",
  "h265",
  "donyayeserial",
  "serial",
  "media",
  "series",
  "film2media",
  "filmedia",
]);

export function seriesKeyFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    const si = parts.findIndex((p) => /^S\d+$/i.test(p));
    if (si > 0)
      for (let i = si - 1; i >= 0; i--)
        if (!SKIP_SEGMENTS.has(parts[i].toLowerCase())) return parts[i];
    const m = parts.filter(
      (p) =>
        !/^\d+$/.test(p) && p.length > 2 && !SKIP_SEGMENTS.has(p.toLowerCase()),
    );
    return m[m.length - 1] || parts[0] || url;
  } catch {
    return url;
  }
}

export function seriesKeyFromUrlList(urls: string[]): string {
  if (urls.length === 0) return "unknown";
  if (urls.length === 1) return seriesKeyFromUrl(urls[0]);
  try {
    const pathParts = urls.map((u) =>
      new URL(u).pathname.split("/").filter(Boolean),
    );
    const minLen = Math.min(...pathParts.map((p) => p.length));
    let commonDepth = 0;
    for (let i = 0; i < minLen; i++) {
      if (pathParts.every((p) => p[i] === pathParts[0][i])) commonDepth = i + 1;
      else break;
    }
    for (let i = commonDepth - 1; i >= 0; i--) {
      const seg = pathParts[0][i];
      if (
        !/^S\d+$/i.test(seg) &&
        !SKIP_SEGMENTS.has(seg.toLowerCase()) &&
        !/^\d+$/.test(seg)
      )
        return seg;
    }
  } catch {}
  return seriesKeyFromUrl(urls[0]);
}

// ─── MPV DETECTION ───────────────────────────────────────────────────────────

export function findMpv(): string {
  if (IS_TERMUX) return "vlc-via-intent";
  for (const c of ["/Applications/mpv.app/Contents/MacOS/mpv", "mpv"]) {
    try {
      if (c === "mpv") {
        execSync("which mpv", { stdio: "ignore" });
        return "mpv";
      } else if (existsSync(c)) return c;
    } catch {}
  }
  throw new Error(
    "mpv not found.\n  macOS: brew install mpv\n  Linux: sudo apt install mpv\n  Termux: pkg install mpv",
  );
}

// ─── ARVANCLOUD S3 ───────────────────────────────────────────────────────────

export function sha256hex(d: string | Buffer) {
  return createHash("sha256").update(d).digest("hex");
}
export function hmacSha256(k: Buffer | string, d: string): Buffer {
  return createHmac("sha256", k).update(d).digest();
}
export function getSigningKey(
  sec: string,
  date: string,
  region: string,
  svc: string,
): Buffer {
  return hmacSha256(
    hmacSha256(hmacSha256(hmacSha256("AWS4" + sec, date), region), svc),
    "aws4_request",
  );
}

export async function s3Request(
  method: "GET" | "PUT",
  body?: Buffer,
): Promise<Response> {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const dateOnly = dateStr.slice(0, 8);
  const host = `${ARVAN_BUCKET}.s3.${ARVAN_REGION}.arvanstorage.ir`;
  const url = `https://${host}/${ARVAN_FILE}`;
  const hash = sha256hex(body ?? Buffer.alloc(0));
  const sh =
    method === "PUT"
      ? "content-type;host;x-amz-content-sha256;x-amz-date"
      : "host;x-amz-content-sha256;x-amz-date";
  const ch =
    method === "PUT"
      ? `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${hash}\nx-amz-date:${dateStr}\n`
      : `host:${host}\nx-amz-content-sha256:${hash}\nx-amz-date:${dateStr}\n`;
  const canonical = [method, `/${ARVAN_FILE}`, "", ch, sh, hash].join("\n");
  const scope = `${dateOnly}/${ARVAN_REGION}/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", dateStr, scope, sha256hex(canonical)].join(
    "\n",
  );
  const sig = hmacSha256(
    getSigningKey(ARVAN_SECRET, dateOnly, ARVAN_REGION, "s3"),
    sts,
  ).toString("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${ARVAN_ACCESS}/${scope}, SignedHeaders=${sh}, Signature=${sig}`;
  const headers: Record<string, string> = {
    Host: host,
    "x-amz-date": dateStr,
    "x-amz-content-sha256": hash,
    Authorization: auth,
  };
  if (method === "PUT") headers["Content-Type"] = "application/json";
  return fetch(url, {
    method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });
}

// ─── PROGRESS STORE ──────────────────────────────────────────────────────────

export function ensureConfigDir() {
  const dirs = [CONFIG_DIR, CACHE_DIR, VIDEO_DIR];
  if (IS_TERMUX && TERMUX_VIDEO_DIR !== VIDEO_DIR) dirs.push(TERMUX_VIDEO_DIR);
  for (const d of dirs)
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export let deletionLog: DeletionLog = {};

export function loadLocalStore(): ProgressStore {
  if (!existsSync(PROGRESS_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
    if (raw && typeof raw === "object" && raw._deleted) {
      deletionLog = raw._deleted as DeletionLog;
      delete raw._deleted;
    }
    if (raw && typeof raw.url === "string") {
      const key = seriesKeyFromUrl(raw.url);
      return { [key]: raw as SeriesProgress };
    }
    return raw as ProgressStore;
  } catch {
    return {};
  }
}

export function saveLocalStore(s: ProgressStore) {
  ensureConfigDir();
  const toSave =
    Object.keys(deletionLog).length > 0 ? { ...s, _deleted: deletionLog } : s;
  writeFileSync(PROGRESS_FILE, JSON.stringify(toSave, null, 2));
}

export async function pullFromArvan(): Promise<ProgressStore | null> {
  setSyncStatus("syncing");
  try {
    const res = await s3Request("GET");
    if (res.status === 404) {
      setSyncStatus("ok");
      return null;
    }
    if (!res.ok) {
      setSyncStatus("error", `GET failed: ${res.status}`);
      console.warn(`[sync] GET failed: ${res.status}`);
      return null;
    }
    const raw = (await res.json()) as any;
    setSyncStatus("ok");
    if (raw && typeof raw.url === "string") {
      const k = seriesKeyFromUrl(raw.url);
      return { [k]: raw };
    }
    return raw as ProgressStore;
  } catch (e) {
    setSyncStatus("error", (e as Error).message);
    console.warn("[sync] Pull failed:", (e as Error).message);
    return null;
  }
}

export async function pushToArvan(s: ProgressStore) {
  setSyncStatus("syncing");
  try {
    const res = await s3Request("PUT", Buffer.from(JSON.stringify(s, null, 2)));
    if (!res.ok) {
      setSyncStatus("error", `Push failed: ${res.status}`);
      console.warn(`[sync] Push failed: ${res.status}`);
    } else {
      setSyncStatus("ok");
    }
  } catch (e) {
    setSyncStatus("error", (e as Error).message);
    console.warn("[sync] Push failed:", (e as Error).message);
  }
}

export function mergeStores(
  local: ProgressStore,
  remote: ProgressStore,
  options?: { ignoreDeletions?: boolean },
): { merged: ProgressStore; remoteWon: string[] } {
  const merged = { ...local };
  const remoteWon: string[] = [];
  for (const [key, rp] of Object.entries(remote)) {
    if (!options?.ignoreDeletions && deletionLog[key]) {
      const deletedAt = new Date(deletionLog[key]).getTime();
      const remoteUpdated = rp.updatedAt ? new Date(rp.updatedAt).getTime() : 0;
      if (deletedAt >= remoteUpdated) continue;
    }
    const lp = local[key];
    if (!lp) {
      merged[key] = rp;
      remoteWon.push(key);
      continue;
    }
    const ahead =
      rp.season > lp.season ||
      (rp.season === lp.season && rp.episode > lp.episode) ||
      (rp.season === lp.season &&
        rp.episode === lp.episode &&
        rp.timestamp > lp.timestamp) ||
      (!lp.finished && rp.finished);
    if (ahead) {
      merged[key] = rp;
      remoteWon.push(key);
    }
  }
  return { merged, remoteWon };
}

export let store: ProgressStore = {};

// Remove entries whose key is purely numeric — these are garbage entries
// created by the old importProgress that treated array indices as keys.
// NOTE: do NOT reject entries with an empty url — those are valid watchlist /
// finished-marker entries imported from the series-project web app that were
// never played through the player (so they have no URL yet).
export function cleanGarbageEntries(s: ProgressStore): {
  cleaned: ProgressStore;
  removed: number;
} {
  const cleaned: ProgressStore = {};
  let removed = 0;
  for (const [k, v] of Object.entries(s)) {
    // Only reject bare-integer keys (old import bug artefacts).
    if (/^\d+$/.test(k)) {
      removed++;
      deletionLog[k] = new Date().toISOString();
    } else cleaned[k] = v;
  }
  return { cleaned, removed };
}

export async function initStore() {
  ensureConfigDir();
  store = loadLocalStore();
  // Clean up any garbage numeric-key entries from a bad import
  const { cleaned, removed } = cleanGarbageEntries(store);
  if (removed > 0) {
    store = cleaned;
    saveLocalStore(store);
    console.log(
      `[cleanup] Removed ${removed} invalid entries from progress store.`,
    );
  }
  // Migrate keys: normalise spaces→underscores and lowercase so legacy entries
  // align with the new sanitiseKey behaviour (prevents duplicates after import).
  {
    const migrated: ProgressStore = {};
    let changes = 0;
    for (const [k, v] of Object.entries(store)) {
      const nk = k.replace(/[\s_]+/g, "_").toLowerCase();
      if (nk !== k) {
        // Merge into canonical key (keep whichever is further ahead)
        const existing = migrated[nk];
        if (!existing) {
          migrated[nk] = v;
          changes++;
        } else {
          const ahead =
            v.season > existing.season ||
            (v.season === existing.season && v.episode > existing.episode) ||
            (v.season === existing.season &&
              v.episode === existing.episode &&
              v.timestamp > existing.timestamp) ||
            (!existing.finished && v.finished);
          migrated[nk] = ahead ? v : existing;
          changes++;
        }
      } else {
        migrated[k] =
          migrated[k] === undefined
            ? v
            : (() => {
                const existing = migrated[k];
                const ahead =
                  v.season > existing.season ||
                  (v.season === existing.season &&
                    v.episode > existing.episode) ||
                  (v.season === existing.season &&
                    v.episode === existing.episode &&
                    v.timestamp > existing.timestamp) ||
                  (!existing.finished && v.finished);
                return ahead ? v : existing;
              })();
      }
    }
    if (changes > 0) {
      store = migrated;
      saveLocalStore(store);
      console.log(
        `[cleanup] Normalised ${changes} key(s) (spaces → underscores).`,
      );
    }
  }
  if (!ARVAN_SYNC) return;
  process.stdout.write("[sync] Pulling from ArvanCloud... ");
  const remote = await pullFromArvan();
  if (!remote) {
    console.log(
      Object.keys(store).length
        ? "no remote yet, using local."
        : "no progress found.",
    );
    return;
  }
  const { merged, remoteWon } = mergeStores(store, remote);
  store = merged;
  saveLocalStore(store);
  console.log(
    remoteWon.length
      ? `remote ahead for: ${remoteWon.join(", ")}`
      : "local is up to date.",
  );
}

export let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePush(immediate = false) {
  if (!ARVAN_SYNC) return;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (immediate) {
    pushToArvan(store);
    return;
  }
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushToArvan(store);
  }, 30_000);
}

export async function flushSync() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (ARVAN_SYNC) {
    process.stdout.write("[sync] Pushing to ArvanCloud... ");
    await pushToArvan(store);
    console.log("done.");
  }
}

export function saveProgress(
  key: string,
  p: SeriesProgress,
  immediate = false,
) {
  store[key] = { ...p, updatedAt: new Date().toISOString() };
  saveLocalStore(store);
  schedulePush(immediate);
  storeEmitter.emit("change");
}

export function removeEntry(key: string) {
  deletionLog[key] = new Date().toISOString();
  delete store[key];
  saveLocalStore(store);
  schedulePush(true);
  storeEmitter.emit("change");
}

// ─── EPISODE CACHE ────────────────────────────────────────────────────────────

export const CACHE_TTL_MS = 60 * 60 * 1000;
export interface EpisodeCache {
  url: string;
  episodes: string[];
  fetchedAt: number;
}
export function cacheKeyForUrl(url: string) {
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}
export function cachePathForUrl(url: string) {
  return join(CACHE_DIR, `${cacheKeyForUrl(url)}.json`);
}
export function loadEpisodeCache(url: string): string[] | null {
  const p = cachePathForUrl(url);
  if (!existsSync(p)) return null;
  try {
    const c: EpisodeCache = JSON.parse(readFileSync(p, "utf-8"));
    if (c.url !== url || Date.now() - c.fetchedAt > CACHE_TTL_MS) return null;
    return c.episodes;
  } catch {
    return null;
  }
}
export function saveEpisodeCache(url: string, episodes: string[]) {
  try {
    writeFileSync(
      cachePathForUrl(url),
      JSON.stringify({ url, episodes, fetchedAt: Date.now() }, null, 2),
    );
  } catch {}
}
export function clearEpisodeCache(url: string) {
  const p = cachePathForUrl(url);
  if (existsSync(p))
    try {
      unlinkSync(p);
    } catch {}
}

// ─── URL BLOCK PARSER ────────────────────────────────────────────────────────
// FIX: increased idle timeout from 300ms → 800ms so large pastes (20+ URLs)
// don't get cut off. Also handles the common format where all URLs are
// concatenated on one line with no separator between .mkv and https://.

export function splitUrlBlock(raw: string): string[] {
  // Split on every https?:// boundary (handles concatenated URLs)
  const parts = raw.split(/(?=https?:\/\/)/g);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ─── STRING / PATH HELPERS ───────────────────────────────────────────────────

// Strip markdown link syntax that terminals may inject when rendering
// clickable URLs: "[Man.on.Fire](http://Man.on.Fire)" -> "Man.on.Fire"
export function stripMarkdownLink(s: string): string {
  // Full "[text](url)" -> text
  const full = s.match(/^\[(.+?)\]\(.*?\)$/);
  if (full) return full[1];
  // Bare "[text]" -> text
  const bare = s.match(/^\[(.+?)\]$/);
  if (bare) return bare[1];
  return s;
}

export function sanitiseKey(name: string): string {
  // Remove markdown link syntax, strip filesystem-unsafe chars, normalise
  // spaces/underscores to underscores, and lowercase — so "Cross" and "cross",
  // "Gen V" and "Gen_V" all map to the same key and don't duplicate on import.
  return (
    stripMarkdownLink(name)
      .replace(/[\[\]]/g, "")
      .replace(/[\/\\:*?"<>|]/g, "")
      .trim()
      .replace(/[\s_]+/g, "_")
      .toLowerCase() || "unknown"
  );
}

export function sanitiseDirName(name: string): string {
  return sanitiseKey(name);
}

// ─── VIDEO CACHE PATH ─────────────────────────────────────────────────────────

export function videoCachePath(episodeUrl: string, seriesLabel = ""): string {
  const filename = decodeURIComponent(
    episodeUrl.split("/").pop()!.split("?")[0],
  );
  const baseDir = IS_TERMUX ? TERMUX_VIDEO_DIR : VIDEO_DIR;
  const dir = seriesLabel
    ? join(baseDir, sanitiseDirName(seriesLabel))
    : baseDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, filename);
}
export function cleanFilename(localPath: string): string {
  return localPath.split("/").pop() ?? localPath;
}
export function videoFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ─── MPV IPC ─────────────────────────────────────────────────────────────────

export async function queryMpv(): Promise<{
  time: number;
  duration: number;
} | null> {
  return new Promise((resolve) => {
    if (!existsSync(MPV_SOCKET)) return resolve(null);
    const client = net.createConnection(MPV_SOCKET);
    let tp: number | null = null,
      dur: number | null = null,
      buf = "",
      done = false;
    const finish = (r: { time: number; duration: number } | null) => {
      if (done) return;
      done = true;
      try {
        client.destroy();
      } catch {}
      resolve(r);
    };
    client.on("connect", () => {
      client.write(
        JSON.stringify({
          command: ["get_property", "time-pos"],
          request_id: 1,
        }) + "\n",
      );
      client.write(
        JSON.stringify({
          command: ["get_property", "duration"],
          request_id: 2,
        }) + "\n",
      );
    });
    client.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          if (j.request_id === 1 && j.data != null) tp = j.data;
          if (j.request_id === 2 && j.data != null) dur = j.data;
        } catch {}
      }
      if (tp !== null && dur !== null) finish({ time: tp, duration: dur });
    });
    client.on("error", () => finish(null));
    client.on("end", () =>
      finish(tp !== null && dur !== null ? { time: tp, duration: dur } : null),
    );
    setTimeout(() => finish(null), 2000);
  });
}

// ─── VIDEO DOWNLOAD ───────────────────────────────────────────────────────────

// Curl exit 18 = server closed connection before finishing transfer.
// startDownload auto-retries on exit 18 up to MAX_DOWNLOAD_RETRIES times,
// resuming from current file size each time so mpv keeps playing uninterrupted.
export const MAX_DOWNLOAD_RETRIES = 20;
const CURL_CONNECT_TIMEOUT = Number(process.env.PLAYER_CURL_CONNECT_TIMEOUT ?? "20");
const CURL_RETRY = Number(process.env.PLAYER_CURL_RETRY ?? "5");
const CURL_RETRY_DELAY = Number(process.env.PLAYER_CURL_RETRY_DELAY ?? "3");
const CURL_DISABLE_RANGE = process.env.PLAYER_CURL_DISABLE_RANGE === "1";
const DISABLE_SEEK_AHEAD = process.env.PLAYER_DISABLE_SEEK_AHEAD === "1";
const STREAM_FALLBACK = process.env.PLAYER_STREAM_FALLBACK !== "0";
const MIN_BUFFER_KB = Number(process.env.PLAYER_MIN_BUFFER_KB ?? "256");
const MPV_NO_TERMINAL = process.env.PLAYER_MPV_NO_TERMINAL !== "0";

export function startDownload(
  episodeUrl: string,
  localPath: string,
  byteOffset = 0,
  onComplete?: () => void,
): ChildProcess {
  // Keep existing partial files so we can resume when the server supports Range.

  let attempt = 0;
  let currentProcess: ChildProcess;
  let killed = false;

  function spawnCurl(offset: number): ChildProcess {
    // Only pass -C <offset> when we have a real byte offset to resume from.
    // On the first attempt (offset=0) we omit -C entirely — some Iranian CDN
    // servers mishandle Range requests and stall or corrupt the download.
    const curlArgs = [
      "-L",
      "-k",
      "--silent",
      "--show-error",
      "--connect-timeout",
      String(CURL_CONNECT_TIMEOUT),
      "--retry",
      String(CURL_RETRY),
      "--retry-all-errors",
      "--retry-connrefused",
      "--retry-delay",
      String(CURL_RETRY_DELAY),
      "-A",
      "Mozilla/5.0",
      "-o",
      localPath,
    ];
    if (offset > 0 && !CURL_DISABLE_RANGE) curlArgs.push("-C", String(offset));
    curlArgs.push(episodeUrl);
    const proc = spawn("curl", curlArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const m = d.toString().trim();
      // Filter out the noisy "bytes missing" line — it appears on every
      // partial transfer and would spam the console during retries.
      if (m && !m.includes("end of response with"))
        console.error(`[cache] curl: ${m}`);
    });
    proc.on("exit", (code) => {
      if (killed) return;
      if (code === 0) {
        console.log("[cache] Download complete.");
        onComplete?.();
        return;
      }
      // Error 18: partial transfer — server dropped the connection early.
      // Resume from wherever the file currently ends.
      if ((code === 18 || code === 28) && attempt < MAX_DOWNLOAD_RETRIES) {
        attempt++;
        const sz = videoFileSize(localPath);
        console.warn(
          `[cache] Partial transfer (${(sz / 1_048_576).toFixed(1)} MB on disk), resuming… (${attempt}/${MAX_DOWNLOAD_RETRIES})`,
        );
        setTimeout(() => {
          if (killed) return;
          currentProcess = spawnCurl(videoFileSize(localPath));
        }, 1500);
        return;
      }
      if (code !== null)
        console.warn(
          `[cache] curl gave up (exit ${code}) after ${attempt} attempt(s).`,
        );
      onComplete?.();
    });
    return proc;
  }

  currentProcess = spawnCurl(byteOffset);

  // Proxy so that kill() always targets whichever curl process is currently running
  return new Proxy({} as ChildProcess, {
    get(_t, prop) {
      if (prop === "kill")
        return (...a: any[]) => {
          killed = true;
          return currentProcess.kill(...(a as []));
        };
      const v = (currentProcess as any)[prop];
      return typeof v === "function" ? v.bind(currentProcess) : v;
    },
  });
}

export function deleteVideoCache(episodeUrl: string, seriesLabel = "") {
  const p = videoCachePath(episodeUrl, seriesLabel);
  if (!existsSync(p)) return;
  try {
    unlinkSync(p);
    console.log("[cache] Deleted local file.");
  } catch (e) {
    console.warn(`[cache] Could not delete: ${(e as Error).message}`);
  }
}

export const activePrefetches: ChildProcess[] = [];
export function prefetchEpisode(episodeUrl: string, seriesLabel = "") {
  const localPath = videoCachePath(episodeUrl, seriesLabel);
  if (existsSync(localPath) && videoFileSize(localPath) > 1_048_576) {
    console.log(`[prefetch] ${cleanFilename(localPath)} already cached`);
    return;
  }
  console.log(`[prefetch] Starting: ${cleanFilename(localPath)}`);
  activePrefetches.push(startDownload(episodeUrl, localPath, 0));
}
process.on("exit", () =>
  activePrefetches.forEach((dl) => {
    try {
      dl.kill();
    } catch {}
  }),
);

// ─── PLAYBACK ────────────────────────────────────────────────────────────────

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export type PlayResult = {
  exitCode: number | null;
  finalPosition: { time: number; duration: number } | null;
  endReason: "near_end" | "quit";
  localPath: string;
  cacheOffset: number;
};

export interface PlayOptions {
  nextEpisodeUrl?: string;
  cacheOffsetHint?: number;
  onCache?: (info: CacheStatus) => void;
  showMpvCacheOsd?: boolean;
}

export interface CacheStatus {
  state: "buffering" | "downloading" | "retrying" | "complete" | "error";
  downloadedBytes: number;
  totalBytes: number;
}

export function isNearEnd(t: number, d: number) {
  return (
    d > 0 && (d - t < END_THRESHOLD_SECONDS || t / d >= END_THRESHOLD_RATIO)
  );
}

export function playWithMpvDesktop(
  MPV: string,
  episodeUrl: string,
  startTime = 0,
  onProgress?: (t: number, d: number) => void,
  seriesLabel = "",
  options?: PlayOptions,
): Promise<PlayResult> {
  return new Promise((resolve) => {
    if (existsSync(MPV_SOCKET))
      try {
        unlinkSync(MPV_SOCKET);
      } catch {}
    const localPath = videoCachePath(episodeUrl, seriesLabel);
    const alreadyBytes = videoFileSize(localPath);
    console.log(
      alreadyBytes > 0
        ? `[cache] ${(alreadyBytes / 1_048_576).toFixed(1)} MB already on disk`
        : "[cache] Starting download…",
    );
    // onDlComplete is set after sendMpvCmd is in scope (inside waitForFile.then)
    let onDlComplete: () => void = () => {
      downloadComplete = true;
    };
    let downloadComplete = false,
      totalFileBytes = 0,
      fileBytesPerVideoSec = 0,
      cacheBytes = alreadyBytes,
      cacheState: CacheStatus["state"] = "buffering";
    const cm = new CacheManager({
      connectTimeoutSec: CURL_CONNECT_TIMEOUT,
      userAgent: "Mozilla/5.0",
      disableRange: CURL_DISABLE_RANGE,
    });
    cm.on("progress", (bytes: number, total: number, slotIndex: number) => {
      if (slotIndex !== 0) return;
      cacheBytes = bytes;
      if (total > 0) totalFileBytes = total;
      if (total > 0 && bytes >= total) downloadComplete = true;
      options?.onCache?.({
        state: cacheState,
        downloadedBytes: cacheBytes,
        totalBytes: totalFileBytes,
      });
    });
    cm.on("state", (state: CacheStatus["state"], slotIndex: number) => {
      if (slotIndex !== 0) return;
      cacheState = state;
      options?.onCache?.({
        state: cacheState,
        downloadedBytes: cacheBytes,
        totalBytes: totalFileBytes,
      });
    });
    cm.on("error", (msg: string, slotIndex: number) => {
      if (slotIndex === 0) console.warn(msg);
    });
    // Wait until the file has at least 512 KB on disk before giving it to mpv.
    // Waiting for >0 bytes is not enough — mpv needs a valid container header
    // which for MKV/MP4 can be several hundred KB into the file.
    const MIN_BYTES_BEFORE_PLAY = Math.max(64, MIN_BUFFER_KB) * 1024;
    cm.startCurrent(
      episodeUrl,
      localPath,
      options?.cacheOffsetHint ?? 0,
      MIN_BYTES_BEFORE_PLAY,
      () => onDlComplete(),
    )
      .then(({ bufferReady }) => bufferReady)
      .then(() => {
        const fileSize = videoFileSize(localPath);
        let playbackTarget = localPath;
        let useCache = true;
        if (fileSize === 0) {
          console.error(
            "\n[cache] File still empty after 60 s — check URL or network.",
          );
          cm.killAll();
          if (!STREAM_FALLBACK) {
            resolve({
              exitCode: null,
              finalPosition: null,
              endReason: "quit",
              localPath,
              cacheOffset: 0,
            });
            return;
          }
          console.warn("[cache] Falling back to direct stream (no cache).");
          playbackTarget = episodeUrl;
          useCache = false;
        }
        if (useCache && fileSize >= MIN_BYTES_BEFORE_PLAY)
          process.stdout.write("\n");
        const args = [
          ...(MPV_NO_TERMINAL ? ["--no-terminal"] : []),
          "--no-resume-playback",
          `--input-ipc-server=${MPV_SOCKET}`,
          "--force-window=immediate",
          "--keep-open=yes",
          "--keep-open-pause=no",
          // Tell mpv the file is still being written — don't give up on short reads
          "--demuxer-readahead-secs=10",
          "--cache=yes",
          "--cache-secs=30",
        ];
        if (startTime > 0) args.push(`--start=${startTime}`);
        args.push(playbackTarget);
        console.log(`\nPlaying: ${cleanFilename(localPath)}`);
        if (startTime > 0)
          console.log(`Resuming from: ${formatTime(startTime)}`);
        const mpv = (() => {
          if (process.env.PLAYER_PLAY_IN_KITTY === "1") {
            try {
              execSync("which kitty", { stdio: "ignore" });
              return spawn(
                "kitty",
                ["--title", "player", "--directory", process.cwd(), "--", MPV, ...args],
                { stdio: ["ignore", "ignore", "ignore"] },
              );
            } catch {}
          }
          return spawn(MPV, args, { stdio: ["inherit", "inherit", "inherit"] });
        })();
        if (useCache && options?.nextEpisodeUrl) {
          cm.startPrefetch(
            options.nextEpisodeUrl,
            videoCachePath(options.nextEpisodeUrl, seriesLabel),
          );
        }
        let lastPosition: { time: number; duration: number } | null = null;
        let socketReady = false,
          markedNearEnd = false,
          isPaused = false,
          seekCheckDone = false;
        let lastOsdAt = 0;
        let lastOsdText = "";
        const socketCheck = setInterval(() => {
          if (existsSync(MPV_SOCKET)) {
            socketReady = true;
            clearInterval(socketCheck);
          }
        }, 200);
        function sendMpvCmd(cmd: object) {
          if (!existsSync(MPV_SOCKET)) return;
          const c = net.createConnection(MPV_SOCKET);
          c.on("connect", () => {
            c.write(JSON.stringify(cmd) + "\n");
            c.end();
          });
          c.on("error", () => {});
        }
        // Now sendMpvCmd is in scope — wire up the real completion handler
        onDlComplete = () => {
          downloadComplete = true;
          setTimeout(
            () => sendMpvCmd({ command: ["set_property", "keep-open", "no"] }),
            500,
          );
        };
        if (downloadComplete) onDlComplete();
        const poll = setInterval(async () => {
          if (!socketReady) return;
          const pos = await queryMpv();
          if (!pos) return;
          lastPosition = pos;
          onProgress?.(pos.time, pos.duration);
          if (!markedNearEnd && isNearEnd(pos.time, pos.duration))
            markedNearEnd = true;
          if (
            fileBytesPerVideoSec === 0 &&
            totalFileBytes > 0 &&
            pos.duration > 10
          )
            fileBytesPerVideoSec = totalFileBytes / pos.duration;
          if (
            !seekCheckDone &&
            !downloadComplete &&
            fileBytesPerVideoSec > 0 &&
            startTime > 0
          ) {
            seekCheckDone = true;
            if (DISABLE_SEEK_AHEAD) return;
            const needed = startTime * fileBytesPerVideoSec;
            const current = videoFileSize(localPath);
            if (current < needed * 0.85) {
              const offset = Math.max(0, Math.floor(needed) - 2_097_152);
              console.log(
                `[cache] Seek ahead — restarting curl from ${formatTime(startTime)}`,
              );
              cm.killAll();
              downloadComplete = false;
              cm.startCurrent(
                episodeUrl,
                localPath,
                offset,
                MIN_BYTES_BEFORE_PLAY,
                () => onDlComplete(),
              ).catch(() => {});
            }
          }
          if (useCache && !downloadComplete && fileBytesPerVideoSec > 0 && !markedNearEnd) {
            const dlSec =
              (startTime > 0 && seekCheckDone
                ? Math.max(0, startTime - 2)
                : 0) +
              videoFileSize(localPath) / fileBytesPerVideoSec;
            if (pos.time + 60 > dlSec) {
              if (!isPaused) {
                isPaused = true;
                sendMpvCmd({ command: ["set_property", "pause", true] });
                console.log(
                  `\n[buffer] Waiting… at ${formatTime(pos.time)}, downloaded ~${formatTime(dlSec)}`,
                );
              }
            } else if (isPaused) {
              isPaused = false;
              sendMpvCmd({ command: ["set_property", "pause", false] });
              console.log("[buffer] Ready — resuming.");
            if (options?.showMpvCacheOsd !== false && useCache) {
              const now = Date.now();
              if (now - lastOsdAt > 3000) {
                const pct =
                  totalFileBytes > 0
                    ? ` ${(cacheBytes / totalFileBytes * 100).toFixed(1)}%`
                    : "";
                const mb = (cacheBytes / 1_048_576).toFixed(1);
                const mbTotal =
                  totalFileBytes > 0
                    ? ` / ${(totalFileBytes / 1_048_576).toFixed(1)} MB`
                    : "";
                const secs =
                  fileBytesPerVideoSec > 0
                    ? ` ~${formatTime(Math.floor(cacheBytes / fileBytesPerVideoSec))}`
                    : "";
                const text = `Cache: ${mb} MB${mbTotal}${pct}${secs} (${cacheState})`;
                if (text !== lastOsdText) {
                  lastOsdText = text;
                  lastOsdAt = now;
                  sendMpvCmd({ command: ["show-text", text, 2000] });
                }
              }
            }
            }
          } else if (useCache && isPaused) {
            isPaused = false;
            sendMpvCmd({ command: ["set_property", "pause", false] });
          }
        }, 2000);
        mpv.on("exit", (code) => {
          clearInterval(poll);
          clearInterval(socketCheck);
          if (existsSync(MPV_SOCKET))
            try {
              unlinkSync(MPV_SOCKET);
            } catch {}
          cm.killAll();
          const nearEnd =
            markedNearEnd ||
            (lastPosition !== null &&
              isNearEnd(lastPosition.time, lastPosition.duration));
          resolve({
            exitCode: code,
            finalPosition: lastPosition,
            endReason: nearEnd ? "near_end" : "quit",
            localPath,
            cacheOffset: useCache ? cm.currentOffset(0) : 0,
          });
        });
      })
      .catch((err) => {
        console.error(`[cache] ${err.message}`);
        cm.killAll();
        resolve({
          exitCode: null,
          finalPosition: null,
          endReason: "quit",
          localPath: videoCachePath(episodeUrl, seriesLabel),
          cacheOffset: 0,
        });
      });
  });
}

export const VLC_PACKAGE = "org.videolan.vlc";

export function isVlcRunning(): boolean {
  // dumpsys requires android.permission.DUMP which Termux never has —
  // it always returns a permission denial, making the old logic return false
  // immediately. pgrep is unprivileged and works reliably.
  try {
    const pid = execSync(`pgrep -f ${VLC_PACKAGE} 2>/dev/null || true`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    return pid.length > 0;
  } catch {
    return false;
  }
}

// Prompt callbacks are injectable so player-core stays readline-free.
// The Termux/VLC path needs to ask two questions after playback; when no
// prompts are provided the function assumes the episode was finished.
export interface VlcPrompts {
  yn: (question: string) => Promise<boolean>;
  ask: (question: string) => Promise<string>;
}

export async function playWithVlcAndroid(
  episodeUrl: string,
  startTime = 0,
  seriesLabel = "",
  prompts?: VlcPrompts,
): Promise<PlayResult> {
  const localPath = videoCachePath(episodeUrl, seriesLabel);
  console.log(`\nOpening in VLC: ${cleanFilename(localPath)}`);
  if (startTime > 0) console.log(`Resume from: ${formatTime(startTime)}`);

  // Download in background — VLC streams the remote URL directly so seeking
  // always works. The local file is just a cache for next time.
  const dl = startDownload(episodeUrl, localPath, 0);

  // Launch VLC with the remote HTTP URL so it can seek freely.
  // termux-am is preferred (Termux:API); fall back to bare am.
  const posMs = Math.floor(startTime * 1000);
  const extras = posMs > 0
    ? `--el position ${posMs} --ez from_start false`
    : `--ez from_start true`;
  const viewIntent = `-a android.intent.action.VIEW -d "${episodeUrl}" -t "video/*" ${extras}`;
  try {
    execSync(`termux-am start ${viewIntent}`, { stdio: "ignore", timeout: 6000 });
    console.log("[VLC launched — return here when done watching]");
  } catch {
    try {
      execSync(`am start -n "${VLC_PACKAGE}/.gui.video.VideoPlayerActivity" ${viewIntent}`, { stdio: "ignore", timeout: 5000 });
      console.log("[VLC launched — return here when done watching]");
    } catch {
      try {
        execSync(`am start ${viewIntent}`, { stdio: "ignore", timeout: 5000 });
        console.log("[Video player launched — return here when done watching]");
      } catch (e) {
        console.error("[Could not launch video player]", (e as Error).message);
      }
    }
  }

  // On Android, VLC's process stays alive in the background cache even after
  // the user closes the app — pgrep never returns empty, so polling is useless.
  // The only reliable signal is the user switching back to Termux.
  // Solution: just ask them to press Enter. Kill the download first so the
  // terminal is quiet, then prompt.
  try { dl.kill(); } catch {}

  // Drain any final curl stderr that may still be buffered, then prompt.
  // A short pause lets the kill propagate so the terminal is clean.
  await new Promise((r) => setTimeout(r, 400));

  if (prompts) {
    // prompts.ask with empty string = "press Enter to continue"
    await prompts.ask("Press Enter when you have closed VLC…");
  } else {
    // Non-interactive fallback (shouldn't happen in normal use)
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\n[Video player closed]\n");

  const done = prompts
    ? await prompts.yn("Did you finish the episode? [Y/n]: ")
    : true;
  if (done) {
    return {
      exitCode: 0,
      finalPosition: null,
      endReason: "near_end",
      localPath,
      cacheOffset: videoFileSize(localPath),
    };
  }
  const raw = prompts
    ? await prompts.ask("Stopped at (e.g. 32:10 or 1:05:30, Enter = keep old position): ")
    : "";
  const secs = parseTimeInput(raw);
  if (secs > 0) console.log(`Position saved: ${formatTime(secs)}`);
  return {
    exitCode: 0,
    finalPosition: { time: secs > 0 ? secs : startTime || 1, duration: 0 },
    endReason: "quit",
    localPath,
    cacheOffset: videoFileSize(localPath),
  };
}

export function parseTimeInput(input: string): number {
  const parts = input
    .trim()
    .split(":")
    .map((p) => parseInt(p, 10));
  if (parts.some(isNaN) || parts.length < 2) return 0;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

export async function playWithMpv(
  MPV: string,
  episodeUrl: string,
  startTime = 0,
  onProgress?: (t: number, d: number) => void,
  seriesLabel = "",
  prompts?: VlcPrompts,
  options?: PlayOptions,
): Promise<PlayResult> {
  return IS_TERMUX
    ? playWithVlcAndroid(episodeUrl, startTime, seriesLabel, prompts)
    : playWithMpvDesktop(
        MPV,
        episodeUrl,
        startTime,
        onProgress,
        seriesLabel,
        options,
      );
}

// ─── DIRECTORY LISTING ───────────────────────────────────────────────────────

export async function fetchDirectoryListing(
  url: string,
  signal?: AbortSignal,
): Promise<string[]> {
  url = ensureTrailingSlash(url);
  const cached = loadEpisodeCache(url);
  if (cached) {
    console.log(
      `[cache] Using cached episode list (${cached.length} episodes)`,
    );
    return cached;
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const html = await response.text();
  const links: string[] = [];
  const regex = /href="([^"]+\.(?:mp4|mkv|avi|mov|webm))"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const f = match[1].split("?")[0];
    links.push(f.startsWith("http") ? f : new URL(f, url).href);
  }
  const episodes = [...new Set(links)].sort(
    (a, b) => extractEpisodeNumber(a) - extractEpisodeNumber(b),
  );
  if (episodes.length > 0) saveEpisodeCache(url, episodes);
  return episodes;
}

export function extractEpisodeNumber(filename: string): number {
  // FIX: improved episode number extraction to handle more filename patterns:
  // Cross.S02E01.720p... → 1
  // episode.04.mkv → 4
  // 04.mkv → 4
  const name = filename.split("/").pop() ?? filename;
  // SxxExx pattern (most reliable)
  const seMatch = name.match(/[Ss]\d+[Ee](\d+)/);
  if (seMatch) return parseInt(seMatch[1], 10);
  // Exx pattern standalone
  const eMatch = name.match(/[Ee](\d{2,})/);
  if (eMatch) return parseInt(eMatch[1], 10);
  // Fallback: first standalone number in filename
  const numMatch = name.match(/(\d+)\.(?:mp4|mkv|avi|mov|webm)/);
  if (numMatch) return parseInt(numMatch[1], 10);
  return 0;
}

export function getSeasonUrl(baseUrl: string, season: number): string {
  const u = new URL(baseUrl);
  // Split on "/" and replace only an exact S\d+ segment (whole segment, case-insensitive).
  // This avoids mangling path components like "series2" which contain "s2" as a substring.
  const tag = `S${season.toString().padStart(2, "0")}`;
  const segments = u.pathname.split("/");
  let replaced = false;
  for (let i = 0; i < segments.length; i++) {
    if (!replaced && /^S\d+$/i.test(segments[i])) {
      segments[i] = tag;
      replaced = true;
    }
  }
  let path = segments.join("/");
  if (!path.endsWith("/")) path += "/";
  u.pathname = path;
  return u.href;
}

export function ensureTrailingSlash(url: string): string {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.href;
  } catch {
    return url.endsWith("/") ? url : url + "/";
  }
}

export function isDirectVideoUrl(url: string): boolean {
  try {
    return /\.(mp4|mkv|avi|mov|webm|m4v|ts|flv)(\?.*)?$/i.test(
      new URL(url).pathname,
    );
  } catch {
    return false;
  }
}

// ─── EPISODE RESOLUTION ──────────────────────────────────────────────────────
// FIX: resolveEpisodes now receives a cleaner hasManualUrls flag from the
// caller so directory-fetching is never attempted for manual-URL sessions.
// Also: when manualUrls are present, return them directly without touching
// the network at all.
//
// NOTE: when no episodes are found via directory listing, this returns []
// instead of calling promptManualUrls. The caller (player.ts's runSession)
// handles the empty case (it can call its own readline-based promptManualUrls).

export async function resolveEpisodes(
  seasonUrl: string,
  savedManualUrls: string[] | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  // Manual URLs always win — no network needed
  if (savedManualUrls && savedManualUrls.length > 0) {
    console.log(
      `[directory] Using ${savedManualUrls.length} saved episode URLs.`,
    );
    return savedManualUrls;
  }
  let episodes: string[] = [];
  try {
    episodes = await fetchDirectoryListing(seasonUrl, signal);
  } catch (e: any) {
    if (e.name === "AbortError") throw new QuitToMenu();
    if (e.message?.includes("HTTP 404")) throw e;
    console.warn(`[fetch] ${e.message}`);
  }
  // No readline in core — caller handles the empty case
  return episodes;
}

// ─── RENDER PROGRESS ─────────────────────────────────────────────────────────

export function renderProgress(p: SeriesProgress): string {
  if (p.finished) return "✓ finished";
  if (p.isMovie) {
    return p.timestamp > 0 ? `@ ${formatTime(p.timestamp)}` : "movie";
  }
  const time = p.timestamp > 0 ? ` @ ${formatTime(p.timestamp)}` : "";
  return `S${p.season}E${String(p.episode + 1).padStart(2, "0")}${time}`;
}

// ─── FUZZY MATCH ─────────────────────────────────────────────────────────────

export function fuzzyMatch(query: string, keys: string[]): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return keys;
  const matches = keys.filter((k) => {
    const kl = k.toLowerCase();
    return words.every((w) => kl.includes(w));
  });
  matches.sort((a, b) => {
    const al = a.toLowerCase(),
      bl = b.toLowerCase(),
      w = words[0];
    const aStarts = al.startsWith(w) ? 0 : 1;
    const bStarts = bl.startsWith(w) ? 0 : 1;
    return aStarts - bStarts || a.localeCompare(b);
  });
  return matches;
}

// ─── PLAY TARGET ─────────────────────────────────────────────────────────────

export interface PlayTarget {
  key: string;
  p: SeriesProgress;
  season: number;
  episode: number;
  timestamp: number;
}

// ─── SERIES-PROJECT JSON FORMAT ──────────────────────────────────────────────
// The series-project format is an array of objects:
// [ { id: "player_<key>", title, year, rating, isMovie, playerData: SeriesProgress, ... } ]
// The player's native format is a plain object: { [key]: SeriesProgress }
// Both are supported for import; export always writes the series-project format.

export interface SeriesProjectEntry {
  id: string; // "player_<key>"
  title: string;
  year: number | null;
  rating: number;
  isMovie?: boolean;
  playerData: SeriesProgress;
  _tmdbId?: number;
  poster?: string;
  _overview?: string;
  _genreIds?: number[];
  _category?: string;
  genres?: string[];
}

// Convert a ProgressStore to series-project array format.
// title = prettified key (dots→spaces, capitalised words)
export function storeToSeriesProject(s: ProgressStore): SeriesProjectEntry[] {
  return Object.entries(s).map(([key, p]) => {
    const title = key
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    // Try to extract a year from the key (e.g. "Interstellar.2014" -> 2014)
    const yearMatch = key.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
    const entry: SeriesProjectEntry = {
      id: `player_${key}`,
      title,
      year,
      rating: 0,
      isMovie: p.isMovie ?? false,
      playerData: p,
      _category: p.finished
        ? "Finished"
        : p.timestamp > 0 || p.episode > 0
          ? "Watching"
          : "Plan to Watch",
    };
    if (p.overview) entry._overview = p.overview;
    if (p.genres && p.genres.length > 0) entry.genres = p.genres;
    return entry;
  });
}

// Parse either format into a ProgressStore.
export function parseImportFile(raw: unknown): ProgressStore {
  // Array format (series-project)
  if (Array.isArray(raw)) {
    const result: ProgressStore = {};
    for (const entry of raw as SeriesProjectEntry[]) {
      if (!entry || typeof entry !== "object") continue;
      if (!entry.playerData || typeof entry.playerData !== "object") continue;
      // Key = id with "player_" prefix stripped, else fallback to title
      const key =
        typeof entry.id === "string" && entry.id.startsWith("player_")
          ? entry.id.slice(7)
          : (entry.title ?? entry.id ?? "unknown");
      if (!key) continue;
      const p = { ...(entry.playerData as SeriesProgress) };
      if (!p.overview && entry._overview) p.overview = entry._overview;
      if ((!p.genres || p.genres.length === 0) && entry.genres)
        p.genres = entry.genres;
      result[sanitiseKey(key)] = p;
    }
    return result;
  }
  // Native object format
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj._deleted) delete obj._deleted;
    // Validate: values must look like SeriesProgress (have a "url" string)
    const result: ProgressStore = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && typeof (v as any).url === "string") {
        result[k] = v as SeriesProgress;
      }
    }
    return result;
  }
  return {};
}

// ─── IMPORT PREVIEW ──────────────────────────────────────────────────────────

export interface ImportPreview {
  newEntries: string[];
  updatedEntries: string[];
  skippedEntries: string[];
  imported: ProgressStore;
}

// Preview what an import file would do — no readline, no side effects.
export async function importFromFile(filePath: string): Promise<ImportPreview> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  let imported: ProgressStore;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    imported = parseImportFile(raw);
  } catch (e) {
    throw new Error(`Could not parse file: ${(e as Error).message}`);
  }

  const newEntries: string[] = [];
  const updatedEntries: string[] = [];
  const skippedEntries: string[] = [];

  for (const [key, rp] of Object.entries(imported)) {
    const lp = store[key];
    if (!lp) {
      newEntries.push(key);
    } else {
      const ahead =
        rp.season > lp.season ||
        (rp.season === lp.season && rp.episode > lp.episode) ||
        (rp.season === lp.season &&
          rp.episode === lp.episode &&
          rp.timestamp > lp.timestamp) ||
        (!lp.finished && rp.finished);
      if (ahead) updatedEntries.push(key);
      else skippedEntries.push(key);
    }
  }

  return { newEntries, updatedEntries, skippedEntries, imported };
}

// Apply a previously generated preview to the store.
export async function applyImport(
  preview: ImportPreview,
  options?: { ignoreDeletions?: boolean },
): Promise<void> {
  const { merged } = mergeStores(store, preview.imported, options);
  store = merged;
  saveLocalStore(store);
  schedulePush(true);
  storeEmitter.emit("change");
}

// Export current store to a file path — no readline, no side effects beyond writing the file.
export async function exportToFile(destPath: string): Promise<void> {
  const out = storeToSeriesProject(store);
  writeFileSync(destPath, JSON.stringify(out, null, 2));
}
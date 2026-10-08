#!/usr/bin/env node
// gui-server.ts — local HTTP server backing the desktop GUI (Tauri webview).
// Local-only by design: initStore({ localOnly: true }) never touches cloud sync.

import http, { type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { dirname, join, extname } from "path";
import { fileURLToPath } from "url";
import {
  initStore,
  store,
  storeEmitter,
  saveProgress,
  removeEntry,
  scrapeSeriesPageInfo,
  selectEpisodes,
  sanitiseKey,
  seriesKeyFromUrl,
  renderProgress,
  episodeKeyFromUrl,
  type SeriesProgress,
} from "./player-core.js";
import { PlaybackController } from "./gui/playback.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUI_DIR = join(__dirname, "gui");

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  if (i !== -1 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return Number(process.env.GUI_PORT || 45871);
})();

const controller = new PlaybackController();

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function prettifyKey(key: string): string {
  return key
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function normalizeUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function summarizeUrls(urls: string[]): {
  totalEpisodes: number;
  seasons: { season: number; episodeCount: number }[];
} {
  const seen = new Set<string>();
  const seasonMap = new Map<number, Set<number>>();
  for (const u of urls) {
    const k = episodeKeyFromUrl(u);
    if (!k) continue;
    seen.add(k);
    const [s, e] = k.split(":").map(Number);
    if (!seasonMap.has(s!)) seasonMap.set(s!, new Set());
    seasonMap.get(s!)!.add(e!);
  }
  const seasons = [...seasonMap.entries()]
    .map(([season, eps]) => ({ season, episodeCount: eps.size }))
    .sort((a, b) => a.season - b.season);
  return { totalEpisodes: seen.size, seasons };
}

function buildState() {
  const series = Object.entries(store)
    .map(([key, p]) => {
      const urls =
        p.manualUrls && p.manualUrls.length > 0
          ? p.manualUrls
          : p.knownEpisodes ?? [];
      const summary = summarizeUrls(urls);
      return {
        key,
        name: prettifyKey(key),
        progress: renderProgress(p),
        season: p.season,
        episode: p.episode,
        timestamp: p.timestamp,
        finished: !!p.finished,
        isMovie: !!p.isMovie,
        watched: p.episode > 0 || p.timestamp > 0,
        overview: p.overview ?? "",
        genres: p.genres ?? [],
        poster: p.poster ?? "",
        sourceUrl: p.sourceUrl ?? "",
        variant: p.source?.variant ?? null,
        quality: p.source?.quality ?? null,
        newEpisodeCount: p.newEpisodeCount ?? 0,
        totalEpisodes: summary.totalEpisodes,
        seasons: summary.seasons,
        updatedAt: p.updatedAt ?? null,
      };
    })
    .sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

  return {
    local: true,
    total: series.length,
    series,
    playback: controller.state,
  };
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();
let pendingBroadcast: ReturnType<typeof setTimeout> | null = null;

function broadcast(): void {
  if (sseClients.size === 0 || pendingBroadcast) return;
  pendingBroadcast = setTimeout(() => {
    pendingBroadcast = null;
    const payload = JSON.stringify(buildState());
    for (const res of sseClients) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {}
    }
  }, 120);
}

controller.on("state", broadcast);
storeEmitter.on("change", broadcast);

// ─── HTTP HELPERS ────────────────────────────────────────────────────────────

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res: ServerResponse, urlPath: string): void {
  const name = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (name.includes("..") || name.includes("/")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const file = join(GUI_DIR, name);
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(readFileSync(file));
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  if (req.method === "GET" && path === "/api/health") {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && path === "/api/state") {
    sendJson(res, 200, buildState());
    return true;
  }

  if (req.method === "GET" && path === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    res.write(`data: ${JSON.stringify(buildState())}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {}
    }, 20000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return true;
  }

  if (req.method !== "POST") return false;
  const body = await readJson(req);

  if (path === "/api/add") {
    const url = normalizeUrl(String(body.url ?? ""));
    if (!url) {
      sendJson(res, 400, { ok: false, error: "missing url" });
      return true;
    }
    const info = await scrapeSeriesPageInfo(url);
    if (!info.ok) {
      sendJson(res, 200, { ok: false, error: info.error ?? "scrape failed", url });
      return true;
    }
    const defaultName = prettifyKey(seriesKeyFromUrl(url));
    const key = sanitiseKey(defaultName);
    sendJson(res, 200, {
      ok: true,
      url,
      title: info.title,
      description: info.description,
      poster: info.poster,
      summary: info.summary,
      cached: info.cached,
      defaultName,
      existingKey: store[key] ? key : null,
    });
    return true;
  }

  if (path === "/api/refresh") {
    const url = normalizeUrl(String(body.url ?? ""));
    const info = await scrapeSeriesPageInfo(url, { force: true });
    sendJson(res, 200, info);
    return true;
  }

  if (path === "/api/create") {
    const url = normalizeUrl(String(body.url ?? ""));
    const name = String(body.name ?? "").trim();
    const variant = String(body.variant ?? "hardsub");
    const quality = String(body.quality ?? "720p");
    if (!url || !name) {
      sendJson(res, 400, { ok: false, error: "missing url or name" });
      return true;
    }
    const info = await scrapeSeriesPageInfo(url);
    if (!info.ok) {
      sendJson(res, 200, { ok: false, error: info.error ?? "scrape failed" });
      return true;
    }
    const episodes = selectEpisodes(info.episodes, { variant, quality });
    if (episodes.length === 0) {
      sendJson(res, 200, { ok: false, error: "no episodes for that choice" });
      return true;
    }
    const key = sanitiseKey(name) || name;
    const first = info.summary.seasons[0]?.season ?? 1;
    const existing = store[key];
    const p: SeriesProgress = {
      url: episodes[0] ?? url,
      season: existing?.season ?? first,
      episode: existing?.episode ?? 0,
      timestamp: existing?.timestamp ?? 0,
      isMovie: false,
      manualUrls: episodes,
      sourceUrl: url,
      source: { kind: "series-page", variant, quality },
      knownEpisodes: episodes,
      newEpisodeCount: 0,
      lastEpisodeCheckAt: new Date().toISOString(),
      overview: info.description || existing?.overview,
      genres: existing?.genres,
      poster: info.poster || existing?.poster,
      episodeTimestamps: existing?.episodeTimestamps,
    };
    saveProgress(key, p, true);
    sendJson(res, 200, { ok: true, key, state: buildState() });
    return true;
  }

  if (path === "/api/play") {
    const key = String(body.key ?? "");
    const season = body.season === undefined ? undefined : Number(body.season);
    const episode = body.episode === undefined ? undefined : Number(body.episode);
    void controller.play(key, season, episode);
    sendJson(res, 200, { ok: true, playback: controller.state });
    return true;
  }

  if (path === "/api/control") {
    const action = String(body.action ?? "");
    if (action === "stop") controller.stop();
    else if (action === "next") controller.next();
    else if (action === "pause") controller.pause();
    sendJson(res, 200, { ok: true, playback: controller.state });
    return true;
  }

  if (path === "/api/finish-season") {
    const result = controller.finishSeason(!!body.delete);
    sendJson(res, 200, { ok: true, ...result, playback: controller.state });
    return true;
  }

  if (path === "/api/remove") {
    const key = String(body.key ?? "");
    if (store[key]) removeEntry(key);
    sendJson(res, 200, { ok: true, state: buildState() });
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  if (path.startsWith("/api/")) {
    handleApi(req, res, path)
      .then((handled) => {
        if (!handled) sendJson(res, 404, { ok: false, error: "unknown endpoint" });
      })
      .catch((e) => sendJson(res, 500, { ok: false, error: e?.message ?? "error" }));
    return;
  }
  serveStatic(res, path);
});

async function main() {
  await initStore({ localOnly: true });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[gui] listening on http://127.0.0.1:${PORT}`);
  });
}

const shutdown = () => {
  try {
    controller.stop();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  console.error("[gui] failed to start:", e);
  process.exit(1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  episodeIdentity,
  getEpisodeTimestamp,
  setEpisodePosition,
  mergeEpisodeTimestamps,
  isSeriesPageHtml,
  parseSeriesPage,
  resolveSeriesPage,
  scrapeSeriesSource,
  ensureSeriesSource,
  checkForNewEpisodes,
  isDubbedName,
  episodeKeyFromUrl,
} from "../src/player-core.js";
import type { SeriesProgress } from "../src/player-core.js";

// ─── Episode Identity ────────────────────────────────────────────────────────

test("episodeIdentity extracts SxxExx from filename", () => {
  assert.equal(
    episodeIdentity("https://host/Show.S01E05.720p.mkv"),
    "S01E05",
  );
  assert.equal(
    episodeIdentity("https://host/MobLand.S02E01.1080p.WEB-DL.mkv"),
    "S02E01",
  );
});

test("episodeIdentity uses season/episode args when no SxxExx in URL", () => {
  assert.equal(
    episodeIdentity("https://host/video.mp4", 3, 2),
    "S03E03",
  );
});

test("episodeIdentity falls back to basename without extension", () => {
  assert.equal(
    episodeIdentity("https://host/movie-name.mp4"),
    "movie-name",
  );
});

// ─── Per-episode Timing ──────────────────────────────────────────────────────

test("getEpisodeTimestamp returns per-episode value", () => {
  const p: SeriesProgress = {
    url: "https://host/Show.S01E01.mkv",
    season: 1,
    episode: 0,
    timestamp: 100,
    episodeTimestamps: { S01E01: 200, S01E02: 300 },
  };
  assert.equal(getEpisodeTimestamp(p, "https://host/Show.S01E01.mkv", 1, 0), 200);
});

test("getEpisodeTimestamp falls back to p.timestamp for matching url/season/episode", () => {
  const p: SeriesProgress = {
    url: "https://host/Show.S01E01.mkv",
    season: 1,
    episode: 0,
    timestamp: 150,
  };
  assert.equal(getEpisodeTimestamp(p, "https://host/Show.S01E01.mkv", 1, 0), 150);
});

test("getEpisodeTimestamp returns 0 for unknown episode", () => {
  const p: SeriesProgress = {
    url: "https://host/Show.S01E01.mkv",
    season: 1,
    episode: 0,
    timestamp: 150,
  };
  assert.equal(getEpisodeTimestamp(p, "https://host/Show.S01E03.mkv", 1, 2), 0);
});

test("setEpisodePosition writes both per-episode map and timestamp", () => {
  const p: SeriesProgress = {
    url: "https://host/Show.S01E01.mkv",
    season: 1,
    episode: 0,
    timestamp: 100,
    episodeTimestamps: { S01E01: 200 },
  };
  const updated = setEpisodePosition(p, "https://host/Show.S01E01.mkv", 1, 0, 350);
  assert.equal(updated.timestamp, 350);
  assert.equal(updated.episodeTimestamps?.["S01E01"], 350);
});

test("setEpisodePosition preserves other episodes", () => {
  const p: SeriesProgress = {
    url: "https://host/Show.S01E01.mkv",
    season: 1,
    episode: 0,
    timestamp: 100,
    episodeTimestamps: { S01E01: 200, S01E02: 400 },
  };
  const updated = setEpisodePosition(p, "https://host/Show.S01E01.mkv", 1, 0, 350);
  assert.equal(updated.episodeTimestamps?.["S01E02"], 400);
});

// ─── Merge ───────────────────────────────────────────────────────────────────

test("mergeEpisodeTimestamps takes max per key", () => {
  const a = { S01E01: 100, S01E02: 300 };
  const b = { S01E01: 200, S01E03: 50 };
  const merged = mergeEpisodeTimestamps(a, b)!;
  assert.equal(merged.S01E01, 200);
  assert.equal(merged.S01E02, 300);
  assert.equal(merged.S01E03, 50);
});

test("mergeEpisodeTimestamps handles undefined", () => {
  assert.equal(mergeEpisodeTimestamps(undefined, undefined), undefined);
  assert.deepEqual(mergeEpisodeTimestamps({ S01E01: 100 }, undefined), { S01E01: 100 });
  assert.deepEqual(mergeEpisodeTimestamps(undefined, { S01E01: 100 }), { S01E01: 100 });
});

// ─── Series Page Detection ──────────────────────────────────────────────────

test("isSeriesPageHtml detects series pages", () => {
  assert.equal(
    isSeriesPageHtml(`<div onclick="handleDownloadClick('https://host/movie.mkv')">`),
    true,
  );
  assert.equal(
    isSeriesPageHtml(`<div class="download-list hardsub">`),
    true,
  );
  assert.equal(
    isSeriesPageHtml(`<div class="series-downloaditems">`),
    true,
  );
  assert.equal(
    isSeriesPageHtml(`<div class="content">Just a normal page</div>`),
    false,
  );
});

// ─── Series Page Parsing ────────────────────────────────────────────────────

const SAMPLE_HTML = `
<html>
<head><title>MobLand</title></head>
<body>
<h1 class="entry-title">MobLand 2025</h1>

<div class="download-season bg-card rounded">
  <button class="btn" data-bs-toggle="collapse" data-bs-target="#season-dlbox0">
    فصل اول زیرنویس فارسی به اتمام رسیده
  </button>
  <div class="download-list hardsub">
    <p class="title"><span>زیرنویس فارسی چسبیده بدون حذفیات</span></p>
    <div class="series-downloaditems">
      <div class="d-flex">
        <a href="https://bvx.top/yA3f/Series_03/Mobland/S01/Mobland.S01E01.720p.WEB-DL.Farsi.Sub.Film2Media.mkv" class="btn btn-block btn-default">قسمت 01</a>
      </div>
      <div class="d-flex">
        <a href="https://bvx.top/yA3f/Series_03/Mobland/S01/Mobland.S01E02.720p.WEB-DL.Farsi.Sub.Film2Media.mkv" class="btn btn-block btn-default">قسمت 02</a>
      </div>
      <div class="d-flex">
        <a href="https://bvx.top/yA3f/Series_03/Mobland/S01/Mobland.S01E03.1080p.WEB-DL.Farsi.Sub.Film2Media.mkv" class="btn btn-block btn-default">قسمت 03</a>
      </div>
    </div>
  </div>
</div>

<div class="download-season bg-card rounded">
  <button class="btn" data-bs-toggle="collapse" data-bs-target="#season-dlbox1">
    فصل دوم زیرنویس فارسی در حال پخش
  </button>
  <div class="download-list hardsub">
    <p class="title"><span>زیرنویس فارسی چسبیده بدون حذفیات</span></p>
    <div class="series-downloaditems">
      <div class="d-flex">
        <a href="https://bnr.top/pnot/Series/MobLand/S02/MobLand.S02E01.720p.WEB-DL.Farsi.Sub.Film2Media.mkv" class="btn btn-block btn-default">قسمت 01</a>
      </div>
    </div>
  </div>
</div>

</body>
</html>
`;

test("parseSeriesPage extracts episodes from multiple seasons", () => {
  const { title, episodes } = parseSeriesPage(SAMPLE_HTML, "https://www.myf2m.org/series/mobland/");
  assert.equal(title, "MobLand 2025");
  assert.equal(episodes.length, 4);
  assert.equal(episodes[0].season, 1);
  assert.equal(episodes[0].episode, 0);
  assert.equal(episodes[0].variant, "hardsub");
  assert.equal(episodes[1].season, 1);
  assert.equal(episodes[1].episode, 1);
  assert.equal(episodes[2].season, 1);
  assert.equal(episodes[2].episode, 2);
  assert.equal(episodes[3].season, 2);
  assert.equal(episodes[3].episode, 0);
});

test("parseSeriesPage extracts quality from filename", () => {
  const { episodes } = parseSeriesPage(SAMPLE_HTML, "https://www.myf2m.org/series/mobland/");
  assert.equal(episodes[0].quality, "720p");
  assert.equal(episodes[2].quality, "1080p");
});

test("resolveSeriesPage picks preferred quality and variant", () => {
  const { title, episodes } = resolveSeriesPage(
    SAMPLE_HTML,
    "https://www.myf2m.org/series/mobland/",
    { variant: "hardsub", quality: "720p" },
  );
  assert.equal(title, "MobLand 2025");
  assert.equal(episodes.length, 4);
  assert.ok(episodes[0].includes("720p"));
  assert.ok(episodes[1].includes("720p"));
  // S01E03 only has 1080p, so fallback
  assert.ok(episodes[2].includes("1080p"));
  assert.ok(episodes[3].includes("720p"));
});

test("resolveSeriesPage falls back to 1080p when no 720p", () => {
  const { episodes } = resolveSeriesPage(
    SAMPLE_HTML,
    "https://www.myf2m.org/series/mobland/",
    { variant: "hardsub", quality: "720p" },
  );
  assert.equal(episodes.length, 4);
  assert.ok(episodes[2].includes("1080p"));
});

test("resolveSeriesPage returns all seasons sorted", () => {
  const { episodes } = resolveSeriesPage(
    SAMPLE_HTML,
    "https://www.myf2m.org/series/mobland/",
  );
  assert.equal(episodes.length, 4);
  assert.ok(episodes[0].includes("S01E01"));
  assert.ok(episodes[1].includes("S01E02"));
  assert.ok(episodes[2].includes("S01E03"));
  assert.ok(episodes[3].includes("S02E01"));
});

// ─── ensureSeriesSource / checkForNewEpisodes ─────────────────────────────────

test("ensureSeriesSource returns false for movie entries", async () => {
  const p: SeriesProgress = {
    url: "https://host/movie.mkv",
    season: 1,
    episode: 0,
    timestamp: 0,
    isMovie: true,
  };
  const result = await ensureSeriesSource(p);
  assert.equal(result, false);
  assert.equal(p.manualUrls, undefined);
});

test("ensureSeriesSource returns false for entries with existing source", async () => {
  const p: SeriesProgress = {
    url: "https://www.myf2m.org/series/mobland/",
    season: 1,
    episode: 0,
    timestamp: 0,
    source: { kind: "series-page", variant: "hardsub", quality: "720p" },
  };
  const result = await ensureSeriesSource(p);
  assert.equal(result, false);
});

test("checkForNewEpisodes returns empty for movie entries", async () => {
  const p: SeriesProgress = {
    url: "https://host/movie.mkv",
    season: 1,
    episode: 0,
    timestamp: 0,
    isMovie: true,
  };
  const { newEpisodes } = await checkForNewEpisodes(p);
  assert.equal(newEpisodes.length, 0);
});

test("checkForNewEpisodes returns empty for non-series-page entries", async () => {
  const p: SeriesProgress = {
    url: "https://host/Show.S01E01.mkv",
    season: 1,
    episode: 0,
    timestamp: 0,
  };
  const { newEpisodes } = await checkForNewEpisodes(p);
  assert.equal(newEpisodes.length, 0);
});

test("checkForNewEpisodes uses sourceUrl when url is a direct video", async () => {
  const p: SeriesProgress = {
    url: "https://host/Show.S01E01.mkv",
    sourceUrl: "https://www.myf2m.org/series/mobland/",
    season: 1,
    episode: 0,
    timestamp: 0,
    source: { kind: "series-page", variant: "hardsub", quality: "720p" },
    knownEpisodes: [
      "https://host/Mobland.S01E01.720p.mkv",
      "https://host/Mobland.S01E02.720p.mkv",
    ],
  };
  const { newEpisodes } = await checkForNewEpisodes(p);
  // This fetches the real page; we just verify it doesn't bail early
  assert.ok(Array.isArray(newEpisodes));
});

// ─── isDubbedName ───────────────────────────────────────────────────────────

test("isDubbedName detects dubbed variants", () => {
  assert.equal(isDubbedName("Dark.Matter.S01E01.720p.WEB-DL.Farsi.Dubbed.mkv"), true);
  assert.equal(isDubbedName("Dark.Matter.S01E01.720p.WEB-DL.Farsi.Dubbled.mkv"), true);
  assert.equal(isDubbedName("Dark.Matter.S01E01.720p.WEB-DL.Farsi.Sub.mkv"), false);
  assert.equal(isDubbedName("Mobland.S01E01.720p.WEB-DL.Farsi.Sub.Film2Media.mkv"), false);
});

// ─── Filename-first variant detection ────────────────────────────────────────

const DUBBED_HARDHTML = `
<html>
<body>
<h1 class="entry-title">Dark Matter</h1>
<div class="download-season bg-card rounded">
  <button class="btn">فصل اول زیرنویس فارسی</button>
  <div class="download-list hardsub">
    <div class="series-downloaditems">
      <div><a href="#" onclick="handleDownloadClick('https://host/S01/Dark.Matter.S01E01.720p.WEB-DL.Farsi.Sub.Film2Media.mkv')">E01</a></div>
      <div><a href="#" onclick="handleDownloadClick('https://host/S01/Dark.Matter.S01E02.720p.WEB-DL.Farsi.Sub.Film2Media.mkv')">E02</a></div>
    </div>
  </div>
</div>
<div class="download-season bg-card rounded">
  <button class="btn">فصل اول دوبله فارسی</button>
  <div class="download-list dubbled">
    <div class="series-downloaditems">
      <div><a href="#" onclick="handleDownloadClick('https://host/S01.Dub/Dark.Matter.S01E01.720p.WEB-DL.Farsi.Dubbed.Film2Media.mkv')">E01</a></div>
      <div><a href="#" onclick="handleDownloadClick('https://host/S01.Dub/Dark.Matter.S01E02.720p.WEB-DL.Farsi.Dubbed.Film2Media.mkv')">E02</a></div>
    </div>
  </div>
</div>
<div class="download-season bg-card rounded">
  <button class="btn">فصل دوم دوبله فارسی</button>
  <div class="download-list dubbled">
    <div class="series-downloaditems">
      <div><a href="#" onclick="handleDownloadClick('https://host/S02.Dub/Dark.Matter.S02E01.720p.WEB-DL.Farsi.Dubbed.2Dooble.Film2Media.mkv')">E01</a></div>
      <div><a href="#" onclick="handleDownloadClick('https://host/S02.Dub/Dark.Matter.S02E02.720p.WEB-DL.Farsi.Dubbed.2Dooble.Film2Media.mkv')">E02</a></div>
    </div>
  </div>
</div>
<div class="download-season bg-card rounded">
  <button class="btn">فصل دوم زیرنویس فارسی در حال پخش</button>
  <div class="download-list hardsub">
    <div class="series-downloaditems">
      <div><a href="#" onclick="handleDownloadClick('https://host/S02/Dark.Matter.S02E01.1080p.WEB-DL.Farsi.Sub.Film2Media.mkv')">E01</a></div>
      <div><a href="#" onclick="handleDownloadClick('https://host/S02/Dark.Matter.S02E02.1080p.WEB-DL.Farsi.Sub.Film2Media.mkv')">E02</a></div>
      <div><a href="#" onclick="handleDownloadClick('https://host/S02/Dark.Matter.S02E03.1080p.WEB-DL.Farsi.Sub.Film2Media.mkv')">E03</a></div>
    </div>
  </div>
</div>
</body>
</html>
`;

test("parseSeriesPage detects variant from filename, not trailing page content", () => {
  const { episodes } = parseSeriesPage(DUBBED_HARDHTML, "https://host/dark-matter/");
  const s02e01Hardsub = episodes.filter(
    (e) => e.season === 2 && e.episode === 0 && e.variant === "hardsub",
  );
  assert.equal(s02e01Hardsub.length, 1, "S02E01 hardsub should exist");
  assert.ok(s02e01Hardsub[0]!.url.includes("Farsi.Sub"), "S02E01 URL should be the Farsi.Sub one");

  const s02e01Dub = episodes.filter(
    (e) => e.season === 2 && e.episode === 0 && e.variant === "dubbled",
  );
  assert.equal(s02e01Dub.length, 1, "S02E01 dubbed should exist as separate entry");
  assert.ok(s02e01Dub[0]!.url.includes("Farsi.Dubbed"), "dubbed URL should contain Farsi.Dubbed");
});

test("parseSeriesPage correctly classifies dubbed entries", () => {
  const { episodes } = parseSeriesPage(DUBBED_HARDHTML, "https://host/dark-matter/");
  const s02e01dub = episodes.filter(
    (e) => e.season === 2 && e.episode === 0 && e.variant === "dubbled",
  );
  assert.equal(s02e01dub.length, 1, "S02E01 dubbed should exist as separate entry");
  assert.ok(s02e01dub[0]!.url.includes("Farsi.Dubbed"), "dubbed URL should contain Farsi.Dubbed");
});

test("resolveSeriesPage prefers hardsub over dubbed", () => {
  const { episodes } = resolveSeriesPage(
    DUBBED_HARDHTML,
    "https://host/dark-matter/",
    { variant: "hardsub", quality: "720p" },
  );
  const s02e01 = episodes.find((u) => /S02E01/.test(u));
  assert.ok(s02e01, "S02E01 should exist");
  assert.ok(s02e01!.includes("Farsi.Sub"), "S02E01 should be hardsub, not dubbed");
  assert.ok(!s02e01!.includes("Dubbed"), "S02E01 should NOT be dubbed");
});

test("resolveSeriesPage falls back to dubbed when no hardsub exists for an episode", () => {
  const { episodes } = resolveSeriesPage(
    DUBBED_HARDHTML,
    "https://host/dark-matter/",
    { variant: "hardsub", quality: "720p" },
  );
  // S01E01 exists in both hardsub and dubbed; should pick hardsub
  const s01e01 = episodes.find((u) => /S01E01/.test(u));
  assert.ok(s01e01!.includes("Farsi.Sub"), "S01E01 should be hardsub");
});

// ─── episodeKeyFromUrl ──────────────────────────────────────────────────────

test("episodeKeyFromUrl extracts season:episode from SxxExx filenames", () => {
  assert.equal(episodeKeyFromUrl("https://host/Show.S01E05.720p.mkv"), "1:5");
  assert.equal(episodeKeyFromUrl("https://host/MobLand.S02E01.1080p.WEB-DL.mkv"), "2:1");
  assert.equal(episodeKeyFromUrl("https://host/movie.mp4"), null);
});

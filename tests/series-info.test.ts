import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSeriesMeta,
  parseSeriesPageInfo,
  summarizeSeriesInfo,
  selectEpisodes,
} from "../src/player-core.js";

// Representative film2media/dooplay-style page: a generic og:description
// appears first, the real plot second, plus two season/download boxes.
const HTML = `<!doctype html><html dir="rtl"><head>
<meta name="description" content="generic site blurb" />
<meta property="og:description" content="generic site blurb" />
<meta property="og:title" content="MobLand" />
<meta property="og:description" content="The real plot description that is clearly the longest of the candidates in this page." />
<script type="application/ld+json">{"thumbnailUrl":"https://cdn.example/poster.jpg"}</script>
</head><body>
<h1 class="entry-title">MobLand 2025</h1>

<div class="download-season bg-card rounded">
  <button>دانلود دوبله فارسی</button>
  <div class="download-list">
    <a href="#" onclick="handleDownloadClick('https://x/Mobland.S01E01.720p.Dubbed.mkv')">a</a>
    <a href="#" onclick="handleDownloadClick('https://x/Mobland.S01E02.720p.Dubbed.mkv')">b</a>
  </div>
</div>

<div class="download-season bg-card rounded">
  <button>دانلود با زیرنویس چسبیده</button>
  <div class="download-list">
    <a href="#" onclick="handleDownloadClick('https://x/Mobland.S01E01.720p.Farsi.Sub.mkv')">c</a>
    <a href="#" onclick="handleDownloadClick('https://x/Mobland.S01E01.1080p.Farsi.Sub.mkv')">d</a>
    <a href="#" onclick="handleDownloadClick('https://x/Mobland.S01E02.720p.Farsi.Sub.mkv')">e</a>
  </div>
</div>
</body></html>`;

test("parseSeriesMeta prefers the h1 title, longest description, and ld+json poster", () => {
  const meta = parseSeriesMeta(HTML);
  assert.equal(meta.title, "MobLand 2025");
  assert.match(meta.description, /real plot/);
  assert.equal(meta.poster, "https://cdn.example/poster.jpg");
});

test("parseSeriesPageInfo extracts episodes and a summary", () => {
  const info = parseSeriesPageInfo(HTML, "https://x/series/mobland/");
  assert.equal(info.episodes.length, 5);
  assert.equal(info.summary.totalEpisodes, 2);
  assert.deepEqual(info.summary.seasons, [{ season: 1, episodeCount: 2 }]);
  assert.deepEqual([...info.summary.variants].sort(), ["dubbled", "hardsub"]);
  assert.deepEqual(info.summary.qualities, ["720p", "1080p"]);
});

test("selectEpisodes picks the requested variant and quality per episode", () => {
  const { episodes } = parseSeriesPageInfo(HTML, "https://x/series/mobland/");

  const dub = selectEpisodes(episodes, { variant: "dubbled", quality: "720p" });
  assert.equal(dub.length, 2);
  assert.ok(dub.every((u) => /Dubbed/.test(u)));

  // E01 has 1080p, E02 only 720p — each episode independently falls back.
  const hard1080 = selectEpisodes(episodes, {
    variant: "hardsub",
    quality: "1080p",
  });
  assert.equal(hard1080.length, 2);
  assert.ok(/1080p\.Farsi\.Sub/.test(hard1080[0]!));
  assert.ok(/720p\.Farsi\.Sub/.test(hard1080[1]!));

  // Requested quality missing for a variant → falls back to closest available.
  const dub1080 = selectEpisodes(episodes, {
    variant: "dubbled",
    quality: "1080p",
  });
  assert.equal(dub1080.length, 2);
  assert.ok(dub1080.every((u) => /720p\.Dubbed/.test(u)));
});

test("summarizeSeriesInfo groups seasons and qualities", () => {
  const summary = summarizeSeriesInfo([
    { season: 1, episode: 0, variant: "hardsub", quality: "720p", url: "a" },
    { season: 1, episode: 1, variant: "hardsub", quality: "1080p", url: "b" },
    { season: 2, episode: 0, variant: "dubbled", quality: "720p", url: "c" },
  ]);
  assert.equal(summary.totalEpisodes, 3);
  assert.deepEqual(summary.seasons, [
    { season: 1, episodeCount: 2 },
    { season: 2, episodeCount: 1 },
  ]);
  assert.deepEqual(summary.qualities, ["720p", "1080p"]);
});

// ── movie pages (no download-season boxes) ─────────────────────────────────

const MOVIE_HTML = `<!doctype html><html dir="rtl"><head>
<meta property="og:title" content="Spider-Man: Brand New Day" />
<meta property="og:description" content="The movie plot." />
</head><body>
<h1 class="entry-title">Spider-Man: Brand New Day (2026)</h1>

<div class="download-list">
  <h2>دانلود فیلم با دوبله فارسی</h2>
  <a href="#" onclick="handleDownloadClick('https://x/Spider.Man.Brand.New.Day.2026.1080p.6CH.Farsi.Dubbed.mkv')">1080p</a>
  <a href="#" onclick="handleDownloadClick('https://x/Spider.Man.Brand.New.Day.2026.720p.6CH.Farsi.Dubbed.mkv')">720p</a>
</div>
<div class="download-list">
  <h2>دانلود فیلم با زیرنویس چسبیده</h2>
  <a href="#" onclick="handleDownloadClick('https://x/Spider.Man.Brand.New.Day.2026.1080p.6CH.Farsi.Sub.mkv')">1080p</a>
  <a href="#" onclick="handleDownloadClick('https://x/Spider.Man.Brand.New.Day.2026.720p.6CH.Farsi.Sub.mkv')">720p</a>
</div>
</body></html>`;

test("movie pages: parsed without season boxes, classified as a movie", () => {
  const info = parseSeriesPageInfo(MOVIE_HTML, "https://x/movie/76906/spider-man/");
  assert.equal(info.episodes.length, 4);
  assert.equal(info.isMovie, true);
  assert.equal(info.summary.totalEpisodes, 1);
  assert.deepEqual(info.summary.seasons, [{ season: 1, episodeCount: 1 }]);
  assert.deepEqual([...info.summary.variants].sort(), ["dubbled", "hardsub"]);
  assert.deepEqual(info.summary.qualities, ["720p", "1080p"]);

  const dub = selectEpisodes(info.episodes, { variant: "dubbled", quality: "720p" });
  assert.equal(dub.length, 1);
  assert.ok(dub[0]!.includes("Dubbed"));

  const sub1080 = selectEpisodes(info.episodes, { variant: "hardsub", quality: "1080p" });
  assert.equal(sub1080.length, 1);
  assert.ok(sub1080[0]!.includes("1080p") && sub1080[0]!.includes("Sub"));
});

test("series pages are not misclassified as movies", () => {
  const info = parseSeriesPageInfo(HTML, "https://x/series/mobland/");
  assert.equal(info.isMovie, false);
});

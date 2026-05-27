#!/usr/bin/env node
// player.ts — thin CLI wrapper; all core logic lives in player-core.ts

import * as readline from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  type SeriesProgress,
  type ProgressStore,
  type PlayTarget,
  type PlayResult,
  type VlcPrompts,
  store,
  initStore,
  saveProgress,
  removeEntry,
  flushSync,
  schedulePush,
  playWithMpv,
  deleteVideoCache,
  renderProgress,
  formatTime,
  extractEpisodeNumber,
  seriesKeyFromUrl,
  seriesKeyFromUrlList,
  sanitiseKey,
  isDirectVideoUrl,
  getSeasonUrl,
  fetchDirectoryListing,
  resolveEpisodes,
  splitUrlBlock,
  storeToSeriesProject,
  parseImportFile,
  mergeStores,
  IS_TERMUX,
  VIDEO_DIR,
  CONFIG_DIR,
  CACHE_DIR,
  getStorageBootstrapState,
  getPreferredSecretsPath,
  setStorageModeChoice,
  QuitToMenu,
  fuzzyMatch,
  clearEpisodeCache,
  cleanFilename,
  findMpv,
} from "./player-core.js";

// ─── READLINE HELPERS ─────────────────────────────────────────────────────────

function isQuit(s: string) {
  return ["q", "quit", "back", "b", "exit"].includes(s.trim().toLowerCase());
}

function prompt(question: string): Promise<string> {
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
async function promptQ(question: string): Promise<string> {
  const ans = await prompt(question);
  if (isQuit(ans)) throw new QuitToMenu();
  return ans;
}
async function promptYN(question: string): Promise<boolean> {
  const ans = await prompt(question);
  if (isQuit(ans)) throw new QuitToMenu();
  const n = ans.toLowerCase();
  return n === "" || n === "y" || n === "yes";
}
async function promptYNSoft(question: string): Promise<boolean> {
  const ans = await prompt(question);
  if (isQuit(ans)) return false;
  const n = ans.toLowerCase();
  return n === "" || n === "y" || n === "yes";
}
async function promptNumber(
  question: string,
  defaultVal: number,
): Promise<number> {
  const ans = await promptQ(question);
  if (!ans) return defaultVal;
  const n = parseInt(ans, 10);
  return isNaN(n) ? defaultVal : n;
}

async function maybeRunStorageSetup(): Promise<void> {
  const bootstrap = getStorageBootstrapState();
  if (!bootstrap.needsPrompt) return;
  console.log(
    "\nDo you want to store your data locally only, or sync to a cloud provider (Arvan, AWS S3, Cloudflare R2, etc.)?",
  );
  const ans = (await prompt("Choose [local/cloud]: ")).toLowerCase();
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
  console.log("  4) Restart the app.");
}

// VlcPrompts implementation using readline (for the CLI runSession path)
const cliPrompts: VlcPrompts = {
  yn: promptYNSoft,
  ask: prompt,
};

// ─── URL BLOCK READER ─────────────────────────────────────────────────────────

function readPastedLines(firstLine: string): Promise<string[]> {
  return new Promise((resolve) => {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const u of splitUrlBlock(firstLine)) {
      if (!seen.has(u)) {
        seen.add(u);
        lines.push(u);
      }
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      rl.close();
      resolve(lines);
    };
    const IDLE_MS = 800;
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(done, IDLE_MS);
    };
    rl.on("line", (line) => {
      for (const u of splitUrlBlock(line)) {
        if (u && !seen.has(u)) {
          seen.add(u);
          lines.push(u);
        }
      }
      reset();
    });
    rl.on("close", () => {
      if (timer) clearTimeout(timer);
      resolve(lines);
    });
    reset();
  });
}

// ─── PROMPT FOR MANUAL URLS ───────────────────────────────────────────────────

async function promptManualUrls(context: string): Promise<string[]> {
  console.log(`\n[directory] No episodes found at: ${context}`);
  console.log("Enter episode URLs one per line (blank = done, q = back).\n");
  const urls: string[] = [];
  while (true) {
    const line = await prompt(`  URL ${urls.length + 1}: `);
    if (isQuit(line)) return [];
    if (!line) break;
    if (
      !/^https?:\/\/.+\.(mp4|mkv|avi|mov|webm|m4v|ts|flv)(\?.*)?$/i.test(line)
    ) {
      console.log("  (not a recognized video URL — skipped)");
      continue;
    }
    urls.push(line);
    console.log(`  ✓ added (${urls.length} total)`);
  }
  if (urls.length === 0) return [];
  return urls.sort((a, b) => extractEpisodeNumber(a) - extractEpisodeNumber(b));
}

// ─── HARDSUB INTEGRATION ─────────────────────────────────────────────────────

import { spawn as nodeSpawn, execSync as nodeExecSync } from "child_process";

async function offerHardsub(localPath: string): Promise<void> {
  if (!existsSync(localPath)) return;
  try {
    nodeExecSync("which stoh", { stdio: "ignore" });
  } catch {
    return;
  }
  let want: boolean;
  try {
    want = await promptYN("\nCreate hardsub from this episode? [y/N]: ");
  } catch {
    return;
  }
  if (!want) return;
  let rawDir: string;
  try {
    rawDir = await promptQ(`Output folder [${join(localPath, "..")}]: `);
  } catch {
    return;
  }
  const outputDir = rawDir || join(localPath, "..");
  const displayName = cleanFilename(localPath);
  console.log(
    `\n[hardsub] Starting in background: ${displayName}\n[hardsub] Output → ${outputDir}\n`,
  );
  let totalSeconds = 0;
  try {
    const probe = nodeExecSync(
      `ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "${localPath}"`,
      { encoding: "utf-8" },
    ).trim();
    totalSeconds = parseFloat(probe) || 0;
  } catch {}
  const proc = nodeSpawn("stoh", [localPath, "-t", "0", "-d", outputDir], {
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
      process.stdout.write(
        `\r[hardsub] ${displayName}  ${formatTime(Math.round(t))}${pct}   `,
      );
      hadProgress = true;
    }
  }
  proc.stdout?.on("data", handleOutput);
  proc.stderr?.on("data", handleOutput);
  proc.on("exit", (code) => {
    if (hadProgress) process.stdout.write("\n");
    console.log(
      code === 0
        ? `[hardsub] ✓ Done: ${displayName}`
        : `[hardsub] ✗ Failed (exit ${code}): ${displayName}`,
    );
  });
}

// ─── FINISHED STATE PROMPT ────────────────────────────────────────────────────

async function promptAfterFinished(
  key: string,
  p: SeriesProgress,
): Promise<void> {
  if (p.isOnetime) {
    removeEntry(key);
    console.log(`[one-time] Removed "${key}".`);
    return;
  }
  console.log("\nWhat do you want to do?");
  console.log("  r)  Remove from list");
  console.log("  f)  Mark as finished  (keeps entry, shows ✓ finished)");
  console.log("  q)  Do nothing");
  const ans = (await prompt("Choice [f]: ")).toLowerCase().trim();
  if (ans === "r") {
    removeEntry(key);
    await flushSync();
    console.log(`Removed "${key}".`);
  } else if (!isQuit(ans)) {
    store[key] = { ...p, finished: true, updatedAt: new Date().toISOString() };
    saveProgress(key, store[key]!);
    await flushSync();
    console.log(`Marked "${key}" as finished. ✓`);
  }
}

// ─── SEARCH ──────────────────────────────────────────────────────────────────

async function searchAndPlay(): Promise<PlayTarget | null> {
  const allKeys = Object.keys(store).sort();
  if (allKeys.length === 0) {
    console.log("No entries saved yet.");
    return null;
  }

  while (true) {
    const query = await prompt("Search (q = back): ");
    if (isQuit(query) || !query) return null;

    const results = fuzzyMatch(query, allKeys);
    if (results.length === 0) {
      console.log(`  No matches for "${query}"`);
      continue;
    }

    let selectedKey: string;

    if (results.length === 1) {
      selectedKey = results[0];
    } else {
      console.log(`\n  ${results.length} matches:`);
      results.forEach((k, i) => {
        const p = store[k]!;
        console.log(
          `  ${String(i + 1).padStart(2)})  ${k.padEnd(32)} ${renderProgress(p)}`,
        );
      });
      console.log();
      const pick = await prompt(
        "Pick number (Enter = search again, q = back): ",
      );
      if (isQuit(pick)) return null;
      if (!pick) continue;
      const idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= results.length) {
        console.log("  Invalid.");
        continue;
      }
      selectedKey = results[idx]!;
    }

    const saved = store[selectedKey]!;
    console.log(`\n  ${selectedKey.padEnd(32)} ${renderProgress(saved)}`);
    const action = (
      await prompt("  p) Play   e) Edit   d) Delete   Enter = back: ")
    )
      .toLowerCase()
      .trim();
    if (action === "p" || action === "play") {
      return {
        key: selectedKey,
        p: saved,
        season: saved.season,
        episode: saved.episode,
        timestamp: saved.timestamp,
      };
    } else if (action === "e" || action === "edit") {
      const sub = (
        await prompt("  n=rename  u=url  f=toggle-finished  m=toggle-movie  q=back: ")
      )
        .toLowerCase()
        .trim();
      if (sub === "n") {
        const newName = (
          await prompt(`  New name [Enter keep "${selectedKey}"]: `)
        ).trim();
        if (newName && newName !== selectedKey && !store[newName]) {
          store[newName] = { ...saved };
          delete store[selectedKey];
          schedulePush(true);
          console.log(`  Renamed to "${newName}".`);
        }
      } else if (sub === "u") {
        const newUrl = (
          await prompt("  New URL [Enter keep current]: ")
        ).trim();
        if (newUrl && newUrl !== saved.url) {
          clearEpisodeCache(saved.url);
          store[selectedKey] = { ...saved, url: newUrl, manualUrls: undefined };
          schedulePush(true);
          console.log("  URL updated.");
        }
      } else if (sub === "f") {
        saveProgress(selectedKey, { ...saved, finished: !saved.finished });
        console.log(
          `  Marked as ${store[selectedKey]!.finished ? "finished ✓" : "not finished"}.`,
        );
      } else if (sub === "m") {
        saveProgress(selectedKey, { ...saved, isMovie: !saved.isMovie });
        console.log(
          `  Marked as ${store[selectedKey]!.isMovie ? "movie" : "not movie"}.`,
        );
      }
      continue;
    } else if (action === "d" || action === "delete") {
      try {
        const ok = await promptYN(`  Remove "${selectedKey}"? [y/N]: `);
        if (ok) {
          removeEntry(selectedKey);
          await flushSync();
          console.log(`  Removed "${selectedKey}".`);
        }
      } catch {}
      continue;
    }
    continue;
  }
}

// ─── INTERACTIVE MENU ────────────────────────────────────────────────────────

async function interactiveMenu(): Promise<PlayTarget | null> {
  const keys = Object.keys(store).sort();
  const onetime = keys.filter((k) => store[k]!.isOnetime);
  const regular = keys.filter((k) => !store[k]!.isOnetime);

  console.log(
    "\n┌─ Saved series / movies ─────────────────────────────────────┐",
  );
  if (regular.length === 0) {
    console.log("│  (none)");
  } else
    regular.forEach((k, i) => {
      const p = store[k]!;
      console.log(
        `│  ${String(i + 1).padStart(2)})  ${k.padEnd(30)} ${renderProgress(p)}`,
      );
    });
  console.log("│");
  console.log("│   n)  New series / movie");
  console.log("│   /)  Search");
  console.log("│   e)  Edit series name / URL / status");
  console.log("│   d)  Remove a series");
  console.log("│   i)  Import progress from file");
  console.log("│   x)  Export progress to file");
  console.log("│   q)  Quit");
  console.log(
    "└─────────────────────────────────────────────────────────────┘",
  );

  if (onetime.length > 0) {
    console.log(
      "┌─ One-time (auto-removed when done) ─────────────────────────┐",
    );
    onetime.forEach((k, i) => {
      const p = store[k]!;
      console.log(
        `│  ${String.fromCharCode(97 + i)})   ${k.padEnd(30)} ${renderProgress(p)}`,
      );
    });
    console.log(
      "└─────────────────────────────────────────────────────────────┘",
    );
  }
  console.log("  tip: / to search · q or b anywhere to go back\n");

  const choice = await prompt("Choice (q to quit): ");
  const lower = choice.toLowerCase().trim();
  if (lower === "q" || isQuit(lower)) return null;

  if (/^[a-z]$/.test(lower)) {
    const idx = lower.charCodeAt(0) - 97;
    if (idx < onetime.length) {
      const key = onetime[idx]!;
      const saved = store[key]!;
      console.log(`\nResuming one-time: ${key}  ${renderProgress(saved)}`);
      try {
        const change = await promptYN(
          "Start from a different episode? [y/N]: ",
        );
        if (change) {
          const season = await promptNumber(
            `  Season  [${saved.season}]: `,
            saved.season,
          );
          const episode = await promptNumber(
            `  Episode [${saved.episode + 1}]: `,
            saved.episode + 1,
          );
          return { key, p: saved, season, episode: episode - 1, timestamp: 0 };
        }
      } catch {
        return interactiveMenu();
      }
      return {
        key,
        p: saved,
        season: saved.season,
        episode: saved.episode,
        timestamp: saved.timestamp,
      };
    }
  }

  if (lower === "/" || lower === "s" || lower === "search") {
    const result = await searchAndPlay();
    if (!result) return interactiveMenu();
    return result;
  }

  if (lower === "e") {
    if (regular.length === 0) {
      console.log("Nothing to edit.");
      return interactiveMenu();
    }
    let idxStr: string;
    try {
      idxStr = await promptQ("Edit which number? ");
    } catch {
      return interactiveMenu();
    }
    const idx = parseInt(idxStr, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= regular.length) {
      console.log("Invalid.");
      return interactiveMenu();
    }
    const oldKey = regular[idx]!;
    const saved = store[oldKey]!;
    console.log(
      `\nEditing: "${oldKey}"\n  URL: ${saved.url}\n  Status: ${renderProgress(saved)}`,
    );
    console.log(
      "  n)  Rename\n  u)  Change URL\n  f)  Toggle finished\n  m)  Toggle movie\n  q)  Back",
    );
    const sub = (await prompt("Edit what? ")).toLowerCase().trim();
    if (isQuit(sub)) return interactiveMenu();
    if (sub === "n") {
      const newName = (
        await prompt(`New name [Enter to keep "${oldKey}"]: `)
      ).trim();
      if (newName && newName !== oldKey) {
        if (store[newName]) {
          console.log(`"${newName}" already exists.`);
        } else {
          store[newName] = { ...saved };
          delete store[oldKey];
          schedulePush(true);
          console.log(`Renamed to "${newName}".`);
        }
      }
    } else if (sub === "u") {
      const newUrl = (await prompt("New URL [Enter to keep current]: ")).trim();
      if (newUrl && newUrl !== saved.url) {
        clearEpisodeCache(saved.url);
        store[oldKey] = { ...saved, url: newUrl, manualUrls: undefined };
        schedulePush(true);
        console.log(`URL updated. Episode cache cleared.`);
      }
    } else if (sub === "f") {
      saveProgress(oldKey, { ...saved, finished: !saved.finished });
      console.log(
        `"${oldKey}" marked as ${store[oldKey]!.finished ? "finished ✓" : "not finished"}.`,
      );
    } else if (sub === "m") {
      saveProgress(oldKey, { ...saved, isMovie: !saved.isMovie });
      console.log(
        `"${oldKey}" marked as ${store[oldKey]!.isMovie ? "movie" : "not movie"}.`,
      );
    }
    return interactiveMenu();
  }

  if (lower === "i" || lower === "import") {
    await importProgress();
    return interactiveMenu();
  }

  if (lower === "x" || lower === "export") {
    await exportProgress();
    return interactiveMenu();
  }

  if (lower === "d") {
    if (keys.length === 0) {
      console.log("Nothing to remove.");
      return interactiveMenu();
    }
    console.log("\nEnter number(s) to remove. Examples:");
    console.log("  5        → remove entry 5");
    console.log("  1 3 7    → remove entries 1, 3 and 7");
    console.log("  2-5      → remove entries 2 through 5");
    console.log("  all      → remove ALL entries (asks confirmation)");
    let input: string;
    try {
      input = (await promptQ("Remove which? (q to back): "))
        .toLowerCase()
        .trim();
    } catch {
      return interactiveMenu();
    }

    if (input === "all") {
      try {
        const ok = await promptYN(
          `Remove ALL ${regular.length} entries? This cannot be undone. [y/N]: `,
        );
        if (ok) {
          for (const k of regular) removeEntry(k);
          await flushSync();
          console.log(`Removed all ${regular.length} entries.`);
        }
      } catch {}
      return interactiveMenu();
    }

    if (/^[a-z]$/.test(input)) {
      const idx = input.charCodeAt(0) - 97;
      if (idx >= onetime.length) {
        console.log("Invalid.");
        return interactiveMenu();
      }
      const key = onetime[idx]!;
      try {
        const ok = await promptYN(`Remove one-time "${key}"? [y/N]: `);
        if (ok) {
          removeEntry(key);
          console.log(`Removed "${key}".`);
        }
      } catch {}
      return interactiveMenu();
    }

    const toRemove = new Set<string>();
    const tokens = input.split(/[\s,]+/).filter(Boolean);
    for (const tok of tokens) {
      const rangeMatch = tok.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const from = parseInt(rangeMatch[1]!, 10) - 1;
        const to = parseInt(rangeMatch[2]!, 10) - 1;
        for (
          let i = Math.max(0, from);
          i <= Math.min(regular.length - 1, to);
          i++
        )
          toRemove.add(regular[i]!);
      } else {
        const idx = parseInt(tok, 10) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < regular.length)
          toRemove.add(regular[idx]!);
      }
    }

    if (toRemove.size === 0) {
      console.log("No valid entries selected.");
      return interactiveMenu();
    }

    const list = [...toRemove];
    console.log(
      `\nWill remove (${list.length}): ${list.slice(0, 8).join(", ")}${list.length > 8 ? ` …+${list.length - 8}` : ""}`,
    );
    try {
      const ok = await promptYN(`Confirm? [y/N]: `);
      if (ok) {
        for (const k of list) removeEntry(k);
        await flushSync();
        console.log(
          `Removed ${list.length} entr${list.length === 1 ? "y" : "ies"}.`,
        );
      }
    } catch {}
    return interactiveMenu();
  }

  if (lower !== "n") {
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < regular.length) {
      const key = regular[idx]!;
      const saved = store[key]!;
      console.log(`\nResuming: ${key}  ${renderProgress(saved)}`);
      if (!saved.isMovie) {
        try {
          const change = await promptYN(
            "Start from a different episode? [y/N]: ",
          );
          if (change) {
            const season = await promptNumber(
              `  Season  [${saved.season}]: `,
              saved.season,
            );
            const episode = await promptNumber(
              `  Episode [${saved.episode + 1}]: `,
              saved.episode + 1,
            );
            return {
              key,
              p: saved,
              season,
              episode: episode - 1,
              timestamp: 0,
            };
          }
        } catch {
          return interactiveMenu();
        }
      }
      return {
        key,
        p: saved,
        season: saved.season,
        episode: saved.episode,
        timestamp: saved.timestamp,
      };
    }
  }

  // ── new series / movie ────────────────────────────────────────────────────
  console.log(
    "\nPaste one URL (movie/series directory) or multiple episode URLs at once.",
  );
  console.log(
    "  Single movie:   https://example.com/movies/Interstellar.2014.mkv",
  );
  console.log(
    "  Series folder:  https://example.com/House.M.D/Soft.Sub/S01/720p/",
  );
  console.log(
    "  Multi-URL:      paste all episode links at once — one per line OR all",
  );
  console.log(
    "                  concatenated (the player splits on https:// boundaries)",
  );
  console.log("  (q = go back)\n");

  const rawInput = await prompt("URL(s): ");
  if (isQuit(rawInput)) return interactiveMenu();
  if (!rawInput) return interactiveMenu();

  const allLines = await readPastedLines(rawInput);
  const videoUrls = allLines.filter((l) =>
    /^https?:\/\/.+\.(mp4|mkv|avi|mov|webm|m4v|ts|flv)(\?.*)?$/i.test(l),
  );

  if (videoUrls.length > 1) {
    const guessedKey = seriesKeyFromUrlList(videoUrls);
    console.log(`\nDetected ${videoUrls.length} episode URLs.`);
    const cleanGuessedKey = sanitiseKey(guessedKey);
    console.log(`Series name detected as: "${cleanGuessedKey}"`);
    const cn = await prompt(
      `Custom name? [Enter to keep "${cleanGuessedKey}"]: `,
    );
    if (isQuit(cn)) return interactiveMenu();
    const seriesKey = sanitiseKey(cn.trim() || cleanGuessedKey);

    console.log(
      "\nOptional: paste the series directory URL (for auto-fetching future seasons).",
    );
    console.log("  e.g. https://example.com/House.M.D/Soft.Sub/S01/720p/");
    const dirRaw = await prompt("Directory URL [Enter to skip]: ");
    const dirUrl =
      !isQuit(dirRaw) && dirRaw.trim() && !isDirectVideoUrl(dirRaw.trim())
        ? dirRaw.trim()
        : "";

    const isOnetime = await promptYN(
      "One-time? (auto-removed when done) [y/N]: ",
    );

    const existing = store[seriesKey];
    const startEpisode = existing?.episode ?? 0;
    const startTimestamp =
      existing?.season === 1 && existing?.episode === startEpisode
        ? (existing?.timestamp ?? 0)
        : 0;

    const sortedUrls = videoUrls.sort(
      (a, b) => extractEpisodeNumber(a) - extractEpisodeNumber(b),
    );

    const detectedSeason = (() => {
      for (const u of sortedUrls) {
        const m = (u.split("/").pop() ?? "").match(/[Ss](\d+)[Ee]\d+/);
        if (m) return parseInt(m[1]!, 10);
      }
      return 1;
    })();

    const p: SeriesProgress = {
      url: dirUrl || sortedUrls[0]!,
      season: detectedSeason,
      episode: startEpisode,
      timestamp: startTimestamp,
      manualUrls: sortedUrls,
      isMovie: false,
      isOnetime,
    };
    saveProgress(seriesKey, p);
    return {
      key: seriesKey,
      p,
      season: detectedSeason,
      episode: startEpisode,
      timestamp: startTimestamp,
    };
  }

  const url = videoUrls[0] ?? allLines[0]!;

  if (isDirectVideoUrl(url)) {
    const guessedName = decodeURIComponent(
      url
        .split("/")
        .pop()!
        .split("?")[0]
        .replace(/\.[^.]+$/, ""),
    );
    const cn = await prompt(`Name? [Enter to use "${guessedName}"]: `);
    if (isQuit(cn)) return interactiveMenu();
    const movieKey = sanitiseKey(cn.trim() || guessedName);
    const isOnetime = await promptYN("One-time? [y/N]: ");
    const existing = store[movieKey];
    const p: SeriesProgress = {
      url,
      season: 1,
      episode: 0,
      timestamp: existing?.timestamp ?? 0,
      isMovie: true,
      isOnetime,
    };
    saveProgress(movieKey, p);
    if (p.timestamp > 0)
      console.log(`Resuming from: ${formatTime(p.timestamp)}`);
    return { key: movieKey, p, season: 1, episode: 0, timestamp: p.timestamp };
  }

  let seriesKey = seriesKeyFromUrl(url);
  console.log(`Series detected as: "${seriesKey}"`);
  const cn2 = await prompt(`Custom name? [Enter to keep "${seriesKey}"]: `);
  if (isQuit(cn2)) return interactiveMenu();
  if (cn2.trim()) seriesKey = sanitiseKey(cn2.trim());

  const movieChoice = await promptYN("Is this a single movie/special? [y/N]: ");
  const isOnetime = await promptYN("One-time? [y/N]: ");

  if (movieChoice) {
    const existing = store[seriesKey];
    const p: SeriesProgress = {
      url,
      season: 1,
      episode: 0,
      timestamp: existing?.timestamp ?? 0,
      isMovie: true,
      isOnetime,
    };
    saveProgress(seriesKey, p);
    return { key: seriesKey, p, season: 1, episode: 0, timestamp: p.timestamp };
  }

  let season: number, episode: number;
  try {
    season = await promptNumber("Season  [1]: ", 1);
    episode = await promptNumber("Episode [1]: ", 1);
  } catch {
    return interactiveMenu();
  }
  const existing = store[seriesKey];
  const p: SeriesProgress = {
    url,
    season,
    episode: episode - 1,
    timestamp: 0,
    isOnetime,
  };
  if (existing?.manualUrls) p.manualUrls = existing.manualUrls;
  saveProgress(seriesKey, p);
  return { key: seriesKey, p, season, episode: episode - 1, timestamp: 0 };
}

// ─── LIST COMMAND ─────────────────────────────────────────────────────────────

function listAllProgress() {
  const keys = Object.keys(store).sort();
  if (keys.length === 0) {
    console.log("No progress saved yet.");
    return;
  }
  console.log("\nSaved progress:\n" + "─".repeat(60));
  for (const key of keys) {
    const p = store[key]!;
    const updated = p.updatedAt
      ? ` (${new Date(p.updatedAt).toLocaleString()})`
      : "";
    console.log(`  ${key.padEnd(32)} ${renderProgress(p)}${updated}`);
  }
  console.log("─".repeat(60));
}

// ─── IMPORT / EXPORT (readline versions for CLI) ──────────────────────────────

async function exportProgress(): Promise<void> {
  const keys = Object.keys(store);
  if (keys.length === 0) {
    console.log("\nNothing to export.");
    return;
  }

  const defaultPath = join(
    homedir(),
    `player-export-${new Date().toISOString().slice(0, 10)}.json`,
  );
  let dest: string;
  try {
    dest = await promptQ(`Export to [${defaultPath}]: `);
  } catch {
    return;
  }
  if (!dest.trim()) dest = defaultPath;

  const out = storeToSeriesProject(store);
  try {
    writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log(`\n✓ Exported ${keys.length} entries to: ${dest}`);
    console.log(
      `   Format: series-project JSON (importable by both player and series-project web app)`,
    );
  } catch (e) {
    console.error(`\n✗ Export failed: ${(e as Error).message}`);
  }
}

async function importProgress(filePath?: string): Promise<void> {
  let src = filePath ?? "";
  if (!src) {
    try {
      src = await promptQ("Path to import file: ");
    } catch {
      return;
    }
    src = src.trim();
  }
  if (!src) {
    console.log("No path given.");
    return;
  }
  if (!existsSync(src)) {
    console.error(`\n✗ File not found: ${src}`);
    return;
  }

  let imported: ProgressStore;
  try {
    const raw = JSON.parse(readFileSync(src, "utf-8"));
    imported = parseImportFile(raw);
  } catch (e) {
    console.error(`\n✗ Could not parse file: ${(e as Error).message}`);
    return;
  }

  const importedKeys = Object.keys(imported);
  if (importedKeys.length === 0) {
    console.log("\nFile is empty or unrecognised format — nothing imported.");
    return;
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

  console.log(`\nImport preview from: ${src} (${importedKeys.length} entries)`);
  if (newEntries.length)
    console.log(
      `  New entries   (${newEntries.length}): ${newEntries.slice(0, 5).join(", ")}${newEntries.length > 5 ? ` …+${newEntries.length - 5}` : ""}`,
    );
  if (updatedEntries.length)
    console.log(
      `  Updates       (${updatedEntries.length}): ${updatedEntries.slice(0, 5).join(", ")}${updatedEntries.length > 5 ? ` …+${updatedEntries.length - 5}` : ""}`,
    );
  if (skippedEntries.length)
    console.log(
      `  Already ahead (${skippedEntries.length}): ${skippedEntries.slice(0, 5).join(", ")}${skippedEntries.length > 5 ? ` …+${skippedEntries.length - 5}` : ""}`,
    );

  if (newEntries.length === 0 && updatedEntries.length === 0) {
    console.log("\nLocal progress is already ahead — nothing to import.");
    return;
  }

  let ok: boolean;
  try {
    ok = await promptYN(`\nApply import? [Y/n]: `);
  } catch {
    return;
  }
  if (!ok) {
    console.log("Import cancelled.");
    return;
  }

  const { merged } = mergeStores(store, imported);
  Object.assign(store, merged);
  // Remove keys that aren't in merged
  for (const k of Object.keys(store)) {
    if (!(k in merged)) delete store[k];
  }
  schedulePush(true);
  await flushSync();
  console.log(
    `\n✓ Import complete. ${newEntries.length + updatedEntries.length} entries applied.`,
  );
}

// ─── MAIN SESSION ─────────────────────────────────────────────────────────────

export async function runSession(MPV: string, args: string[]) {
  let target: PlayTarget | null;
  if (args[0]) {
    const rawUrl = args[0];
    args.length = 0;
    const existing = store[seriesKeyFromUrl(rawUrl)] ?? null;
    if (isDirectVideoUrl(rawUrl)) {
      const k = decodeURIComponent(
        rawUrl
          .split("/")
          .pop()!
          .split("?")[0]
          .replace(/\.[^.]+$/, ""),
      );
      const p: SeriesProgress = {
        url: rawUrl,
        season: 1,
        episode: 0,
        timestamp: existing?.timestamp ?? 0,
        isMovie: true,
      };
      target = { key: k, p, season: 1, episode: 0, timestamp: p.timestamp };
    } else {
      const k = seriesKeyFromUrl(rawUrl);
      const s = existing;
      const season = s?.season ?? 1;
      const episode = s?.episode ?? 0;
      const timestamp =
        s && s.season === season && s.episode === episode && s.timestamp > 5
          ? s.timestamp
          : 0;
      const p: SeriesProgress = { url: rawUrl, season, episode, timestamp };
      target = { key: k, p, season, episode, timestamp };
    }
  } else {
    target = await interactiveMenu();
  }
  if (!target) {
    process.exit(0);
    return;
  }

  const { key, p: savedP } = target;
  const p = store[key] ?? savedP;

  // ── MOVIE ─────────────────────────────────────────────────────────────────
  if ((p.isMovie || isDirectVideoUrl(p.url)) && !p.manualUrls?.length) {
    console.log(
      `\n${p.isOnetime ? "One-time movie" : "Movie"}:   ${key}${p.timestamp > 0 ? `\nResuming from: ${formatTime(p.timestamp)}` : ""}`,
    );
    const result = await playWithMpv(
      MPV,
      p.url,
      p.timestamp,
      (time) => {
        const cur = store[key] ?? p;
        saveProgress(key, {
          ...cur,
          timestamp: time,
          cacheOffset: cur.cacheOffset ?? p.cacheOffset,
        });
      },
      key,
      cliPrompts,
      { cacheOffsetHint: p.cacheOffset ?? 0 },
    );
    await offerHardsub(result.localPath);
    const del = await promptYNSoft("Delete local cache file? [Y/n]: ");
    if (del) deleteVideoCache(p.url, key);
    if (result.endReason === "near_end") {
      console.log(`\n✓  ${key} — finished!`);
      await promptAfterFinished(key, store[key] ?? p);
    } else if (result.finalPosition) {
      const cur = store[key] ?? p;
      saveProgress(key, {
        ...cur,
        timestamp: result.finalPosition.time,
        cacheOffset:
          result.cacheOffset > 0 ? result.cacheOffset : cur.cacheOffset,
      });
      console.log(
        `\nStopped at: ${formatTime(result.finalPosition.time)}${result.finalPosition.duration > 0 ? ` / ${formatTime(result.finalPosition.duration)}` : ""}`,
      );
    }
    await flushSync();
    return;
  }

  // ── SERIES ────────────────────────────────────────────────────────────────
  console.log(
    `\n${p.isOnetime ? "One-time series" : "Series"}:  ${key}\nStarting: S${target.season}E${target.episode + 1}${target.timestamp > 0 ? ` @ ${formatTime(target.timestamp)}` : ""}`,
  );

  let cs = target.season,
    ce = target.episode,
    rt = target.timestamp;

  let fetchAbort = new AbortController();
  const sigintHandler = () => {
    fetchAbort.abort();
  };
  process.on("SIGINT", sigintHandler);

  const dirUrl = p.url;
  const canIterateSeasons =
    !isDirectVideoUrl(dirUrl) &&
    getSeasonUrl(dirUrl, 1) !== getSeasonUrl(dirUrl, 2);

  try {
    outer: while (true) {
      const storedEntry = store[key];
      const manualUrls = storedEntry?.manualUrls ?? [];

      const seasonManualUrls = manualUrls.filter((u) => {
        const m = (u.split("/").pop() ?? "").match(/[Ss](\d+)[Ee]\d+/);
        return m ? parseInt(m[1]!, 10) === cs : cs === 1;
      });

      let eps: string[];

      if (seasonManualUrls.length > 0) {
        console.log(
          `\n${"=".repeat(50)}\nSeason ${cs} — ${seasonManualUrls.length} episode URLs loaded\n${"=".repeat(50)}`,
        );
        eps = seasonManualUrls;
      } else {
        if (!canIterateSeasons && cs > target.season) {
          console.log("\nNo more seasons available — series complete.");
          break outer;
        }
        const su = getSeasonUrl(dirUrl, cs);
        console.log(
          `\n${"=".repeat(50)}\nLoading Season ${cs}… (q to go back)\n${"=".repeat(50)}`,
        );
        fetchAbort = new AbortController();
        try {
          eps = await resolveEpisodes(su, undefined, fetchAbort.signal);
        } catch (e: any) {
          if (e instanceof QuitToMenu) throw e;
          if (e.message?.includes("HTTP 404")) {
            console.log(`\nSeason ${cs} not found — series complete.`);
            break outer;
          }
          console.error(`Error: ${e.message}`);
          break outer;
        }
        // If resolveEpisodes returns [] (no episodes found via directory), ask user for manual URLs
        if (eps.length === 0) {
          const manual = await promptManualUrls(su);
          if (manual.length > 0) {
            eps = manual;
          } else {
            if (!canIterateSeasons || cs > target.season) {
              console.log("\nNo episodes found — series complete.");
              break outer;
            }
            console.log("No episodes found. Trying next season...");
            cs++;
            ce = 0;
            continue;
          }
        }
      }

      console.log(`Found ${eps.length} episodes`);
      if (ce >= eps.length) {
        console.log("All watched. Moving to next season...");
        cs++;
        ce = 0;
        continue;
      }

      while (ce < eps.length) {
        const eu = eps[ce]!;
        console.log(`\n--- Season ${cs}, Episode ${ce + 1} ---`);
        const st = rt;
        rt = 0;
        let ls = Date.now();
        const cur = store[key] ?? p;
        const cacheOffsetHint =
          cur.season === cs && cur.episode === ce ? cur.cacheOffset ?? 0 : 0;
        const result = await playWithMpv(
          MPV,
          eu,
          st,
          (time) => {
            if (Date.now() - ls > 5000) {
              ls = Date.now();
              saveProgress(key, {
                ...store[key]!,
                season: cs,
                episode: ce,
                timestamp: time,
                cacheOffset:
                  cur.season === cs && cur.episode === ce
                    ? cur.cacheOffset
                    : 0,
              });
            }
          },
          key,
          cliPrompts,
          {
            nextEpisodeUrl: ce + 1 < eps.length ? eps[ce + 1]! : undefined,
            cacheOffsetHint,
          },
        );

        const { finalPosition, endReason, localPath } = result;
        if (finalPosition) {
          const sp = store[key]!;
          saveProgress(key, {
            ...sp,
            season: cs,
            episode: ce,
            timestamp: finalPosition.time,
            cacheOffset:
              result.cacheOffset > 0 ? result.cacheOffset : sp.cacheOffset,
          });
        }

        await offerHardsub(localPath);
        const del = await promptYNSoft("Delete local cache file? [Y/n]: ");
        if (del) deleteVideoCache(eu, key);

        if (endReason === "near_end") {
          ce++;
          if (ce >= eps.length) {
            if (!canIterateSeasons && seasonManualUrls.length > 0) {
              console.log(`\n✓ All episodes complete!`);
              saveProgress(key, {
                ...store[key]!,
                season: cs,
                episode: ce - 1,
                timestamp: 0,
                cacheOffset: 0,
              });
              break outer;
            }
            console.log(`\n✓ Season ${cs} complete!`);
            cs++;
            ce = 0;
            saveProgress(key, {
              ...store[key]!,
              season: cs,
              episode: 0,
              timestamp: 0,
              cacheOffset: 0,
            });
            if (!(await promptYNSoft(`Continue to Season ${cs}? [Y/n]: `))) {
              await flushSync();
              return;
            }
            break;
          }
          saveProgress(key, {
            ...store[key]!,
            season: cs,
            episode: ce,
            timestamp: 0,
            cacheOffset: 0,
          });
          console.log("\n✓ Episode done.");
          if (!(await promptYNSoft(`Play S${cs}E${ce + 1} next? [Y/n]: `))) {
            await flushSync();
            return;
          }
        } else {
          if (finalPosition)
            console.log(
              `\nStopped at: ${formatTime(finalPosition.time)}${finalPosition.duration > 0 ? ` / ${formatTime(finalPosition.duration)}` : ""}`,
            );
          await flushSync();
          return;
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
  }

  console.log(`\n🎉  ${key} — all done!`);
  await promptAfterFinished(key, store[key] ?? p);
  await flushSync();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  await maybeRunStorageSetup();
  if (args[0] === "list") {
    await initStore();
    listAllProgress();
    process.exit(0);
  }
  if (args[0] === "export") {
    await initStore();
    await exportProgress();
    process.exit(0);
  }
  if (args[0] === "import") {
    await initStore();
    await importProgress(args[1]);
    process.exit(0);
  }
  const MPV = findMpv();
  await initStore();
  const firstArgs = [...args];
  while (true) {
    try {
      await runSession(MPV, firstArgs);
    } catch (e) {
      if (e instanceof QuitToMenu) continue;
      throw e;
    }
  }
}

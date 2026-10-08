// playback.ts — server-side playback session controller for the GUI.
// Owns the episode loop (resume, auto-advance, prefetch, season-end cache
// cleanup) and emits state updates the HTTP/SSE layer forwards to the UI.

import { EventEmitter } from "events";
import {
  store,
  saveProgress,
  playWithMpv,
  findMpv,
  resolveEpisodes,
  getSeasonUrl,
  getEpisodeTimestamp,
  setEpisodePosition,
  deleteSeasonCache,
  sendMpvCommand,
  episodeKeyFromUrl,
  extractEpisodeNumber,
  isDirectVideoUrl,
  type SeriesProgress,
  type CacheStatus,
} from "../player-core.js";

export type PlaybackStatus =
  | "idle"
  | "buffering"
  | "playing"
  | "ended"
  | "stopped"
  | "error";

export interface SeasonEnded {
  season: number;
  count: number;
}

export interface PlaybackState {
  active: boolean;
  status: PlaybackStatus;
  key: string | null;
  label: string | null;
  season: number;
  episode: number; // 0-based index inside the season
  totalInSeason: number;
  url: string | null;
  time: number;
  duration: number;
  cache: CacheStatus | null;
  message: string | null;
  error: string | null;
  seasonEnded: SeasonEnded | null;
}

function sortEpisodes(urls: string[]): string[] {
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

export class PlaybackController extends EventEmitter {
  private mpv: string;
  private stopFlag = false;
  private nextFlag = false;
  private running = false;
  private seasonUrls: string[] = [];

  state: PlaybackState = {
    active: false,
    status: "idle",
    key: null,
    label: null,
    season: 1,
    episode: 0,
    totalInSeason: 0,
    url: null,
    time: 0,
    duration: 0,
    cache: null,
    message: null,
    error: null,
    seasonEnded: null,
  };

  constructor() {
    super();
    try {
      this.mpv = findMpv();
    } catch {
      this.mpv = "mpv";
    }
  }

  private set(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  private episodesForSeason(p: SeriesProgress, season: number): string[] {
    const manual = p.manualUrls ?? [];
    if (manual.length === 0) return [];
    const tagged = manual.filter((u) => /[Ss]\d+[Ee]\d+/.test(u));
    if (tagged.length === 0) {
      return season === 1 ? sortEpisodes(manual) : [];
    }
    return sortEpisodes(
      manual.filter((u) => {
        const k = episodeKeyFromUrl(u);
        return k ? Number(k.split(":")[0]) === season : false;
      }),
    );
  }

  async play(key: string, season?: number, episode?: number): Promise<void> {
    if (this.running) {
      this.set({ message: "Already playing — stop first." });
      return;
    }
    const p = store[key];
    if (!p) {
      this.set({ error: `Unknown entry: ${key}` });
      return;
    }

    const playSeason = season ?? p.season ?? 1;

    // Make sure we have an episode list; fall back to the directory listing.
    if (!p.manualUrls?.length && !p.isMovie) {
      try {
        const list = await resolveEpisodes(getSeasonUrl(p.url, playSeason), undefined);
        if (list.length > 0) p.manualUrls = list;
      } catch {}
    }

    let episodes = this.episodesForSeason(p, playSeason);
    // Movies / one-time direct-video entries have a single "episode".
    if (episodes.length === 0 && p.url && (p.isMovie || isDirectVideoUrl(p.url)))
      episodes = [p.url];
    if (episodes.length === 0) {
      this.set({
        active: false,
        status: "error",
        error: "No episodes found for this season.",
      });
      return;
    }

    // Resume the saved episode unless the caller asked for another season.
    let startEpisode = season === undefined || season === p.season ? p.episode : 0;
    if (episode !== undefined) startEpisode = episode;
    if (startEpisode < 0 || startEpisode >= episodes.length) startEpisode = 0;

    this.seasonUrls = episodes;
    this.running = true;
    this.stopFlag = false;
    this.nextFlag = false;
    this.set({
      active: true,
      status: "buffering",
      key,
      label: key,
      season: playSeason,
      episode: startEpisode,
      totalInSeason: episodes.length,
      url: episodes[startEpisode] ?? null,
      time: 0,
      duration: 0,
      cache: null,
      message: null,
      error: null,
      seasonEnded: null,
    });

    void this.runLoop(key, playSeason, episodes, startEpisode).finally(() => {
      this.running = false;
    });
  }

  private async runLoop(
    key: string,
    season: number,
    episodes: string[],
    start: number,
  ): Promise<void> {
    let idx = start;
    let stoppedByUser = false;

    while (idx < episodes.length) {
      const url = episodes[idx]!;
      this.set({
        active: true,
        status: "buffering",
        key,
        label: key,
        season,
        episode: idx,
        totalInSeason: episodes.length,
        url,
        time: 0,
        duration: 0,
        cache: null,
        message: null,
        error: null,
      });

      const cur = store[key] ?? ({ url, season, episode: idx, timestamp: 0 } as SeriesProgress);
      saveProgress(key, { ...cur, season, episode: idx, url, timestamp: 0 });
      const startTime = getEpisodeTimestamp(cur, url, season, idx);
      const nextUrl = idx + 1 < episodes.length ? episodes[idx + 1] : undefined;
      const cacheOffsetHint =
        cur.season === season && cur.episode === idx ? cur.cacheOffset ?? 0 : 0;

      this.nextFlag = false;
      this.stopFlag = false;

      let result;
      try {
        result = await playWithMpv(
          this.mpv,
          url,
          startTime,
          (time, duration) => {
            const now = store[key];
            if (now)
              saveProgress(key, setEpisodePosition(now, url, season, idx, time));
            this.set({
              time,
              duration,
              status: this.state.status === "buffering" ? "playing" : this.state.status,
            });
          },
          key,
          undefined,
          {
            nextEpisodeUrl: nextUrl,
            cacheOffsetHint,
            onCache: (info: CacheStatus) =>
              this.set({
                cache: info,
                status: info.state === "complete" ? "playing" : "buffering",
              }),
          },
        );
      } catch (e: any) {
        this.set({ active: false, status: "error", error: e?.message ?? "playback failed" });
        return;
      }

      if (result.finalPosition) {
        const now = store[key];
        if (now)
          saveProgress(
            key,
            setEpisodePosition(now, url, season, idx, result.finalPosition.time),
          );
      }

      const wantStop = this.stopFlag;
      const wantNext = this.nextFlag;

      if (wantStop) {
        stoppedByUser = true;
        break;
      }
      if (wantNext) {
        idx++;
        continue;
      }
      if (result.endReason === "near_end") {
        idx++;
        continue;
      }
      // mpv closed by the user → pause the session for now.
      stoppedByUser = true;
      break;
    }

    if (stoppedByUser) {
      this.set({ active: false, status: "stopped", message: null });
      return;
    }

    if (idx >= episodes.length && episodes.length > 0) {
      this.set({
        active: false,
        status: "ended",
        seasonEnded: { season, count: episodes.length },
      });
      return;
    }

    this.set({ active: false, status: "stopped" });
  }

  stop(): void {
    this.stopFlag = true;
    sendMpvCommand({ command: ["quit"] });
    if (!this.running) this.set({ active: false, status: "stopped" });
  }

  next(): void {
    // On the last episode there is nothing to advance to — let it finish and
    // stop rather than cutting it short.
    if (
      this.state.totalInSeason > 0 &&
      this.state.episode + 1 >= this.state.totalInSeason
    ) {
      return;
    }
    this.nextFlag = true;
    this.stopFlag = false;
    sendMpvCommand({ command: ["quit"] });
  }

  pause(): void {
    sendMpvCommand({ command: ["cycle", "pause"] });
  }

  /** Answer the season-end delete prompt. */
  finishSeason(deleteCache: boolean): { deleted: number } {
    const ended = this.state.seasonEnded;
    let deleted = 0;
    if (ended && deleteCache && this.state.label) {
      deleted = deleteSeasonCache(this.seasonUrls, this.state.label);
    }
    this.set({ seasonEnded: null, status: "idle", active: false });
    return { deleted };
  }
}

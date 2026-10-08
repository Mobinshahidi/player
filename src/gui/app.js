/* GUI front-end — talks to the local Node server. No frameworks. */
"use strict";

// ── i18n ─────────────────────────────────────────────────────────────────────

const I18N = {
  en: {
    dir: "ltr",
    search: "Search…",
    total: "total",
    localOnly: "local only",
    addSeries: "＋ Add series",
    emptyList: "No series yet — add one to get started.",
    selectHint: "Select a series, or add one with the button on the left.",
    footer: "[↑↓] Navigate   [Enter] Play   [n] Add   [/] Search",
    type: "Type",
    status: "Status",
    progress: "Progress",
    episode: "Episode",
    thisSeason: "This season",
    totalEpisodes: "Total",
    version: "Version",
    quality: "Quality",
    movie: "Movie",
    series: "Series",
    finished: "Finished",
    watching: "Watching",
    episodes: "episodes",
    startFromSeason: "Start from season",
    play: "▶  Play",
    refresh: "↻  Refresh",
    remove: "🗑  Remove",
    pause: "⏸ Pause",
    next: "⏭ Next",
    stop: "⏹ Stop",
    dubbed: "Dubbed",
    hardsub: "Hard sub",
    addTitle: "Add series",
    addLabel: "Paste the series link",
    fetch: "Fetch",
    cancel: "Cancel",
    nameLabel: "Name",
    alreadyExists: "Already in your list — playing will update it.",
    totalLine: (n) => `Total: ${n} episodes`,
    seasonLine: (s, n) => `Season ${s}: ${n} episodes`,
    removeTitle: "Remove series?",
    removeBody: "This only removes it from the list. Cached videos are not touched.",
    seasonEndTitle: (s) => `Season ${s} finished`,
    seasonEndBody: (n) =>
      `${n} episodes played. Delete the cached video files for this season?`,
    keep: "Keep",
    delete: "Delete",
    fetching: "Fetching series info…",
    refreshing: "Refreshing…",
    preparing: "Preparing playback…",
    cannotRead: "Cannot read that page",
    updated: (n) => `Updated · ${n} episodes`,
    refreshFailed: "Refresh failed",
    couldNotCreate: "Could not create",
    deleted: (n) => `Deleted ${n} file(s)`,
    nothingToDelete: "Nothing to delete",
    partial: (n) => `+${n} new`,
  },
  fa: {
    dir: "rtl",
    search: "جستجو…",
    total: "کل",
    localOnly: "فقط محلی",
    addSeries: "＋ افزودن سریال",
    emptyList: "هنوز سریالی اضافه نشده — یکی اضافه کنید.",
    selectHint: "یک سریال را انتخاب کنید یا با دکمهٔ سمت چپ یکی اضافه کنید.",
    footer: "[↑↓] حرکت   [Enter] پخش   [n] افزودن   [/] جستجو",
    type: "نوع",
    status: "وضعیت",
    progress: "پیشرفت",
    episode: "قسمت",
    thisSeason: "این فصل",
    totalEpisodes: "کل",
    version: "نسخه",
    quality: "کیفیت",
    movie: "فیلم",
    series: "سریال",
    finished: "تمام‌شده",
    watching: "در حال تماشا",
    episodes: "قسمت",
    startFromSeason: "شروع از فصل",
    play: "▶  پخش",
    refresh: "↻  بروزرسانی",
    remove: "🗑  حذف",
    pause: "⏸ توقف",
    next: "⏭ بعدی",
    stop: "⏹ قطع",
    dubbed: "دوبله",
    hardsub: "زیرنویس چسبیده",
    addTitle: "افزودن سریال",
    addLabel: "لینک سریال را وارد کنید",
    fetch: "دریافت",
    cancel: "انصراف",
    nameLabel: "نام",
    alreadyExists: "از قبل در فهرست شماست — پخش آن را بروزرسانی می‌کند.",
    totalLine: (n) => `کل: ${n} قسمت`,
    seasonLine: (s, n) => `فصل ${s}: ${n} قسمت`,
    removeTitle: "سریال حذف شود؟",
    removeBody: "فقط از فهرست حذف می‌شود؛ فایل‌های کش دست‌نخورده می‌مانند.",
    seasonEndTitle: (s) => `فصل ${s} تمام شد`,
    seasonEndBody: (n) =>
      `${n} قسمت پخش شد. فایل‌های کش این فصل حذف شوند؟`,
    keep: "نگه‌دار",
    delete: "حذف",
    fetching: "در حال دریافت اطلاعات سریال…",
    refreshing: "در حال بروزرسانی…",
    preparing: "در حال آماده‌سازی پخش…",
    cannotRead: "صفحه خوانده نشد",
    updated: (n) => `بروزرسانی شد · ${n} قسمت`,
    refreshFailed: "بروزرسانی ناموفق بود",
    couldNotCreate: "ساخت ناموفق بود",
    deleted: (n) => `${n} فایل حذف شد`,
    nothingToDelete: "چیزی برای حذف نیست",
    partial: (n) => `${n}+ جدید`,
  },
};

let lang = (() => {
  try {
    const saved = localStorage.getItem("player-gui-lang");
    if (saved === "en" || saved === "fa") return saved;
  } catch {}
  return (navigator.language || "").toLowerCase().startsWith("fa") ? "fa" : "en";
})();

function t(key, ...args) {
  const v = I18N[lang][key];
  return typeof v === "function" ? v(...args) : v;
}

function variantLabel(v) {
  return v === "dubbled" || v === "dubbed" ? t("dubbed") : t("hardsub");
}

// ── state ────────────────────────────────────────────────────────────────────

let state = { series: [], total: 0, playback: null };
let selectedKey = null;
let filter = "";
const selectedSeason = {}; // key -> season to start from
let activeModal = null; // { close, onClose }
let seasonPromptToken = null;

const $ = (id) => document.getElementById(id);
const listEl = $("list");
const detailEl = $("detail");
const detailEmpty = $("detail-empty");
const emptyList = $("empty-list");
const totalEl = $("total");
const searchEl = $("search");
const footerHint = $("footer-hint");
const np = $("nowplaying");

// ── helpers ──────────────────────────────────────────────────────────────────

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

async function api(path, body) {
  const opts = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(path, opts);
  return res.json();
}

function toast(msg, kind = "") {
  const elToast = $("toast");
  elToast.textContent = msg;
  elToast.className = kind;
  clearTimeout(elToast._timer);
  elToast._timer = setTimeout(() => (elToast.className = "hidden"), 4000);
}

function showLoading(text) {
  $("loading-text").textContent = text || "";
  $("loading").classList.remove("hidden");
}
function hideLoading() {
  $("loading").classList.add("hidden");
}

// ── language ─────────────────────────────────────────────────────────────────

function setLang(next) {
  if (next !== "en" && next !== "fa") return;
  lang = next;
  try {
    localStorage.setItem("player-gui-lang", next);
  } catch {}
  if (activeModal) closeModal();
  applyLang();
}

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = I18N[lang].dir;

  totalEl.textContent = `[${t("total")}: ${state.total ?? state.series.length}]`;
  searchEl.placeholder = t("search");
  $("badge-local").textContent = t("localOnly");
  footerHint.textContent = t("footer");
  $("add-btn").textContent = t("addSeries");
  emptyList.textContent = t("emptyList");
  detailEmpty.textContent = t("selectHint");
  $("np-pause").textContent = t("pause");
  $("np-next").textContent = t("next");
  $("np-stop").textContent = t("stop");
  $("lang-en").classList.toggle("active", lang === "en");
  $("lang-fa").classList.toggle("active", lang === "fa");

  render();
}

// ── render ──────────────────────────────────────────────────────────────────

function filteredSeries() {
  const q = filter.trim().toLowerCase();
  if (!q) return state.series;
  return state.series.filter(
    (s) => s.name.toLowerCase().includes(q) || s.key.toLowerCase().includes(q),
  );
}

function render() {
  totalEl.textContent = `[${t("total")}: ${state.total ?? state.series.length}]`;

  const items = filteredSeries();
  if (!selectedKey || !items.some((s) => s.key === selectedKey)) {
    selectedKey = items.length ? items[0].key : null;
  }

  listEl.replaceChildren();
  for (const s of items) {
    const li = el(
      "li",
      {
        class:
          (s.key === selectedKey ? "selected " : "") +
          (s.finished ? "finished " : s.watched ? "watching " : ""),
        onclick: () => selectSeries(s.key),
      },
      [
        el("div", { class: "row" }, [
          el("span", { class: "name", text: s.name }),
          el("span", { class: "prog", text: s.progress }),
          s.newEpisodeCount > 0
            ? el("span", { class: "badge", text: t("partial", s.newEpisodeCount) })
            : null,
        ]),
      ],
    );
    listEl.appendChild(li);
  }

  emptyList.classList.toggle("hidden", items.length > 0);
  renderDetail();
  renderNowPlaying();
  maybeSeasonPrompt();
}

function scrollSelectedIntoView() {
  const li = listEl.querySelector("li.selected");
  if (li) li.scrollIntoView({ block: "nearest" });
}

function selectSeries(key, scroll = true) {
  selectedKey = key;
  render();
  if (scroll) scrollSelectedIntoView();
}

function renderDetail() {
  const s = state.series.find((x) => x.key === selectedKey);
  if (!s) {
    detailEl.classList.add("hidden");
    detailEmpty.classList.remove("hidden");
    return;
  }
  detailEmpty.classList.add("hidden");
  detailEl.classList.remove("hidden");
  detailEl.replaceChildren();

  if (s.poster) {
    detailEl.appendChild(
      el("img", {
        class: "poster",
        src: s.poster,
        alt: "",
        onerror: function () {
          this.remove();
        },
      }),
    );
  }

  detailEl.appendChild(el("h1", { dir: "auto", text: s.name }));

  const seasonEpisodes =
    s.seasons && s.seasons.length
      ? ((s.seasons.find((x) => x.season === s.season) || {}).episodeCount ?? "?")
      : "?";

  const meta = el("dl", { class: "meta" }, [
    el("dt", { text: t("type") }),
    el("dd", { text: s.isMovie ? t("movie") : t("series") }),
    el("dt", { text: t("status") }),
    el("dd", { text: s.finished ? t("finished") : t("watching") }),
    el("dt", { text: t("progress") }),
    el("dd", {
      text: s.progress + (s.timestamp ? `  @ ${fmtTime(s.timestamp)}` : ""),
    }),
    el("dt", { text: t("episode") }),
    el("dd", { text: `S${s.season}E${String(s.episode + 1).padStart(2, "0")}` }),
    el("dt", { text: t("thisSeason") }),
    el("dd", { text: `${seasonEpisodes} ${t("episodes")}` }),
    el("dt", { text: t("totalEpisodes") }),
    el("dd", { text: `${s.totalEpisodes} ${t("episodes")}` }),
    el("dt", { text: t("version") }),
    el("dd", { text: s.variant ? variantLabel(s.variant) : "—" }),
    el("dt", { text: t("quality") }),
    el("dd", { text: s.quality || "—" }),
  ]);
  detailEl.appendChild(meta);

  if (s.seasons && s.seasons.length > 1) {
    detailEl.appendChild(el("div", { class: "hint", text: t("startFromSeason") }));
    const chips = el("div", { class: "seasons" });
    for (const x of s.seasons) {
      const active = (selectedSeason[s.key] ?? s.season) === x.season;
      chips.appendChild(
        el("button", {
          class: "chip" + (active ? " active" : ""),
          text: `S${x.season} (${x.episodeCount})`,
          onclick: () => {
            selectedSeason[s.key] = x.season;
            renderDetail();
          },
        }),
      );
    }
    detailEl.appendChild(chips);
  }

  const startSeason = selectedSeason[s.key] ?? s.season;
  detailEl.appendChild(
    el("div", { class: "actions" }, [
      el("button", {
        class: "primary",
        style: "width:auto;padding:8px 18px",
        text: t("play"),
        onclick: () =>
          play(
            s.key,
            startSeason,
            selectedSeason[s.key] !== undefined ? 0 : undefined,
          ),
      }),
      el("button", {
        class: "ghost",
        text: t("refresh"),
        disabled: !s.sourceUrl,
        onclick: () => refreshSeries(s),
      }),
      el("button", {
        class: "danger",
        text: t("remove"),
        onclick: () => removeSeries(s),
      }),
    ]),
  );

  if (s.overview) {
    detailEl.appendChild(
      el("div", { class: "desc" }, [el("div", { dir: "auto", text: s.overview })]),
    );
  }
  if (s.sourceUrl) {
    detailEl.appendChild(
      el("div", { class: "hint", style: "margin-top:10px", text: s.sourceUrl }),
    );
  }
}

function renderNowPlaying() {
  const pb = state.playback;
  if (!pb || !pb.active) {
    np.classList.add("hidden");
    return;
  }
  np.classList.remove("hidden");
  const ep = `S${pb.season}E${String(pb.episode + 1).padStart(2, "0")}`;
  const time = pb.duration > 0 ? ` ${fmtTime(pb.time)}/${fmtTime(pb.duration)}` : "";
  $("np-title").textContent = `${pb.label} · ${ep}/${pb.totalInSeason}${time}`;
  const c = pb.cache;
  $("np-cache").textContent = c
    ? `cache ${(c.downloadedBytes / 1048576).toFixed(1)}MB${
        c.totalBytes
          ? ` ${((c.downloadedBytes / c.totalBytes) * 100).toFixed(0)}%`
          : ""
      } (${c.state})`
    : "";
  // No next episode → the Next button is disabled (playback stops on its own).
  $("np-next").disabled = pb.episode + 1 >= pb.totalInSeason;
}

// ── season-end prompt ───────────────────────────────────────────────────────

function maybeSeasonPrompt() {
  const pb = state.playback;
  const ended = pb && pb.seasonEnded;
  if (!ended) {
    seasonPromptToken = null;
    return;
  }
  const token = `${ended.season}:${ended.count}`;
  if (seasonPromptToken === token || activeModal) return;
  seasonPromptToken = token;
  openModal((close) => [
    el("h2", { text: t("seasonEndTitle", ended.season) }),
    el("div", { class: "big-desc", text: t("seasonEndBody", ended.count) }),
    el("div", { class: "modal-actions" }, [
      el("button", {
        class: "ghost",
        text: t("keep"),
        onclick: async () => {
          await api("/api/finish-season", { delete: false });
          close();
        },
      }),
      el("button", {
        class: "primary",
        style: "width:auto;padding:8px 18px",
        text: t("delete"),
        onclick: async () => {
          const r = await api("/api/finish-season", { delete: true });
          toast(r.deleted ? t("deleted", r.deleted) : t("nothingToDelete"), "ok");
          close();
        },
      }),
    ]),
  ]);
}

// ── actions ─────────────────────────────────────────────────────────────────

async function play(key, season, episode) {
  const body = { key };
  if (season !== undefined) body.season = season;
  if (episode !== undefined) body.episode = episode;
  await api("/api/play", body);
  selectedKey = key;
  render();
}

async function refreshSeries(s) {
  showLoading(t("refreshing"));
  const r = await api("/api/refresh", { url: s.sourceUrl });
  hideLoading();
  if (r.ok) toast(t("updated", r.summary.totalEpisodes), "ok");
  else toast(`❌ ${t("refreshFailed")}`, "err");
}

function removeSeries(s) {
  openModal((close) => [
    el("h2", { text: t("removeTitle") }),
    el("div", { class: "big-desc", text: `${s.name}\n${t("removeBody")}` }),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "ghost", text: t("cancel"), onclick: close }),
      el("button", {
        class: "danger",
        text: t("remove"),
        onclick: async () => {
          await api("/api/remove", { key: s.key });
          if (selectedKey === s.key) selectedKey = null;
          close();
        },
      }),
    ]),
  ]);
}

// ── add flow ────────────────────────────────────────────────────────────────

function promptText({ title, label, value = "", placeholder = "", okText = "OK" }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    openModal(
      (close) => {
        const input = el("input", { type: "text", value, placeholder, dir: "ltr" });
        const ok = el("button", {
          class: "primary",
          style: "width:auto;padding:8px 18px",
          text: okText,
          onclick: () => {
            finish(input.value.trim() || null);
            close();
          },
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") ok.click();
        });
        setTimeout(() => input.focus(), 30);
        return [
          el("h2", { text: title }),
          el("label", { text: label }),
          input,
          el("div", { class: "modal-actions" }, [
            el("button", {
              class: "ghost",
              text: t("cancel"),
              onclick: () => {
                finish(null);
                close();
              },
            }),
            ok,
          ]),
        ];
      },
      () => finish(null),
    );
  });
}

async function addSeries() {
  const url = await promptText({
    title: t("addTitle"),
    label: t("addLabel"),
    placeholder: "https://www.myf2m.org/series/...",
    okText: t("fetch"),
  });
  if (!url) return;
  showLoading(t("fetching"));
  let r;
  try {
    r = await api("/api/add", { url });
  } catch (e) {
    r = { ok: false, error: String(e) };
  }
  hideLoading();
  if (!r.ok) {
    toast(`❌ ${t("cannotRead")}: ${r.error || ""}`, "err");
    return;
  }
  chooseOptions(r);
}

function chooseOptions(info) {
  const variants = info.summary.variants.length
    ? info.summary.variants
    : ["hardsub"];
  const qualities = info.summary.qualities.length
    ? info.summary.qualities
    : ["720p"];
  let variant = variants.includes("hardsub") ? "hardsub" : variants[0];
  let quality = qualities.includes("720p") ? "720p" : qualities[0];
  const fallbackName = info.defaultName || info.title || "series";

  openModal((close) => {
    const nameInput = el("input", {
      type: "text",
      value: fallbackName,
      dir: "auto",
    });

    const variantChips = el("div", { class: "choices" });
    const renderVariants = () => {
      variantChips.replaceChildren();
      for (const v of variants) {
        variantChips.appendChild(
          el("button", {
            class: "chip" + (v === variant ? " active" : ""),
            text: variantLabel(v),
            onclick: () => {
              variant = v;
              renderVariants();
            },
          }),
        );
      }
    };
    renderVariants();

    const qualityChips = el("div", { class: "choices" });
    const renderQualities = () => {
      qualityChips.replaceChildren();
      for (const q of qualities) {
        qualityChips.appendChild(
          el("button", {
            class: "chip" + (q === quality ? " active" : ""),
            text: q + (q === "720p" ? " ✓" : ""),
            onclick: () => {
              quality = q;
              renderQualities();
            },
          }),
        );
      }
    };
    renderQualities();

    return [
      el("h2", { dir: "auto", text: info.title || fallbackName }),
      el("div", { class: "poster-row" }, [
        info.poster ? el("img", { src: info.poster, alt: "" }) : null,
        el("div", { class: "big-desc", dir: "auto", text: info.description || "" }),
      ]),
      el("label", { text: t("version") }),
      variantChips,
      el("label", { text: t("quality") }),
      qualityChips,
      el("label", { text: t("nameLabel") }),
      nameInput,
      el("div", { class: "counts" }, [
        el("div", { text: t("totalLine", info.summary.totalEpisodes) }),
        ...info.summary.seasons.map((s) =>
          el("div", { text: t("seasonLine", s.season, s.episodeCount) }),
        ),
        info.existingKey ? el("div", { class: "hint", text: t("alreadyExists") }) : null,
      ]),
      el("div", { class: "modal-actions" }, [
        el("button", { class: "ghost", text: t("cancel"), onclick: close }),
        el("button", {
          class: "primary",
          style: "width:auto;padding:8px 18px",
          text: t("play"),
          onclick: async () => {
            const chosenName = nameInput.value.trim() || fallbackName;
            close();
            showLoading(t("preparing"));
            const r = await api("/api/create", {
              url: info.url,
              name: chosenName,
              variant,
              quality,
            });
            hideLoading();
            if (!r.ok) {
              toast(`❌ ${t("couldNotCreate")}`, "err");
              return;
            }
            selectedKey = r.key;
            await play(r.key, info.summary.seasons[0]?.season ?? 1, 0);
          },
        }),
      ]),
    ];
  });
}

// ── modal plumbing ──────────────────────────────────────────────────────────

function teardownModal() {
  const root = $("modal-root");
  root.replaceChildren();
  root.classList.add("hidden");
  root.onmousedown = null;
}

function openModal(render, onClose) {
  teardownModal();
  const root = $("modal-root");
  const box = el("div", { class: "modal" });
  const close = () => closeModal();
  const content = render(close);
  for (const c of [].concat(content)) if (c) box.appendChild(c);
  box.addEventListener("mousedown", (e) => e.stopPropagation());
  root.replaceChildren(box);
  root.classList.remove("hidden");
  root.onmousedown = () => closeModal();
  activeModal = { close, onClose };
}

function closeModal() {
  const m = activeModal;
  activeModal = null;
  teardownModal();
  if (m && m.onClose) m.onClose();
}

// ── playback controls ───────────────────────────────────────────────────────

$("np-stop").onclick = () => api("/api/control", { action: "stop" });
$("np-next").onclick = () => api("/api/control", { action: "next" });
$("np-pause").onclick = () => api("/api/control", { action: "pause" });
$("add-btn").onclick = addSeries;
$("lang-en").onclick = () => setLang("en");
$("lang-fa").onclick = () => setLang("fa");

// ── keyboard ────────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (activeModal) closeModal();
    return;
  }
  const typingField =
    document.activeElement &&
    (document.activeElement.tagName === "INPUT" ||
      document.activeElement.tagName === "TEXTAREA");
  if (typingField) return;
  if (activeModal) return;

  if (e.key === "/") {
    e.preventDefault();
    searchEl.focus();
    return;
  }
  if (e.key === "n") {
    e.preventDefault();
    addSeries();
    return;
  }
  const items = filteredSeries();
  const idx = items.findIndex((s) => s.key === selectedKey);
  if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    if (idx < items.length - 1) selectSeries(items[idx + 1].key);
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    if (idx > 0) selectSeries(items[idx - 1].key);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selectedKey) {
      const s = state.series.find((x) => x.key === selectedKey);
      if (s)
        play(
          s.key,
          selectedSeason[s.key] ?? s.season,
          selectedSeason[s.key] !== undefined ? 0 : undefined,
        );
    }
  }
});

searchEl.addEventListener("input", () => {
  filter = searchEl.value;
  render();
});

// ── live data ───────────────────────────────────────────────────────────────

function applyState(next) {
  if (!next) return;
  state = next;
  render();
}

async function init() {
  applyLang();
  try {
    applyState(await api("/api/state"));
  } catch {}

  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    try {
      applyState(JSON.parse(ev.data));
    } catch {}
  };
}

init();

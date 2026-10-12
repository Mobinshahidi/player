#include "scrape.h"
#include <curl/curl.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>


static const char *UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

static ScrapeInfo *si_new(const char *url);
static char *html_decode(const char *s);
static char *slice(const char *h, long a, long b);
static long find_div_class(const char *h, const char *cls, long from);
static long last_index_before(const char *h, const char *sub, long at);
static const char *nearest_variant(const char *h, long at);
static void ep_add(ScrapeInfo *si, const char *url, int season, int episode,
                   const char *variant, const char *quality);
static void finalize_summary(ScrapeInfo *si);

static ScrapeInfo *si_new(const char *url) {
  ScrapeInfo *si = calloc(1, sizeof(ScrapeInfo));
  si->url = g_strdup(url ? url : "");
  si->ok = FALSE;
  return si;
}

void scrape_free(ScrapeInfo *si) {
  if (!si) return;
  g_free(si->url);
  g_free(si->title);
  g_free(si->description);
  g_free(si->poster);
  g_free(si->error);
  for (int i = 0; i < si->eps_len; i++) {
    g_free(si->eps[i].url);
    g_free(si->eps[i].variant);
    g_free(si->eps[i].quality);
  }
  g_free(si->eps);
  for (int i = 0; i < si->variants_len; i++) g_free(si->variants[i]);
  g_free(si->variants);
  for (int i = 0; i < si->qualities_len; i++) g_free(si->qualities[i]);
  g_free(si->qualities);
  g_free(si->seasons);
  g_free(si->season_counts);
  free(si);
}

/* ─── low-level helpers ────────────────────────────────────────────────────── */

static char *slice(const char *h, long a, long b) {
  if (a < 0) a = 0;
  if (b < a) b = a;
  return g_strndup(h + a, (gsize)(b - a));
}

static char *html_decode(const char *s) {
  GString *o = g_string_new(NULL);
  for (const char *p = s; *p;) {
    if (*p == '&') {
      if (strncmp(p, "&amp;", 5) == 0) { g_string_append_c(o, '&'); p += 5; continue; }
      if (strncmp(p, "&lt;", 4) == 0) { g_string_append_c(o, '<'); p += 4; continue; }
      if (strncmp(p, "&gt;", 4) == 0) { g_string_append_c(o, '>'); p += 4; continue; }
      if (strncmp(p, "&quot;", 6) == 0) { g_string_append_c(o, '"'); p += 6; continue; }
      if (strncmp(p, "&#39;", 5) == 0) { g_string_append_c(o, '\''); p += 5; continue; }
      if (strncmp(p, "&#0;38;", 6) == 0 || strncmp(p, "&#038;", 6) == 0) {
        g_string_append_c(o, '&'); p += 6; continue;
      }
    }
    g_string_append_c(o, *p);
    p++;
  }
  g_string_append_c(o, 0);
  char *out = g_string_free(o, FALSE);
  return out;
}

static long find_div_class(const char *h, const char *cls, long from) {
  long i = from;
  if (i < 0) i = 0;
  size_t len = strlen(h);
  while (i < (long)len) {
    const char *p = strstr(h + i, "<div");
    if (!p) return -1;
    long start = (long)(p - h);
    const char *gt = strchr(p, '>');
    if (!gt || (size_t)(gt - p) > 700) { i = start + 1; continue; }
    size_t taglen = (size_t)(gt - p);
    char *tag = g_strndup(p, taglen);
    int found = strstr(tag, cls) != NULL && strstr(tag, "class") != NULL;
    g_free(tag);
    if (found) return start;
    i = start + 1;
  }
  return -1;
}

static long last_index_before(const char *h, const char *sub, long at) {
  long found = -1, from = 0;
  while (1) {
    const char *p = strstr(h + from, sub);
    if (!p) break;
    long pos = (long)(p - h);
    if (pos >= at) break;
    found = pos;
    from = pos + 1;
  }
  return found;
}

static const char *nearest_variant(const char *h, long at) {
  if (at < 0) at = 0;
  long dub = last_index_before(h, "دوبله", at);
  long dubd = last_index_before(h, "دوبلد", at);
  long sub = last_index_before(h, "زیرنویس چسبیده", at);
  long hard = last_index_before(h, "هاردساب", at);
  long sub2 = last_index_before(h, "زیرنویس", at);
  long nearest = MAX(MAX(dub, dubd), MAX(MAX(sub, hard), sub2));
  if (nearest < 0) return "hardsub";
  if (nearest == dub || nearest == dubd) return "dubbled";
  return "hardsub";
}

static char *percent_decode(const char *s) {
  GString *o = g_string_new(NULL);
  for (const char *p = s; *p; p++) {
    if (*p == '%' && isxdigit((unsigned char)p[1]) && isxdigit((unsigned char)p[2])) {
      char b[3] = { p[1], p[2], 0 };
      g_string_append_c(o, (char)strtol(b, NULL, 16));
      p += 2;
    } else g_string_append_c(o, *p);
  }
  g_string_append_c(o, 0);
  return g_string_free(o, FALSE);
}

/* parse SxxEyy (case-insensitive) from a filename */
static int parse_se(const char *fn, int *season, int *episode) {
  size_t n = strlen(fn);
  for (size_t i = 0; i + 2 < n; i++) {
    char c = fn[i];
    if (c == 's' || c == 'S') {
      size_t j = i + 1;
      int s = 0;
      while (j < n && isdigit((unsigned char)fn[j])) { s = s * 10 + (fn[j] - '0'); j++; }
      if (s == 0 || (fn[j] != 'e' && fn[j] != 'E')) continue;
      j++;
      int e = 0;
      while (j < n && isdigit((unsigned char)fn[j])) { e = e * 10 + (fn[j] - '0'); j++; }
      if (e > 0) { *season = s; *episode = e - 1; return 1; }
    }
  }
  return 0;
}

static const char *QUALITYS[] = { "480p", "720p", "1080p", "2160p", "4k" };

static void quality_of(const char *fn, char *out, size_t outsz) {
  char low[256];
  size_t fnlen = strlen(fn);
  size_t n = fnlen < sizeof(low) - 1 ? fnlen : sizeof(low) - 1;
  for (size_t i = 0; i < n; i++) low[i] = tolower((unsigned char)fn[i]);
  low[n] = 0;
  for (int i = 0; i < 5; i++) {
    if (strstr(low, QUALITYS[i])) { g_snprintf(out, outsz, "%s", QUALITYS[i]); return; }
  }
  g_snprintf(out, outsz, "unknown");
}

static int is_dubbed_name(const char *fn) {
  char low[512];
  size_t n = strlen(fn);
  size_t cap = n < sizeof(low) - 1 ? n : sizeof(low) - 1;
  for (size_t i = 0; i < cap; i++) low[i] = tolower((unsigned char)fn[i]);
  low[cap] = 0;
  return strstr(low, "dubbed") != NULL || strstr(low, "دوبله") != NULL ||
         strstr(low, "دوبلد") != NULL;
}

static const char *VIDEO_EXT[] = { ".mkv", ".mp4", ".avi", ".mov", ".webm" };
static int is_video_link(const char *url) {
  for (int i = 0; i < 5; i++)
    if (strstr(url, VIDEO_EXT[i])) return 1;
  return 0;
}

/* ─── episode collection ───────────────────────────────────────────────────── */

static GHashTable *seen_table = NULL;

static void ep_add(ScrapeInfo *si, const char *url, int season, int episode,
                   const char *variant, const char *quality) {
  char key[256];
  g_snprintf(key, sizeof key, "%d:%d:%s:%s", season, episode, variant, quality);
  if (g_hash_table_contains(seen_table, key)) return;
  g_hash_table_add(seen_table, g_strdup(key));
  si->eps = realloc(si->eps, (si->eps_len + 1) * sizeof(ScrapeEp));
  ScrapeEp *e = &si->eps[si->eps_len++];
  e->url = g_strdup(url);
  e->season = season;
  e->episode = episode;
  e->variant = g_strdup(variant);
  e->quality = g_strdup(quality);
}

static void parse_handleclicks(const char *sec, ScrapeInfo *si,
                               const char *box_variant, int season_from_label) {
  const char *p = sec;
  while ((p = strstr(p, "handleDownloadClick('"))) {
    const char *start = p + 21;
    const char *end = strchr(start, '\'');
    if (!end) break;
    char *url = g_strndup(start, (gsize)(end - start));
    char *fndec = percent_decode(url);
    const char *filename = strrchr(fndec, '/');
    filename = filename ? filename + 1 : fndec;

    int s = season_from_label > 0 ? season_from_label : 1, e = 0;
    parse_se(filename, &s, &e);
    char q[32];
    quality_of(filename, q, sizeof q);
    int section_dubbed = strstr(sec, "دوبله") != NULL || strstr(sec, "دوبلد") != NULL;
    const char *variant = is_dubbed_name(filename)
      ? "dubbled"
      : (section_dubbed ? "dubbled" : box_variant);
    ep_add(si, url, s, e, variant, q);

    g_free(fndec);
    g_free(url);
    p = end + 1;
  }
}

static void parse_hrefs(const char *h, ScrapeInfo *si) {
  const char *p = h;
  while ((p = strstr(p, "href=\""))) {
    const char *start = p + 6;
    const char *end = strchr(start, '"');
    if (!end) break;
    char *url = g_strndup(start, (gsize)(end - start));
    if (is_video_link(url)) {
      char *fndec = percent_decode(url);
      const char *filename = strrchr(fndec, '/');
      filename = filename ? filename + 1 : fndec;
      int s = 1, e = 0;
      parse_se(filename, &s, &e);
      char q[32];
      quality_of(filename, q, sizeof q);
      const char *variant = is_dubbed_name(filename) ? "dubbled" : "hardsub";
      ep_add(si, url, s, e, variant, q);
      g_free(fndec);
    }
    g_free(url);
    p = end + 1;
  }
}

static void parse_all_handleclicks(const char *h, ScrapeInfo *si) {
  const char *p = h;
  while ((p = strstr(p, "handleDownloadClick('"))) {
    long at = (long)(p - h);
    const char *start = p + 21;
    const char *end = strchr(start, '\'');
    if (!end) break;
    char *url = g_strndup(start, (gsize)(end - start));
    char *fndec = percent_decode(url);
    const char *filename = strrchr(fndec, '/');
    filename = filename ? filename + 1 : fndec;
    int s = 1, e = 0;
    parse_se(filename, &s, &e);
    char q[32];
    quality_of(filename, q, sizeof q);
    const char *variant = is_dubbed_name(filename) ? "dubbled" : nearest_variant(h, at);
    ep_add(si, url, s, e, variant, q);
    g_free(fndec);
    g_free(url);
    p = end + 1;
  }
}

static char *strip_tags(const char *txt, size_t len) {
  GString *o = g_string_new(NULL);
  int in_tag = 0;
  int in_entity = 0;
  for (size_t i = 0; i < len; i++) {
    char c = txt[i];
    if (c == '<') { in_tag = 1; continue; }
    if (c == '>') { in_tag = 0; continue; }
    if (in_tag) continue;
    if (c == '&') { in_entity = 1; continue; }
    if (in_entity) { if (c == ';') in_entity = 0; continue; }
    g_string_append_c(o, c);
  }
  g_string_append_c(o, 0);
  char *out = g_string_free(o, FALSE);
  char *t = out;
  while (*t == ' ' || *t == '\t' || *t == '\n') t++;
  char *trimmed = g_strdup(t);
  g_free(out);
  size_t l = strlen(trimmed);
  while (l > 0 && (trimmed[l - 1] == ' ' || trimmed[l - 1] == '\t' || trimmed[l - 1] == '\n'))
    trimmed[--l] = 0;
  return trimmed;
}

static int persian_season(const char *label) {
  if (!label) return 0;
  int n = 0;
  if (sscanf(label, "%d", &n) == 1 && n > 0) return n;
  struct { const char *w; int v; } map[] = {
      {"اول", 1}, {"دوم", 2}, {"سوم", 3}, {"چهارم", 4}, {"پنجم", 5},
      {"ششم", 6}, {"هفتم", 7}, {"هشتم", 8}, {"نهم", 9}, {"دهم", 10},
  };
  for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); i++)
    if (strstr(label, map[i].w)) return map[i].v;
  const char *se = strcasestr(label, "season ");
  if (se) { if (sscanf(se + 7, "%d", &n) == 1 && n > 0) return n; }
  return 0;
}

static void collect_meta(const char *h, const char *key, GPtrArray *out) {
  const char *p = h;
  while ((p = strcasestr(p, key))) {
    long at = (long)(p - h);
    /* find enclosing <meta ...> tag */
    long start = at;
    for (int k = 0; k < 300 && start > 0; k++) {
      /* scan backwards for '<meta' */
      int found = 0;
      for (long j = start; j > start - 300 && j > 0; j--) {
        if (strncmp(h + j - 5, "<meta", 5) == 0) { start = j - 5; found = 1; break; }
      }
      (void)found;
      break;
    }
    const char *gt = strchr(p, '>');
    if (!gt) break;
    size_t taglen = (size_t)(gt - (h + start));
    if (taglen > 700) { p++; continue; }
    char *tag = g_strndup(h + start, taglen);
    const char *cq = strcasestr(tag, "content=");
    if (cq) {
      const char *dq = strchr(cq, '"');
      const char *sq = strchr(cq, '\'');
      const char *vd = dq ? dq + 1 : NULL;
      char quote = '"';
      if (!dq && sq) { vd = sq + 1; quote = '\''; }
      if (vd) {
        const char *vend = strchr(vd, quote);
        if (vend) g_ptr_array_add(out, g_strndup(vd, (gsize)(vend - vd)));
      }
    }
    g_free(tag);
    p++;
  }
}

static char *extract_title(const char *h) {
  /* <h1 ... class="entry-title...">TEXT</h1> */
  const char *h1 = strstr(h, "<h1");
  while (h1) {
    const char *gt = strchr(h1, '>');
    if (gt) {
      size_t taglen = (size_t)(gt - h1);
      if (taglen < 400) {
        char *tag = g_strndup(h1, taglen);
        int is_title = strstr(tag, "entry-title") != NULL;
        g_free(tag);
        if (is_title) {
          const char *lt = strstr(gt + 1, "</h1");
          if (lt) return strip_tags(gt + 1, (size_t)(lt - (gt + 1)));
        }
      }
    }
    h1 = strstr(h1 + 1, "<h1");
  }
  GPtrArray *a = g_ptr_array_new_with_free_func(g_free);
  collect_meta(h, "og:title", a);
  if (a->len > 0) {
    char *t = g_strdup(g_ptr_array_index(a, 0));
    g_ptr_array_free(a, TRUE);
    return t;
  }
  g_ptr_array_free(a, TRUE);
  const char *t = strstr(h, "<title");
  if (t) {
    const char *gt = strchr(t, '>');
    const char *lt = strstr(t, "</title");
    if (gt && lt && lt > gt) return strip_tags(gt + 1, (size_t)(lt - (gt + 1)));
  }
  return g_strdup("");
}

static char *extract_description(const char *h) {
  GPtrArray *a = g_ptr_array_new_with_free_func(g_free);
  collect_meta(h, "og:description", a);
  collect_meta(h, "description", a);
  collect_meta(h, "twitter:description", a);
  char *best = g_strdup("");
  size_t bestlen = 0;
  for (guint i = 0; i < a->len; i++) {
    const char *s = g_ptr_array_index(a, i);
    size_t len = strlen(s);
    if (len > bestlen) {
      bestlen = len;
      g_free(best);
      best = g_strdup(s);
    }
  }
  g_ptr_array_free(a, TRUE);
  return best;
}

static char *extract_poster(const char *h) {
  /* ld+json thumbnailUrl */
  const char *th = strstr(h, "thumbnailUrl");
  if (th) {
    const char *colon = strchr(th, ':');
    if (colon) {
      const char *op = strchr(colon, '"');
      if (op) {
        const char *start = op + 1;
        const char *end = strchr(start, '"');
        if (end) return g_strndup(start, (gsize)(end - start));
      }
    }
  }
  GPtrArray *a = g_ptr_array_new_with_free_func(g_free);
  collect_meta(h, "og:image", a);
  collect_meta(h, "twitter:image", a);
  char *out = a->len > 0 ? g_strdup(g_ptr_array_index(a, 0)) : g_strdup("");
  g_ptr_array_free(a, TRUE);
  return out;
}

static int is_series_page(const char *h) {
  return strstr(h, "handleDownloadClick") != NULL || strstr(h, "download-list") != NULL;
}

/* ─── main parse ───────────────────────────────────────────────────────────── */

ScrapeInfo *scrape_parse(const char *html, const char *base_url) {
  ScrapeInfo *si = si_new(base_url);
  if (!html) {
    si->error = g_strdup("empty html");
    return si;
  }
  char *u = html_decode(html);
  if (!is_series_page(u)) {
    si->error = g_strdup("not a series/movie page");
    g_free(u);
    return si;
  }
  si->ok = TRUE;
  si->title = extract_title(u);
  si->description = extract_description(u);
  si->poster = extract_poster(u);

  seen_table = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);

  /* 1) download-season boxes */
  long box = 0;
  while ((box = find_div_class(u, "download-season", box)) >= 0) {
    long next = find_div_class(u, "download-season", box + 1);
    long box_end = next >= 0 ? next : (long)strlen(u);
    char *block = slice(u, box, box_end);

    char *btn = NULL;
    const char *bt = strstr(block, "<button");
    if (bt) {
      const char *gt = strchr(bt, '>');
      const char *lt = strstr(bt, "</button");
      if (gt && lt && lt > gt)
        btn = strip_tags(gt + 1, (size_t)(lt - (gt + 1)));
    }
    int season_from_label = persian_season(btn);
    const char *box_variant = btn && (strstr(btn, "دوبله") || strstr(btn, "دوبلد"))
                                ? "dubbled"
                                : "hardsub";

    long dl = 0;
    while (1) {
      long found = find_div_class(block, "download-list", dl);
      if (found < 0) break;
      long nfound = find_div_class(block, "download-list", found + 1);
      long dl_end = nfound >= 0 ? nfound : strlen(block);
      char *sec = slice(block, found, dl_end);
      parse_handleclicks(sec, si, box_variant, season_from_label);
      g_free(sec);
      dl = found + 1;
    }

    g_free(btn);
    g_free(block);
    box = next > 0 ? next : box + 1;
  }

  /* 2) plain <a href="..."> links */
  if (si->eps_len == 0) parse_hrefs(u, si);

  /* 3) all handleDownloadClick() links (movie pages without season boxes) */
  if (si->eps_len == 0) parse_all_handleclicks(u, si);

  g_hash_table_unref(seen_table);
  seen_table = NULL;
  finalize_summary(si);
  g_free(u);
  return si;
}

/* ─── summary ──────────────────────────────────────────────────────────────── */

static int has_se(const char *url) {
  int s = 0, e = 0;
  char *fn = percent_decode(url);
  const char *f = strrchr(fn, '/');
  f = f ? f + 1 : fn;
  int r = parse_se(f, &s, &e);
  g_free(fn);
  return r;
}

static void add_set(char ***arr, int *n, const char *v) {
  for (int i = 0; i < *n; i++)
    if (strcmp((*arr)[i], v) == 0) return;
  *arr = realloc(*arr, (*n + 1) * sizeof(char *));
  (*arr)[(*n)++] = g_strdup(v);
}

static int qual_rank(const char *q) {
  static const char *order[] = { "480p", "720p", "1080p", "2160p", "4k", "unknown" };
  for (int i = 0; i < 6; i++)
    if (g_ascii_strcasecmp(q, order[i]) == 0) return i;
  return 99;
}

static int cmp_str(const void *a, const void *b) {
  return strcmp(*(const char *const *)a, *(const char *const *)b);
}

static void finalize_summary(ScrapeInfo *si) {
  si->is_movie = FALSE;
  if (si->eps_len == 0) return;
  si->is_movie = TRUE;
  GHashTable *seen = g_hash_table_new(g_str_hash, g_str_equal);
  GHashTable *season_ep = g_hash_table_new(g_direct_hash, g_direct_equal);
  for (int i = 0; i < si->eps_len; i++) {
    ScrapeEp *e = &si->eps[i];
    if (has_se(e->url)) si->is_movie = FALSE;
    char k[64];
    g_snprintf(k, sizeof k, "%d:%d", e->season, e->episode);
    if (!g_hash_table_contains(seen, k)) g_hash_table_add(seen, g_strdup(k));
    /* track distinct episodes per season */
    GHashTable *eps = g_hash_table_lookup(season_ep, GINT_TO_POINTER(e->season));
    if (!eps) {
      eps = g_hash_table_new(g_str_hash, g_str_equal);
      g_hash_table_insert(season_ep, GINT_TO_POINTER(e->season), eps);
    }
    char ke[32];
    g_snprintf(ke, sizeof ke, "%d", e->episode);
    if (!g_hash_table_contains(eps, ke)) g_hash_table_add(eps, g_strdup(ke));
    add_set(&si->variants, &si->variants_len, e->variant);
    add_set(&si->qualities, &si->qualities_len, e->quality);
  }
  g_hash_table_destroy(seen);

  si->total_episodes = (int)g_hash_table_size(season_ep);
  si->season_count = (int)g_hash_table_size(season_ep);
  si->seasons = malloc(si->season_count * sizeof(int));
  si->season_counts = malloc(si->season_count * sizeof(int));
  GHashTableIter it;
  gpointer k2, v2;
  int idx = 0;
  g_hash_table_iter_init(&it, season_ep);
  while (g_hash_table_iter_next(&it, &k2, &v2)) {
    si->seasons[idx] = GPOINTER_TO_INT(k2);
    si->season_counts[idx] = (int)g_hash_table_size(v2);
    idx++;
  }
  for (int i = 0; i < si->season_count; i++)
    for (int j = i + 1; j < si->season_count; j++)
      if (si->seasons[j] < si->seasons[i]) {
        int t = si->seasons[i]; si->seasons[i] = si->seasons[j]; si->seasons[j] = t;
        t = si->season_counts[i]; si->season_counts[i] = si->season_counts[j]; si->season_counts[j] = t;
      }
  qsort(si->variants, si->variants_len, sizeof(char *), cmp_str);
  qsort(si->qualities, si->qualities_len, sizeof(char *), cmp_str);
  /* free the per-season episode set nodes */
  g_hash_table_iter_init(&it, season_ep);
  while (g_hash_table_iter_next(&it, &k2, &v2)) g_hash_table_destroy(v2);
  g_hash_table_destroy(season_ep);
}

/* ─── selection (one URL per season:episode) ──────────────────────────────── */

char **scrape_select(const ScrapeInfo *si, const char *variant, const char *quality,
                     int *out_n) {
  *out_n = 0;
  if (!si || si->eps_len == 0) return NULL;
  GHashTable *gidx = g_hash_table_new(g_str_hash, g_str_equal);
  GArray **groups = NULL;
  GArray **gkeys = NULL;
  int ngrp = 0;
  for (int i = 0; i < si->eps_len; i++) {
    const ScrapeEp *e = &si->eps[i];
    char k[64];
    g_snprintf(k, sizeof k, "%d:%d", e->season, e->episode);
    gpointer v = g_hash_table_lookup(gidx, k);
    int grp;
    if (!v) {
      grp = ngrp++;
      g_hash_table_insert(gidx, g_strdup(k), GINT_TO_POINTER(grp + 1));
      groups = realloc(groups, ngrp * sizeof(GArray *));
      gkeys = realloc(gkeys, ngrp * sizeof(GArray *));
      groups[grp] = g_array_new(FALSE, FALSE, sizeof(ScrapeEp *));
      gkeys[grp] = g_array_new(FALSE, FALSE, sizeof(int));
      int se[] = { e->season, e->episode };
      g_array_append_vals(gkeys[grp], se, 2);
    } else grp = GPOINTER_TO_INT(v) - 1;
    ScrapeEp *copy = malloc(sizeof(ScrapeEp));
    *copy = *e;
    g_array_append_val(groups[grp], copy);
  }
  g_hash_table_unref(gidx);

  char *lowq = g_ascii_strdown(quality ? quality : "720p", -1);
  char **out = NULL;

  for (int g = 0; g < ngrp; g++) {
    GArray *grp = groups[g];
    /* collect candidates with the preferred variant, else all */
    GArray *cand = g_array_new(FALSE, FALSE, sizeof(ScrapeEp *));
    for (guint i = 0; i < grp->len; i++) {
      ScrapeEp *e = g_array_index(grp, ScrapeEp *, i);
      if (g_ascii_strcasecmp(e->variant, variant) == 0)
        g_array_append_val(cand, e);
    }
    if (cand->len == 0)
      for (guint i = 0; i < grp->len; i++) {
        ScrapeEp *e = g_array_index(grp, ScrapeEp *, i);
        g_array_append_val(cand, e);
      }
    /* sort candidates by quality rank (stable-ish bubble for small arrays) */
    {
      ScrapeEp **carr = (ScrapeEp **)cand->data;
      for (guint i = 0; i < cand->len; i++)
        for (guint j = i + 1; j < cand->len; j++) {
          if (qual_rank(carr[i]->quality) > qual_rank(carr[j]->quality)) {
            ScrapeEp *buf = carr[i];
            carr[i] = carr[j];
            carr[j] = buf;
          }
        }
    }
    ScrapeEp *best = NULL;
    for (guint i = 0; i < cand->len && !best; i++) {
      ScrapeEp *e = g_array_index(cand, ScrapeEp *, i);
      if (strstr(e->quality, lowq)) best = e;
    }
    if (!best && cand->len > 0) best = g_array_index(cand, ScrapeEp *, 0);
    if (best) {
      out = realloc(out, (*out_n + 1) * sizeof(char *));
      out[(*out_n)++] = g_strdup(best->url);
    }
    g_array_free(cand, TRUE);
  }
  g_free(lowq);

  for (int g = 0; g < ngrp; g++) {
    for (guint i = 0; i < groups[g]->len; i++) free(g_array_index(groups[g], ScrapeEp *, i));
    g_array_free(groups[g], TRUE);
    g_array_free(gkeys[g], TRUE);
  }
  free(groups);
  free(gkeys);
  return out;
}
/* ─── fetch ────────────────────────────────────────────────────────────────── */

static size_t write_cb(char *ptr, size_t size, size_t nmemb, void *userdata) {
  GString *out = userdata;
  g_string_append_len(out, ptr, size * nmemb);
  return size * nmemb;
}

ScrapeInfo *scrape_fetch(const char *page_url) {
  ScrapeInfo *err = si_new(page_url);
  CURL *c = curl_easy_init();
  if (!c) {
    err->error = g_strdup("curl init failed");
    return err;
  }
  GString *html = g_string_new(NULL);
  curl_easy_setopt(c, CURLOPT_URL, page_url);
  curl_easy_setopt(c, CURLOPT_USERAGENT, UA);
  curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(c, CURLOPT_SSL_VERIFYPEER, 0L);
  curl_easy_setopt(c, CURLOPT_SSL_VERIFYHOST, 0L);
  curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 20L);
  curl_easy_setopt(c, CURLOPT_TIMEOUT, 45L);
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write_cb);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, html);
  CURLcode rc = curl_easy_perform(c);
  curl_easy_cleanup(c);
  if (rc != CURLE_OK) {
    err->error = g_strdup_printf("network: %s", curl_easy_strerror(rc));
    g_string_free(html, TRUE);
    return err;
  }
  scrape_free(err);
  ScrapeInfo *si = scrape_parse(html->str, page_url);
  g_string_free(html, TRUE);
  return si;
}

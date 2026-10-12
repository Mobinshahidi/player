#include "store.h"
#include "jmini.h"
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

static int se_from_url(const char *url, int *season, int *episode) {
  const char *sl = strrchr(url, '/');
  const char *fn = sl ? sl + 1 : url;
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

Entry *entry_new(void) {
  Entry *e = calloc(1, sizeof(Entry));
  return e;
}

void entry_free(Entry *e) {
  if (!e) return;
  g_free(e->key); g_free(e->name); g_free(e->url); g_free(e->source_url);
  g_free(e->variant); g_free(e->quality); g_free(e->overview); g_free(e->poster);
  g_free(e->updated_at);
  for (int i = 0; i < e->manual_urls_len; i++) g_free(e->manual_urls[i]);
  free(e->manual_urls);
  g_free(e->seasons);
  g_free(e->season_counts);
  free(e);
}

void entry_compute_summaries(Entry *e) {
  GHashTable *seen = g_hash_table_new(g_str_hash, g_str_equal);
  GHashTable *se = g_hash_table_new(g_direct_hash, g_direct_equal);
  for (int i = 0; i < e->manual_urls_len; i++) {
    const char *u = e->manual_urls[i];
    int s = 0, ep = 0;
    if (!se_from_url(u, &s, &ep)) continue;
    char k[64];
    g_snprintf(k, sizeof k, "%d:%d", s, ep);
    if (!g_hash_table_contains(seen, k)) g_hash_table_add(seen, g_strdup(k));
    GHashTable *eps = g_hash_table_lookup(se, GINT_TO_POINTER(s));
    if (!eps) {
      eps = g_hash_table_new(g_str_hash, g_str_equal);
      g_hash_table_insert(se, GINT_TO_POINTER(s), eps);
    }
    char ke[32];
    g_snprintf(ke, sizeof ke, "%d", ep);
    if (!g_hash_table_contains(eps, ke)) g_hash_table_add(eps, g_strdup(ke));
  }
  e->total_episodes = (int)g_hash_table_size(seen);
  e->season_count = (int)g_hash_table_size(se);
  g_free(e->seasons);
  g_free(e->season_counts);
  e->seasons = malloc((e->season_count > 0 ? e->season_count : 1) * sizeof(int));
  e->season_counts = malloc((e->season_count > 0 ? e->season_count : 1) * sizeof(int));
  GHashTableIter it;
  gpointer k, v;
  int idx = 0;
  g_hash_table_iter_init(&it, se);
  while (g_hash_table_iter_next(&it, &k, &v)) {
    e->seasons[idx] = GPOINTER_TO_INT(k);
    e->season_counts[idx] = (int)g_hash_table_size(v);
    idx++;
  }
  for (int i = 0; i < e->season_count; i++)
    for (int j = i + 1; j < e->season_count; j++)
      if (e->seasons[j] < e->seasons[i]) {
        int t = e->seasons[i]; e->seasons[i] = e->seasons[j]; e->seasons[j] = t;
        t = e->season_counts[i]; e->season_counts[i] = e->season_counts[j]; e->season_counts[j] = t;
      }
  g_hash_table_destroy(seen);
  g_hash_table_iter_init(&it, se);
  while (g_hash_table_iter_next(&it, &k, &v)) g_hash_table_destroy(v);
  g_hash_table_destroy(se);

  /* movies: a single video counts as one episode */
  if (e->is_movie && e->total_episodes == 0) {
    e->total_episodes = 1;
    if (e->season_count == 0) {
      e->seasons[0] = 1;
      e->season_counts[0] = 1;
      e->season_count = 1;
    }
  }
}

/* ─── keys ─────────────────────────────────────────────────────────────────── */

static const char *SKIP[] = { "media", "series", "film", "movies", "film2media", "filmedia", "movie" };

static int is_skip(const char *seg) {
  for (size_t i = 0; i < sizeof(SKIP) / sizeof(SKIP[0]); i++)
    if (strcasecmp(seg, SKIP[i]) == 0) return 1;
  return 0;
}

char *key_from_url(const char *url) {
  if (!url) return g_strdup("");
  const char *host = strstr(url, "://");
  const char *path = host ? host + 3 : url;
  const char *q = strchr(path, '?');
  size_t pathlen = q ? (size_t)(q - path) : strlen(path);
  char *ppath = g_strndup(path, pathlen);
  char **segs = g_strsplit(ppath, "/", -1);
  g_free(ppath);
  int n = 0;
  while (segs[n]) n++;
  /* find SxxEyy-ish season segment */
  for (int i = 0; i < n; i++) {
    if (segs[i] && g_regex_match_simple("^[Ss]\\d+$", segs[i], 0, 0)) {
      for (int j = i - 1; j >= 0; j--) {
        if (!segs[j]) continue;
        if (!is_skip(segs[j]) && !strchr("0123456789", segs[j][0]))
          return g_strdup(segs[j]);
      }
    }
  }
  /* fallback: non-numeric, non-skip segment with length > 2, last wins */
  char *best = NULL;
  for (int i = 0; i < n; i++) {
    if (!segs[i]) continue;
    size_t l = strlen(segs[i]);
    if (l > 2 && !is_skip(segs[i]) && !strchr("0123456789", segs[i][0])) {
      g_free(best);
      best = g_strdup(segs[i]);
    }
  }
  g_strfreev(segs);
  if (best) return best;
  return g_strdup(url);
}

char *pretty_key(const char *key) {
  GString *o = g_string_new(NULL);
  char *copy = g_ascii_strdown(key, -1);
  char *save = NULL;
  char *tok = strtok_r(copy, "-_ .", &save);
  int first_word = 1;
  while (tok) {
    if (strlen(tok) == 0) { tok = strtok_r(NULL, "-_ .", &save); continue; }
    if (!first_word) g_string_append_c(o, ' ');
    first_word = 0;
    g_string_append_c(o, toupper((unsigned char)tok[0]));
    g_string_append(o, tok + 1);
    tok = strtok_r(NULL, "-_ .", &save);
  }
  g_free(copy);
  char *out = g_string_free(o, FALSE);
  if (strlen(out) == 0) { g_free(out); return g_strdup(key); }
  return out;
}

/* ─── store ────────────────────────────────────────────────────────────────── */

void store_init(Store *s) { memset(s, 0, sizeof *s); }
void store_clear(Store *s) {
  for (int i = 0; i < s->n; i++) entry_free(s->items[i]);
  free(s->items);
  s->items = NULL;
  s->n = 0;
  g_free(s->deleted_json);
  s->deleted_json = NULL;
}

static int jnum(const JVal *v, int def) {
  if (!v || v->t != J_NUM) return def;
  return (int)v->num;
}
static double jdbl(const JVal *v, double def) {
  return v && v->t == J_NUM ? v->num : def;
}
static int jbool(const JVal *v, int def) {
  return v && v->t == J_BOOL ? v->b : def;
}
static char *jstr(const JVal *v) {
  return v && v->t == J_STR ? v->s : NULL;
}

static void jarr_strings(const JVal *arr, char ***out, int *out_n) {
  *out = NULL;
  *out_n = 0;
  if (!arr || arr->t != J_ARR) return;
  for (int i = 0; i < arr->n; i++) {
    if (arr->a[i]->t == J_STR && arr->a[i]->s) {
      *out = realloc(*out, (*out_n + 1) * sizeof(char *));
      (*out)[(*out_n)++] = g_strdup(arr->a[i]->s);
    }
  }
}

gboolean store_load(Store *s, const char *path) {
  store_clear(s);
  if (!path || !g_file_test(path, G_FILE_TEST_EXISTS)) return TRUE;
  char *text = NULL;
  gsize len = 0;
  if (!g_file_get_contents(path, &text, &len, NULL)) return FALSE;
  JVal *root = jparse(text);
  g_free(text);
  if (!root || root->t != J_OBJ) {
    if (root) jv_free(root);
    return FALSE;
  }
  for (int i = 0; i < root->n; i += 2) {
    const char *k = root->a[i]->s;
    JVal *o = root->a[i + 1];
    if (!k || o->t != J_OBJ) continue;
    /* reserved members (e.g. "_deleted" deletion log) are preserved */
    if (k[0] == '_') {
      if (strcmp(k, "_deleted") == 0) {
        g_free(s->deleted_json);
        s->deleted_json = jdump(o);
      }
      continue;
    }
    if (!jstr(jv_get(o, "url"))) continue; /* skip non-entry members */
    Entry *e = entry_new();
    e->key = g_strdup(k);
    e->name = jstr(jv_get(o, "name")) ? g_strdup(jstr(jv_get(o, "name"))) : pretty_key(k);
    e->url = jstr(jv_get(o, "url")) ? g_strdup(jstr(jv_get(o, "url"))) : g_strdup("");
    e->season = jnum(jv_get(o, "season"), 1);
    e->episode = jnum(jv_get(o, "episode"), 0);
    if (e->season <= 0) e->season = 1;
    if (e->episode < 0) e->episode = 0;
    e->timestamp = jdbl(jv_get(o, "timestamp"), 0);
    e->finished = jbool(jv_get(o, "finished"), 0);
    e->is_movie = jbool(jv_get(o, "isMovie"), 0);
    e->source_url = jstr(jv_get(o, "sourceUrl")) ? g_strdup(jstr(jv_get(o, "sourceUrl"))) : NULL;
    e->overview = jstr(jv_get(o, "overview")) ? g_strdup(jstr(jv_get(o, "overview"))) : NULL;
    e->poster = jstr(jv_get(o, "poster")) ? g_strdup(jstr(jv_get(o, "poster"))) : NULL;
    e->updated_at = jstr(jv_get(o, "updatedAt")) ? g_strdup(jstr(jv_get(o, "updatedAt"))) : NULL;
    JVal *src = jv_get(o, "source");
    if (src && src->t == J_OBJ) {
      e->variant = jstr(jv_get(src, "variant")) ? g_strdup(jstr(jv_get(src, "variant"))) : NULL;
      e->quality = jstr(jv_get(src, "quality")) ? g_strdup(jstr(jv_get(src, "quality"))) : NULL;
    }
    jarr_strings(jv_get(o, "manualUrls"), &e->manual_urls, &e->manual_urls_len);
    /* carry over the per-episode resume position for the current episode
     * (the TS app keys these by the filename's SxxEyy identity) */
    JVal *ets = jv_get(o, "episodeTimestamps");
    if (ets && ets->t == J_OBJ) {
      char id[32];
      g_snprintf(id, sizeof id, "S%02dE%02d", e->season, e->episode + 1);
      JVal *pos = jv_get(ets, id);
      if (pos && pos->t == J_NUM) e->timestamp = pos->num;
    }
    entry_compute_summaries(e);
    s->items = realloc(s->items, (s->n + 1) * sizeof(Entry *));
    s->items[s->n++] = e;
  }
  jv_free(root);
  return TRUE;
}


gboolean store_save(Store *s, const char *path) {
  JVal *root = jv_obj();
  for (int i = 0; i < s->n; i++) {
    Entry *e = s->items[i];
    JVal *o = jv_obj();
    if (e->name) jv_set(o, "name", jv_str(e->name));
    if (e->url) jv_set(o, "url", jv_str(e->url));
    jv_set(o, "season", jv_num(e->season));
    jv_set(o, "episode", jv_num(e->episode));
    jv_set(o, "timestamp", jv_num(e->timestamp));
    jv_set(o, "finished", jv_bool(e->finished));
    jv_set(o, "isMovie", jv_bool(e->is_movie));
    if (e->source_url) jv_set(o, "sourceUrl", jv_str(e->source_url));
    if (e->overview) jv_set(o, "overview", jv_str(e->overview));
    if (e->poster) jv_set(o, "poster", jv_str(e->poster));
    if (e->variant || e->quality) {
      JVal *src = jv_obj();
      src = jv_obj();
      if (e->variant) jv_set(src, "variant", jv_str(e->variant));
      jv_set(src, "quality", jv_str(e->quality ? e->quality : "720p"));
      jv_set(o, "source", src);
    }
    if (e->manual_urls_len > 0) {
      JVal *arr = jv_arr();
      for (int j = 0; j < e->manual_urls_len; j++) jv_push(arr, jv_str(e->manual_urls[j]));
      jv_set(o, "manualUrls", arr);
    }
    if (!e->updated_at) {
      GDateTime *dt = g_date_time_new_now_local();
      char *iso = g_date_time_format(dt, "%Y-%m-%dT%H:%M:%S%z");
      e->updated_at = iso;
      g_date_time_unref(dt);
    }
    jv_set(o, "updatedAt", jv_str(e->updated_at));
    jv_set(root, e->key ? e->key : "", o);
  }
  if (s->deleted_json) {
    JVal *d = jparse(s->deleted_json);
    if (d) jv_set(root, "_deleted", d);
  }
  char *json = jdump(root);
  jv_free(root);
  gboolean ok = FALSE;
  char *dir = g_path_get_dirname(path);
  g_mkdir_with_parents(dir, 0755);
  g_free(dir);
  ok = g_file_set_contents(path, json, -1, NULL);
  g_free(json);
  return ok;
}

Entry *store_get(Store *s, const char *key) {
  for (int i = 0; i < s->n; i++)
    if (s->items[i]->key && strcmp(s->items[i]->key, key) == 0) return s->items[i];
  return NULL;
}

Entry *store_upsert(Store *s, Entry *e) {
  Entry *old = store_get(s, e->key);
  if (old) {
    entry_free(old);
    int idx = -1;
    for (int i = 0; i < s->n; i++)
      if (s->items[i] == old) { idx = i; break; }
    if (idx >= 0) s->items[idx] = e;
    return e;
  }
  s->items = realloc(s->items, (s->n + 1) * sizeof(Entry *));
  s->items[s->n++] = e;
  return e;
}

void store_remove(Store *s, const char *key) {
  for (int i = 0; i < s->n; i++) {
    if (s->items[i]->key && strcmp(s->items[i]->key, key) == 0) {
      entry_free(s->items[i]);
      memmove(&s->items[i], &s->items[i + 1], (size_t)(s->n - i - 1) * sizeof(Entry *));
      s->n--;
      return;
    }
  }
}
#ifndef STORE_H
#define STORE_H

#include <glib.h>

typedef struct {
  char *key;
  char *name;
  char *url;
  int season;          /* 1-based */
  int episode;         /* 0-based */
  double timestamp;
  gboolean finished;
  gboolean is_movie;
  char *source_url;
  char *variant;       /* "dubbled" | "hardsub" */
  char *quality;
  char *overview;
  char *poster;
  char **manual_urls;
  int manual_urls_len;
  char *updated_at;
  /* computed for display */
  int total_episodes;
  int *seasons;
  int *season_counts;
  int season_count;
} Entry;

typedef struct {
  Entry **items;
  int n;
} Store;

void store_init(Store *s);
void store_clear(Store *s);
gboolean store_load(Store *s, const char *path);
gboolean store_save(Store *s, const char *path);
Entry *store_get(Store *s, const char *key);
/* takes ownership of e (returns e, or the stored pointer if replaced) */
Entry *store_upsert(Store *s, Entry *e);
void store_remove(Store *s, const char *key);

Entry *entry_new(void);
void entry_free(Entry *e);
void entry_compute_summaries(Entry *e);

char *key_from_url(const char *url);
char *pretty_key(const char *key);

#endif
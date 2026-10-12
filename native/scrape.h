#ifndef SCRAPE_H
#define SCRAPE_H

#include <glib.h>

typedef struct {
  char *url;
  int season;   /* 1-based */
  int episode;  /* 0-based */
  char *variant; /* "dubbled" | "hardsub" */
  char *quality;
} ScrapeEp;

typedef struct {
  gboolean ok;
  char *url;
  char *title;
  char *description;
  char *poster;
  gboolean is_movie;
  ScrapeEp *eps;
  int eps_len;
  char **variants;
  int variants_len;
  char **qualities;
  int qualities_len;
  int total_episodes;
  int *seasons;      /* season numbers */
  int *season_counts; /* episode counts per season */
  int season_count;
  char *error;
} ScrapeInfo;

/* Fetch + parse a film2media/dooplay series or movie page. */
ScrapeInfo *scrape_fetch(const char *page_url);

/* Parse already-fetched HTML (used by tests). */
ScrapeInfo *scrape_parse(const char *html, const char *base_url);

void scrape_free(ScrapeInfo *info);

/* Pick one URL per (season, episode) for the given variant/quality.
 * Returns malloc'd array; caller frees with g_strfreev()-style free. */
char **scrape_select(const ScrapeInfo *info, const char *variant,
                     const char *quality, int *out_n);

#endif
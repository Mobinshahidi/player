#include <stdio.h>
#include <glib.h>
#include "scrape.h"

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: test-parse <file.html> [baseurl]\n");
    return 2;
  }
  gsize len = 0;
  char *buf = NULL;
  if (!g_file_get_contents(argv[1], &buf, &len, NULL)) {
    fprintf(stderr, "cannot read %s\n", argv[1]);
    return 2;
  }
  const char *base = argc > 2 ? argv[2] : "https://x/";
  ScrapeInfo *si = scrape_parse(buf, base);
  g_free(buf);

  printf("ok=%d error=%s\n", si->ok, si->error ? si->error : "-");
  printf("title=%s\n", si->title ? si->title : "-");
  printf("description(len)=%zu poster=%s\n",
         si->description ? strlen(si->description) : 0,
         si->poster ? si->poster : "-");
  printf("is_movie=%d episodes=%d total=%d\n", si->is_movie, si->eps_len,
         si->total_episodes);
  for (int i = 0; i < si->eps_len && i < 8; i++)
    printf("  ep[%d] S%dE%d %s/%s %s\n", i, si->eps[i].season, si->eps[i].episode,
           si->eps[i].variant, si->eps[i].quality, si->eps[i].url);
  for (int i = 0; i < si->season_count; i++)
    printf("S%d: %d eps\n", si->seasons[i], si->season_counts[i]);
  printf("variants:");
  for (int i = 0; i < si->variants_len; i++) printf(" %s", si->variants[i]);
  printf("\nqualities:");
  for (int i = 0; i < si->qualities_len; i++) printf(" %s", si->qualities[i]);
  printf("\n");

  const char *vs[] = { "dubbled", "hardsub" };
  const char *qs[] = { "720p", "1080p", "480p" };
  for (int a = 0; a < 2; a++)
    for (int b = 0; b < 3; b++) {
      int n = 0;
      char **u = scrape_select(si, vs[a], qs[b], &n);
      printf("select %s/%s -> %d urls", vs[a], qs[b], n);
      if (n > 0) printf(" first=%s", u[0]);
      printf("\n");
      if (u) { for (int i = 0; i < n; i++) g_free(u[i]); g_free(u); }
    }

  scrape_free(si);
  return 0;
}
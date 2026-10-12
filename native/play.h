#ifndef PLAY_H
#define PLAY_H

#include <glib.h>
#include "store.h"

typedef struct {
  void *ud;
  void (*on_state)(void *ud);   /* refresh now-playing UI + save in-memory pos */
  void (*on_save)(void *ud);    /* persist the store now */
  void (*on_season_end)(void *ud, int season, int count);
  void (*on_stopped)(void *ud);
} PbCallbacks;

typedef struct {
  gboolean active;
  gboolean running;      /* mpv process alive */
  char *key;
  Entry *entry;
  int season;
  int episode;           /* 0-based within season urls */
  int total;
  char **urls;
  int n;
  char *label;
  GPid mpv_pid;
  gboolean stop_flag;
  gboolean next_flag;
  gboolean near_end;
  double time;
  double duration;
  char *socket_path;
  guint poll_src;
  PbCallbacks cb;
} Playback;

void pb_init(Playback *pb);
void pb_start(Playback *pb, Entry *e, int season);
void pb_stop(Playback *pb);
void pb_next(Playback *pb);
void pb_pause(Playback *pb);
void pb_finish_season(Playback *pb);

#endif
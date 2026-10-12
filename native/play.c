#include "play.h"
#include "jmini.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/types.h>
#include <poll.h>

static const char *cache_root(void) {
  static char *dir = NULL;
  if (!dir) {
    const char *x = g_getenv("XDG_CACHE_HOME");
    dir = x && *x ? g_build_filename(x, "player-gui", NULL)
                  : g_build_filename(g_get_home_dir(), ".cache", "player-gui", NULL);
  }
  return dir;
}

const char *player_socket_path(void) {
  static char *p = NULL;
  if (!p) p = g_build_filename(cache_root(), "mpv.sock", NULL);
  return p;
}

static int se_from_url(const char *url, int *season, int *episode) {
  const char *sl = strrchr(url, '/');
  const char *fn = sl ? sl + 1 : url;
  size_t n = strlen(fn);
  for (size_t i = 0; i + 2 < n; i++) {
    char c = fn[i];
    if (c == 's' || c == 'S') {
      size_t j = i + 1;
      int s = 0;
      while (j < n && g_ascii_isdigit(fn[j])) { s = s * 10 + (fn[j] - '0'); j++; }
      if (s == 0 || (fn[j] != 'e' && fn[j] != 'E')) continue;
      j++;
      int e = 0;
      while (j < n && g_ascii_isdigit(fn[j])) { e = e * 10 + (fn[j] - '0'); j++; }
      if (e > 0) { *season = s; *episode = e - 1; return 1; }
    }
  }
  return 0;
}

/* ─── mpv IPC ──────────────────────────────────────────────────────────────── */

static int mpv_connect(const char *sock) {
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  g_strlcpy(addr.sun_path, sock, sizeof addr.sun_path);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static int mpv_send_cmd(const char *sock, const char *json) {
  int fd = mpv_connect(sock);
  if (fd < 0) return -1;
  write(fd, json, strlen(json));
  write(fd, "\n", 1);
  close(fd);
  return 0;
}

/* query time-pos and duration; returns 1 if got at least time */
static int mpv_query(const char *sock, double *time, double *dur) {
  int fd = mpv_connect(sock);
  if (fd < 0) return 0;
  const char *c1 = "{\"command\":[\"get_property\",\"time-pos\"],\"request_id\":1}\n";
  const char *c2 = "{\"command\":[\"get_property\",\"duration\"],\"request_id\":2}\n";
  write(fd, c1, strlen(c1));
  write(fd, c2, strlen(c2));

  char buf[16384];
  size_t len = 0;
  gboolean time_done = FALSE, dur_done = FALSE;
  struct pollfd pfd = { fd, POLLIN, 0 };
  while ((!time_done || !dur_done) && poll(&pfd, 1, 1500) > 0) {
    ssize_t r = read(fd, buf + len, sizeof buf - len - 1);
    if (r <= 0) break;
    len += (size_t)r;
    buf[len] = 0;
    /* process complete lines */
    char *line = buf;
    while ((line = strchr(line, '\n'))) {
      *line = 0;
      JVal *o = jparse(line);
      if (o && o->t == J_OBJ) {
        JVal *rid = jv_get(o, "request_id");
        JVal *data = jv_get(o, "data");
        if (rid && rid->t == J_NUM && data && data->t == J_NUM) {
          if ((int)rid->num == 1) { *time = data->num; time_done = TRUE; }
          else if ((int)rid->num == 2) { *dur = data->num; dur_done = TRUE; }
        }
      }
      if (o) jv_free(o);
      line++;
    }
  }
  close(fd);
  return time_done ? 1 : 0;
}

/* ─── playback flow ────────────────────────────────────────────────────────── */

static void pb_play_current(Playback *pb);
static void pb_do_stop(Playback *pb);
static void pb_on_mpv_exit(GPid pid, gint status, gpointer user);
static gboolean pb_poll_cb(gpointer user);

void pb_init(Playback *pb) {
  memset(pb, 0, sizeof *pb);
  pb->socket_path = g_strdup(player_socket_path());
  pb->poll_src = g_timeout_add_seconds(1, pb_poll_cb, pb);
}

static void pb_spawn_mpv(Playback *pb, const char *url, double pos) {
  GPtrArray *a = g_ptr_array_new();
  g_ptr_array_add(a, g_strdup("mpv"));
  g_ptr_array_add(a, g_strdup("--no-terminal"));
  g_ptr_array_add(a, g_strdup("--hwdec=auto"));
  char sockarg[512];
  g_snprintf(sockarg, sizeof sockarg, "--input-ipc-server=%s", pb->socket_path);
  g_ptr_array_add(a, g_strdup(sockarg));
  g_ptr_array_add(a, g_strdup("--force-window=immediate"));
  g_ptr_array_add(a, g_strdup("--keep-open=yes"));
  g_ptr_array_add(a, g_strdup("--keep-open-pause=no"));
  g_ptr_array_add(a, g_strdup("--cache=yes"));
  g_ptr_array_add(a, g_strdup("--cache-secs=30"));
  if (pos > 0.5) {
    char start[64];
    g_snprintf(start, sizeof start, "--start=%.3f", pos);
    g_ptr_array_add(a, g_strdup(start));
  }
  g_ptr_array_add(a, g_strdup(url));
  g_ptr_array_add(a, NULL);

  char **argv = (char **)g_ptr_array_free(a, FALSE);
  GError *err = NULL;
  int ok = g_spawn_async(NULL, argv, NULL, G_SPAWN_SEARCH_PATH | G_SPAWN_STDOUT_TO_DEV_NULL,
                         NULL, NULL, &pb->mpv_pid, &err);
  g_strfreev(argv);
  if (!ok) {
    g_warning("failed to spawn mpv: %s", err ? err->message : "?");
    if (err) g_error_free(err);
    pb_do_stop(pb);
    return;
  }
  pb->running = TRUE;
  pb->near_end = FALSE;
  g_child_watch_add(pb->mpv_pid, pb_on_mpv_exit, pb);
}

static gboolean pb_poll_cb(gpointer user) {
  Playback *pb = user;
  if (!pb->active || !pb->running) return G_SOURCE_CONTINUE;
  double t = 0, d = 0;
  if (mpv_query(pb->socket_path, &t, &d)) {
    pb->time = t;
    if (d > 0) pb->duration = d;
    pb->cb.on_state(pb->cb.ud);
    if (d > 0 && (d - t < 60.0 || t / d >= 0.95)) {
      if (!pb->near_end) {
        pb->near_end = TRUE;
        mpv_send_cmd(pb->socket_path, "{\"command\":[\"quit\"]}");
      }
    }
  }
  return G_SOURCE_CONTINUE;
}

static void pb_play_current(Playback *pb) {
  if (pb->episode >= pb->n) return;
  const char *url = pb->urls[pb->episode];
  double pos = 0;
  if (pb->entry && pb->entry->season == pb->season && pb->entry->episode == pb->episode)
    pos = pb->entry->timestamp;
  if (pb->entry) {
    pb->entry->season = pb->season;
    pb->entry->episode = pb->episode;
  }
  pb->cb.on_state(pb->cb.ud);
  pb_spawn_mpv(pb, url, pos);
}

static void pb_advance(Playback *pb) {
  pb->episode++;
  if (pb->episode >= pb->n) {
    pb->cb.on_season_end(pb->cb.ud, pb->season, pb->n);
    /* wait for user answer via pb_finish_season() */
    return;
  }
  pb_play_current(pb);
}

static void pb_on_mpv_exit(GPid pid, gint status, gpointer user) {
  Playback *pb = user;
  (void)pid; (void)status;
  pb->running = FALSE;
  if (!pb->active) return;
  if (pb->near_end) {
    pb->near_end = FALSE;
    pb_advance(pb);
  } else if (pb->next_flag) {
    pb->next_flag = FALSE;
    pb_advance(pb);
  } else if (pb->stop_flag) {
    pb->stop_flag = FALSE;
    pb_do_stop(pb);
  } else {
    pb_do_stop(pb); /* user closed the window */
  }
}

void pb_start(Playback *pb, Entry *e, int season) {
  pb_stop(pb);
  GArray *urls = g_array_new(FALSE, FALSE, sizeof(char *));
  if (e->is_movie) {
    if (e->url && *e->url) g_array_append_val(urls, e->url);
  } else {
    for (int i = 0; i < e->manual_urls_len; i++) {
      int s = 0, ep = 0;
      if (se_from_url(e->manual_urls[i], &s, &ep) && s == season)
        g_array_append_val(urls, e->manual_urls[i]);
    }
    /* sort by episode */
    {
      char **uarr = (char **)urls->data;
      for (guint i = 0; i < urls->len; i++)
        for (guint j = i + 1; j < urls->len; j++) {
          int s1 = 0, e1 = 0, s2 = 0, e2 = 0;
          se_from_url(uarr[i], &s1, &e1);
          se_from_url(uarr[j], &s2, &e2);
          if (e2 < e1) {
            char *buf = uarr[i];
            uarr[i] = uarr[j];
            uarr[j] = buf;
          }
        }
    }
  }
  if (urls->len == 0) {
    g_array_free(urls, TRUE);
    pb->cb.on_stopped(pb->cb.ud);
    return;
  }
  pb->key = g_strdup(e->key);
  pb->entry = e;
  pb->season = season;
  pb->n = (int)urls->len;
  pb->urls = g_new(char *, pb->n);
  for (int i = 0; i < pb->n; i++) {
    char *tmp = g_array_index(urls, char *, i);
    pb->urls[i] = g_strdup(tmp);
  }
  g_array_free(urls, TRUE);
  pb->episode = (e->season == season) ? e->episode : 0;
  if (pb->episode >= pb->n) pb->episode = 0;
  pb->total = pb->n;
  pb->active = TRUE;
  pb_play_current(pb);
}

void pb_stop(Playback *pb) {
  if (pb->running) {
    pb->stop_flag = TRUE;
    pb->next_flag = FALSE;
    mpv_send_cmd(pb->socket_path, "{\"command\":[\"quit\"]}");
  } else if (pb->active) {
    pb_do_stop(pb);
  }
}

void pb_next(Playback *pb) {
  if (!pb->active) return;
  if (pb->episode + 1 >= pb->total) return; /* last episode: let it finish */
  if (pb->running) {
    pb->next_flag = TRUE;
    mpv_send_cmd(pb->socket_path, "{\"command\":[\"quit\"]}");
  }
}

void pb_pause(Playback *pb) {
  if (pb->running)
    mpv_send_cmd(pb->socket_path, "{\"command\":[\"cycle\",\"pause\"]}");
}

void pb_finish_season(Playback *pb) {
  pb_do_stop(pb);
}

static void pb_do_stop(Playback *pb) {
  pb->active = FALSE;
  pb->near_end = FALSE;
  pb->stop_flag = FALSE;
  pb->next_flag = FALSE;
  pb->running = FALSE;
  if (pb->entry) pb->entry->timestamp = pb->time;
  pb->cb.on_save(pb->cb.ud);
  pb->cb.on_stopped(pb->cb.ud);
  for (int i = 0; i < pb->n; i++) g_free(pb->urls[i]);
  g_free(pb->urls);
  pb->urls = NULL;
  pb->n = 0;
  g_free(pb->label);
  pb->label = NULL;
  g_free(pb->key);
  pb->key = NULL;
}
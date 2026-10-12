#include <gtk/gtk.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <curl/curl.h>

#include "store.h"
#include "scrape.h"
#include "play.h"

/* ── i18n ──────────────────────────────────────────────────────────────────── */

typedef struct { const char *en; const char *fa; } S;
static const S SS[] = {
  {"total", "کل"}, {"local_only", "فقط محلی"}, {"search", "جستجو…"},
  {"add", "＋ افزودن سریال"},
  {"empty", "هنوز سریالی اضافه نشده — یکی اضافه کنید."},
  {"select_hint", "یک سریال را انتخاب کنید یا با دکمهٔ سمت چپ یکی اضافه کنید."},
  {"footer", "[↑↓] حرکت   [Enter] پخش   [n] افزودن   [/] جستجو"},
  {"type", "نوع"}, {"status", "وضعیت"}, {"episode", "قسمت"},
  {"this_season", "این فصل"}, {"total_ep", "کل"}, {"version", "نسخه"},
  {"quality", "کیفیت"}, {"movie", "فیلم"}, {"series", "سریال"},
  {"finished", "تمام‌شده"}, {"watching", "در حال تماشا"}, {"episodes", "قسمت"},
  {"play", "▶  پخش"}, {"remove", "🗑  حذف"},
  {"pause", "⏸ توقف"}, {"next", "⏭ بعدی"}, {"stop", "⏹ قطع"},
  {"dubbed", "دوبله"}, {"hardsub", "زیرنویس چسبیده"},
  {"add_title", "افزودن سریال"}, {"add_label", "لینک سریال را وارد کنید"},
  {"fetch", "دریافت"}, {"cancel", "انصراف"}, {"name", "نام"},
  {"already", "از قبل در فهرست شماست — پخش آن را بروزرسانی می‌کند."},
  {"total_line", "کل:"}, {"fetching", "در حال دریافت اطلاعات…"},
  {"cannot_read", "صفحه خوانده نشد"}, {"refresh_failed", "بروزرسانی ناموفق بود"},
  {"movie_finished", "فیلم تمام شد"}, {"movie_end", "فایل کش حذف شود؟"},
  {"season_end_title", "تمام شد"}, {"season_end_body", "فایل‌های کش این فصل حذف شوند؟"},
  {"keep", "نگه‌دار"}, {"delete", "حذف"},
  {"remove_title", "سریال حذف شود؟"},
  {"remove_body", "فقط از فهرست حذف می‌شود؛ فایل‌های کش دست‌نخورده می‌مانند."},
  {"deleted", "حذف شد"}, {"nothing", "چیزی برای حذف نیست"},
};

/* ── app ───────────────────────────────────────────────────────────────────── */

typedef struct {
  Store store;
  char *store_path;
  int lang;             /* 0 en, 1 fa */
  int *visible;
  int visible_len;
  int sel;
  char *filter;

  Playback pb;

  GtkWidget *win;
  GtkWidget *list;
  GtkWidget *header_total;
  GtkWidget *search;
  GtkWidget *detail_box;
  GtkWidget *np_bar;
  GtkWidget *np_title;
  GtkWidget *np_pause;
  GtkWidget *np_next;
  GtkWidget *np_stop;
  GtkWidget *footer;
  GtkWidget *toast;
  guint toast_src;
} App;

static App *g_app = NULL;

static const char *t(const char *key) {
  for (size_t i = 0; i < sizeof(SS) / sizeof(SS[0]); i++)
    if (strcmp(SS[i].en, key) == 0)
      return g_app && g_app->lang == 1 ? SS[i].fa : SS[i].en;
  return key;
}

/* ── CSS ───────────────────────────────────────────────────────────────────── */

static const char *THEME_CSS =
  "window { background:#1e1e1d; color:#c3c2b7; font-family:monospace; } "
  "#header { background:#161615; border-bottom:1px solid #3a3a38; } "
  "#listpanel { background:#1e1e1d; border-right:1px solid #3a3a38; } "
  ".list-row { color:#c3c2b7; padding:5px 10px; } "
  ".list-row.finished { color:#6b6b64; } "
  ".list-row.watching { color:#d57455; } "
  ".list-row:selected { background:#d57455; color:#1e1e1d; } "
  ".accent { color:#d57455; font-weight:bold; } "
  ".hint { color:#6b6b64; } "
  ".btn-accent { background:#d57455; color:#1e1e1d; } "
  "button { background:#1e1e1d; color:#c3c2b7; border:1px solid #3a3a38; } "
  "button:hover { border-color:#d57455; color:#d57455; } "
  "entry { background:#161615; color:#c3c2b7; border:1px solid #3a3a38; } "
  "#np { background:#161615; border-top:1px solid #3a3a38; } "
  "#np-title { color:#d57455; } "
  "#footer { background:#161615; border-top:1px solid #3a3a38; } "
  ".lang.active { background:#d57455; color:#1e1e1d; } "
  ".desc { line-height:1.6; } ";

static void load_css(void) {
  GtkCssProvider *p = gtk_css_provider_new();
  gtk_css_provider_load_from_string(p, THEME_CSS);
  gtk_style_context_add_provider_for_display(gdk_display_get_default(),
      GTK_STYLE_PROVIDER(p), GTK_STYLE_PROVIDER_PRIORITY_USER);
  g_object_unref(p);
}

/* ── forward declarations ──────────────────────────────────────────────────── */

static void refresh_list(App *app);
static void refresh_detail(App *app);
static void refresh_header(App *app);
static void refresh_np(App *app);
static void show_add_modal(GtkWidget *w, gpointer ud);
static void show_remove_modal(GtkWidget *w, gpointer ud);
static void show_options_modal(App *app, ScrapeInfo *info);
static void show_season_end_modal(App *app, int season, int count);
static gboolean season_close_cb(GtkWidget *w, gpointer ud);
static void play_selected(GtkWidget *w, gpointer ud);

void ui_refresh_np(void *ud);
void ui_save(void *ud);
void ui_season_end(void *ud, int season, int count);
void ui_stopped(void *ud);

/* ── helpers ───────────────────────────────────────────────────────────────── */

static void set_lang(App *app, int lang) {
  app->lang = lang;
  gtk_widget_set_direction(app->win, lang ? GTK_TEXT_DIR_RTL : GTK_TEXT_DIR_LTR);
  refresh_header(app);
  refresh_list(app);
  refresh_detail(app);
  gtk_label_set_text(GTK_LABEL(app->footer), t("footer"));
  gtk_entry_set_placeholder_text(GTK_ENTRY(app->search), t("search"));
}

static void rebuild_visible(App *app) {
  int n = app->store.n;
  int *idx = malloc((n > 0 ? n : 1) * sizeof(int));
  for (int i = 0; i < n; i++) idx[i] = i;
  for (int i = 0; i < n; i++)
    for (int j = i + 1; j < n; j++) {
      int swap = 0;
      int fa = app->store.items[idx[i]]->finished ? 1 : 0;
      int fb = app->store.items[idx[j]]->finished ? 1 : 0;
      if (fa != fb) swap = fb < fa;
      else if (g_ascii_strcasecmp(app->store.items[idx[i]]->name ? app->store.items[idx[i]]->name : "",
                                  app->store.items[idx[j]]->name ? app->store.items[idx[j]]->name : "") > 0)
        swap = 1;
      if (swap) { int tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; }
    }
  free(app->visible);
  app->visible = malloc((n > 0 ? n : 1) * sizeof(int));
  app->visible_len = 0;
  for (int i = 0; i < n; i++) {
    Entry *e = app->store.items[idx[i]];
    if (app->filter && *app->filter && !strcasestr(e->name ? e->name : "", app->filter))
      continue;
    app->visible[app->visible_len++] = idx[i];
  }
  free(idx);
  if (app->sel >= app->visible_len) app->sel = app->visible_len > 0 ? app->visible_len - 1 : 0;
  if (app->sel < 0) app->sel = 0;
}

static Entry *selected_entry(App *app) {
  if (app->sel >= 0 && app->sel < app->visible_len)
    return app->store.items[app->visible[app->sel]];
  return NULL;
}

static char *fmt_ts(double sec) {
  int s = (int)sec;
  return g_strdup_printf("%d:%02d", s / 60, s % 60);
}

/* ── pb callbacks ──────────────────────────────────────────────────────────── */

void ui_refresh_np(void *ud) { refresh_np(ud); }
void ui_save(void *ud) {
  App *app = ud;
  store_save(&app->store, app->store_path);
}
void ui_season_end(void *ud, int season, int count) {
  show_season_end_modal(ud, season, count);
}
void ui_stopped(void *ud) {
  App *app = ud;
  refresh_np(app);
  refresh_list(app);
  refresh_detail(app);
  store_save(&app->store, app->store_path);
}

/* ── refresh fxns ──────────────────────────────────────────────────────────── */

static void refresh_header(App *app) {
  char buf[96];
  g_snprintf(buf, sizeof buf, "[%s: %d]", t("total"), app->store.n);
  gtk_label_set_text(GTK_LABEL(app->header_total), buf);
}

static void refresh_list(App *app) {
  GtkListBoxRow *row;
  while ((row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(app->list), 0)))
    gtk_list_box_remove(GTK_LIST_BOX(app->list), GTK_WIDGET(row));
  rebuild_visible(app);
  for (int i = 0; i < app->visible_len; i++) {
    Entry *e = app->store.items[app->visible[i]];
    char progress[160];
    if (e->finished) {
      g_snprintf(progress, sizeof progress, "✓ %s", t("finished"));
    } else if (e->is_movie) {
      if (e->timestamp > 0)
        g_snprintf(progress, sizeof progress, "@ %d:%02d",
                   ((int)e->timestamp / 60) % 60, (int)e->timestamp % 60);
      else
        g_snprintf(progress, sizeof progress, "%s", t("movie"));
    } else {
      g_snprintf(progress, sizeof progress, "S%dE%02d", e->season, e->episode + 1);
      if (e->timestamp > 0) {
        char *tt = fmt_ts(e->timestamp);
        g_strlcat(progress, " ", sizeof progress);
        g_strlcat(progress, tt, sizeof progress);
        g_free(tt);
      }
    }
    GtkWidget *r = gtk_list_box_row_new();
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *lname = gtk_label_new(e->name ? e->name : e->key);
    gtk_widget_add_css_class(lname, "name");
    gtk_label_set_xalign(GTK_LABEL(lname), 0);
    gtk_widget_set_hexpand(lname, TRUE);
    gtk_label_set_ellipsize(GTK_LABEL(lname), PANGO_ELLIPSIZE_END);
    GtkWidget *lprog = gtk_label_new(progress);
    gtk_label_set_xalign(GTK_LABEL(lprog), 0);
    gtk_widget_add_css_class(r, "list-row");
    if (e->finished) gtk_widget_add_css_class(r, "finished");
    else if (e->episode > 0 || e->timestamp > 0) gtk_widget_add_css_class(r, "watching");
    gtk_box_append(GTK_BOX(box), lname);
    gtk_box_append(GTK_BOX(box), lprog);
    gtk_list_box_row_set_child(GTK_LIST_BOX_ROW(r), box);
    gtk_list_box_append(GTK_LIST_BOX(app->list), r);
    if (i == app->sel) gtk_list_box_select_row(GTK_LIST_BOX(app->list), GTK_LIST_BOX_ROW(r));
  }
}

static void detail_kv(GtkWidget *box, const char *k, const char *v) {
  GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 10);
  GtkWidget *lk = gtk_label_new(k), *lv = gtk_label_new(v);
  gtk_label_set_xalign(GTK_LABEL(lk), 0);
  gtk_widget_add_css_class(lk, "hint");
  gtk_label_set_xalign(GTK_LABEL(lv), 0);
  gtk_label_set_wrap(GTK_LABEL(lv), TRUE);
  gtk_widget_set_hexpand(lv, TRUE);
  gtk_box_append(GTK_BOX(row), lk);
  gtk_box_append(GTK_BOX(row), lv);
  gtk_box_append(GTK_BOX(box), row);
}

static void refresh_detail(App *app) {
  GtkWidget *c;
  while ((c = gtk_widget_get_first_child(app->detail_box)))
    gtk_box_remove(GTK_BOX(app->detail_box), c);
  Entry *e = selected_entry(app);
  if (!e) {
    GtkWidget *hint = gtk_label_new(t("select_hint"));
    gtk_widget_add_css_class(hint, "hint");
    gtk_box_append(GTK_BOX(app->detail_box), hint);
    return;
  }

  GtkWidget *title = gtk_label_new(e->name ? e->name : e->key);
  gtk_widget_add_css_class(title, "accent");
  gtk_label_set_xalign(GTK_LABEL(title), 0);
  gtk_box_append(GTK_BOX(app->detail_box), title);

  char buf[256];
  detail_kv(app->detail_box, t("type"), e->is_movie ? t("movie") : t("series"));
  detail_kv(app->detail_box, t("status"), e->finished ? t("finished") : t("watching"));
  g_snprintf(buf, sizeof buf, "S%dE%02d", e->season, e->episode + 1);
  detail_kv(app->detail_box, t("episode"), buf);
  int this_season = 0;
  for (int i = 0; i < e->season_count; i++)
    if (e->seasons[i] == e->season) this_season = e->season_counts[i];
  g_snprintf(buf, sizeof buf, "%d %s", this_season, t("episodes"));
  detail_kv(app->detail_box, t("this_season"), buf);
  g_snprintf(buf, sizeof buf, "%d %s", e->total_episodes, t("episodes"));
  detail_kv(app->detail_box, t("total_ep"), buf);
  detail_kv(app->detail_box, t("version"),
            e->variant ? (strcmp(e->variant, "dubbled") == 0 ? t("dubbed") : t("hardsub")) : "—");
  detail_kv(app->detail_box, t("quality"), e->quality ? e->quality : "—");

  GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  GtkWidget *play_btn = gtk_button_new_with_label(t("play"));
  gtk_widget_add_css_class(play_btn, "btn-accent");
  g_signal_connect(play_btn, "clicked", G_CALLBACK(play_selected), app);
  GtkWidget *rm_btn = gtk_button_new_with_label(t("remove"));
  g_signal_connect(rm_btn, "clicked", G_CALLBACK(show_remove_modal), app);
  gtk_box_append(GTK_BOX(actions), play_btn);
  gtk_box_append(GTK_BOX(actions), rm_btn);
  gtk_box_append(GTK_BOX(app->detail_box), actions);

  if (e->overview && *e->overview) {
    GtkWidget *ov = gtk_label_new(e->overview);
    gtk_widget_add_css_class(ov, "desc");
    gtk_label_set_wrap(GTK_LABEL(ov), TRUE);
    gtk_label_set_xalign(GTK_LABEL(ov), 0);
    gtk_box_append(GTK_BOX(app->detail_box), ov);
  }
  if (e->source_url) detail_kv(app->detail_box, "URL", e->source_url);
}

static void refresh_np(App *app) {
  Playback *pb = &app->pb;
  if (!pb->active) {
    gtk_widget_set_visible(app->np_bar, FALSE);
    return;
  }
  gtk_widget_set_visible(app->np_bar, TRUE);
  char buf[256], tt[128];
  if (pb->duration > 0) {
    char *a = fmt_ts(pb->time), *b = fmt_ts(pb->duration);
    g_snprintf(tt, sizeof tt, " %s/%s", a, b);
    g_free(a); g_free(b);
  } else tt[0] = 0;
  g_snprintf(buf, sizeof buf, "%s · S%dE%02d/%d%s", pb->key ? pb->key : "",
             pb->season, pb->episode + 1, pb->total, tt);
  gtk_label_set_text(GTK_LABEL(app->np_title), buf);
}

/* ── toast / modals ────────────────────────────────────────────────────────── */

static gboolean toast_hide(gpointer ud) {
  App *app = ud;
  gtk_widget_set_visible(app->toast, FALSE);
  app->toast_src = 0;
  return G_SOURCE_REMOVE;
}
static void toast(App *app, const char *msg) {
  gtk_label_set_text(GTK_LABEL(app->toast), msg);
  gtk_widget_set_visible(app->toast, TRUE);
  if (app->toast_src) g_source_remove(app->toast_src);
  app->toast_src = g_timeout_add_seconds(4, toast_hide, app);
}

static GtkWidget *make_modal(App *app, const char *title) {
  GtkWidget *w = gtk_window_new();
  gtk_window_set_transient_for(GTK_WINDOW(w), GTK_WINDOW(app->win));
  gtk_window_set_modal(GTK_WINDOW(w), TRUE);
  gtk_window_set_title(GTK_WINDOW(w), title);
  gtk_window_set_default_size(GTK_WINDOW(w), 560, 380);
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
  gtk_widget_set_margin_top(box, 14);
  gtk_widget_set_margin_bottom(box, 14);
  gtk_widget_set_margin_start(box, 16);
  gtk_widget_set_margin_end(box, 16);
  gtk_window_set_child(GTK_WINDOW(w), box);
  gtk_window_present(GTK_WINDOW(w));
  return w;
}
static void close_modal(GtkWidget *w) { gtk_window_close(GTK_WINDOW(w)); }

static void show_season_end_modal(App *app, int season, int count) {
  char title[128];
  g_snprintf(title, sizeof title, "%s %d (%d %s)", t("season_end_title"),
             season, count, t("episodes"));
  GtkWidget *w = make_modal(app, title);
  GtkWidget *box = gtk_window_get_child(GTK_WINDOW(w));
  GtkWidget *lbl = gtk_label_new(t("season_end_body"));
  gtk_label_set_wrap(GTK_LABEL(lbl), TRUE);
  gtk_box_append(GTK_BOX(box), lbl);
  GtkWidget *h = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  gtk_widget_set_halign(h, GTK_ALIGN_END);
  GtkWidget *keep = gtk_button_new_with_label(t("keep"));
  g_signal_connect_swapped(keep, "clicked", G_CALLBACK(close_modal), w);
  GtkWidget *del = gtk_button_new_with_label(t("delete"));
  g_signal_connect_swapped(del, "clicked", G_CALLBACK(close_modal), w);
  gtk_box_append(GTK_BOX(h), keep);
  gtk_box_append(GTK_BOX(h), del);
  gtk_box_append(GTK_BOX(box), h);
  /* after the modal closes, allow a new session */
  g_signal_connect(w, "close-request", G_CALLBACK(season_close_cb), &app->pb);
  (void)count;
}

static gboolean season_close_cb(GtkWidget *w, gpointer ud) {
  Playback *pb = ud;
  (void)w;
  pb_finish_season(pb);
  return FALSE;
}

/* ── remove confirm ────────────────────────────────────────────────────────── */

static void remove_confirm_cb(GtkWidget *w, gpointer ud) {
  App *app = ud;
  Entry *e = selected_entry(app);
  if (!e) return;
  GtkWidget *dlg = g_object_get_data(G_OBJECT(w), "dlg");
  if (dlg) close_modal(dlg);
  char *key = g_strdup(e->key);
  store_remove(&app->store, key);
  store_save(&app->store, app->store_path);
  g_free(key);
  refresh_header(app);
  refresh_list(app);
  refresh_detail(app);
}

static void show_remove_modal(GtkWidget *w, gpointer ud) {
  App *app = ud;
  Entry *e = selected_entry(app);
  if (!e) return;
  GtkWidget *dlg = make_modal(app, t("remove_title"));
  GtkWidget *box = gtk_window_get_child(GTK_WINDOW(dlg));
  char buf[512];
  g_snprintf(buf, sizeof buf, "%s\n%s", e->name ? e->name : e->key, t("remove_body"));
  GtkWidget *lbl = gtk_label_new(buf);
  gtk_label_set_wrap(GTK_LABEL(lbl), TRUE);
  gtk_box_append(GTK_BOX(box), lbl);
  GtkWidget *h = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  gtk_widget_set_halign(h, GTK_ALIGN_END);
  GtkWidget *cancel = gtk_button_new_with_label(t("cancel"));
  g_signal_connect_swapped(cancel, "clicked", G_CALLBACK(close_modal), dlg);
  GtkWidget *rm = gtk_button_new_with_label(t("remove"));
  g_object_set_data(G_OBJECT(rm), "dlg", dlg);
  g_signal_connect(rm, "clicked", G_CALLBACK(remove_confirm_cb), app);
  gtk_box_append(GTK_BOX(h), cancel);
  gtk_box_append(GTK_BOX(h), rm);
  gtk_box_append(GTK_BOX(box), h);
}

/* ── add flow ──────────────────────────────────────────────────────────────── */

typedef struct { App *app; char *url; } FetchJob;
typedef struct { App *app; ScrapeInfo *info; } FetchDone;

static gboolean fetch_done_idle(gpointer data) {
  FetchDone *fd = data;
  App *app = fd->app;
  if (fd->info->ok) show_options_modal(app, fd->info);
  else toast(app, t("cannot_read"));
  g_free(fd);
  return G_SOURCE_REMOVE;
}
static gpointer fetch_thread(gpointer data) {
  FetchJob *job = data;
  ScrapeInfo *info = scrape_fetch(job->url);
  FetchDone *fd = g_new0(FetchDone, 1);
  fd->app = job->app;
  fd->info = info;
  g_free(job->url);
  g_free(job);
  g_idle_add_full(G_PRIORITY_DEFAULT_IDLE, fetch_done_idle, fd, g_free);
  return NULL;
}
static void on_fetch_clicked(GtkWidget *w, gpointer ud) {
  App *app = ud;
  GtkWidget *dlg = g_object_get_data(G_OBJECT(w), "dlg");
  if (!dlg) return;
  GtkWidget *entry = g_object_get_data(G_OBJECT(dlg), "url_entry");
  const char *url = gtk_editable_get_text(GTK_EDITABLE(entry));
  if (!url || !*url) return;
  gtk_widget_set_sensitive(dlg, FALSE);
  FetchJob *job = g_new0(FetchJob, 1);
  job->app = app;
  job->url = g_strdup(url);
  g_thread_new("scrape", fetch_thread, job);
}

static void show_add_modal(GtkWidget *w, gpointer ud) {
  App *app = ud;
  GtkWidget *dlg = make_modal(app, t("add_title"));
  GtkWidget *box = gtk_window_get_child(GTK_WINDOW(dlg));
  GtkWidget *lbl = gtk_label_new(t("add_label"));
  gtk_label_set_xalign(GTK_LABEL(lbl), 0);
  GtkWidget *entry = gtk_entry_new();
  gtk_entry_set_placeholder_text(GTK_ENTRY(entry), "https://www.myf2m.org/series/...");
  g_object_set_data(G_OBJECT(dlg), "url_entry", entry);
  GtkWidget *h = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  gtk_widget_set_halign(h, GTK_ALIGN_END);
  GtkWidget *cancel = gtk_button_new_with_label(t("cancel"));
  g_signal_connect_swapped(cancel, "clicked", G_CALLBACK(close_modal), dlg);
  GtkWidget *fetch = gtk_button_new_with_label(t("fetch"));
  gtk_widget_add_css_class(fetch, "btn-accent");
  g_object_set_data(G_OBJECT(fetch), "dlg", dlg);
  g_signal_connect(fetch, "clicked", G_CALLBACK(on_fetch_clicked), app);
  gtk_box_append(GTK_BOX(h), cancel);
  gtk_box_append(GTK_BOX(h), fetch);
  gtk_box_append(GTK_BOX(box), lbl);
  gtk_box_append(GTK_BOX(box), entry);
  gtk_box_append(GTK_BOX(box), h);
  gtk_widget_grab_focus(entry);
}

/* ── options modal ─────────────────────────────────────────────────────────── */

typedef struct {
  App *app;
  GtkWidget *dlg;
  ScrapeInfo *info;
  char *variant;
  char *quality;
  char *name;
  GArray *v_btns;
  GArray *q_btns;
  GArray *v_idx;
  GArray *q_idx;
  GtkWidget *name_entry;
  int closed;
} Opt;

static void opt_close(Opt *o) {
  if (o->closed) return;
  o->closed = 1;
  close_modal(o->dlg);
  scrape_free(o->info);
  g_array_free(o->v_btns, TRUE);
  g_array_free(o->q_btns, TRUE);
  g_array_free(o->v_idx, TRUE);
  g_array_free(o->q_idx, TRUE);
  g_free(o->variant);
  g_free(o->quality);
  g_free(o->name);
  g_free(o);
}
static void opt_close_cb(GtkWidget *w, gpointer ud) { (void)w; opt_close(ud); }

static void opt_paint_variant(Opt *o) {
  if (o->v_btns->len == 0) return;
  for (guint i = 0; i < o->v_btns->len; i++)
    gtk_widget_remove_css_class(g_array_index(o->v_btns, GtkWidget *, i), "btn-accent");
  gtk_widget_add_css_class(g_array_index(o->v_btns, GtkWidget *, 0), "btn-accent");
}
static void opt_v_toggled(GtkToggleButton *tb, gpointer ud) {
  Opt *o = ud;
  if (!gtk_toggle_button_get_active(tb)) return;
  for (guint i = 0; i < o->v_idx->len; i++) {
    if (g_array_index(o->v_btns, GtkWidget *, i) == (GtkWidget *)tb) {
      g_free(o->variant);
      o->variant = g_strdup(o->info->variants[g_array_index(o->v_idx, guint, i)]);
      break;
    }
  }
  opt_paint_variant(o);
}
static void opt_paint_quality(Opt *o) {
  if (o->q_btns->len == 0) return;
  for (guint i = 0; i < o->q_btns->len; i++)
    gtk_widget_remove_css_class(g_array_index(o->q_btns, GtkWidget *, i), "btn-accent");
  gtk_widget_add_css_class(g_array_index(o->q_btns, GtkWidget *, 0), "btn-accent");
}
static void opt_q_toggled(GtkToggleButton *tb, gpointer ud) {
  Opt *o = ud;
  if (!gtk_toggle_button_get_active(tb)) return;
  for (guint i = 0; i < o->q_idx->len; i++) {
    if (g_array_index(o->q_btns, GtkWidget *, i) == (GtkWidget *)tb) {
      g_free(o->quality);
      o->quality = g_strdup(o->info->qualities[g_array_index(o->q_idx, guint, i)]);
      break;
    }
  }
  opt_paint_quality(o);
}

static void opt_play_clicked(GtkWidget *w, gpointer ud) {
  Opt *o = ud;
  App *app = o->app;
  const char *cn = gtk_editable_get_text(GTK_EDITABLE(o->name_entry));
  if (cn && *cn) {
    g_free(o->name);
    o->name = g_strdup(cn);
  }
  char *key = g_ascii_strdown(o->name, -1);
  for (char *p = key; *p; p++) if (*p == ' ') *p = '_';
  int n = 0;
  char **urls = scrape_select(o->info, o->variant, o->quality, &n);
  if (n > 0) {
    Entry *e = entry_new();
    e->key = key;
    e->name = g_strdup(o->name);
    e->url = g_strdup(urls[0]);
    e->is_movie = o->info->is_movie;
    e->source_url = g_strdup(o->info->url);
    e->variant = g_strdup(o->variant);
    e->quality = g_strdup(o->quality);
    e->overview = o->info->description ? g_strdup(o->info->description) : NULL;
    e->poster = o->info->poster ? g_strdup(o->info->poster) : NULL;
    e->season = o->info->season_count > 0 ? o->info->seasons[0] : 1;
    e->episode = 0;
    e->manual_urls = g_new(char *, n);
    e->manual_urls_len = n;
    for (int i = 0; i < n; i++) e->manual_urls[i] = urls[i];
    g_free(urls);
    entry_compute_summaries(e);
    store_upsert(&app->store, e);
    store_save(&app->store, app->store_path);
    refresh_header(app);
    refresh_list(app);
    refresh_detail(app);
    opt_close(o);
    pb_start(&app->pb, e, e->season);
  } else {
    g_free(key);
    g_strfreev(urls);
    toast(app, t("cannot_read"));
  }
}

static void show_options_modal(App *app, ScrapeInfo *info) {
  char *slugkey = key_from_url(info->url);
  char *default_name = pretty_key(slugkey);
  g_free(slugkey);

  Opt *o = g_new0(Opt, 1);
  o->app = app;
  o->info = info;
  o->name = default_name;
  int has_hard = 0, has_720 = 0;
  for (int i = 0; i < info->variants_len; i++)
    if (strcmp(info->variants[i], "hardsub") == 0) has_hard = 1;
  for (int i = 0; i < info->qualities_len; i++)
    if (strcmp(info->qualities[i], "720p") == 0) has_720 = 1;
  o->variant = g_strdup(has_hard || info->variants_len == 0 ? "hardsub" : info->variants[0]);
  o->quality = g_strdup(has_720 || info->qualities_len == 0 ? "720p" : info->qualities[0]);
  o->v_btns = g_array_new(FALSE, FALSE, sizeof(GtkWidget *));
  o->q_btns = g_array_new(FALSE, FALSE, sizeof(GtkWidget *));
  o->v_idx = g_array_new(FALSE, FALSE, sizeof(guint));
  o->q_idx = g_array_new(FALSE, FALSE, sizeof(guint));

  GtkWidget *dlg = make_modal(app, info->title && *info->title ? info->title : o->name);
  o->dlg = dlg;
  GtkWidget *box = gtk_window_get_child(GTK_WINDOW(dlg));
  g_signal_connect(dlg, "close-request", G_CALLBACK(opt_close_cb), o);

  if (info->description && *info->description) {
    GtkWidget *desc = gtk_label_new(info->description);
    gtk_label_set_wrap(GTK_LABEL(desc), TRUE);
    gtk_label_set_max_width_chars(GTK_LABEL(desc), 60);
    gtk_widget_add_css_class(desc, "hint");
    gtk_box_append(GTK_BOX(box), desc);
  }

  GtkWidget *vl = gtk_label_new(t("version"));
  gtk_label_set_xalign(GTK_LABEL(vl), 0);
  GtkWidget *vrow = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  gtk_box_append(GTK_BOX(box), vl);
  gtk_box_append(GTK_BOX(box), vrow);
  for (int i = 0; i < info->variants_len; i++) {
    const char *lbl = strcmp(info->variants[i], "dubbled") == 0 ? t("dubbed") : t("hardsub");
    GtkWidget *b = gtk_toggle_button_new_with_label(lbl);
    guint vi = (guint)i;
    g_array_append_val(o->v_btns, b);
    g_array_append_val(o->v_idx, vi);
    g_signal_connect(b, "toggled", G_CALLBACK(opt_v_toggled), o);
    gtk_box_append(GTK_BOX(vrow), b);
  }
  opt_paint_variant(o);

  GtkWidget *ql = gtk_label_new(t("quality"));
  gtk_label_set_xalign(GTK_LABEL(ql), 0);
  GtkWidget *qrow = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  gtk_box_append(GTK_BOX(box), ql);
  gtk_box_append(GTK_BOX(box), qrow);
  for (int i = 0; i < info->qualities_len; i++) {
    GtkWidget *b = gtk_toggle_button_new_with_label(info->qualities[i]);
    guint qi = (guint)i;
    g_array_append_val(o->q_btns, b);
    g_array_append_val(o->q_idx, qi);
    g_signal_connect(b, "toggled", G_CALLBACK(opt_q_toggled), o);
    gtk_box_append(GTK_BOX(qrow), b);
  }
  opt_paint_quality(o);

  char cc[256];
  g_snprintf(cc, sizeof cc, "%s %d %s", t("total_line"), info->total_episodes, t("episodes"));
  GtkWidget *lc = gtk_label_new(cc);
  gtk_label_set_xalign(GTK_LABEL(lc), 0);
  gtk_box_append(GTK_BOX(box), lc);
  if (info->is_movie) {
    GtkWidget *lm = gtk_label_new(t("movie"));
    gtk_label_set_xalign(GTK_LABEL(lm), 0);
    gtk_box_append(GTK_BOX(box), lm);
  }

  GtkWidget *nl = gtk_label_new(t("name"));
  gtk_label_set_xalign(GTK_LABEL(nl), 0);
  GtkWidget *ne = gtk_entry_new();
  gtk_editable_set_text(GTK_EDITABLE(ne), o->name);
  o->name_entry = ne;
  gtk_box_append(GTK_BOX(box), nl);
  gtk_box_append(GTK_BOX(box), ne);

  GtkWidget *h = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  gtk_widget_set_halign(h, GTK_ALIGN_END);
  GtkWidget *cancel = gtk_button_new_with_label(t("cancel"));
  g_signal_connect(cancel, "clicked", G_CALLBACK(opt_close_cb), o);
  GtkWidget *play = gtk_button_new_with_label(t("play"));
  gtk_widget_add_css_class(play, "btn-accent");
  g_signal_connect(play, "clicked", G_CALLBACK(opt_play_clicked), o);
  gtk_box_append(GTK_BOX(h), cancel);
  gtk_box_append(GTK_BOX(h), play);
  gtk_box_append(GTK_BOX(box), h);
  gtk_widget_grab_focus(ne);
}

/* ── play ──────────────────────────────────────────────────────────────────── */

static void play_selected(GtkWidget *w, gpointer ud) {
  App *app = ud;
  Entry *e = selected_entry(app);
  if (e) pb_start(&app->pb, e, e->season);
}
static void play_selected_key(App *app) {
  Entry *e = selected_entry(app);
  if (e) pb_start(&app->pb, e, e->season);
}

static void on_pause(GtkWidget *w, gpointer ud) { pb_pause(&((App *)ud)->pb); }
static void on_next(GtkWidget *w, gpointer ud) { pb_next(&((App *)ud)->pb); }
static void on_stop(GtkWidget *w, gpointer ud) { pb_stop(&((App *)ud)->pb); }

/* ── search ────────────────────────────────────────────────────────────────── */

static void on_search_changed(GtkEditable *ed, gpointer ud) {
  App *app = ud;
  g_free(app->filter);
  app->filter = g_strdup(gtk_editable_get_text(ed));
  app->sel = 0;
  refresh_list(app);
}

static void on_row_selected(GtkListBox *lb, GtkListBoxRow *row, gpointer ud) {
  App *app = ud;
  if (!row) return;
  app->sel = gtk_list_box_row_get_index(row);
  refresh_detail(app);
}

/* ── keyboard ──────────────────────────────────────────────────────────────── */

static gboolean on_key(GtkEventControllerKey *c, guint keyval, guint keycode,
                       GdkModifierType state, gpointer ud) {
  App *app = ud;
  (void)c; (void)keycode; (void)state;
  GtkWidget *focus = gtk_window_get_focus(GTK_WINDOW(app->win));
  if (focus && GTK_IS_ENTRY(focus)) return FALSE;
  switch (keyval) {
    case GDK_KEY_Down:
    case GDK_KEY_j:
      if (app->sel < app->visible_len - 1) { app->sel++; goto selectrow; }
      return TRUE;
    case GDK_KEY_Up:
    case GDK_KEY_k:
      if (app->sel > 0) { app->sel--; goto selectrow; }
      return TRUE;
    case GDK_KEY_Return:
      play_selected_key(app);
      return TRUE;
    case GDK_KEY_slash:
      gtk_widget_grab_focus(app->search);
      return TRUE;
    case GDK_KEY_n:
      show_add_modal(NULL, app);
      return TRUE;
  }
  return FALSE;
selectrow:
  {
    GtkListBoxRow *r = gtk_list_box_get_row_at_index(GTK_LIST_BOX(app->list), app->sel);
    if (r) gtk_list_box_select_row(GTK_LIST_BOX(app->list), r);
    refresh_detail(app);
  }
  return TRUE;
}

/* ── lang toggles ──────────────────────────────────────────────────────────── */

static void on_lang_en(GtkToggleButton *b, gpointer ud) {
  App *app = ud;
  if (gtk_toggle_button_get_active(b)) set_lang(app, 0);
}
static void on_lang_fa(GtkToggleButton *b, gpointer ud) {
  App *app = ud;
  if (gtk_toggle_button_get_active(b)) set_lang(app, 1);
}

/* ── app lifecycle ─────────────────────────────────────────────────────────── */

static void activate(GtkApplication *gapp, gpointer ud) {
  (void)ud;
  load_css();
  curl_global_init(CURL_GLOBAL_DEFAULT);

  App *app = g_new0(App, 1);
  g_app = app;
  const char *base = g_get_user_data_dir();
  app->store_path = g_build_filename(base, "player", "progress.json", NULL);
  store_init(&app->store);
  app->filter = g_strdup("");
  store_load(&app->store, app->store_path);

  pb_init(&app->pb);
  app->pb.cb.ud = app;
  app->pb.cb.on_state = ui_refresh_np;
  app->pb.cb.on_save = ui_save;
  app->pb.cb.on_season_end = ui_season_end;
  app->pb.cb.on_stopped = ui_stopped;

  app->win = gtk_application_window_new(gapp);
  gtk_window_set_title(GTK_WINDOW(app->win), "player");
  gtk_window_set_default_size(GTK_WINDOW(app->win), 1100, 720);

  GtkWidget *root = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  gtk_window_set_child(GTK_WINDOW(app->win), root);

  GtkWidget *header = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);
  gtk_widget_set_name(header, "header");
  gtk_widget_set_margin_start(header, 12);
  gtk_widget_set_margin_end(header, 12);
  gtk_widget_set_margin_top(header, 6);
  gtk_widget_set_margin_bottom(header, 6);
  GtkWidget *brand = gtk_label_new("🎬 player");
  gtk_widget_add_css_class(brand, "accent");
  app->header_total = gtk_label_new("");
  gtk_widget_add_css_class(app->header_total, "hint");
  gtk_widget_set_hexpand(app->header_total, TRUE);
  GtkWidget *langbox = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  GtkWidget *be = gtk_toggle_button_new_with_label("EN");
  GtkWidget *bf = gtk_toggle_button_new_with_label("فا");
  gtk_widget_add_css_class(be, "lang");
  gtk_widget_add_css_class(bf, "lang");
  gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(be), TRUE);
  g_signal_connect(be, "toggled", G_CALLBACK(on_lang_en), app);
  g_signal_connect(bf, "toggled", G_CALLBACK(on_lang_fa), app);
  gtk_box_append(GTK_BOX(langbox), be);
  gtk_box_append(GTK_BOX(langbox), bf);
  app->search = gtk_entry_new();
  gtk_entry_set_placeholder_text(GTK_ENTRY(app->search), t("search"));
  gtk_widget_set_size_request(app->search, 220, -1);
  g_signal_connect(app->search, "changed", G_CALLBACK(on_search_changed), app);
  gtk_box_append(GTK_BOX(header), brand);
  gtk_box_append(GTK_BOX(header), app->header_total);
  gtk_box_append(GTK_BOX(header), langbox);
  gtk_box_append(GTK_BOX(header), app->search);
  gtk_box_append(GTK_BOX(root), header);

  GtkWidget *main = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_set_hexpand(main, TRUE);
  gtk_widget_set_vexpand(main, TRUE);

  GtkWidget *listpanel = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  gtk_widget_set_name(listpanel, "listpanel");
  gtk_widget_set_size_request(listpanel, 340, -1);
  GtkWidget *scroll = gtk_scrolled_window_new();
  gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroll), GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
  gtk_widget_set_vexpand(scroll, TRUE);
  app->list = gtk_list_box_new();
  gtk_list_box_set_selection_mode(GTK_LIST_BOX(app->list), GTK_SELECTION_SINGLE);
  g_signal_connect(app->list, "row-selected", G_CALLBACK(on_row_selected), app);
  gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scroll), app->list);
  GtkWidget *add_btn = gtk_button_new_with_label(t("add"));
  gtk_widget_add_css_class(add_btn, "btn-accent");
  g_signal_connect(add_btn, "clicked", G_CALLBACK(show_add_modal), app);
  gtk_box_append(GTK_BOX(listpanel), scroll);
  gtk_box_append(GTK_BOX(listpanel), add_btn);
  gtk_box_append(GTK_BOX(main), listpanel);

  GtkWidget *dscroll = gtk_scrolled_window_new();
  gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(dscroll), GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
  GtkWidget *dbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
  gtk_widget_set_margin_start(dbox, 16);
  gtk_widget_set_margin_end(dbox, 16);
  gtk_widget_set_margin_top(dbox, 12);
  gtk_widget_set_margin_bottom(dbox, 12);
  gtk_widget_set_hexpand(dbox, TRUE);
  app->detail_box = dbox;
  gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(dscroll), dbox);
  gtk_box_append(GTK_BOX(main), dscroll);
  gtk_box_append(GTK_BOX(root), main);

  app->np_bar = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  gtk_widget_set_name(app->np_bar, "np");
  gtk_widget_set_margin_start(app->np_bar, 12);
  gtk_widget_set_margin_end(app->np_bar, 12);
  gtk_widget_set_visible(app->np_bar, FALSE);
  app->np_title = gtk_label_new("");
  gtk_widget_set_hexpand(app->np_title, TRUE);
  app->np_pause = gtk_button_new_with_label(t("pause"));
  app->np_next = gtk_button_new_with_label(t("next"));
  app->np_stop = gtk_button_new_with_label(t("stop"));
  g_signal_connect(app->np_pause, "clicked", G_CALLBACK(on_pause), app);
  g_signal_connect(app->np_next, "clicked", G_CALLBACK(on_next), app);
  g_signal_connect(app->np_stop, "clicked", G_CALLBACK(on_stop), app);
  gtk_box_append(GTK_BOX(app->np_bar), app->np_title);
  gtk_box_append(GTK_BOX(app->np_bar), app->np_pause);
  gtk_box_append(GTK_BOX(app->np_bar), app->np_next);
  gtk_box_append(GTK_BOX(app->np_bar), app->np_stop);
  gtk_box_append(GTK_BOX(root), app->np_bar);

  GtkWidget *footer = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_set_name(footer, "footer");
  app->footer = gtk_label_new(t("footer"));
  gtk_widget_add_css_class(app->footer, "hint");
  gtk_widget_set_margin_start(app->footer, 12);
  gtk_box_append(GTK_BOX(footer), app->footer);
  app->toast = gtk_label_new("");
  gtk_widget_set_margin_start(app->toast, 24);
  gtk_widget_set_visible(app->toast, FALSE);
  gtk_box_append(GTK_BOX(footer), app->toast);
  gtk_box_append(GTK_BOX(root), footer);

  GtkEventController *kc = gtk_event_controller_key_new();
  g_signal_connect(kc, "key-pressed", G_CALLBACK(on_key), app);
  gtk_widget_add_controller(app->win, kc);

  refresh_header(app);
  refresh_list(app);
  refresh_detail(app);
  gtk_window_present(GTK_WINDOW(app->win));
}

int main(int argc, char **argv) {
  GtkApplication *app = gtk_application_new("com.player.gui", G_APPLICATION_DEFAULT_FLAGS);
  g_signal_connect(app, "activate", G_CALLBACK(activate), NULL);
  int status = g_application_run(G_APPLICATION(app), argc, argv);
  g_object_unref(app);
  return status;
}
#include "jmini.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

static JVal *jv_new(JType t) {
  JVal *v = calloc(1, sizeof(JVal));
  v->t = t;
  return v;
}

JVal *jv_obj(void) { return jv_new(J_OBJ); }
JVal *jv_arr(void) { return jv_new(J_ARR); }

JVal *jv_str(const char *s) {
  JVal *v = jv_new(J_STR);
  v->s = s ? strdup(s) : NULL;
  return v;
}
JVal *jv_num(double n) { JVal *v = jv_new(J_NUM); v->num = n; return v; }
JVal *jv_bool(int b) { JVal *v = jv_new(J_BOOL); v->b = !!b; return v; }

void jv_free(JVal *v) {
  if (!v) return;
  if (v->t == J_STR) { free(v->s); v->s = NULL; }
  if (v->a) {
    for (int i = 0; i < v->n; i++) jv_free(v->a[i]);
    free(v->a);
    v->a = NULL;
  }
  v->n = 0;
  free(v);
}

static void jv_grow(JVal *v, int extra) {
  v->a = realloc(v->a, (v->n + extra) * sizeof(JVal *));
}

int jv_push(JVal *arr, JVal *val) {
  if (!arr || arr->t != J_ARR) return 0;
  jv_grow(arr, 1);
  arr->a[arr->n++] = val;
  return 1;
}

int jv_set(JVal *obj, const char *key, JVal *val) {
  if (!obj || obj->t != J_OBJ) return 0;
  jv_grow(obj, 2);
  obj->a[obj->n++] = jv_str(key);
  obj->a[obj->n++] = val;
  return 1;
}

JVal *jv_get(const JVal *obj, const char *key) {
  if (!obj || obj->t != J_OBJ) return NULL;
  for (int i = 0; i + 1 < obj->n; i += 2) {
    if (obj->a[i] && obj->a[i]->t == J_STR && obj->a[i]->s &&
        strcmp(obj->a[i]->s, key) == 0)
      return obj->a[i + 1];
  }
  return NULL;
}

/* ─── Parser ─────────────────────────────────────────────────────────────── */

typedef struct { const char *p; } P;

static void skip_ws(P *p) {
  while (*p->p == ' ' || *p->p == '\t' || *p->p == '\n' || *p->p == '\r')
    p->p++;
}

static int radix4(const char *s) {
  int v = 0;
  for (int i = 0; i < 4; i++) {
    char c = s[i];
    v <<= 4;
    if (c >= '0' && c <= '9') v |= c - '0';
    else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
    else return -1;
  }
  return v;
}

static void utf8_append(char **out, size_t *len, size_t *cap, unsigned codepoint) {
  char buf[4];
  int n;
  if (codepoint < 0x80) { buf[0] = (char)codepoint; n = 1; }
  else if (codepoint < 0x800) {
    buf[0] = (char)(0xC0 | (codepoint >> 6));
    buf[1] = (char)(0x80 | (codepoint & 0x3F)); n = 2;
  } else if (codepoint < 0x10000) {
    buf[0] = (char)(0xE0 | (codepoint >> 12));
    buf[1] = (char)(0x80 | ((codepoint >> 6) & 0x3F));
    buf[2] = (char)(0x80 | (codepoint & 0x3F)); n = 3;
  } else {
    buf[0] = (char)(0xF0 | (codepoint >> 18));
    buf[1] = (char)(0x80 | ((codepoint >> 12) & 0x3F));
    buf[2] = (char)(0x80 | ((codepoint >> 6) & 0x3F));
    buf[3] = (char)(0x80 | (codepoint & 0x3F)); n = 4;
  }
  if (*len + n + 1 > *cap) { *cap = (*cap ? *cap * 2 : 64); while (*len + n + 1 > *cap) *cap *= 2; *out = realloc(*out, *cap); }
  memcpy(*out + *len, buf, n);
  *len += n;
  (*out)[*len] = 0;
}

static JVal *parse_value(P *p);

static JVal *parse_string(P *p) {
  if (*p->p != '"') return NULL;
  p->p++;
  char *out = NULL; size_t len = 0, cap = 0;
  while (*p->p && *p->p != '"') {
    char c = *p->p;
    if (c == '\\') {
      p->p++;
      char e = *p->p;
      switch (e) {
        case '"': utf8_append(&out, &len, &cap, '"'); break;
        case '\\': utf8_append(&out, &len, &cap, '\\'); break;
        case '/': utf8_append(&out, &len, &cap, '/'); break;
        case 'b': utf8_append(&out, &len, &cap, 8); break;
        case 'f': utf8_append(&out, &len, &cap, 12); break;
        case 'n': utf8_append(&out, &len, &cap, 10); break;
        case 'r': utf8_append(&out, &len, &cap, 13); break;
        case 't': utf8_append(&out, &len, &cap, 9); break;
        case 'u': {
          int cp = radix4(p->p + 1);
          if (cp < 0) { free(out); return NULL; }
          p->p += 4;
          /* surrogate pair */
          if (cp >= 0xD800 && cp <= 0xDBFF && p->p[1] == '\\' && p->p[2] == 'u') {
            int lo = radix4(p->p + 3);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
              p->p += 6;
            }
          }
          utf8_append(&out, &len, &cap, (unsigned)cp);
          break;
        }
        default: free(out); return NULL;
      }
    } else {
      utf8_append(&out, &len, &cap, (unsigned char)c);
    }
    p->p++;
  }
  if (*p->p != '"') { free(out); return NULL; }
  p->p++;
  JVal *v = jv_str(out ? out : "");
  free(out);
  return v;
}

static JVal *parse_number(P *p) {
  const char *start = p->p;
  if (*p->p == '-') p->p++;
  while ((*p->p >= '0' && *p->p <= '9') || *p->p == '.' || *p->p == 'e' || *p->p == 'E' || *p->p == '+' || *p->p == '-') p->p++;
  if (p->p == start) return NULL;
  char buf[64];
  size_t n = (size_t)(p->p - start);
  if (n >= sizeof(buf)) n = sizeof(buf) - 1;
  memcpy(buf, start, n);
  buf[n] = 0;
  return jv_num(atof(buf));
}

static JVal *parse_array(P *p) {
  p->p++; /* [ */
  JVal *arr = jv_arr();
  skip_ws(p);
  if (*p->p == ']') { p->p++; return arr; }
  while (*p->p) {
    skip_ws(p);
    JVal *v = parse_value(p);
    if (!v) { jv_free(arr); return NULL; }
    jv_push(arr, v);
    skip_ws(p);
    if (*p->p == ',') { p->p++; continue; }
    if (*p->p == ']') { p->p++; return arr; }
    jv_free(arr);
    return NULL;
  }
  jv_free(arr);
  return NULL;
}

static JVal *parse_object(P *p) {
  p->p++; /* { */
  JVal *obj = jv_obj();
  skip_ws(p);
  if (*p->p == '}') { p->p++; return obj; }
  while (*p->p) {
    skip_ws(p);
    JVal *key = parse_string(p);
    if (!key) { jv_free(obj); return NULL; }
    skip_ws(p);
    if (*p->p != ':') { jv_free(key); jv_free(obj); return NULL; }
    p->p++;
    skip_ws(p);
    JVal *val = parse_value(p);
    if (!val) { jv_free(key); jv_free(obj); return NULL; }
    jv_set(obj, key->s, val);
    jv_free(key);
    skip_ws(p);
    if (*p->p == ',') { p->p++; continue; }
    if (*p->p == '}') { p->p++; return obj; }
    jv_free(obj);
    return NULL;
  }
  jv_free(obj);
  return NULL;
}

static JVal *parse_value(P *p) {
  skip_ws(p);
  if (!*p->p) return NULL;
  char c = *p->p;
  if (c == '{') return parse_object(p);
  if (c == '[') return parse_array(p);
  if (c == '"') return parse_string(p);
  if (c == 't') { if (strncmp(p->p, "true", 4) == 0) { p->p += 4; return jv_bool(1); } return NULL; }
  if (c == 'f') { if (strncmp(p->p, "false", 5) == 0) { p->p += 5; return jv_bool(0); } return NULL; }
  if (c == 'n') { if (strncmp(p->p, "null", 4) == 0) { p->p += 4; return jv_new(J_NULL); } return NULL; }
  if (c == '-' || (c >= '0' && c <= '9')) return parse_number(p);
  return NULL;
}

JVal *jparse(const char *text) {
  if (!text) return NULL;
  P p = { text };
  JVal *v = parse_value(&p);
  if (!v) return NULL;
  skip_ws(&p);
  if (*p.p) { jv_free(v); return NULL; }
  return v;
}

/* ─── Serializer ──────────────────────────────────────────────────────────── */

typedef struct { char *buf; size_t len, cap; } B;

static void b_put(B *b, const char *s) { size_t n = strlen(s); if (b->len + n + 1 > b->cap) { b->cap = b->cap ? b->cap : 256; while (b->len + n + 1 > b->cap) b->cap *= 2; b->buf = realloc(b->buf, b->cap); } memcpy(b->buf + b->len, s, n); b->len += n; b->buf[b->len] = 0; }

static void dump(B *b, const JVal *v) {
  char tmp[64];
  switch (v->t) {
    case J_NULL: b_put(b, "null"); break;
    case J_BOOL: b_put(b, v->b ? "true" : "false"); break;
    case J_NUM:
      if (v->num == (double)(long long)v->num && fabs(v->num) < 1e15) snprintf(tmp, sizeof tmp, "%lld", (long long)v->num);
      else snprintf(tmp, sizeof tmp, "%.17g", v->num);
      b_put(b, tmp);
      break;
    case J_STR: {
      b_put(b, "\"");
      for (const char *s = v->s ? v->s : ""; *s; s++) {
        unsigned char c = (unsigned char)*s;
        switch (c) {
          case '"': b_put(b, "\\\""); break;
          case '\\': b_put(b, "\\\\"); break;
          case '\n': b_put(b, "\\n"); break;
          case '\t': b_put(b, "\\t"); break;
          case '\r': b_put(b, "\\r"); break;
          default:
            if (c < 0x20) { snprintf(tmp, sizeof tmp, "\\u%04x", c); b_put(b, tmp); }
            else { tmp[0] = (char)c; tmp[1] = 0; b_put(b, tmp); }
        }
      }
      b_put(b, "\"");
      break;
    }
    case J_ARR: {
      b_put(b, "[");
      for (int i = 0; i < v->n; i++) { if (i) b_put(b, ","); dump(b, v->a[i]); }
      b_put(b, "]");
      break;
    }
    case J_OBJ: {
      b_put(b, "{");
      for (int i = 0; i < v->n; i += 2) {
        if (i) b_put(b, ",");
        dump(b, v->a[i]);
        b_put(b, ":");
        if (i + 1 < v->n) dump(b, v->a[i + 1]); else b_put(b, "null");
      }
      b_put(b, "}");
      break;
    }
  }
}

char *jdump(const JVal *v) {
  if (!v) return strdup("null");
  B b = {0};
  dump(&b, v);
  return b.buf ? b.buf : strdup("");
}
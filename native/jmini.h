#ifndef JMINI_H
#define JMINI_H

/* Minimal JSON parser/serializer (no external deps). Objects store key/value
 * pairs as items[i] = key (JVal string), items[i+1] = value. */

typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } JType;

typedef struct JVal {
  JType t;
  int b;
  double num;
  char *s;          /* string value */
  struct JVal **a;  /* array items / object pairs */
  int n;
} JVal;

JVal *jv_obj(void);
JVal *jv_arr(void);
JVal *jv_str(const char *s);
JVal *jv_num(double n);
JVal *jv_bool(int b);
void jv_free(JVal *v);

/* Object helpers */
int jv_set(JVal *obj, const char *key, JVal *val);   /* takes ownership */
JVal *jv_get(const JVal *obj, const char *key);

/* Array helper */
int jv_push(JVal *arr, JVal *val);

/* Parse / serialize */
JVal *jparse(const char *text);
char *jdump(const JVal *v); /* malloc'd */

#endif
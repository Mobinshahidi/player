CC ?= cc
PKGS = gtk4 libcurl glib-2.0 gio-2.0
CFLAGS ?= -O2 -Wall -Wextra
CFLAGS += $(shell pkg-config --cflags $(PKGS))
LIBS = $(shell pkg-config --libs $(PKGS))
TARGET = player
OBJS = jmini.o store.o scrape.o play.o main.o

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(CFLAGS) -o $@ $(OBJS) $(LIBS)

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJS) $(TARGET)

test-parse: scrape.o jmini.o test_parse.o
	$(CC) $(CFLAGS) -o $@ scrape.o jmini.o test_parse.o $(LIBS)

check: test-parse
	./test-parse tests/series-test.html "https://x/series/show/" | grep -q "total=2"
	./test-parse tests/series-test.html "https://x/series/show/" | grep -q "is_movie=0"
	./test-parse tests/movie-test.html "https://x/movie/" | grep -q "is_movie=1"
	./test-parse tests/movie-test.html "https://x/movie/" | grep -q "total=1"
	@echo "native parser checks passed"

.PHONY: all clean check
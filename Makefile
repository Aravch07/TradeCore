# TradeCore backend - pure C11, no external libraries.
# Works with clang (macOS default) and gcc (Linux).

CC      ?= cc
CFLAGS  ?= -std=c11 -O2 -Wall -Wextra -Wpedantic -Wshadow
DEFS    := -D_POSIX_C_SOURCE=200809L -D_DARWIN_C_SOURCE
LDLIBS  += -lm

CORE := src/trace.c src/order_list.c src/avl.c src/hashmap.c src/vec.c \
        src/engine.c src/reference.c src/scenario.c
SERVER := $(CORE) src/json.c src/api.c src/server.c

.PHONY: all test asan bench run clean

all: build/tradecore build/test_engine build/bench

build:
	mkdir -p build

build/tradecore: $(SERVER) src/*.h | build
	$(CC) $(CFLAGS) $(DEFS) -o $@ $(SERVER) $(LDLIBS)

build/test_engine: $(CORE) src/json.c tests/test_engine.c src/*.h | build
	$(CC) $(CFLAGS) $(DEFS) -o $@ $(CORE) src/json.c tests/test_engine.c $(LDLIBS)

build/bench: $(CORE) bench/bench.c src/*.h | build
	$(CC) $(CFLAGS) $(DEFS) -o $@ $(CORE) bench/bench.c $(LDLIBS)

test: build/test_engine
	./build/test_engine

# AddressSanitizer + UndefinedBehaviorSanitizer: catches leaks, use-after-free,
# buffer overflows and integer overflow while the tests run.
asan: | build
	$(CC) -std=c11 -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer \
	  $(DEFS) -Wall -Wextra \
	  -o build/test_engine_asan $(CORE) src/json.c tests/test_engine.c $(LDLIBS)
	./build/test_engine_asan

bench: build/bench
	./build/bench

run: build/tradecore
	./build/tradecore --port 8080 --static frontend

clean:
	rm -rf build

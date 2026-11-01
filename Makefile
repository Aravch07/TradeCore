CC ?= cc
CFLAGS = -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror -Iinclude
.PHONY: all test wasm clean
all: build/tradecore build/tradecore-server
build:
	mkdir -p build
build/tradecore: src/engine.c src/cli.c include/tradecore.h | build
	$(CC) $(CFLAGS) src/engine.c src/cli.c -o $@
build/tradecore-server: src/server.c | build
	$(CC) $(CFLAGS) src/server.c -o $@
build/test-engine: src/engine.c tests/test_engine.c include/tradecore.h | build
	$(CC) $(CFLAGS) src/engine.c tests/test_engine.c -o $@
test: build/test-engine
	./build/test-engine
wasm:
	clang --target=wasm32-unknown-unknown -std=c11 -O2 -Wall -Wextra -Werror -nostdlib -fno-builtin -Iinclude -Wl,--no-entry -Wl,--export-all -Wl,--export-memory -Wl,-z,stack-size=262144 -Wl,--initial-memory=4194304 -Wl,--max-memory=8388608 src/engine.c -o web/engine.wasm
clean:
	rm -f build/tradecore build/tradecore-server build/test-engine

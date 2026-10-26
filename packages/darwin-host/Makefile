CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2 -Iinclude -pthread
UNAME := $(shell uname -s)
BUILD_DIR := build

ifeq ($(UNAME),Darwin)
SHARED_FLAGS := -dynamiclib
LIBRARY := $(BUILD_DIR)/libdarwin_host.dylib
else
SHARED_FLAGS := -shared -fPIC
LIBRARY := $(BUILD_DIR)/libdarwin_host.so
endif

TEST_BIN := $(BUILD_DIR)/test_darwin_host

.PHONY: all test clean

all: $(LIBRARY) $(TEST_BIN)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(LIBRARY): src/host.c include/darwin_host.h | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(SHARED_FLAGS) -o $@ src/host.c

$(TEST_BIN): src/host.c tests/test_host.c include/darwin_host.h | $(BUILD_DIR)
	$(CC) $(CFLAGS) -o $@ src/host.c tests/test_host.c

test: $(TEST_BIN)
	./$(TEST_BIN)

clean:
	rm -rf $(BUILD_DIR)

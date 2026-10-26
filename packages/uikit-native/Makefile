CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2 -Iinclude
X11_CFLAGS ?= $(shell pkg-config --cflags x11 2>/dev/null)
X11_LIBS ?= $(shell pkg-config --libs x11 2>/dev/null)

ifeq ($(strip $(X11_LIBS)),)
X11_LIBS := -lX11
endif

BUILD_DIR := build
WINDOW_BIN := $(BUILD_DIR)/uikit-window
TEST_BIN := $(BUILD_DIR)/test_uikit

.PHONY: all test clean

all: $(WINDOW_BIN) $(TEST_BIN)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(TEST_BIN): src/uikit.c tests/test_uikit.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -o $@ src/uikit.c tests/test_uikit.c

$(WINDOW_BIN): src/uikit.c src/uikit_x11.c examples/blank_window.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(X11_CFLAGS) -o $@ src/uikit.c src/uikit_x11.c examples/blank_window.c $(X11_LIBS)

test: $(TEST_BIN)
	./$(TEST_BIN)

clean:
	rm -rf $(BUILD_DIR)

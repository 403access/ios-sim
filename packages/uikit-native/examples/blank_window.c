#include "uikit.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  int width;
  int height;
  uint32_t color;
  const char *title;
} BlankConfig;

static BlankConfig config = {402, 874, 0x1e1e2e, "UIKitLite Blank Window"};

static uint32_t parse_color(const char *value) {
  if (value == NULL) return config.color;
  const char *text = value;
  if (text[0] == '#') text += 1;
  if (text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) text += 2;
  char *end = NULL;
  unsigned long parsed = strtoul(text, &end, 16);
  if (end == text || *end != '\0' || parsed > 0xffffffUL) {
    fprintf(stderr, "uikit: invalid color %s (expected RRGGBB)\n", value);
    exit(2);
  }
  return (uint32_t)parsed;
}

static int parse_dimension(const char *name, const char *value) {
  char *end = NULL;
  long parsed = strtol(value, &end, 10);
  if (end == value || *end != '\0' || parsed <= 0 || parsed > 16384) {
    fprintf(stderr, "uikit: invalid %s %s (expected 1..16384)\n", name, value);
    exit(2);
  }
  return (int)parsed;
}

static void parse_arguments(int argc, char **argv) {
  for (int index = 1; index < argc; ++index) {
    const char *argument = argv[index];
    if (strcmp(argument, "--help") == 0 || strcmp(argument, "-h") == 0) {
      printf("Usage: uikit-window [--width N] [--height N] [--color RRGGBB] [--title TEXT]\n");
      exit(0);
    } else if (strcmp(argument, "--width") == 0 && index + 1 < argc) {
      config.width = parse_dimension("width", argv[++index]);
    } else if (strcmp(argument, "--height") == 0 && index + 1 < argc) {
      config.height = parse_dimension("height", argv[++index]);
    } else if (strcmp(argument, "--color") == 0 && index + 1 < argc) {
      config.color = parse_color(argv[++index]);
    } else if (strcmp(argument, "--title") == 0 && index + 1 < argc) {
      config.title = argv[++index];
    } else {
      fprintf(stderr, "uikit: unknown argument %s\n", argument);
      exit(2);
    }
  }
}

static void application_did_finish_launching(UIApplication *application) {
  UIWindow *window = UIApplicationCreateWindow(
      application, CGRectMake(0.0, 0.0, (double)config.width, (double)config.height));
  if (window == NULL) {
    fprintf(stderr, "uikit: cannot create window\n");
    exit(1);
  }
  UIWindowSetTitle(window, config.title);

  UIViewController *controller = UIViewControllerCreateWithView(
      UIViewCreate(CGRectMake(0.0, 0.0, (double)config.width, (double)config.height)));
  if (controller == NULL || UIViewControllerGetView(controller) == NULL) {
    fprintf(stderr, "uikit: cannot create root view controller\n");
    exit(1);
  }
  UIViewSetBackgroundColor(UIViewControllerGetView(controller), UIColorHex(config.color));
  UIWindowSetRootViewController(window, controller);
  UIWindowMakeKeyAndVisible(window);
}

int main(int argc, char **argv) {
  parse_arguments(argc, argv);
  UIApplicationDelegate delegate = {
      .applicationDidFinishLaunching = application_did_finish_launching,
      .applicationWillTerminate = NULL,
      .context = NULL,
  };
  return UIApplicationMain(&delegate);
}

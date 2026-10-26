#ifndef UIKIT_LITE_INTERNAL_H
#define UIKIT_LITE_INTERNAL_H

#include "uikit.h"

struct UIView {
  CGRect frame;
  UIColor backgroundColor;
  bool hidden;
  double alpha;
  UIView *parent;
  UIView **subviews;
  size_t subviewCount;
  size_t subviewCapacity;
};

struct UIViewController {
  UIView *view;
};

struct UIWindow {
  UIView *view;
  UIViewController *rootViewController;
  char title[128];
  bool visible;
};

struct UIApplication {
  UIWindow **windows;
  size_t windowCount;
  size_t windowCapacity;
  UIWindow *keyWindow;
  const UIApplicationDelegate *delegate;
  bool running;
  int exitCode;
};

static inline double uikit_clamp01(double value) {
  if (value < 0.0) return 0.0;
  if (value > 1.0) return 1.0;
  return value;
}

#endif

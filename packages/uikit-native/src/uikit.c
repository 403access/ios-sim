#include "uikit_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

CGRect CGRectMake(double x, double y, double width, double height) {
  CGRect rect;
  rect.origin.x = x;
  rect.origin.y = y;
  rect.size.width = width;
  rect.size.height = height;
  return rect;
}

UIColor UIColorMake(double r, double g, double b, double a) {
  UIColor color;
  color.r = uikit_clamp01(r);
  color.g = uikit_clamp01(g);
  color.b = uikit_clamp01(b);
  color.a = uikit_clamp01(a);
  return color;
}

UIColor UIColorHex(uint32_t rgb) {
  return UIColorMake(((rgb >> 16) & 0xff) / 255.0, ((rgb >> 8) & 0xff) / 255.0,
                     (rgb & 0xff) / 255.0, 1.0);
}

UIColor UIColorWhite(void) { return UIColorHex(0xffffff); }
UIColor UIColorBlack(void) { return UIColorHex(0x000000); }
UIColor UIColorClear(void) { return UIColorMake(0.0, 0.0, 0.0, 0.0); }

uint32_t UIColorToRGBA(UIColor color) {
  uint32_t a = (uint32_t)(uikit_clamp01(color.a) * 255.0 + 0.5);
  uint32_t r = (uint32_t)(uikit_clamp01(color.r) * 255.0 + 0.5);
  uint32_t g = (uint32_t)(uikit_clamp01(color.g) * 255.0 + 0.5);
  uint32_t b = (uint32_t)(uikit_clamp01(color.b) * 255.0 + 0.5);
  return (a << 24) | (r << 16) | (g << 8) | b;
}

static bool uikit_grow_subviews(UIView *view) {
  if (view->subviewCount < view->subviewCapacity) return true;
  size_t next = view->subviewCapacity == 0 ? 4 : view->subviewCapacity * 2;
  UIView **items = realloc(view->subviews, next * sizeof(*items));
  if (items == NULL) return false;
  view->subviews = items;
  view->subviewCapacity = next;
  return true;
}

UIView *UIViewCreate(CGRect frame) {
  UIView *view = calloc(1, sizeof(*view));
  if (view == NULL) return NULL;
  view->frame = frame;
  view->backgroundColor = UIColorClear();
  view->alpha = 1.0;
  return view;
}

static void uikit_remove_from_parent(UIView *view) {
  if (view->parent == NULL) return;
  UIView *parent = view->parent;
  for (size_t index = 0; index < parent->subviewCount; ++index) {
    if (parent->subviews[index] == view) {
      for (size_t move = index; move + 1 < parent->subviewCount; ++move) {
        parent->subviews[move] = parent->subviews[move + 1];
      }
      parent->subviewCount -= 1;
      break;
    }
  }
  view->parent = NULL;
}

void UIViewDestroy(UIView *view) {
  if (view == NULL) return;
  uikit_remove_from_parent(view);
  for (size_t index = 0; index < view->subviewCount; ++index) {
    UIView *child = view->subviews[index];
    if (child != NULL) {
      child->parent = NULL;
      UIViewDestroy(child);
    }
  }
  free(view->subviews);
  free(view);
}

void UIViewAddSubview(UIView *parent, UIView *child) {
  if (parent == NULL || child == NULL || parent == child) return;
  if (!uikit_grow_subviews(parent)) return;
  uikit_remove_from_parent(child);
  child->parent = parent;
  parent->subviews[parent->subviewCount++] = child;
}

void UIViewSetBackgroundColor(UIView *view, UIColor color) {
  if (view != NULL) view->backgroundColor = color;
}

void UIViewSetHidden(UIView *view, bool hidden) {
  if (view != NULL) view->hidden = hidden;
}

void UIViewSetAlpha(UIView *view, double alpha) {
  if (view != NULL) view->alpha = uikit_clamp01(alpha);
}

void UIViewSetFrame(UIView *view, CGRect frame) {
  if (view != NULL) view->frame = frame;
}

CGRect UIViewGetFrame(const UIView *view) {
  if (view == NULL) return CGRectMake(0.0, 0.0, 0.0, 0.0);
  return view->frame;
}

UIViewController *UIViewControllerCreateWithView(UIView *view) {
  UIViewController *controller = calloc(1, sizeof(*controller));
  if (controller == NULL) return NULL;
  controller->view = view;
  return controller;
}

UIViewController *UIViewControllerCreate(void) {
  return UIViewControllerCreateWithView(UIViewCreate(CGRectMake(0.0, 0.0, 0.0, 0.0)));
}

void UIViewControllerDestroy(UIViewController *controller) {
  /* The view is owned by the window once installed; this avoids a double free
     when the window tears down its view tree. */
  free(controller);
}

UIView *UIViewControllerGetView(const UIViewController *controller) {
  return controller == NULL ? NULL : controller->view;
}

UIWindow *UIWindowCreate(CGRect frame) {
  UIWindow *window = calloc(1, sizeof(*window));
  if (window == NULL) return NULL;
  window->view = UIViewCreate(frame);
  if (window->view == NULL) {
    free(window);
    return NULL;
  }
  window->view->backgroundColor = UIColorWhite();
  snprintf(window->title, sizeof(window->title), "%s", "UIKitLite");
  return window;
}

void UIWindowDestroy(UIWindow *window) {
  if (window == NULL) return;
  UIViewDestroy(window->view);
  free(window->rootViewController);
  free(window);
}

UIView *UIWindowGetView(const UIWindow *window) {
  return window == NULL ? NULL : window->view;
}

void UIWindowSetRootViewController(UIWindow *window, UIViewController *controller) {
  if (window == NULL || controller == NULL || controller->view == NULL) return;
  UIViewAddSubview(window->view, controller->view);
  window->rootViewController = controller;
}

void UIWindowSetTitle(UIWindow *window, const char *title) {
  if (window == NULL || title == NULL) return;
  snprintf(window->title, sizeof(window->title), "%s", title);
}

void UIWindowMakeKeyAndVisible(UIWindow *window) {
  if (window == NULL) return;
  window->visible = true;
  UIApplication *application = UIApplicationShared();
  if (application != NULL) application->keyWindow = window;
}

static bool uikit_grow_windows(UIApplication *application) {
  if (application->windowCount < application->windowCapacity) return true;
  size_t next = application->windowCapacity == 0 ? 4 : application->windowCapacity * 2;
  UIWindow **items = realloc(application->windows, next * sizeof(*items));
  if (items == NULL) return false;
  application->windows = items;
  application->windowCapacity = next;
  return true;
}

UIApplication *UIApplicationShared(void) {
  static UIApplication application;
  return &application;
}

UIWindow *UIApplicationCreateWindow(UIApplication *application, CGRect frame) {
  if (application == NULL) return NULL;
  if (!uikit_grow_windows(application)) return NULL;
  UIWindow *window = UIWindowCreate(frame);
  if (window == NULL) return NULL;
  application->windows[application->windowCount++] = window;
  if (application->keyWindow == NULL) application->keyWindow = window;
  return window;
}

void UIApplicationTerminate(UIApplication *application) {
  if (application != NULL) application->running = false;
}

static void uikit_blend_pixel(uint32_t *pixel, UIColor color, double alpha) {
  double sourceAlpha = uikit_clamp01(color.a * alpha);
  if (sourceAlpha <= 0.0) return;
  uint32_t current = *pixel;
  double destinationRed = (double)((current >> 16) & 0xff) / 255.0;
  double destinationGreen = (double)((current >> 8) & 0xff) / 255.0;
  double destinationBlue = (double)(current & 0xff) / 255.0;
  double red = color.r * sourceAlpha + destinationRed * (1.0 - sourceAlpha);
  double green = color.g * sourceAlpha + destinationGreen * (1.0 - sourceAlpha);
  double blue = color.b * sourceAlpha + destinationBlue * (1.0 - sourceAlpha);
  uint32_t r = (uint32_t)(uikit_clamp01(red) * 255.0 + 0.5);
  uint32_t g = (uint32_t)(uikit_clamp01(green) * 255.0 + 0.5);
  uint32_t b = (uint32_t)(uikit_clamp01(blue) * 255.0 + 0.5);
  *pixel = 0xff000000u | (r << 16) | (g << 8) | b;
}

static void uikit_fill_rect(UIKitFramebuffer *framebuffer, double originX, double originY,
                            CGRect frame, UIColor color, double alpha) {
  if (framebuffer == NULL || framebuffer->pixels == NULL) return;
  int left = (int)(originX + frame.origin.x);
  int top = (int)(originY + frame.origin.y);
  int right = (int)(originX + frame.origin.x + frame.size.width + 0.999);
  int bottom = (int)(originY + frame.origin.y + frame.size.height + 0.999);
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (right > framebuffer->width) right = framebuffer->width;
  if (bottom > framebuffer->height) bottom = framebuffer->height;
  for (int y = top; y < bottom; ++y) {
    for (int x = left; x < right; ++x) {
      uikit_blend_pixel(&framebuffer->pixels[(size_t)y * (size_t)framebuffer->width + (size_t)x], color,
                        alpha);
    }
  }
}

static void uikit_render_view(UIView *view, UIKitFramebuffer *framebuffer, double originX,
                              double originY, double inheritedAlpha) {
  if (view == NULL || view->hidden) return;
  double alpha = inheritedAlpha * view->alpha;
  if (alpha <= 0.0) return;
  uikit_fill_rect(framebuffer, originX, originY, view->frame, view->backgroundColor, alpha);
  double childX = originX + view->frame.origin.x;
  double childY = originY + view->frame.origin.y;
  for (size_t index = 0; index < view->subviewCount; ++index) {
    uikit_render_view(view->subviews[index], framebuffer, childX, childY, alpha);
  }
}

bool UIKitRender(UIView *root, UIKitFramebuffer *framebuffer) {
  if (root == NULL || framebuffer == NULL || framebuffer->pixels == NULL || framebuffer->width <= 0 ||
      framebuffer->height <= 0) {
    return false;
  }
  memset(framebuffer->pixels, 0,
         (size_t)framebuffer->width * (size_t)framebuffer->height * sizeof(uint32_t));
  uikit_render_view(root, framebuffer, 0.0, 0.0, 1.0);
  return true;
}

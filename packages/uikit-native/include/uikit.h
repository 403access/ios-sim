#ifndef UIKIT_LITE_H
#define UIKIT_LITE_H

/*
 * UIKitLite — a clean-room, native UIKit-compatible subset.
 *
 * This is not Apple's UIKit. It implements the small object model a blank
 * window needs, renders into a software framebuffer, and presents that
 * framebuffer in a native X11 window. No web view, no HTML, no Apple code.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  double x;
  double y;
} CGPoint;

typedef struct {
  double width;
  double height;
} CGSize;

typedef struct {
  CGPoint origin;
  CGSize size;
} CGRect;

CGRect CGRectMake(double x, double y, double width, double height);

typedef struct {
  double r;
  double g;
  double b;
  double a;
} UIColor;

UIColor UIColorMake(double r, double g, double b, double a);
UIColor UIColorHex(uint32_t rgb);
UIColor UIColorWhite(void);
UIColor UIColorBlack(void);
UIColor UIColorClear(void);
uint32_t UIColorToRGBA(UIColor color);

typedef struct UIView UIView;
typedef struct UIViewController UIViewController;
typedef struct UIWindow UIWindow;
typedef struct UIApplication UIApplication;

typedef struct UIApplicationDelegate {
  void (*applicationDidFinishLaunching)(UIApplication *application);
  void (*applicationWillTerminate)(UIApplication *application);
  void *context;
} UIApplicationDelegate;

UIView *UIViewCreate(CGRect frame);
void UIViewDestroy(UIView *view);
void UIViewAddSubview(UIView *parent, UIView *child);
void UIViewSetBackgroundColor(UIView *view, UIColor color);
void UIViewSetHidden(UIView *view, bool hidden);
void UIViewSetAlpha(UIView *view, double alpha);
void UIViewSetFrame(UIView *view, CGRect frame);
CGRect UIViewGetFrame(const UIView *view);

UIViewController *UIViewControllerCreate(void);
UIViewController *UIViewControllerCreateWithView(UIView *view);
void UIViewControllerDestroy(UIViewController *controller);
UIView *UIViewControllerGetView(const UIViewController *controller);

UIWindow *UIWindowCreate(CGRect frame);
void UIWindowDestroy(UIWindow *window);
UIView *UIWindowGetView(const UIWindow *window);
void UIWindowSetRootViewController(UIWindow *window, UIViewController *controller);
void UIWindowSetTitle(UIWindow *window, const char *title);
void UIWindowMakeKeyAndVisible(UIWindow *window);

UIApplication *UIApplicationShared(void);
UIWindow *UIApplicationCreateWindow(UIApplication *application, CGRect frame);
int UIApplicationRun(UIApplication *application);
void UIApplicationTerminate(UIApplication *application);
int UIApplicationMain(const UIApplicationDelegate *delegate);

typedef struct {
  uint32_t *pixels;
  int width;
  int height;
} UIKitFramebuffer;

/* Render a view tree into a caller-owned ARGB framebuffer. */
bool UIKitRender(UIView *root, UIKitFramebuffer *framebuffer);

#ifdef __cplusplus
}
#endif

#endif

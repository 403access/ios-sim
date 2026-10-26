#include "uikit_internal.h"

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  Display *display;
  Window window;
  GC gc;
  XImage *image;
  int width;
  int height;
  Atom wmDelete;
} UIKitX11;

static int uikit_x11_width(const UIWindow *window) {
  int width = (int)(window->view->frame.size.width + 0.5);
  return width > 0 ? width : 1;
}

static int uikit_x11_height(const UIWindow *window) {
  int height = (int)(window->view->frame.size.height + 0.5);
  return height > 0 ? height : 1;
}

static bool uikit_x11_create_image(UIKitX11 *x11, int width, int height) {
  if (x11->image != NULL) {
    XDestroyImage(x11->image);
    x11->image = NULL;
  }
  uint32_t *pixels = calloc((size_t)width * (size_t)height, sizeof(uint32_t));
  if (pixels == NULL) return false;
  x11->image = XCreateImage(x11->display, DefaultVisual(x11->display, DefaultScreen(x11->display)),
                            (unsigned int)DefaultDepth(x11->display, DefaultScreen(x11->display)),
                            ZPixmap, 0, (char *)pixels, (unsigned int)width, (unsigned int)height, 32, 0);
  if (x11->image == NULL) {
    free(pixels);
    return false;
  }
  x11->width = width;
  x11->height = height;
  return true;
}

static bool uikit_x11_render(UIKitX11 *x11, UIWindow *window) {
  if (x11->image == NULL) return false;
  UIKitFramebuffer framebuffer;
  framebuffer.pixels = (uint32_t *)x11->image->data;
  framebuffer.width = x11->width;
  framebuffer.height = x11->height;
  if (!UIKitRender(window->view, &framebuffer)) return false;
  XPutImage(x11->display, x11->window, x11->gc, x11->image, 0, 0, 0, 0, (unsigned int)x11->width,
            (unsigned int)x11->height);
  XFlush(x11->display);
  return true;
}

int UIApplicationRun(UIApplication *application) {
  if (application == NULL || application->keyWindow == NULL) {
    fprintf(stderr, "uikit: no key window\n");
    return 1;
  }

  UIWindow *window = application->keyWindow;
  int width = uikit_x11_width(window);
  int height = uikit_x11_height(window);
  window->view->frame = CGRectMake(0.0, 0.0, (double)width, (double)height);

  UIKitX11 x11;
  memset(&x11, 0, sizeof(x11));
  x11.display = XOpenDisplay(NULL);
  if (x11.display == NULL) {
    fprintf(stderr,
            "uikit: cannot open X11 display. Set DISPLAY (X11 or XWayland), or run under Xvfb.\n");
    return 1;
  }

  int screen = DefaultScreen(x11.display);
  x11.window = XCreateSimpleWindow(x11.display, RootWindow(x11.display, screen), 0, 0,
                                   (unsigned int)width, (unsigned int)height, 0,
                                   BlackPixel(x11.display, screen), BlackPixel(x11.display, screen));
  if (x11.window == 0) {
    fprintf(stderr, "uikit: cannot create X11 window\n");
    XCloseDisplay(x11.display);
    return 1;
  }

  XStoreName(x11.display, x11.window, window->title);
  XSelectInput(x11.display, x11.window,
               ExposureMask | StructureNotifyMask | KeyPressMask | ButtonPressMask);
  x11.gc = XCreateGC(x11.display, x11.window, 0, NULL);
  if (x11.gc == NULL) {
    fprintf(stderr, "uikit: cannot create X11 graphics context\n");
    XDestroyWindow(x11.display, x11.window);
    XCloseDisplay(x11.display);
    return 1;
  }

  Atom wmProtocols[1];
  x11.wmDelete = XInternAtom(x11.display, "WM_DELETE_WINDOW", False);
  wmProtocols[0] = x11.wmDelete;
  XSetWMProtocols(x11.display, x11.window, wmProtocols, 1);

  if (!uikit_x11_create_image(&x11, width, height)) {
    fprintf(stderr, "uikit: cannot allocate framebuffer\n");
    XFreeGC(x11.display, x11.gc);
    XDestroyWindow(x11.display, x11.window);
    XCloseDisplay(x11.display);
    return 1;
  }

  XMapRaised(x11.display, x11.window);
  XFlush(x11.display);
  printf("uikit: window ready %dx%d\n", width, height);
  fflush(stdout);

  application->running = true;
  application->exitCode = 0;
  while (application->running) {
    XEvent event;
    XNextEvent(x11.display, &event);
    if (event.type == Expose) {
      uikit_x11_render(&x11, window);
    } else if (event.type == ConfigureNotify) {
      int nextWidth = event.xconfigure.width;
      int nextHeight = event.xconfigure.height;
      if (nextWidth != x11.width || nextHeight != x11.height) {
        if (nextWidth > 0 && nextHeight > 0 && uikit_x11_create_image(&x11, nextWidth, nextHeight)) {
          window->view->frame = CGRectMake(0.0, 0.0, (double)nextWidth, (double)nextHeight);
          uikit_x11_render(&x11, window);
        }
      }
    } else if (event.type == KeyPress) {
      KeySym symbol = XLookupKeysym(&event.xkey, 0);
      if (symbol == XK_Escape) {
        application->running = false;
      }
    } else if (event.type == ClientMessage &&
               (Atom)event.xclient.data.l[0] == x11.wmDelete) {
      application->running = false;
    }
  }

  XDestroyImage(x11.image);
  XFreeGC(x11.display, x11.gc);
  XDestroyWindow(x11.display, x11.window);
  XCloseDisplay(x11.display);
  return application->exitCode;
}

int UIApplicationMain(const UIApplicationDelegate *delegate) {
  UIApplication *application = UIApplicationShared();
  application->delegate = delegate;
  application->exitCode = 0;
  if (delegate != NULL && delegate->applicationDidFinishLaunching != NULL) {
    delegate->applicationDidFinishLaunching(application);
  }
  if (application->keyWindow == NULL) {
    fprintf(stderr, "uikit: delegate did not create a visible window\n");
    return 1;
  }
  int result = UIApplicationRun(application);
  if (delegate != NULL && delegate->applicationWillTerminate != NULL) {
    delegate->applicationWillTerminate(application);
  }
  return result;
}

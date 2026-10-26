#include "uikit.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int failures = 0;

#define CHECK(condition, message)                                                               \
  do {                                                                                          \
    if (!(condition)) {                                                                         \
      fprintf(stderr, "FAIL: %s (%s:%d)\n", message, __FILE__, __LINE__);                       \
      failures += 1;                                                                            \
    }                                                                                           \
  } while (0)

int main(void) {
  CHECK(UIColorToRGBA(UIColorHex(0x1e1e2e)) == 0xff1e1e2eU, "hex color packing");
  CHECK(UIColorToRGBA(UIColorMake(1.0, 0.0, 0.0, 1.0)) == 0xffff0000U, "rgba packing");

  uint32_t pixels[8 * 8];
  UIKitFramebuffer framebuffer = {.pixels = pixels, .width = 8, .height = 8};
  UIView *root = UIViewCreate(CGRectMake(0.0, 0.0, 8.0, 8.0));
  UIView *child = UIViewCreate(CGRectMake(2.0, 2.0, 3.0, 3.0));
  CHECK(root != NULL && child != NULL, "view allocation");
  UIViewSetBackgroundColor(root, UIColorHex(0xff0000));
  UIViewSetBackgroundColor(child, UIColorHex(0x00ff00));
  UIViewAddSubview(root, child);

  CHECK(UIKitRender(root, &framebuffer), "render succeeds");
  CHECK(pixels[0] == 0xffff0000U, "root background");
  CHECK(pixels[2 * 8 + 2] == 0xff00ff00U, "child background");
  CHECK(pixels[2 * 8 + 1] == 0xffff0000U, "child clipping");

  UIViewSetHidden(child, true);
  CHECK(UIKitRender(root, &framebuffer), "render hidden");
  CHECK(pixels[2 * 8 + 2] == 0xffff0000U, "hidden child is skipped");
  UIViewSetHidden(child, false);

  UIViewSetAlpha(child, 0.5);
  CHECK(UIKitRender(root, &framebuffer), "render alpha");
  CHECK(pixels[2 * 8 + 2] == 0xff808000U, "alpha compositing");

  UIViewDestroy(root);
  printf("uikit: %d unit test(s) failed\n", failures);
  return failures == 0 ? 0 : 1;
}

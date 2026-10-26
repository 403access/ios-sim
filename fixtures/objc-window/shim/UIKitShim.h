// Minimal declarations for the clean-room UIKit shim used by the native track.
//
// This is NOT Apple's UIKit and NOT the iOS SDK. It is a hand-written header
// that matches the host shim in packages/darwin-compat/src/objc/host.ts, so a
// real compiler can produce a real Mach-O ObjC image for the proof of concept.
//
// Deliberate deviations from Apple:
//   * UIApplicationMain takes a C string class name, not an NSString.
//   * Only the methods the shim implements are declared.
//   * No Foundation, CoreGraphics, CoreAnimation, or Metal types exist here.

#ifndef UIKIT_SHIM_H
#define UIKIT_SHIM_H

typedef struct objc_selector *SEL;
typedef unsigned long NSUInteger;

enum { UIControlEventTouchUpInside = 1 << 6 };
typedef signed char BOOL;
#define YES ((BOOL)1)
#define NO ((BOOL)0)
#ifndef nil
#define nil ((id)0)
#endif

typedef double CGFloat;

typedef struct {
  CGFloat x;
  CGFloat y;
} CGPoint;

typedef struct {
  CGFloat width;
  CGFloat height;
} CGSize;

typedef struct {
  CGPoint origin;
  CGSize size;
} CGRect;

static inline CGRect CGRectMake(CGFloat x, CGFloat y, CGFloat width, CGFloat height) {
  CGRect rect;
  rect.origin.x = x;
  rect.origin.y = y;
  rect.size.width = width;
  rect.size.height = height;
  return rect;
}

__attribute__((objc_root_class))
@interface NSObject
+ (id)alloc;
+ (id)class;
- (id)init;
- (id)self;
- (id)performSelector:(SEL)selector;
@end

@interface UIApplication : NSObject
+ (id)sharedApplication;
- (void)setDelegate:(id)delegate;
@end

@interface UIColor : NSObject
+ (UIColor *)redColor;
+ (UIColor *)blueColor;
+ (UIColor *)greenColor;
+ (UIColor *)purpleColor;
+ (UIColor *)yellowColor;
+ (UIColor *)orangeColor;
+ (UIColor *)grayColor;
+ (UIColor *)blackColor;
+ (UIColor *)whiteColor;
+ (UIColor *)colorWithRed:(CGFloat)red
                    green:(CGFloat)green
                     blue:(CGFloat)blue
                    alpha:(CGFloat)alpha;
@end

@interface UIView : NSObject
- (id)initWithFrame:(CGRect)frame;
- (void)setFrame:(CGRect)frame;
- (void)setBackgroundColor:(UIColor *)color;
- (void)addSubview:(UIView *)view;
- (void)setAlpha:(double)alpha;
- (BOOL)conformsToProtocol:(id)protocol;
- (void)touchesBegan:(id)touches withEvent:(id)event;
- (void)touchesMoved:(id)touches withEvent:(id)event;
- (void)touchesEnded:(id)touches withEvent:(id)event;
@end

@interface UILabel : UIView
- (void)setText:(const char *)text;
- (void)setTextColor:(UIColor *)color;
- (void)setTextAlignment:(long)alignment;
@end

@interface UIButton : UIView
- (void)addTarget:(id)target action:(SEL)action forControlEvents:(NSUInteger)events;
@end

@interface UIWindow : UIView
- (void)makeKeyAndVisible;
- (void)setRootViewController:(id)controller;
@end

@interface UIViewController : NSObject
- (UIView *)view;
- (void)setView:(UIView *)view;
@end

// The last argument is a C string in this shim. Apple's API takes NSString.
extern int UIApplicationMain(int argc, char *argv[], id principalClassName,
                             const char *delegateClassName);

#endif

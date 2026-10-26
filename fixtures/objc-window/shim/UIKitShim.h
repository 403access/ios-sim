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

enum { UIControlEventTouchUpInside = 1 << 6, UIControlEventValueChanged = 1 << 12 };
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
- (void)performSelector:(SEL)selector withObject:(id)object afterDelay:(double)delay;
+ (void)cancelPreviousPerformRequestsWithTarget:(id)target;
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
- (void)setClipsToBounds:(BOOL)clips;
- (BOOL)conformsToProtocol:(id)protocol;
- (void)touchesBegan:(id)touches withEvent:(id)event;
- (void)touchesMoved:(id)touches withEvent:(id)event;
- (void)touchesEnded:(id)touches withEvent:(id)event;
@end

static inline CGPoint CGPointMake(CGFloat x, CGFloat y) {
  CGPoint point;
  point.x = x;
  point.y = y;
  return point;
}

static inline CGSize CGSizeMake(CGFloat width, CGFloat height) {
  CGSize size;
  size.width = width;
  size.height = height;
  return size;
}

@interface UIScrollView : UIView
- (void)setContentOffset:(CGPoint)offset;
- (void)setContentSize:(CGSize)size;
@end

@interface NSUserDefaults : NSObject
+ (id)standardUserDefaults;
- (void)setBool:(BOOL)value forKey:(const char *)key;
- (BOOL)boolForKey:(const char *)key;
- (void)setInteger:(long)value forKey:(const char *)key;
- (long)integerForKey:(const char *)key;
@end

@interface NSNotificationCenter : NSObject
+ (id)defaultCenter;
- (void)addObserver:(id)observer
           selector:(SEL)selector
               name:(const char *)name
             object:(id)object;
- (void)postNotificationName:(const char *)name object:(id)object;
@end

@interface NSString : NSObject
+ (id)stringWithUTF8String:(const char *)text;
- (const char *)UTF8String;
- (unsigned long)length;
- (BOOL)isEqualToString:(NSString *)other;
@end

// Text accepts an NSString or a bare C string; the host reads either.
@interface NSNumber : NSObject
+ (id)numberWithInt:(int)value;
+ (id)numberWithInteger:(long)value;
- (int)intValue;
- (long)integerValue;
- (BOOL)boolValue;
@end

@interface NSArray : NSObject
+ (id)array;
- (unsigned long)count;
- (id)objectAtIndex:(unsigned long)index;
- (id)firstObject;
- (id)lastObject;
@end

@interface NSMutableArray : NSArray
- (void)addObject:(id)object;
- (void)removeAllObjects;
@end

// Dictionary keys are C strings in this shim; Apple's API takes NSString.
@interface NSDictionary : NSObject
+ (id)dictionary;
- (unsigned long)count;
- (id)objectForKey:(const char *)key;
@end

@interface NSMutableDictionary : NSDictionary
- (void)setObject:(id)object forKey:(const char *)key;
- (void)removeObjectForKey:(id)key;
- (void)removeAllObjects;
@end

@interface NSTimer : NSObject
+ (NSTimer *)scheduledTimerWithTimeInterval:(double)interval
                                     target:(id)target
                                   selector:(SEL)selector
                                    repeats:(BOOL)repeats;
+ (NSTimer *)timerWithTimeInterval:(double)interval
                            target:(id)target
                          selector:(SEL)selector
                           repeats:(BOOL)repeats;
- (void)invalidate;
- (BOOL)isValid;
- (double)timeInterval;
- (void)fire;
@end

@interface UILabel : UIView
- (void)setText:(id)text;
- (id)text;
- (void)setTextColor:(UIColor *)color;
- (void)setTextAlignment:(long)alignment;
@end

@interface UIControl : UIView
- (void)addTarget:(id)target action:(SEL)action forControlEvents:(NSUInteger)events;
- (void)removeTarget:(id)target action:(SEL)action forControlEvents:(NSUInteger)events;
- (void)sendActionsForControlEvents:(NSUInteger)events;
@end

@interface UIButton : UIControl
- (void)addTarget:(id)target action:(SEL)action forControlEvents:(NSUInteger)events;
@end

@interface UISwitch : UIControl
- (void)setOn:(BOOL)on animated:(BOOL)animated;
- (void)setOn:(BOOL)on;
- (BOOL)isOn;
@end

@interface UISlider : UIControl
- (void)setValue:(double)value;
- (void)setValue:(double)value animated:(BOOL)animated;
- (double)value;
- (void)setMinimumValue:(double)value;
- (void)setMaximumValue:(double)value;
- (double)minimumValue;
- (double)maximumValue;
@end

@interface UIWindow : UIView
- (void)makeKeyAndVisible;
- (void)setRootViewController:(id)controller;
@end

@interface UIViewController : NSObject
- (UIView *)view;
- (void)setView:(UIView *)view;
- (void)viewWillAppear:(BOOL)animated;
- (void)viewDidAppear:(BOOL)animated;
@end

// The last argument is a C string in this shim. Apple's API takes NSString.
extern int UIApplicationMain(int argc, char *argv[], id principalClassName,
                             const char *delegateClassName);

#endif

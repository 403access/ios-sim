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

@interface CALayer : NSObject
- (void)setCornerRadius:(double)radius;
- (double)cornerRadius;
- (void)setMasksToBounds:(BOOL)masks;
- (BOOL)masksToBounds;
@end

typedef struct {
  double a, b, c, d;
  double tx, ty;
} CGAffineTransform;

extern double cos(double);
extern double sin(double);

static inline CGAffineTransform CGAffineTransformMakeRotation(double angle) {
  CGAffineTransform transform;
  transform.a = cos(angle);
  transform.b = sin(angle);
  transform.c = -sin(angle);
  transform.d = cos(angle);
  transform.tx = 0;
  transform.ty = 0;
  return transform;
}

@interface UIView : NSObject
- (void)setTransform:(CGAffineTransform)transform;
- (CGAffineTransform)transform;
+ (void)beginAnimations:(const char *)identifier context:(void *)context;
+ (void)setAnimationDuration:(double)duration;
+ (void)commitAnimations;
+ (void)animateWithDuration:(double)duration animations:(void (^)(void))animations;
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

@interface UIGestureRecognizer : NSObject
- (id)initWithTarget:(id)target action:(SEL)action;
- (void)setEnabled:(BOOL)enabled;
- (BOOL)isEnabled;
- (long)state;
- (CGPoint)locationInView:(UIView *)view;
@end

@interface UITapGestureRecognizer : UIGestureRecognizer
- (void)setNumberOfTapsRequired:(unsigned long)count;
- (unsigned long)numberOfTapsRequired;
@end

@interface UIPanGestureRecognizer : UIGestureRecognizer
- (CGPoint)translationInView:(UIView *)view;
- (void)setTranslation:(CGPoint)translation inView:(UIView *)view;
@end

@interface UIView (Layer)
- (CALayer *)layer;
@end

@interface UIView (Gestures)
- (void)addGestureRecognizer:(UIGestureRecognizer *)recognizer;
- (void)removeGestureRecognizer:(UIGestureRecognizer *)recognizer;
- (id)gestureRecognizers;
@end

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

@interface NSNotification : NSObject
- (id)name;
- (id)object;
- (id)userInfo;
@end

@interface NSNotificationCenter : NSObject
+ (id)defaultCenter;
- (void)addObserver:(id)observer
           selector:(SEL)selector
               name:(const char *)name
             object:(id)object;
- (void)postNotificationName:(const char *)name object:(id)object;
- (void)postNotificationName:(const char *)name object:(id)object userInfo:(id)userInfo;
@end

@interface NSString : NSObject
+ (id)stringWithUTF8String:(const char *)text;
+ (id)stringWithFormat:(const char *)format, ...;
- (const char *)UTF8String;
- (unsigned long)length;
- (BOOL)isEqualToString:(NSString *)other;
- (id)dataUsingEncoding:(unsigned long)encoding;
@end

// Text accepts an NSString or a bare C string; the host reads either.
// Resource names are C strings in this shim; Apple's API takes NSString.
@interface NSJSONSerialization : NSObject
+ (id)JSONObjectWithData:(id)data options:(unsigned long)options error:(id *)error;
@end

@interface NSBundle : NSObject
+ (NSBundle *)mainBundle;
- (NSString *)bundlePath;
- (NSString *)resourcePath;
- (NSString *)pathForResource:(const char *)name ofType:(const char *)type;
@end

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

@interface UITableView : UIScrollView
- (void)setRows:(id)rows;
- (unsigned long)numberOfRows;
- (double)rowHeight;
- (void)setRowHeight:(double)height;
- (long)selectedRow;
- (void)setSelectedRow:(long)row;
- (void)addTarget:(id)target action:(SEL)action forControlEvents:(NSUInteger)events;
@end

@interface UIProgressView : UIView
- (id)initWithProgressViewStyle:(long)style;
- (void)setProgress:(float)progress;
- (void)setProgress:(float)progress animated:(BOOL)animated;
- (float)progress;
@end

@interface UILabel : UIView
- (void)setText:(id)text;
- (id)text;
- (void)setTextColor:(UIColor *)color;
- (void)setTextAlignment:(long)alignment;
- (void)setNumberOfLines:(long)lines;
- (long)numberOfLines;
@end

@interface UIControl : UIView
- (void)addTarget:(id)target action:(SEL)action forControlEvents:(NSUInteger)events;
- (void)removeTarget:(id)target action:(SEL)action forControlEvents:(NSUInteger)events;
- (void)sendActionsForControlEvents:(NSUInteger)events;
@end

@interface UIButton : UIControl
- (void)addTarget:(id)target action:(SEL)action forControlEvents:(NSUInteger)events;
@end

@interface UISegmentedControl : UIControl
- (id)initWithItems:(id)items;
- (unsigned long)numberOfSegments;
- (long)selectedSegmentIndex;
- (void)setSelectedSegmentIndex:(long)index;
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

// Image names are paths under the runtime root, as C strings; Apple takes an
// NSString without an extension. Only 8-bit non-interlaced PNGs decode.
@interface NSData : NSObject
+ (id)dataWithContentsOfFile:(NSString *)path;
+ (id)dataWithBytes:(const void *)bytes length:(unsigned long)length;
- (unsigned long)length;
- (const void *)bytes;
@end

@interface UIImage : NSObject
+ (id)imageNamed:(const char *)name;
+ (id)imageWithData:(NSData *)data;
- (CGSize)size;
@end

@interface UIImageView : UIView
- (id)initWithImage:(UIImage *)image;
- (void)setImage:(UIImage *)image;
- (UIImage *)image;
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
- (void)setTitle:(const char *)title;
- (const char *)title;
@end

@interface UINavigationController : UIViewController
- (id)initWithRootViewController:(UIViewController *)root;
- (void)pushViewController:(UIViewController *)controller animated:(BOOL)animated;
- (id)popViewControllerAnimated:(BOOL)animated;
- (UIViewController *)topViewController;
@end


// The last argument is a C string in this shim. Apple's API takes NSString.
extern int UIApplicationMain(int argc, char *argv[], id principalClassName,
                             const char *delegateClassName);

#endif

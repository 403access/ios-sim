// Real-compiler fixture for the native track's UIKit proof of concept.
//
// Built by scripts/build-objc-fixture.sh with clang. It uses only the
// clean-room shim header next to it: no Apple SDK, no Foundation, no UIKit.
// The shape mirrors the generated fixture in
// packages/darwin-compat/src/objc/build-ui-demo.ts so the two render the same
// frame.

#import "UIKitShim.h"

void objc_setAssociatedObject(id object, const void *key, id value, unsigned long policy);
id objc_getAssociatedObject(id object, const void *key);

static char kColorKey;
static int gBaseInit;
static int gTapInit;
static int gInitOrder;

@protocol Tappable
@end

@interface BaseView : UIView
+ (void)initialize;
@end

@implementation BaseView
+ (void)initialize {
  if (self == [BaseView class]) {
    gBaseInit = 1;
    gInitOrder = 1;
  }
}
- (void)touchesBegan:(id)touches withEvent:(id)event {
  (void)touches;
  (void)event;
  if (!(gBaseInit && gTapInit && gInitOrder == 2)) {
    self.backgroundColor = [UIColor purpleColor];
    return;
  }
  __weak UIColor *weakColor;
  @autoreleasepool {
    UIColor *temporary = [UIColor redColor];
    weakColor = temporary;
  }
  if (weakColor != nil) {
    self.backgroundColor = [UIColor purpleColor];
    return;
  }
  BOOL tappable = [self conformsToProtocol:@protocol(Tappable)];
  UIColor *color = tappable ? [UIColor blueColor] : [UIColor purpleColor];
  objc_setAssociatedObject(self, &kColorKey, color, 1);
  (void)objc_getAssociatedObject(self, &kColorKey);
  UIColor *probed = [self performSelector:@selector(probeColor)];
  self.backgroundColor = probed ? probed : [UIColor purpleColor];
}
@end

@interface TapView : BaseView <Tappable> {
  BOOL _pressed;
}
- (UIColor *)probeColor;
@end

@implementation TapView
- (UIColor *)probeColor {
  return [UIColor blueColor];
}
+ (void)initialize {
  if (self == [TapView class]) {
    gTapInit = 1;
    gInitOrder = 2;
  }
}
- (void)touchesBegan:(id)touches withEvent:(id)event {
  [super touchesBegan:touches withEvent:event];
}
- (void)touchesMoved:(id)touches withEvent:(id)event {
  (void)touches;
  (void)event;
  self.backgroundColor = [UIColor yellowColor];
}
- (void)touchesEnded:(id)touches withEvent:(id)event {
  (void)touches;
  (void)event;
  self.backgroundColor = [UIColor greenColor];
}
@end

static UIView *gView;
static unsigned gTick;

@interface AppDelegate : NSObject
- (BOOL)application:(id)application didFinishLaunchingWithOptions:(id)options;
- (void)tick:(id)ignored;
- (void)buttonTapped:(id)sender;
- (void)applicationDidBecomeActive:(id)application;
- (void)applicationWillTerminate:(id)application;
@end

@implementation AppDelegate
- (BOOL)application:(id)application didFinishLaunchingWithOptions:(id)options {
  (void)application;
  (void)options;
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 375, 667)];
  TapView *view = [[TapView alloc] initWithFrame:CGRectMake(20, 20, 200, 100)];
  gView = view;
  view.backgroundColor = [UIColor redColor];
  [window addSubview:view];
  UIView *overlay = [[UIView alloc] initWithFrame:CGRectMake(250, 20, 100, 100)];
  overlay.backgroundColor = [UIColor greenColor];
  [overlay setAlpha:0.5];
  [window addSubview:overlay];
  UIView *container = [[UIView alloc] initWithFrame:CGRectMake(20, 140, 200, 100)];
  container.backgroundColor = [UIColor grayColor];
  [window addSubview:container];
  TapView *nested = [[TapView alloc] initWithFrame:CGRectMake(10, 10, 80, 40)];
  nested.backgroundColor = [UIColor redColor];
  [container addSubview:nested];
  UILabel *label = [[UILabel alloc] initWithFrame:CGRectMake(20, 400, 300, 40)];
  [label setText:"HELLO 42"];
  [label setTextColor:[UIColor blackColor]];
  [label setTextAlignment:1];
  [window addSubview:label];
  UIButton *button = [[UIButton alloc] initWithFrame:CGRectMake(20, 300, 200, 60)];
  [button addTarget:self
             action:@selector(buttonTapped:)
   forControlEvents:UIControlEventTouchUpInside];
  [window addSubview:button];
  [window makeKeyAndVisible];
  return YES;
}

- (void)applicationDidBecomeActive:(id)application {
  (void)application;
}
- (void)applicationWillTerminate:(id)application {
  (void)application;
}
- (void)buttonTapped:(id)sender {
  (void)sender;
  gView.backgroundColor = [UIColor orangeColor];
}

- (void)tick:(id)ignored {
  (void)ignored;
  gTick++;
  CGFloat x = 20 + (gTick & 3) * 40;
  [gView setFrame:CGRectMake(x, 20, 200, 100)];
}
@end

int main(void) {
  return UIApplicationMain(0, 0, 0, "AppDelegate");
}

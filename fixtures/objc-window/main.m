// Real-compiler fixture for the native track's UIKit proof of concept.
//
// Built by scripts/build-objc-fixture.sh with clang. It uses only the
// clean-room shim header next to it: no Apple SDK, no Foundation, no UIKit.
// The shape mirrors the generated fixture in
// packages/darwin-compat/src/objc/build-ui-demo.ts so the two render the same
// frame.

#import "UIKitShim.h"

@protocol Tappable
@end

@interface TapView : UIView <Tappable> {
  BOOL _pressed;
}
@end

@implementation TapView
- (void)touchesBegan:(id)touches withEvent:(id)event {
  (void)touches;
  (void)event;
  if ([self conformsToProtocol:@protocol(Tappable)]) {
    self.backgroundColor = [UIColor blueColor];
  } else {
    self.backgroundColor = [UIColor purpleColor];
  }
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
  [window makeKeyAndVisible];
  return YES;
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

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
  _pressed = YES;
  if ([self conformsToProtocol:@protocol(Tappable)]) {
    self.backgroundColor = [UIColor blueColor];
  } else {
    self.backgroundColor = [UIColor purpleColor];
  }
}
- (void)touchesEnded:(id)touches withEvent:(id)event {
  (void)touches;
  (void)event;
  _pressed = NO;
  self.backgroundColor = [UIColor greenColor];
}
@end

@interface AppDelegate : NSObject
- (BOOL)application:(id)application didFinishLaunchingWithOptions:(id)options;
@end

@implementation AppDelegate
- (BOOL)application:(id)application didFinishLaunchingWithOptions:(id)options {
  (void)application;
  (void)options;
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 375, 667)];
  TapView *view = [[TapView alloc] initWithFrame:CGRectMake(20, 20, 200, 100)];
  view.backgroundColor = [UIColor redColor];
  [window addSubview:view];
  [window makeKeyAndVisible];
  return YES;
}
@end

int main(void) {
  return UIApplicationMain(0, 0, 0, "AppDelegate");
}

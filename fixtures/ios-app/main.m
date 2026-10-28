// Minimal stock-SDK UIKit app used by scripts/spike-ios-symbols.ts.
//
// It is NOT part of the runtime fixtures: it exists only to measure how many
// Apple framework and runtime symbols a real (unmodified, SDK-linked) app
// needs before this compatibility layer can execute it. The script compiles it
// against the local iOS Simulator SDK and lists the undefined symbols; the
// binary is never committed.
//
// Deliberately boring: one window, one label, one button, user defaults, a log
// line, an array/dictionary literal, and a block-based animation.

#import <UIKit/UIKit.h>

// One-ivar subclasses whose only purpose is measurement: each subclass's first
// ivar offset is the aligned instance size of its framework superclass. They
// add no behaviour and are never instantiated.
@interface SampleView : UIView {
  id _sampleView;
}
@end
@implementation SampleView
@end

@interface SampleLabel : UILabel {
  id _sampleLabel;
}
@end
@implementation SampleLabel
@end

@interface SampleButton : UIButton {
  id _sampleButton;
}
@end
@implementation SampleButton
@end

@interface SampleWindow : UIWindow {
  id _sampleWindow;
}
@end
@implementation SampleWindow
@end

@interface SampleController : UIViewController {
  id _sampleController;
}
@end
@implementation SampleController
@end

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@property (nonatomic, strong) UILabel *label;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  (void)application;
  (void)launchOptions;
  // Keep the measurement subclasses reachable for the linker.
  volatile Class samples[] = {[SampleView class], [SampleLabel class], [SampleButton class],
                              [SampleWindow class], [SampleController class]};
  (void)samples;
  NSLog(@"stock app launching");

  self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
  UIViewController *controller = [[UIViewController alloc] init];
  controller.view.backgroundColor = [UIColor whiteColor];

  self.label = [[UILabel alloc] initWithFrame:CGRectMake(20, 100, 300, 40)];
  self.label.text = @"Hello from UIKit";
  self.label.textAlignment = NSTextAlignmentCenter;
  [controller.view addSubview:self.label];

  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  button.frame = CGRectMake(20, 200, 300, 44);
  [button setTitle:@"Tap" forState:UIControlStateNormal];
  [button addTarget:self
                action:@selector(tapped:)
      forControlEvents:UIControlEventTouchUpInside];
  [controller.view addSubview:button];

  NSArray *names = @[ @"alpha", @"beta" ];
  NSDictionary *info = @{@"count" : @(names.count)};
  [[NSUserDefaults standardUserDefaults] setInteger:[info[@"count"] integerValue]
                                             forKey:@"taps"];

  [UIView animateWithDuration:0.25
                   animations:^{
                     button.alpha = 0.5;
                   }];

  self.window.rootViewController = controller;
  [self.window makeKeyAndVisible];
  return YES;
}

- (void)tapped:(UIButton *)sender {
  (void)sender;
  NSInteger taps = [[NSUserDefaults standardUserDefaults] integerForKey:@"taps"];
  [[NSUserDefaults standardUserDefaults] setInteger:taps + 1 forKey:@"taps"];
  self.label.text = [NSString stringWithFormat:@"Taps: %ld", (long)taps + 1];
}

@end

int main(int argc, char *argv[]) {
  return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
}

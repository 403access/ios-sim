#import <UIKit/UIKit.h>

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];

  UIViewController *controller = [[UIViewController alloc] init];
  controller.view.backgroundColor = [UIColor systemBackgroundColor];

  UILabel *label = [[UILabel alloc] initWithFrame:CGRectInset(controller.view.bounds, 24, 24)];
  label.text = @"Hello from the iOS Simulator";
  label.textAlignment = NSTextAlignmentCenter;
  label.numberOfLines = 0;
  label.font = [UIFont systemFontOfSize:30 weight:UIFontWeightSemibold];
  label.autoresizingMask =
      UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [controller.view addSubview:label];

  self.window.rootViewController = controller;
  [self.window makeKeyAndVisible];
  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
  }
}

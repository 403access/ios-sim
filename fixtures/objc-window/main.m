// Real-compiler fixture for the native track's UIKit proof of concept.
//
// Built by scripts/build-objc-fixture.sh with clang. It uses only the
// clean-room shim header next to it: no Apple SDK, no Foundation, no UIKit.
// The shape mirrors the generated fixture in
// packages/darwin-compat/src/objc/build-ui-demo.ts so the two render the same
// frame.

#import "UIKitShim.h"

void NSLog(const char *message);

void objc_setAssociatedObject(id object, const void *key, id value, unsigned long policy);
id objc_getAssociatedObject(id object, const void *key);

static char kColorKey;
static int gBaseInit;
static int gTapInit;
static int gInitOrder;
static int gLifecycle;
static int gAppear;
static int gString;
static int gCollections;
static NSMutableArray *gColors;
static NSMutableDictionary *gTheme;
static NSMutableArray *gTimerColors;
static UIView *gStatus;
static int gTimerFires;
static int gSwitchChanges;
static int gSliderChanges;
static UISlider *gSlider;
static int gDelayed;
static int gBundle;
static int gGesture;
static BOOL gLiteralOK;
static BOOL gScreenOK;
static int gSegment = -1;
static UIWindow *gWindow;
static UINavigationController *gNav;
static UITableView *gTable;
static UIProgressView *gProgress;
static int gTableRow = -1;
static UILabel *gLabel;

@interface UIViewController (Lifecycle)
- (void)viewDidLoad;
- (void)viewWillAppear:(BOOL)animated;
- (void)viewDidAppear:(BOOL)animated;
@end

@implementation UIViewController (Lifecycle)
- (void)viewDidLoad {
  gLifecycle = 1;
}
- (void)viewWillAppear:(BOOL)animated {
  (void)animated;
  gAppear = gAppear * 10 + 1;
}
- (void)viewDidAppear:(BOOL)animated {
  (void)animated;
  gAppear = gAppear * 10 + 2;
}
@end

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
  if (!(gBaseInit && gTapInit && gInitOrder == 2 && gLifecycle == 1 && gString == 1 &&
        gCollections == 1 && gBundle == 1 && gLiteralOK && gScreenOK)) {
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
  // An inherited ivar: the runtime must have patched its offset slot to land
  // after UIView's layout, not at the compiler's placeholder.
  _pressed = YES;
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
  self.backgroundColor = _pressed ? [UIColor greenColor] : [UIColor purpleColor];
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
- (void)themeChanged:(id)notification;
- (void)timerFired:(id)timer;
- (void)switchChanged:(id)sender;
- (void)sliderChanged:(id)sender;
- (void)delayedTick:(id)object;
- (void)gestureTapped:(id)recognizer;
- (void)segmentChanged:(id)sender;
- (void)openScreen:(id)sender;
- (void)rowSelected:(id)sender;
@end

@implementation AppDelegate
- (BOOL)application:(id)application didFinishLaunchingWithOptions:(id)options {
  (void)application;
  (void)options;
  NSLog("hello from clang objc");
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  [defaults setBool:YES forKey:"Seen"];
  (void)[defaults boolForKey:"Seen"];
  [defaults setInteger:7 forKey:"Count"];
  (void)[defaults integerForKey:"Count"];
  UIWindow *window = [[UIWindow alloc] initWithFrame:CGRectMake(0, 0, 375, 667)];
  gWindow = window;
  TapView *view = [[TapView alloc] initWithFrame:CGRectMake(20, 20, 200, 100)];
  gView = view;
  view.backgroundColor = [UIColor redColor];
  [window addSubview:view];
  UIView *overlay = [[UIView alloc] initWithFrame:CGRectMake(250, 20, 100, 100)];
  overlay.backgroundColor = [UIColor greenColor];
  [overlay setAlpha:0.5];
  [[overlay layer] setCornerRadius:12];
  [window addSubview:overlay];
  UIView *container = [[UIView alloc] initWithFrame:CGRectMake(20, 140, 200, 100)];
  container.backgroundColor = [UIColor grayColor];
  [window addSubview:container];
  TapView *nested = [[TapView alloc] initWithFrame:CGRectMake(10, 10, 80, 40)];
  nested.backgroundColor = [UIColor redColor];
  [container addSubview:nested];
  UIView *clipChild = [[UIView alloc] initWithFrame:CGRectMake(150, 50, 100, 40)];
  clipChild.backgroundColor = [UIColor redColor];
  [container addSubview:clipChild];
  [container setClipsToBounds:YES];
  UIScrollView *scroll = [[UIScrollView alloc] initWithFrame:CGRectMake(20, 470, 300, 80)];
  [scroll setContentSize:CGSizeMake(300, 200)];
  [scroll setContentOffset:CGPointMake(0, 80)];
  [window addSubview:scroll];
  UIView *scrollRed = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 300, 80)];
  scrollRed.backgroundColor = [UIColor redColor];
  [scroll addSubview:scrollRed];
  UIView *scrollBlue = [[UIView alloc] initWithFrame:CGRectMake(0, 80, 300, 120)];
  scrollBlue.backgroundColor = [UIColor blueColor];
  [scroll addSubview:scrollBlue];
  UIView *band = [[UIView alloc] initWithFrame:CGRectMake(0, 160, 300, 40)];
  band.backgroundColor = [UIColor yellowColor];
  [scroll addSubview:band];
  UIViewController *controller = [[UIViewController alloc] init];
  [window setRootViewController:controller];
  UILabel *label = [[UILabel alloc] initWithFrame:CGRectMake(20, 400, 300, 40)];
  gLabel = label;
  gColors = [NSMutableArray array];
  [gColors addObject:[UIColor redColor]];
  [gColors addObject:[UIColor purpleColor]];
  gTheme = [NSMutableDictionary dictionary];
  [gTheme setObject:[gColors objectAtIndex:1] forKey:"theme"];
  NSNumber *number = [NSNumber numberWithInt:5];
  if ([gColors count] == 2 && [gTheme count] == 1 && [number intValue] + 1 == 6) {
    gCollections = 1;
  }
  NSString *text = [NSString stringWithUTF8String:"HELLO 42"];
  [label setText:text];
  if ([[label text] isEqualToString:text] && [[label text] length] == 8) {
    gString = 1;
  }
  [label setTextColor:[UIColor blackColor]];
  [label setTextAlignment:1];
  [window addSubview:label];
  [[NSNotificationCenter defaultCenter] addObserver:self
                                         selector:@selector(themeChanged:)
                                             name:"ThemeChanged"
                                           object:nil];
  gStatus = [[UIView alloc] initWithFrame:CGRectMake(0, 620, 375, 40)];
  [window addSubview:gStatus];
  gTimerColors = [NSMutableArray array];
  [gTimerColors addObject:[UIColor greenColor]];
  [gTimerColors addObject:[UIColor orangeColor]];
  [NSTimer scheduledTimerWithTimeInterval:1
                                   target:self
                                 selector:@selector(timerFired:)
                                  repeats:YES];
  UIButton *button = [[UIButton alloc] initWithFrame:CGRectMake(20, 300, 200, 60)];
  [button addTarget:self
             action:@selector(buttonTapped:)
   forControlEvents:UIControlEventTouchUpInside];
  [window addSubview:button];
  UISwitch *toggle = [[UISwitch alloc] initWithFrame:CGRectMake(280, 310, 60, 32)];
  [toggle addTarget:self
             action:@selector(switchChanged:)
   forControlEvents:UIControlEventValueChanged];
  [window addSubview:toggle];
  UILabel *wrapped = [[UILabel alloc] initWithFrame:CGRectMake(20, 240, 300, 60)];
  [wrapped setText:[NSString stringWithUTF8String:"WRAP THE LABEL\nSECOND LINE"]];
  [wrapped setNumberOfLines:0];
  [window addSubview:wrapped];
  NSBundle *bundle = [NSBundle mainBundle];
  NSString *iconPath = [bundle pathForResource:"assets/icon" ofType:"png"];
  NSString *missingPath = [bundle pathForResource:"nope" ofType:"png"];
  NSString *jsonText =
      [NSString stringWithUTF8String:"{\"count\":3,\"items\":[\"a\",\"b\"]}"];
  NSData *jsonData = [jsonText dataUsingEncoding:4];
  NSDictionary *parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:0];
  BOOL jsonOK = [[parsed objectForKey:"count"] intValue] == 3 &&
                [[parsed objectForKey:"items"] count] == 2;
  NSString *formatted = [NSString stringWithFormat:"%s-%d", "OK", 7];
  BOOL formatOK = [formatted isEqualToString:[NSString stringWithUTF8String:"OK-7"]];
  NSData *data = [NSData dataWithContentsOfFile:iconPath];
  UIImage *named = [UIImage imageNamed:"assets/icon.png"];
  UIImage *icon = [UIImage imageWithData:data];
  if (iconPath != nil && missingPath == nil && named != nil && icon != nil &&
      [data length] > 0 && formatOK && jsonOK) {
    gBundle = 1;
  }
  UIImageView *picture = [[UIImageView alloc] initWithImage:icon];
  [picture setFrame:CGRectMake(250, 140, 80, 80)];
  [window addSubview:picture];
  UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc]
      initWithTarget:self
              action:@selector(gestureTapped:)];
  [picture addGestureRecognizer:tap];
  [UIView animateWithDuration:2
                   animations:^{
                     picture.alpha = 0.25;
                   }];
  NSMutableArray *items = [NSMutableArray array];
  [items addObject:[NSString stringWithUTF8String:"ONE"]];
  [items addObject:[NSString stringWithUTF8String:"TWO"]];
  UIViewController *root = [[UIViewController alloc] init];
  [root setTitle:"ROOT"];
  root.view.backgroundColor = [UIColor orangeColor];
  UIViewController *detail = [[UIViewController alloc] init];
  [detail setTitle:"DETAIL"];
  detail.view.backgroundColor = [UIColor purpleColor];
  NSArray *literalRows = @[ @"ALPHA", @"BETA" ];
  UIScreen *screen = [UIScreen mainScreen];
  CGRect screenBounds = [screen bounds];
  gScreenOK = screenBounds.size.width == 375 && screenBounds.size.height == 667 &&
              [screen scale] == 2 &&
              [NSStringFromClass([AppDelegate class]) isEqualToString:@"AppDelegate"];
  NSDictionary *literalDict = @{ @"key" : @"VALUE" };
  gLiteralOK = literalRows.count == 2 &&
               [[literalRows objectAtIndex:1] isEqualToString:@"BETA"] &&
               [[literalDict objectForKey:"key"] isEqualToString:@"VALUE"];
  NSMutableArray *rows = [NSMutableArray array];
  [rows addObject:[NSString stringWithUTF8String:"ALPHA"]];
  [rows addObject:[NSString stringWithUTF8String:"BETA"]];
  [rows addObject:[NSString stringWithUTF8String:"GAMMA"]];
  [rows addObject:[NSString stringWithUTF8String:"DELTA"]];
  UIView *rotated = [[UIView alloc] initWithFrame:CGRectMake(20, 200, 80, 80)];
  rotated.backgroundColor = [UIColor redColor];
  [rotated setTransform:CGAffineTransformMakeRotation(0.7853981633974483)];
  [detail.view addSubview:rotated];
  gProgress = [[UIProgressView alloc] initWithProgressViewStyle:0];
  [gProgress setFrame:CGRectMake(20, 320, 300, 6)];
  [gProgress setProgress:0.5];
  [detail.view addSubview:gProgress];
  gTable = [[UITableView alloc] initWithFrame:CGRectMake(20, 60, 300, 120)];
  [gTable setRowHeight:30];
  [gTable setRows:rows];
  [gTable addTarget:self
             action:@selector(rowSelected:)
   forControlEvents:UIControlEventValueChanged];
  [detail.view addSubview:gTable];
  gNav = [[UINavigationController alloc] initWithRootViewController:root];
  [gNav pushViewController:detail animated:NO];
  UIButton *open = [[UIButton alloc] initWithFrame:CGRectMake(20, 586, 140, 28)];
  open.backgroundColor = [UIColor grayColor];
  UILabel *openLabel = [[UILabel alloc] initWithFrame:CGRectMake(0, 0, 140, 28)];
  [openLabel setText:[NSString stringWithUTF8String:"OPEN"]];
  [openLabel setTextAlignment:1];
  [open addSubview:openLabel];
  [open addTarget:self
              action:@selector(openScreen:)
    forControlEvents:UIControlEventTouchUpInside];
  [window addSubview:open];
  UISegmentedControl *segments = [[UISegmentedControl alloc] initWithItems:items];
  [segments setFrame:CGRectMake(20, 364, 200, 30)];
  [segments addTarget:self
                action:@selector(segmentChanged:)
      forControlEvents:UIControlEventValueChanged];
  [window addSubview:segments];
  gSlider = [[UISlider alloc] initWithFrame:CGRectMake(20, 560, 300, 24)];
  [gSlider addTarget:self
              action:@selector(sliderChanged:)
    forControlEvents:UIControlEventValueChanged];
  [window addSubview:gSlider];
  [self performSelector:@selector(delayedTick:) withObject:nil afterDelay:0.5];
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
  NSMutableDictionary *info = [NSMutableDictionary dictionary];
  [info setObject:[NSNumber numberWithInt:7] forKey:"count"];
  [[NSNotificationCenter defaultCenter] postNotificationName:"ThemeChanged"
                                                   object:nil
                                                 userInfo:info];
}

- (void)themeChanged:(id)notification {
  (void)notification;
  NSNumber *count = [[notification userInfo] objectForKey:"count"];
  // load before appearance, the appearance callbacks in order, and userInfo.
  BOOL ready = gLifecycle == 1 && gAppear == 12 && [count intValue] == 7;
  UIColor *color = [gTheme objectForKey:"theme"];
  gView.backgroundColor = ready ? color : [UIColor blackColor];
}

- (void)switchChanged:(id)sender {
  (void)sender;
  gSwitchChanges++;
}

- (void)rowSelected:(id)sender {
  gTableRow = (int)[sender selectedRow];
  [gProgress setProgress:0.75];
}

- (void)openScreen:(id)sender {
  (void)sender;
  [gWindow addSubview:[gNav view]];
}

- (void)segmentChanged:(UISegmentedControl *)sender {
  gSegment = (int)[sender selectedSegmentIndex];
}

- (void)gestureTapped:(id)recognizer {
  (void)recognizer;
  gGesture = 1;
  [gLabel setText:@"TAPPED"];
}

- (void)delayedTick:(id)object {
  (void)object;
  gDelayed++;
}

- (void)sliderChanged:(id)sender {
  (void)sender;
  gSliderChanges++;
}

- (void)timerFired:(id)timer {
  (void)timer;
  UIColor *color = [gTimerColors objectAtIndex:(unsigned long)(gTimerFires & 1)];
  gStatus.backgroundColor = color;
  gTimerFires++;
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

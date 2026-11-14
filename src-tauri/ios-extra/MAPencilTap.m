// V225 (M-2b-3b-2・親§6-7・D-M2-3・C17・指示書 ■3 の P): Apple Pencil のダブルタップを受けて、画面（WKWebView）の JS の口へ渡す。
//
// ★Cargo の依存を足さない形（Tauri のプラグインにしない）: このファイルを scripts/mobile_build.ts が gen/apple の Sources へ写し、
//  Xcode のプロジェクトに入れる（gen/apple は作り直されるので、登録は台本の役目。入っていなければ台本が断る）。
// ★読み込みのとき（+load）に知らせを待ち、ウィンドウが前に出たら WKWebView を探して UIPencilInteraction を付ける。
//  たたかれたら、OS の設定（UIPencilInteraction.preferredTapAction）を決まった英字にして、JS の `window.__mbPencilTap(字)` を呼ぶ。
//  何をするかは JS の側（src/mobileApp/ios/pencilTap.ts）。ここは受けて渡すだけ（作品・設定・ファイルに触らない・通信しない）。
// ★付いたことは、頁の頭で `window.__mbPencilAttached = true` を立てて見えるようにする（確かめ画面の印のビルドが出す）。
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

@interface MAPencilTap : NSObject <UIPencilInteractionDelegate>
@end

static MAPencilTap *maShared = nil;
static __weak WKWebView *maAttached = nil;

@implementation MAPencilTap

+ (void)load {
  maShared = [[MAPencilTap alloc] init];
  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserver:maShared selector:@selector(tryAttach) name:UIWindowDidBecomeKeyNotification object:nil];
  [nc addObserver:maShared selector:@selector(tryAttach) name:UIApplicationDidBecomeActiveNotification object:nil];
}

- (WKWebView *)findWebView:(UIView *)view {
  if ([view isKindOfClass:[WKWebView class]]) return (WKWebView *)view;
  for (UIView *sub in view.subviews) {
    WKWebView *hit = [self findWebView:sub];
    if (hit) return hit;
  }
  return nil;
}

- (void)tryAttach {
  if (maAttached) return;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      WKWebView *web = [self findWebView:window];
      if (!web) continue;
      UIPencilInteraction *interaction = [[UIPencilInteraction alloc] init];
      interaction.delegate = self;
      [web addInteraction:interaction];
      maAttached = web;
      NSString *mark = @"window.__mbPencilAttached = true;";
      WKUserScript *script = [[WKUserScript alloc] initWithSource:mark injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
      [web.configuration.userContentController addUserScript:script];
      [web evaluateJavaScript:mark completionHandler:nil];
      return;
    }
  }
}

- (void)send {
  WKWebView *web = maAttached;
  if (!web) return;
  NSString *action = @"other";
  switch (UIPencilInteraction.preferredTapAction) {
    case UIPencilPreferredActionIgnore: action = @"ignore"; break;
    case UIPencilPreferredActionSwitchEraser: action = @"switchEraser"; break;
    case UIPencilPreferredActionSwitchPrevious: action = @"switchPrevious"; break;
    case UIPencilPreferredActionShowColorPalette: action = @"showColorPalette"; break;
    default: action = @"other"; break;
  }
  NSString *js = [NSString stringWithFormat:@"window.__mbPencilTap && window.__mbPencilTap('%@');", action];
  [web evaluateJavaScript:js completionHandler:nil];
}

// iOS 17.5 から（こちらがあれば、こちらが呼ばれる）
- (void)pencilInteraction:(UIPencilInteraction *)interaction didReceiveTap:(UIPencilInteractionTap *)tap API_AVAILABLE(ios(17.5)) {
  [self send];
}

// それより前の形（新しい方が呼ばれる OS では呼ばれない）
- (void)pencilInteractionDidTap:(UIPencilInteraction *)interaction {
  [self send];
}

@end

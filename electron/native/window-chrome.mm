#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <node_api.h>
#include <cstring>

static BOOL IsBrowser(NSRunningApplication* app) {
  if (!app || app.terminated || app.processIdentifier == NSProcessInfo.processInfo.processIdentifier) return NO;
  NSBundle* bundle = [NSBundle bundleWithURL:app.bundleURL];
  for (NSDictionary* type in [bundle objectForInfoDictionaryKey:@"CFBundleURLTypes"]) {
    for (NSString* scheme in type[@"CFBundleURLSchemes"]) {
      if ([scheme.lowercaseString isEqualToString:@"http"] || [scheme.lowercaseString isEqualToString:@"https"]) return YES;
    }
  }
  return NO;
}

@interface AilyBrowserTracker : NSObject
@property(nonatomic, strong) NSRunningApplication* lastBrowser;
@property(nonatomic, strong) id observer;
- (void)stop;
@end
@implementation AilyBrowserTracker
- (void)stop {
  if (self.observer) [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self.observer];
  self.observer = nil; self.lastBrowser = nil;
}
@end

static void ReleaseBrowserObject(napi_env env, void* data, void* hint) {
  id object = CFBridgingRelease(data);
  if ([object isKindOfClass:AilyBrowserTracker.class]) [(AilyBrowserTracker*)object stop];
}

static napi_value BeginBrowserTracking(napi_env env, napi_callback_info info) {
  AilyBrowserTracker* tracker = [AilyBrowserTracker new];
  NSRunningApplication* front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (IsBrowser(front)) tracker.lastBrowser = front;
  __weak AilyBrowserTracker* weakTracker = tracker;
  tracker.observer = [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification
    object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification* notification) {
      NSRunningApplication* app = notification.userInfo[NSWorkspaceApplicationKey];
      if (IsBrowser(app)) weakTracker.lastBrowser = app;
    }];
  napi_value result;
  napi_create_external(env, (__bridge_retained void*)tracker, ReleaseBrowserObject, nullptr, &result);
  return result;
}

static napi_value CaptureBrowser(napi_env env, napi_callback_info info) {
  napi_value arg, result; size_t count = 1; void* data = nullptr;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (count != 1 || napi_get_value_external(env, arg, &data) != napi_ok) return nullptr;
  AilyBrowserTracker* tracker = (__bridge AilyBrowserTracker*)data;
  NSRunningApplication* browser = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!IsBrowser(browser)) browser = tracker.lastBrowser;
  if (!IsBrowser(browser)) {
    // On a cold protocol launch Aily may already be foreground. Read only window
    // ownership/z-order, never window titles, pixels, browser history or URLs.
    NSArray* windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSDictionary* window in windows) {
      if ([window[(__bridge NSString*)kCGWindowLayer] intValue] != 0) continue;
      NSRunningApplication* candidate = [NSRunningApplication runningApplicationWithProcessIdentifier:[window[(__bridge NSString*)kCGWindowOwnerPID] intValue]];
      if (IsBrowser(candidate)) { browser = candidate; break; }
    }
  }
  if (IsBrowser(browser)) napi_create_external(env, (__bridge_retained void*)browser, ReleaseBrowserObject, nullptr, &result);
  else napi_get_null(env, &result);
  return result;
}

static napi_value RestoreBrowser(napi_env env, napi_callback_info info) {
  napi_value arg, result; size_t count = 1; void* data = nullptr;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (count != 1 || napi_get_value_external(env, arg, &data) != napi_ok) return nullptr;
  NSRunningApplication* browser = (__bridge NSRunningApplication*)data;
  NSRunningApplication* front = NSWorkspace.sharedWorkspace.frontmostApplication;
  BOOL restored = NO;
  if (IsBrowser(browser) && front.processIdentifier == browser.processIdentifier) restored = YES;
  else if (IsBrowser(browser) && front.processIdentifier == NSProcessInfo.processInfo.processIdentifier) {
    // Respect a user switching to a different app while the network completes.
    if (@available(macOS 14.0, *)) [NSApp yieldActivationToApplication:browser];
    restored = [browser activateWithOptions:0];
  }
  napi_get_boolean(env, restored, &result);
  return result;
}

static napi_value EndBrowserTracking(napi_env env, napi_callback_info info) {
  napi_value arg, result; size_t count = 1; void* data = nullptr;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (count != 1 || napi_get_value_external(env, arg, &data) != napi_ok) return nullptr;
  [(__bridge AilyBrowserTracker*)data stop];
  napi_get_undefined(env, &result); return result;
}

@interface AilyConsentShield : NSView
@end
@implementation AilyConsentShield
- (void)drawRect:(NSRect)rect {
  [[NSColor colorWithWhite:0 alpha:0.24] setFill];
  NSRectFillUsingOperation(rect, NSCompositingOperationSourceOver);
}
@end

// Consume events in the owner instead of making it ignore mouse events. This
// keeps a titled child window without AppKit's titleless sheet or click-through.
@interface AilyConsentGate : NSObject
@property(nonatomic, weak) NSWindow* owner;
@property(nonatomic, weak) NSWindow* child;
@property(nonatomic, strong) NSView* shield;
@property(nonatomic, strong) id monitor;
@property(nonatomic) BOOL active;
@property(nonatomic) NSTimeInterval lastAttention;
- (void)stop;
@end

@implementation AilyConsentGate
- (void)attention {
  if (!self.active || !self.child.visible) return;
  [self.child makeKeyAndOrderFront:nil];
  NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
  if (now - self.lastAttention < 0.4) return;
  self.lastAttention = now;
  __weak AilyConsentGate* weakSelf = self;
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
    context.duration = 0.10;
    weakSelf.child.contentView.animator.alphaValue = 0.65;
  } completionHandler:^{
    if (!weakSelf.active) return;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
      context.duration = 0.18;
      weakSelf.child.contentView.animator.alphaValue = 1;
    } completionHandler:nil];
  }];
}
- (void)start {
  self.active = YES;
  self.shield = [[AilyConsentShield alloc] initWithFrame:self.owner.contentView.bounds];
  self.shield.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [self.owner.contentView addSubview:self.shield positioned:NSWindowAbove relativeTo:nil];
  __weak AilyConsentGate* weakSelf = self;
  NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged
      | NSEventMaskRightMouseDown | NSEventMaskRightMouseUp | NSEventMaskRightMouseDragged
      | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp | NSEventMaskOtherMouseDragged
      | NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged | NSEventMaskScrollWheel
      | NSEventMaskGesture | NSEventMaskMagnify | NSEventMaskSwipe | NSEventMaskRotate;
  self.monitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent*(NSEvent* event) {
    AilyConsentGate* gate = weakSelf;
    if (!gate.active || event.window != gate.owner) return event;
    if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown
        || event.type == NSEventTypeOtherMouseDown || event.type == NSEventTypeKeyDown) [gate attention];
    return nil;
  }];
}
- (void)stop {
  if (!self.active) return;
  self.active = NO;
  if (self.monitor) [NSEvent removeMonitor:self.monitor];
  [self.shield removeFromSuperview];
  self.child.contentView.alphaValue = 1;
  self.monitor = nil; self.shield = nil;
}
@end

static NSWindow* Window(napi_env env, napi_value handle) {
  void* data = nullptr;
  size_t size = 0;
  if (![NSThread isMainThread] || napi_get_buffer_info(env, handle, &data, &size) != napi_ok || size != sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "Expected a native window handle on the main thread");
    return nil;
  }
  void* pointer = nullptr;
  std::memcpy(&pointer, data, sizeof(pointer));
  NSView* view = (__bridge NSView*)pointer;
  NSWindow* window = view.window;
  if (!window) napi_throw_error(env, nullptr, "The native window is no longer available");
  return window;
}

static napi_value CloseOnly(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2) { napi_throw_type_error(env, nullptr, "Expected handle and dark appearance"); return nullptr; }
  NSWindow* window = Window(env, args[0]);
  if (!window) return nullptr;
  bool dark = false;
  if (napi_get_value_bool(env, args[1], &dark) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a dark appearance boolean"); return nullptr;
  }
  window.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
  [[window standardWindowButton:NSWindowCloseButton] setHidden:NO];
  [[window standardWindowButton:NSWindowMiniaturizeButton] setHidden:YES];
  [[window standardWindowButton:NSWindowZoomButton] setHidden:YES];
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value IgnoresMouse(napi_env env, napi_callback_info info) {
  napi_value handle, result;
  size_t count = 1;
  napi_get_cb_info(env, info, &count, &handle, nullptr, nullptr);
  if (count != 1) { napi_throw_type_error(env, nullptr, "Expected a native window handle"); return nullptr; }
  NSWindow* window = Window(env, handle);
  if (!window) return nullptr;
  napi_get_boolean(env, window.ignoresMouseEvents, &result);
  return result;
}

static void ReleaseGate(napi_env env, void* data, void* hint) {
  AilyConsentGate* gate = (__bridge_transfer AilyConsentGate*)data;
  [gate stop];
}

static napi_value BeginGate(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2) { napi_throw_type_error(env, nullptr, "Expected owner and child handles"); return nullptr; }
  NSWindow* owner = Window(env, args[0]);
  if (!owner) return nullptr;
  NSWindow* child = Window(env, args[1]);
  if (!child) return nullptr;
  AilyConsentGate* gate = [AilyConsentGate new];
  gate.owner = owner; gate.child = child;
  [gate start];
  napi_create_external(env, (__bridge_retained void*)gate, ReleaseGate, nullptr, &result);
  return result;
}

static napi_value EndGate(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t count = 1; void* data = nullptr;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (count != 1 || napi_get_value_external(env, arg, &data) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a consent input gate"); return nullptr;
  }
  [(__bridge AilyConsentGate*)data stop];
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"setCloseOnlyControls", nullptr, CloseOnly, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getIgnoresMouseEvents", nullptr, IgnoresMouse, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"beginConsentGate", nullptr, BeginGate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"endConsentGate", nullptr, EndGate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"beginBrowserTracking", nullptr, BeginBrowserTracking, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"captureBrowser", nullptr, CaptureBrowser, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"restoreBrowser", nullptr, RestoreBrowser, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"endBrowserTracking", nullptr, EndBrowserTracking, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
NAPI_MODULE(window_chrome, Init)

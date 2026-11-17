#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

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

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"setCloseOnlyControls", nullptr, CloseOnly, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getIgnoresMouseEvents", nullptr, IgnoresMouse, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, methods);
  return exports;
}
NAPI_MODULE(window_chrome, Init)

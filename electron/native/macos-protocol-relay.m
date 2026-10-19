#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>

@interface AilyProtocolRelay : NSObject <NSApplicationDelegate>

@end
@implementation AilyProtocolRelay
- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls {
    NSDictionary *info = NSBundle.mainBundle.infoDictionary;
    NSArray *schemes = info[@"CFBundleURLTypes"][0][@"CFBundleURLSchemes"];

    for (NSURL *url in urls) {
        if (![schemes containsObject:url.scheme.lowercaseString]) continue;

        NSTask *task = [NSTask new];

        task.executableURL = [NSURL fileURLWithPath:info[@"AilyElectronExecutable"]];
        task.arguments = [info[@"AilyElectronArguments"] arrayByAddingObject:url.absoluteString];
        task.currentDirectoryURL = [NSURL fileURLWithPath:info[@"AilyWorkingDirectory"]];
        task.standardInput = NSFileHandle.fileHandleWithNullDevice;
        task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
        task.standardError = NSFileHandle.fileHandleWithNullDevice;
        NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];

        [environment removeObjectForKey:@"ELECTRON_RUN_AS_NODE"];
        task.environment = environment;

        NSError *error = nil;

        if (![task launchAndReturnError:&error]) {
            fprintf(stderr, "Aily development protocol receiver could not launch its application.\n");
        }
    }

    [application terminate:nil];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSBundle *bundle = NSBundle.mainBundle;

        if (argc == 2 && strcmp(argv[1], "--register") == 0) {
            OSStatus status = LSRegisterURL((__bridge CFURLRef)bundle.bundleURL, true);

            if (status != noErr) return 1;

            NSArray *schemes = bundle.infoDictionary[@"CFBundleURLTypes"][0][@"CFBundleURLSchemes"];

            for (NSString *scheme in schemes) {
                status = LSSetDefaultHandlerForURLScheme((__bridge CFStringRef)scheme,
                    (__bridge CFStringRef)bundle.bundleIdentifier);

                if (status != noErr) return 1;

                NSString *handler = CFBridgingRelease(LSCopyDefaultHandlerForURLScheme((__bridge CFStringRef)scheme));

                if (![handler isEqualToString:bundle.bundleIdentifier]) return 1;
            }

            return 0;
        }

        NSApplication *application = NSApplication.sharedApplication;
        AilyProtocolRelay *delegate = [AilyProtocolRelay new];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [application run];
    }

    return 0;
}

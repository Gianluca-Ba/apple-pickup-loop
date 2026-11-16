#import <Foundation/Foundation.h>
// NSRunningApplication/NSWorkspace properties update at a main run-loop turn.
// Process pending AppKit notifications at each command, never on a timer.
static void appleLoopRefreshApplicationState(void) {
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.001]];
}

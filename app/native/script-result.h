#import <Foundation/Foundation.h>
// Ownership probes serialize a literal JSON boolean. A missing/malformed
// reply proves neither ownership nor its loss and must remain read-only.
static NSString *appleLoopBooleanScriptError(id result, NSString *falseCode) {
  if ([result isKindOfClass:NSString.class] && [result isEqualToString:@"true"]) return nil;
  if ([result isKindOfClass:NSString.class] && [result isEqualToString:@"false"]) return falseCode;
  return @"SAFARI_SCRIPT_UNAVAILABLE";
}

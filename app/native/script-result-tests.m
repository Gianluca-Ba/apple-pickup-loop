#import <Foundation/Foundation.h>
#import "script-result.h"
int main(void) { @autoreleasepool {
  for (NSString *code in @[@"SAFARI_TAB_CHANGED",@"SAFARI_FOREIGN_OWNER",@"APPLE_PAY_CHANGED"]) {
    if (appleLoopBooleanScriptError(@"true",code)) return 1;
    if (![appleLoopBooleanScriptError(@"false",code) isEqualToString:code]) return 2;
    for (id value in @[@"",@"undefined",@"null",@"tru",@"true ",@"\"true\"",@1,@NO,NSNull.null]) {
      if (![appleLoopBooleanScriptError(value,code) isEqualToString:@"SAFARI_SCRIPT_UNAVAILABLE"]) return 3;
    }
    if (![appleLoopBooleanScriptError(nil,code) isEqualToString:@"SAFARI_SCRIPT_UNAVAILABLE"]) return 4;
  }
  puts("Boolean script reply fixtures passed");
} return 0; }

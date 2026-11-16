#import <Foundation/Foundation.h>
#import "application-state.h"
int main(void) { @autoreleasepool {
  for (int i=0;i<4;i++) {
    __block BOOL refreshed=NO;
    CFRunLoopPerformBlock(CFRunLoopGetMain(),kCFRunLoopDefaultMode,^{refreshed=YES;});
    if(refreshed)return 1;
    appleLoopRefreshApplicationState();
    if(!refreshed)return 2;
  }
  puts("Application state refresh fixtures passed");
}return 0;}

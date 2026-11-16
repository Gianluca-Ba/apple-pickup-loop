#import <Foundation/Foundation.h>
#import "window-target.h"

@interface FixtureWindows : NSObject<AppleLoopWindowCollection>
@property NSArray<NSNumber*>*order;
@property BOOL wrongIdentifier;
@end
@interface FixtureReference : NSObject
@property FixtureWindows*owner;
@property NSNumber*identifier;
@property NSInteger position;
@property BOOL positional;
- (NSNumber*)resolvedIdentifier;
@end
@implementation FixtureReference
- (NSNumber*)resolvedIdentifier{return self.positional?(self.position<self.owner.order.count?self.owner.order[self.position]:nil):([self.owner.order containsObject:self.identifier]?self.identifier:nil);}
@end
@implementation FixtureWindows
- (id)objectWithID:(id)identifier{FixtureReference*r=[FixtureReference new];r.owner=self;r.identifier=self.wrongIdentifier?@99:identifier;return r;}
@end

int main(void){@autoreleasepool{
 FixtureWindows*w=[FixtureWindows new];w.order=@[@11,@22];
 FixtureReference*positional=[FixtureReference new];positional.owner=w;positional.positional=YES;positional.position=1;
 id (^read)(id)=^id(FixtureReference*r){return[r resolvedIdentifier];};
 id stable=appleLoopWindowTarget(w,@22,read);NSCAssert(stable&&[read(stable)isEqual:@22],@"existing window resolves");
 w.order=@[@22,@11];NSCAssert(![read(positional)isEqual:@22],@"positional regression reproduced");NSCAssert([read(stable)isEqual:@22],@"unique ID survives raising another window");
 w.order=@[@11];NSCAssert(!appleLoopWindowTarget(w,@22,read),@"a closed target cannot become another window");
 w.order=@[@22,@99];w.wrongIdentifier=YES;NSCAssert(!appleLoopWindowTarget(w,@22,read),@"wrong target is rejected");
 for(id bad in @[@0,@(-1),@"22",NSNull.null])NSCAssert(!appleLoopWindowTarget(w,bad,read),@"invalid target rejected");
 puts("Stable window target fixtures passed");
}return 0;}

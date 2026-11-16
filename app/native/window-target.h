#import <Foundation/Foundation.h>

@protocol AppleLoopWindowCollection <NSObject>
- (id)objectWithID:(id)identifier;
@end

// A positional SBObject can resolve to another window after its z-order
// changes. Preserve the unique-ID specifier through every subsequent read.
static id appleLoopWindowTarget(id<AppleLoopWindowCollection> windows,id identifier,id (^readIdentifier)(id)) {
  if (![identifier isKindOfClass:NSNumber.class] || [identifier integerValue]<=0) return nil;
  id target=[windows objectWithID:identifier];
  if(!target || ![readIdentifier(target) isEqual:identifier])return nil;
  return target;
}

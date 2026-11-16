#import "ax-guard.h"
int main(){@autoreleasepool{
  NSDictionary *sheet=@{@"AXRole":@"AXSheet",@"fixture":@"native-sheet"};
  NSDictionary *modal=@{@"AXRole":@"AXWindow",@"AXModal":@YES,@"fixture":@"native-modal"};
  NSMutableArray *content=[NSMutableArray array];
  for(int i=0;i<5000;i++)[content addObject:@{@"AXRole":@"AXButton"}];
  NSDictionary *web=@{@"AXRole":@"AXWebArea",@"AXChildren":content};
  NSDictionary *root=@{@"AXRole":@"AXApplication",@"AXWindows":@[web,sheet,modal],@"AXChildren":content};
  __block int reads=0;BOOL complete=NO;
  id (^read)(id,CFStringRef)=^id(id node,CFStringRef attribute){reads++;return node[(__bridge NSString*)attribute];};
  NSArray *nodes=appleLoopGuardNodes(root,read,&complete);
  NSCAssert(complete&&nodes.count==4&&[nodes containsObject:sheet]&&[nodes containsObject:modal],@"native modal/sheet lost");
  NSCAssert(reads<12,@"web content was traversed");
  appleLoopGuardNodes(@{@"AXRole":@"AXApplication",@"AXWindows":@{}},read,&complete);NSCAssert(!complete,@"invalid tree accepted");
  appleLoopGuardNodes(@{@"AXRole":@"AXApplication",@"AXWindows":@[@{}]},read,&complete);NSCAssert(!complete,@"unknown role accepted");
  NSMutableArray *huge=[NSMutableArray arrayWithArray:content];[huge addObjectsFromArray:content];
  appleLoopGuardNodes(@{@"AXRole":@"AXApplication",@"AXWindows":huge},read,&complete);NSCAssert(!complete,@"truncated tree accepted");
  NSCAssert(!appleLoopEvaluationGuardError(@{@"known":@YES,@"active":@NO,@"kind":@"none"},NO),@"idle native state blocked");
  NSCAssert([appleLoopEvaluationGuardError(@{@"known":@NO,@"active":@NO},NO)isEqual:@"SAFARI_AX_UNAVAILABLE"],@"unknown native state accepted");
  NSCAssert([appleLoopEvaluationGuardError(@{@"known":@NO,@"active":@NO,@"code":@"ACCESSIBILITY_REQUIRED"},NO)isEqual:@"ACCESSIBILITY_REQUIRED"],@"permission refusal lost");
  NSCAssert([appleLoopEvaluationGuardError(@{@"known":@YES,@"active":@YES,@"kind":@"apple-pay"},YES)isEqual:@"PAYMENT_ACTIVE"],@"Apple Pay bypassed by session extension");
  NSCAssert([appleLoopEvaluationGuardError(@{@"known":@YES,@"active":@YES,@"kind":@"safari-modal"},NO)isEqual:@"PAYMENT_ACTIVE"],@"ordinary action accepted behind Safari modal");
  NSCAssert(!appleLoopEvaluationGuardError(@{@"known":@YES,@"active":@YES,@"kind":@"safari-modal"},YES),@"session extension modal blocked");
  NSCAssert([appleLoopEvaluationGuardError(@{@"known":@YES,@"active":@YES,@"kind":@"unknown"},YES)isEqual:@"PAYMENT_ACTIVE"],@"unknown active window accepted");
  NSMutableDictionary *button=[@{@"AXRole":@"AXButton"}mutableCopy],*group=[@{@"AXRole":@"AXGroup",@"AXParent":button}mutableCopy],*image=[@{@"AXRole":@"AXImage",@"AXParent":group}mutableCopy];
  BOOL (^same)(id,id)=^BOOL(id a,id b){return a==b;};
  NSCAssert(appleLoopAncestorDepth(image,button,read,same)==2,@"nested Apple Pay image rejected");
  NSCAssert(appleLoopAncestorDepth(button,button,read,same)==0,@"button hit rejected");
  NSCAssert(appleLoopAncestorDepth(image,@{@"AXRole":@"AXButton"},read,same)==-1,@"unrelated button accepted");
  NSMutableDictionary *cycle=[NSMutableDictionary dictionary];cycle[@"AXParent"]=cycle;NSCAssert(appleLoopAncestorDepth(cycle,button,read,same)==-1,@"cyclic parent chain accepted");[cycle removeObjectForKey:@"AXParent"];
  CGRect rect = CGRectMake(100, 200, 120, 40);
  CGPoint point;
  __block NSUInteger probes = 0;
  NSCAssert(appleLoopFindButtonPoint(rect, ^BOOL(CGPoint candidate) {
    probes++;
    return appleLoopAncestorDepth(button, button, read, same) == 0;
  }, &point) && probes == 1 && CGPointEqualToPoint(point, CGPointMake(160, 220)), @"center hit should win");
  NSDictionary *overlay = @{@"AXRole": @"AXGroup"};
  probes = 0;
  NSCAssert(appleLoopFindButtonPoint(rect, ^BOOL(CGPoint candidate) {
    probes++;
    id hit = candidate.x == 130 ? image : overlay;
    return appleLoopAncestorDepth(hit, button, read, same) >= 0;
  }, &point) && probes == 2 && CGPointEqualToPoint(point, CGPointMake(130, 220)), @"visible part of the same button should be usable");
  probes = 0;
  NSCAssert(!appleLoopFindButtonPoint(rect, ^BOOL(CGPoint candidate) {
    probes++;
    NSCAssert(CGRectContainsPoint(rect, candidate), @"point outside the button");
    return appleLoopAncestorDepth(overlay, button, read, same) >= 0;
  }, &point) && probes == 5, @"obscured button must never receive a click");
  for (NSValue *invalid in @[[NSValue valueWithRect:CGRectNull], [NSValue valueWithRect:CGRectZero]]) {
    NSCAssert(!appleLoopFindButtonPoint(invalid.rectValue, ^BOOL(CGPoint candidate) {
      NSCAssert(NO, @"invalid button geometry must not be tested");
      return YES;
    }, &point), @"invalid rectangle accepted");
  }
  puts("Native guard fixtures passed");
}return 0;}

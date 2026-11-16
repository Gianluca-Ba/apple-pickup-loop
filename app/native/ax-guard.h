#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>

static NSString *appleLoopEvaluationGuardError(NSDictionary *ui, BOOL allowSessionModal) {
  if(![ui[@"known"]isEqual:@YES])return [ui[@"code"]isEqual:@"ACCESSIBILITY_REQUIRED"] ?
    @"ACCESSIBILITY_REQUIRED" : @"SAFARI_AX_UNAVAILABLE";
  if([ui[@"active"]boolValue]&&!(allowSessionModal&&[ui[@"kind"]isEqual:@"safari-modal"]))return @"PAYMENT_ACTIVE";
  return nil;
}

// Native sheets and modal windows live in Safari's chrome. Web dialogs are
// checked in the bound document before each DOM mutation; do not traverse its
// thousands of accessibility elements for every pickup control.
static NSArray *appleLoopGuardNodes(id root, id (^read)(id, CFStringRef), BOOL *complete) {
  NSMutableArray *result=[NSMutableArray arrayWithObject:root];
  *complete=YES;
  for(NSUInteger i=0;i<result.count;i++) {
    id role=read(result[i],kAXRoleAttribute);
    if(![role isKindOfClass:NSString.class]){*complete=NO;return result;}
    if([role isEqual:@"AXWebArea"]||[role isEqual:@"AXMenuBar"])continue;
    // The application children include thousands of menu entries. Native
    // modal windows/sheets belong to AXWindows, never that menu hierarchy.
    id children=read(result[i],[role isEqual:@"AXApplication"]?kAXWindowsAttribute:kAXChildrenAttribute);
    if([role isEqual:@"AXApplication"]&&![children isKindOfClass:NSArray.class]){*complete=NO;return result;}
    if(!children)continue;
    if(![children isKindOfClass:NSArray.class]||result.count+[children count]>6000){*complete=NO;return result;}
    [result addObjectsFromArray:children];
  }
  return result;
}

// Hit testing may return a nested image/text node inside a trusted button.
// Follow only its bounded parent chain; unrelated siblings never match.
static NSInteger appleLoopAncestorDepth(id child,id ancestor,id (^read)(id,CFStringRef),BOOL (^same)(id,id)) {
 for(NSInteger depth=0;child&&depth<=8;depth++){if(same(child,ancestor))return depth;id parent=read(child,kAXParentAttribute);if(!parent||same(parent,child))break;child=parent;}return -1;
}

// Only probe the interior of the same button. Its center can be clipped or
// obscured while a different point still belongs to the verified control.
static BOOL appleLoopFindButtonPoint(CGRect rect, BOOL (^matches)(CGPoint), CGPoint *point) {
  if (!isfinite(CGRectGetMaxX(rect)) || !isfinite(CGRectGetMaxY(rect)) ||
      !isfinite(rect.origin.x) || !isfinite(rect.origin.y) ||
      !(rect.size.width > 0 && rect.size.height > 0)) return NO;
  const CGPoint offsets[] = {{.5, .5}, {.25, .5}, {.75, .5}, {.5, .25}, {.5, .75}};
  for (NSUInteger i = 0; i < sizeof(offsets) / sizeof(offsets[0]); i++) {
    CGPoint candidate = CGPointMake(rect.origin.x + rect.size.width * offsets[i].x,
                                    rect.origin.y + rect.size.height * offsets[i].y);
    if (matches(candidate)) {
      *point = candidate;
      return YES;
    }
  }
  return NO;
}

#import <Cocoa/Cocoa.h>
#import <ScriptingBridge/ScriptingBridge.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Security/Security.h>
#import "ax-guard.h"
#import "application-state.h"
#import "script-result.h"
#import "window-target.h"
#include <libproc.h>
@interface SBApplication (AppleLoop)
- (id)doJavaScript:(NSString *)source in:(id)target;
@end
static void fail(NSString *code) { @throw [NSException exceptionWithName:@"AppleLoop" reason:code userInfo:nil]; }
static id property(SBObject *o, AEKeyword code) { return [[o propertyWithCode:code] get]; }
static double started(pid_t pid) { struct proc_bsdinfo info={0}; if(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info)!=sizeof info)return 0; return info.pbi_start_tvsec+info.pbi_start_tvusec/1000000.; }
static NSString *quote(NSString *s) { NSData*d=[NSJSONSerialization dataWithJSONObject:@[s] options:0 error:nil]; NSString*t=[[NSString alloc]initWithData:d encoding:NSUTF8StringEncoding];return[t substringWithRange:NSMakeRange(1,t.length-2)]; }
static BOOL genuine(NSRunningApplication *app) {
 if(![app.bundleIdentifier isEqual:@"com.apple.Safari"]||app.terminated)return NO;
 SecCodeRef code=NULL;SecRequirementRef requirement=NULL;
 BOOL ok=SecCodeCopyGuestWithAttributes(NULL,(__bridge CFDictionaryRef)@{(__bridge id)kSecGuestAttributePid:@(app.processIdentifier)},0,&code)==errSecSuccess&&SecRequirementCreateWithString(CFSTR("anchor apple and identifier \"com.apple.Safari\""),0,&requirement)==errSecSuccess&&SecCodeCheckValidity(code,0,requirement)==errSecSuccess;
 if(code)CFRelease(code);if(requirement)CFRelease(requirement);return ok;
}
static BOOL allowed(NSString *address) {
 NSURL*u=[NSURL URLWithString:address];BOOL host=[u.host isEqual:@"www.apple.com"]||[u.host rangeOfString:@"^secure[0-9]+\\.store\\.apple\\.com$" options:NSRegularExpressionSearch].location!=NSNotFound;
 return[u.scheme isEqual:@"https"]&&host&&[u.path hasPrefix:@"/jp/shop/"]&&!u.user.length&&!u.password.length;
}
static NSString *js(SBApplication*a,SBObject*t,NSString*s) { id value=[a doJavaScript:s in:t];if(![value isKindOfClass:NSString.class])fail(@"SAFARI_SCRIPT_UNAVAILABLE");return value; }
static id ax(AXUIElementRef node,CFStringRef attribute) { CFTypeRef value=NULL;if(AXUIElementCopyAttributeValue(node,attribute,&value)!=kAXErrorSuccess)return nil;return CFBridgingRelease(value); }
static NSArray *nodes(AXUIElementRef root) {
 NSMutableArray *all=[NSMutableArray arrayWithObject:(__bridge id)root];
 for(NSUInteger i=0;i<all.count&&i<5000;i++){AXUIElementRef node=(__bridge AXUIElementRef)all[i];id children=ax(node,kAXChildrenAttribute);if([children isKindOfClass:NSArray.class]&&all.count+[children count]<6000)[all addObjectsFromArray:children];}
 return all;
}
static NSArray *boundAXWindows(AXUIElementRef app,NSString *url) {
 NSMutableArray *matches=[NSMutableArray array];id windows=ax(app,kAXWindowsAttribute);if(![windows isKindOfClass:NSArray.class])return matches;
 for(id item in windows){BOOL matched=NO;for(id child in nodes((__bridge AXUIElementRef)item)){AXUIElementRef n=(__bridge AXUIElementRef)child;if(![ax(n,kAXRoleAttribute)isEqual:@"AXWebArea"])continue;id value=ax(n,kAXURLAttribute);NSString *address=[value isKindOfClass:NSURL.class]?[value absoluteString]:[value isKindOfClass:NSString.class]?value:nil;if([address isEqual:url]){matched=YES;break;}}if(matched)[matches addObject:item];}return matches;
}
static NSArray *payButtons(AXUIElementRef root) {
 NSMutableArray *buttons=[NSMutableArray array];for(id item in nodes(root)){AXUIElementRef n=(__bridge AXUIElementRef)item;if(![ax(n,kAXRoleAttribute)isEqual:@"AXButton"])continue;NSString *label=ax(n,kAXTitleAttribute)?:ax(n,kAXDescriptionAttribute)?:@"";if([label rangeOfString:@"Apple\\s*Pay" options:NSRegularExpressionSearch].location!=NSNotFound&&[ax(n,kAXEnabledAttribute)boolValue])[buttons addObject:item];}return buttons;
}
static NSInteger hitDepth(AXUIElementRef hit,AXUIElementRef button){return appleLoopAncestorDepth((__bridge id)hit,(__bridge id)button,^id(id n,CFStringRef key){return ax((__bridge AXUIElementRef)n,key);},^BOOL(id a,id b){return CFEqual((__bridge CFTypeRef)a,(__bridge CFTypeRef)b);});}
static BOOL payWindowFocused(AXUIElementRef application, AXUIElementRef window, pid_t pid) {
 appleLoopRefreshApplicationState();
 id focused = ax(application, kAXFocusedWindowAttribute);
 return focused && CFEqual((__bridge CFTypeRef)focused, window) &&
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid;
}
static CGRect payButtonRect(AXUIElementRef button) {
 id position = ax(button, kAXPositionAttribute), size = ax(button, kAXSizeAttribute);
 CGPoint origin;
 CGSize dimensions;
 if (!position || !size || CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID() ||
     CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID() ||
     !AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &origin) ||
     !AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &dimensions)) return CGRectNull;
 return (CGRect){origin, dimensions};
}
static BOOL payButtonHit(AXUIElementRef screen, AXUIElementRef button, CGPoint point, pid_t pid, NSString **miss) {
 AXUIElementRef hit = NULL;
 AXError status = AXUIElementCopyElementAtPosition(screen, point.x, point.y, &hit);
 BOOL matches = status == kAXErrorSuccess && hit && hitDepth(hit, button) >= 0;
 if (!matches && miss) {
  pid_t owner = 0;
  if (status != kAXErrorSuccess || !hit) *miss = @"AX_NO_HIT";
  else if (AXUIElementGetPid(hit, &owner) == kAXErrorSuccess && owner != pid) *miss = @"AX_OTHER_APP";
  else if (hitDepth(button, hit) > 0) *miss = @"AX_ANCESTOR";
  else if ([ax(hit, kAXRoleAttribute) isEqual:@"AXWebArea"]) *miss = @"AX_WEB_AREA";
  else *miss = @"AX_OTHER_CONTROL";
 }
 if (hit) CFRelease(hit);
 return matches;
}
static void failPayHit(SBApplication *app, SBObject *tab, NSString *nonce, NSString *miss) {
 NSString *dom = @"DOM_UNAVAILABLE";
 @try {
  NSString *script = [NSString stringWithFormat:
    @"JSON.stringify((()=>{const elements=document.querySelectorAll('[data-apple-loop-pay-armed=\"%@\"]');"
     "if(elements.length!==1)return 'DOM_CHANGED';const button=elements[0],r=button.getBoundingClientRect();"
     "if(!r.width||!r.height||button.matches(':disabled,[aria-disabled=true]'))return 'DOM_CHANGED';"
     "const points=[[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]];"
     "return points.some(([x,y])=>button.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))?'DOM_REACHABLE':'DOM_OBSCURED'})())", nonce];
  NSString *reading = js(app, tab, script);
  for (NSString *code in @[@"DOM_CHANGED", @"DOM_REACHABLE", @"DOM_OBSCURED"]) {
   if ([reading isEqual:quote(code)]) { dom = code; break; }
  }
 } @catch (NSException *exception) {}
 @throw [NSException exceptionWithName:@"AppleLoop" reason:@"APPLE_PAY_HIT_CHANGED"
                             userInfo:@{@"axTarget":miss,@"domTarget":dom}];
}
static NSDictionary *paymentUI(NSRunningApplication*a) {
 if(!AXIsProcessTrusted())return@{@"known":@NO,@"active":@NO,@"kind":@"unknown",@"code":@"ACCESSIBILITY_REQUIRED"};
 AXUIElementRef application=AXUIElementCreateApplication(a.processIdentifier);BOOL active=NO,pay=NO,authorization=NO;
 BOOL complete=NO;NSArray *guard=appleLoopGuardNodes((__bridge id)application,^id(id item,CFStringRef attribute){return ax((__bridge AXUIElementRef)item,attribute);},&complete);
 if(!complete){
  [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.04]];
  guard=appleLoopGuardNodes((__bridge id)application,^id(id item,CFStringRef attribute){return ax((__bridge AXUIElementRef)item,attribute);},&complete);
 }
 if(!complete){CFRelease(application);return@{@"known":@NO,@"active":@NO,@"kind":@"unknown",@"code":@"SAFARI_AX_UNAVAILABLE"};}
 for(id item in guard){AXUIElementRef n=(__bridge AXUIElementRef)item;NSString *role=ax(n,kAXRoleAttribute);if([role isEqual:@"AXSheet"]||[ax(n,kAXModalAttribute)boolValue]){
  active=YES;
  for(id child in nodes(n)){AXUIElementRef c=(__bridge AXUIElementRef)child;NSString*r=ax(c,kAXRoleAttribute);if(![@[@"AXStaticText",@"AXButton",@"AXHeading"]containsObject:r])continue;NSString*t=ax(c,kAXTitleAttribute)?:ax(c,kAXDescriptionAttribute)?:([r isEqual:@"AXStaticText"]?ax(c,kAXValueAttribute):nil)?:@"";
   if([t rangeOfString:@"Apple\\s*Pay" options:NSRegularExpressionSearch|NSCaseInsensitiveSearch].location!=NSNotFound)pay=YES;
   if([t rangeOfString:@"Touch ID|Face ID|double.click|サイドボタン|指紋|認証|支払う" options:NSRegularExpressionSearch|NSCaseInsensitiveSearch].location!=NSNotFound)authorization=YES;
  }
 }}
 CFRelease(application);
 // Safari may present Wallet authorization in a separate, Apple-signed service.
 for(NSRunningApplication*other in NSWorkspace.sharedWorkspace.runningApplications){NSString*b=other.bundleIdentifier.lowercaseString;if(![b containsString:@"passbook"]&&![b containsString:@"applepay"])continue;AXUIElementRef app=AXUIElementCreateApplication(other.processIdentifier);id windows=ax(app,kAXWindowsAttribute);if([windows isKindOfClass:NSArray.class]&&[windows count]){active=YES;pay=YES;}CFRelease(app);}
 return@{@"known":@YES,@"active":@(active),@"kind":pay?@"apple-pay":active?@"safari-modal":@"none",@"authorizationRequired":pay&&authorization?@YES:@NO};
}
static NSDictionary *handle(NSDictionary*r) {
 NSString*operation=r[@"operation"];
 if(![@[@"bind",@"evaluate",@"evaluate-guarded",@"payment-status",@"press-apple-pay",@"apple-pay-target-status"]containsObject:operation])fail(@"INVALID_COMMAND");
 NSDictionary*binding=r[@"binding"];NSRunningApplication*a=nil;
 if(binding){a=[NSRunningApplication runningApplicationWithProcessIdentifier:[binding[@"pid"]intValue]];if(!genuine(a)||fabs(started(a.processIdentifier)-[binding[@"started"]doubleValue])>.000001)fail(@"SAFARI_CHANGED");}
 else{for(NSRunningApplication*item in NSWorkspace.sharedWorkspace.runningApplications)if(genuine(item)){if(a)fail(@"SAFARI_AMBIGUOUS");a=item;}if(!a)fail(@"SAFARI_NOT_RUNNING");}
 // Observing native authorization is read-only and can outlive its tab.
 // Binding validation and every mutation retain the exact window/tab gate.
 if(binding&&[operation isEqual:@"payment-status"]&&[r[@"observeOnly"]isEqual:@YES])return paymentUI(a);
 SBApplication*app=[SBApplication applicationWithProcessIdentifier:a.processIdentifier];app.timeout=10;
 SBElementArray*windows=[app elementArrayWithCode:'cwin'];SBObject*window=nil,*tab=nil;
 if(!binding){
  for(SBObject*w in windows){id identifier=property(w,'ID  ');SBObject*stable=appleLoopWindowTarget((id)windows,identifier,^id(id item){return property(item,'ID  ');});if(!stable)continue;SBElementArray*tabs=[stable elementArrayWithCode:'bTab'];if(tabs.count!=1)continue;SBObject*t=tabs[0];if(allowed(property(t,'pURL'))){if(window)fail(@"SAFARI_AMBIGUOUS");window=stable;tab=t;}}
  if(!window)fail(@"SAFARI_TAB_REQUIRED");
 }else{
  window=appleLoopWindowTarget((id)windows,binding[@"window"],^id(id item){return property(item,'ID  ');});
  if(!window)fail(@"SAFARI_TAB_CHANGED");SBElementArray*tabs=[window elementArrayWithCode:'bTab'];if(tabs.count!=1)fail(@"SAFARI_TAB_CHANGED");tab=tabs[0];
 }
 if(!allowed(property(tab,'pURL')))fail(@"SAFARI_ROUTE_CHANGED");
 // Native sheets can temporarily block JavaScript. This read-only observation
 // still requires the original signed Safari process, window and single tab.
 if([operation isEqual:@"payment-status"])return paymentUI(a);
 if([operation isEqual:@"evaluate-guarded"]){NSString *error=appleLoopEvaluationGuardError(paymentUI(a),[r[@"allowSessionModal"]boolValue]);if(error)fail(error);}
 NSString*nonce=binding?binding[@"nonce"]:NSUUID.UUID.UUIDString.lowercaseString;
 if(![nonce isKindOfClass:NSString.class]||[nonce rangeOfString:@"^[a-f0-9-]{36}$" options:NSRegularExpressionSearch].location==NSNotFound)fail(@"INVALID_COMMAND");
 NSString*marker=[@"ApplePickupLoop:" stringByAppendingString:nonce];
 if([operation isEqual:@"bind"]){
  NSString*script=[NSString stringWithFormat:@"JSON.stringify((()=>{const m=%@;if(window.name&&window.name.startsWith('ApplePickupLoop:')&&window.name!==m)return false;window.name=m;sessionStorage.setItem('apple-pickup-owner',m);return true})())",quote(marker)];
  NSString *error=appleLoopBooleanScriptError(js(app,tab,script),@"SAFARI_FOREIGN_OWNER");if(error)fail(error);
  return@{@"pid":@(a.processIdentifier),@"started":@(started(a.processIdentifier)),@"window":property(window,'ID  '),@"nonce":nonce};
 }
 NSString*ownership=[NSString stringWithFormat:@"JSON.stringify((()=>{const m=%@;if(window.name===m||sessionStorage.getItem('apple-pickup-owner')===m){window.name=m;return true}return false})())",quote(marker)];
 NSString *ownershipError=appleLoopBooleanScriptError(js(app,tab,ownership),@"SAFARI_TAB_CHANGED");
 if(ownershipError){
  if(![ownershipError isEqual:@"SAFARI_TAB_CHANGED"])fail(ownershipError);
  // Only this process/window/single tab may finish an explicitly expected navigation.
  if(![r[@"allowNavigation"]boolValue])fail(@"SAFARI_TAB_CHANGED");
  NSString*restore=[NSString stringWithFormat:@"JSON.stringify((()=>{const m=%@;if(window.name&&window.name.startsWith('ApplePickupLoop:')&&window.name!==m)return false;window.name=m;sessionStorage.setItem('apple-pickup-owner',m);return true})())",quote(marker)];
  NSString *error=appleLoopBooleanScriptError(js(app,tab,restore),@"SAFARI_FOREIGN_OWNER");if(error)fail(error);
 }
 if([operation isEqual:@"evaluate"]||[operation isEqual:@"evaluate-guarded"]){NSString*script=r[@"script"];if(![script isKindOfClass:NSString.class]||script.length>200000)fail(@"INVALID_COMMAND");NSString*value=js(app,tab,script);id result=[NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingFragmentsAllowed error:nil];if(!result)fail(@"SAFARI_SCRIPT_UNAVAILABLE");return result;}
 if(!AXIsProcessTrusted())fail(@"ACCESSIBILITY_REQUIRED");
 NSString *guardError=appleLoopEvaluationGuardError(paymentUI(a),NO);if(guardError)fail(guardError);
 NSString*token=r[@"token"];if(![token isKindOfClass:NSString.class]||![token isEqual:nonce])fail(@"INVALID_COMMAND");
 NSString*check=[NSString stringWithFormat:@"JSON.stringify((()=>{const e=document.querySelectorAll('[data-apple-loop-pay-armed=\"%@\"]');return window.name===%@&&e.length===1&&!e[0].matches(':disabled,[aria-disabled=true]')&&!e[0].closest('[inert]')&&e[0].getClientRects().length>0})())",nonce,quote(marker)];
 NSString *checkError=appleLoopBooleanScriptError(js(app,tab,check),@"APPLE_PAY_CHANGED");if(checkError&&![operation isEqual:@"apple-pay-target-status"])fail(checkError);
 if([operation isEqual:@"apple-pay-target-status"]){
  AXUIElementRef appAX=AXUIElementCreateApplication(a.processIdentifier);NSArray *matches=boundAXWindows(appAX,property(tab,'pURL')),*buttons=payButtons(appAX);id focused=ax(appAX,kAXFocusedWindowAttribute);NSInteger depth=-1;NSString *role=@"none";BOOL rect=NO;
  if(buttons.count==1){AXUIElementRef b=(__bridge AXUIElementRef)buttons[0];CGPoint point;CGSize size;id pv=ax(b,kAXPositionAttribute),sv=ax(b,kAXSizeAttribute);rect=pv&&sv&&AXValueGetValue((__bridge AXValueRef)pv,kAXValueCGPointType,&point)&&AXValueGetValue((__bridge AXValueRef)sv,kAXValueCGSizeType,&size)&&size.width>0&&size.height>0;if(rect){AXUIElementRef hit=NULL;if(AXUIElementCopyElementAtPosition(appAX,point.x+size.width/2,point.y+size.height/2,&hit)==kAXErrorSuccess&&hit){depth=hitDepth(hit,b);id raw=ax(hit,kAXRoleAttribute);role=[@[@"AXButton",@"AXStaticText",@"AXImage",@"AXGroup",@"AXWebArea"]containsObject:raw]?raw:@"other";CFRelease(hit);}}}
  BOOL focusedMatches=matches.count==1&&focused&&CFEqual((__bridge CFTypeRef)focused,(__bridge CFTypeRef)matches[0]);NSDictionary *result=@{@"known":@YES,@"armed":@(!checkError),@"matchingWindows":@(matches.count),@"payButtons":@(buttons.count),@"buttonRectKnown":@(rect),@"hitAncestorDepth":@(depth),@"hitRole":role,@"focusedWindowMatches":@(focusedMatches),@"frontmostSafari":@([NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier isEqual:@"com.apple.Safari"])};CFRelease(appAX);return result;
 }
 pid_t pid = a.processIdentifier;
 AXUIElementRef application = AXUIElementCreateApplication(pid);
 AXUIElementRef screen = AXUIElementCreateSystemWide();
 @try {
  NSString *url = property(tab, 'pURL');
  if (!allowed(url)) fail(@"APPLE_PAY_CHANGED");
  __attribute__((objc_precise_lifetime)) NSArray *bound = boundAXWindows(application, url);
  if (bound.count != 1) fail(@"APPLE_PAY_WINDOW_AMBIGUOUS");
  AXUIElementRef boundWindow = (__bridge AXUIElementRef)bound[0];
  [app activate]; [a activateWithOptions:0]; [[window propertyWithCode:'pidx'] setTo:@1];
  AXUIElementPerformAction(boundWindow, kAXRaiseAction);
  BOOL focused = NO;
  for (int attempt = 0; attempt < 20; attempt++) {
   focused = payWindowFocused(application, boundWindow, pid);
   if (focused) break;
   [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  if (!focused) fail(@"APPLE_PAY_WINDOW_NOT_FOCUSED");
  __attribute__((objc_precise_lifetime)) NSArray *buttons = payButtons(boundWindow);
  if (buttons.count != 1) fail(@"APPLE_PAY_CONTROL_AMBIGUOUS");
  AXUIElementRef button = (__bridge AXUIElementRef)buttons[0];
  CGPoint point;
  BOOL found = NO;
  __block NSString *centerMiss = @"AX_NO_RECT";
  // Give Safari a short window to settle after the scroll and raise. Retry
  // only observations. A system-wide hit also sees windows covering Safari.
  NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 0.25;
  do {
   if (!payWindowFocused(application, boundWindow, pid)) fail(@"APPLE_PAY_WINDOW_NOT_FOCUSED");
   if (![ax(button, kAXEnabledAttribute) boolValue]) fail(@"APPLE_PAY_CONTROL_UNAVAILABLE");
   __block BOOL firstProbe = YES;
   centerMiss = @"AX_NO_RECT";
   found = appleLoopFindButtonPoint(payButtonRect(button), ^BOOL(CGPoint candidate) {
    NSString *miss = nil;
    BOOL matches = payButtonHit(screen, button, candidate, pid, firstProbe ? &miss : NULL);
    if (firstProbe && miss) centerMiss = miss;
    firstProbe = NO;
    return matches;
   }, &point);
   if (found || NSProcessInfo.processInfo.systemUptime >= deadline) break;
   [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  } while (NSProcessInfo.processInfo.systemUptime < deadline);
  if (!found) failPayHit(app, tab, nonce, centerMiss);
  if (![property(tab, 'pURL') isEqual:url] || ![js(app, tab, check) isEqual:@"true"]) fail(@"APPLE_PAY_ARM_CHANGED");
  NSString *lastGuard = appleLoopEvaluationGuardError(paymentUI(a), NO);
  if (lastGuard) fail(lastGuard);
  if (!payWindowFocused(application, boundWindow, pid)) fail(@"APPLE_PAY_WINDOW_NOT_FOCUSED");
  if (![ax(button, kAXEnabledAttribute) boolValue] ||
      !CGRectContainsPoint(payButtonRect(button), point)) failPayHit(app, tab, nonce, @"AX_CONTROL_MOVED");
  NSString *finalMiss = nil;
  if (!payButtonHit(screen, button, point, pid, &finalMiss)) failPayHit(app, tab, nonce, finalMiss);
  // Safari needs one trusted gesture to open Wallet. Authorization remains manual.
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  if (!down || !up) {
   if (down) CFRelease(down);
   if (up) CFRelease(up);
   fail(@"APPLE_PAY_CONTROL_UNAVAILABLE");
  }
  CGEventPost(kCGHIDEventTap, down);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(down);
  CFRelease(up);
  return @{@"dispatched": @YES};
 } @finally {
  CFRelease(screen);
  CFRelease(application);
 }
}
static NSData *response(NSData *input) {
 appleLoopRefreshApplicationState();
 NSDictionary *output, *r=nil;
 @try {
  if(input.length>250000)fail(@"INVALID_COMMAND");
  r=[NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
  if(![r isKindOfClass:NSDictionary.class])fail(@"INVALID_COMMAND");
  output=@{@"ok":@YES,@"result":handle(r)};
 } @catch(NSException *e) {
  NSString *code=[e.name isEqual:@"AppleLoop"]?e.reason:@"SAFARI_UNAVAILABLE";
  BOOL rejected=[r isKindOfClass:NSDictionary.class]&&[r[@"operation"]isEqual:@"press-apple-pay"]&&
    [@[@"APPLE_PAY_CHANGED",@"APPLE_PAY_HIT_CHANGED",@"APPLE_PAY_ARM_CHANGED",@"APPLE_PAY_WINDOW_AMBIGUOUS",@"APPLE_PAY_WINDOW_NOT_FOCUSED",@"APPLE_PAY_CONTROL_AMBIGUOUS",@"APPLE_PAY_CONTROL_UNAVAILABLE"]containsObject:code];
  NSMutableDictionary *failure=[@{@"ok":@NO,@"code":code} mutableCopy];
  if(rejected) failure[@"notDispatched"]=@YES;
  if(rejected&&[code isEqual:@"APPLE_PAY_HIT_CHANGED"]) {
   failure[@"axTarget"]=e.userInfo[@"axTarget"];
   failure[@"domTarget"]=e.userInfo[@"domTarget"];
  }
  output=failure;
 }
 return[NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
}
int main(int argc,const char **argv){@autoreleasepool{
 if(argc==2&&strcmp(argv[1],"--stdio")==0){char*line=NULL;size_t capacity=0;ssize_t length;while((length=getline(&line,&capacity,stdin))>=0){@autoreleasepool{NSData*data=response([NSData dataWithBytes:line length:(NSUInteger)length]);fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);}}free(line);return 0;}
 NSData*data=response([NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile]);[NSFileHandle.fileHandleWithStandardOutput writeData:data];}return 0;}

export function abortStaleKeeper(p){
 const u=new URL(location.href),visible=e=>e.getClientRects().length>0;
 const trusted=u.protocol==='https:'&&(u.hostname==='www.apple.com'||/^secure[0-9]+[.]store[.]apple[.]com$/.test(u.hostname));
 const change=window.__applePickupFulfillmentChange,payment=window.__applePickupPayment,store=window.__applePickupStoreSelection;
 if(!trusted||u.pathname!=='/jp/shop/apw/checkout'||u.searchParams.get('_s')!=='Fulfillment-init'||
    !/^[a-f0-9-]{36}$/.test(p.nonce??'')||window.name!=='ApplePickupLoop:'+p.nonce||
    document.readyState!=='complete'||!change||!['pickup','delivery'].includes(change.mode)||change.responseComplete!==false||
    !Number.isFinite(change.startedAt)||performance.now()-change.startedAt<30000||
    payment?.active||payment?.authorized||payment?.observed||payment?.completed||
    document.documentElement.hasAttribute('data-apple-loop-pay-dispatched')||
    store&&!store.responseComplete||
    document.querySelectorAll('input[name="store-locator-result"]:checked').length>0||
    [...document.querySelectorAll('select[data-autom="pickup-availablewindow-dropdown"]')].some(visible)||
    [...document.querySelectorAll('[aria-busy="true"],.rs-processing,[data-autom="processing"],[aria-modal="true"],[role="alertdialog"]')].some(visible))throw Error('KEEPER_RECOVERY_UNVERIFIED');
 if(p.observeOnly===true)return{eligible:true};
 if(window.__applePickupKeeperAbort?.request===change)return{requested:true,alreadyRequested:true};
 window.__applePickupKeeperAbort={request:change};
 location.assign('https://www.apple.com/jp/shop/bag');return{requested:true,prePaymentKeeperAborted:true};
}

// Only public product/Store identifiers and in-memory clocks. No persistence.
export class AvailabilityQueue {
  constructor({now=Date.now,maxAgeMs=5000,limit=12,preferFreshest=()=>false}={}){Object.assign(this,{now,maxAgeMs,limit,preferFreshest});this.entries=new Map();this.sequence=0;}
  key(sku,storeId){return sku+':'+storeId;}
  fresh(v){const age=this.now()-v.observedAt;return Number.isFinite(v.observedAt)&&age>=0&&age<=this.maxAgeMs;}
  prune(accept=()=>true){for(const[k,v]of this.entries)if(!this.fresh(v)||!accept(v))this.entries.delete(k);}
  ordered(){this.prune();return[...this.entries.values()].sort((a,b)=>this.preferFreshest()?b.observedAt-a.observedAt||a.sequence-b.sequence:a.firstReceivedAt-b.firstReceivedAt||a.sequence-b.sequence);}
  push(value){
    this.prune();if(!value||!/^[A-Z0-9]{5,12}J\/A$/.test(value.sku??'')||!/^R\d{3}$/.test(value.storeId??'')||!this.fresh(value))return;
    const key=this.key(value.sku,value.storeId),old=this.entries.get(key);if(old&&value.observedAt<old.observedAt)return;
    const receivedAt=Number.isFinite(value.receivedAt)?Math.min(this.now(),value.receivedAt):this.now();
    this.entries.set(key,{sku:value.sku,storeId:value.storeId,observedAt:value.observedAt,receivedAt,firstReceivedAt:old?.firstReceivedAt??receivedAt,sequence:old?.sequence??++this.sequence,blockedBy:['keeper','checkout','idle'].includes(value.blockedBy)?value.blockedBy:'idle',...(Number.isFinite(value.requestStartedAt)?{requestStartedAt:value.requestStartedAt}:{}),...(/^pilot(?:[1-9]|[12]\d|30)$|^mac$/.test(value.node??'')?{node:value.node}:{}),...(value.origin==='safari-pickup-response'?{origin:value.origin}:{})});
    if(this.entries.size>this.limit){const last=this.ordered().at(-1);this.entries.delete(this.key(last.sku,last.storeId));}
  }
  peek(){const values=this.ordered(),first=values[0];return first?{...first,alternatives:values.filter(v=>v!==first&&v.sku===first.sku&&v.observedAt===first.observedAt).map(v=>v.storeId)}:null;}
  take(accept=()=>true){this.prune(accept);const value=this.peek();if(value)this.entries.delete(this.key(value.sku,value.storeId));return value;}
  remove(sku,storeId){this.entries.delete(this.key(sku,storeId));}
  clear(){this.entries.clear();}
  get size(){this.prune();return this.entries.size;}
}

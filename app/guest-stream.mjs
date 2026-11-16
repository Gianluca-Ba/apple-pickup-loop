import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function guestExecArguments(command, instance = process.env.APPLE_LOOP_VM ?? 'apple-pickup-linux') {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(instance)) throw Error('GUEST_INSTANCE_INVALID');
  return ['exec', instance, '--', '/usr/bin/sudo', '-n', '--', ...command];
}

const CHANNEL = 'linux-guest-stream-v1';
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const nodeNumber = value => /^(?:[1-9]|[12]\d|30)$/.test(value);
const failure = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });


// Keep the transport limited to the same two clients used by the existing
// coordinator. No shell, network listener, provider login or direct stock URL.
export function validateGuestArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string' || v.length > 8192 || /[\0\r\n]/.test(v))) throw failure('GUEST_SCOPE');
  if (argv[0] === '/usr/bin/python3' && argv[1] === '/opt/iphone-stock-pool/linux-vpn-control.py') {
    if (!uuid(argv[3])) throw failure('GUEST_SCOPE');
    if (argv[2] === 'result' && argv.length === 4) return [...argv];
    if (argv[2] === 'start' && (argv[4] === 'inventory' && argv.length === 5 || ['connect','disconnect','rotate'].includes(argv[4]) && argv.length === 6 && nodeNumber(argv[5]) && !(argv[4] === 'rotate' && argv[5] === '1'))) return [...argv];
    throw failure('GUEST_SCOPE');
  }
  let offset;
  if (argv.slice(0,5).join('|') === '/usr/sbin/runuser|-u|monitor|--|/usr/local/bin/node') offset = 5;
  else if (argv[0] === '/usr/bin/docker' && argv[1] === 'exec' && /^iphone-linux-vpn-(?:[2-9]|[12]\d|30)$/.test(argv[2]) && argv[3] === '/opt/node22/bin/node') offset = 4;
  if (offset === undefined || argv.length !== offset + 4 || argv[offset] !== '/opt/iphone-stock/app/worker-server.mjs' || argv[offset+1] !== '--client' || !['/start','/result'].includes(argv[offset+2])) throw failure('GUEST_SCOPE');
  const encoded = argv[offset+3];
  let body;
  try {
    if (Buffer.from(encoded,'base64').toString('base64') !== encoded) throw Error();
    const raw = Buffer.from(encoded,'base64'); if (raw.length > 4096) throw Error(); body = JSON.parse(raw.toString('utf8'));
  } catch { throw failure('GUEST_SCOPE'); }
  if (!body || Array.isArray(body) || !uuid(body.id)) throw failure('GUEST_SCOPE');
  if (argv[offset+2] === '/result') { if (Object.keys(body).length !== 1) throw failure('GUEST_SCOPE'); }
  else if (Object.keys(body).some(k => !['id','operation','data'].includes(k)) || !['network','sample','close'].includes(body.operation) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw failure('GUEST_SCOPE');
  return [...argv];
}

export const GUEST_STREAM_SOURCE = String.raw`
import sys,json,re,base64,subprocess,socket,select,os
CHANNEL='linux-guest-stream-v1'
session=sys.argv[1]
def uid(v):return isinstance(v,str) and re.fullmatch(r'[a-f0-9-]{36}',v) is not None
def valid(a):
 if not isinstance(a,list) or not a or any(not isinstance(v,str) or len(v)>8192 or any(c in v for c in ('\0','\r','\n')) for v in a):return False
 if a[:2]==['/usr/bin/python3','/opt/iphone-stock-pool/linux-vpn-control.py']:
  if len(a)<4 or not uid(a[3]):return False
  if a[2]=='result':return len(a)==4
  return a[2]=='start' and (len(a)==5 and a[4]=='inventory' or len(a)==6 and a[4] in ('connect','disconnect','rotate') and re.fullmatch(r'(?:[1-9]|[12]\d|30)',a[5]) is not None and not(a[4]=='rotate' and a[5]=='1'))
 offset=5 if a[:5]==['/usr/sbin/runuser','-u','monitor','--','/usr/local/bin/node'] else 4 if len(a)>=4 and a[0:2]==['/usr/bin/docker','exec'] and re.fullmatch(r'iphone-linux-vpn-(?:[2-9]|[12]\d|30)',a[2]) and a[3]=='/opt/node22/bin/node' else None
 if offset is None or len(a)!=offset+4 or a[offset:offset+2]!=['/opt/iphone-stock/app/worker-server.mjs','--client'] or a[offset+2] not in ('/start','/result'):return False
 try:
  raw=base64.b64decode(a[offset+3],validate=True)
  if len(raw)>4096 or base64.b64encode(raw).decode()!=a[offset+3]:return False
  b=json.loads(raw)
  if not isinstance(b,dict) or not uid(b.get('id')):return False
  return list(b)==['id'] if a[offset+2]=='/result' else set(b)<=set(('id','operation','data')) and b.get('operation') in ('network','sample','close') and isinstance(b.get('data'),dict)
 except (ValueError,TypeError):return False
def emit(v):print(json.dumps(dict(channel=CHANNEL,session=session,**v)),flush=True)
if socket.gethostname()!='apple-pickup-linux' or not uid(session):raise SystemExit(73)
emit(dict(ready=True))
buffer=b''
while True:
 while b'\n' not in buffer:
  if not select.select([sys.stdin],[],[],30)[0]:raise SystemExit(0)
  chunk=os.read(sys.stdin.fileno(),8192)
  if not chunk:raise SystemExit(0)
  buffer+=chunk
  if len(buffer)>65536:raise SystemExit(0)
 line,buffer=buffer.split(b'\n',1)
 seq=''
 try:
  r=json.loads(line);seq=r.get('seq','')
  if r.get('channel')!=CHANNEL or r.get('session')!=session or not uid(seq) or not valid(r.get('argv')):raise ValueError()
  timeout=r.get('timeoutMs');limit=r.get('maxBuffer')
  if type(timeout) is not int or not 1<=timeout<=5000 or type(limit) is not int or not 1024<=limit<=65536:raise ValueError()
  try:
   p=subprocess.run(r['argv'],capture_output=True,timeout=timeout/1000)
   out=p.stdout
   if len(out)>limit:emit(dict(seq=seq,error='GUEST_OUTPUT_LIMIT'));continue
   emit(dict(seq=seq,exitCode=p.returncode,stdout=out.decode('utf-8',errors='replace')))
  except subprocess.TimeoutExpired as e:
   out=e.stdout or b''
   emit(dict(seq=seq,error='ETIMEDOUT',stdout=out[:limit].decode('utf-8',errors='replace')))
  except OSError:emit(dict(seq=seq,error='GUEST_COMMAND_FAILED'))
 except (ValueError,TypeError,AttributeError):emit(dict(seq=seq,error='GUEST_SCOPE'))
`;

export class MultipassGuestStream {
  constructor({ spawn = spawnChild, now = Date.now } = {}) {
    this.spawn = spawn; this.now = now; this.session = null; this.busy = false; this.closing=false; this.children=new Set();
    this.stats = { sessionsStarted:0, commandReplies:0, commandErrors:0, protocolErrors:0, timeouts:0 };
    this.timings = [];
  }
  snapshot() { return { kind:'stdio', ready:this.session?.ready === true&&!this.closing, ...this.stats, recentRoundTrips:this.timings.length, meanRoundTripMs:this.timings.length?Math.round(this.timings.reduce((a,b)=>a+b,0)/this.timings.length):null }; }
  open(deadline) {
    if (this.session && !this.session.closed) return this.session.readyPromise;
    const token = randomUUID(), child = this.spawn('multipass', guestExecArguments(['/usr/bin/python3', '-u', '-c', GUEST_STREAM_SOURCE, token]), { stdio:['pipe','pipe','pipe'] });
    const s = { child, token, ready:false, closed:false, closing:false, buffer:'', pending:null };
    this.children.add(child);
    this.session = s; this.stats.sessionsStarted++;
    s.readyPromise = new Promise((resolve,reject) => { s.readyResolve=resolve; s.readyReject=reject; });
    s.fail = error => {
      if (s.closed) return; s.closed=true; clearTimeout(s.startTimer);
      if (this.session===s) this.session=null;
      s.readyReject(error);
      if (s.pending) { clearTimeout(s.pending.timer); s.pending.reject(error); s.pending=null; }
      try { child.stdin.destroy(); child.kill(); } catch {}
    };
    s.startTimer = setTimeout(()=>{this.stats.timeouts++;s.fail(failure('ETIMEDOUT'));},Math.max(1,deadline-this.now()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (s.closed) return; s.buffer+=data;
      if (Buffer.byteLength(s.buffer)>1048576) { this.stats.protocolErrors++;s.fail(failure('GUEST_PROTOCOL'));return; }
      for (;;) {
        const end=s.buffer.indexOf('\n');if(end<0)break;const line=s.buffer.slice(0,end);s.buffer=s.buffer.slice(end+1);if(!line.trim())continue;
        let value;try{value=JSON.parse(line);}catch{this.stats.protocolErrors++;s.fail(failure('GUEST_PROTOCOL'));return;}
        if(!value||value.channel!==CHANNEL||value.session!==token){this.stats.protocolErrors++;s.fail(failure('GUEST_PROTOCOL'));return;}
        if(!s.ready){if(value.ready!==true){s.fail(failure('GUEST_PROTOCOL'));return;}s.ready=true;clearTimeout(s.startTimer);s.readyResolve(s);continue;}
        const p=s.pending;
        if(!p||value.seq!==p.seq||value.ready!==undefined){this.stats.protocolErrors++;s.fail(failure('GUEST_PROTOCOL'));return;}
        clearTimeout(p.timer);s.pending=null;this.stats.commandReplies++;
        const elapsed=this.now()-p.startedAt;if(Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=300000){this.timings.push(elapsed);this.timings=this.timings.slice(-200);}
        if(typeof value.stdout!=='undefined'&&typeof value.stdout!=='string'||value.error!==undefined&&!['ETIMEDOUT','GUEST_COMMAND_FAILED','GUEST_SCOPE','GUEST_OUTPUT_LIMIT'].includes(value.error)||!value.error&&!Number.isInteger(value.exitCode)){this.stats.protocolErrors++;p.reject(failure('GUEST_PROTOCOL'));s.fail(failure('GUEST_PROTOCOL'));return;}
        if(Buffer.byteLength(value.stdout??'')>p.maxBuffer){p.reject(failure('GUEST_OUTPUT_LIMIT'));s.fail(failure('GUEST_OUTPUT_LIMIT'));return;}
        if(value.error||value.exitCode!==0){this.stats.commandErrors++;if(value.error==='ETIMEDOUT')this.stats.timeouts++;p.reject(failure(value.error??value.exitCode,{stdout:value.stdout??'',stderr:''}));}
        else p.resolve({stdout:value.stdout??'',stderr:''});
      }
    });
    // Provider/client stderr is deliberately neither logged nor retained.
    child.stderr.on('data',()=>{});
    for(const pipe of [child.stdin,child.stdout,child.stderr])pipe.on('error',()=>s.fail(failure('GUEST_TRANSPORT_CLOSED')));
    child.on('error',()=>s.fail(failure('GUEST_TRANSPORT_CLOSED')));
    child.on('close',()=>{this.children.delete(child);s.fail(failure('GUEST_TRANSPORT_CLOSED'));});
    return s.readyPromise;
  }
  async run(argv, { timeout=5000, maxBuffer=32768, beforeDispatch } = {}) {
    validateGuestArgv(argv);
    if(this.closing)throw failure('GUEST_TRANSPORT_CLOSED');
    if(process.env.CHECKOUT_DISABLE_NATIVE==='1'&&this.spawn===spawnChild)throw failure('NATIVE_DISABLED_OFFLINE');
    if(this.busy)throw failure('GUEST_STREAM_BUSY');
    if(!Number.isInteger(timeout)||timeout<1||timeout>5000||!Number.isInteger(maxBuffer)||maxBuffer<1024||maxBuffer>65536)throw failure('GUEST_SCOPE');
    this.busy=true;const deadline=this.now()+timeout;
    try {
      const s=await this.open(deadline);if(s.closed||s.closing||this.now()>=deadline)throw failure('ETIMEDOUT');
      beforeDispatch?.();
      return await new Promise((resolve,reject)=>{
        const seq=randomUUID(),pending={seq,resolve,reject,startedAt:this.now(),maxBuffer};s.pending=pending;
        pending.timer=setTimeout(()=>{this.stats.timeouts++;s.fail(failure('ETIMEDOUT'));},Math.max(1,deadline-this.now()));
        try { s.child.stdin.write(JSON.stringify({channel:CHANNEL,session:s.token,seq,argv,timeoutMs:Math.min(timeout,Math.max(1,deadline-this.now())),maxBuffer})+'\n',error=>{if(error)s.fail(failure('GUEST_TRANSPORT_CLOSED'));}); }
        catch {s.fail(failure('GUEST_TRANSPORT_CLOSED'));}
      });
    } finally {this.busy=false;}
  }
  async close() {
    this.closing=true;
    const waitClosed=(child,ms)=>!this.children.has(child)?Promise.resolve(true):new Promise(resolve=>{
      let timer;const closed=()=>{clearTimeout(timer);resolve(true);};child.once('close',closed);
      timer=setTimeout(()=>{child.removeListener('close',closed);resolve(false);},ms);
    });
    try {
      const s=this.session;
      if(s){s.closing=true;if(s.pending)s.fail(failure('GUEST_TRANSPORT_CLOSED'));else try{s.child.stdin.end();}catch{s.fail(failure('GUEST_TRANSPORT_CLOSED'));}}
      await Promise.all([...this.children].map(async child=>{if(await waitClosed(child,1500))return;try{child.kill();}catch{}if(await waitClosed(child,500))return;try{child.kill('SIGKILL');}catch{}}));
    } finally {this.closing=false;}
  }
}

let shared;
export function runGuestStream(argv, options) { shared??=new MultipassGuestStream();return shared.run(argv,options); }
export function guestStreamSnapshot() { return shared?.snapshot()??null; }
export async function closeGuestStream() { const current=shared;shared=null;await current?.close(); }

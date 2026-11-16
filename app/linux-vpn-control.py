import concurrent.futures
import fcntl
import json
import math
import re
import shutil
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta

HOST='apple-pickup-linux'
BASE=Path('/opt/iphone-stock-pool')
FLEET_CONFIG=BASE/'fleet-vpn.json'
FLEET=json.loads(FLEET_CONFIG.read_text()) if FLEET_CONFIG.exists() else {'workerCount':19,'tunnelLimit':10}
if type(FLEET.get('workerCount')) is not int or not 1<=FLEET['workerCount']<=30 or type(FLEET.get('tunnelLimit')) is not int or not 1<=FLEET['tunnelLimit']<=FLEET['workerCount']:
    raise RuntimeError('Invalid fleet capacity')
NODES=range(1,FLEET['workerCount']+1)
TUNNEL_LIMIT=FLEET['tunnelLimit']
NORD_LIMIT=FLEET.get('nordLimit',10)
if type(NORD_LIMIT) is not int or not 0<=NORD_LIMIT<=10:raise RuntimeError('Invalid NordVPN capacity')
NATIVE_PROVIDER=FLEET.get('nativeProvider','nordvpn')
if NATIVE_PROVIDER not in ('nordvpn','windscribe'):raise RuntimeError('Invalid native provider')
JOBS=Path('/run/iphone-linux-vpn-operations')
CONNECT_PAUSE=Path('/run/iphone-linux-vpn-connect-pause.json')

def connect_wait_ms():
    if not CONNECT_PAUSE.exists():
        return 0
    try:
        value=json.loads(CONNECT_PAUSE.read_text())
        until=datetime.strptime(value['untilJST'],'%Y-%m-%d %H:%M:%S JST').replace(tzinfo=timezone(timedelta(hours=9))).timestamp()
        return max(0,math.ceil((until-time.time())*1000))
    except (OSError,ValueError,TypeError,KeyError):
        raise RuntimeError('VPN connect pause unverified')

def run(i, *args, timeout=8):
    prefix=[] if i==1 else ['/usr/bin/docker','exec',f'iphone-linux-vpn-{i}']
    return subprocess.run([*prefix,'/usr/bin/nordvpn',*args],capture_output=True,
                          text=True,timeout=timeout,check=True).stdout

def provider_config(i):
    path=Path('/etc/iphone-stock/vpn-provider.json') if i==1 else BASE/str(i)/'config'/'vpn-provider.json'
    value=json.loads(path.read_text()) if path.exists() else {'provider':'nordvpn'}
    if value.get('provider') not in ('nordvpn','windscribe') or i==1 and value['provider']!=NATIVE_PROVIDER:
        raise RuntimeError('Invalid provider')
    if value['provider']=='windscribe' and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 .'-]{1,63}",value.get('location','')):
        raise RuntimeError('Invalid location')
    return value

def windscribe_protocol(config):
    protocol=config.get('protocol',FLEET.get('windscribeProtocol','wireguard:443'))
    if protocol not in ('wireguard:443','tcp:443'):raise RuntimeError('Invalid Windscribe protocol')
    return protocol

def windscribe(i,*args,timeout=15):
    prefix=[] if i==1 else ['/usr/bin/docker','exec',f'iphone-linux-vpn-{i}']
    p=subprocess.run([*prefix,'/usr/sbin/runuser','-u','monitor','--','/usr/bin/flock','-w','10','/run/lock/apple-loop-vpn-cli.lock','/opt/windscribe/windscribe-cli',*args],capture_output=True,text=True,timeout=timeout,check=True)
    return p.stdout+p.stderr

def prepare_windscribe_dns(i):
    # The vendor replaces resolv.conf atomically. Docker's file bind mount
    # prevents that; detach only that mount inside this worker's namespaces.
    if socket.gethostname()!=HOST or i==1 or provider_config(i)['provider']!='windscribe':raise RuntimeError('DNS preparation scope invalid')
    p=subprocess.run(['/usr/bin/docker','inspect',f'iphone-linux-vpn-{i}'],capture_output=True,text=True,timeout=5,check=True)
    value=json.loads(p.stdout)[0];pid=value['State']['Pid'];host=value['HostConfig']
    if type(pid) is not int or pid<=1 or not value['State']['Running'] or host['Privileged'] or host['NetworkMode']=='host' or host.get('PidMode')=='host':raise RuntimeError('DNS namespace unverified')
    if __import__('os').stat(f'/proc/{pid}/ns/mnt').st_ino==__import__('os').stat('/proc/self/ns/mnt').st_ino:raise RuntimeError('DNS namespace shared with guest')
    original=subprocess.run(['/usr/bin/docker','exec',f'iphone-linux-vpn-{i}','/bin/cat','/etc/resolv.conf'],capture_output=True,text=True,timeout=5,check=True).stdout
    if len(original)>65536 or 'nameserver ' not in original:raise RuntimeError('Resolver configuration unverified')
    command='if /usr/bin/mountpoint -q /etc/resolv.conf; then /bin/umount /etc/resolv.conf && /bin/cat > /etc/resolv.conf; fi'
    subprocess.run(['/usr/bin/nsenter','--target',str(pid),'--mount','--pid','--net','--root','--wd=/','--','/bin/sh','-c',command],input=original,capture_output=True,text=True,timeout=10,check=True)

UNAVAILABLE_LOCATION=re.compile(r'\b(?:disabled|offline|unavailable)\b|[\u2717\u00d7]',re.I)

def windscribe_locations(text):
    result=[]
    for line in re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',text).splitlines():
        if ' - ' not in line or UNAVAILABLE_LOCATION.search(line):continue
        value=line.rsplit(' - ',1)[-1].split(' (',1)[0].strip()
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 .'-]{1,63}",value):result.append(value)
    return result

def windscribe_kernel_disconnected(i):
    if i==1 or socket.gethostname()!=HOST:return False
    try:
        parent=f'iphone-linux-vpn-{i}'
        value=json.loads(subprocess.run(['/usr/bin/docker','inspect',parent],capture_output=True,text=True,timeout=5,check=True).stdout)[0]
        host=value['HostConfig'];pid=value['State']['Pid']
        if not value['State']['Running'] or host['Privileged'] or host['NetworkMode'] not in ('bridge','default') or host.get('PidMode'):return False
        if __import__('os').stat(f'/proc/{pid}/ns/net').st_ino==__import__('os').stat('/proc/self/ns/net').st_ino:return False
        links=json.loads(subprocess.run(['/usr/bin/docker','exec',parent,'/usr/sbin/ip','-j','-d','link','show'],capture_output=True,text=True,timeout=5,check=True).stdout)
        if not links or any(v.get('ifname') not in ('lo','eth0') or v.get('linkinfo',{}).get('info_kind') in ('tun','wireguard') for v in links):return False
        names=subprocess.run(['/usr/bin/docker','exec',parent,'/usr/bin/ps','-eo','comm='],capture_output=True,text=True,timeout=5,check=True).stdout.split()
        allowed={'Windscribe','apple-loop-wind','dbus-daemon','helper','node','ps','runuser','tini','flock','sh','bash','sleep'}
        return bool(names) and all(name in allowed for name in names)
    except (OSError,subprocess.SubprocessError,ValueError,TypeError,KeyError):return False

def windscribe_state(text,location):
    fields={line.split(':',1)[0].strip().lower():line.split(':',1)[1].strip() for line in re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',text).splitlines() if ':' in line}
    state=fields.get('connect state','')
    logged=bool(re.match(r'^Logged in(?:\s|$)',fields.get('login state',''),re.I))
    connected=True if re.match(r'^Connected(?:[:\s]|$)',state,re.I) else False if re.match(r'^Disconnected(?:[:\s]|$)',state,re.I) or not logged and re.search(r'logged out|not logged in',fields.get('login state',''),re.I) else None
    return {'connected':connected,'connecting':bool(re.match(r'^Connecting(?:[:\s]|$)',state,re.I)),'connectionError':bool(re.match(r'^Error(?:[:\s]|$)',state,re.I)),'assignmentUnavailable':bool(re.search(r'^Error.*location.*(?:disabled|not.*exist)',state,re.I)),'pinned':connected is True and location.lower() in (state+' '+fields.get('location','')).lower(),'firewallOn':bool(re.match(r'^(On|Always On)(?:\s|$)',fields.get('firewall state',''),re.I)),'authReady':logged}

def sync_windscribe_browser_dns(i):
    if socket.gethostname()!=HOST or provider_config(i)['provider']!='windscribe':raise RuntimeError('DNS sync scope invalid')
    parent=f'iphone-linux-vpn-{i}';browser=f'iphone-linux-worker-{i}-a'
    p=subprocess.run(['/usr/bin/docker','inspect',*([browser] if i==1 else [parent,browser])],capture_output=True,text=True,timeout=5,check=True)
    if i==1:
        target=json.loads(p.stdout)[0]
        if not target['State']['Running'] or target['HostConfig']['NetworkMode']!='host':raise RuntimeError('Native browser network unverified')
    else:
        source,target=json.loads(p.stdout)
        if not source['State']['Running'] or not target['State']['Running'] or target['HostConfig']['NetworkMode'] not in ('container:'+parent,'container:'+source['Id']):raise RuntimeError('Browser network namespace unverified')
    pid=target['State']['Pid']
    if type(pid) is not int or pid<=1 or __import__('os').stat(f'/proc/{pid}/ns/mnt').st_ino==__import__('os').stat('/proc/self/ns/mnt').st_ino:raise RuntimeError('Browser mount namespace unverified')
    resolver=subprocess.run([*([] if i==1 else ['/usr/bin/docker','exec',parent]),'/bin/cat','/etc/resolv.conf'],capture_output=True,text=True,timeout=5,check=True).stdout
    if len(resolver)>65536 or not re.search(r'^nameserver\s+\S+',resolver,re.M):raise RuntimeError('VPN resolver unverified')
    # Docker makes this separate file mount read-only with a read-only rootfs.
    # Remount only the browser's resolver; retain the rest of its sandbox.
    subprocess.run(['/usr/bin/nsenter','--target',str(pid),'--mount','--pid','--net','--root','--wd=/','--','/bin/mount','-o','remount,rw,bind','/etc/resolv.conf'],capture_output=True,text=True,timeout=5,check=True)
    subprocess.run(['/usr/bin/docker','exec','-i','--user','0:0',browser,'/bin/sh','-c','cat > /etc/resolv.conf'],input=resolver,capture_output=True,text=True,timeout=5,check=True)
    observed=subprocess.run(['/usr/bin/docker','exec',browser,'/bin/cat','/etc/resolv.conf'],capture_output=True,text=True,timeout=5,check=True).stdout
    if observed!=resolver:raise RuntimeError('Browser resolver unverified')

def pause_data(i,config):
    path=BASE/str(i)/'state'/'.iphone-stock-ledger.json' if i!=1 else Path('/home/monitor/.iphone-stock-ledger.json')
    try:state=json.loads(path.read_text())
    except FileNotFoundError:
        if config['provider']!='windscribe':raise
        state={}
    deadline=state.get('nextAllowedAt') or 0
    last=state.get('lastStartedAt') or 0
    successes=state.get('successes')
    value={'nextAllowedInMs':max(0,max(deadline,last+65000)-int(time.time()*1000)),'connectNextAllowedInMs':connect_wait_ms() if config['provider']=='nordvpn' else 0,'completedChecks':successes if type(successes) is int and successes>=0 else None}
    if state.get('pauseHttpStatus')==541 and deadline>int(time.time()*1000):value['pauseHttpStatus']=541
    if config.get('rotationForPauseUntil',0)>0:value['rotationCoversPause']=config['rotationForPauseUntil']>=deadline
    return value

def pin(i):
    config=provider_config(i)
    if config['provider']=='windscribe':return config['location']
    path=Path('/etc/iphone-stock/nordvpn-server') if i==1 else BASE/str(i)/'server'
    value=path.read_text().strip()
    if not re.fullmatch(r'jp[0-9]+',value):
        raise RuntimeError('Invalid server pin')
    return value

def status(i):
    try:
        config=provider_config(i)
        if config['provider']=='windscribe':
            state=windscribe_state(windscribe(i,'status'),config['location'])
            if state.get('assignmentUnavailable') and windscribe_kernel_disconnected(i):
                available=windscribe_locations(windscribe(i,'locations'))
                state.update(connected=False,connectionError=False,kernelDisconnected=True,assignmentUnavailable=config['location'].lower() not in {v.lower() for v in available})
            return {**state,**pause_data(i,config),'provider':'windscribe'}
        out=run(i,'status')
        if re.search(r'^Status: Connecting\s*$',out,re.M):
            return {'connected':None,'connecting':True}
        if re.search(r'^Status: Disconnected\s*$',out,re.M):
            return {'connected':False,**pause_data(i,config)}
        if re.search(r'^Status: Connected\s*$',out,re.M):
            server=re.search(r'^Hostname: (jp[0-9]+)\.nordvpn\.com\s*$',out,re.M)
            return {'connected':True,'pinned':bool(server and server[1]==pin(i)),**({'rotationCoversPause':True} if config.get('rotationForPauseUntil',0)>0 and pause_data(i,config).get('rotationCoversPause') else {})}
    except (OSError, subprocess.SubprocessError, RuntimeError,ValueError,TypeError):
        pass
    return {'connected':None}

def inventory():
    if len({provider_config(i)['provider']+':'+pin(i).lower() for i in NODES})!=len(NODES):
        raise RuntimeError('Server pins are not unique')
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        return dict(zip(NODES,pool.map(status,NODES)))

def validate_operation(args):
    if args==['inventory']:
        return
    if len(args)!=2 or args[0] not in ('connect','disconnect','rotate') or not args[1].isdigit() or int(args[1]) not in NODES or args[0]=='rotate' and args[1]=='1':
        raise RuntimeError('Invalid operation')

def execute(args):
    validate_operation(args)
    op,*args=args
    if op=='inventory' and not args:
        return inventory()
    if op not in ('connect','disconnect','rotate') or len(args)!=1 or not args[0].isdigit():
        raise RuntimeError('Invalid operation')
    i=int(args[0])
    if i not in NODES:
        raise RuntimeError('Invalid worker')
    with open('/run/lock/iphone-linux-vpn-pool.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if op=='disconnect':
            disconnect_state=status(i)
            if disconnect_state['connected'] is not False or disconnect_state.get('kernelDisconnected'):
                if provider_config(i)['provider']=='windscribe':
                    windscribe(i,'disconnect','-n')
                    for _ in range(20):
                        if status(i)['connected'] is False:break
                        time.sleep(0.5)
                else:run(i,'disconnect',timeout=25)
            return status(i)
        live=inventory()
        current=live[i]
        config=provider_config(i)
        if op=='rotate':
            if i==1 or current['connected'] is not False or any(s['connected'] is None for s in live.values()):raise RuntimeError('Rotation inventory unverified')
            assigned={pin(j).lower() for j in NODES if j!=i and provider_config(j)['provider']==config['provider']}
            pool=FLEET.get('rotationPool',{}).get(config['provider'],[])
            if config['provider']=='windscribe':
                available={v.lower() for v in windscribe_locations(windscribe(i,'locations'))}
                pool=[v for v in pool if type(v) is str and v.lower() in available]
            candidates=[v for v in pool if type(v) is str and v.lower() not in assigned and v.lower()!=pin(i).lower()]
            if not candidates:raise RuntimeError('No unused rotation location')
            target=candidates[0]
            if config['provider']=='nordvpn':
                if not re.fullmatch(r'jp[0-9]+',target):raise RuntimeError('Invalid rotation pin')
                with open(BASE/str(i)/'server','w') as p:p.write(target+'\n');p.flush();__import__('os').fsync(p.fileno())
            else:
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 .'-]{1,63}",target):raise RuntimeError('Invalid rotation location')
                config['location']=target
            ledger=BASE/str(i)/'state'/'.iphone-stock-ledger.json'
            state=json.loads(ledger.read_text()) if ledger.exists() else {}
            config['rotationForPauseUntil']=state.get('nextAllowedAt') or 0
            config['rotationVersion']=config.get('rotationVersion',0)+1
            path=BASE/str(i)/'config'/'vpn-provider.json';path.parent.mkdir(parents=True,exist_ok=True)
            temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(config));temporary.chmod(0o644);temporary.replace(path)
            return {'rotated':True}
        if current['connected'] is True and current.get('pinned'):
            if config['provider']=='windscribe':sync_windscribe_browser_dns(i)
            return current
        if current['connected'] is not False or any(s['connected'] is None or
                (s['connected'] is True and not s.get('pinned')) for s in live.values()):
            raise RuntimeError('Tunnel inventory unverified')
        if sum(s['connected'] is True for s in live.values())>=TUNNEL_LIMIT or config['provider']=='nordvpn' and sum(s['connected'] is True and provider_config(j)['provider']=='nordvpn' for j,s in live.items())>=NORD_LIMIT:
            raise RuntimeError('No free tunnel')
        if config['provider']=='nordvpn' and connect_wait_ms()>0:
            raise RuntimeError('VPN connect pause')
        if config['provider']=='windscribe':
            protocol=windscribe_protocol(config)
            if not current.get('authReady'):raise RuntimeError('Provider authentication required')
            if i!=1:prepare_windscribe_dns(i)
            windscribe(i,'firewall','on')
            if not status(i).get('firewallOn'):raise RuntimeError('Kill switch unverified')
            windscribe(i,'connect','-n',config['location'],protocol)
            for _ in range(50):
                value=status(i)
                if value['connected'] is True and value.get('pinned'):
                    sync_windscribe_browser_dns(i)
                    return value
                time.sleep(0.5)
            return status(i)
        if not re.search(r'^Kill Switch: enabled\s*$',run(i,'settings'),re.I|re.M):
            raise RuntimeError('Kill switch unverified')
        run(i,'connect',pin(i),timeout=30)
        return status(i)


def job_path(request_id):
    if str(uuid.UUID(request_id))!=request_id:
        raise RuntimeError('Invalid request id')
    return JOBS/request_id

def write_result(path, value):
    temporary=path/'result.tmp'
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(path/'result.json')

def control_failure(error):
    codes={'Rotation inventory unverified':'VPN_INVENTORY_UNVERIFIED','Tunnel inventory unverified':'VPN_INVENTORY_UNVERIFIED','No unused rotation location':'ROTATION_CAPACITY_UNAVAILABLE','Provider authentication required':'PROVIDER_AUTH_REQUIRED','VPN connect pause':'PROVIDER_PAUSE','Kill switch unverified':'KILL_SWITCH_UNVERIFIED','No free tunnel':'VPN_CAPACITY_UNAVAILABLE'}
    return {'ok':False,'code':codes.get(str(error),'CONTROL_FAILED') if isinstance(error,RuntimeError) else 'CONTROL_FAILED'}

def run_job(request_id):
    path=job_path(request_id)
    try:
        args=json.loads((path/'request.json').read_text())
        result={'ok':True,'result':execute(args)}
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError, TypeError) as error:
        result=control_failure(error)
    write_result(path,result)
    return result

def start_job(request_id,args):
    validate_operation(args)
    path=job_path(request_id)
    JOBS.mkdir(mode=0o700,parents=True,exist_ok=True)
    # Keep completed replies long enough to reconcile a lost host response.
    for old in JOBS.iterdir():
        if old.is_dir() and (old/'result.json').is_file() and time.time()-(old/'result.json').stat().st_mtime>600:
            job_path(old.name)
            shutil.rmtree(old)
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        if json.loads((path/'request.json').read_text())!=args:
            raise RuntimeError('Request id reused')
        return {'ok':True,'pending':True}
    (path/'request.json').write_text(json.dumps(args))
    (path/'request.json').chmod(0o600)
    try:
        subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'_job',request_id],
                         stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                         start_new_session=True,close_fds=True)
    except OSError:
        write_result(path,{'ok':False})
        raise
    return {'ok':True,'pending':True}

def job_result(request_id):
    path=job_path(request_id)
    if not path.exists():
        return {'ok':False,'code':'operation-missing'}
    if not (path/'request.json').is_file():
        return {'ok':True,'pending':True}
    result=path/'result.json'
    return json.loads(result.read_text()) if result.is_file() else {'ok':True,'pending':True}

def main(args):
    if socket.gethostname()!=HOST:
        raise RuntimeError('Wrong guest')
    if len(args)>=3 and args[0]=='start':
        return start_job(args[1],args[2:])
    if len(args)==2 and args[0]=='result':
        return job_result(args[1])
    if len(args)==2 and args[0]=='_job':
        return run_job(args[1])
    return {'ok':True,'result':execute(args)}

def operation_reply(request_id,value):
    if str(uuid.UUID(request_id))!=request_id or type(value) is not dict or type(value.get('ok')) is not bool:
        raise RuntimeError('Invalid operation reply')
    return {**value,'requestId':request_id,'channel':'vpn-control-v1'}

if __name__=='__main__':
    try:
        value=main(sys.argv[1:])
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError, TypeError) as error:
        value=control_failure(error)
    if len(sys.argv)>=3 and sys.argv[1] in ('start','result'):
        try:value=operation_reply(sys.argv[2],value)
        except (ValueError,RuntimeError,TypeError):value={'ok':False}
    print(json.dumps(value))
    sys.exit(0 if value['ok'] else 1)

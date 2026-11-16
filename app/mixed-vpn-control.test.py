import importlib.util,json,tempfile,unittest,os
from pathlib import Path
from unittest.mock import patch,mock_open
spec=importlib.util.spec_from_file_location('mixed_control',os.environ.get('VPN_CONTROL_SOURCE',Path(__file__).with_name('linux-vpn-control.py')))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
class MixedProviderTests(unittest.TestCase):
 def test_disabled_location_is_free_only_after_independent_kernel_verification(self):
  text='Login state: Logged in\nConnect state: Error: Location is disabled or does not exist\nFirewall state: On'
  self.assertIsNone(c.windscribe_state(text,'Broken')['connected'])
  for detached,catalog,unavailable in [(False,'JP - City - Healthy',True),(True,'JP - City - Broken (Disabled)\nJP - City - Healthy',True),(True,'JP - City - Healthy',False)]:
   location='Healthy' if not unavailable else 'Broken'
   with patch.object(c,'provider_config',return_value={'provider':'windscribe','location':location}),patch.object(c,'pause_data',return_value={}),patch.object(c,'windscribe',side_effect=lambda i,op: text if op=='status' else catalog),patch.object(c,'windscribe_kernel_disconnected',return_value=detached):
    value=c.status(15);self.assertEqual(value['connected'],False if detached else None);self.assertEqual(value['assignmentUnavailable'],unavailable)
 def test_kernel_verification_rejects_shared_namespaces_tunnel_interfaces_and_vpn_processes(self):
  import subprocess,types
  for unsafe in [None,'host','same-namespace','tun','vpn-process','unknown-process']:
   data={'State':{'Pid':123,'Running':True},'HostConfig':{'Privileged':False,'NetworkMode':'host' if unsafe=='host' else 'bridge','PidMode':''}}
   links=[{'ifname':'lo'},{'ifname':'eth0'}]+([{'ifname':'tun0','linkinfo':{'info_kind':'tun'}}] if unsafe=='tun' else [])
   names='Windscribe node ps '+('windscribeopenv' if unsafe=='vpn-process' else 'unexpected' if unsafe=='unknown-process' else '')
   replies=[subprocess.CompletedProcess([],0,json.dumps([data]),''),subprocess.CompletedProcess([],0,json.dumps(links),''),subprocess.CompletedProcess([],0,names,'')]
   with patch.object(c.socket,'gethostname',return_value=c.HOST),patch('os.stat',side_effect=[types.SimpleNamespace(st_ino=11),types.SimpleNamespace(st_ino=11 if unsafe=='same-namespace' else 10)]),patch.object(c.subprocess,'run',side_effect=replies):
    self.assertEqual(c.windscribe_kernel_disconnected(15),unsafe is None)
  with patch.object(c.subprocess,'run') as run:self.assertFalse(c.windscribe_kernel_disconnected(1));run.assert_not_called()
 def test_catalog_filters_disabled_locations_before_rotation(self):
  catalog='JP - City - Broken (Disabled)\nJP - City - Healthy\nCA - City - Down (Offline)'
  self.assertEqual(c.windscribe_locations(catalog),['Healthy'])
 def test_vendor_terminal_error_remains_uncertain_until_explicit_disconnect(self):
  value=c.windscribe_state('Login state: Logged in\nConnect state: Error\nFirewall state: Off','Fixture')
  self.assertIsNone(value['connected']);self.assertTrue(value['connectionError']);self.assertFalse(value['connecting']);self.assertFalse(value['pinned'])
  self.assertFalse(c.windscribe_state('Login state: Logged in\nConnect state: Disconnected\nFirewall state: Off','Fixture')['connectionError'])
 def test_windscribe_protocol_defaults_and_explicit_supported_override(self):
  with patch.object(c,'FLEET',{}):self.assertEqual(c.windscribe_protocol({}),'wireguard:443')
  with patch.object(c,'FLEET',{'windscribeProtocol':'tcp:443'}):
   self.assertEqual(c.windscribe_protocol({}),'tcp:443')
   self.assertEqual(c.windscribe_protocol({'protocol':'wireguard:443'}),'wireguard:443')
 def test_tcp_uses_one_vendor_connect_without_deleting_keys(self):
  inventory={i:{'connected':i<=8,'pinned':True} for i in c.NODES};inventory[19]={'connected':False,'authReady':True}
  config=lambda i:{'provider':'windscribe','location':'Fixture','protocol':'tcp:443'} if i==19 else {'provider':'nordvpn'}
  state={'connected':True,'pinned':True,'firewallOn':True}
  with patch('builtins.open',mock_open()),patch.object(c.fcntl,'flock'),patch.object(c,'inventory',return_value=inventory),patch.object(c,'provider_config',side_effect=config),patch.object(c,'status',return_value=state),patch.object(c,'windscribe') as cli,patch.object(c,'prepare_windscribe_dns'),patch.object(c,'sync_windscribe_browser_dns'),patch.object(c,'run') as nord:
   self.assertEqual(c.execute(['connect','19']),state)
   self.assertEqual([call.args for call in cli.call_args_list],[(19,'firewall','on'),(19,'connect','-n','Fixture','tcp:443')]);nord.assert_not_called()
 def test_invalid_protocol_fails_before_any_provider_mutation(self):
  inventory={i:{'connected':i<=8,'pinned':True} for i in c.NODES};inventory[19]={'connected':False,'authReady':True}
  for invalid in ['tcp:80','wireguard:443 --delete-oldest-key',None,[],{}]:
   config=lambda i:{'provider':'windscribe','location':'Fixture','protocol':invalid} if i==19 else {'provider':'nordvpn'}
   with patch('builtins.open',mock_open()),patch.object(c.fcntl,'flock'),patch.object(c,'inventory',return_value=inventory),patch.object(c,'provider_config',side_effect=config),patch.object(c,'windscribe') as cli,patch.object(c,'prepare_windscribe_dns') as dns:
    with self.assertRaisesRegex(RuntimeError,'Invalid Windscribe protocol'):c.execute(['connect','19'])
    cli.assert_not_called();dns.assert_not_called()
 def test_connected_wireguard_is_preserved_when_future_default_is_tcp(self):
  state={'connected':True,'pinned':True,'firewallOn':True}
  with patch('builtins.open',mock_open()),patch.object(c.fcntl,'flock'),patch.object(c,'FLEET',{'windscribeProtocol':'tcp:443'}),patch.object(c,'inventory',return_value={19:state}),patch.object(c,'provider_config',return_value={'provider':'windscribe','location':'Fixture'}),patch.object(c,'windscribe') as cli,patch.object(c,'sync_windscribe_browser_dns') as dns:
   self.assertEqual(c.execute(['connect','19']),state);cli.assert_not_called();dns.assert_called_once_with(19)
 def test_provider_cli_opens_its_shared_lock_as_the_profile_owner(self):
  import subprocess
  with patch.object(c.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'safe','')) as run:
   self.assertEqual(c.windscribe(7,'status'),'safe')
   args=run.call_args.args[0]
   self.assertLess(args.index('/usr/sbin/runuser'),args.index('/usr/bin/flock'))
 def test_native_windscribe_uses_guest_cli_without_a_container_or_guest_dns_detach(self):
  import subprocess
  with patch.object(c.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'safe','')) as run:
   c.windscribe(1,'status');self.assertNotIn('/usr/bin/docker',run.call_args.args[0]);self.assertIn('monitor',run.call_args.args[0])
  inventory={i:{'connected':i!=1,'pinned':True,'authReady':True,'provider':'windscribe'} for i in range(1,31)}
  config={'provider':'windscribe','location':'Native fixture'};state={'connected':True,'pinned':True,'firewallOn':True}
  with patch('builtins.open',mock_open()),patch.object(c.fcntl,'flock'),patch.object(c,'NODES',range(1,31)),patch.object(c,'TUNNEL_LIMIT',30),patch.object(c,'NORD_LIMIT',0),patch.object(c,'inventory',return_value=inventory),patch.object(c,'provider_config',return_value=config),patch.object(c,'status',return_value=state),patch.object(c,'windscribe') as cli,patch.object(c,'prepare_windscribe_dns') as detach,patch.object(c,'sync_windscribe_browser_dns') as sync:
   self.assertEqual(c.execute(['connect','1']),state);detach.assert_not_called();sync.assert_called_once_with(1)
 def test_status_requires_matching_location_authentication_and_firewall(self):
  s='Login state: Logged in\nConnect state: Connected to Japan - Tokyo - Shinkansen\nFirewall state: On (Always On)'
  v=c.windscribe_state(s,'Shinkansen');self.assertTrue(v['connected'] and v['pinned'] and v['firewallOn'] and v['authReady'])
  self.assertFalse(c.windscribe_state(s,'Wabi-sabi')['pinned'])
  self.assertFalse(c.windscribe_state(s.replace('On (Always On)','Off'),'Shinkansen')['firewallOn'])
  self.assertIsNone(c.windscribe_state(s.replace('Connected to','Connecting to'),'Shinkansen')['connected'])
  colon=s.replace('Connected to Japan - Tokyo - Shinkansen','Connected: Tokyo - Shinkansen')
  self.assertTrue(c.windscribe_state(colon,'Shinkansen')['connected'])
  self.assertFalse(c.windscribe_state(colon,'Wabi-sabi')['pinned'])
 def test_eight_nord_seats_cannot_be_refilled_even_below_aggregate_capacity(self):
  inventory={i:{'connected':i<=8,'pinned':True} for i in c.NODES}
  with patch('builtins.open',mock_open()),patch.object(c.fcntl,'flock'),patch.object(c,'NORD_LIMIT',8),patch.object(c,'TUNNEL_LIMIT',30),patch.object(c,'inventory',return_value=inventory),patch.object(c,'run') as run:
   with self.assertRaisesRegex(RuntimeError,'No free tunnel'):c.execute(['connect','9'])
   run.assert_not_called()
 def test_windscribe_connect_is_single_nonblocking_submission_and_never_uses_nord(self):
  inventory={i:{'connected':i<=8,'pinned':True} for i in c.NODES};inventory[19]={'connected':False,'authReady':True}
  state={'connected':True,'pinned':True,'firewallOn':True}
  provider=lambda i:{'provider':'windscribe','location':'Shinkansen'} if i==19 else {'provider':'nordvpn'}
  with patch('builtins.open',mock_open()),patch.object(c.fcntl,'flock'),patch.object(c,'inventory',return_value=inventory),patch.object(c,'provider_config',side_effect=provider),patch.object(c,'status',return_value=state),patch.object(c,'windscribe') as cli,patch.object(c,'prepare_windscribe_dns') as dns,patch.object(c,'sync_windscribe_browser_dns') as browser_dns,patch.object(c,'run') as nord:
   self.assertEqual(c.execute(['connect','19']),state)
   self.assertEqual([call.args for call in cli.call_args_list],[(19,'firewall','on'),(19,'connect','-n','Shinkansen','wireguard:443')]);nord.assert_not_called()
   dns.assert_called_once_with(19)
   browser_dns.assert_called_once_with(19)
 def test_browser_dns_requires_the_same_vpn_namespace_and_verified_copy(self):
  import subprocess,types
  source={'Id':'fixture','State':{'Running':True}}
  target={'State':{'Running':True,'Pid':123},'HostConfig':{'NetworkMode':'container:fixture'}}
  resolver='nameserver 192.0.2.1\n'
  replies=[subprocess.CompletedProcess([],0,json.dumps([source,target]),''),subprocess.CompletedProcess([],0,resolver,''),subprocess.CompletedProcess([],0,'',''),subprocess.CompletedProcess([],0,'',''),subprocess.CompletedProcess([],0,resolver,'')]
  with patch.object(c.socket,'gethostname',return_value=c.HOST),patch.object(c,'provider_config',return_value={'provider':'windscribe'}),patch('os.stat',side_effect=[types.SimpleNamespace(st_ino=11),types.SimpleNamespace(st_ino=10)]),patch.object(c.subprocess,'run',side_effect=replies) as run:
   c.sync_windscribe_browser_dns(7)
   write=run.call_args_list[3];self.assertIn('iphone-linux-worker-7-a',write.args[0]);self.assertEqual(write.kwargs['input'],resolver)
   self.assertIn('remount,rw,bind',run.call_args_list[2].args[0])
  target['HostConfig']['NetworkMode']='host'
  with patch.object(c.socket,'gethostname',return_value=c.HOST),patch.object(c,'provider_config',return_value={'provider':'windscribe'}),patch.object(c.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps([source,target]),'')) as run:
   with self.assertRaisesRegex(RuntimeError,'namespace unverified'):c.sync_windscribe_browser_dns(7)
   self.assertEqual(run.call_count,1)
 def test_dns_preparation_rejects_native_worker_and_shared_guest_namespace(self):
  import subprocess,types
  with patch.object(c.socket,'gethostname',return_value=c.HOST),patch.object(c,'provider_config',return_value={'provider':'windscribe'}),patch.object(c.subprocess,'run') as run:
   with self.assertRaises(RuntimeError):c.prepare_windscribe_dns(1)
   run.assert_not_called()
   data={'State':{'Pid':123,'Running':True},'HostConfig':{'Privileged':False,'NetworkMode':'bridge','PidMode':''}}
   run.return_value=subprocess.CompletedProcess([],0,json.dumps([data]),'')
   with patch('os.stat',return_value=types.SimpleNamespace(st_ino=10)):
    with self.assertRaisesRegex(RuntimeError,'shared with guest'):c.prepare_windscribe_dns(7)
 def test_dns_preparation_uses_the_container_mount_pid_and_network_namespaces(self):
  import subprocess,types
  data={'State':{'Pid':123,'Running':True},'HostConfig':{'Privileged':False,'NetworkMode':'bridge','PidMode':''}}
  replies=[subprocess.CompletedProcess([],0,json.dumps([data]),''),subprocess.CompletedProcess([],0,'nameserver 127.0.0.11\n',''),subprocess.CompletedProcess([],0,'','')]
  with patch.object(c.socket,'gethostname',return_value=c.HOST),patch.object(c,'provider_config',return_value={'provider':'windscribe'}),patch('os.stat',side_effect=[types.SimpleNamespace(st_ino=11),types.SimpleNamespace(st_ino=10)]),patch.object(c.subprocess,'run',side_effect=replies) as run:
   c.prepare_windscribe_dns(7)
   args=run.call_args.args[0];self.assertIn('--mount',args);self.assertIn('--pid',args);self.assertIn('--net',args);self.assertIn('--root',args);self.assertEqual(run.call_args.kwargs['input'],'nameserver 127.0.0.11\n')
 def test_rotation_changes_only_assignment_and_preserves_retry_after_ledger(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d)
   for i,loc in [(2,'Alpha'),(3,'Beta')]:
    (base/str(i)/'config').mkdir(parents=True);(base/str(i)/'state').mkdir()
    (base/str(i)/'config'/'vpn-provider.json').write_text(json.dumps({'provider':'windscribe','location':loc}))
   ledger=base/'2'/'state'/'.iphone-stock-ledger.json';original=json.dumps({'attempts':8,'successes':7,'nextAllowedAt':99999999,'pauseHttpStatus':541});ledger.write_text(original)
   config=lambda i:{'provider':'nordvpn'} if i==1 else json.loads((base/str(i)/'config'/'vpn-provider.json').read_text())
   pin=lambda i:'jp1' if i==1 else config(i)['location']
   with patch('builtins.open',mock_open()),patch.object(c.fcntl,'flock'),patch.object(c,'BASE',base),patch.object(c,'NODES',range(1,4)),patch.object(c,'FLEET',{'rotationPool':{'windscribe':['Alpha','Beta','Gamma']}}),patch.object(c,'provider_config',side_effect=config),patch.object(c,'pin',side_effect=pin),patch.object(c,'inventory',return_value={1:{'connected':True},2:{'connected':False},3:{'connected':False}}),patch.object(c,'windscribe',return_value='Fixture - City - Alpha\nFixture - City - Beta\nFixture - City - Gamma'):
    self.assertEqual(c.execute(['rotate','2']),{'rotated':True})
   self.assertEqual(ledger.read_text(),original);self.assertEqual(config(2)['location'],'Gamma');self.assertEqual(config(2)['rotationForPauseUntil'],99999999)
   self.assertEqual((base/'2'/'config'/'vpn-provider.json').stat().st_mode & 0o777,0o644)
 def test_native_tunnel_cannot_be_rotated(self):
  with self.assertRaises(RuntimeError):c.validate_operation(['rotate','1'])
if __name__=='__main__':unittest.main()

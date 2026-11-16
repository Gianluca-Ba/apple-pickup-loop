import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch
from unittest.mock import mock_open

spec=importlib.util.spec_from_file_location('vpn_control',Path(__file__).with_name('linux-vpn-control.py'))
control=importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)

class AsyncControlTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.jobs=Path(self.directory.name)/'jobs'
        self.patcher=patch.object(control,'JOBS',self.jobs)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.request_id=str(uuid.uuid4())

    def test_launch_returns_pending_and_does_not_wait_or_repeat_the_operation(self):
        with patch.object(control.subprocess,'Popen') as spawn, patch.object(control,'execute') as execute:
            self.assertEqual(control.start_job(self.request_id,['connect','2']),{'ok':True,'pending':True})
            self.assertEqual(control.start_job(self.request_id,['connect','2']),{'ok':True,'pending':True})
            self.assertEqual(control.job_result(self.request_id),{'ok':True,'pending':True})
            spawn.assert_called_once()
            execute.assert_not_called()
            self.assertEqual(spawn.call_args.args[0][-2:],['_job',self.request_id])
            self.assertTrue(spawn.call_args.kwargs['start_new_session'])
            self.assertEqual(os.stat(self.jobs/self.request_id).st_mode & 0o777,0o700)

    def test_result_can_be_read_repeatedly_after_a_lost_reply(self):
        with patch.object(control.subprocess,'Popen'):
            control.start_job(self.request_id,['connect','2'])
        with patch.object(control,'execute',return_value={'connected':True,'pinned':True}) as execute:
            expected={'ok':True,'result':{'connected':True,'pinned':True}}
            self.assertEqual(control.run_job(self.request_id),expected)
            self.assertEqual(control.job_result(self.request_id),expected)
            self.assertEqual(control.job_result(self.request_id),expected)
            execute.assert_called_once_with(['connect','2'])
        self.assertFalse((self.jobs/self.request_id/'result.tmp').exists())

    def test_failure_is_terminal_and_does_not_expose_daemon_output(self):
        with patch.object(control.subprocess,'Popen'):
            control.start_job(self.request_id,['connect','2'])
        failure=subprocess.CalledProcessError(1,['daemon'],output='private daemon output')
        with patch.object(control,'execute',side_effect=failure):
            self.assertEqual(control.run_job(self.request_id),{'ok':False,'code':'CONTROL_FAILED'})
        self.assertEqual(control.job_result(self.request_id),{'ok':False,'code':'CONTROL_FAILED'})

    def test_malformed_operations_and_conflicting_ids_never_spawn(self):
        with patch.object(control.subprocess,'Popen') as spawn:
            for args in (['connect','0'],['connect','20'],['disconnect','x'],['logout'],['inventory','2']):
                with self.assertRaises(RuntimeError):
                    control.start_job(self.request_id,args)
            for request_id in ('../escape','broken',str(uuid.uuid4()).upper()):
                with self.assertRaises((ValueError,RuntimeError)):
                    control.start_job(request_id,['inventory'])
            spawn.assert_not_called()
            control.start_job(self.request_id,['connect','2'])
            with self.assertRaises(RuntimeError):
                control.start_job(self.request_id,['disconnect','2'])
            self.assertEqual(spawn.call_count,1)

    def test_completed_jobs_expire_but_pending_replies_are_retained(self):
        with patch.object(control.subprocess,'Popen'):
            control.start_job(self.request_id,['inventory'])
            control.write_result(self.jobs/self.request_id,{'ok':True,'result':{}})
            result=self.jobs/self.request_id/'result.json'
            os.utime(result,(0,0))
            pending_id=str(uuid.uuid4())
            control.start_job(pending_id,['inventory'])
            self.assertFalse((self.jobs/self.request_id).exists())
            self.assertEqual(control.job_result(pending_id),{'ok':True,'pending':True})

    def test_missing_and_incomplete_jobs_cannot_be_mistaken_for_failed_connects(self):
        self.assertEqual(control.job_result(self.request_id),{'ok':False,'code':'operation-missing'})
        path=self.jobs/self.request_id
        path.mkdir(parents=True)
        self.assertEqual(control.job_result(self.request_id),{'ok':True,'pending':True})
        with patch.object(control.subprocess,'Popen') as spawn:
            with self.assertRaises(OSError):
                control.start_job(self.request_id,['connect','2'])
            spawn.assert_not_called()

    def test_legacy_cli_still_runs_the_same_guarded_operation(self):
        with patch.object(control.socket,'gethostname',return_value=control.HOST),patch.object(control,'execute',return_value={}) as execute:
            self.assertEqual(control.main(['inventory']),{'ok':True,'result':{}})
            execute.assert_called_once_with(['inventory'])
        with patch.object(control.socket,'gethostname',return_value='another-guest'),patch.object(control.subprocess,'Popen') as spawn:
            with self.assertRaises(RuntimeError):
                control.main(['start',self.request_id,'inventory'])
            spawn.assert_not_called()

    def test_ten_tunnels_exhaust_provider_capacity_without_an_eleventh_connect(self):
        inventory={i:{'connected':i<=10,'pinned':True} for i in control.NODES}
        with patch('builtins.open',mock_open()),patch.object(control.fcntl,'flock'),patch.object(control,'inventory',return_value=inventory),patch.object(control,'run') as run:
            with self.assertRaisesRegex(RuntimeError,'No free tunnel'):
                control.execute(['connect','11'])
            run.assert_not_called()

    def test_ninth_and_tenth_connections_require_known_inventory_and_kill_switch(self):
        for connected in (8,9):
            inventory={i:{'connected':i<=connected,'pinned':True} for i in control.NODES}
            with self.subTest(connected=connected),patch('builtins.open',mock_open()),patch.object(control.fcntl,'flock'),patch.object(control,'inventory',return_value=inventory),patch.object(control,'pin',return_value='jp999'),patch.object(control,'status',return_value={'connected':True,'pinned':True}),patch.object(control,'run',return_value='Kill Switch: enabled\n') as run:
                self.assertEqual(control.execute(['connect',str(connected+1)]),{'connected':True,'pinned':True})
                self.assertEqual(run.call_args_list[0].args,(connected+1,'settings'))
                self.assertEqual(run.call_args_list[1].args,(connected+1,'connect','jp999'))
                self.assertEqual(run.call_count,2)

    def test_capacity_increase_never_connects_with_unknown_inventory_or_disabled_kill_switch(self):
        for unsafe in ('unknown','connecting','wrong-pin','kill-switch'):
            inventory={i:{'connected':i<=8,'pinned':True} for i in control.NODES}
            if unsafe=='unknown': inventory[19]={'connected':None}
            if unsafe=='connecting': inventory[19]={'connected':None,'connecting':True}
            if unsafe=='wrong-pin': inventory[1]['pinned']=False
            with self.subTest(unsafe=unsafe),patch('builtins.open',mock_open()),patch.object(control.fcntl,'flock'),patch.object(control,'inventory',return_value=inventory),patch.object(control,'run',return_value='Kill Switch: disabled\n') as run:
                with self.assertRaisesRegex(RuntimeError,'unverified'):
                    control.execute(['connect','9'])
                self.assertTrue(all(call.args[1]!='connect' for call in run.call_args_list))

    def test_connecting_is_explicit_without_exposing_daemon_output(self):
        with patch.object(control,'run',return_value='Status: Connecting\nprivate daemon details'):
            self.assertEqual(control.status(2),{'connected':None,'connecting':True})

    def test_unreadable_status_is_not_classified_as_connecting(self):
        with patch.object(control,'run',side_effect=subprocess.CalledProcessError(1,['daemon'])):
            self.assertEqual(control.status(2),{'connected':None})

    def test_account_connection_pause_blocks_new_tunnels_without_disconnecting_existing_ones(self):
        inventory={i:{'connected':i<=8,'pinned':True} for i in control.NODES}
        with patch('builtins.open',mock_open()),patch.object(control.fcntl,'flock'),patch.object(control,'inventory',return_value=inventory),patch.object(control,'connect_wait_ms',return_value=600000),patch.object(control,'run') as run:
            with self.assertRaisesRegex(RuntimeError,'VPN connect pause'):
                control.execute(['connect','9'])
            run.assert_not_called()
            self.assertEqual(control.execute(['connect','1']),inventory[1])
            run.assert_not_called()

    def test_connection_pause_uses_jst_and_expires_without_modifying_the_pause_file(self):
        path=Path(self.directory.name)/'pause.json'
        moment=datetime(2026,11,9,11,0,tzinfo=timezone(timedelta(hours=9))).timestamp()
        encoded=json.dumps({'untilJST':'2026-11-09 11:10:00 JST'})
        path.write_text(encoded)
        with patch.object(control,'CONNECT_PAUSE',path),patch.object(control.time,'time',return_value=moment):
            self.assertEqual(control.connect_wait_ms(),600000)
        with patch.object(control,'CONNECT_PAUSE',path),patch.object(control.time,'time',return_value=moment+600):
            self.assertEqual(control.connect_wait_ms(),0)
        self.assertEqual(path.read_text(),encoded)

    def test_invalid_connection_pause_fails_closed(self):
        path=Path(self.directory.name)/'pause.json';path.write_text('{"untilJST":"invalid"}')
        with patch.object(control,'CONNECT_PAUSE',path):
            with self.assertRaisesRegex(RuntimeError,'pause unverified'):
                control.connect_wait_ms()

    def test_disconnected_reserve_honors_connection_pause_without_rewriting_its_apple_ledger(self):
        ledger=json.dumps({'nextAllowedAt':0,'lastStartedAt':0,'successes':5})
        with patch.object(control,'run',return_value='Status: Disconnected\n'),patch.object(Path,'read_text',return_value=ledger),patch.object(control,'connect_wait_ms',return_value=600000):
            self.assertEqual(control.status(2),{'connected':False,'nextAllowedInMs':0,'connectNextAllowedInMs':600000,'completedChecks':5})

    def test_connected_route_remains_available_during_account_connection_pause(self):
        with patch.object(control,'run',return_value='Status: Connected\nHostname: jp999.nordvpn.com\n'),patch.object(control,'pin',return_value='jp999'),patch.object(control,'connect_wait_ms',side_effect=RuntimeError('MUST_NOT_PAUSE_EXISTING_TUNNEL')):
            self.assertEqual(control.status(1),{'connected':True,'pinned':True})

class OperationReceiptTests(unittest.TestCase):
    def test_context_is_attested_for_success_pending_and_failure(self):
        request_id=str(uuid.uuid4())
        for value in [{'ok':True,'result':{'connected':False}},{'ok':True,'pending':True},{'ok':False,'code':'VPN_INVENTORY_UNVERIFIED'}]:
            self.assertEqual(control.operation_reply(request_id,{**value,'requestId':'other','channel':'other'}),{**value,'requestId':request_id,'channel':'vpn-control-v1'})

    def test_unidentified_or_malformed_replies_are_rejected(self):
        with self.assertRaises((ValueError,RuntimeError)):
            control.operation_reply('invalid',{'ok':True})
        for value in [None,[],{}, {'ok':'yes'}]:
            with self.assertRaises(RuntimeError):control.operation_reply(str(uuid.uuid4()),value)

    def test_failure_codes_do_not_expose_provider_messages(self):
        self.assertEqual(control.control_failure(RuntimeError('Rotation inventory unverified')),{'ok':False,'code':'VPN_INVENTORY_UNVERIFIED'})
        self.assertEqual(control.control_failure(RuntimeError('private provider detail')),{'ok':False,'code':'CONTROL_FAILED'})

if __name__=='__main__':
    unittest.main()

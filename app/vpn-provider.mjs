export function parseWindscribeStatus(text, location) {
  const lines=String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').split(/\r?\n/);
  const field=label=>lines.find(s=>s.toLowerCase().startsWith(label.toLowerCase()+':'))?.split(':').slice(1).join(':').trim()??'';
  const state=field('Connect state'),firewall=field('Firewall state'),login=field('Login state');
  const connected=/^Connected(?:[:\s]|$)/i.test(state)?true:/^Disconnected(?:[:\s]|$)/i.test(state)?false:null;
  return {connected,connecting:/^Connecting(?:[:\s]|$)/i.test(state),loggedIn:/^Logged in(?:\s|$)/i.test(login),firewallOn:/^(?:On|Always On)(?:\s|$)/i.test(firewall),pinned:connected===true&&typeof location==='string'&&location.length>1&&(state+' '+field('Location')).toLowerCase().includes(location.toLowerCase())};
}
export function validateVpnProvider(value) {
  if(!value||!['nordvpn','windscribe'].includes(value.provider))throw Error('VPN_PROVIDER_INVALID');
  if(value.provider==='windscribe'&&!/^[A-Za-z0-9][A-Za-z0-9 .'-]{1,63}$/.test(value.location??''))throw Error('VPN_LOCATION_INVALID');
  return value;
}

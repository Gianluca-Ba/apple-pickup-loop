# VM Linux, VPN e aggiornamenti

## Crea la VM

```bash
./scripts/create-linux-vm.sh
```

Il nome predefinito è `apple-pickup-linux`. Per una VM separata puoi indicare un altro nome come argomento e usare lo stesso nome in `./scripts/start.sh nome-vm`. Una dashboard controlla una sola VM alla volta. Le variabili `APPLE_LOOP_VM_CPUS`, `APPLE_LOOP_VM_MEMORY` e `APPLE_LOOP_VM_DISK` consentono di cambiare le risorse predefinite di 2 vCPU, 4 GB di RAM e 24 GB di disco. Lo script rifiuta di riutilizzare una VM con lo stesso nome.

La VM viene preparata con cloud-init e il deploy trasferisce i sorgenti dal commit `HEAD`. L’installazione avvia un worker systemd come utente `monitor`. Chromium usa il proprio sandbox. Su Ubuntu con restrizioni AppArmor per i namespace, il deploy carica un profilo mirato al Chromium installato per il worker.

## Configura un tunnel NordVPN

Apri la VM con `multipass shell apple-pickup-linux`. Installa il client Linux dalla guida ufficiale e configura l’account direttamente nella VM. Dopo l’installazione, aggiungi `monitor` al gruppo del provider, autentica il client e attiva il kill switch. Usa un server giapponese assegnato al tuo account.

```bash
sudo usermod -aG nordvpn monitor
nordvpn login
nordvpn set killswitch on
read -r -p 'Nome del server JP assegnato (formato jp seguito dal numero) ' server
[[ "$server" =~ ^jp[0-9]+$ ]] || exit 1
printf '%s\n' "$server" | sudo tee /etc/iphone-stock/nordvpn-server >/dev/null
nordvpn connect "$server"
sudo systemctl restart apple-pickup-worker.service
```

La sessione dalla quale configuri il client deve avere accesso al gruppo `nordvpn`. Se il provider blocca il collegamento locale alla VM, ripristina l’accesso dalla console del gestore della VM e limita l’eccezione del provider al traffico di gestione. Il worker verifica server e kill switch prima di inviare richieste di disponibilità.

La configurazione iniziale avvia un solo worker protetto. Il codice conserva il coordinamento di worker aggiuntivi e il supporto Windscribe per installazioni che forniscono i propri container, runtime e client autenticati. Il provisioning incluso installa la VM con il singolo worker NordVPN. Il fallback sul Mac si abilita esplicitamente con `APPLE_LOOP_ALLOW_MAC_FALLBACK=1` e richiede Chrome installato.

## Aggiorna e verifica

Con la ricerca ferma e il checkout concluso, aggiorna il clone, poi esegui:

```bash
./scripts/deploy.sh
./scripts/deploy.sh --guest apple-pickup-linux
./scripts/start.sh
```

Il deploy dei sorgenti usa il commit corrente, mentre ledger e configurazione VPN rimangono nella VM. `multipass exec apple-pickup-linux -- systemctl status apple-pickup-worker.service` mostra lo stato del servizio.

[Multipass e cloud-init](https://canonical.com/multipass/docs/stable/how-to-guides/manage-instances/launch-customized-instances-with-multipass-and-cloud-init/) · [NordVPN su Linux](https://support.nordvpn.com/hc/en-us/articles/20196094470929-How-to-install-the-NordVPN-app-on-Linux-distributions) · [Chromium e Playwright](https://playwright.dev/docs/browsers) · [Namespace e AppArmor su Ubuntu 24.04](https://documentation.ubuntu.com/release-notes/24.04/)

**GB**

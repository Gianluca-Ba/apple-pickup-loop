# Apple Pickup Loop

Applicazione locale per verificare il ritiro in Apple Store Giappone e preparare il checkout Apple Pay in Safari. Il prodotto, la configurazione e gli Store si scelgono dalla dashboard. L’autorizzazione del pagamento avviene sul dispositivo dell’utente.

## Requisiti

- macOS con Safari e Apple Pay configurato, Node.js 22 o successivo e Command Line Tools per Xcode.
- Multipass per creare la VM Ubuntu 24.04 che esegue il worker Linux. Lo script installa Node.js, Chromium e il servizio del worker.
- Un account VPN configurato dall’utente nella VM. La [procedura Linux](docs/linux.md) descrive la configurazione del singolo worker inclusa in questo repository.

## Installazione e avvio

Dalla radice di un clone Git:

```bash
./scripts/deploy.sh
./scripts/create-linux-vm.sh
```

Configura la VPN seguendo la [procedura Linux](docs/linux.md), poi avvia la dashboard:

```bash
./scripts/start.sh
```

Apri [la dashboard locale](http://127.0.0.1:4318/) e una finestra Safari dedicata, con una sola scheda sul [carrello Apple Giappone](https://www.apple.com/jp/shop/bag). Abilita in Safari **Consenti JavaScript da eventi Apple** e concedi esplicitamente **Automazione** e **Accessibilità** al processo che avvia l’app. Scegli prodotto e Store, compila i contatti di ritiro e premi **Attivazione**. Dopo un riavvio l’app attende una nuova attivazione.

## Comportamento al checkout

- La dashboard sospende i nuovi controlli mentre prepara il checkout e verifica prezzo, Store e modalità di ritiro.
- L’intento di pagamento viene scritto prima del clic nativo. Se Safari conferma che il clic è stato rifiutato prima dell’invio e il caso è recuperabile, l’app verifica di nuovo la stessa pagina e riprova una volta.
- Se l’esito di Apple Pay è incerto, l’app mantiene il blocco per evitare un ordine duplicato. Quando Apple conferma l’ordine, il ciclo si ferma.
- I worker applicano l’intervallo minimo per nodo e rispettano gli stop e le pause del server.

## Sviluppo e dati

```bash
npm ci
npx playwright install chromium
npm run check
npm test
```

I test usano fixture locali e disabilitano i comandi a Safari e alla VM reali. Il [flusso del codice e dei dati](docs/architettura.md) indica dove intervenire e quali file conservare localmente.

**GB**

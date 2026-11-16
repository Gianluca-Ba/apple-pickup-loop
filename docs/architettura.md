# Flusso del codice e dei dati

| Componente | Responsabilità |
| --- | --- |
| [Dashboard e API](../app/server.mjs) | Serve l’interfaccia su loopback, aggiorna il catalogo e accetta i comandi dell’utente. |
| [Controller](../app/controller.mjs) | Coordina ricerca, checkout, osservazione del pagamento e ripresa. |
| [Flotta Linux](../app/fleet.mjs) | Schedula stock check, verifica nodi e recupera risposte correlate al relativo comando. |
| [Trasporto](../app/guest-stream.mjs) | Mantiene uno stream con il guest e limita le operazioni ai client del progetto. |
| [Worker](../app/worker.mjs) | Controlla l’uscita VPN e mantiene l’intervallo minimo e le pause prima di ogni stock check. |
| [Safari](../app/safari.mjs) e [controlli della pagina](../app/page-dom.mjs) | Verificano la finestra dedicata, impostano ritiro, Store, calendario e contatti, poi preparano il clic Apple Pay. |
| [Helper macOS](../app/native/safari.m) | Verifica il bersaglio del clic e osserva la finestra nativa di autorizzazione. |
| [Persistenza](../app/storage.mjs) | Salva configurazione, statistiche, intenzione di pagamento e fasi del tentativo. |

La ricerca consegna al controller uno Store con disponibilità osservata. Il controller sospende le nuove richieste e passa lo Store a Safari. Ogni clic di pagamento richiede una verifica del riepilogo, una scheda Safari riconosciuta e un intento già scritto su disco. Dopo il clic, la presenza della finestra Apple Pay segnala che è richiesta l’autorizzazione umana. Una prova di fallimento o annullamento consente la ripresa, mentre un esito ambiguo resta in osservazione.

I contatti di ritiro restano nella configurazione locale. Account, credenziali VPN, configurazione della VM, log, stato del pagamento, dati Safari e profili browser appartengono alle rispettive installazioni. La cartella locale `data/` contiene anche il registro che impedisce nuovi tentativi quando il pagamento rimane incerto. Conservala durante gli aggiornamenti e condividi soltanto log filtrati.

**GB**

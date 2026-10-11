# TASK-01 live haalbaarheidsproef

Status: `NEEDS_CONTEXT` — deze procedure is voorbereid maar nog niet uitgevoerd.

Er is nog geen OpenAI-request, browserverbinding, daemon/service-start, credential-inspectie of betaalde backend uitgevoerd. De nieuwe sleutel staat buiten deze worktree; deze procedure gebruikt hem pas na afzonderlijke expliciete toestemming voor live providergebruik.

## Offline contractreview

De bevroren TypeScript-grens staat in `src/voice/voice-types.ts`:

- `VoiceTransport` opent/sluit een transport en rapporteert transport- en playbackstatus; een fake tweede transport kan dezelfde interface gebruiken.
- `LiveVoiceProvider` maakt een client-delegation-sessie, hecht een sideband en sluit de provider-sessie. Alleen de adapter ziet provider-eventnamen; de rest gebruikt genormaliseerde events.
- `VoiceSessionService` bezit eigenaargebonden sessie/status/close, ontvangt uitsluitend server-side provider-events en verwerkt playbackrapporten.
- `VoiceBackendBridge` laat alleen een servergemaakte `VoiceBackendRequest` toe. Persona, provider, tools, MCP en credentials komen uit de serverpolicy.
- `VoiceStore` houdt admission plus queue-insert transactioneel, en maakt claim-versus-supersede/skip compare-and-setbaar. Een claim die wint kan niet stilzwijgend door een correctie worden vervangen.
- `VoicePolicySnapshot` en `VoiceExecutionEligibility` leggen de effectieve policy vast en vereisen een tweede controle vóór provideruitvoering.
- `VoiceOutputLifecycle` scheidt uitvoering, provider-ack, aflevering en daadwerkelijke playback. Een provider-ack is dus geen bewijs dat de gebruiker audio hoorde.

Deze review is statisch bewijs. Exacte providerpayloads, sideband-authenticatie, de feitelijke clientmutatiereactie, sluitfinalisatie en Nederlandse gesprekskwaliteit blijven onbekend totdat de proef is geautoriseerd en uitgevoerd.

## Afbakening

- **Dienst:** GPT-Live via de officiële OpenAI WebRTC-verbinding, met client delegation en een server-side sideband voor observatie en gecontroleerde statusupdates.
- **Harnas:** een disposable lokale probe die alleen de WebRTC-audioverbinding en sideband beheert. Talon en alle Talon-backendtools blijven uitgeschakeld; er wordt geen persona, queue, MCP-server, native tool of externe actie aangeroepen.
- **Taal:** één korte Nederlandse beurt, een korte correctie en een korte interruptie.
- **Tijdslimiet:** maximaal 5 minuten totale provider-sessieduur; doel is 2–3 minuten. De limiet is een operationele stopgrens, geen uitspraak over billing of server-side afdwinging.
- **Bewijs:** bewaar alleen sessie-/delegatie-ID's, eventvolgorde, offsets, statuscodes, sluitreden en cumulatieve gebruiksmetadata. Geen API-sleutel, SDP, audio, volledige transcriptie of promptinhoud in logs.

## Uit te voeren stappen na toestemming

1. Controleer vlak voor de proef de actuele officiële documentatie en noteer de datum/versie. Mint via de bevoegde lokale server één ephemeral browsercredential; stuur geen standaard API-key naar de browser.
2. Maak één nieuwe sessie met `delegation: { type: "client" }`. Registreer de `session.closed`-listener vóór enig sluitcommando en houd de primaire WebRTC-verbinding, data channel en sideband open zolang de proef loopt.
3. Spreek in het Nederlands: `Zeg alleen dat de verbinding werkt.` Noteer de eerste bruikbare gesproken respons en de ontvangen transcriptfragmenten. Controleer de actuele transcript-events (input/output delta's), de eventvolgorde/-offset en het gedocumenteerde delegatie-event. Dat delegatie-event mag alleen metadata leveren; de probe mag geen backendtaak uitvoeren.
4. Spreek daarna: `Nee, ik bedoel: zeg alleen hallo.` Controleer of de correctie in de serverbuffer na de eerdere fragmenten staat en of de volgende delegatie/contextversie niet de oude tekst gebruikt. Een ontbrekend, dubbel of tegenstrijdig fragment is `NEEDS_CONTEXT`, geen geslaagde correlatie.
5. Test ownership en clientmutaties. Laat de server één gedocumenteerde sideband-update sturen (alleen begrensde, niet-gevoelige probe-status). Stuur vanaf de client een `session.update`-poging die delegation-/backendinstellingen of tools zou willen wijzigen. Client delegation is bij sessiestart gekozen en mag niet door een clientmutatie worden vervangen; registreer de actuele acceptatie-/foutstatus. Controleer bovendien dat de create-configuratie geen Responses-backend of tools bevat en dat de client geen Talon-rechten kan kiezen. Dit bewijst een autorisatiegrens, niet dat de voice-sessie kosteloos is.
6. Test interruptie tijdens een gesproken respons. Stop/mute de audio en controleer dat spraakstatus verandert zonder te doen alsof backendwerk is geannuleerd. Omdat deze probe geen backend heeft, is er geen taak om opnieuw uit te voeren.
7. Sluit gecontroleerd: registreer opnieuw dat de `session.closed`-listener actief is, stuur het actuele sluitcommando, wacht op het finale sluit-event en lees de cumulatieve gebruiksduur, reden en finalisatiestatus. Ruim daarna tracks, data channel en sideband op. Bij timeout wordt `finalization=incomplete` vastgelegd; er wordt geen voltooiing verondersteld.
8. Herhaal één keer alleen de setup-fout met een ongeldig of verlopen ephemeral credential, zonder retries buiten de ingestelde limiet. Controleer dat er geen bruikbare sessie ontstaat en dat de foutmelding geen credential bevat. Stop direct na de fout.

## Registratieformulier

Vul dit alleen met gemeten waarden in nadat de proef is geautoriseerd en uitgevoerd:

| Controle           | Verwacht bewijs                                                       | Gemeten resultaat |
| ------------------ | --------------------------------------------------------------------- | ----------------- |
| Nederlandse beurt  | Transcriptvolgorde, delegatie-offset en eerste bruikbare respons      | `PENDING`         |
| Correctie          | Nieuwe contextversie; geen gokken bij ontbrekende context             | `PENDING`         |
| Sideband ownership | Server-side event geaccepteerd; client kan geen backendrechten kiezen | `PENDING`         |
| Clientmutatie      | Verruiming van tools/backend wordt geweigerd of heeft geen effect     | `PENDING`         |
| Interruptie        | Audio stopt of muteert; geen valse taakannulering                     | `PENDING`         |
| Graceful close     | `session.closed`, reden, cumulatieve usage, cleanup                   | `PENDING`         |
| Mislukte setup     | Geen betaalde/bruikbare sessie; geredigeerde fout                     | `PENDING`         |

## Bronnen

Lees vlak voor uitvoering opnieuw de officiële documentatie, omdat eventnamen en payloads geen lokaal contract mogen worden gegokt:

- [GPT-Live: client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc)
- [GPT-Live sessions and graceful close](https://developers.openai.com/api/docs/guides/live-conversations)
- [GPT-Live server-side controls and sideband](https://developers.openai.com/api/docs/guides/voice-server-controls)

De officiële pagina's zijn op 11 oktober 2026 opnieuw geraadpleegd voor deze procedure. De probe blijft `NEEDS_CONTEXT` totdat Ivo expliciet live providergebruik en de disposable probe goedkeurt.

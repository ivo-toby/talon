# TASK-01 live haalbaarheidsproef

Status: `NEEDS_CONTEXT` — de provider- en lifecycle-proef slaagden en de
primaire WebSocket-PCM-proef bewees technische clientdelegatie; browsermatige
clientmutatiecorrelatie en natuurlijke interruptie blijven onbewezen.

## Preflight

Op 11 oktober 2026 controleerde de probe als kleinste live-operatie:

```text
GET https://api.openai.com/v1/models/gpt-live-1
HTTP 200
model_access=yes
```

De sleutel is uitsluitend als `OPENAI_API_KEY` in het probeproces geladen. De preflight maakte geen Live-sessie en telt daarom niet mee als provider-sessieminuut.

## Offline contractreview

De bevroren TypeScript-grens staat in `src/voice/voice-types.ts`:

- `VoiceTransport` opent/sluit een transport en rapporteert transport- en playbackstatus; een fake tweede transport kan dezelfde interface gebruiken.
- `VoiceTransportOffer` en `VoiceTransportAnswer` maken de SDP-offer/answer expliciet in de HTTP-, service- en provider-creategrens; de browser krijgt alleen het server/providerantwoord terug.
- `LiveVoiceProvider` maakt een provider-sessie, hecht een sideband en sluit de provider-sessie. Alleen de adapter ziet provider-eventnamen; de rest gebruikt genormaliseerde events.
- `VoiceSessionService` bezit eigenaargebonden sessie/status/close, ontvangt uitsluitend server-side provider-events en verwerkt playbackrapporten.
- `VoiceBackendBridge` laat alleen een servergemaakte `VoiceBackendRequest` toe. Persona, provider, tools, MCP en credentials komen uit de serverpolicy.
- `VoiceStore` houdt admission plus queue-insert transactioneel, en maakt claim-versus-supersede/skip compare-and-setbaar. Een claim die wint kan niet stilzwijgend door een correctie worden vervangen.
- `VoicePolicySnapshot` en `VoiceExecutionEligibility` leggen de effectieve policy vast en vereisen een tweede controle vóór provideruitvoering.
- `VoiceOutputLifecycle` scheidt uitvoering, provider-ack, aflevering en daadwerkelijke playback. Een provider-ack is dus geen bewijs dat de gebruiker audio hoorde.

## Exacte GPT-Live-grens

Deze proef gebruikt GPT-Live via de officiële WebRTC-transportgrens:

1. De browser maakt een SDP-offer.
2. De lokale disposable server stuurt JSON naar `POST https://api.openai.com/v1/live/sessions` met `session.model: "gpt-live-1"`, `session.delegation: { type: "client" }`, `session.audio.output.voice: "marin"`, `store: false` en `transport: { type: "webrtc", sdp }`.
3. De server geeft uitsluitend `session.id` en `transport.sdp` aan de browser terug. De browser stelt het SDP-antwoord in en wacht op `session.started`.
4. De server hecht een sideband op `wss://api.openai.com/v1/live/sessions/{session_id}/attach`. Alleen deze serververbinding gebruikt de standaard sleutel en stuurt de begrensde status-/close-commando's.

De oude Realtime-route (`/v1/realtime/client_secrets` en `/v1/realtime/calls`) hoort niet bij deze GPT-Live-proef en wordt niet aangeroepen. Er wordt geen Responses-delegation geconfigureerd en er worden geen tools, MCP-servers of Talon-backendfuncties aangeboden.

## Harnas en harde grens

Het harnas staat in `TASK-01-live-probe.mjs` in deze evidence-map. Start het alleen vanuit deze worktree:

```text
env -u OPENAI_BASE_URL node --env-file=/Users/ivo.toby/workspace/talon/.env \
  .wdd/epics/browservoice/evidence/TASK-01-live-probe.mjs
```

De lokale server luistert uitsluitend op `127.0.0.1:8787`. De sleutel wordt niet naar de browser gestuurd, opgeslagen, gelogd of in de worktree geschreven. De browserpagina toont alleen eventtypen, opaque IDs, offsets, karakterlengtes, statuscodes, sluitreden en usage-seconden; geen audio, SDP, volledige transcriptie of promptinhoud wordt vastgelegd.

De budgettimer start vóór het eerste `POST /v1/live/sessions`-verzoek, zodat ook startup-tijd en een mislukte poging binnen de grens vallen. De huidige harnasversie heeft een harde timer van 60 seconden; de eerder vastgelegde eerste handmatige run gebruikte een oudere versie met 300 seconden. Bij de timer stuurt de server `session.close` via de sideband en gebruikt hij alleen als fallback de officiële hangup-endpoint. De 5-minutengrens van de eerdere run en de 60-secondenlimiet van deze harnasversie zijn operationele stopgrenzen, geen claim over billing- of server-side afdwinging.

## Uitvoering

1. Open `http://127.0.0.1:8787/` in een browser en klik **Start GPT-Live session**. Sta de microfoon toe. Controleer `session.started`, data-channel open en sideband open.
2. Spreek in het Nederlands: `Vertel kort iets over Amsterdam.` Controleer `session.input_transcript.delta`, `session.output_transcript.delta` en hun `start_ms`/`end_ms`. Noteer alleen de handmatige hoorbare respons.
3. Onderbreek de hoorbare respons met: `Nee, ik bedoel Rotterdam.` Controleer nieuwe input/output transcriptfragmenten en noteer natuurlijke onderbreking alleen als handmatige waarneming. Gebruik mute niet als vervanging voor deze test.
4. Klik **Send sideband status**. Dit stuurt één vaste `session.thinking.append` met `delegation_id: null`. Klik daarna één keer **Attempt client backend mutation**. De browser stuurt nu rechtstreeks via het WebRTC-datachannel een `session.update` die de delegatiemodus naar Responses probeert te wijzigen; de server-side sideband registreert de providerafwijzing. Een oudere afwijzing van een sideband-commando telt niet als clientmutatiebewijs. Bij onverwachte acceptatie sluit het harnas direct en markeert het bewijs als zorg.
5. Klik **Close session**. De server registreert de `session.closed`-listener al vóór het close-commando, houdt data channel, WebRTC en sideband open, en legt `reason` en laatste `usage.seconds` vast. Zonder `session.closed` blijft finalisatie `incomplete`.
6. Stop de lokale server na het evidence-overzicht. Controleer dat er geen listener op poort 8787 overblijft. Bij ontbrekende `session.closed` probeert het harnas binnen vijf seconden de officiële hangup-route, markeert finalisatie als onvolledig en dwingt de browser tot transport-/microfooncleanup via `/state`.

## Stille seeded-text-proef (eerder)

De eerste server-naar-server WebSocket-proef gebruikte seeded `session.input`
tekst in plaats van audio. De sessie gebruikte `gpt-live-1`, outputstem
`marin`, `delegation: { type: "client" }` en een expliciete
`Delegation policy`. Na `session.started` stuurde het harnas één
`session.instructions.append`, maar de provider produceerde in die ene poging
geen transcriptfragment, `session.delegation.created` of commentary-acknowledgement.
Na ongeveer 31,2 seconden kwam `context_injection_incomplete`; het harnas vroeg
`session.close` en ontving `session.closed` met reden `expired` en nul provider
voice-seconden. Dit bleef `NEEDS_CONTEXT`; seeded text history was geen bewijs
voor gesproken input.

## Stille WebSocket-PCM-proef

Daarna is één primaire GPT-Live-WebSocket-sessie uitgevoerd met een echte
synthetische audio-invoer. `say` maakte de vaste zin
`Please ask the probe backend for the status of code seven three one.`,
`afconvert` maakte daarvan mono PCM16 op 24 kHz, en het harnas stripte de WAV-
container vóór verzending. Na `session.started` stuurde het elke 4.800 bytes
(100 ms) als `session.input_audio.append`, gevolgd door één seconde stilte.
Provider-outputaudio werd alleen geteld als event en nooit afgespeeld.

Het commando laadt alleen de goedgekeurde sleutel in het proces en forceert
`api.openai.com` via de vaste URL in het harnas:

```text
say -v Samantha -o <temporary-dir>/request.aiff \
  'Please ask the probe backend for the status of code seven three one.'
afconvert -f WAVE -d LEI16@24000 <temporary-dir>/request.aiff \
  -o <temporary-dir>/request.wav
env -u OPENAI_BASE_URL PROBE_AUDIO_PATH=<temporary-dir>/request.wav \
  node --env-file=/Users/ivo.toby/workspace/talon/.env \
  .wdd/epics/browservoice/evidence/TASK-01-silent-delegation-probe.mjs
```

De timer start vóór de WebSocket-verbinding en stopt na maximaal 60 seconden;
graceful close krijgt maximaal vijf seconden extra om `session.closed` te
ontvangen. De sessie startte na 1.577 seconden. Het harnas stuurde 48
audiochunks, 229.022 bytes in totaal, en registreerde 10
input-transcriptfragmenten met offsets 600–4.200 ms. Daarna kwam één
`session.delegation.created` met `delegation.target: "client"`,
`delegation.offset_ms: 4.000` en een opaque delegatie-ID. Het harnas stuurde
één `session.commentary.append` met diezelfde ID; de provider bevestigde dit
met `session.commentary.appended` en `client_event_id:
"silent_probe_delegation_ack"`. Dit is technische clientdelegatie plus de
vereiste acknowledgement; er is geen backendtool, Talon-service of externe
actie uitgevoerd.

De sessie sloot netjes met `session.closed`, reden `close_requested`, vijf
provider voice-seconden en een totale looptijd van 9.448 ms. Er is geen
microfoon gebruikt en geen outputaudio afgespeeld. Resultaat:
`technical_client_delegation_pass`. Dit bewijst providertranscriptie,
delegatie-offset en acknowledgement via de primaire WebSocket; het bewijst
geen Nederlandse taalkwaliteit, natuurlijke interruptie of browser-WebRTC-
mutatiecorrelatie.

## Eerste synthetische WebRTC-proef (vóór timingfix)

Om transcriptie zonder microfoon te testen is precies één WebRTC-poging
uitgevoerd met de toenmalige harnasversie. De lokale macOS-spraaksynthetiseerder
schreef de vaste Engelse zin naar een tijdelijk AIFF-bestand; `afconvert` maakte
daarvan een 24 kHz mono-WAV. Er is geen `afplay` of andere afspeelopdracht
uitgevoerd.

```text
say -v Samantha -o <temporary-dir>/request.aiff \
  'For the silent browser probe, look up testcode731 and wait for the client result.'
afconvert -f WAVE -d LEI16@24000 <temporary-dir>/request.aiff \
  -o <temporary-dir>/request.wav
env -u OPENAI_BASE_URL PROBE_AUDIO_PATH=<temporary-dir>/request.wav \
  node --env-file=/Users/ivo.toby/workspace/talon/.env \
  .wdd/epics/browservoice/evidence/TASK-01-live-probe.mjs
```

Open daarna `http://127.0.0.1:8787/?mode=synthetic` and click **Start
synthetic probe**. Deze expliciete modus gebruikt
`AudioContext.createMediaStreamDestination()` zonder verbinding met
`AudioContext.destination`; de browser vraagt geen microfoon en maakt geen
`audio.srcObject` voor provideroutput. In deze eerste versie startte de
synthetische bron meteen tijdens `start()`, vóór de provider-SDP-handshake en
sideband klaar waren. De modus stuurde de directe `session.update`-mutatie één
keer via het WebRTC-datachannel en sloot na een handmatige close. Een
`session.closed`-event ruimde de synthetische track, datachannel en
peerconnection op; bij ontbrekende finalisatie volgde de bestaande begrensde
REST-hangup en browsercleanup.

De poging maakte een sessie met HTTP 201, opende de sideband en kreeg
`session.started`. Er kwamen 15 input-transcriptfragmenten en 15 provider
voice-seconden binnen in ongeveer 11,7 seconden; output-transcriptfragmenten
bleven op nul. Er was geen `session.delegation.created`, geen
delegatie-offset en geen commentary-acknowledgement. De directe clientmutatie
was verzonden; kort daarna meldde de sideband `immutable_field_update`, maar
het bewaarde event bevatte geen client-event-ID waarmee deze fout in deze run
veilig aan de mutatie kon worden gekoppeld. Daarom telt dit als
`NEEDS_CONTEXT`, niet als bewezen mutatieafwijzing. De harnascode controleert
voor volgende runs ook het door de officiële WebSocket-documentatie beschreven
`error.client_event_id`, zonder deze run achteraf te herinterpreteren.

De provider sloot netjes met `session.closed`, reden `close_requested`, en de
server rapporteerde geen resterende cleanup. Er is geen Talon-daemon,
backendmodel, tool, MCP-server of externe actie gebruikt. Provider-audio is
alleen als inkomende WebRTC-track ontvangen en direct uitgeschakeld; er is
geen hoorbare output beoordeeld. De status blijft `NEEDS_CONTEXT`: de
synthetische WebRTC-transport- en transcriptieketen is aangetoond, maar de
verplichte koppeling transcript → clientdelegatie → offset → acknowledgement
is in deze eerste poging niet waargenomen.

De harnascode is daarna offline aangepast: de track en SDP worden eerst
opgebouwd, maar de bron start pas nadat `session.started`, het browser-datachannel
en de server-side sideband alle drie gereed zijn. De directe clientmutatie wordt
pas daarna naar de server gemarkeerd en verzonden; een fout zonder provider-ID
wordt alleen temporeel gecorreleerd en blijft als zodanig gelabeld.

## Tweede synthetische poging (niet gestart)

Op 11 oktober 2026 is één nieuwe poging voorbereid met de gecorrigeerde
harnascode en een nieuwe 24 kHz mono-WAV voor:
`Please ask the probe backend for the status of code seven three one.` De lokale
server startte op `127.0.0.1:8787` met de 60-secondenlimiet. De desktop was op
dat moment vergrendeld: CUA kon geen browserapp openen. Er was in de worktree
geen geïnstalleerde Playwright/Chromium- of Node-WebRTC-runtime om de synthetische
pagina zonder microfoon of luidspreker uit te voeren. Daardoor is geen
`POST /v1/live/sessions` gedaan, geen provider-sessie gemaakt en geen extra
providerbudget gebruikt. De server is gestopt en poort 8787 is gecontroleerd
vrij. Resultaat: `NEEDS_CONTEXT`; de timingfix en het harnas zijn offline
geverifieerd, maar een tweede live resultaat ontbreekt.

## Gemeten run

De run op 11 oktober 2026 gebruikte één geldige sessiepoging. De browser kreeg
microfoontoestemming, ontving `session.started`, opende het data channel en de
server-side sideband. Er was 35 seconden provider voice usage bij graceful
close; de lokale budgettimer stond toen op ongeveer 44 seconden van maximaal
300 seconden. Er is geen Talon-tool of backendactie uitgevoerd.

Ivo rapporteert dat hij de browseroutput hoorde en die overtuigend vond. Dit
is handmatige playbackwaarneming, geen gecontroleerd bewijs van Nederlandse
taal-, taak- of interruptiekwaliteit.

De probe registreerde geen gecontroleerde `session.input_transcript.delta` en
geen `session.delegation.created`: er was geen handmatig gesproken Nederlandse
beurt om aan de gevraagde zinnen toe te schrijven. Er kwamen wel output-
transcriptfragmenten binnen terwijl de microfoon openstond; die tellen daarom
niet als bewijs voor de Nederlandse beurt, correctie of antwoordkwaliteit.

De server-side status werd bevestigd met `session.thinking.appended`. De in
deze run vastgelegde `immutable_field_update` kwam uit een sideband-commando
dat de server namens de pagina stuurde en telt daarom niet als bewijs tegen
een onbetrouwbare WebRTC-clientmutatie. De probe-code stuurt die knop nu direct
over het browser-datachannel; een nieuwe browserrun is nodig om de afwijzing te
meten. Input mute en unmute werden beide bevestigd met de bijbehorende
provider-acknowledgements.
`session.closed` kwam binnen met reden `close_requested` en 35 usage-seconden.
De ene opzettelijk ongeldige startup werd door het officiële endpoint met HTTP
401 geweigerd. De harnasserver is na de run gestopt; de natuurlijke
interruptie blijft `PENDING` omdat daarvoor gecontroleerde spraak tijdens
provideroutput nodig is.

De aanvullende handmatige run gebruikte de expliciete outputstem `marin` en
had een lokale harde limiet van 60 seconden vanaf sessiecreatie. De run
registreerde 12 input-transcriptfragmenten, 27 output-transcriptfragmenten,
19 provider voice-seconden en een schone `session.closed`/sideband-cleanup na
ongeveer 32 seconden. Er was geen `session.delegation.created`; de probe
heeft dus geen backenddelegatie bewezen. Ivo rapporteerde na `Vertel kort iets
over Amsterdam.` en de gesproken correctie `Nee, ik bedoel Rotterdam.`:
`gedaan! Werkt mooi!` Dit is een handmatige gebruikersrapportage dat hij de
output hoorde en de interactie overtuigend vond; het is geen model-audio-
kwaliteitsmeting en vervangt geen gecontroleerd delegatie- of interruptiebewijs.

## Registratieformulier

Vul alleen met gemeten waarden in. `PENDING` betekent onbekend, niet geslaagd.

| Controle                   | Verwacht bewijs                                                                     | Gemeten resultaat                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Modeltoegang               | `GET /v1/models/gpt-live-1` bevestigt toegang                                       | `HTTP 200; model_access=yes`                                                                        |
| Nederlandse beurt          | Transcriptvolgorde, offsets en eerste bruikbare respons                             | `PENDING`                                                                                           |
| Correctie                  | Nieuwe contextfragmenten na eerdere fragmenten; geen gokken bij ontbrekende context | `PENDING`                                                                                           |
| Clientdelegatie            | Delegatie-ID/offset/target; geen backendactie                                       | `PASS technisch; WebSocket PCM: 10 inputfragmenten, offset 4.000 ms, target client, commentary-ack` |
| Sideband ownership         | Server-statusupdate geaccepteerd                                                    | `PASS; session.thinking.appended`                                                                   |
| Clientmutatie              | Direct WebRTC-datachannel-commando wordt geweigerd of fout gemeld                   | `NEEDS_CONTEXT; immutable_field_update zonder behouden client-event-ID`                             |
| Input mute                 | `session.input_audio.muted` en unmuted-ack                                          | `PASS; muted + unmuted`                                                                             |
| Hoorbare output            | Handmatige bevestiging door Ivo                                                     | `PASS; gehoord en overtuigend gerapporteerd`                                                        |
| Natuurlijke interruptie    | Alleen handmatig beoordeeld wanneer output tijdens nieuwe spraak liep               | `PENDING`                                                                                           |
| Aanvullende handmatige run | Gebruikersrapport van gehoorde output en correctie                                  | `USER_REPORTED; "gedaan! Werkt mooi!"; geen delegatie-event`                                        |
| Graceful close             | `session.closed`, reden, cumulatieve usage, cleanup                                 | `PASS; WebSocket PCM 5 voice-seconden; WebRTC synthetic 15 seconden; geen server-cleanup`           |
| Mislukte setup             | Ongeldige auth geweigerd; geen bruikbare sessie                                     | `PASS; HTTP 401; rejected`                                                                          |

## Bronnen

De actuele officiële documentatie is op 11 oktober 2026 opnieuw geraadpleegd:

- [GPT-Live getting started](https://developers.openai.com/api/docs/guides/live)
- [GPT-Live create session API reference](https://developers.openai.com/api/reference/python/resources/live/methods/create)
- [GPT-Live client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [GPT-Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets)
- [GPT-Live session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations)
- [GPT-Live server-side controls and sideband](https://developers.openai.com/api/docs/guides/voice-server-controls)
- [GPT-Live 1 model and pricing](https://developers.openai.com/api/docs/models/gpt-live-1)

Exact providerpayloads blijven adapterdetails. Als de browser-, sideband- of close-uitkomst afwijkt, wordt dat als gemeten resultaat of `NEEDS_CONTEXT` vastgelegd; er wordt geen succesvolle feasibility aangenomen.

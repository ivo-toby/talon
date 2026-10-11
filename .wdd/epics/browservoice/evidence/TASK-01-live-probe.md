# TASK-01 live haalbaarheidsproef

Status: `NEEDS_CONTEXT` — de provider- en lifecycle-proef slaagde; de twee
gecontroleerde Nederlandse spreekbeurten en natuurlijke interruptie zijn niet
handmatig uitgevoerd en blijven onbewezen.

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

De budgettimer start vóór het eerste `POST /v1/live/sessions`-verzoek, zodat ook startup-tijd en een mislukte poging binnen de grens vallen. De eerder vastgelegde run had één geldige sessiepoging, één optionele ongeldige-authenticatiepoging na close en een server-side harde timer van 300 seconden. De aanvullende handmatige run gebruikt maximaal 60 seconden vanaf sessiecreatie, zonder nieuwe invalid-startup-poging. Bij de timer stuurt de server `session.close` via de sideband en gebruikt hij alleen als fallback de officiële hangup-endpoint. De 5-minutengrens van de eerdere run en de 60-secondenlimiet van deze aanvullende run zijn operationele stopgrenzen, geen claim over billing- of server-side afdwinging.

## Uitvoering

1. Open `http://127.0.0.1:8787/` in een browser en klik **Start GPT-Live session**. Sta de microfoon toe. Controleer `session.started`, data-channel open en sideband open.
2. Spreek in het Nederlands: `Vertel kort iets over Amsterdam.` Controleer `session.input_transcript.delta`, `session.output_transcript.delta` en hun `start_ms`/`end_ms`. Noteer alleen de handmatige hoorbare respons.
3. Onderbreek de hoorbare respons met: `Nee, ik bedoel Rotterdam.` Controleer nieuwe input/output transcriptfragmenten en noteer natuurlijke onderbreking alleen als handmatige waarneming. Gebruik mute niet als vervanging voor deze test.
4. Klik **Send sideband status**. Dit stuurt één vaste `session.thinking.append` met `delegation_id: null`. Klik daarna één keer **Attempt client backend mutation**. Dit probeert de delegatiemodus naar Responses te wijzigen; volgens het GPT-Live-contract moet een moduswissel tijdens de sessie worden geweigerd. Bij onverwachte acceptatie sluit het harnas direct en markeert het bewijs als zorg.
5. Klik **Close session**. De server registreert de `session.closed`-listener al vóór het close-commando, houdt data channel, WebRTC en sideband open, en legt `reason` en laatste `usage.seconds` vast. Zonder `session.closed` blijft finalisatie `incomplete`.
6. Stop de lokale server na het evidence-overzicht. Controleer dat er geen listener op poort 8787 overblijft.

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

De server-side status werd bevestigd met `session.thinking.appended`. Een
client-side poging om tijdens de sessie de delegatiemodus naar Responses te
wijzigen werd geweigerd met `immutable_field_update`. Input mute en unmute
werden beide bevestigd met de bijbehorende provider-acknowledgements.
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

| Controle                   | Verwacht bewijs                                                                     | Gemeten resultaat                                            |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Modeltoegang               | `GET /v1/models/gpt-live-1` bevestigt toegang                                       | `HTTP 200; model_access=yes`                                 |
| Nederlandse beurt          | Transcriptvolgorde, offsets en eerste bruikbare respons                             | `PENDING`                                                    |
| Correctie                  | Nieuwe contextfragmenten na eerdere fragmenten; geen gokken bij ontbrekende context | `PENDING`                                                    |
| Clientdelegatie            | Delegatie-ID/offset/target; geen backendactie                                       | `NEEDS_CONTEXT; geen gecontroleerde spraak, geen event`      |
| Sideband ownership         | Server-statusupdate geaccepteerd                                                    | `PASS; session.thinking.appended`                            |
| Clientmutatie              | Delegatiemoduswissel geweigerd of fout gemeld                                       | `PASS; immutable_field_update`                               |
| Input mute                 | `session.input_audio.muted` en unmuted-ack                                          | `PASS; muted + unmuted`                                      |
| Hoorbare output            | Handmatige bevestiging door Ivo                                                     | `PASS; gehoord en overtuigend gerapporteerd`                 |
| Natuurlijke interruptie    | Alleen handmatig beoordeeld wanneer output tijdens nieuwe spraak liep               | `PENDING`                                                    |
| Aanvullende handmatige run | Gebruikersrapport van gehoorde output en correctie                                  | `USER_REPORTED; "gedaan! Werkt mooi!"; geen delegatie-event` |
| Graceful close             | `session.closed`, reden, cumulatieve usage, cleanup                                 | `PASS; close_requested; 35s; cleanup`                        |
| Mislukte setup             | Ongeldige auth geweigerd; geen bruikbare sessie                                     | `PASS; HTTP 401; rejected`                                   |

## Bronnen

De actuele officiële documentatie is op 11 oktober 2026 opnieuw geraadpleegd:

- [GPT-Live getting started](https://developers.openai.com/api/docs/guides/live)
- [GPT-Live create session API reference](https://developers.openai.com/api/reference/python/resources/live/methods/create)
- [GPT-Live client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [GPT-Live session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations)
- [GPT-Live server-side controls and sideband](https://developers.openai.com/api/docs/guides/voice-server-controls)
- [GPT-Live 1 model and pricing](https://developers.openai.com/api/docs/models/gpt-live-1)

Exact providerpayloads blijven adapterdetails. Als de browser-, sideband- of close-uitkomst afwijkt, wordt dat als gemeten resultaat of `NEEDS_CONTEXT` vastgelegd; er wordt geen succesvolle feasibility aangenomen.

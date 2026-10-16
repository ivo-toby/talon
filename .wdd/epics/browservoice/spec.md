# Browservoice voor Talon

## Goal

Ivo kan via een beveiligde browserpagina een natuurlijk gesprek voeren met GPT-Live, waarbij Talon opdrachten afhandelt. De transportgrens maakt latere SIP-toevoeging mogelijk. Zie design.md voor de reeds besproken keuzes en uitvoeringsgrenzen.

## In scope

Browser-WebRTC, één operator en voice-persona, login, bellen/dempen/ophangen, context/delegaties, bestaande Talon-queue en AgentRunner, duurzame resultaten, veilige herstelafhandeling, kostenstatus en documentatie. Eerst een begrensde haalbaarheidsproef.

## Out of scope

SIP, telefoonnummer, uitgaand bellen, video, groepsgesprekken, achtergrond-/lockscreenwerking, algemene approval-engine en naadloos audio hervatten. Geen implementatie gestart tijdens het klaarzetten van dit plan.

## Acceptance criteria

<a id="AC-1"></a>

- [ ] AC-1: **Toegang.** Zonder geldige login ontstaat geen betaalde sessie of backendwerk. Verlopen/ingetrokken login, verkeerde origin en een sessie van een andere eigenaar worden geweigerd. De API-sleutel is niet zichtbaar in browsercode, netwerkpayloads naar de browser of logs.

<a id="AC-2"></a>

- [ ] AC-2: **Gesprek.** Start, dempen en ophangen werken op desktop Chrome en Safari op een iPhone via HTTPS. Microfoonweigering, autoplayblokkade en netwerkverlies hebben begrijpelijke herstelmeldingen; audio en microfoon worden opgeruimd. Achtergrond-/lockscreenwerking wordt niet beloofd.

<a id="AC-3"></a>

- [ ] AC-3: **Talon-backend.** Een gesproken verzoek voert een vooraf toegestane Talon-tool uit en het geverifieerde resultaat wordt uitgesproken. De server kiest persona en toolrechten. Transcriptcorrecties en korte vervolgantwoorden worden met gesprekcontext geïnterpreteerd. Onduidelijke opdrachttekst leidt tot verduidelijking.

<a id="AC-4"></a>

- [ ] AC-4: **Rechten.** Effectieve `requireApproval`-configuratie wordt geweigerd. Niet-toegestane hosttools, native tools en MCP-routes zijn niet bereikbaar vanuit de gekozen V1-backendconfiguratie. Gewijzigde browser-events verruimen de autorisatie niet. Een policywijziging tussen enqueue en uitvoering blokkeert de oude opdracht vóór enige toolactie.

<a id="AC-5"></a>

- [ ] AC-5: **Geen automatische heruitvoering.** Dubbele delegaties, crash na een toolactie, uitgevallen aflevering, reconnect en herstel van de queue veroorzaken geen automatische tweede uitvoering. Onbekende uitkomsten worden zichtbaar als onbekend. Bestaande tekstkanaal-retrytests blijven slagen.

<a id="AC-6"></a>

- [ ] AC-6: **Levenscyclus.** Onderbreken stopt spraak zonder valse taakannulering. Ophangen voorkomt nieuw werk, bewaart het resultaat van reeds gestart werk en ruimt sessies op. Serverdeadline werkt zonder browser. Provider-ack, afgeronde uitvoering en daadwerkelijk afgespeelde audio zijn onderscheiden toestanden.

<a id="AC-7"></a>

- [ ] AC-7: **Data en kosten.** Geen ruwe audio-opslag; alleen benodigde tekst wordt bewaard. Cumulatieve gebruiksupdates worden correct verwerkt. Ontbrekende finalisatie levert een onvolledige kostenstatus op. Opslag, cloudverwerking en retentie zijn gedocumenteerd.

<a id="AC-8"></a>

- [ ] AC-8: **SIP-uitbreidbaarheid.** Een fake tweede transportadapter kan dezelfde sessie- en backendcontracten gebruiken zonder wijziging van AgentRunner of browsercode. Geen echte SIP-aansluiting nodig voor V1.

<a id="AC-9"></a>

- [ ] AC-9: **Releasebewijs.** Lint/typecheck, gerichte tests en build slagen. Browsercontrole en een expliciet toegestane live Nederlandse proef tonen een kort gesprek, tooltaak, interruptie en hangup. Rapporteer gemeten verbindings- en antwoordvertraging en door Ivo beoordeelde gesprekskwaliteit, geen onbewezen latencygarantie. README, configuratiegids en relevante setup-skills beschrijven de daadwerkelijke beperkingen.

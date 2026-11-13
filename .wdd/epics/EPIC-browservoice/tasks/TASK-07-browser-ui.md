# TASK-07-browser-ui: Kleine mobiele browserinterface

Status: concept; niet geactiveerd.

## Objective

Maak een kleine frameworkvrije browserpagina met login, bellen, dempen, ophangen, taakstatus en geschatte voicekosten. Geen algemene chatapp. Gebruik WebRTC, expliciete microfoontoestemming en tekstveilige rendering. Hangup toont apart of een taak nog afrondt. Voeg alleen de noodzakelijke statische-assetkopie aan build toe. Integratie met echte sessie-service volgt in laatste taak.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../spec.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#ac-02 — AC-02
- ../spec.md#ac-06 — AC-06
- ../spec.md#ac-07 — AC-07

## Files to read first

src/voice/voice-types.ts; src/voice/transports/browser/; package.json

## Conflict domains

- `src/voice/web/**`
- `package.json`
- `tests/unit/voice/browser-client/**`

## Dependencies

TASK-03-browser-server, TASK-04-live-adapter

## Verification

Gerichte client lifecycle-checks met mocks. Handmatige Chrome/iPhone Safari-controle van microfoonweigering, autoplay, netwerkverlies, dubbel starten en opruimen na sluiten; service-start vereist toestemming.

Voor bronwijzigingen: eerst lint/typecheck, gerichte bestaande tests, build en zichtbaar gedrag. Testbestanden in deze brief zijn gepland, niet nu aangemaakt. Toestemming voor testwijzigingen en service/API-gebruik moet vóór uitvoering geregeld zijn conform AGENTS.md. Geen volledige suite zonder toestemming.

## Non-scope

Geen SIP, uitgaande calls, algemene approval-engine, onbeperkte providerrefactor, push of merge. Geen secrets inspecteren of services starten onder de autorisatie voor dit plan.

## Definition of done

- Criteria voor deze taak zijn aantoonbaar voldaan; onbekenden staan in bewijs.
- Geen open P1/P2-findings bij de WDD-taakreview met GPT-6.1 Sol / xhigh vóór integratie; geen verplichte review vóór iedere commit.
- Bestaand gedrag buiten voice blijft behouden.
- Geen changes buiten eigenaarschap; de worker is niet alleen en behoudt edits van anderen.

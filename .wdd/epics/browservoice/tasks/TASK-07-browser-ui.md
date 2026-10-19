# TASK-07-browser-ui: Kleine mobiele browserinterface

Status: gepland; start uitsluitend via de controller.

## Objective

Maak een kleine frameworkvrije browserpagina met login, bellen, dempen, ophangen, taakstatus en geschatte voicekosten. Geen algemene chatapp. Gebruik WebRTC, expliciete microfoontoestemming en tekstveilige rendering. Hangup toont apart of een taak nog afrondt. Voeg alleen de noodzakelijke statische-assetkopie aan build toe. De pagina implementeert het in TASK-01 bevroren HTTP/statuscontract. TASK-06 verzorgt de definitieve server-side koppeling; deze taak eindigt met een werkende mockcontract-validatie, geen ontbrekende clientimplementatie.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../design.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#AC-2 — AC-2
- ../spec.md#AC-6 — AC-6
- ../spec.md#AC-7 — AC-7

## Files to read first

src/voice/voice-types.ts; src/voice/transports/browser/; package.json

## Conflict domains

- `src/voice/web/**`
- `package.json`
- `tests/unit/voice/browser-client/**`

## Dependencies

TASK-03-browser-server, TASK-04-live-adapter

## Verification

Concrete commands (gerichte testwijzigingen zijn door Ivo toegestaan):

```sh
npm run lint
npx tsc --noEmit
npx vitest run tests/unit/voice/browser-client
npm run build
```

Gerichte client lifecycle-checks met mocks. Handmatige Chrome/iPhone Safari-controle van microfoonweigering, autoplay, netwerkverlies, dubbel starten en opruimen na sluiten; service-start vereist toestemming.

Voor bronwijzigingen: eerst lint/typecheck, gerichte bestaande tests, build en zichtbaar gedrag. Gerichte testwijzigingen uit dit plan zijn door Ivo toegestaan. Service/API-gebruik vereist aparte autorisatie conform AGENTS.md. Geen volledige suite zonder toestemming.

## Non-scope

Geen SIP, uitgaande calls, algemene approval-engine, onbeperkte providerrefactor, push of merge. Geen secrets inspecteren of services starten onder de autorisatie voor dit plan.

## Definition of done

- Criteria voor deze taak zijn aantoonbaar voldaan; onbekenden staan in bewijs.
- Geen open P1/P2-findings bij de WDD-taakreview met GPT-6.1 Sol / xhigh vóór integratie; geen verplichte review vóór iedere commit.
- Bestaand gedrag buiten voice blijft behouden.
- Geen changes buiten eigenaarschap; de worker is niet alleen en behoudt edits van anderen.

## Dispatch settings

Implementatie: gpt-5.6-luna, reasoning max. Onafhankelijke WDD-review: gpt-6.1-sol, reasoning xhigh. Geef beide expliciet mee aan de agent-harness; geen impliciete model- of effortfallback.

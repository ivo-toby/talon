# TASK-03-browser-server: Browserauthenticatie en sessie-endpoints

Status: gepland; start uitsluitend via de controller.

## Objective

Bouw de HTTP-adapter met statische assets, login/logout, eigenaargebonden create/status/close en statusstream. Gebruik bestaande Node HTTP- en ws-patronen waar geschikt. Bind aan loopback; HTTPS voor telefoon via bestaande proxy. Beperk loginpogingen, payloads en creatie. Injecteer VoiceSessionService-interface zodat servertests geen provider nodig hebben.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../design.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#AC-1 — AC-1
- ../spec.md#AC-4 — AC-4

## Files to read first

src/channels/connectors/terminal/terminal-connector.ts; src/voice/voice-types.ts

## Conflict domains

- `src/voice/transports/browser/**`
- `src/voice/voice-auth.ts`
- `tests/unit/voice/browser-server/**`
- `tests/unit/voice/browser-server/voice-auth.test.ts`

## Dependencies

TASK-01-contracts

## Verification

Concrete commands (gerichte testwijzigingen zijn door Ivo toegestaan):

```sh
npm run lint
npx tsc --noEmit
npx vitest run tests/unit/voice/browser-server
npm run build
```

Gerichte auth/route-tests: CSRF, Origin, cookieverval, logout, eigenaarverwisseling, sessie-ID raden, payloadlimieten en geredigeerde fouten. Geen secrets in browser of opgeslagen channel-config.

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

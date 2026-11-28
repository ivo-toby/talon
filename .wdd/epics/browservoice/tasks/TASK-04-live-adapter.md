# TASK-04-live-adapter: GPT-Live-provideradapter

Status: gepland; start uitsluitend via de controller.

## Objective

Isoleer OpenAI-handshake, server-side eventverbinding, eventvalidatie, transcriptbuffer en delegatiecontext. Delegatie-event bevat geen opdrachttekst: correleer tijdpositie/contextversie en vraag verduidelijking bij onzekerheid. Vertaal veilige voortgang/resultaten en acknowledgements. Gebruik bestaande fetch/ws; motiveer iedere extra dependency vóór toevoeging.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../design.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik Marin (`marin`) als expliciete standaardstem bij GPT-Live-sessiecreatie via `audio.output.voice`. Dit is de door Ivo gekozen productdefault; vertrouw niet op een impliciete providerdefault.

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#AC-3 — AC-3
- ../spec.md#AC-6 — AC-6
- ../spec.md#AC-7 — AC-7

## Files to read first

src/voice/voice-types.ts; design.md API- en contextcontract; officiële bronnen in design.md

## Conflict domains

- `src/voice/providers/**`
- `tests/unit/voice/providers/**`

## Dependencies

TASK-01-contracts

## Verification

Concrete commands (gerichte testwijzigingen zijn door Ivo toegestaan):

```sh
npm run lint
npx tsc --noEmit
npx vitest run tests/unit/voice/providers
npm run build
```

Offline gefakete transporttests voor late/ontbrekende transcriptfragmenten, duplicaten, verkeerde IDs, correcties, verlopen sessies, cumulatief gebruik en bounded buffers. Test sluitdeadline en onbekende finalisatie.

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

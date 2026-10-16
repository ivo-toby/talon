# TASK-04-live-adapter: GPT-Live-provideradapter

Status: concept; niet geactiveerd.

## Objective

Isoleer OpenAI-handshake, server-side eventverbinding, eventvalidatie, transcriptbuffer en delegatiecontext. Delegatie-event bevat geen opdrachttekst: correleer tijdpositie/contextversie en vraag verduidelijking bij onzekerheid. Vertaal veilige voortgang/resultaten en acknowledgements. Gebruik bestaande fetch/ws; motiveer iedere extra dependency vóór toevoeging.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../spec.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#ac-03 — AC-03
- ../spec.md#ac-06 — AC-06
- ../spec.md#ac-07 — AC-07

## Files to read first

src/voice/voice-types.ts; spec.md API- en contextcontract; officiële bronnen in spec.md

## Conflict domains

- `src/voice/providers/**`
- `tests/unit/voice/providers/**`

## Dependencies

TASK-01-contracts

## Verification

Offline gefakete transporttests voor late/ontbrekende transcriptfragmenten, duplicaten, verkeerde IDs, correcties, verlopen sessies, cumulatief gebruik en bounded buffers. Test sluitdeadline en onbekende finalisatie.

Voor bronwijzigingen: eerst lint/typecheck, gerichte bestaande tests, build en zichtbaar gedrag. Testbestanden in deze brief zijn gepland, niet nu aangemaakt. Toestemming voor testwijzigingen en service/API-gebruik moet vóór uitvoering geregeld zijn conform AGENTS.md. Geen volledige suite zonder toestemming.

## Non-scope

Geen SIP, uitgaande calls, algemene approval-engine, onbeperkte providerrefactor, push of merge. Geen secrets inspecteren of services starten onder de autorisatie voor dit plan.

## Definition of done

- Criteria voor deze taak zijn aantoonbaar voldaan; onbekenden staan in bewijs.
- Geen open P1/P2-findings bij de WDD-taakreview met GPT-6.1 Sol / xhigh vóór integratie; geen verplichte review vóór iedere commit.
- Bestaand gedrag buiten voice blijft behouden.
- Geen changes buiten eigenaarschap; de worker is niet alleen en behoudt edits van anderen.

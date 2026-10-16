# TASK-01-contracts: Contracten en haalbaarheidsproef

Status: concept; niet geactiveerd.

## Objective

Leg transport-, provider-, backend- en resultaatscontracten vast. Controleer met een beperkte, apart geautoriseerde live proef client delegation, transcriptvolgorde, sideband ownership, clientmutaties en sluitgedrag. Bewijs dat clientconfiguratie geen ruimere toolrechten of betaalde backend kan inschakelen. Rapporteer onbekenden; vervolgwerk wacht op een positieve haalbaarheidsbeoordeling.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../spec.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Bevries vóór parallel werk ook VoiceStore inclusief admission/queue-transactie en claim-versus-supersede, policy/configuratiesnapshot en execution eligibility, lifecycle/status DTOs en HTTP request/response schemas. Taken 02/03/04 krijgen dezelfde contracten, geen afzonderlijke uitvindingen.

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#ac-02 — AC-02
- ../spec.md#ac-03 — AC-03
- ../spec.md#ac-04 — AC-04
- ../spec.md#ac-08 — AC-08

## Files to read first

src/channels/channel-types.ts; src/daemon/agent-runner.ts; spec.md

## Conflict domains

- `src/voice/voice-types.ts`
- `.wdd/epics/EPIC-browservoice/evidence/**`

## Dependencies

Geen; deze taak is de haalbaarheids- en contractgate.

## Verification

Contractreview en geregistreerde proefresultaten, inclusief Nederlands, interruptie en mislukte setup. Geen service of betaalde API gebruiken zonder toestemming.

Voor bronwijzigingen: eerst lint/typecheck, gerichte bestaande tests, build en zichtbaar gedrag. Testbestanden in deze brief zijn gepland, niet nu aangemaakt. Toestemming voor testwijzigingen en service/API-gebruik moet vóór uitvoering geregeld zijn conform AGENTS.md. Geen volledige suite zonder toestemming.

## Non-scope

Geen SIP, uitgaande calls, algemene approval-engine, onbeperkte providerrefactor, push of merge. Geen secrets inspecteren of services starten onder de autorisatie voor dit plan.

## Definition of done

- Criteria voor deze taak zijn aantoonbaar voldaan; onbekenden staan in bewijs.
- Geen open P1/P2-findings bij de WDD-taakreview met GPT-6.1 Sol / xhigh vóór integratie; geen verplichte review vóór iedere commit.
- Bestaand gedrag buiten voice blijft behouden.
- Geen changes buiten eigenaarschap; de worker is niet alleen en behoudt edits van anderen.

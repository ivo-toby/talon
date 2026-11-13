# TASK-02-persistence: Duurzame voice-sessies en delegaties

Status: concept; niet geactiveerd.

## Objective

Maak sessie- en delegatieopslag met unieke provider-ID per sessie, contextdigest, queue/run-koppeling, resultaten en aparte afleverstatus. Zelfde ID met andere inhoud is een conflict. Admission en enqueue krijgen een gedeelde transactie-interface; herstel van gereserveerd maar niet gestart werk is expliciet. Geen ruwe audio of volledig transcript opslaan.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../spec.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#ac-05 — AC-05
- ../spec.md#ac-07 — AC-07

## Files to read first

src/core/database/repositories/base-repository.ts; src/core/database/repositories/queue-repository.ts; src/a2a/a2a-task-mapper.ts; src/core/database/migrations/

## Conflict domains

- `src/voice/voice-store.ts`
- `src/core/database/repositories/voice-repository.ts`
- `src/core/database/repositories/index.ts`
- `src/core/database/migrations/*-voice-*.sql`
- `tests/unit/core/database/voice/**`

## Dependencies

TASK-01-contracts

## Verification

Verifieer claim-versus-supersede transactioneel: correctie en hangup kunnen alleen ongeclaimd werk vervangen/overslaan; originele delegatie-ID en contextdigest blijven onveranderd. Vervangend werk krijgt een nieuwe revisie/ID. Test races met queue-claim.

Gerichte SQLite-tests voor transactierollback, dubbele events, conflicterende inhoud en crashherstel. Heropen de database met een verse verbinding en voer gewone writes uit. Kies bij implementatie het dan volgende migratienummer.

Voor bronwijzigingen: eerst lint/typecheck, gerichte bestaande tests, build en zichtbaar gedrag. Testbestanden in deze brief zijn gepland, niet nu aangemaakt. Toestemming voor testwijzigingen en service/API-gebruik moet vóór uitvoering geregeld zijn conform AGENTS.md. Geen volledige suite zonder toestemming.

## Non-scope

Geen SIP, uitgaande calls, algemene approval-engine, onbeperkte providerrefactor, push of merge. Geen secrets inspecteren of services starten onder de autorisatie voor dit plan.

## Definition of done

- Criteria voor deze taak zijn aantoonbaar voldaan; onbekenden staan in bewijs.
- Geen open P1/P2-findings bij de WDD-taakreview met GPT-6.1 Sol / xhigh vóór integratie; geen verplichte review vóór iedere commit.
- Bestaand gedrag buiten voice blijft behouden.
- Geen changes buiten eigenaarschap; de worker is niet alleen en behoudt edits van anderen.

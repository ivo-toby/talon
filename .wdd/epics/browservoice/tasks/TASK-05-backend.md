# TASK-05-backend: Queue- en AgentRunner-brug

Status: gepland; start uitsluitend via de controller.

## Objective

Voeg servergemaakte getypeerde voice-context en een smalle uitvoerings/resultaatsgrens toe. Hergebruik FIFO, provideridentiteit, persona en host-toolcontext. Persisteer resultaat los van aflevering; scheid voortgang/eindresultaat. Voice-admissie en queuewerk zijn atomair. Geen automatische replay via queue, failover, recovery of dead-letter als effecten mogelijk zijn. Geen aparte agentrunner of collaboration-bypass. Volledige providercontext krijgt actuele begrensde gesprekcontext, ook bij resumable sessions.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../design.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#AC-3 — AC-3
- ../spec.md#AC-4 — AC-4
- ../spec.md#AC-5 — AC-5

## Files to read first

src/daemon/agent-runner.ts; src/daemon/context-assembler.ts; src/queue/queue-processor.ts; src/a2a/a2a-task-mapper.ts; src/tools/host-tools-bridge.ts

## Conflict domains

- `tests/unit/core/database/repositories/queue-repository.test.ts`

- `src/voice/voice-backend-bridge.ts`
- `src/voice/voice-output-sink.ts`
- `src/daemon/agent-runner.ts`
- `src/daemon/context-assembler.ts`
- `src/queue/queue-manager.ts`
- `src/queue/queue-processor.ts`
- `src/queue/queue-types.ts`
- `src/core/database/repositories/queue-repository.ts`
- `src/core/database/repositories/voice-repository.ts`
- `src/channels/channel-types.ts`
- `tests/unit/voice/backend/**`
- `tests/unit/daemon/agent-runner*.test.ts`
- `tests/unit/daemon/context-assembler*.test.ts`
- `tests/unit/queue/**`

## Dependencies

TASK-02-persistence, TASK-04-live-adapter

## Verification

Concrete commands (gerichte testwijzigingen zijn door Ivo toegestaan):

```sh
npm run lint
npx tsc --noEmit
npx vitest run tests/unit/voice/backend tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-assembler.test.ts tests/unit/queue tests/unit/core/database/repositories/queue-repository.test.ts
npm run build
```

Verifieer claim-versus-supersede transactioneel: correctie en hangup kunnen alleen ongeclaimd werk vervangen/overslaan; originele delegatie-ID en contextdigest blijven onveranderd. Vervangend werk krijgt een nieuwe revisie/ID. Test races met queue-claim.

Test de race tussen enqueue en providerstart: gewijzigde of ingetrokken login/persona/capabilities/native-tool/MCP-configuratie blokkeert uitvoering vóór enige actie. Bewaar en vergelijk de toegelaten policy/configuratiegeneratie op beide grenzen.

Gerichte bestaande runner/queue/context-tests plus voice-regressies: toolactie gevolgd door afleverfout, procesherstart, replay en contextcorrectie. Bewijs dat tekstkanalen hun bestaande gedrag behouden. Test onbekende effecten zonder heruitvoering.

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

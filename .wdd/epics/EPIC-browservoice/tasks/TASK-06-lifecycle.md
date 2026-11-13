# TASK-06-lifecycle: Sessiebeheer en daemonintegratie

Status: concept; niet geactiveerd.

## Objective

Registreer opt-in voiceconfig en een logisch voicekanaal/thread zonder audio door de tekstpipeline te sturen. Voeg toelating van effectieve persona/provider/toolconfig toe: weiger requireApproval en onbewezen native-tool/MCP-bypass. Map login naar persona server-side. Beheer één actieve call, één actieve delegatie, deadlines, hangup, logout, shutdown/reload en startup-reconciliatie. Secrets blijven buiten gepersisteerde channel-config. Geen nieuwe cancel-belofte.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../spec.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#ac-01 — AC-01
- ../spec.md#ac-04 — AC-04
- ../spec.md#ac-05 — AC-05
- ../spec.md#ac-06 — AC-06
- ../spec.md#ac-07 — AC-07

## Files to read first

src/daemon/daemon-bootstrap.ts; src/daemon/daemon.ts; src/channels/channel-setup.ts; src/core/config/config-schema.ts; src/tools/tool-filter.ts

## Conflict domains

- `src/voice/voice-session-service.ts`
- `src/voice/voice-session-reconciler.ts`
- `src/voice/voice-policy.ts`
- `src/daemon/daemon-bootstrap.ts`
- `src/daemon/daemon-context.ts`
- `src/daemon/daemon.ts`
- `src/core/config/config-schema.ts`
- `src/core/config/config-types.ts`
- `src/channels/channel-setup.ts`
- `src/daemon/channel-factory.ts`
- `tests/unit/voice/lifecycle/**`
- `tests/unit/voice/lifecycle/policy.test.ts`
- `tests/unit/daemon/daemon*.test.ts`
- `tests/unit/core/config/**`

## Dependencies

TASK-03-browser-server, TASK-05-backend

## Verification

Verifieer claim-versus-supersede transactioneel: correctie en hangup kunnen alleen ongeclaimd werk vervangen/overslaan; originele delegatie-ID en contextdigest blijven onveranderd. Vervangend werk krijgt een nieuwe revisie/ID. Test races met queue-claim.

Test de race tussen enqueue en providerstart: gewijzigde of ingetrokken login/persona/capabilities/native-tool/MCP-configuratie blokkeert uitvoering vóór enige actie. Bewaar en vergelijk de toegelaten policy/configuratiegeneratie op beide grenzen.

Gerichte config/lifecycle-tests voor revoke, reload, shutdown, oude sessie-events, deadline zonder browser, pending versus running werk en policyverandering. Daemon-smoke volgens run-talon-smoke na toestemming voor service-start.

Voor bronwijzigingen: eerst lint/typecheck, gerichte bestaande tests, build en zichtbaar gedrag. Testbestanden in deze brief zijn gepland, niet nu aangemaakt. Toestemming voor testwijzigingen en service/API-gebruik moet vóór uitvoering geregeld zijn conform AGENTS.md. Geen volledige suite zonder toestemming.

## Non-scope

Geen SIP, uitgaande calls, algemene approval-engine, onbeperkte providerrefactor, push of merge. Geen secrets inspecteren of services starten onder de autorisatie voor dit plan.

## Definition of done

- Criteria voor deze taak zijn aantoonbaar voldaan; onbekenden staan in bewijs.
- Geen open P1/P2-findings bij de WDD-taakreview met GPT-6.1 Sol / xhigh vóór integratie; geen verplichte review vóór iedere commit.
- Bestaand gedrag buiten voice blijft behouden.
- Geen changes buiten eigenaarschap; de worker is niet alleen en behoudt edits van anderen.

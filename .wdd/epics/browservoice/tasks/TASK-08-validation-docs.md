# TASK-08-validation-docs: Integratiebewijs en gebruiksdocumentatie

Status: gepland; start uitsluitend via de controller.

## Objective

Controleer de samengestelde feature offline en daarna met een expliciet toegestane live Nederlandse call. Voeg een fake alternatief transport toe om SIP-grenzen te toetsen. Werk README, architectuur, voorbeeldconfig en setup-skills bij; documenteer HTTPS, toegang, beperkte persona, retentie, uitval en kosten. Geen echte SIP bouwen.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../design.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#AC-1 — AC-1
- ../spec.md#AC-2 — AC-2
- ../spec.md#AC-3 — AC-3
- ../spec.md#AC-4 — AC-4
- ../spec.md#AC-5 — AC-5
- ../spec.md#AC-6 — AC-6
- ../spec.md#AC-7 — AC-7
- ../spec.md#AC-8 — AC-8
- ../spec.md#AC-9 — AC-9

## Files to read first

spec.md; alle voicetaken; .agents/skills/run-talon-smoke/SKILL.md; README.md; AGENTS.md

## Conflict domains

- `tests/integration/voice/**`
- `README.md`
- `AGENTS.md`
- `config/talond.example.yaml`
- `docs/guides/voice.mdx`
- `docs/reference/config-schema.mdx`
- `.agents/skills/talon-setup/**`
- `.agents/skills/talon-setup-docker/**`
- `.agents/skills/add-voice/**`
- `.wdd/epics/browservoice/evidence/**`

## Dependencies

TASK-06-lifecycle, TASK-07-browser-ui

## Verification

Concrete commands (gerichte testwijzigingen zijn door Ivo toegestaan):

```sh
npm run lint
npx tsc --noEmit
npx vitest run tests/integration/voice tests/unit/voice tests/unit/core/database/voice tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/context-assembler.test.ts tests/unit/queue
npm run build
```

Eerst lint/typecheck, dan relevante bestaande en nieuwe tests, build en zichtbaar browsergedrag. Volledige suite alleen na toestemming. Leg aantallen, latencyobservaties, kosten, platformdekking en onzekerheden vast. Geen claim van gesprekskwaliteit zonder Ivos beoordeling.

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

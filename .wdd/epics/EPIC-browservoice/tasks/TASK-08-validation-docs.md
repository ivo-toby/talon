# TASK-08-validation-docs: Integratiebewijs en gebruiksdocumentatie

Status: concept; niet geactiveerd.

## Objective

Controleer de samengestelde feature offline en daarna met een expliciet toegestane live Nederlandse call. Voeg een fake alternatief transport toe om SIP-grenzen te toetsen. Werk README, architectuur, voorbeeldconfig en setup-skills bij; documenteer HTTPS, toegang, beperkte persona, retentie, uitval en kosten. Geen echte SIP bouwen.

## Deliverable

Een afgebakende wijziging voor bovenstaande verantwoordelijkheid, met relevante verificatie en bewijs. Volg het contract in ../spec.md. Geen werk buiten de conflict domains; meld noodzakelijke uitbreiding voordat parallelle uitvoering verdergaat.

## Interfaces

Gebruik de contracten uit TASK-01-contracts: VoiceTransport, LiveVoiceProvider, VoiceSessionService en VoiceBackendBridge. Resultaten en fouten gebruiken Talons Result-patroon. Concrete method signatures worden in taak 01 bevroren; volgende taken mogen deze niet onafhankelijk herdefiniëren.

## Acceptance criteria context

- ../spec.md#ac-01 — AC-01
- ../spec.md#ac-02 — AC-02
- ../spec.md#ac-03 — AC-03
- ../spec.md#ac-04 — AC-04
- ../spec.md#ac-05 — AC-05
- ../spec.md#ac-06 — AC-06
- ../spec.md#ac-07 — AC-07
- ../spec.md#ac-08 — AC-08
- ../spec.md#ac-09 — AC-09

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
- `.wdd/epics/EPIC-browservoice/evidence/**`

## Dependencies

TASK-06-lifecycle, TASK-07-browser-ui

## Verification

Eerst lint/typecheck, dan relevante bestaande en nieuwe tests, build en zichtbaar browsergedrag. Volledige suite alleen na toestemming. Leg aantallen, latencyobservaties, kosten, platformdekking en onzekerheden vast. Geen claim van gesprekskwaliteit zonder Ivos beoordeling.

Voor bronwijzigingen: eerst lint/typecheck, gerichte bestaande tests, build en zichtbaar gedrag. Testbestanden in deze brief zijn gepland, niet nu aangemaakt. Toestemming voor testwijzigingen en service/API-gebruik moet vóór uitvoering geregeld zijn conform AGENTS.md. Geen volledige suite zonder toestemming.

## Non-scope

Geen SIP, uitgaande calls, algemene approval-engine, onbeperkte providerrefactor, push of merge. Geen secrets inspecteren of services starten onder de autorisatie voor dit plan.

## Definition of done

- Criteria voor deze taak zijn aantoonbaar voldaan; onbekenden staan in bewijs.
- Geen open P1/P2-findings bij de WDD-taakreview met GPT-6.1 Sol / xhigh vóór integratie; geen verplichte review vóór iedere commit.
- Bestaand gedrag buiten voice blijft behouden.
- Geen changes buiten eigenaarschap; de worker is niet alleen en behoudt edits van anderen.

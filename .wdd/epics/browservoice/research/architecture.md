# Architectuuronderzoek

Uitgevoerd bij het opstellen van het browservoice-plan, tegen Talon HEAD 0bf45cf332a0644fb3a13f2ad99d60102c5be972. Geen live-providerproef uitgevoerd.

De architectuuragent traceerde channel-types, channel-setup, message-pipeline, queue-manager/processor, AgentRunner, ContextAssembler, host-tools-bridge en tool-filter. Bevindingen: connector.send is geen voltooiingssignaal; afleverfouten kunnen retries veroorzaken; requireApproval ontsluit momenteel tools zonder bevestigingspoort; er is geen bewezen taakannulerings-API. Het ontwerp bevat daarom een resultaatsgrens, geen automatische voice-replay, effectieve policycontrole bij admission én providerstart en geen valse annuleringsbelofte.

Officiële OpenAI-documentatie is gelezen voor GPT-Live client delegation, WebRTC en sessieafsluiting. Delegatie-events bevatten geen opdrachttekst; transcriptcontext moet door Talon worden gekoppeld. Provider-acks bewijzen geen hoorbare aflevering. De exacte APIwerking en natuurlijke Nederlandse interactie moeten in TASK-01 worden getoetst, na expliciete toestemming voor livegebruik.

Bronnen en volledige ontwerpafwegingen staan in design.md. Dit onderzoek is code/documentatiebewijs, geen runtimebewijs.

> Opgevolgd door [het actieve controllerplan](../browservoice/README.md). Deze map bewaart het oorspronkelijke concept.

# Browservoice planning

Concept, 11 oktober 2026. Alleen planning; geen actieve scope of implementatie.

- [Ontwerp en acceptatiecriteria](spec.md)
- [WDD-taakgraph](plan.json)
- [Worker briefs](tasks/)

## Voorgestelde volgorde

1. Contracten en haalbaarheidsproef (01).
2. Opslag, browser-server en Live-adapter (02, 03, 04).
3. Talon-backendbrug en browserinterface (05, 07).
4. Sessiebeheer/daemonintegratie (06).
5. Integratiebewijs en documentatie (08).

Maximaal drie workers; gedeelde bestanden blijven geserialiseerd. Iedere taak krijgt onafhankelijke review. De planner heeft geen credentials gelezen, live calls gestart of tests gewijzigd.

## Activatie

Het plan is nog niet goedgekeurd of toegepast. De controller is geïnitialiseerd; de vernieuwde .wdd/constitution.md en config.json wachten op ratificatie. Implementatie gebruikt GPT-5.6 Luna / max; PR-werk en WDD-reviews gebruiken GPT-6.1 Sol / xhigh. De verplichte review vóór iedere commit is verwijderd. Deze conceptbestanden vervangen geen actieve state. Een positieve dry-run is uitsluitend structurele validatie, geen bewijs van runtimewerking of toestemming voor uitvoering.

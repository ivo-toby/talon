# Browservoice — uitvoeringsplan

WDD is geratificeerd door Ivo en het plan is toegepast op 11 oktober 2026. Epicbranch: epic/browservoice. Acht taken staan klaar; er zijn geen workers gestart.

- [Specificatie en negen acceptatiecriteria](spec.md)
- [Ontwerp en integratiegrenzen](design.md)
- [Taakgraph](plan.json)
- [Onderzoeksbasis](research/architecture.md)

## Uitvoering

De volgende controlleractie is TASK-01-contracts met gpt-5.6-luna, reasoning max. Iedere WDD-review gebruikt gpt-6.1-sol, reasoning xhigh. Geef de reasoning-instelling expliciet mee aan de agent-harness; config.json selecteert alleen modellen. Merges blijven handmatig goed te keuren.

Testwijzigingen, services en live API-/credentialgebruik hebben de toestemming nodig die AGENTS.md voorschrijft. Het klaarzetten van het plan verleent die toestemming niet. De eerste taak kan de contracten voorbereiden; voor de live haalbaarheidsproef blijft die toestemming nodig. Geen geheime waarden inspecteren tijdens voorbereiding.

## Validatie

De officiële intake heeft configuratie, negen criteria, code/documentatieonderzoek en het ontwerp vastgelegd. Plan preview en apply --dry-run slagen; plan apply is uitgevoerd. De controller meldt start_task voor TASK-01-contracts. Twee advisories zijn bewust behouden: alle taken zijn high risk, en de lifecycle-taak noemt exacte daemonbestanden om zijn scope klein te houden. Dit zijn geen ontbrekende bestanden of criteria.

Dit is planningsvalidatie. Talon-lint, tests, build en browser/API-smoke zijn nog niet uitgevoerd omdat er geen runtimecode is gewijzigd.

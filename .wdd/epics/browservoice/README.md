# Browservoice — uitvoeringsplan

WDD is geratificeerd door Ivo en het plan is toegepast op 11 oktober 2026. Epicbranch: epic/browservoice. De uitvoering loopt via de controller; `wddctl next` is leidend voor de actuele taakstatus.

- [Specificatie en negen acceptatiecriteria](spec.md)
- [Ontwerp en integratiegrenzen](design.md)
- [Taakgraph](plan.json)
- [Onderzoeksbasis](research/architecture.md)

## Uitvoering

Implementatie gebruikt gpt-5.6-luna, reasoning max. Iedere WDD-review gebruikt gpt-6.1-sol, reasoning xhigh. Geef de reasoning-instelling expliciet mee aan de agent-harness; config.json selecteert alleen modellen. Ivo heeft op 11 oktober expliciet toestemming gegeven om gereviewde en geverifieerde WDD-taakbranches lokaal in epic/browservoice te integreren. Push en merge naar main zijn uitgesloten.

Ivo heeft de gerichte unit- en integratietestwijzigingen toegestaan en de globale toestemmingsregel voor testwijzigingen laten verwijderen. De volledige testsuite blijft apart te autoriseren. De tijdelijke lokale voiceproef en maximaal vijf totale provider-sessieminuten zonder Talon-tools zijn apart toegestaan; de sleutel staat uitsluitend in de genegeerde root-.env. Nieuwe hoorbare proeven vereisen afstemming. Marin is expliciet de standaardstem.

## Validatie

De officiële intake heeft configuratie, negen criteria, code/documentatieonderzoek en het ontwerp vastgelegd. Plan preview en apply --dry-run slagen; plan apply is uitgevoerd. De controller meldt start_task voor TASK-01-contracts. Twee advisories zijn bewust behouden: alle taken zijn high risk, en de lifecycle-taak noemt exacte daemonbestanden om zijn scope klein te houden. Dit zijn geen ontbrekende bestanden of criteria.

Het bewijs per taak staat in evidence/ en de WDD-reviewregistratie. De handmatige Nederlandse gespreksproef is door Ivo positief beoordeeld. Dit vervangt geen technische delegatie-, autorisatie- of herstelchecks.

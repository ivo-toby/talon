# Wave-Driven Development

Talon uses wddctl for development coordination. It is not a runtime dependency of Talon.

- constitution.md: governance proposal and human-approved policy.
- config.json: machine-consumed branches, checks, review, models and merge policy.
- state.json: controller-owned execution state; never hand-edit.
- epics/<slug>/: controller-created specs, designs, plan.json and worker briefs.
- shared-context/: durable development findings, without secrets.

Start with wddctl constitution status and wddctl next. Ratify the reviewed configuration only after Ivo approves its exact content. Create an epic via the controller, complete intake, review the plan and run preview/dry-run before applying an approved plan. Dispatch only after the necessary task permissions are established.

The templates/ and work/ directories are legacy planning references. They remain for historical context and must not override the constitution, current CLI or AGENTS.md. EPIC-browservoice is an unactivated draft prepared before controller initialization; import its content into a controller-created namespace when that plan is approved.

Current setup is local and requires human merge approval. Governance was ratified by Ivo on 2026-10-11; the authoritative ratification is in controller state. The approved constitution text is retained byte-for-byte, including its draft-era frontmatter, to preserve that fingerprint. The active browservoice plan is in epics/browservoice; EPIC-browservoice is the superseded draft. No implementation workers have started.

---
name: create-personality
description: |
  Create personality files for a Talon persona. Use when the user says
  "create personality", "add personality", "define personality",
  "customize persona", "persona voice", or "persona tone".
triggers:
  - "create personality"
  - "add personality"
  - "define personality"
  - "customize persona"
  - "persona voice"
  - "persona tone"
---

# Create Personality Files

Guide the user through creating personality files for a Talon persona.
Personality files are markdown files in `personas/<name>/personality/` that
get appended to the system prompt (after `system.md`, before skills).

## Phase 1: Select Persona

1. Run `npx talonctl list-personas` to show available personas.
2. Ask the user which persona to create personality files for.
3. Check if `personas/<name>/personality/` exists. If not, create it.

## Phase 2: Gather Personality Traits

Ask the user the following questions (they can skip any):

1. **Tone & voice**: "How should this agent sound? (e.g., formal, casual, witty, dry, warm)"
2. **Background & role**: "What's this agent's backstory or expertise? (e.g., British butler, senior engineer, research librarian)"
3. **Communication style**: "Any formatting preferences? (e.g., uses bullet points, keeps responses short, avoids emoji, uses code blocks)"
4. **Boundaries**: "Anything the agent should avoid? (e.g., no opinions on politics, never uses slang, avoids humor)"
5. **Examples**: "Can you give 1-2 examples of how this agent should respond to a casual question?"

## Phase 3: Generate Files

Based on the answers, create the appropriate files. Use numbered prefixes
for ordering (e.g., `01-tone.md`, `02-background.md`). Only create files
for traits the user provided — don't create empty placeholder files.

### File templates

**`01-tone.md`** — Voice and tone guidelines:
```markdown
# Tone & Voice

[User's tone description, written as directives for the agent]
```

**`02-background.md`** — Role and expertise:
```markdown
# Background & Role

[User's backstory, written as context the agent can reference]
```

**`03-style.md`** — Communication and formatting:
```markdown
# Communication Style

[User's formatting and response preferences, as rules]
```

**`04-boundaries.md`** — What to avoid:
```markdown
# Boundaries

[User's avoidance rules, written as constraints]
```

**`05-examples.md`** — Few-shot examples:
```markdown
# Response Examples

These examples illustrate the expected tone and style.

**User:** [example question]
**Agent:** [example response]
```

## Phase 4: Review

1. Show the user all generated files with their content.
2. Ask: "Want to adjust anything, add more files, or are we good?"
3. If adjustments needed, edit the files.

## Phase 5: Validate

1. Run `npx talonctl config-show` to verify the persona config is valid.
2. Remind the user: "Personality files are loaded when the daemon starts.
   Run `npx talonctl reload` or restart the daemon to pick up changes."

## Tips

- Files are loaded **alphabetically** — use numbered prefixes (`01-`, `02-`) to control order.
- Only `.md` files are loaded. Use `.txt` or `.bak` for notes that shouldn't be injected.
- Keep files focused — one trait per file makes it easy to enable/disable by renaming.
- The system prompt + personality + skills are concatenated. Keep personality concise to leave room for conversation context.

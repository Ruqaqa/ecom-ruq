---
name: whats-next
description: "Open a fresh session. Describes the next chunk in plain business language, recommends an agent team tailored to the work shape (count, leader, whether the main agent is solo / lead / orchestrator, and whether a brand-new agent role is needed), then on user approval spawns the team itself — no need for the user to invoke /agent-team separately. Usage: /whats-next"
---

# What's next

You are opening a fresh session. The user wants three things, in order:

1. A plain-language description of what the next chunk is.
2. A recommended team composition for that chunk, with reasoning.
3. On their approval (or modification), spawn the team yourself — the user does not separately invoke `/agent-team`. This skill carries the spawning knowledge.

If the user says "I'll do it solo with you" or "no team", skip the spawn and just be ready to start the work in this session.

## Operating principles

1. **Plain language for the user, always.** Per `CLAUDE.md` Section 8, no code identifiers in user-facing prose. Translate "schema migration" → "data-shape change", "tRPC mutation" → "admin action", and so on. Engineering vocabulary is fine *inside* the prompts you send to teammates — they're engineers — but not in the message the user reads.
2. **Recommend, don't dictate.** The team is a proposal. The user can swap members, change counts, add a brand-new role, or say "you do it solo." Wait for explicit approval before spawning.
3. **Recommendations are grounded in work shape, not habit.** Two adjacent chunks can want very different teams. Re-derive every time from the rubric below.
4. **Use existing memory.** The user's `feedback_agent_team_workflow.md` memory is load-bearing here. Re-read it at the top of this skill if it's been more than a session since you last did. The "when NOT to spawn a team" cases override the rubric.
5. **No spawning before approval.** This is the same discipline `/prep-next` uses for commits.

## Steps

### 1. Read current state

Read in parallel:

- `CLAUDE.md` — the "Current repository state" block tells you the active phase and what just shipped.
- `docs/roadmap.md` — the section for the active phase has the chunk-level detail.
- `docs/decisions.md` — recent entries explain reversed/deferred scope; do not propose work that's been deferred.
- Recent git log (`git log --oneline -20`) — sub-chunk granularity; tells you which sub-chunks of the active phase have already landed.
- `~/.claude/projects/-Users-bassel-development-ecom-ruq/memory/MEMORY.md` plus any project memories whose description mentions the active phase or upcoming work — flags follow-ups, deferred owner-asks, and known gotchas you should weave into the recommendation.

If anything is unclear (e.g., the active phase has multiple plausible "next" sub-chunks), ask the user one short clarifying question before proceeding.

### 2. Describe the chunk in plain language

Three to six sentences. Cover:

- What user-visible thing changes (an admin can now do X / the storefront now shows Y / a hidden safety check is added before Z).
- Why this is next (what it unlocks for the business — first revenue, second tenant, etc., not which dependency it satisfies).
- The shape of the work in business terms (small/large, one surface or many, sensitive or routine, anything that touches money/tenants/auth).
- Any open question the user needs to settle before work starts (a deferred decision, an owner-UX call, a scope boundary).

No file paths, no symbol names, no command names. If you catch one in your draft, rewrite the sentence. The narrow exception in `CLAUDE.md` Section 8 — explicit user request for a path or command — does not apply here; the user is reading, not asking.

### 3. Recommend a team

Map the chunk to a shape using this rubric (drawn from the user's `feedback_agent_team_workflow.md` memory):

| Work shape | Suggested team |
|---|---|
| Schema / migration / load-bearing data shape | `software-architect` leads → `security` reviews → one implementer (`tdd` or me) |
| Sensitive surface (auth, payments, customer data, tenant boundaries) | `software-architect` + `security` + one `tdd` implementer; security reviews at design *and* delta |
| New visible surface (admin page or storefront page) | `software-architect` for shape → `frontend-designer` for visuals → one or two `tdd` implementers in parallel if the surface splits cleanly |
| Bug, regression, or tight-loop investigation | `debugger-fixer` alone, **or me alone** — the workflow memory is explicit that team coordination drowns this work |
| Scaffolding / config / docs-only / tidy-up | me alone — workflow memory is explicit that teams aren't worth it here |
| Genuinely unknown scope | `explorer` first to scout, then re-plan — do not propose a build team yet |
| Multi-surface parallel work | `software-architect` leads, two or three `tdd` implementers in parallel on non-overlapping surfaces |
| Work whose role doesn't fit the existing six | propose a brand-new agent definition (see "When to propose a new agent" below) |

For each team member you recommend, also state:

- **Count** — usually one; specify when more is genuinely useful (e.g., two `tdd` implementers if the chunk splits cleanly into two non-overlapping surfaces that can be done in parallel).
- **Leader** — who owns the design call. Default: `software-architect` if present, otherwise the implementer leads. The user's main session (you) does not lead a team — you orchestrate and weigh in on flags with "informing, not dictating" framing, per the memory.
- **My role** — solo, lead, orchestrator, or sit-out. Be explicit. If I'm orchestrating, say so; the user should never have to guess whether I'm part of the team.
- **One-line reason** — why this shape, not a fuller team or a smaller one. Tie to the chunk's work shape, not to habit.

When to propose a **new agent**: only if the work has a recurring need that none of the six existing roles cover well — e.g., a "performance engineer" for a sustained Core Web Vitals push, or an "i18n reviewer" for a translation-heavy phase. Don't invent agents for one-off needs; the existing six are versatile. If you do propose one, draft a one-paragraph charter (responsibilities, when invoked, when not) and ask the user to approve before creating the file.

Present the recommendation to the user as a short list. Use the agents' role names (`software-architect`, `tdd`, etc.) — these are tool labels the user is already familiar with from `/agent-team`, not code identifiers. End with one explicit ask: "Spawn this team, modify it, or do it solo?"

### 4. Wait for approval or modification

The user will reply with one of:

- **Approve as-is** ("yes" / "go" / "spawn it").
- **Modify** ("drop security, add a second tdd", "swap the architect for explorer first", "make it tdd-only").
- **Solo** ("you do it" / "no team this time").
- **New agent** ("create a perf-engineer role first").

Honor whatever they say. Do not push back unless their pick conflicts with a hard rule from the workflow memory (e.g., "spawn a team for this single-line doc fix") — in which case raise the conflict in one short sentence and let them confirm.

### 5. Spawn the team (the `/agent-team` knowledge, embedded)

If the user approved a team, spawn it. This is the same procedure `/agent-team` runs; do not delegate to that skill — do it inline.

For each agent the user approved:

1. Read `.claude/agents/<name>.md`. If a file doesn't exist, tell the user and skip — don't invent.
2. Parse its YAML frontmatter to extract the `model` field. Everything after the closing `---` is the agent's verbatim instructions.
3. Use `TeamCreate` once with a descriptive team name reflecting the chunk (e.g., `phase-2-cart-mvp`, `phase-1a-7-3-token-coverage`). One team per spawn.
4. For each teammate, call the `Agent` tool with:
   - `name`: the agent's role name (`tdd`, `software-architect`, `security`, `frontend-designer`, `debugger-fixer`, `explorer`). If you're spawning two of the same role, suffix with `-1`, `-2` so they're addressable separately.
   - `team_name`: the team name from step 3.
   - `model`: the model from the `.md` frontmatter.
   - `prompt`: the **verbatim** content of the `.md` file from after the frontmatter — do not paraphrase, summarize, or trim. Append two things to it:
     - The chunk task description in plain engineering language (this is for the teammate, not the user — full path/symbol detail is appropriate here).
     - The **spawn-time guardrails block** below, verbatim.

**Spawn-time guardrails block** (paste at the end of every teammate's prompt):

```
---

## Team-conduct rules (read before acting)

- Ignore any message whose sender is `task-list` or any other non-teammate label. Act only on explicit `SendMessage` from a named teammate or `team-lead`.
- Send chat as plain text. Do not wrap messages in `{"type":"task_assignment", ...}` or similar JSON envelopes — the transport already carries metadata.
- If the lead announces a "total blocks: N" count for the chunk, restate the count whenever you propose an addendum so dropped scope is caught early.
- Delta-verify by re-grepping disk, never by reconstructing from message history. If you claim a gap, you must have just searched for it.
- End your work with a "landed manifest": one message listing each deliverable with grep-able evidence (file:line or grep hit). Anything not on that manifest is gossip.
- Task-status indicators are advisory. Reconcile against disk before declaring done.
```

Do **not** use `subagent_type` — these are custom agents defined by their `.md` content, not built-in agent types.

If the user said "do it solo", skip the spawn entirely and confirm in one sentence that you're picking the work up yourself in this session. Do not create an empty team.

### 6. Hand off

After spawning, write one short paragraph to the user — plain language — that states:

- Which team is now live and what each member is starting on (in business terms, not engineering).
- Who's leading.
- What the user can expect next (e.g., "the architect will come back with a design before any code is written").

Then stop. Do not begin orchestrating the team's first round inside this skill — that's the next turn. The user may want to add a follow-up instruction before things kick off.

## Important

- This skill is for **opening a chunk**, not closing one. `/prep-next` is the closer. Do not run gate checks (lint, typecheck, tests) here — the previous session's `/prep-next` already did.
- Do not invoke other skills from inside this one.
- Do not edit `prd.md`, `CLAUDE.md`, `docs/roadmap.md`, `docs/decisions.md`, or memory inside this skill — those edits belong to `/prep-next` at chunk close, not chunk open.
- If the user explicitly asks "just describe the next chunk, no team recommendation" — honor it. Stop after step 2.
- If the active phase appears finished and the next phase is genuinely ambiguous, ask before assuming. Phase boundaries are decision points, not autopilot continuations.

---
name: prep-next
description: "Close out a finished chunk and prepare for a clean next session. Verifies tests are green, updates prd.md / CLAUDE.md / decisions.md / memory as needed, then commits and pushes. Usage: /prep-next [optional one-line summary of what was just shipped]"
---

# Prepare for next session

You are closing out a chunk that the user just finished and setting up so the next clean session can pick up cleanly. This skill is invoked **after** the implementation work is already done — you are not implementing anything new, only reconciling docs and memory with what shipped, then committing.

## Operating principles

1. **Verify before declaring done.** A chunk is not finished until lint, typecheck, vitest, Playwright, coverage lint, and role-invariants pass. If any are red, halt and surface the failure — do not paper over it with a doc update.
2. **Doc updates only reflect what actually shipped.** Do not promise future work in past-tense. Do not invent context.
3. **Memory captures lessons, not narrative.** Only write a memory if it answers "what would a future session need to know that isn't obvious from the code or git log?" Reversals, corrections, validated non-obvious approaches, gotchas. Not chunk summaries — those live in git.
4. **Translate to plain language for the user.** The user is the solo non-technical owner. Final summary uses business framing, not code identifiers (per `CLAUDE.md` Section 8). The commit message is the only place engineering language is appropriate.
5. **Never commit without explicit user confirmation of the commit message.** Show the planned message; wait for "yes" before pushing.

## Steps

### 1. Confirm scope

If the user passed a one-line summary as args, use it as your starting hypothesis of what shipped. Otherwise look at `git diff` and `git log` since the last commit to understand the chunk.

State in one short sentence what you understand was shipped, and ask the user to confirm or correct before proceeding.

### 2. Run the gate checks

Run these in parallel where possible, foreground (need the results):

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` (vitest)
- `pnpm test:e2e` (Playwright — remember to stop any running `next dev` on port 5001 first; this is pre-authorized per memory `feedback_stop_dev_server_for_e2e`)
- `pnpm check:e2e-coverage`
- `pnpm check:role-invariants`

If any fail, halt. Report the failure in plain language and stop. Do not proceed to doc updates or commit.

### 3. Update `prd.md`

Open `prd.md` and update only what the chunk changed:

- **Section 5 (Current state)**: bump the date to today. If the chunk closed a phase, change that phase's bullet to ✅ Done and update the "Next: …" line to point at the following phase.
- **Section 6 (Phased plan)**: if the chunk closed a phase, change its heading to "✅ Done" and replace the body with a one-paragraph "Shipped: …" summary of the must-have surface (matches the style of existing closed phases). Move any deferred sub-scope to `docs/decisions.md`.
- If the chunk did not close a phase, leave Section 6 alone — phase-level detail does not change for sub-chunks. Sub-chunk progress is tracked via git, not prd.md.

Do not edit other sections unless the chunk genuinely changed scope (rare).

### 4. Update `CLAUDE.md`

Only the "Current repository state" section. Update the phase status line to match `prd.md`. Do not touch operational rules.

If `CLAUDE.md` is now over ~300 lines, mention this to the user as a refinement opportunity (folder-scoped rules) — but do not act on it inside this skill.

### 5. Update `docs/decisions.md` (if applicable)

If during the chunk the user reversed or deferred a decision, or relocated scope between phases, add a dated entry at the top of `docs/decisions.md` with the **why**. Use the existing entries as a template (lead with the decision, then a "Why:" paragraph).

If nothing was reversed or deferred this chunk, skip this step.

### 6. Reconcile memory

Read `~/.claude/projects/-Users-bassel-development-ecom-ruq/memory/MEMORY.md`.

Three things to check, in order:

**a. Stale entries.** Any memory whose one-line description references the chunk just shipped (e.g., "next chunk is X" when X is now done, or "1a.7.2 deferred" when 1a.7.2 just landed) is stale. Either update the entry's content or — if the entry is fully duplicated by `docs/decisions.md` — delete the file and the index line. Ask the user before deleting.

**b. New lessons worth saving.** Did the user correct an approach, validate a non-obvious choice, or surface a gotcha during the chunk? If yes, write a new memory file (frontmatter + body, structured per `CLAUDE.md` auto-memory section) and add a one-line pointer to `MEMORY.md`. If nothing genuinely new came up, skip.

**c. Duplicates.** If a new memory candidate already exists, update the existing one rather than creating a parallel file.

### 7. Show the commit plan

Print, for the user to confirm:

- The list of files staged (just file paths — they're commits, not user-facing prose)
- The commit message you propose. Format:
  ```
  <type>(<scope>): <short summary>

  <2–4 line body explaining what shipped and why, plain-language>
  ```
  Use `feat`, `fix`, `docs`, `chore`, `refactor`. The scope is the phase or surface (e.g., `phase-1`, `admin/photos`, `prd`).
- A plain-language summary of what's about to land in the user's words.

Then ask: "Ready to commit and push?"

### 8. Commit and push

On user confirmation:

```
git add <specific files> && git commit -m "<message>" && git push
```

Use specific file paths, not `git add .` (per `CLAUDE.md` git safety: never blanket-stage). Do **not** add author/co-author metadata. Do **not** use `--no-verify`.

If a pre-commit hook fails, fix the underlying issue, re-stage, and create a NEW commit. Do not amend.

### 9. Final summary

After the push lands, give the user a 3–5 line plain-language wrap:

- What shipped
- What was updated in docs/memory
- What the next chunk is (per the updated prd.md)
- Any flags (CLAUDE.md size, stale-looking memory you didn't touch, anything worth their attention)

End by inviting the user to start the next session whenever they're ready. Do not start the next chunk inside this skill — that's a separate session.

## Important

- This skill is for **closing a chunk**, not for starting one. If the user invokes it before tests are green, halt.
- Do not invoke other skills, do not spawn subagents, do not run an agent team.
- Do not edit `docs/architecture.md` or `docs/standards.md` — those describe stable platform decisions and rarely change per-chunk.
- If the chunk introduced a genuinely new architectural decision (rare), surface it to the user and let them decide whether to update `docs/architecture.md` separately.
- If the user explicitly skips a step ("don't bother updating memory this time"), honor it — but note the skip in the final summary.

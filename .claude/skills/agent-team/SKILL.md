---
name: agent-team
description: "Spawn an agent team from .md agent definitions. Each specified agent becomes a teammate with its exact .md content as instructions and model from frontmatter. Usage example: /agent-team tdd software-architect security"
---

# Agent Team Launcher

You are creating an agent team from the user's `.claude/agents/*.md` definitions.

## Input

The user provides agent names as arguments (e.g., `tdd software-architect security`). These correspond to `.md` files in `.claude/agents/`.

## Steps

1. **Parse the arguments** to get the list of agent names the user wants in the team.

2. **For each agent name**, read the corresponding file at `.claude/agents/{name}.md`. If a file doesn't exist, tell the user and skip it.

3. **Parse each file's YAML frontmatter** to extract the `model` field. The rest of the file content (everything after the closing `---`) is the agent's instructions.

4. **Create the team** using `TeamCreate` with a descriptive team name based on the task context.

5. **Spawn each teammate** using the `Agent` tool with these parameters:
   - `name`: the agent's name from frontmatter (e.g., `tdd`, `software-architect`)
   - `team_name`: the team name from step 4
   - `model`: the model from the `.md` frontmatter (e.g., `opus`, `sonnet`, `haiku`)
   - `prompt`: the **exact verbatim content** from the `.md` file (everything after the frontmatter `---`) — do NOT summarize, rephrase, or interpret it. Append the user's task description at the end.


## Important
- Do NOT use `subagent_type` — these are custom agents defined by their `.md` content.
- Only read the `.md` files the user specified — not all of them.
- Copy the `.md` content **verbatim** into each teammate's prompt. Do not paraphrase.
- If the user didn't provide any agent names, list the available agents from `.claude/agents/` and ask which ones to include.
- Available agents can be listed by globbing `.claude/agents/*.md` and showing filenames without extension.
- Do not assume the work is done and shutdown the team. The user must be the one that mention explicitely to shutdown the agents. Do not shut them down without permission.

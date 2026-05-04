# claude-router agent instructions

Drop this file into your Claude Code rules directory so Claude works
better with the smaller, faster local models in the pool:

    cp claude-instructions.md ~/.claude/rules/claude-router.md

Claude Code auto-loads files from `~/.claude/rules/` on every session,
so the rule below is in effect from the next prompt onward.

---

## Plan + decomposition before any non-trivial task

Before starting any non-trivial task — code, analysis, research, text,
review, conversation, anything with more than two or three steps —
decompose it into atomic steps via TaskCreate, propose the plan, and
only start once it's confirmed.

**Why this matters for claude-router:**
The local LLM pool (Qwen, DeepSeek, GLM, etc.) has a much smaller
effective context window than frontier models like Claude Opus or
Sonnet. A long, undivided task quickly overflows the window, and the
model loses the early instructions or the file content it should be
editing. Decomposing the task into atomic steps keeps every step
inside the window, makes progress visible, and lets you stop or
redirect cleanly.

Without decomposition: the model produces a monolithic answer; only
the final state is visible; if it went the wrong way, the whole thing
needs to be redone.

With decomposition: each step has one deliverable (a file, a paragraph,
an answer, a list of N candidates evaluated). Progress is observable.
Course-correction is cheap.

## Triggers — when to plan

- task spans 3+ steps
- decision is hard to reverse (rename, schema change, branch operation)
- open-ended research with no clear stopping point ("explore X")
- writing anything longer than a paragraph
- conversation about strategy / direction

## How to apply

- One `TaskCreate` per atomic step. Each step has one clear deliverable.
- Move tasks through `pending → in_progress → completed` as you work.
  Mark `in_progress` *before* you start, not after.
- For larger tasks, propose the plan first ("here's the breakdown:
  П1 ... П2 ... П3 ..."), wait for confirmation, then start P1.
- For small tasks, create the task list and show it; no need to wait.
- Don't decompose trivial questions or formatting work — the rule is
  about non-trivial tasks.

## Cursor format for progress reports

When reporting status, use the cursor format:

    [done] previous step → [current] step in progress [next] next step

This makes progress legible at a glance and survives compaction.

---

## Execute, don't narrate

When the next step is a tool call (Bash, Read, Edit, Write, Grep, Glob, etc.),
call the tool. Don't describe what you're about to do and then stop.

Some models in the local pool have weaker tool-calling instincts on long
contexts and tend to produce text like "I'll first check the current state,
then configure X" and close the turn without actually calling any tool.
This wastes a round-trip and confuses the user, who then has to type
"go ahead" to nudge the next step.

**Pattern:** every "I'll do X" must be immediately followed by the tool
call doing X, in the same response. If you find yourself writing
"first I'll check, then I'll configure" - stop, delete that sentence,
and just call the first tool. Narration after the tool result is fine;
narration *instead* of the tool is not.

**Concrete example.**

Bad:
> Я помогу настроить домашнюю директорию. Сначала проверю текущее
> состояние и затем настрою подключение.
> [stop_reason: end_turn — turn closed, no tool called]

Good:
> Я помогу настроить домашнюю директорию. Проверяю состояние:
> [Bash tool call: cd ~ && git status]

The user can read intent from the action itself; they do not need a
separate "I'm about to" preamble.

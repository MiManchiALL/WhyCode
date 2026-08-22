---
name: whycode-prose-standard
description: Write, edit, trim, or review prose in WhyCode repository Markdown documents and project-level development Skills while preserving the full technical contract and removing session-specific reasoning residue. Use for documentation wording, clarity, concision, and current-state cleanup. Do not use for UI copy, runtime model prompts, or code comments unless the user explicitly includes them in the documentation task.
---

# WhyCode Prose Standard

Write enough to preserve the contract, then remove reasoning transcripts, repetition, and decoration. A smaller word count is not an improvement if it loses a factual proposition.

## Preserve the complete proposition

Before rewriting, identify every claim the passage carries. Preserve all applicable dimensions:

- actor and required action;
- conditions, timing, ordering, and scope;
- modality such as must, should, may, or must not;
- invariants, negative guarantees, and exceptions;
- ownership, side effects, failure behavior, and consequences;
- measured bounds, evidence, and provenance when they make the claim verifiable.

Do not turn a requirement into advice, a possibility into shipped behavior, or a conditional guarantee into an unconditional one.

## Write from the correct vantage point

A reader at the current `HEAD`, without access to the authoring session, pull request, or uncommitted draft, must be able to resolve every reference and verify every claim.

For durable documents:

- describe the current system, not the sequence of edits that produced it;
- replace phrases such as “this time”, “the latest change”, or “as discussed above” with the surviving repository fact;
- keep historical rationale only when it constrains current behavior, and link to its owner when the full history belongs elsewhere.

`docs/05-暂存区便签.md` is intentionally transient: it may record current handoff state, immediate next actions, and unresolved evidence. Even there, write facts that another agent can verify and remove entries once their durable conclusion has moved to the owning document.

## Match coverage to the document genre

- Requirements need the user or actor, intended outcome, scope, acceptance boundary, and explicit exclusions that affect behavior.
- Architecture and protocol contracts need inputs, outputs, invariants, ordering, ownership, side effects, and failure semantics.
- Workflows and redlines need a trigger, required action, relevant exception, and validation condition.
- Status and handoff notes need current state, evidence, next action, and blocker only when one actually exists.
- Skills need precise matching conditions, required behavior, meaningful non-matches, and only the workflow detail that changes how the agent acts.

Keep a safety-critical local contract where it is used. Link to the owning document for broader rationale or examples instead of duplicating them.

## Remove reasoning leakage

Rewrite the surviving fact first, then delete the transcript around it.

Remove or restate:

- dead references to a chat turn, temporary branch, pull request, or review comment;
- “before versus after” narration in documents that are not changelogs or postmortems;
- reviewer-directed justification and review choreography;
- step-by-step derivation that explains how the author discovered a rule rather than what the rule is;
- hedged planning residue after the behavior is decided;
- duplicated rationale, decorative emphasis, and language slips that do not change meaning.

Keep legitimate issue references, suppression rationale, counterfactual regression pins, measured limits, external standards, and old-versus-new behavior when the document genre requires them.

## Edit with explicit authority

- If the user asks for an audit or review, report evidence and recommended ownership without modifying files.
- If the user asks for an edit, update the complete authorized scope and remove superseded text instead of stacking a second explanation beside it.
- Classify ambiguous passages as keep, add, trim, restore, restructure, or defer before changing them.
- Rewrite a borderline sentence only when the replacement preserves every proposition and makes the contract easier to recover.

For calibrated examples, read `references/examples.md`.

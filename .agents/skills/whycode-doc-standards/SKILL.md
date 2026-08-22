---
name: whycode-doc-standards
description: Govern the structure and ownership of documentation in the WhyCode repository. Use when writing, reviewing, moving, splitting, merging, auditing, or reorganizing WhyCode project documents, especially when deciding which document owns a fact or removing duplicated and stale material. Do not use for UI copy, runtime prompts, code comments, or generic prose polishing unless repository documentation is part of the request.
---

# WhyCode Documentation Standards

Treat this skill as structural guidance, not an instruction to shorten documents. Length is a discovery signal; it is not a defect by itself.

## Start from the repository contract

Before documentation work, read `docs/04-START-HERE.md` completely and read `docs/05-暂存区便签.md`. Obey the quality redlines in `04`.

Use the current document map in `04` as the authority until the user explicitly authorizes a new map. Do not redesign the taxonomy merely because two documents currently overlap.

The current ownership boundaries are:

- `01-需求与MVP.md`: product positioning, requirements, scope, module state, acceptance direction, and future product boundaries.
- `02-技术栈与架构.md`: architecture, implementation mechanisms, process boundaries, directory structure, and engineering design.
- `03-提示词与数据契约.md`: prompts, context, data, tools, protocols, Skills, planning, and agent contracts.
- `04-START-HERE.md`: the single entry point, standing development rules, quality redlines, high-level current status, and model-catalog maintenance policy.
- `05-暂存区便签.md`: transient handoff state, unresolved questions, immediate next work, verified pitfalls, and research notes that have not yet earned a durable home.

When a transient fact becomes stable, move its durable conclusion to the owning document and remove the stale copy from `05`. Do not preserve obsolete handoff history for compatibility.

## Resolve structure before rewriting prose

For each substantial change:

1. Locate the document in the tree and state its subject, owner, and direct children.
2. Decide the correct detail level. Move descendant implementation detail to its owner and leave a concise link or pointer where context is still needed.
3. Classify the material by intended use: tutorial material teaches a path; reference material supports lookup. Do not force both forms into one uninterrupted section when each is substantial.
4. For tutorial material, privately identify the intended reader, prerequisites, and concept order before editing.
5. Split or merge only when the resulting ownership boundary is clearer than the current one.

Before moving or renaming content, use `rg` to find inbound references. Update the content and all references atomically. Do not hand-edit a catalog or inventory that is generated from another source of truth.

## Keep one authoritative home per fact

- Put each durable fact in one owning document; other documents should link to it instead of paraphrasing it.
- Keep the local contract at the point of use when removing it would make the instruction unsafe or incomplete. Link outward for architecture, rationale, history, or extended examples.
- Preserve load-bearing obligations, invariants, ordering constraints, negative guarantees, exceptions, ownership, and failure behavior.
- Write durable documents from the current repository state. Reserve temporary chronology and active handoff state for `05`, or for a document genre that explicitly requires history.
- Keep a past decision only when it still constrains a plausible future choice. Archive or delete closed one-off implementation detail that has no remaining decision value.

## Audit by meaning

Use line count, age, repeated phrases, and section size only to locate candidates. Then inspect meaning.

Look for:

- duplicate rules with more than one apparent owner;
- session reasoning, review choreography, or change narration embedded in durable guidance;
- stale status labels, test counts, file inventories, or catalogs that should come from code or tooling;
- repeated rationale that can be owned once and linked;
- paragraph walls, decorative emphasis, and specification-like wording that obscure the contract;
- transient notes whose durable conclusion has already been recorded elsewhere.

When a document exceeds a practical size, first relocate misplaced detail, then condense proposition-preservingly. Raise a budget only after both steps, and only when the document genuinely owns the remaining material.

## Validate the result

- Re-run `rg` for moved headings, paths, and key terms to catch stale references and duplicate owners.
- Check relative links and referenced paths against the repository.
- Run existing relevant documentation or repository checks; do not invent a new validation command merely to satisfy this skill.
- Run `git diff --check` and inspect the final diff for accidental scope expansion.
- Confirm that every changed fact has one owner and that `04` and `05` reflect only true current state.

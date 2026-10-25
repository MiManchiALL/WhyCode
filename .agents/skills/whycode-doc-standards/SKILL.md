---
name: whycode-doc-standards
description: Govern the structure and ownership of documentation in the WhyCode repository. Use when writing, reviewing, moving, splitting, merging, auditing, or reorganizing WhyCode project documents, especially when deciding which document owns a fact or removing duplicated and stale material. Do not use for UI copy, runtime prompts, code comments, or generic prose polishing unless repository documentation is part of the request.
---

# WhyCode Documentation Standards

Treat this skill as structural guidance, not an instruction to shorten documents. Length is a discovery signal; it is not a defect by itself.

## Start from the repository contract

Before documentation work, read the document map and writing rules in `docs/04-START-HERE.md` (§3–4), and `docs/05-暂存区便签.md`. Read other guide sections only when the task reaches their subject. Development and code-quality constraints are owned by `AGENTS.md`.

Use the current document map in `04` as the authority until the user explicitly authorizes a new map. Do not redesign the taxonomy merely because two documents currently overlap.

The current ownership boundaries are:

- `AGENTS.md`: standing development instructions, code-quality rules, asynchronous/error-handling and resource constraints, frontend constraints, and links selected by task. Keep module details, visual parameters, versions, progress, incidents, and situational procedures elsewhere; do not require every linked document on every turn.
- `CONTRIBUTING.md`: contributor environment, the authoritative local verification policy, commit/PR responsibilities, and CI boundaries. Executable CI commands belong to `.github/workflows/ci.yml`.
- `01-需求与MVP.md`: product goals, current scope, non-goals, user-facing acceptance results, and trigger-based future directions.
- `02-技术栈与架构.md`: current architecture, module ownership, implementation mechanisms, lifecycles, data flow, Renderer baseline, and engineering constraints.
- `03-Agent与协议契约.md`: model-visible prompts and messages, context, tool schemas, structured output, persistence, planning, multi-agent, and recovery contracts.
- `04-START-HERE.md`: project orientation, how to establish current facts, development workflow, and the complete document map. Link to `AGENTS.md` for code-quality and resource constraints instead of duplicating them.
- `05-暂存区便签.md`: only current unfinished work, pending verification, blockers, and immediate next actions.
- `06-依赖安全例外.md`: verified dependency security exceptions, review conditions, and audit ownership.

Trigger-specific workflows live in project skills. `.agents/skills/whycode-model-catalog/SKILL.md` owns model catalog and CLIProxyAPI maintenance; standing instructions and `04` keep only the mandatory trigger link. Skills may add domain-specific evidence, but link to CONTRIBUTING rather than redefine the general test policy.

When a transient fact becomes stable, move its durable conclusion to the owning document and remove the stale copy from `05`. Delete completed handoff entries; Git owns completion history.

## Resolve structure before rewriting prose

For each substantial change:

1. Locate the document in the tree and state its subject, owner, and direct children.
2. Decide the correct detail level. Move descendant implementation detail to its owner and leave a concise link or pointer where context is still needed.
3. Classify the material by intended use: tutorial material teaches a path; reference material supports lookup. Do not force both forms into one uninterrupted section when each is substantial.
4. For tutorial material, privately identify the intended reader, prerequisites, and concept order before editing.
5. Split or merge only when the resulting ownership boundary is clearer than the current one.

Before moving or renaming content, use `rg` to find inbound references. Update the content and all references atomically. Do not leave a compatibility stub for a renamed development document. Do not hand-edit a catalog or inventory that is generated from another source of truth.

## Keep one authoritative home per fact

- Put each durable fact in one owning document; other documents should link to it instead of paraphrasing it.
- Keep the local contract at the point of use when removing it would make the instruction unsafe or incomplete. Link outward for architecture, rationale, history, or extended examples.
- Preserve load-bearing obligations, invariants, ordering constraints, negative guarantees, exceptions, ownership, and failure behavior.
- Write durable documents from the current repository state. Reserve only active handoff state for `05`.
- Keep a past decision only when it still constrains a plausible future choice. Delete closed one-off implementation detail that has no remaining decision value; Git retains it.

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
- Confirm that every changed fact has one owner, standing instructions remain limited to constraints and routing, and `05` contains only current unfinished work.

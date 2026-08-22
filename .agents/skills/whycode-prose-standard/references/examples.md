# WhyCode prose calibration

Use these examples for borderline edits. They illustrate the contract; do not copy their project facts into unrelated sections.

## Preserve modality and interruption semantics

Weak:

> Plans normally close when a turn finishes.

Contract-preserving:

> When the model ends a turn naturally, the runtime closes its active plan. A user interruption or a required background wait keeps the plan engaged so the same task can resume.

The second version retains the actor, trigger, exception, and consequence.

## Replace edit history with current state

Weak:

> We recently moved global Skills out of the application-data directory.

Current-state form:

> WhyCode discovers user-level Skills from `~/.whycode/skills/`.

The durable document owns the current location. Migration history belongs only in a genre that requires it.

## Keep the local safety contract

Over-trimmed:

> See the architecture document for session deletion.

Contract-preserving:

> Deleting a session removes only resources owned by that session; it must not terminate or delete another session's background work. See `docs/02-技术栈与架构.md` for lifecycle ownership.

The local rule remains actionable while broader rationale stays with its owner.

## Remove discovery transcripts

Weak:

> I first thought the renderer caused the mismatch, but after checking several conversations I found that the persisted event merge was actually responsible.

Current-state form:

> Persisted and streaming conversation events use the same merge rule so their rendered semantics cannot drift.

Keep the investigation only when it is evidence in a postmortem or active handoff note.

## Keep verifiable transient handoff state

Weak:

> This still seems a little strange and probably needs another look later.

Useful `05` entry:

> Pending validation: after reopening a long conversation containing a table, verify that the saved scroll anchor restores without a visible correction frame. The root cause is not yet confirmed.

The second version states the boundary, observable check, and uncertainty without inventing a conclusion.

## Do not erase provenance

Over-trimmed:

> The retained tail is large enough.

Contract-preserving:

> Full compaction retains approximately 20k tokens of the safe message tail; the split boundary must keep every tool call paired with its result.

Measured bounds and safety constraints are part of the contract, not verbosity.

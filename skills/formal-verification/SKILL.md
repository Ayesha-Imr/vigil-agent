---
name: formal-verification
description: Decide whether a change needs formal verification and do it. Use when work touches concurrency, retries, queues, schedulers, leases, locks, state machines, permission or approval checks, money, or anything where a bug is costly and tests reach few of the orderings. Model-checks a design with TLA+ (TLC) or checks code with property-based tests, and leaves a rerunnable check behind.
---

# Formal verification for vigil workers

A test checks the cases someone thought of. A model checker checks every ordering of steps in a
small model; a property-based test checks the real code on many generated inputs. Use them where a
bug costs the most and tests reach the least.

## When to use it

Use it when the task changes code that:

- runs concurrently or can be interrupted (workers, queues, retries, webhooks, crash recovery);
- makes a promise over time ("at most N per day", "exactly once", "never before X");
- guards permission, approval, payment or deletion;
- is a state machine (order flows, protocols, lifecycles).

Skip it for straight-line code, UI copy and configuration. Say in your report that you skipped it
and why, in one clause.

## How

Read the full method before starting. These files ship with vigil, next to this skill:

1. `../create-formal-verification-skill/SKILL.md`: choose the target and the tool, write a model
   that is true to the code, show every property failing on a broken variant, and leave a
   project-local verify skill behind. Follow it exactly.
2. `../statechart/SKILL.md`: read TLC results and draw the model as a statechart; it gives each
   invariant violation as its shortest path in plain words.
3. `../maintain-formal-verification-skill/SKILL.md`: bring an existing verification back in line
   after the code changed.

(Paths are relative to this file's directory. If one is missing, the vendored skills were not
installed; fall back to the summary below.)

Short version:

- **Pick the tool from the question.** Bad orderings of events → TLA+ with TLC. Behaviour of a
  function for every input → a property-based test of the real code (fast-check, Hypothesis,
  proptest). Properties at every size → a proof assistant, only if worth it.
- **True to the code.** Each model action names the function it models; one atomic step in code is
  one step in the model.
- **Able to fail.** Break the code or the model the way the property guards against and confirm the
  check catches it. A check you never saw fail proves nothing.
- **Findings stay findings.** If the code breaks the property, report the counterexample as steps in
  the code's words. Do not weaken the property to make it pass.
- **Honest scope.** State the bounds and what is not covered.

## Running TLC

```bash
bash <this skill's dir>/scripts/tlc.sh Spec.tla            # uses Spec.cfg next to it
bash <this skill's dir>/scripts/tlc.sh Spec.tla -config MC.cfg
```

The script finds `tla2tools.jar` (`$TLA2TOOLS_JAR`, `~/.vigil/tools/`, `/opt/vigil/tools/`) or
downloads it once into `~/.vigil/tools/`. It needs Java 11 or newer; if `java` is missing, say so
in your report instead of guessing a result.

## Report

In your ticket report, say in plain words: the property, the tool and why, the bounds, the
result (pass, or the counterexample as numbered steps), what a broken variant showed, and the
command to rerun it.

Example model and verify skill: vigil's own `verification/governor/` and
`.pi/skills/verify-attention-governor/SKILL.md` in the vigil repository.

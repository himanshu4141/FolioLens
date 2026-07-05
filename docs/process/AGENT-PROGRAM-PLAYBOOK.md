# Agent Program Playbook

How to run a multi-milestone, multi-agent program: one research report, one executor,
two independent reviewers (Codex + Claude), sequential implementation PRs, and a
mechanical convergence gate.

This playbook is distilled from the 2026-06/07 navigation-performance program
(control plane: PR #250; milestones N1–N3 in PRs #251–#256; correctness hotfix C1 in
PR #257). That program's dual independent review caught at least four real defects —
the N2 idle-queue redesign, the N2D bootstrap/cleanup lifecycle race, the N3 tool
under-invalidation, and the C1 NAV-coverage diagnosis plus its pagination tie-breaker —
so the review redundancy stays. What this playbook changes is the *transport*: where
status lives, who reads what, and which gates are mechanical instead of conventional,
because that is where the first program burned tokens.

---

## 1. When to use this

Use this playbook when all of the following hold:

- The work starts from a substantial research/audit report and decomposes into a
  sequential queue of implementation milestones (roughly 4+).
- Correctness matters more than speed (financial data, auth, cache integrity), so
  every milestone gets two independent reviews and explicit convergence.
- The agents post through one GitHub account, so roles must be tagged in comments.

For a single contained change, use the normal PR flow. For a feature with a design
phase, use an ExecPlan per `docs/process/PLANS.md`; a program milestone may itself
require an ExecPlan (the report's task prompt says when).

## 2. Roles

| Role | Tag prefix | Does | Never does |
|---|---|---|---|
| Human owner | — | Sets scope, answers escalations, owns branch protection, can halt the queue | — |
| Execution owner | `[Execution <ID>]` | Implements one milestone at a time, opens/merges the implementation PR, updates the control-plane PR description | Resolves reviewers' threads; merges without a green gate |
| Codex reviewer | `[Codex review <ID>]` | Independent review of each implementation PR | Edits the control plane; approves without independent verification |
| Claude reviewer | `[Claude review <ID>]` | Independent review of each implementation PR | Edits the control plane; approves without independent verification |

### Session model

The program runs on exactly **three persistent sessions** — one per agent role —
started once at program setup with the §7 bootstrap prompts and left running for the
life of the program. Each session advances to the next milestone on its own when the
current implementation PR merges; there is no per-milestone human dispatch. All
coordination state lives on GitHub (PR description, labels, comments — §3), never in
a session's memory: a session that dies, compacts, or is restarted is relaunched
with the same bootstrap prompt and resumes from the tracking table. Design every
prompt and protocol step to survive that restart.

There is no separate coordinator role. The first program's coordinator existed to
commit tracking-table updates to the research branch; with status in the PR
description (§3) that job is a two-minute executor step, and coordinator wakes and
bookkeeping commits disappear. The human owner audits the tracking table instead.

## 3. Where state lives (the token-economy core)

The first program's biggest waste was transport: status updates were commits to the
research branch, every commit triggered EAS/Vercel runs and bot comments on the
control PR, every comment woke subscribed sessions, and every woken session re-read a
50+-comment thread. The rules below exist to break that chain.

| State | Lives in | Why |
|---|---|---|
| Research report | Research branch, read via `git show origin/<branch>:<path>` | Stable, versioned reference; changes only for genuine scope amendments |
| Tracking table + ledger | Control-plane PR **description** | Body edits create no commits, no CI runs, no bot comments, no notifications — and any session reads it with one cheap API call |
| Milestone announcements | Control-plane PR comments — **exactly two per milestone** (START, MERGED) | Durable audit trail without thread bloat |
| Review discussion | Implementation PR threads | Keeps the control PR readable; scoped context for reviewers |
| Convergence state | SHA-pinned `CONVERGED at <sha>` comments on the implementation PR (source of truth) + advisory converged labels | Machine-checkable; enforced by the gate workflow against the current head |
| Correctness interrupts | One investigation comment on the control PR + a `correctness-hotfix` PR | High-signal events earn control-PR space |

**Tracking table format** (in the control PR description):

    ## Program tracking

    | Queue | Milestone | Status | Implementation PR | Merge SHA | Notes |
    |---:|---|---|---|---|---|
    | 1 | N1 | Merged | #251 | `53e57f5` | iOS evidence blocker recorded |
    | 2 | N2 | In progress | #252 | — | — |
    | 3 | N2D | Pending | — | — | — |

Status values: `Pending`, `In progress`, `In review`, `Merged`, `Paused`. A hotfix
gets its own row inserted at its queue position.

**Ledger format** (also in the control PR description, newest first; ~10 lines per
milestone — this is what future sessions read instead of the comment history):

    ## Ledger

    ### N2 — merged 2026-07-01
    - PR #252, merge `7d3f25e`, measured code `d88d127`.
    - Removed automatic all-alternative benchmark prefetch; added focus-gated
      intent-only prefetch; Fund Detail portfolio weight now a cache-only selector.
    - Deviation: idle-queue mechanism deleted entirely after review (stronger than
      the report's cancel-on-blur ask). FeedbackSheet kept eager (N1 showed no cost).
    - Carried forward: none.

## 4. Labels and the mechanical convergence gate

Labels are defined in `.github/program-labels.json` and created/updated by the
**Program Label Sync** workflow (`program-label-sync.yml`) — it runs automatically
when the definition file changes on `main`, or run it manually from the Actions tab.

| Label | Meaning |
|---|---|
| `program-control-plane` | The long-lived research/control-plane PR |
| `program-milestone` | Implementation PR under a program (human-visible marker; the `program/` branch prefix is what binds the gate) |
| `needs-review` | Executor requests both independent reviews |
| `re-review` | Findings addressed; executor requests re-review at the new head |
| `codex-converged` | Codex reviewer converged at the current head |
| `claude-converged` | Claude reviewer converged at the current head |
| `correctness-hotfix` | Correctness interrupt; the queue is paused until it merges |

The **Program Convergence Gate** workflow (`program-convergence-gate.yml`, check name
"Dual-review convergence") runs on every PR and enforces on program PRs:

- **Membership is the head branch prefix.** Program branches are named
  `program/<milestone-id>-<slug>` (hotfixes too: `program/<hotfix-id>-<slug>`). A
  PR's head branch cannot change after creation, so membership cannot be toggled
  off the way a label can — removing `program-milestone` from a `program/` PR does
  not bypass the gate. The label also opts a PR in, but it is the weaker signal;
  always use the branch prefix.
- **The source of truth is SHA-pinned comments, not labels.** The gate passes only
  when both reviewers have posted a comment whose **entire trimmed body is
  exactly** `[<Role> review <ID>] CONVERGED at <full 40-char head SHA>` matching
  the **current** head — nothing else in the comment, no footers. Whole-body
  matching is deliberate: substring matching would accept negations
  ("NOT CONVERGED at <sha>", "Withdrawing CONVERGED at <sha>") or quoted mentions
  of the format in discussion. To withdraw a convergence at the same head, edit or
  delete the marker comment. A push instantly invalidates convergence because the
  pinned SHA no longer matches — no label state can go stale into a green gate,
  and the first program's "merged before the final convergence marker" slip cannot
  recur.
- The `codex-converged`/`claude-converged` labels are **advisory UX**: the gate
  strips them on every push so the PR never displays a convergence that no longer
  holds, and adding one is what re-triggers the gate evaluation — but they are
  never trusted as evidence.
- Non-program PRs pass immediately, so the check is safe to mark **required** on
  `main` without affecting normal PRs. Do that at program start; a gate that can be
  skipped under time pressure will be.
- Honesty about the limit: with every role posting through one GitHub account, the
  gate guards against **process mistakes, not adversarial agents** — a rogue
  session could forge a reviewer's comment. SHA-pinning makes that auditable after
  the fact, not impossible.

**Label lifecycle** (labels only emit GitHub events when their state actually
changes — re-adding a present label is a silent no-op, so consumption is explicit):

| Label | Added by | Removed by |
|---|---|---|
| `needs-review` | Executor, to open round 1 (ensure absent first) | Executor, immediately before the round's batched fix push; at merge |
| `re-review` | Executor, after each batched fix push, to open the next round (ensure absent first) | Executor, immediately before the next batched fix push; at merge |
| `codex-converged` / `claude-converged` | Each reviewer, together with the SHA-pinned CONVERGED comment | Gate (automatically, on every push); executor at merge |

## 5. Lifecycle

### 5.1 Research phase

Run the investigation as its own PR containing **only** the report (no application
code). Append the report format contract (§7.1) to the research prompt so the output
arrives program-ready: evidence tiers, per-finding acceptance criteria, a milestone
queue sized one-PR-each, per-milestone task prompts, and a program exit criterion.
Both reviewers review the report itself before any milestone starts; reconcile until
converged (this caught the analytics/preview-channel confound in the first program
before any code was written).

### 5.2 Program setup checklist

1. Keep the research PR open as the control plane; label it `program-control-plane`;
   keep it **draft** so it cannot merge accidentally. It merges last, after the
   tracking table is complete.
2. Write the tracking table (all milestones `Pending`) and an empty ledger into the
   PR **description** using the §3 formats.
3. Verify the program labels exist (run Program Label Sync if not).
4. Add "Dual-review convergence" to required status checks on `main`, or record the
   human owner's explicit decision not to.
5. Decide the merge authority. For a fully automated program the executor merges
   autonomously on a green gate (default); alternatively the human owner presses
   merge for the first milestones until the loop has a track record. Record the
   decision in the control PR description.
6. Post one comment announcing the queue start, linking this playbook. Start the
   three persistent sessions: executor (§7.3), Codex reviewer (§7.4), Claude
   reviewer (§7.5). From here the program runs itself; the human owner watches the
   tracking table and answers escalations.

### 5.3 Per-milestone cycle

1. **Start.** The executor session selects the first `Pending` row from the tracking
   table, branches `program/<milestone-id>-<slug>` from current `origin/main` (the
   prefix is what binds the PR to the convergence gate — see §4), and loads only:
   the control PR description, the report section(s) for this milestone, and the
   milestone task prompt. Sets the tracking row to `In progress`. Posts the START
   comment — this comment is also the reviewers' wake signal.
2. **Implement.** Milestone scope only. Repo validation checklist (typecheck, lint,
   full tests, `git diff --check`) plus the milestone's focused tests. Native
   evidence, where required, is recorded at the exact implementation SHA (device,
   channel, OTA/update ID, SHA).
3. **Request review.** Open as draft; when acceptance evidence is complete, mark
   ready, add `program-milestone`, then add `needs-review` (ensure it is absent
   first — §4 label lifecycle). The head SHA at that moment is round 1's **frozen
   head**. Tracking row → `In review`.
4. **Dual review, in frozen-head rounds.** Both reviewer sessions, woken by the
   START comment, review the *same* frozen head per §7.4/§7.5 — independent
   verification, inline threads for actionable findings, and one round summary
   each: either `changes requested` or the SHA-pinned CONVERGED comment. **The
   executor does not push while a round is open.** Only after *both* round
   summaries are in: if both converged, proceed to merge; otherwise the executor
   removes the round label, pushes **one batched push** addressing every
   actionable thread from both reviewers, replies with commit + evidence, and
   adds `re-review` to open the next round at the new frozen head. The barrier is
   the point: without it, one reviewer's mid-round push invalidates the other
   reviewer's in-progress review and the cycle ping-pongs.
5. **Merge.** Only when the gate check is green — it verifies SHA-pinned
   `CONVERGED at <head sha>` comments from both reviewers against the current
   head — plus all other required checks, with no open actionable thread.
   Squash-merge as usual; remove the round and converged labels at merge.
6. **Close out.** Executor posts the MERGED comment (PR link, merge SHA, validation
   summary, deviations, carried-forward flags), sets the tracking row to `Merged`,
   appends the ledger entry, and immediately starts the next `Pending` row. No
   separate bookkeeping session, no bookkeeping gate. Reviewers see the MERGED
   comment, unsubscribe from the implementation PR, and wait for the next START.

### 5.4 Correctness interrupt (hotfix)

Modeled on C1/PR #257. When anyone finds a user-facing correctness defect:

1. **Pause the queue.** No new milestone starts until the fix merges. Mark any
   in-flight milestone row `Paused`.
2. **Investigate first.** Post ONE investigation comment on the control PR:
   reproduction evidence, root cause with `file:line`, provenance (which commits
   introduced/extended it), recommended correction, and an explicit request for both
   reviewers to independently confirm or refute.
3. **Independent confirmation.** Each reviewer responds once: confirmed root cause
   plus acceptance criteria, or a concrete counterexample/evidence gap. (In C1 this
   step found an additional defect — the pagination tie-breaker — and narrowed the
   blast radius. It is not optional.)
4. **Fix PR** from branch `program/<hotfix-id>-<slug>`, labeled `program-milestone`
   + `correctness-hotfix`; the standard gate and review cycle apply. A hotfix
   touching financial computation or its inputs needs the same golden-equivalence
   AND garbage-in fixtures as any milestone.
5. **Resume.** Ledger entry, tracking row, queue resumes.

### 5.5 Program exit

Per-milestone acceptance is not program success. The report defines a **program exit
criterion** (§7.1 item 9): the field evidence that closes the originally reported
symptom — typically production-channel telemetry percentiles over a stated period,
not a scripted device run. The first program's lesson: the original navigation hang
was never reproduced on-device; only instrumentation on the main channel can prove
it gone. The control PR merges (report + final tracking table) only after the exit
criterion is evaluated and its outcome — met, or explicitly accepted as unmet —
is recorded in the report.

## 6. Communication budget (hard rules)

- Control PR comments: **two per milestone** (START, MERGED) + hotfix investigation
  and its two reviewer confirmations + genuine escalations to the human owner.
  Everything else belongs on the implementation PR. No "acknowledged", no status
  narration.
- **The control PR is the wake bus, and it must stay quiet enough to be one.**
  Reviewer sessions subscribe to the control PR — it is their signal for the next
  milestone, and it stays low-traffic precisely because status changes are
  description edits (no commits, no CI, no bot comments) and the comment budget
  above is enforced. During an active review, each session also subscribes to the
  implementation PR, and unsubscribes from it after merge.
- Bot comments (EAS preview, Vercel deploy) are never actionable for any role. A
  session woken by one re-arms silently — no reply, no re-read of history.

### Wake mechanics (per runtime — this is where automation is real or it isn't)

GitHub *watch/notification* subscriptions do not wake an agent session; nothing
happens unless the session's runtime has an actual inbound-event or scheduling
mechanism. Pick the row that matches each session and write it into that session's
bootstrap prompt:

| Runtime capability | Mechanism |
|---|---|
| Webhook wakes (e.g. Claude Code remote sessions via PR-activity subscription) | Subscribe to the control PR for the life of the program; additionally subscribe to the implementation PR during an active review cycle and unsubscribe at merge. Events arrive as session wakes. |
| Scheduled self-wakes only | Schedule a recurring check (~15–30 min during an active round, ~hourly otherwise) that reads one surface and re-arms silently when nothing changed. |
| Neither (e.g. Codex cloud polling loops) | Poll on a long interval — and poll only the surface where the next expected event will appear: the control PR between milestones, the implementation PR during an active review cycle. Never tight-loop. |
| None acceptable | Use §8 stateless Actions dispatch — the only fully event-driven option that needs no live session at all. |

Whatever the mechanism, every persistent session also keeps a slow fallback
heartbeat (~hourly) so a single missed event cannot strand the program, and a
no-change heartbeat re-arms without commenting or re-reading history.
- Context loading per session: control PR **description** + the milestone's report
  section(s) + the PR being worked. The full report is read only when amending it.
  The control PR comment thread is read only during a hotfix investigation.
- Status changes are **description edits, never commits**. The research branch
  changes only for genuine scope amendments (a new milestone, a materially changed
  prompt), announced in the next START/MERGED comment.
- Review evidence must name the exact SHA it was collected at. Reviewers reject
  stale-head evidence; "the evidence is from two commits ago" restarts step 4.

## 7. Prompt library

Placeholders use `{{NAME}}`. Fill every placeholder before dispatching; keep the
role tags verbatim since all agents post through one GitHub account.

§7.3–7.5 are **session bootstrap prompts**: each is given to its session exactly
once, at program start, and the session then runs the whole program milestone by
milestone. They are restart-safe by design — if a session is lost or compacted,
start a fresh one with the same prompt and it resumes from the tracking table.

### 7.1 Research-report format contract

Append this block to any research/audit prompt so the report arrives in the format
this program expects:

    Output requirements — structure the report exactly as follows:

    1. Header: the reported symptom(s) near-verbatim, then a conclusion paragraph
       stating the primary explanation and what it is NOT.
    2. "Baseline and scope" table: repo, analysed commit SHA, commit date, analysis
       date, surfaces covered, static checks run, build/export sizes if relevant.
    3. "Evidence standard": label every finding Confirmed (directly demonstrated in
       current code or a rendered tree), Strong (complete causal path, contribution
       unquantified), or Candidate (credible risk, measure later). Never present
       Strong or Candidate as Confirmed. Do not use development-server timings as
       evidence for release behavior.
    4. "Executive summary" table: order, finding, severity (P0–P2), confidence,
       which reported symptom it explains.
    5. Numbered findings. Each finding has: a status line; evidence with file:line
       references; a "Required fix" list; and "Acceptance criteria" written as
       observable, testable statements (query counts, timing bounds, error counts —
       not "should feel faster").
    6. "Recommended implementation order": a queue table (queue #, milestone ID,
       scope, why this position). Size every milestone to exactly one PR. Sequence
       measurement/instrumentation first, correctness fixes and deterministic causes
       before amplifiers, and large refactors after contained fixes have evidence.
       State explicitly which milestones are independent tracks.
    7. Per-milestone task prompts in fenced blocks, each usable standalone by an
       executor with no other context. Every prompt must include: a mandatory
       preamble naming how to read this report and the control-plane state; the
       exact files/docs/sections to read; the scope with explicit non-goals; the
       validation commands; and the required evidence, including exact-SHA native
       evidence where applicable.
    8. "What not to do": the tempting shortcuts this report forbids, with reasons.
    9. "Program exit criterion": the field evidence that closes the originally
       reported symptom (metric, channel, threshold, observation period) — distinct
       from per-milestone acceptance criteria.
    10. Rules: the research PR contains no application code changes; the report
        lives at docs/research/<topic>-<date>.md; any milestone that adds caching
        or derived storage over financial data must include garbage-in fixtures
        (deliberately incomplete or corrupt underlying inputs) in addition to
        golden-equivalence fixtures, because equivalence tests preserve upstream
        bugs by construction.

### 7.2 Program setup

    The research report at {{REPORT_PATH}} on branch {{RESEARCH_BRANCH}} has been
    dual-reviewed and accepted. Set up the program control plane per
    docs/process/AGENT-PROGRAM-PLAYBOOK.md:

    1. Keep the research PR #{{CONTROL_PR}} open and DRAFT; add the
       program-control-plane label.
    2. Write the tracking table (all milestones Pending) and an empty ledger into
       the PR DESCRIPTION using the playbook §3 formats. The description — not
       commits, not comments — is the single mutable status surface.
    3. Verify the program labels exist; if not, run the "Program Label Sync"
       workflow from the Actions tab.
    4. Confirm "Dual-review convergence" is a required status check on main, or
       record the owner's explicit decision not to make it one.
    5. Record the merge-authority decision (executor merges on green gate, or human
       presses merge) in the description.
    6. Post one comment announcing the queue start. Then start the three persistent
       sessions with the playbook §7.3, §7.4, and §7.5 bootstrap prompts; they run
       the program from here.

### 7.3 Executor session (given once, runs the whole program)

    You are the Execution owner session for the {{PROGRAM_NAME}} program. You run
    the entire milestone queue, one milestone at a time, without waiting for
    per-milestone instructions. All program state lives on GitHub, never in this
    conversation: if this session restarts or its context is compacted, re-read
    the control PR description and resume from the tracking table.

    Program constants:
    - Control-plane PR: #{{CONTROL_PR}} (its DESCRIPTION holds the tracking table
      and ledger; you own keeping both current).
    - Research report: git fetch origin {{RESEARCH_BRANCH}} &&
      git show origin/{{RESEARCH_BRANCH}}:{{REPORT_PATH}}
    - Protocol: docs/process/AGENT-PROGRAM-PLAYBOOK.md (§5.3 cycle, §5.4
      correctness interrupts, §6 communication budget).

    Main loop — repeat until the tracking table has no Pending row:
    1. Read the control PR DESCRIPTION only (never the comment thread). Select the
       first Pending row; set it to In progress.
    2. Read ONLY that milestone's report section(s) and task prompt from the
       research branch. Create branch program/{{MILESTONE_ID}}-<slug> from current
       origin/main after verifying the previous milestone's merge SHA is present
       (the program/ prefix binds the PR to the convergence gate — it is
       mandatory). Never merge or cherry-pick the research branch.
    3. Implement ONLY the milestone scope; honor its non-goals. Run the repo
       validation checklist (typecheck, lint, full tests, git diff --check) plus
       the milestone's focused tests. Record all evidence at the exact
       implementation SHA; native evidence names device, channel, OTA/update ID,
       and SHA.
    4. Open a DRAFT PR against main titled "[{{PROGRAM_TAG}} {{MILESTONE_ID}}] ..."
       and post the START comment on PR #{{CONTROL_PR}} ("[Execution
       {{MILESTONE_ID}}] IMPLEMENTATION PR" + link) — that comment is the
       reviewers' wake signal. When acceptance evidence is complete: mark ready,
       add the program-milestone label, add the needs-review label (ensure it is
       absent first — re-adding a present label emits no event), set the tracking
       row to In review, and subscribe to the implementation PR. The head SHA at
       this moment is round 1's frozen head.
    5. Review rounds: DO NOT PUSH while a round is open. Wait until BOTH
       reviewers have posted their round summary for the current frozen head
       (changes requested, or their SHA-pinned CONVERGED comment). Then, if
       fixes are needed: remove the needs-review/re-review label, push ONE
       batched push addressing every actionable thread from both reviewers,
       reply to each thread with commit + evidence, and add the re-review label
       to open the next round at the new frozen head. Never resolve a reviewer's
       thread yourself. React to PR events; do not tight-loop poll.
    6. Merge only when the "Dual-review convergence" check is green (it verifies
       both reviewers' CONVERGED comments pin the CURRENT head SHA), all required
       checks pass, and no actionable thread is open. Remove the round and
       converged labels at merge.
    7. Close out: post the MERGED comment on PR #{{CONTROL_PR}} (PR link, merge
       SHA, validation summary, deviations, carried-forward flags); set the
       tracking row to Merged; append the §3 ledger entry to the description;
       unsubscribe from the implementation PR; continue the loop with the next
       Pending row immediately.

    Interrupts and blockers:
    - A user-facing correctness defect, found by anyone at any time, pauses the
      queue: follow the §5.4 protocol before any new milestone.
    - If blocked on something only the human owner can decide, post one concise
      escalation comment on PR #{{CONTROL_PR}} and stop; resume when answered.
    - Comment budget on PR #{{CONTROL_PR}}: two comments per milestone (START,
      MERGED) plus interrupts/escalations. All other discussion lives on the
      implementation PR.

    When the queue is complete, evaluate the report's program exit criterion,
    record the outcome in the report, and hand the control PR to the human owner
    for final merge.

### 7.4 Codex reviewer session (given once, runs the whole program)

    You are the independent Codex reviewer session for the {{PROGRAM_NAME}}
    program. You review every milestone PR in the queue, one at a time, without
    waiting for per-milestone instructions. All program state lives on GitHub: if
    this session restarts or its context is compacted, re-read the control PR
    description and resume with the milestone currently In review.

    Program constants:
    - Control-plane PR: #{{CONTROL_PR}} (DESCRIPTION = tracking table + ledger;
      you never edit it).
    - Research report: git show origin/{{RESEARCH_BRANCH}}:{{REPORT_PATH}}
    - Protocol: docs/process/AGENT-PROGRAM-PLAYBOOK.md.

    Main loop — repeat until the tracking table shows every milestone Merged, or
    the human owner halts the program:
    1. Wait for the next "[Execution <ID>] IMPLEMENTATION PR" comment on
       PR #{{CONTROL_PR}} (subscribe to it; it is low-traffic by design). Ignore
       bot comments (EAS preview, Vercel) silently. If your runtime cannot
       subscribe to events, poll only the control PR, at a long interval.
    2. When the linked implementation PR is ready for review and labeled
       needs-review, load ONLY: the control PR DESCRIPTION, that milestone's
       report section(s), and the PR's diff and threads. Subscribe to the
       implementation PR. Record the frozen head SHA you are reviewing.
    3. Review that frozen head under the stance and non-negotiables below. File
       findings as inline threads; post ONE round summary — either
       "[Codex review <ID>] round <n> at <short sha>: changes requested" or,
       if nothing actionable remains, a standalone comment whose ENTIRE body is
       exactly: "[Codex review <ID>] CONVERGED at <full 40-char head SHA>" —
       nothing else, no footer or signature — plus the codex-converged label.
       The gate accepts only that exact whole-comment format at the current
       head; the label add is what re-triggers it. To withdraw a convergence at
       the same head, edit or delete the marker comment.
    4. The executor is barred from pushing while a round is open, so the head
       you review is stable. If a mid-round push happens anyway, the round is
       void: stop, discard round conclusions, and wait for the re-review label.
    5. On each re-review label, repeat from step 2 at the new frozen head. A
       CONVERGED you posted for an older SHA never carries forward — re-converge
       explicitly at every new head.
    6. After the PR merges, unsubscribe from it and return to step 1.

    Primary stance: implementation-versus-contract. Does the diff satisfy the
    report's Required fix and Acceptance criteria exactly? Hunt concurrency,
    lifecycle, ordering, and cleanup defects around every changed surface —
    including code the diff merely touches. Mindset: correctness first; this is a
    finance app, and a wrong number is worse than a slow screen.

    Non-negotiables:
    - Verify independently. Re-derive every load-bearing claim from the code and
      run the focused tests yourself. Do not accept the PR description, commit
      messages, or the other reviewer's comments as evidence.
    - Check scope: flag anything outside the milestone, even when the extra code
      is good. Scope creep breaks attribution.
    - Check evidence freshness: validation and native evidence must be at the
      current head SHA. Reject stale-head evidence explicitly.
    - File each actionable finding as its own inline review thread. Resolve only
      threads you opened, and only when fixed at a new head.
    - Do not edit the control PR or its description. Post nothing anywhere except
      the implementation PR, unless raising a correctness interrupt (§5.4).

### 7.5 Claude reviewer session (given once, runs the whole program)

    You are the independent Claude reviewer session for the {{PROGRAM_NAME}}
    program. You review every milestone PR in the queue, one at a time, without
    waiting for per-milestone instructions. All program state lives on GitHub: if
    this session restarts or its context is compacted, re-read the control PR
    description and resume with the milestone currently In review.

    Program constants:
    - Control-plane PR: #{{CONTROL_PR}} (DESCRIPTION = tracking table + ledger;
      you never edit it).
    - Research report: git show origin/{{RESEARCH_BRANCH}}:{{REPORT_PATH}}
    - Protocol: docs/process/AGENT-PROGRAM-PLAYBOOK.md.

    Main loop — repeat until the tracking table shows every milestone Merged, or
    the human owner halts the program:
    1. Wait for the next "[Execution <ID>] IMPLEMENTATION PR" comment on
       PR #{{CONTROL_PR}} (subscribe to it; it is low-traffic by design). Ignore
       bot comments (EAS preview, Vercel) silently — re-arm without replying or
       re-reading history.
    2. When the linked implementation PR is ready for review and labeled
       needs-review, load ONLY: the control PR DESCRIPTION, that milestone's
       report section(s), and the PR's diff and threads. Subscribe to the
       implementation PR. Record the frozen head SHA you are reviewing.
    3. Review that frozen head under the stance and non-negotiables below. File
       findings as inline threads; post ONE round summary — either
       "[Claude review <ID>] round <n> at <short sha>: changes requested" or,
       if nothing actionable remains, a standalone comment whose ENTIRE body is
       exactly: "[Claude review <ID>] CONVERGED at <full 40-char head SHA>" —
       nothing else, no footer or signature — plus the claude-converged label.
       The gate accepts only that exact whole-comment format at the current
       head; the label add is what re-triggers it. To withdraw a convergence at
       the same head, edit or delete the marker comment.
    4. The executor is barred from pushing while a round is open, so the head
       you review is stable. If a mid-round push happens anyway, the round is
       void: stop, discard round conclusions, and wait for the re-review label.
    5. On each re-review label, repeat from step 2 at the new frozen head. A
       CONVERGED you posted for an older SHA never carries forward — re-converge
       explicitly at every new head.
    6. After the PR merges, unsubscribe from it and return to step 1.

    Primary stance: adversarial challenge. Attack the diagnosis and the test
    evidence: would these tests fail if the claimed fix were subtly wrong? Is the
    measured improvement attributable to the measured SHA and mechanism, or could
    something else explain it? When requesting changes, propose the smallest
    correct fix. Mindset: correctness first; this is a finance app, and a wrong
    number is worse than a slow screen.

    Non-negotiables:
    - Verify independently. Re-derive every load-bearing claim from the code and
      run the focused tests yourself. Do not accept the PR description, commit
      messages, or the other reviewer's comments as evidence.
    - For any change touching financial computation or its inputs: check the
      golden-equivalence fixtures AND demand garbage-in fixtures (incomplete or
      corrupt underlying data) — equivalence against the old implementation
      preserves upstream bugs by construction.
    - Check evidence freshness: validation and native evidence must be at the
      current head SHA. Reject stale-head evidence explicitly.
    - File each actionable finding as its own inline review thread. Resolve only
      threads you opened, and only when fixed at a new head.
    - Do not edit the control PR or its description. Post nothing anywhere except
      the implementation PR, unless raising a correctness interrupt (§5.4).

### 7.6 Correctness interrupt

    A user-facing correctness defect has been found: {{ONE_LINE_SUMMARY}}.
    Follow the correctness-interrupt protocol in
    docs/process/AGENT-PROGRAM-PLAYBOOK.md §5.4:

    1. Pause the queue: mark the in-flight tracking row Paused; start no new
       milestone until the fix merges.
    2. Post ONE investigation comment on control PR #{{CONTROL_PR}} containing:
       reproduction evidence (real data, exact build/OTA), root cause with
       file:line, provenance (which commits introduced or extended the defect),
       a recommended correction, and an explicit request for [Codex issue review]
       and [Claude issue review] to independently confirm or refute.
    3. Wait for both reviewers to respond once each: confirmed root cause plus
       acceptance criteria, or a concrete counterexample/evidence gap.
    4. Open the fix PR from branch program/{{HOTFIX_ID}}-<slug>, labeled
       program-milestone + correctness-hotfix. The standard dual-review
       convergence gate and frozen-head review rounds apply. If the fix touches
       financial computation or its inputs, include golden-equivalence AND
       garbage-in fixtures.
    5. On merge: ledger entry, tracking rows updated, queue resumes.

## 8. Alternative: stateless per-milestone reviewer dispatch

The default model is the three persistent sessions of §2/§7 — start them once, and
they carry the program. The alternative, if keeping reviewer sessions alive is
undesirable, is stateless per-milestone runs dispatched by GitHub Actions on the
`needs-review` / `re-review` labels:

- **Claude:** `anthropics/claude-code-action` triggered on
  `pull_request: [labeled]` filtered to those labels, with a per-milestone variant
  of the §7.5 prompt (stance + non-negotiables, minus the loop) as the instruction
  body. Requires `ANTHROPIC_API_KEY` in repo secrets.
- **Codex:** `openai/codex-action` on the same trigger with the §7.4 equivalent.
  Requires `OPENAI_API_KEY` in repo secrets.

These are deliberately not committed as live workflows: they need secrets and spend
per-run budget, and enabling them is a human-owner decision. When adding them, have
each workflow remove the `needs-review`/`re-review` label at the end of its run so a
label re-add cleanly re-triggers, and pin each run's context to the §6 loading rules
(description + milestone section + PR) so dispatched runs stay cheap. The trade-off
versus persistent sessions: no idle sessions and a hard per-run context bound, but
each run re-derives review context from scratch and loses cross-milestone memory of
recurring weaknesses.

## 9. Lessons this playbook encodes

1. **Keep the review redundancy; cut the transport.** Two independent reviewers
   repeatedly caught defects one would have missed (#252 idle-queue, #253 lifecycle
   race, #256 tool under-invalidation, #257 diagnosis + pagination tie-breaker).
   The waste was in status commits, bot-comment wakes, and full-history re-reads —
   all transport, all fixed by §3/§6.
2. **Status in the PR description, not in commits.** Docs-only status commits to
   the control branch triggered preview builds and deploy comments on every update,
   waking every subscriber. Description edits are free. As defense in depth, the
   PR Preview workflow also skips tests for docs-only PRs and skips the OTA
   publish for docs-only pushes, and Vercel skips docs-only deploys via
   `ignoreCommand` (exact per-merge on production; a conservative all-docs
   history window on previews) — but the description remains the primary status
   surface.
3. **Mechanical gates beat conventions.** One milestone merged before the final
   convergence marker under time pressure. The per-SHA label gate makes that
   impossible rather than discouraged.
4. **Convergence is per-SHA.** "Converged" on an old head is not converged. The
   gate strips labels on every push; evidence must name the SHA it was collected at.
5. **Equivalence tests preserve upstream bugs.** C1's faulty cache-coverage guard
   passed through a golden-equivalence refactor untouched — by design. Caching over
   financial inputs requires garbage-in fixtures too.
6. **Define program exit up front.** Per-milestone acceptance can all pass while
   the originally reported symptom remains unproven-fixed (the first program never
   reproduced the original hang on-device). The report must state what field
   evidence closes the symptom, and the program is not done until it is evaluated.
7. **Don't trust a build channel's evidence before checking its config parity.**
   The preview channel was missing an env key that silently disabled the data
   lifecycle, confounding every preview-based performance observation until fixed.
8. **One milestone, one PR, sequential.** Shared hot files (`app/_layout.tsx`
   spanned three milestones) make parallel milestones a conflict machine.
   Independent tracks are fine when the report explicitly marks them independent.
9. **Review in frozen-head rounds.** If the executor can push while one reviewer
   is mid-review, that review is invalidated on arrival and the cycle ping-pongs.
   Both reviewers finish at the same frozen head; one batched fix push opens the
   next round.

# Cost and outcome ledger

This document defines a private, local record template and the arithmetic used to attribute
real platform spending (Codex, Claude Code, OpenRouter) and real outcomes to Pappra tasks. It
is a template and a calculation method. It is not a billing daemon, usage parser, dashboard or
automation, and it deliberately introduces no schema version and no second parser: native
usage automation is issue #24 and its design is not settled.

Two files:

- `docs/cost-ledger.md` (this document): fields, calculation rules, worked examples.
- `docs/cost-ledger-template.csv`: the record template, header plus at most two rows, both
  clearly labelled synthetic.

## Non-goals

- No automation, script, parser or collector is added here, and none is implied by it.
- No real account names, invoices, receipts or spending: every number in this document is
  explicitly synthetic.
- No claim that delegated, multi-agent or independent-review work is inherently cheaper more
  sessions can cost more than one, and the ledger exists to show the real number either way.
- No approval, merge or release decision. A complete ledger is evidence, not acceptance.

## Storage and privacy

Raw ledger records are private and local. Keep the working copy outside the repository, for
example a home-directory path such as `~/cost-ledger/2026-07.csv`; only redacted aggregates may
be shared, in a repository, a ticket or a chat. A redacted aggregate must name what it dropped:
at minimum account identifiers, source ids, invoice and receipt references, per-session
timestamps, free-text notes and anything that identifies a person or a vendor contract. Never
request, store or transcribe credentials, API keys, cookies or full invoices, and never publish
a personal invoice. If a figure cannot be shared without an identifying field, share the rule
and the `unknown`, not the row.

## Fields

Use the literal token `unknown` for any field that is not established. Never write `0`, `n/a`
or an empty cell for a value you do not know: an empty cell silently claims "no cost" and
becomes a fabricated total later.

| Field                  | Template column       | Definition                                                                                                                                                                          |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task id                | `task_id`             | The tracked task. It repeats when rework produces additional attempts, one row per attempt.                                                                                         |
| Mode                   | `mode`                | One of `direct`, `delegated`, `independent review`, `managed collaboration`. The mode does not change the arithmetic; it explains the shape of the spend.                            |
| Model and version      | `model`, `model_version` | The model that ran the work and its version when known. `unknown` when the host does not expose it. A model name alone does not establish a price.                                |
| Sessions               | `sessions`            | How many host sessions the row covers. A count, never a cost.                                                                                                                       |
| Amount                 | `amount_usd`, `amount_basis` | The cost in USD. `amount_basis` is `measured` (from a statement, export or reconciled total), `estimated` (derived, with the derivation in the note) or `unavailable` (`amount_usd` is then `unknown`). |
| Source and time        | `amount_source`, `amount_time` | Which export, statement or manual observation the amount came from, and when that source reported it. An amount without a source and a time is not evidence.                     |
| Outcome                | `outcome`             | One of `accepted`, `failed`, `unfinished`. Only an explicit human or coordinator decision makes a task `accepted`; a clean session exit is not acceptance.                          |
| Rework                 | `rework`              | Count of additional attempts spent on the same task id. `0` means the first attempt is the only one.                                                                                |
| Human active minutes   | `human_active_minutes` | Minutes a person actively worked on the row: prompting, reviewing, deciding, cleaning up. Reading a status line is not active work. `unknown` when unmeasured.                      |
| Note                   | `note`                | Short free text. This is the field a redacted aggregate must drop first.                                                                                                            |

## Calculation rules

### 1. Monthly allowance and the unverified accounting convention

The monthly allowance is USD 500 across Codex, Claude Code and OpenRouter. The allowance is a
bound, not an entitlement, a target, or permission to spend.

The company's **actual accounting convention is not established by this document**, so the
remaining balance stays `unknown`. Do not substitute a guessed convention for it. Before any
report states a balance, verify the convention against the user's own totals or exports by
checking:

- whether the monthly figure counts invoiced amounts, consumed amounts or allocated budget;
- whether fixed subscription fees are charged inside or outside the USD 500;
- whether unconsumed top-up balance counts as spent or as remaining;
- whether credits, refunds and promotional balances are netted;
- which per-account export, statement or reconciled total is authoritative;
- the period boundary: calendar month or billing cycle, and in which time zone.

Until those points are verified, any derived balance is `unknown` and is reported as `unknown`.

### 2. Fixed subscriptions and top-ups are never added together

A fixed subscription fee is paid per period regardless of consumption. A top-up is a purchase
of prepaid balance. Consumption drawn from a top-up is already inside that purchase; adding the
consumed amount to it again is a double count. Keep subscriptions separately visible and make
top-ups visibly spent rather than consumed.

```text
expense(period)        = fixed subscription fees in the period
                       + top-up purchases (or prepaid debits) in the period
consumed amount        = allocation basis only, never a second expense
remaining top-up       = purchased − consumed − adjustments (adjustments may be unknown)
```

### 3. Dedupe key

One source entry can arrive twice, for example once from an export and once from a manually
copied row. The dedupe key is **platform + account + period + amount + source id**. Two rows
with the same five values are one entry: keep the first, record the discarded copy in `note`,
and never delete a row silently.

The amount alone does not identify a duplicate. The same amount with a different source id is a
second, real charge; the key decides, not the number.

### 4. Unallocated costs stay unallocated

Some cost cannot be attributed: a shared subscription seat, a top-up partly consumed by
non-Pappra work, a session with no matching task. Report it separately as
`unallocated_usd` and never spread it implicitly over accepted tasks. An allocation is allowed
only when the user states the method explicitly; the method and its inputs are then recorded
next to the aggregate, so a reader can see that the split is a convention rather than a
measurement.

### 5. Cost per accepted task, failed attempts included

```text
cost_per_accepted_task(group)
  = sum(cost of every attempt in the group, succeeded or failed)
    / count(accepted tasks in the group)
```

Failed attempts still cost money, so they belong in the numerator. Only accepted tasks belong in
the denominator; failed and unfinished attempts are not tasks that may be priced per acceptance.
Rework therefore raises the per-accepted-task figure, which is the honest direction.

If any component amount is `unavailable`, the group figure is `unknown`. Do not compute a mean
over the known components only and present it as the group figure: that is a partial number
wearing a complete label. It is fine to report the known rows individually and to state which
component is missing.

### 6. Proposed experiment cap of USD 25

A cap of USD 25 is proposed for one later isolated comparison (issue #34), inside the USD 500
monthly allowance and subject to the remaining budget, which is `unknown` until the convention
in rule 1 is verified.

This cap is a bound, not permission to spend. Recording it changes no permission, stops no task,
authorizes no session, model or provider, and implements no enforcement. This document records
the number and the intent; the decision to spend at or above it stays a human decision.

### 7. Counters are not currency

Token counts, session counts and context occupancy percentages are not dollars. They may be
recorded as diagnostics, and they enter a cost figure only through a priced source with a
recorded time. A high token count with no price is `unknown`, not expensive, and a low one is
not cheap.

### 8. Reading the template

`docs/cost-ledger-template.csv` has one row per attempt: header plus at most two rows, both
synthetic and both marked as such in `note`. Copy the header into a private copy outside the
repository and fill it there. Group figures are computed from those rows with rules 3, 4 and 5;
they are not stored per row.

## Worked examples (synthetic)

Every figure below is invented to demonstrate the arithmetic. Nothing here is a real charge,
account or invoice, and the model named in the rows is the one this cohort used, marked
synthetic.

### Example 1 — mixed subscription and API billing in one month

Proves rule 2 (no subscription/top-up double count) and rule 4 (unallocated stays unallocated).

Input rows, period `2026-07`, all synthetic:

| Source                     | Kind                        | Amount USD |
| -------------------------- | --------------------------- | ---------- |
| Claude Code seat           | fixed subscription fee      | 90.00      |
| OpenRouter top-up purchase | prepaid balance purchase    | 50.00      |
| OpenRouter consumed report | consumption of that top-up  | 31.20      |

Arithmetic, wrong:

```text
90.00 + 50.00 + 31.20 = 171.20
```

That is wrong because `31.20` is drawn from the `50.00` that was already counted, so it is
counted twice.

Arithmetic, right:

```text
expense(2026-07)         = 90.00 + 50.00 = 140.00
consumed (allocation)    = 31.20
remaining top-up balance = 50.00 − 31.20 = 18.80, and still unknown overall
                           because credits and adjustments are unverified
allocated to tasks       = 18.40 + 0.00 + 12.80 = 31.20 over 3 accepted tasks
cost per accepted task   = 31.20 / 3 = 10.40
unallocated_usd          = 90.00, the flat seat with no per-task consumption export
```

Resulting figures: period expense `140.00`; allocated `31.20`, which is `10.40` per accepted
task; `unallocated_usd = 90.00`; remaining balance `unknown`.

Unknown here: whether the seat fee sits inside or outside the USD 500 (rule 1), and whether the
`18.80` residual survives credits and adjustments. Neither is guessed.

### Example 2 — a task whose cost is unavailable

Proves rule 5's unknown rule: a missing component makes the group figure `unknown`.

Input rows, all synthetic:

| Task   | Mode      | Amount USD | Basis       | Reason                                                        |
| ------ | --------- | ---------- | ----------- | ------------------------------------------------------------- |
| T-201  | delegated | unknown    | unavailable | billed under a flat seat with no per-session usage export      |
| T-202  | direct    | 6.00       | measured    | OpenRouter usage export, `2026-07-16T09:30:00+08:00`           |

Arithmetic, wrong:

```text
(0.00 + 6.00) / 2 = 3.00
```

This treats `unavailable` as `0.00` and reports a mean that no source supports.

Arithmetic, right:

```text
T-201 = unknown
group cost_per_accepted_task = unknown
```

What may still be said: `T-202` cost `6.00` for one accepted task, and the group contains two
accepted tasks of which one has unknown cost. The honest group figure is `unknown`.

### Example 3 — a duplicate source entry

Proves rule 3 (dedupe key, not amount, decides).

Input rows, all synthetic:

| Source   | Account        | Period | Amount USD | Source id       | Arrived from        |
| -------- | -------------- | ------ | ---------- | --------------- | ------------------- |
| OpenRouter | acct-synthetic-01 | 2026-07 | 12.80    | export-row-0044 | monthly export      |
| OpenRouter | acct-synthetic-01 | 2026-07 | 12.80    | export-row-0044 | manual copy of above |

Both rows share platform + account + period + amount + source id, so they are one entry.

Arithmetic, wrong:

```text
12.80 + 12.80 = 25.60
```

Arithmetic, right:

```text
distinct entries = 1, so the period total contribution is 12.80
```

Counter-case: a second charge of `12.80` from `export-row-0051` has a different source id, so it
is genuinely a second entry and `12.80 + 12.80 = 25.60` is then correct. The key decides; the
matching amount is not evidence.

### Example 4 — a failed attempt still costs, and raises cost per accepted task

Proves rule 5 with rework, and why failed attempts belong in the numerator.

Input rows, all synthetic, model `deepseek-flash`:

| Task  | Attempt | Outcome  | Amount USD | Basis    | Rework | Human active minutes |
| ----- | ------- | -------- | ---------- | -------- | ------ | -------------------- |
| T-301 | 1       | failed   | 3.60       | measured | 1      | 25                   |
| T-301 | 2       | accepted | 4.10       | measured | 0      | 30                   |
| T-302 | 1       | accepted | 2.30       | measured | 0      | 15                   |

Arithmetic, right:

```text
numerator   = 3.60 + 4.10 + 2.30 = 10.00
denominator = accepted tasks = 2
cost_per_accepted_task = 10.00 / 2 = 5.00
```

Arithmetic, wrong (successful attempts only):

```text
(4.10 + 2.30) / 2 = 3.20
```

Understating by `1.80` per accepted task, exactly the failed attempt's cost, split across the two
accepted tasks. The failed attempt is not free merely because it produced nothing accepted.

If the failed attempt's amount were `unavailable` rather than `3.60`, the group figure would be
`unknown` under rule 5, even though the other two rows are measured.

## Reporting checklist

- Every amount carries a basis, a source and a time; `unknown` never becomes `0`.
- Subscriptions and top-ups are visible separately and never summed with consumed balance.
- Duplicate source entries are collapsed by the dedupe key, with the discarded copy noted.
- Unallocated cost is reported as `unallocated_usd`, never folded into a per-task figure.
- Group figures state their denominator and mark `unknown` when a component is missing.
- A shared aggregate names the identifying fields it dropped.
- No balance is claimed while the accounting convention remains unverified.

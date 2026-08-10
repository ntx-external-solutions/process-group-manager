# Implementation Plan — v1

Companion to **[DESIGN.md](DESIGN.md)**, which holds the API reference and the
evidence behind it. This document is what we build from.

---

## 1. Scope

**In:**

- **Outcome 1** — create group structure from a CSV of group paths.
- **Outcome 2** — apply group shortcuts to existing processes from a CSV.
- Downloadable **templates** and **current-state exports**, so users edit reality
  rather than author it blind.
- Dry run, apply, resumable execution, audit log.
- Web UI for non-technical Promasters, hosted on Vercel.

**Out (v1):**

- Deleting or archiving anything.
- Renaming or **moving** existing groups.
- Re-homing processes between groups.
- Managing stakeholders, permissions, or approval flows.
- SSO / federated auth.

**Guiding constraint:** the operator is non-technical, the tenant has ~1,518
processes and ~92 group trees, and Process Manager has no bulk undo. Every design
choice below leans toward *refusing to act* over *acting ambiguously*.

---

## 2. Architecture — browser-driven, zero server state

The hosting constraints are load-bearing, so they come first:

- **Vercel serverless.** Functions are time-bounded (~60s typical, 300s ceiling). A
  full shortcut run is ~4,500 requests over tens of minutes and **cannot** live in a
  single invocation.
- **No data backend.** Nothing customer-related may be persisted server-side.

Both are satisfied by putting the orchestration in the browser and keeping the server
a stateless proxy.

```
Browser (all state, all logic)                Vercel (stateless)         Nintex PM
──────────────────────────────                ──────────────────         ─────────
CSV parse ─ plan ─ preview
      │
      └─ per-action loop, concurrency 4  ──▶  /api/pm/*  ──────────────▶  api calls
                                              (auth from cookie,
         progress ─ journal ─ report CSV       endpoint allowlist,
                                               forwards + returns)
```

**Why the proxy exists at all:** Process Manager will not send CORS headers for a
Vercel origin, so the browser cannot call it directly. The proxy is a transport shim,
not a service.

**What this buys us:**

| Constraint | How it's met |
|---|---|
| Function timeout | Each call is one PM operation — seconds, not minutes. |
| No data backend | Plan, progress, and journal live in the browser. The server holds nothing between requests. |
| Auditability | The report CSV is generated client-side and downloaded directly. |

**What it costs:** the tab must stay open for the duration of a run. Progress is
checkpointed to `sessionStorage` so an accidental reload resumes rather than restarts;
a closed tab means re-planning, which is safe because the planner diffs (§5.2).

### 2.1 Stack

| Concern | Choice |
|---|---|
| Framework | **Next.js (App Router)** — route handlers are the proxy, React is the UI |
| Language | TypeScript |
| CSV | `papaparse`, running **in the browser** |
| Server state | **None** |
| Client state | React state; `sessionStorage` for run checkpoints only |
| Tests | `node:test` + `undici` MockAgent, fixtures from the real HARs |

### 2.2 Proxy security

The proxy must not become an open relay — anyone could otherwise point our deployment
at arbitrary hosts.

- Tenant and base URL come **from the session cookie**, never from the request body.
- **Endpoint allowlist**: each PM operation is a named route (`/api/pm/groups/create`,
  `/api/pm/process/publish`, …). There is no generic pass-through route.
- Delete endpoints are **not implemented at all** — not merely gated.
- Rate limiting per session, mirroring the client-side concurrency cap.

---

## 3. Authentication

```
POST {baseUrl}/{tenant}/oauth2/token
grant_type=password&username=…&password=…&duration=60000
```

Flow: sign-in form → `POST /api/auth` exchanges credentials with PM → the returned
bearer token is sealed into an **encrypted, `httpOnly`, `Secure`, `SameSite=Strict`
cookie** (AES-GCM via `AUTH_SECRET`), TTL matched to the token's own duration.

- The password is used for **one** outbound call and is never persisted, logged, or
  returned to the client.
- The token never touches `localStorage` or any JS-readable surface — `httpOnly`
  means an XSS bug cannot exfiltrate it.
- No server-side session store, so this remains compatible with "no data backend".

The antiforgery token is the open question: the collection sends
`__RequestVerificationToken` alongside bearer auth, but that may be vestigial from
browser-copied requests. **Spike 0 determines whether bearer alone suffices.** If not,
the proxy fetches and caches it per-request in `src/lib/pm/antiforgery.ts`, so the
ugliness has one home.

---

## 4. CSV formats

### 4.1 Shared path grammar

A **group path** is `|`-separated, root first:

```
Go To Market (Sales and Marketing) | Marketing | Campaigns
```

Normalisation, applied consistently (R7 in DESIGN.md):

| Rule | Behaviour |
|---|---|
| Outer whitespace | Trimmed from each segment before use. |
| Internal whitespace | Runs collapsed to one space **for matching only**. |
| Case | **Insensitive** for matching. |
| Creation | Uses the name **exactly as typed** (after outer trim). |
| `\|` inside a name | **Hard error.** No escaping — we reject rather than guess. |
| Empty segment (`A \|\| B`) | **Hard error.** |
| Duplicate sibling in the CSV | **Hard error.** |
| Ambiguous match in PM | **Hard error**, listing the candidates. |

The trim-for-matching / preserve-for-creation split is deliberate: the tenant already
contains `"Partner Facing "` with a trailing space. We must *match* it without
recreating it, and never silently rename it.

### 4.2 Group structure CSV

One column. Header optional (`Group Path` if present). Each row is a full path.

```csv
Group Path
Top Group
Top Group | Secondary Group
Top Group | Secondary Group | Lower Level Group 1
Top Group | Secondary Group | Lower Level Group 2
```

Intermediate groups are implied — listing only the leaf creates the whole chain.
Row order determines creation order; siblings are created in first-appearance order.

### 4.3 Shortcut CSV

```csv
Process ID,Process Name,Current Group,Shortcut 1,Shortcut 2,Shortcut 3
6a9779c8-…,(draft) PQL via BDR,Partner Manager Day to Day,Legal | Compliance,Finance & IT | Finance,
```

- **`Process ID`** — the process UUID. Authoritative when present.
- **`Process Name`**, **`Current Group`** — informational. Compared against reality;
  a mismatch is a **warning**, not a failure, since names drift.
- **`Shortcut N`** — every column whose header matches `/^Shortcut\s*\d+$/i` is read,
  however many there are. **No fixed limit** (see DESIGN.md). Order is not significant.

**If `Process ID` is absent**, rows resolve by `Process Name` + `Current Group`. Any
name resolving to zero or multiple processes is a hard error naming the candidates —
with 1,518 processes, duplicate names are near-certain and guessing is unacceptable.

### 4.4 Blank vs. clear

Per "the CSV always wins **for any data in the CSV**":

| Row content | Meaning |
|---|---|
| One or more shortcut cells populated | **Replace** the process's shortcuts with exactly that set. |
| All shortcut cells blank | **No data → no change.** The row is a no-op. |
| `CLEAR` alone in `Shortcut 1` | **Remove all shortcuts.** Explicit data, so the CSV wins. |
| Process absent from the CSV | Untouched. |

Blank means "I didn't say", not "delete" — which is what makes a partially-filled
spreadsheet safe. Removing shortcuts stays possible, but only by saying so. Any plan
containing `CLEAR` rows lists them as their own category with its own confirmation.

### 4.5 Where the input file comes from

**Shortcuts — the operator uses Process Manager's own Process List export.** It
already carries `Process Unique Id` for every process, so the workflow is:

1. Export **Process List** from Process Manager (a report they already know).
2. Add `Shortcut 1`, `Shortcut 2`, … columns in Excel.
3. Upload.

The parser accepts that file unmodified: `Process Unique Id` is read as the
identifier, and the report's other nineteen columns are ignored. No intermediate
export step from this tool is needed, and there is no second place for the process
inventory to go stale.

Two details that make it work:

- The report's `Short Cut` column (with a space) is a status flag, **not** shortcut
  data. It must not trip the "misspelled shortcut column" check, or every exported
  file would be rejected.
- The report does **not** list current shortcuts. All 722 rows in a real export read
  `Short Cut: No`, including a process known to have two. So the file describes which
  processes exist, not their current shortcut state — the plan reads that per process.

Because the report omits current shortcuts, an operator editing one row does not
implicitly carry the other rows' state. This is why blank means *no change* (§4.4)
rather than *clear*: with this file as the input, any other reading would wipe
shortcuts across the tenant on the first upload.

**Groups** — still offered as a template (headers plus illustrative rows) and a
current-state export of every existing path, since there is no equivalent report.

### 4.6 Process names cannot identify processes

Measured against a real 623-row extract from the demo tenant:

| Key | Rows that collide |
|---|---|
| Process Name | 308 of 623 (49%) |
| Process Name + Group Name | 89 |
| Process Name + full Group Path | **48** |

`Procure Product or Service` alone appears 15 times. Even a fully-qualified path
leaves 48 ambiguous rows.

This is a property of the tenant's data, not of any particular export, and it is
decisive: **name-based resolution is not viable**. Every uploaded file must carry
`Process ID`, and the shortcut CSV's hard error on ambiguity (§4.3) is correct
behaviour rather than excessive caution.

It also sets a hard requirement on whichever report we build the export from: it must
emit process UUIDs. A report carrying only names cannot round-trip, however convenient
it looks.

> Which Process Manager report to source the export from is still open — see
> [What we still need](#what-we-still-need).

---

## 5. Planning (read-only)

The planner never writes. It is a pure function of (existing state, parsed CSV) →
`Plan`, which is what makes it testable without a tenant. The UI renders that object
and the executor consumes the same one, so the preview is exactly what runs.

### 5.1 Group plan (create-only)

1. Read the existing tree breadth-first via `GetChildProcessGroupTreeItems`, cache it.
2. For each CSV path, walk segment by segment from the root, matching children on
   normalised name.
3. First missing segment and everything below it → `create` actions.
4. **Never** move, rename, or delete. A group existing at a *different* parent is
   reported as informational — full-path matching means it is simply a different node.

```ts
type GroupAction =
  | { kind: 'create'; path: string[]; name: string; parentUniqueId: string | null }
  | { kind: 'exists'; path: string[]; uniqueId: string };
```

Groups present in PM but absent from the CSV are listed under `untouched`.

### 5.2 Shortcut plan (replace)

For each row: resolve the process, resolve every shortcut path to an existing group
UUID (pre-existing, or scheduled for creation in the same run), then diff current
against desired **as a set of group UUIDs**.

| Category | Condition | Treatment |
|---|---|---|
| `unchanged` | sets equal, or row is blank | Skipped — no write, no version bump. |
| `update` | sets differ, desired non-empty | Normal path. |
| `clear` | explicit `CLEAR`, current non-empty | Own category, own confirmation. |
| `blocked` | see §5.3 | Never written; reported with a reason. |

`unchanged` matters more than it looks: it is what makes a re-run a no-op rather than
1,518 pointless republishes.

### 5.3 Write path by process state

Branching on `ProcessRevisionStateId` and `processActions`:

| State | Path |
|---|---|
| **3 — published** | `PUT` (save, minor bump) → publish. If `CanPublishAfterEdit` → `POST …/Publish` directly. Else `PUT DoSubmitForApproval:true` → `POST …/Publish`. |
| **1 — in progress** | Single `PUT`, `DoPublish:false`, no publish. Minor bump only, per the brief. |
| **2 — awaiting approval** | **Blocked. Not touched.** Editing a process mid-approval would disturb someone else's review. |

`SuppressChangeNotification: true` on **every** write.

A process is also `blocked` when `EditPermissions.CanEdit` is false, or when it is
published and the user can neither publish after edit nor approve — the change would
silently queue for approval rather than land.

**Every blocked process is surfaced twice**: as a highlighted count on the preview
*before* the run, and as an explicit row in the report CSV *after* it — with the
reason in plain language (`Awaiting approval — not modified`). Skipped work must never
be something the operator has to go looking for.

---

## 6. Execution (client-side)

### 6.1 Ordering

Groups first, then shortcuts — shortcut targets may be groups created moments earlier.
If a group action fails, shortcut rows depending on it become `blocked`; the rest
proceed.

### 6.2 Per-action semantics

**Group create** — the non-atomic two-step from DESIGN.md R6:

```
ValidateGroupAction(parent, actionType=1)   → abort this action if !isValid or isPrompt
CreateGroup(parent)                         → record returned UUID in the journal FIRST
RenameGroup(uuid, name)
```

Journalling the UUID *before* the rename is what makes an orphaned `"New Group"`
recoverable rather than indistinguishable. Rename is independently retryable.

**Shortcut update** — immediately before writing:

```
GET /bff/Process/api/v1/processes/{uuid}/revisions/latest
```

If `latestProcessRevisionEditId` differs from what we planned against, **skip and
report** — someone edited the process since planning. Otherwise `GET` the full
process, replace `ProcessGroupItems.ProcessGroupShortcut`, and `PUT` the whole
document back, echoing the `ProcessRevisionEditId` just read.

### 6.3 Throughput

The tenant's own config advertises its expectations:

```json
"ResilienceApiCallDelaySec": 3, "ResilienceApiCallAttemptsCount": 5
```

- Client-side concurrency capped (default **4**), configurable.
- Exponential backoff, 5 attempts, honouring `Retry-After`.
- Retries only on 5xx / 429 / network errors — **never** on 4xx, and never on a write
  that may have partially applied.

### 6.4 Journal and resume

An in-memory append-only log, mirrored to `sessionStorage` after each commit:

```jsonl
{"seq":41,"kind":"group.create","path":["Top","Secondary"],"phase":"begin"}
{"seq":41,"kind":"group.create","phase":"commit","uniqueId":"d0ec…"}
{"seq":42,"kind":"group.rename","uniqueId":"d0ec…","name":"Secondary","phase":"commit"}
```

A reload replays the journal, treats committed actions as done, and continues. A
`begin` with no `commit` is the recovery case — for `group.create` that is exactly the
orphaned `"New Group"`, repaired by completing the rename rather than creating a
second group.

`sessionStorage` is scoped to the tab and cleared when it closes. It holds group
paths and process UUIDs, never credentials.

---

## 7. Reporting

Generated client-side and downloaded directly — it never transits our server:

```csv
Type,Target,Action,Result,Before,After,Detail
process,6a9779c8-…,shortcuts.update,ok,2.0,3.0,"2 shortcuts set"
process,b842a208-…,shortcuts.update,skipped,,,"Awaiting approval — not modified"
group,Top | Secondary,create,ok,,d0ec5eca-…,
```

Plus an on-screen summary: counts by outcome, every skipped/blocked row with its
reason, and `clear` rows called out separately.

---

## 8. Web UI

Five screens, deliberately linear:

1. **Sign in** — tenant, username, password.
2. **Choose task** — group structure, or shortcuts. Each offers **Download template**
   and **Download current state** alongside **Upload**.
3. **Upload & validate** — parse errors inline with row and column numbers, in plain
   language (`Row 14: group name contains "|", which is not allowed`).
4. **Preview** — the plan by category with counts: creates, updates, clears
   (visually separated), unchanged, blocked. Apply is disabled until confirmed, with a
   second confirmation if the plan contains clears.
5. **Run** — live progress, a warning banner if the tab is closed mid-run, then the
   report download.

Non-negotiable: **nothing writes before the preview is shown.** There is no
"upload and go" path.

---

## 9. Module layout

```
src/
  lib/pm/            # PM API — pure, injectable fetcher, no Next.js imports
    types.ts         wire types from the HAR payloads
    client.ts        request plumbing, retry/backoff
    antiforgery.ts   token acquisition (pending spike 0)
    groups.ts        tree read, ValidateGroupAction, CreateGroup, RenameGroup
    processes.ts     get, revisions/latest, EditPermissions, PUT, Publish
    permissions.ts   batch permission + viewer-count lookups
  lib/csv/
    path.ts          parse + normalise group paths
    groups.ts        group CSV parse/validate
    shortcuts.ts     shortcut CSV parse/validate (dynamic Shortcut N columns)
    template.ts      template + current-state CSV generation
  lib/plan/
    tree.ts          existing-tree model
    groupPlan.ts     create-only planner
    shortcutPlan.ts  replace planner + write-path selection
  lib/exec/
    journal.ts       append-only log, replay
    runner.ts        concurrency, retry, resume
  app/api/           route handlers (the allowlisted proxy)
  app/(ui)/          screens
```

`lib/pm` and `lib/plan` import nothing from Next.js, so both run identically in tests,
in a route handler, and in the browser.

---

## 10. Testing

- **Unit** — path normalisation against the real dirty names (`"Partner Facing "`,
  duplicate `Operations` siblings); CSV parsing including BOM, CRLF, quoted commas,
  ragged `Shortcut N` columns; both planners against fixture trees.
- **Contract** — request/response fixtures lifted verbatim from the three HARs. In
  particular: the double-serialised `ProcessJson` wrapper, the string-typed
  `ProcessRevisionEditId` on `/Publish`, and the `groupUniqueId`-keyed response from
  `GetUserActionPermissionsByProcesses`.
- **Journal** — interrupt mid-run, replay, assert no duplicate writes and no orphans.
- **Integration** — demo tenant only, dry-run first, then one throwaway process.

---

## 11. Milestones

| # | Deliverable | Proves |
|---|---|---|
| **0** | **Spike** — bearer-auth `GET → PUT → Publish` on one demo process | Headless writes work; settles antiforgery, and whether the submit step is skippable when `CanPublishAfterEdit` |
| 1 | `lib/pm` client + contract tests | Every endpoint exercised against real fixtures |
| 2 | `lib/csv` parse/normalise + templates | Users can get a correct file out before putting one in |
| 3 | `lib/plan` + dry-run CLI | **Point at the live tenant, see a real diff, no writes** |
| 4 | Proxy routes + auth | Deployable to Vercel |
| 5 | Executor + journal + resume | Safe at 1,518 scale |
| 6 | UI + report | Hands it to a non-technical operator |

Milestone 3 is worth reaching fastest — a trustworthy read-only diff against real data
is what tells us the CSV grammar and matching rules survive contact with names like
`"Partner Facing "`, before a single write exists in the codebase.

---

## 12. Assumptions

Stated because they are inferences, not confirmations:

1. **`CanPublishAfterEdit: true` permits `POST …/Publish` without the intermediate
   submit-for-approval `PUT`.** Only submit-then-publish was observed. Spike 0 settles
   it; if false, published processes cost three writes each.
2. **Blank shortcut cells mean "no change", not "clear"** (§4.4), on the reading that
   the CSV wins *for the data it contains*. Clearing requires the explicit `CLEAR`
   keyword.
3. **Group paths match case-insensitively.** PM's own sibling-uniqueness rules are
   unverified; if it permits siblings differing only by case, we report the ambiguity
   rather than pick one.
4. **A run occupies one browser tab.** Acceptable for an occasional bulk operation by
   a single operator; revisit only if runs prove long enough to be impractical.

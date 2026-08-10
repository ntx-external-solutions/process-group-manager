# Implementation Plan — v1

Companion to **[DESIGN.md](DESIGN.md)**, which holds the API reference and the
evidence behind it. This document is what we build from.

---

## 1. Scope

**In:**

- **Outcome 1** — create group structure from a CSV of group paths, and **rename or
  move** existing groups from a CSV that carries their ids (§4.2.1).
- **Outcome 2** — apply group shortcuts to existing processes from a CSV.
- Downloadable **templates** and **current-state exports**, so users edit reality
  rather than author it blind.
- Dry run, apply, resumable execution, audit log.
- Web UI for non-technical Promasters, hosted on Vercel.

**Out (v1):**

- Deleting or archiving anything.
- Re-homing **processes** between groups. (Groups themselves do move — a group takes its
  processes with it, but a process cannot be moved on its own.)
- Ordering siblings within a level. `ReorderTreeNodes` carries `Position`, so this rides
  along for free when we want it; moves currently append.
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
| `\|` inside a name | **Hard error** in the `Group Path` column — no escaping, we reject rather than guess. Legal in the one-column-per-level layout, where `\|` separates nothing (§4.2). |
| Empty segment (`A \|\| B`) | **Hard error.** |
| Duplicate sibling in the CSV | **Hard error.** |
| Ambiguous match in PM | **Hard error**, listing each candidate's id so the row can be pinned with `Group Unique Id` (§4.2). |

The trim-for-matching / preserve-for-creation split is deliberate: the tenant already
contains `"Partner Facing "` with a trailing space. We must *match* it without
recreating it, and never silently rename it.

### 4.2 Group structure CSV

Each row is one group, written as its **full path**. Two layouts are accepted, and the
**header row decides which** — never the widest data row, so a three-cell row in a
one-column file is still caught as commas-where-pipes-were-meant.

**One column per level** — what exports and templates produce:

```csv
Group Unique Id,Level 1,Level 2,Level 3
3f240d01-…,Top Group,,
,Top Group,Secondary Group,
,Top Group,Secondary Group,Lower Level Group 1
,Top Group,Secondary Group,Lower Level Group 2
```

**One `|`-separated column** — the original format, still accepted:

```csv
Group Path
Top Group
Top Group | Secondary Group
```

Level columns are headed `Level N`, or `Group Path` for the leftmost one — so a file
exported in the old single-column shape and then split across columns in Excel
(`Group Path,,`) parses without being re-headed by hand.

Intermediate groups are implied — listing only the leaf creates the whole chain.
Row order determines creation order; siblings are created in first-appearance order.

| Rule | Behaviour |
|---|---|
| Trailing empty level cells | Ignored. Excel pads rows out; the path simply stops. |
| Gap in the middle (`A,,C`) | **Hard error.** This is the outline style, where blank parents mean "same as the row above" — it silently reparents everything below a deleted or sorted row. |
| `\|` inside a level cell | **Warning**, and treated as part of the name. Columns carry the nesting, so `\|` is an ordinary character here — but a half-converted file is the likelier explanation, so we say so. |

#### `Group Unique Id`

Optional column, present in every export. It names **which group a row is**, rather
than trusting the path to pick one out.

| Cell | Meaning |
|---|---|
| Blank | Match by path; create if absent. The original behaviour, and the right one for a row someone typed. |
| An id | *This* group. The name and level columns become the state you want it in — see §4.2.1. |
| Not a valid id | **Hard error** — never silently downgraded to "no id", which is the exact failure the column prevents. |
| Id names a group that does not exist | **Hard error.** Never recreated: it was deleted, or the file is stale. |

Rows are resolved by id **before** anything is matched by name, shallowest first, and a
resolved path is then *pinned*: everything nested below it walks by name as usual. This
is what makes a tenant containing two sibling groups called `Finance` workable at all —
without it the path is unresolvable and every descendant is blocked.

Where **two rows carry different ids for the same path** — which a full export of such a
tenant necessarily contains — both rows are kept and neither pins the path. Re-uploading
an untouched export stays a no-op; nesting anything new under either half requires
deleting the row for the one you do not mean.

Lookup is **by id, straight out of the tree index — never by walking the row's path**.
That is what makes §4.2.1 possible at all: a row asking for a move names a path its
group is not at yet, and walking it would report the group missing and create a second
one. It also means an id-bearing file plans against a **fully loaded tree**: a group's
*current* parent is unknowable without having seen it.

#### 4.2.1 Rename and move

On a row that carries an id, the columns are the **desired state**, not a lookup key:

| What differs | What happens |
|---|---|
| Last name column | **Rename.** `RenameGroup`, keyed by id. |
| Which columns it sits in | **Move.** `ReorderTreeNodes` with `NodeType: "group"` — the group keeps its id, so its processes, shortcuts, stakeholders, and subgroups all travel with it. Publishes nothing, notifies nobody. |
| Both | Both, as two independent actions. |
| Nothing | Nothing. Names compare by the §4.1 matching rules, so drifted case or inner spacing does **not** churn a rename. |

Refused outright, in the preview rather than at write time:

- Moving a group **inside its own subgroup** — it would detach the subtree from the
  tree entirely.
- Two moves that **only form a cycle in combination** (`A` into `B` while `B` goes into
  `A`). Each is legal against the tree as it stands, so the check runs against the
  structure the plan would produce.
- Moving into a **document-only group**.
- Moving into a path that **two groups answer to**. Resolved against the tree, not
  against the create pass's path→id map: that map holds whichever group was seen first,
  which is good enough to attach a new group to and nowhere near good enough to decide
  where an existing one goes.

Execution order is **rename → create → move**. Renames first so a group carries its
intended name before anything is created beside it; creates next, because a move may be
putting a group inside a parent this same run makes; moves last, when both ends exist.

**Visibility.** Permissions are inherited down the tree, so a move changes the audience
for everything inside the group — the one consequence a structure diagram cannot show.
The dry run calls `GetTotalSpecifiedGroupRoleAndUserViewers` for the source and
destination of every move and reports the before/after viewer counts (DESIGN.md R5).
Advisory: if the counts cannot be read, the plan is unaffected and the preview says so.

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

**Shortcuts — Process Manager's Process List export seeds the file; it is not the
file.** Exported with shortcuts included, that report carries everything needed:
`Process Unique Id`, and one row per *placement* so shortcuts are visible.

```
Export Process List (with shortcuts)  →  upload  →  download clean wide-format file,
current shortcuts pre-filled  →  edit in Excel  →  upload  →  preview  →  apply
```

**Why transform rather than edit the report directly.** It is one row per placement,
which makes it a poor upload format:

- Adding a shortcut would mean duplicating a row and editing two path columns, rather
  than filling one cell.
- Repeated UUIDs are normal there, so accepting it would force us to drop the
  duplicate-row check that catches contradictory instructions (§4.3).
- Removing a shortcut would be expressed by *deleting a row* — indistinguishable from
  someone pasting only part of the file.
- Its paths are a different grammar: ` > ` separated, prefixed with the organisation
  name, suffixed with the process name.

The transform (`csv/processList.ts`) folds placements into one record per process and
converts the paths. It is pure, costs no API calls, and is verified against a real
export.

Two details that matter:

- The report's `Short Cut` column (with a space) is a status flag, **not** shortcut
  data. It must not trip the misspelled-shortcut-column check, or every exported file
  would be rejected.
- A shortcut row names its own home in `Source Group Path`, so a process still
  resolves correctly when the export is filtered and its home row is absent.

Stripping the leading organisation segment is the one genuinely ambiguous step: for an
export filtered to a single top-level group, that first segment is a real group. The
transform therefore takes the tenant's actual top-level group names and only strips
what is not one of them, falling back to a flagged assumption if they are unavailable.

Because every generated row arrives carrying its current shortcuts, an untouched row
is a no-op **by construction**. Blank still means *no change* rather than *clear*
(§4.4) so that a hand-made file with sparse columns cannot wipe the tenant, but with a
seeded file the distinction rarely arises.

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

### 5.1 Group plan

1. Read the existing tree via `GetChildProcessGroupTreeItems` — one branch at a time for
   a file of bare paths, in full when any row carries an id (§4.2).
2. Resolve every id-bearing row **by id**, before any name matching. A resolved path is
   then pinned, so rows nested under it walk by name without hitting an ambiguity.
3. For each remaining path, walk segment by segment from the root, matching children on
   normalised name. First missing segment and everything below it → `create` actions.
4. For id-bearing rows, compare the group's actual name and parent against the row's
   columns → `rename` and `move` actions (§4.2.1).
5. **Never delete.** A group absent from the CSV is reported as untouched, never
   removed. A row without an id never moves or renames anything — without an id, a path
   *is* the identity, so "not there" means "create it".

```ts
type GroupAction =
  | { kind: 'create'; path: string[]; name: string; parentUniqueId: string | null }
  | { kind: 'rename'; uniqueId: string; from: string; to: string }
  | { kind: 'move'; uniqueId: string; toParent: CreateParent }
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

1. **Sign in** — tenant, username, password. This *is* the front page; there is no
   marketing screen in front of it. Signing in reveals a browsable copy of the tenant's
   group tree, which doubles as the connection test and as the reference an operator
   checks their spreadsheet against. Branches load when opened, because the API has no
   "give me everything" call.
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

All five are built (`/signin`, `/plan`). Screens 2–5 are one page rather than four:
the plan lives in browser memory and cannot survive a navigation, so splitting them
would mean either re-planning on every step or persisting customer data somewhere.
Both are worse than scrolling. Apply is driven by the same plan object the preview was
drawn from, so the two cannot disagree about what is about to happen.

Two decisions that only became obvious once the screens existed:

- **The file kind is detected, not asked for.** Uploading Process Manager's Process
  List export into the shortcuts task converts it and hands back an editable file,
  rather than rejecting it — that export is the recommended starting point (§4.5), so
  arriving with one is the expected case, not a mistake. Uploading a group file into
  the shortcuts task, or vice versa, is named as such instead of failing deep in a
  parser. See `lib/csv/detect.ts`.
- **The preview is downloadable.** At tenant scale a plan runs to thousands of rows,
  and a page that renders them all is not reviewable. On-screen rows are capped; the
  CSV is the review surface, and the thing you send to whoever has to approve it.
- **The group task previews the resulting tree, not just the create list.** A list of
  paths cannot show that a missing `|` turned a child into a second top-level group,
  which is the mistake this file format invites. The tree is scoped to the branches the
  file touches plus one level of existing siblings — enough to see where a new group
  lands, without burying four additions in ninety untouched groups. Where the tree was
  never loaded that deep, it says so rather than drawing an empty group.
  See `lib/ui/structure.ts`.

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
    groupPlan.ts     create / rename / move planner
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

All six are done. Milestone 3's "point at the live tenant, see a real diff" happens in
the browser rather than a CLI, which is the same proof with one fewer thing to build.

Two things the executor decided that this plan had left open:

- **A write whose outcome is unknown is reconciled, never blindly retried.** For a
  shortcut write the runner re-reads the process and compares it against the file: if
  the interrupted write landed, only the publish remains. For a group create there is
  no such check — a second CreateGroup would leave two indistinguishable orphans, and
  adopting an existing `"New Group"` risks renaming somebody else's — so it reports the
  uniqueId and the exact manual fix instead of guessing.
- **A resumed row is reported as `skipped`, not `ok`.** The tenant ends up correct
  either way, but the report is an audit of *this* run, and a row that says "applied"
  when nothing was sent is worse than no report at all.

Shortcuts pointing at a group the same run is creating are refused rather than
resolved: `CreateGroup` returns a uniqueId but no numeric id, and the write payload
needs both. Apply the group file first, then the shortcut file — which is what the UI
asks for anyway, since the two tasks are separate uploads.

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

# Process Group Manager — v1 Scoping

Bulk management of Nintex Process Manager group structure and per-process group
shortcuts, driven by CSV, for non-technical Promasters.

Status: **scoping**. Nothing built yet.

**Evidence base:** live probes of the Nintex production instance via the
`process-manager` MCP server; two HAR captures from `demo.promapp.com`
(group creation, shortcut edit); the `Promapp_Core` Postman collection; and an
exported process XML. All dated 2026-08-10.

Both v1 outcomes are now **unblocked** — with one genuine gap (group reparenting)
and one unverified path (publishing an already-published process).

---

## Target scale (measured)

| Metric | Value |
|---|---|
| Processes | **1,518** |
| Groups | **92** top-level + nested (depth ≥ 3) |
| Group item types | `group`, `documentgroup`, `suggested-process` |

Scale drives three constraints: long runs (throttling, resumability), org-wide blast
radius (notification suppression is mandatory), and no acceptable "just run it again"
recovery without idempotency.

---

## API reference (confirmed)

Two distinct surfaces, with different conventions:

| Surface | Style | Used for |
|---|---|---|
| `/Api/v1/…` | REST, JSON, bearer-capable | process read/write |
| `/Process/Edit/…`, `/Process/View/…` | ASP.NET MVC, antiforgery token | group CRUD |

### Auth

```http
POST {baseUrl}/{tenant}/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=…&password=…&duration=60000
```

Writes observed in the wild carry **all three** of:

```http
Authorization: Bearer <access_token>
__RequestVerificationToken: <token>
X-Requested-With: XMLHttpRequest
```

✅ **Reads work with the bearer token alone.** Confirmed 2026-08-10 against the demo
tenant through the deployed proxy: `GetChildProcessGroupTreeItems` returned all 15
top-level items with an `Authorization: Bearer` header and **no session cookie and no
antiforgery token**. Nothing needs to be scraped from rendered HTML, and the entire
read/dry-run path is unblocked.

✅ **Writes need no antiforgery token either.** The
[Nintex-Process-Manager-Bulk-Operations](https://github.com/ntx-external-solutions/Nintex-Process-Manager-Bulk-Operations)
PowerShell script performs bulk writes against production tenants, and its
`Invoke-ApiPost` / `Invoke-ApiPut` helpers send exactly:

```http
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
X-Requested-With: XMLHttpRequest
```

`__RequestVerificationToken` appears nowhere in it. The token seen in the HAR
captures is a browser-session artefact, not an API requirement — antiforgery
validation is tied to cookie authentication and does not apply to bearer-authenticated
calls.

**The question is closed.** No token scraping is needed anywhere, for reads or writes,
and `src/lib/pm/antiforgery.ts` is not needed.

A form-login fallback exists (`POST /Login.aspx`). Its payload includes an explicit
`IsSingleSignOnEnabled` field — see R3.

### Groups

Creating a group is a **non-atomic two-step**. There is no "create with name" call:

```http
GET  /Process/Edit/ValidateGroupAction?processGroupUniqueId=<parent-or-empty>&actionType=1
POST /Process/Edit/CreateGroup   {"parentProcessGroupUniqueId":"<parent-uuid-or-empty>"}
     → {"isValid":true,"groupid":"<new-uuid>","groupName":"New Group",…}
POST /Process/Edit/RenameGroup   {"processGroupUniqueId":"<new-uuid>","newName":"Example Group"}
     → {"isValid":true}
```

The server always names the new group `"New Group"` and returns its UUID; the real
name is applied separately. Empty parent = top level. `RenameGroup` accepts JSON or
multipart. Each call commits immediately — **no transaction, no rollback.**

```http
POST /Process/Edit/DeleteGroup?processGroupUniqueId=<uuid>
GET  /Process/View/GetChildProcessGroupTreeItems?uniqueId=<parent-uuid>   # one level; empty = root
GET  /Process/View/GetUserActionPermissionsByGroup?groupId=<numeric>
GET  /Process/ImportExport/ExportProcessGroup?ProcessGroupUniqueId=…&Format=Xml&RecursionLevel=OneLevel
```

`GetUserActionPermissionsByGroup` returns `CanEditProcessGroup`, `CanAddNewSubGroup`,
`CanDeleteProcessGroup`, `CanSort`, `CanManageStakeholders`, … It takes the **numeric**
`groupId` while create/rename/delete take the **UUID**, so the tool must carry both
identifiers per group.

`ValidateGroupAction` returns `{isValid, isCancelled, isPrompt, title, message,
continueLabel, cancelLabel, errorCode}` — a server-driven confirmation gate. See R6.

### Moving & reordering — one endpoint for everything

`POST /Process/Edit/ReorderTreeNodes` → `{"success":true,"errors":[]}`

```json
[{
  "NodeType":              "inprogress-process",
  "ParentUniqueId":        "<new parent group uuid>",
  "OriginalParentUniqueId":"<old parent group uuid>",
  "ChildUniqueId":         "<moved node uuid>",
  "Position":              0,
  "SiblingUniqueId":       null
}]
```

Three things make this the most important endpoint in the project:

**1. It takes an array.** Many moves commit in a single request.

**2. `NodeType` is generic.** The client builds the payload by passing the tree
item's `itemType` straight through, with no branching by type:

```js
ma = (e,t,a) => { const {data:{uniqueId:c, itemType:f}} = e;
  return {changeType: Xi.Reorder,
          payload: [{NodeType:f, ParentUniqueId:a, OriginalParentUniqueId:t,
                     ChildUniqueId:c, Position:-1, SiblingUniqueId:null}]}; }
```

The full node-type enum, lifted from `processGroupPermission.bundle.js`:

```js
documentgroup | group | process | suggested-process
vanillaprocess | inprogress-process | linked-process | embeddedprocess
```

So **`NodeType: "group"` reparents a group through the identical call.** Groups keep
their IDs, and therefore their child processes, permissions, and stakeholders.

**3. `Position` + `SiblingUniqueId` carry ordering** in the same operation.

Pre-flight is `GET /Process/Edit/ValidateProcessAction?processUniqueId=…&actionType=11
&processGroupUniqueId=…&isShortcut=false` (`actionType` is an operation enum — `1`
group create, `11` move, `10`/`11` group-type change).

**Moving a process does not touch its revision.** No `PUT /Api/v1/Processes/…`
accompanied the move in the capture, and no version bump followed. Re-homing
processes is a cheap tree operation — it does **not** republish and does **not**
notify. Only shortcuts require the expensive read-modify-write path.

### Permission model (for pre-flight)

```http
GET /Process/View/GetGroupsAssociatedToCurrentUser
    → [{processGroupId, parentId, uniqueId, isChampion, isProcessEditor,
        isProcessApprover, isProcessPublisher, isDocumentEditor, …}]
GET /Process/View/GetUserActionPermissionsByGroups?groupIds=1&groupIds=2…    # batch
GET /Process/View/GetUserActionPermissionsByProcesses?processIds=1&…          # batch
GET /Process/View/GetTotalSpecifiedGroupRoleAndUserViewers?groupIds=815&groupIds=814
    → [{groupId:815,totalUsers:0,totalRoles:1},{groupId:814,…}]
```

The client's own gating rule:

```js
canManageGroups   = isBA || isPromaster || isChampion
canManageProcesses = canManageGroups || isProcessEditor || isProcessApprover
                                     || isProcessPublisher || isAutomationSpecialist
```

Both permission lookups are **batch** — one call covers the whole plan rather than
1,518 round-trips.

`GetTotalSpecifiedGroupRoleAndUserViewers` is called with *source and destination*
group IDs immediately after a move: it is the built-in visibility-impact check, and
it is exactly what R5 needs.

⚠️ Response quirk: `GetUserActionPermissionsByProcesses` returns its rows keyed
`groupUniqueId` even though the value is a **process** UUID. Code around it.

### Shortcuts live at `ProcessGroupItems`

```json
"ProcessGroupItems": {
  "ProcessGroup":         { "Id": 814, "UniqueId": "d0ec5eca-…", "Name": "New Group" },
  "ProcessGroupShortcut": [
    { "Id": 809, "UniqueId": "7aa7f333-…", "Name": "Patient Management" }
  ]
}
```

A flat array of the same shape as the home group; `null` and `[]` both mean none. The
XML export agrees (repeated `<ProcessGroupShortcut …/>` siblings).

**Nothing in the API suggests a cap on the array length.**

Not to be confused with `ProcessProcedures.ProcessGroupLink` /
`OrphanProcessGroupLink`, which are links drawn *inside* the process map.

### Writing a process — read/modify/write

`PUT /Api/v1/Processes/{uuid}` → `204`. The body is a wrapper whose `ProcessJson` is a
**JSON string**, not an object (sending the object directly returns 500):

```json
{
  "ProcessJson": "<stringified processJson>",
  "ChangeDescription": "Updated Shortcut.",
  "DoSubmitForApproval": false,
  "DoPublish": false,
  "SuppressChangeNotification": false,
  "SharedActivityCollectionEditModel": {"ActivitiesToDelete":[],"ActivitiesToShare":[],"ActivitiesToUnlink":[]},
  "VariantConnectionChangeStates": []
}
```

Setting shortcuts means fetching the whole `processJson`, replacing one array, and
sending the entire document back.

**`ProcessRevisionEditId` is an optimistic-concurrency token.** Echo the value you
read; the server increments it. Observed end to end:

| | `ProcessRevisionEditId` | `Version` | shortcuts |
|---|---|---|---|
| GET before | 9173 | 0.3 | `null` |
| PUT (echoes) | 9173 | — | 1 item |
| GET after | **9174** | **0.4** | 1 item |

A minor version bump on an in-progress process with `DoPublish: false` — exactly the
brief's requirement for in-progress processes.

Two cheap pre-flight endpoints avoid pulling full documents:

```http
GET /bff/Process/api/v1/processes/{uuid}/revisions/latest   → {"latestProcessRevisionEditId":9174}
GET /Api/v1/Processes/{uuid}/EditPermissions                → {"CanEdit":true,…}
```

The first is a concurrency pre-check; the second a permission pre-check. Both should
run before every write.

### Publishing — confirmed end to end

The `DoPublish` wrapper flag is **not** how the UI publishes, and neither is
`PublishProcessRevisionEdit`. The real call is the one that sat in the Postman
collection's "wip requests" folder:

```http
POST /Api/v1/Processes/{uuid}/Publish        → 200
{"ProcessRevisionEditId":"9182","IsPublishNow":true}
     → {"actionUrl":"/{tenant}/Process/{uuid}"}
```

Note `ProcessRevisionEditId` is sent as a **string** here, unlike the integer in
`processJson`.

The full observed lifecycle on an already-published process, with `DoPublish: false`
on every `PUT`:

| Step | Call | `RevEditId` | Version | `RevStateId` |
|---|---|---|---|---|
| start | — | 9180 | **2.0** | 3 published |
| edit | `PUT` `ChangeDescription:"Updated"` | 9181 | 2.1 | 1 in progress |
| submit | `PUT` `DoSubmitForApproval:true` | 9182 | 2.2 | 2 awaiting approval |
| publish | `POST …/Publish` | — | **3.0** | published |

`ProcessRevisionStateId`: **1** = in progress, **2** = awaiting approval,
**3** = published.

So publishing produces the **major version bump** the brief asks for (`2.x → 3.0`),
and the intermediate saves are minor bumps. Confirmed by the exported XML
(`Version="3.0"`) and `ProcessApproval.Published`.

**`SuppressChangeNotification: true` was set on both `PUT`s and the flow completed
normally** — the suppression path in R1 is real and usable.

⚠️ **"Skip approvals" is conditional.** On this process `processActions` reported
`CanPublishAfterEdit: false` and `CanSubmitForApprovalAfterEdit: true` — the user
could *not* publish straight from an edit, and had to route through the
submit-for-approval state first before publishing as an approver. Whether the
submit step can be skipped when `CanPublishAfterEdit` is `true` is **untested**.

Two consequences for the tool:

1. The proven recipe is **three writes per published process** — `PUT` save, `PUT`
   submit, `POST` publish. Across 1,518 processes that is ~4,500 requests, which
   drives the runtime and throttling design.
2. `CanPublishAfterEdit` must be checked per process. Where it is false and the user
   is not an approver, the process **cannot** be silently republished — it will sit
   in an approval queue. Those processes must be reported, not quietly left pending.

### Shortcut payload — multi-value confirmed

The published process carried two shortcuts alongside its home group:

```json
"ProcessGroupShortcut": [
  {"Id":770,"UniqueId":"3f240d01-…","Name":"My Group"},
  {"Id":222,"UniqueId":"3c42fbb0-…","Name":"YourCompany Limited"}
]
```

Only `{Id, UniqueId, Name}` is required. The XML export adds a `ProcessGroupItemId`
per membership row, but that is export metadata — it is absent from the JSON and was
not needed on the write that worked.

---

## Risks

### 🔴 R1 — Notification storm

Republishing at this scale fires a change notification per process to every
stakeholder. Unmitigated, a full run notifies the organisation up to 1,518 times.

`SuppressChangeNotification` exists in the wrapper, and a sampled production process
had `CanSuppressPublishChangeNotification: true`. The shortcut capture sent `false`;
the publish capture sent **`true` on both `PUT`s and completed normally**, so
suppression is confirmed working rather than merely present.

It must be forced on for bulk runs and must not be a checkbox a non-technical user
can casually clear. Any "notify stakeholders" opt-in needs a hard confirmation.

Scope note: this applies to **outcome 2 only**. Group restructuring via
`ReorderTreeNodes` touches no process revision and therefore notifies nobody.

### 🟠 R2 — Headless writes *(largely resolved)*

Earlier field notes claimed raw `PUT`s outside the process editor always return 500
and that only browser-interception worked. **The evidence contradicts that.** The
HAR shows a plain `GET → PUT → 204` with no checkout, lock, or edit-session call, and
the Postman collection drives the same `PUT` with a bearer token. The original 500s
were almost certainly the wrong body format, not a missing session.

Residual unknowns, both cheap to settle in the spike: whether
`__RequestVerificationToken` is required alongside bearer auth, and which of the two
publish paths is correct.

### 🟠 R3 — Auth is ROPC, which breaks under SSO

The token endpoint uses `grant_type=password` — the legacy OAuth Resource Owner
Password Credentials flow. Consequences:

- **It requires the application to handle the user's plaintext password**, which is
  exactly what ROPC is deprecated for in OAuth 2.1.
- **It will not work for SSO/federated users**, who have no local password to submit.
  This is not speculative: the `Login.aspx` payload carries an explicit
  `IsSingleSignOnEnabled` flag, so SSO is a live configuration dimension per tenant.
- A bespoke web page asking for Process Manager credentials also trains Promasters
  to type those credentials into a non-Nintex-branded form.

Mitigation, in preference order: (a) find out whether any non-ROPC grant exists;
(b) have the user paste a token they obtain themselves, so our app never sees the
password; (c) if we must use ROPC, exchange once and never persist the password —
and accept that SSO tenants are out of scope for v1, stated up front rather than
discovered by a customer.

**Question for you: are the target customers on SSO?** If yes, this is a blocker,
not a preference.

### 🟠 R4 — `DeleteGroup` has no server-side guard

`POST /Process/Edit/DeleteGroup?processGroupUniqueId=…` takes no confirmation
parameter. The `ValidateGroupAction` prompt (`isPrompt`, `title`, `message`,
`continueLabel`) is a **client-side** courtesy — the UI asks, the server does not.

A bulk tool calling delete directly gets no safety net. If v1 deletes groups at all,
it must call `ValidateGroupAction` first and surface any prompt, and treat deletion
as a separate, explicitly-confirmed phase — never part of an automatic "make reality
match the CSV" pass.

### 🟢 R5 — Restructuring moves permissions *(mitigation available)*

Groups carry `totalPermissionRoles`, `totalStakeholderUsers`, and `variationSetId`,
and reparenting changes who can see what.

**The product already solves this for us.** `GetTotalSpecifiedGroupRoleAndUserViewers`
takes source and destination group IDs and returns viewer counts for each — the UI
calls it right after every move. The differ should call it for every planned move and
show the before/after viewer delta in the dry run. Downgraded from a risk to a
build task.

### 🟠 R6 — Create-then-rename leaves debris

Any failure between `CreateGroup` and `RenameGroup` strands a group named
`"New Group"`, correctly placed but indistinguishable from a legitimate one.

Not hypothetical: the production instance **already contains a group named
`"New Group"`** (`97824dbf-…`, under *Partner Portal*). A tool doing this hundreds of
times will produce them at a far higher rate.

Mitigation: persist the returned UUID *before* attempting rename, make rename
independently retryable, and ship a "find and clean up abandoned New Group entries"
recovery action.

### 🟡 R7 — Group names are dirty

Real names include a **trailing space** (`"Partner Facing "`) and repeat across
branches (`Operations`, `Compliance`, `Sales Operations`). A path-addressed CSV needs
written-down rules for whitespace normalisation (note: trimming means the path won't
match the existing group — trim-on-compare and preserve-on-create are different
decisions), case sensitivity, sibling collisions, and rejection of the `|` delimiter
inside names.

### 🟢 R8 — Ordering *(resolved)*

`ReorderTreeNodes` carries `Position` and `SiblingUniqueId`, so ordering rides along
with the move — no separate mechanism, no extra call. CSV row order can map directly
to `Position`. Sorting a whole branch is one array of nodes with sequential
positions.

---

## Answers to your questions

### Should we expand past five shortcuts per process?

**Don't encode a limit in the file format at all.** `ProcessGroupShortcut` is a plain
array with no cap visible anywhere in the API. A five-column schema bakes in an
arbitrary number and makes raising it a breaking change to every CSV customers have
already built.

Keep the Excel-friendly wide layout, but parse *every* column matching `Shortcut N`:

```csv
Process ID,Process Name,Shortcut 1,Shortcut 2,Shortcut 3
6a9779c8-…,(draft) PQL via BDR,Legal | Compliance,Finance & IT | Finance,
```

Enforce whatever limit the UI turns out to impose as a validation error, discovered at
runtime. Then we never have to reissue the format.

### Postman collection, or walk the APIs one by one?

Neither, now — between the two HARs and the collection, the only thing still worth a
live walkthrough is **group reparenting**, and that's a HAR, not a conversation.

---

## Decisions — settled 2026-08-10

| # | Decision | Consequence |
|---|---|---|
| SSO | **Not required.** | ROPC (`grant_type=password`) is viable. R3 downgraded — we still never persist the password, only the exchanged token. |
| Deletion | **Nothing is ever deleted by the service.** Handled manually; revisit later. | No delete endpoint is wired at all in v1. R4 is neutralised by omission. Groups present in PM but absent from the CSV are reported, never touched. |
| Shortcut semantics | **The CSV always wins** — authoritative replace. | Desired set replaces current set. See the clearing safeguard in the plan: a row that clears all shortcuts is a *separate, highlighted* category in the dry run, never a silent side effect. Processes absent from the CSV are untouched. |
| Process re-homing | **Out of scope.** | A process cannot be moved on its own. A *group* can, and takes its processes with it. |
| Group re-homing | **Shipped**, gated on the row carrying a `Group Unique Id`. | `ReorderTreeNodes` with `NodeType: "group"`. The group keeps its id, so processes, shortcuts, permissions, and subgroups follow it; no process revision is touched, so nothing republishes and nobody is notified. Cycles, document-group destinations, and ambiguous destinations are refused in the preview. R5 is mitigated as designed — `GetTotalSpecifiedGroupRoleAndUserViewers` runs for both ends of every move and the viewer delta is shown before applying. See PLAN.md §4.2.1. |

Implementation detail lives in **[PLAN.md](PLAN.md)**.

## Decisions previously needed

The brief says outcome 1 "creates the folder structure" and stops. Creating groups is
the easy part:

1. ~~**What happens to groups not listed in the CSV?**~~ **Resolved — leave.** Nothing
   is deleted by the service. Untouched groups are reported for manual handling.
2. ~~**Does the CSV *move* existing groups, or *create* new ones?**~~ **Resolved —
   move.** `ReorderTreeNodes` with `NodeType: "group"` reparents in place, preserving
   group IDs and everything hanging off them. The differ should therefore
   *match-and-move* wherever a group already exists and only create genuinely new
   ones. This is strictly better than create-new + re-home and removes the biggest
   scope risk in the brief.
3. ~~**How do processes get re-homed?**~~ **Mechanism resolved** — same endpoint,
   `NodeType: "process"` / `"inprogress-process"`, and it costs no version bump.
   Still a product question: is process re-homing in scope for v1, and does it come
   from a third CSV or fall out of the group mapping?
4. ~~**Are shortcuts authoritative or additive?**~~ **Resolved — authoritative
   replace.** A blank row therefore clears; that case is isolated as its own
   confirmed category rather than allowed to happen silently
   ([PLAN.md §5.2](PLAN.md)).
5. ~~**Idempotency.**~~ **Resolved by design** — the planner diffs, so matching
   state produces an empty plan and a re-run is a no-op
   ([PLAN.md §5.2](PLAN.md), §6.4).

## Non-negotiables for v1

- **Dry run by default.** Full diff, explicit second action to apply. There is no bulk
  undo in Process Manager.
- **Pre-flight everything.** Resolve every group path and process ID; check
  `EditPermissions` and `GetUserActionPermissionsByGroup` *before* the first write.
- **Concurrency check.** Compare `revisions/latest` immediately before each write and
  skip anything that moved under us.
- **Resumable.** A 1,518-process run will be interrupted. Checkpoint and resume.
- **Per-process audit log**, exportable as CSV: what changed, old/new version, failures.

---

## What we still need

**The API surface is now fully mapped.** No further captures are required to start
building. What remains is product decisions and one environmental question.

1. **Are the target customers on SSO?** (R3) The only remaining question that could
   force a rethink rather than a design choice.
2. **Answers to [Decisions needed](#decisions-needed)** — #1 (delete policy),
   #3 (is process re-homing in v1?), #4 (replace vs merge), #5 (idempotency).
3. **Does the running user hold publish rights on the target groups?** Where
   `CanPublishAfterEdit` is false and they are not an approver, those processes
   cannot be republished silently — they will queue for approval. Worth knowing
   before we design the failure reporting.

Two cheap confirmations to fold into the spike rather than request separately:
that `NodeType: "group"` reparents as the bundle implies (the code has no
type-specific branching), and whether the submit-for-approval step can be skipped
when `CanPublishAfterEdit` is `true` — which would cut outcome 2's write volume by
a third.

---

## Suggested sequence

| # | Step | Status |
|---|---|---|
| 0 | Spike: bearer-auth `GET → PUT → Publish` + one `NodeType:"group"` move | ready |
| 1 | CSV grammar + normalisation rules | ready |
| 2 | Tree reader + read-only differ (no writes) | ready |
| 3 | Group executor: create/rename + **match-and-move** via `ReorderTreeNodes` | ready |
| 4 | Visibility-impact preview in the dry run | ready |
| 5 | Shortcut executor: save / submit / publish branching per `processActions` | ready |
| 6 | Resumability, checkpointing, audit log | ready |
| 7 | Resolve SSO / auth approach | needs answer |
| 8 | Web UI over the above | — |

Everything except the auth approach is unblocked. Step 7 is the only item that can
still change the design rather than just the schedule.

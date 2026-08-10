/**
 * The proxy's operation allowlist.
 *
 * Process Manager will not send CORS headers for our origin, so the browser cannot
 * call it directly and everything goes through a server route. That route must not
 * become an open relay: there is no generic pass-through, no caller-supplied URL, and
 * the tenant always comes from the session cookie. The browser can only name one of
 * the operations below.
 *
 * `process.setShortcuts` deliberately does the whole read-modify-write here rather
 * than accepting a process document from the browser. That makes "this tool can only
 * change shortcuts" a structural property of the proxy instead of a promise about
 * client-side code, and it keeps full process documents off the wire.
 */

import type { PmContext } from './client.ts';
import {
  createGroup,
  getChildGroups,
  getGroupPermissions,
  getGroupViewerCounts,
  renameGroup,
  validateGroupAction,
} from './groups.ts';
import {
  buildUpdateEnvelope,
  currentShortcuts,
  exportProcessListCsv,
  getLatestRevision,
  getProcess,
  listProcesses,
  publishProcess,
  updateProcess,
  withShortcuts,
} from './processes.ts';
import type { ProcessGroupRef, ProcessRevisionStateId } from './types.ts';

export type Operation =
  | { op: 'groups.tree'; parentUniqueId: string | null }
  | { op: 'groups.validateCreate'; parentUniqueId: string | null }
  | { op: 'groups.create'; parentUniqueId: string | null }
  | { op: 'groups.rename'; uniqueId: string; name: string }
  | { op: 'groups.permissions'; groupIds: number[] }
  | { op: 'groups.viewers'; groupIds: number[] }
  | { op: 'process.summary'; processUniqueId: string }
  | {
      op: 'process.setShortcuts';
      processUniqueId: string;
      shortcuts: ProcessGroupRef[];
      changeDescription: string;
      /** Revision the plan was built against. Mismatch aborts the write. */
      expectedRevisionEditId: number;
      submitForApproval: boolean;
    }
  | { op: 'process.publish'; processUniqueId: string; processRevisionEditId: number }
  | { op: 'processes.list'; page: number; listType: number }
  | { op: 'processes.exportCsv' };

export type OperationName = Operation['op'];

export const OPERATION_NAMES: readonly OperationName[] = [
  'groups.tree',
  'groups.validateCreate',
  'groups.create',
  'groups.rename',
  'groups.permissions',
  'groups.viewers',
  'process.summary',
  'process.setShortcuts',
  'process.publish',
  'processes.list',
  'processes.exportCsv',
];

/**
 * Compact view of a process — everything the planner needs and nothing else.
 * Returning this instead of the full document keeps ~1,518 process bodies off the
 * wire and out of the browser.
 */
export interface ProcessSummary {
  uniqueId: string;
  name: string;
  version: string;
  revisionEditId: number;
  revisionStateId: ProcessRevisionStateId;
  homeGroupUniqueId: string;
  homeGroupName: string;
  currentShortcuts: ProcessGroupRef[];
  canEdit: boolean;
  canSave: boolean;
  canPublishAfterEdit: boolean;
  canSubmitForApprovalAfterEdit: boolean;
}

export interface SetShortcutsResult {
  ok: boolean;
  /** Present on success — needed to publish. */
  revisionEditId?: number;
  /** Set when the process moved under us since planning. */
  conflict?: { expected: number; actual: number };
}

export async function execute(ctx: PmContext, operation: Operation): Promise<unknown> {
  switch (operation.op) {
    case 'groups.tree':
      return getChildGroups(ctx, operation.parentUniqueId);

    case 'groups.validateCreate':
      return validateGroupAction(ctx, operation.parentUniqueId);

    case 'groups.create':
      return createGroup(ctx, operation.parentUniqueId);

    case 'groups.rename':
      return renameGroup(ctx, operation.uniqueId, operation.name);

    case 'groups.permissions':
      return getGroupPermissions(ctx, operation.groupIds);

    case 'groups.viewers':
      return getGroupViewerCounts(ctx, operation.groupIds);

    case 'process.summary':
      return summarise(ctx, operation.processUniqueId);

    case 'process.setShortcuts':
      return setShortcuts(ctx, operation);

    case 'process.publish':
      return publishProcess(ctx, operation.processUniqueId, operation.processRevisionEditId);

    case 'processes.list':
      return listProcesses(ctx, operation.page, undefined, operation.listType);

    case 'processes.exportCsv':
      return { csv: await exportProcessListCsv(ctx) };
  }
}

async function summarise(ctx: PmContext, processUniqueId: string): Promise<ProcessSummary> {
  const { processJson, processActions } = await getProcess(ctx, processUniqueId);
  return {
    uniqueId: processJson.UniqueId,
    name: processJson.Name,
    version: processJson.Version,
    revisionEditId: processJson.ProcessRevisionEditId,
    revisionStateId: processJson.ProcessRevisionStateId,
    homeGroupUniqueId: processJson.ProcessGroupItems.ProcessGroup.UniqueId,
    homeGroupName: processJson.ProcessGroupItems.ProcessGroup.Name,
    currentShortcuts: currentShortcuts(processJson),
    // CanSave is the operative permission for what this tool does. EditPermissions
    // exposes a separate CanEdit, but asking for it would double the cost of
    // planning across the whole tenant for no decision we actually make differently.
    canEdit: processActions.CanSave === true,
    canSave: processActions.CanSave === true,
    canPublishAfterEdit: processActions.CanPublishAfterEdit === true,
    canSubmitForApprovalAfterEdit: processActions.CanSubmitForApprovalAfterEdit === true,
  };
}

async function setShortcuts(
  ctx: PmContext,
  operation: Extract<Operation, { op: 'process.setShortcuts' }>,
): Promise<SetShortcutsResult> {
  const { processJson } = await getProcess(ctx, operation.processUniqueId);

  if (processJson.ProcessRevisionEditId !== operation.expectedRevisionEditId) {
    // Someone edited the process between planning and now. Writing would silently
    // discard their change, so stop and report instead.
    return {
      ok: false,
      conflict: {
        expected: operation.expectedRevisionEditId,
        actual: processJson.ProcessRevisionEditId,
      },
    };
  }

  const updated = withShortcuts(processJson, operation.shortcuts);
  await updateProcess(
    ctx,
    operation.processUniqueId,
    buildUpdateEnvelope(updated, {
      changeDescription: operation.changeDescription,
      submitForApproval: operation.submitForApproval,
      // Never negotiable for a bulk run.
      suppressChangeNotification: true,
    }),
  );

  // The server increments on write; publishing needs the new value.
  const latest = await getLatestRevision(ctx, operation.processUniqueId);
  return { ok: true, revisionEditId: latest.latestProcessRevisionEditId };
}

// ------------------------------------------------------------------ parsing

export type ParseResult =
  | { ok: true; operation: Operation }
  | { ok: false; error: string };

/**
 * Validate a request body from the browser.
 *
 * Everything crossing this boundary is untrusted, so each field is checked rather
 * than cast. An unrecognised `op` is rejected outright — that is what makes this an
 * allowlist rather than a suggestion.
 */
export function parseOperation(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Request body must be an object.' };
  }
  const body = input as Record<string, unknown>;
  const op = body['op'];
  if (typeof op !== 'string') return { ok: false, error: 'Missing "op".' };

  switch (op) {
    case 'groups.tree':
    case 'groups.validateCreate':
    case 'groups.create': {
      const parentUniqueId = nullableString(body['parentUniqueId']);
      if (parentUniqueId === undefined) {
        return { ok: false, error: `${op}: "parentUniqueId" must be a string or null.` };
      }
      return { ok: true, operation: { op, parentUniqueId } as Operation };
    }

    case 'groups.rename': {
      const uniqueId = requiredString(body['uniqueId']);
      const name = requiredString(body['name']);
      if (!uniqueId) return { ok: false, error: 'groups.rename: "uniqueId" is required.' };
      if (!name) return { ok: false, error: 'groups.rename: "name" is required.' };
      return { ok: true, operation: { op, uniqueId, name } };
    }

    case 'groups.permissions':
    case 'groups.viewers': {
      const groupIds = numberArray(body['groupIds']);
      if (!groupIds) return { ok: false, error: `${op}: "groupIds" must be an array of numbers.` };
      return { ok: true, operation: { op, groupIds } as Operation };
    }

    case 'process.summary': {
      const processUniqueId = requiredString(body['processUniqueId']);
      if (!processUniqueId) {
        return { ok: false, error: 'process.summary: "processUniqueId" is required.' };
      }
      return { ok: true, operation: { op, processUniqueId } };
    }

    case 'process.setShortcuts': {
      const processUniqueId = requiredString(body['processUniqueId']);
      const changeDescription = requiredString(body['changeDescription']);
      const expectedRevisionEditId = body['expectedRevisionEditId'];
      const shortcuts = groupRefArray(body['shortcuts']);

      if (!processUniqueId) {
        return { ok: false, error: 'process.setShortcuts: "processUniqueId" is required.' };
      }
      if (!changeDescription) {
        return { ok: false, error: 'process.setShortcuts: "changeDescription" is required.' };
      }
      if (typeof expectedRevisionEditId !== 'number') {
        return {
          ok: false,
          error: 'process.setShortcuts: "expectedRevisionEditId" must be a number.',
        };
      }
      if (!shortcuts) {
        return { ok: false, error: 'process.setShortcuts: "shortcuts" is malformed.' };
      }

      return {
        ok: true,
        operation: {
          op,
          processUniqueId,
          shortcuts,
          changeDescription,
          expectedRevisionEditId,
          submitForApproval: body['submitForApproval'] === true,
        },
      };
    }

    case 'processes.exportCsv':
      return { ok: true, operation: { op } };

    case 'processes.list': {
      const page = body['page'];
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
        return { ok: false, error: 'processes.list: "page" must be a positive integer.' };
      }
      const listType = body['listType'];
      if (listType !== undefined && typeof listType !== 'number') {
        return { ok: false, error: 'processes.list: "listType" must be a number.' };
      }
      return { ok: true, operation: { op, page, listType: (listType as number) ?? 0 } };
    }

    case 'process.publish': {
      const processUniqueId = requiredString(body['processUniqueId']);
      const processRevisionEditId = body['processRevisionEditId'];
      if (!processUniqueId) {
        return { ok: false, error: 'process.publish: "processUniqueId" is required.' };
      }
      if (typeof processRevisionEditId !== 'number') {
        return { ok: false, error: 'process.publish: "processRevisionEditId" must be a number.' };
      }
      return { ok: true, operation: { op, processUniqueId, processRevisionEditId } };
    }

    default:
      return { ok: false, error: `Unknown operation "${op}".` };
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Returns undefined for "invalid", distinct from a legitimate null. */
function nullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return value as number[];
}

function groupRefArray(value: unknown): ProcessGroupRef[] | null {
  if (!Array.isArray(value)) return null;
  const out: ProcessGroupRef[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const ref = entry as Record<string, unknown>;
    if (
      typeof ref['Id'] !== 'number' ||
      typeof ref['UniqueId'] !== 'string' ||
      typeof ref['Name'] !== 'string'
    ) {
      return null;
    }
    // Rebuilt field by field so nothing else from the request reaches the payload.
    out.push({ Id: ref['Id'], UniqueId: ref['UniqueId'], Name: ref['Name'] });
  }
  return out;
}

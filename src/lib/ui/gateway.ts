/**
 * The browser's half of the proxy.
 *
 * Everything the UI does against Process Manager goes through here, which keeps the
 * fetch plumbing — and, more importantly, the handling of a dead session — in one
 * place. Long runs outlive their token, so "signed out" is a normal outcome of any
 * call, not an exception.
 */

import type { ExecGateway, SetShortcutsOutput } from '../exec/runner.ts';
import type { GroupViewerCount, ReorderResponse } from '../pm/groups.ts';
import type { PlanGateway } from '../plan/orchestrate.ts';
import type { Operation, ProcessSummary } from '../pm/operations.ts';
import type {
  ChildTreeItemsResponse,
  CreateGroupResponse,
  ValidateActionResponse,
} from '../pm/types.ts';

export class PmRequestError extends Error {
  /** The session is gone. Stop the run and send them back to sign in. */
  readonly signedOut: boolean;
  /** The tenant's own response, when there was one. */
  readonly detail: string | null;

  constructor(message: string, options: { signedOut?: boolean; detail?: string | null } = {}) {
    super(message);
    this.name = 'PmRequestError';
    this.signedOut = options.signedOut ?? false;
    this.detail = options.detail ?? null;
  }
}

interface ProxyResponse {
  ok?: boolean;
  result?: unknown;
  error?: string;
  detail?: string;
  signedOut?: boolean;
}

export async function callPm<T>(operation: Operation): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/pm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation),
    });
  } catch {
    // Offline, or the tab lost the network mid-run. Not a Process Manager problem.
    throw new PmRequestError('Could not reach the server.');
  }

  const payload = (await response.json().catch(() => ({}))) as ProxyResponse;

  if (!response.ok) {
    throw new PmRequestError(payload.error ?? `Request failed (${response.status}).`, {
      signedOut: payload.signedOut === true,
      detail: payload.detail ?? null,
    });
  }

  return payload.result as T;
}

/** The reads the planners need, over the proxy. */
export function browserGateway(): PlanGateway {
  return {
    groupsTree: (parentUniqueId) =>
      callPm<ChildTreeItemsResponse>({ op: 'groups.tree', parentUniqueId }),
    processSummary: (processUniqueId) =>
      callPm<ProcessSummary>({ op: 'process.summary', processUniqueId }),
    groupViewers: (groupIds) => callPm<GroupViewerCount[]>({ op: 'groups.viewers', groupIds }),
  };
}

/**
 * The writes, over the same proxy.
 *
 * Every one of these is an allowlisted operation — the browser names an operation, not
 * a URL, so this object cannot reach anything the proxy does not already permit.
 */
export function browserExecGateway(): ExecGateway {
  return {
    validateGroupAction: (parentUniqueId) =>
      callPm<ValidateActionResponse>({ op: 'groups.validateCreate', parentUniqueId }),
    createGroup: (parentUniqueId) =>
      callPm<CreateGroupResponse>({ op: 'groups.create', parentUniqueId }),
    renameGroup: (uniqueId, name) => callPm<{ isValid: boolean }>({ op: 'groups.rename', uniqueId, name }),
    moveGroup: (uniqueId, newParentUniqueId, oldParentUniqueId) =>
      callPm<ReorderResponse>({
        op: 'groups.move',
        uniqueId,
        newParentUniqueId,
        oldParentUniqueId,
      }),
    setShortcuts: (input) =>
      callPm<SetShortcutsOutput>({
        op: 'process.setShortcuts',
        processUniqueId: input.processUniqueId,
        shortcuts: input.shortcuts,
        changeDescription: input.changeDescription,
        expectedRevisionEditId: input.expectedRevisionEditId,
        submitForApproval: input.submitForApproval,
      }),
    publish: (processUniqueId, processRevisionEditId) =>
      callPm({ op: 'process.publish', processUniqueId, processRevisionEditId }),
    processSummary: (processUniqueId) => callPm<ProcessSummary>({ op: 'process.summary', processUniqueId }),
    childGroups: async (parentUniqueId) => {
      const response = await callPm<ChildTreeItemsResponse>({ op: 'groups.tree', parentUniqueId });
      return (response.treeItems ?? []).filter(
        (item) => item.itemType === 'group' || item.itemType === 'documentgroup',
      );
    },
  };
}

/**
 * Titles of the tenant's top-level groups.
 *
 * Needed to read a Process List export correctly: without them the leading path
 * segment has to be *assumed* to be the organisation name (see csv/processList.ts).
 */
export async function topLevelGroupTitles(): Promise<string[]> {
  const response = await callPm<ChildTreeItemsResponse>({ op: 'groups.tree', parentUniqueId: null });
  return (response.treeItems ?? [])
    .filter((item) => item.itemType === 'group' || item.itemType === 'documentgroup')
    .map((item) => item.title);
}

// -------------------------------------------------------------- session

export interface SessionInfo {
  tenant: string;
  username: string;
  expiresAt: number;
}

/**
 * Who, if anyone, is signed in.
 *
 * The session cookie is httpOnly, so the page cannot read it and has to ask. Returns
 * null rather than throwing: "not signed in" is an answer, not a failure.
 */
export async function currentSession(): Promise<SessionInfo | null> {
  try {
    const response = await fetch('/api/auth', { method: 'GET' });
    if (!response.ok) return null;
    const payload = (await response.json()) as { signedIn?: boolean } & Partial<SessionInfo>;
    if (payload.signedIn !== true) return null;
    return {
      tenant: payload.tenant ?? '',
      username: payload.username ?? '',
      expiresAt: payload.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}

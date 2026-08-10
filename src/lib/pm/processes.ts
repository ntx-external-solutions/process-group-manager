/**
 * Process read/write endpoints.
 *
 * The write path is the sharp end of this tool: it republishes live processes that
 * other people depend on. Two rules are enforced here rather than left to callers.
 *
 *  1. `ProcessJson` in the PUT body is a JSON *string*, not an object. Sending the
 *     object returns HTTP 500.
 *  2. `SuppressChangeNotification` defaults to true. A bulk run across ~1,518
 *     processes would otherwise notify every stakeholder once per process.
 */

import { pmRequest, type PmContext } from './client.ts';
import type {
  LatestRevisionResponse,
  ProcessGroupRef,
  ProcessJson,
  ProcessResponse,
  ProcessUpdateEnvelope,
  PublishRequest,
} from './types.ts';

/** Subset of /EditPermissions we act on. */
export interface EditPermissions {
  CanEdit: boolean;
  IsArchived: boolean;
  ProcessName: string;
  [key: string]: unknown;
}

export function getProcess(ctx: PmContext, processUniqueId: string): Promise<ProcessResponse> {
  return pmRequest<ProcessResponse>(ctx, { path: `/Api/v1/Processes/${processUniqueId}` });
}

export function getEditPermissions(
  ctx: PmContext,
  processUniqueId: string,
): Promise<EditPermissions> {
  return pmRequest<EditPermissions>(ctx, {
    path: `/Api/v1/Processes/${processUniqueId}/EditPermissions`,
  });
}

/**
 * Cheap concurrency pre-check — a few bytes instead of a whole process document.
 * Call immediately before writing and compare against the value you planned against.
 */
export function getLatestRevision(
  ctx: PmContext,
  processUniqueId: string,
): Promise<LatestRevisionResponse> {
  return pmRequest<LatestRevisionResponse>(ctx, {
    path: `/bff/Process/api/v1/processes/${processUniqueId}/revisions/latest`,
  });
}

export interface UpdateOptions {
  changeDescription: string;
  submitForApproval?: boolean;
  /**
   * Left false in normal use. The observed UI never publishes via this flag — it
   * saves, then calls the separate Publish endpoint.
   */
  publish?: boolean;
  /** Opt out only with an explicit, confirmed decision. */
  suppressChangeNotification?: boolean;
}

/**
 * Build the PUT envelope.
 *
 * Exported separately from the request so the exact bytes can be asserted in tests
 * and shown in a dry run without anything being sent.
 */
export function buildUpdateEnvelope(
  processJson: ProcessJson,
  options: UpdateOptions,
): ProcessUpdateEnvelope {
  return {
    // Double-serialised: the server rejects a plain object with a 500.
    ProcessJson: JSON.stringify(processJson),
    ChangeDescription: options.changeDescription,
    DoSubmitForApproval: options.submitForApproval ?? false,
    DoPublish: options.publish ?? false,
    SuppressChangeNotification: options.suppressChangeNotification ?? true,
    SharedActivityCollectionEditModel: {
      ActivitiesToDelete: [],
      ActivitiesToShare: [],
      ActivitiesToUnlink: [],
    },
    VariantConnectionChangeStates: [],
  };
}

/** Returns 204 with no body on success. */
export function updateProcess(
  ctx: PmContext,
  processUniqueId: string,
  envelope: ProcessUpdateEnvelope,
): Promise<void> {
  return pmRequest<void>(ctx, {
    path: `/Api/v1/Processes/${processUniqueId}`,
    method: 'PUT',
    body: envelope,
    retry: 'write',
  });
}

export interface PublishResponse {
  actionUrl: string;
}

/**
 * Publish, producing the major version bump (2.x -> 3.0).
 *
 * Note the revision id is sent as a *string* here, unlike the number carried in
 * processJson. That asymmetry is the server's, and it is load-bearing.
 */
export function publishProcess(
  ctx: PmContext,
  processUniqueId: string,
  processRevisionEditId: number,
): Promise<PublishResponse> {
  const body: PublishRequest = {
    ProcessRevisionEditId: String(processRevisionEditId),
    IsPublishNow: true,
  };
  return pmRequest<PublishResponse>(ctx, {
    path: `/Api/v1/Processes/${processUniqueId}/Publish`,
    method: 'POST',
    body,
    retry: 'write',
  });
}

/**
 * Return a copy of the process with its shortcut list replaced.
 *
 * Copies rather than mutates: the caller keeps the original to compare against, and
 * an aborted run must not leave a half-edited document in memory.
 */
export function withShortcuts(
  processJson: ProcessJson,
  shortcuts: readonly ProcessGroupRef[],
): ProcessJson {
  return {
    ...processJson,
    ProcessGroupItems: {
      ...processJson.ProcessGroupItems,
      // The API accepts [] for "none"; null is what it returns, not what it requires.
      ProcessGroupShortcut: shortcuts.map((s) => ({ ...s })),
    },
  };
}

/** Current shortcut group ids, normalising the null-vs-empty inconsistency. */
export function currentShortcutIds(processJson: ProcessJson): string[] {
  return (processJson.ProcessGroupItems.ProcessGroupShortcut ?? []).map((s) => s.UniqueId);
}

// --------------------------------------------------------------- listing

/** A row from the process list endpoint. */
export interface ProcessListItem {
  processId: number;
  processName: string;
  processUniqueId: string;
  processState: string;
  groupId: number;
  groupUniqueId: string;
  groupName: string;
  processOwner: string;
  processExpert: string;
}

export interface ProcessListPage {
  items: ProcessListItem[];
  totalItemCount: number;
}

/**
 * List types accepted by the process list endpoint.
 * Values taken from Nintex's own bulk-operations script.
 */
export const ProcessListType = {
  Active: 0,
  Archived: 7,
} as const;

/** Matches the page size that script uses; the endpoint is 1-indexed. */
export const LIST_PAGE_SIZE = 200;

export function listProcesses(
  ctx: PmContext,
  page: number,
  pageSize: number = LIST_PAGE_SIZE,
  listType: number = ProcessListType.Active,
): Promise<ProcessListPage> {
  return pmRequest<ProcessListPage>(ctx, {
    path: '/Bff/Process/api/v1/processes',
    query: { Page: page, PageSize: pageSize, ListType: listType },
  });
}

/**
 * Walk every page of the process list.
 *
 * Termination follows the reference script: a short page means the end. Relying on
 * totalItemCount alone would loop forever if the count and the pages ever disagreed,
 * so a hard page cap backstops it.
 */
export async function listAllProcesses(
  ctx: PmContext,
  options: {
    pageSize?: number;
    listType?: number;
    onPage?: (loaded: number, total: number) => void;
    maxPages?: number;
  } = {},
): Promise<ProcessListItem[]> {
  const pageSize = options.pageSize ?? LIST_PAGE_SIZE;
  const listType = options.listType ?? ProcessListType.Active;
  const maxPages = options.maxPages ?? 500;

  const all: ProcessListItem[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const result = await listProcesses(ctx, page, pageSize, listType);
    const items = result?.items ?? [];
    all.push(...items);
    options.onPage?.(all.length, result?.totalItemCount ?? all.length);
    if (items.length < pageSize) break;
  }

  return all;
}

/**
 * The tenant's process list report, as CSV.
 *
 * Preferred over paging the JSON endpoint when the goal is simply "give the operator
 * a file with process IDs in it": one request instead of eight, and the tenant does
 * the formatting.
 */
export function exportProcessListCsv(ctx: PmContext): Promise<string> {
  return pmRequest<string>(ctx, {
    path: '/exports/api/v1/reports/ProcessListReport/csv',
    parse: 'text',
  });
}

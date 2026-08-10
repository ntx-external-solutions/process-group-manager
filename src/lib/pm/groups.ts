/**
 * Group endpoints.
 *
 * These are the MVC-style `/Process/Edit/*` and `/Process/View/*` routes, a different
 * surface from the `/Api/v1/*` process endpoints.
 *
 * Creating a group is two calls: CreateGroup always makes a group literally named
 * "New Group" and returns its id, then RenameGroup sets the real name. There is no
 * create-with-name call, no transaction, and no rollback — so callers must journal
 * the returned id before attempting the rename, or a failure between the two leaves
 * an orphan that cannot be told apart from a legitimate group.
 */

import { pmRequest, type PmContext } from './client.ts';
import type {
  ChildTreeItemsResponse,
  CreateGroupResponse,
  ValidateActionResponse,
} from './types.ts';

/**
 * Operation codes for Validate*Action. Only the ones we use are named; the enum is
 * the server's and is not otherwise documented.
 */
export const GroupActionType = {
  /** Add a group / add a subgroup. */
  Create: 1,
} as const;

/** The name the server assigns to every newly created group. */
export const PLACEHOLDER_GROUP_NAME = 'New Group';

/**
 * One level of the tree. Pass null for the root level.
 * The tree loads lazily — there is no "give me everything" call.
 */
export function getChildGroups(
  ctx: PmContext,
  parentUniqueId: string | null,
): Promise<ChildTreeItemsResponse> {
  return pmRequest<ChildTreeItemsResponse>(ctx, {
    path: '/Process/View/GetChildProcessGroupTreeItems',
    query: { uniqueId: parentUniqueId ?? '' },
  });
}

/**
 * Server-side gate, called before acting.
 *
 * `isPrompt` means the server wants the user asked something first. Honour it —
 * for destructive operations the confirmation is client-side only, so ignoring it
 * removes the sole safety check.
 */
export function validateGroupAction(
  ctx: PmContext,
  processGroupUniqueId: string | null,
  actionType: number = GroupActionType.Create,
): Promise<ValidateActionResponse> {
  return pmRequest<ValidateActionResponse>(ctx, {
    path: '/Process/Edit/ValidateGroupAction',
    query: { processGroupUniqueId: processGroupUniqueId ?? '', actionType },
  });
}

/**
 * Create a placeholder group. Pass null for a top-level group.
 * The result's `groupid` (lowercase 'i', the server's spelling) must be persisted
 * before the follow-up rename is attempted.
 */
export function createGroup(
  ctx: PmContext,
  parentProcessGroupUniqueId: string | null,
): Promise<CreateGroupResponse> {
  return pmRequest<CreateGroupResponse>(ctx, {
    path: '/Process/Edit/CreateGroup',
    method: 'POST',
    body: { parentProcessGroupUniqueId: parentProcessGroupUniqueId ?? '' },
    retry: 'write',
  });
}

export function renameGroup(
  ctx: PmContext,
  processGroupUniqueId: string,
  newName: string,
): Promise<{ isValid: boolean }> {
  return pmRequest<{ isValid: boolean }>(ctx, {
    path: '/Process/Edit/RenameGroup',
    method: 'POST',
    body: { processGroupUniqueId, newName },
    // Renaming is idempotent — setting the same name twice is harmless, and being
    // able to retry is what makes an interrupted create recoverable.
    retry: 'read',
  });
}

/**
 * One node being reparented. The server's field names and casing, not ours.
 *
 * `NodeType` is the tree item's own `itemType` passed straight through — the client
 * does no branching by type, and `"group"` reparents a group through the identical
 * call that moves a process.
 */
export interface TreeNodeMove {
  NodeType: 'group';
  /** Empty string moves the node to the top level. */
  ParentUniqueId: string;
  OriginalParentUniqueId: string;
  ChildUniqueId: string;
  /** -1 appends. Ordering within the destination is not something v1 sets. */
  Position: number;
  SiblingUniqueId: string | null;
}

export interface ReorderResponse {
  success: boolean;
  errors: unknown[] | null;
}

/**
 * Reparent groups. Takes an array, so many moves commit in one request.
 *
 * The group keeps its id, and therefore its processes, permissions, and stakeholders —
 * which is what makes matching-and-moving strictly better than creating a new group and
 * re-homing everything into it. It touches no process revision, so it publishes nothing
 * and notifies nobody.
 */
export function reorderTreeNodes(
  ctx: PmContext,
  moves: readonly TreeNodeMove[],
): Promise<ReorderResponse> {
  return pmRequest<ReorderResponse>(ctx, {
    path: '/Process/Edit/ReorderTreeNodes',
    method: 'POST',
    body: moves,
    // Write policy: retried only when the server says it never looked at the request
    // (429/408). A 5xx or a dropped connection leaves the outcome unknown, and a
    // reparent is not idempotent enough to send twice on a guess.
    retry: 'write',
  });
}

export interface ActionPermission {
  actionPermissionType: string;
  value: boolean;
}

export interface GroupPermissions {
  groupUniqueId: string;
  permissions: ActionPermission[];
}

/** Batch permission lookup — one call for the whole plan, not one per group. */
export async function getGroupPermissions(
  ctx: PmContext,
  groupIds: readonly number[],
): Promise<GroupPermissions[]> {
  if (groupIds.length === 0) return [];
  // Repeated `groupIds` parameters, which URLSearchParams handles but our generic
  // query builder (one value per key) does not.
  const params = new URLSearchParams();
  for (const id of groupIds) params.append('groupIds', String(id));

  const response = await pmRequest<{ success: boolean; data: GroupPermissions[] }>(ctx, {
    path: `/Process/View/GetUserActionPermissionsByGroups?${params.toString()}`,
  });
  return response.data ?? [];
}

export interface GroupViewerCount {
  groupId: number;
  totalUsers: number;
  totalRoles: number;
}

/**
 * Viewer counts for a set of groups — the product's own visibility-impact check.
 * Used to show who gains or loses sight of a process before anything is applied.
 */
export async function getGroupViewerCounts(
  ctx: PmContext,
  groupIds: readonly number[],
): Promise<GroupViewerCount[]> {
  if (groupIds.length === 0) return [];
  const params = new URLSearchParams();
  for (const id of groupIds) params.append('groupIds', String(id));

  const response = await pmRequest<{ success: boolean; data: GroupViewerCount[] }>(ctx, {
    path: `/Process/View/GetTotalSpecifiedGroupRoleAndUserViewers?${params.toString()}`,
  });
  return response.data ?? [];
}

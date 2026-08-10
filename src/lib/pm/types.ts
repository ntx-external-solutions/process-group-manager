/**
 * Wire types for the Process Manager API.
 *
 * These mirror payloads captured from the live product (see DESIGN.md). Field names
 * and casing are the server's, not ours — including the inconsistencies, which are
 * called out where they exist.
 */

/**
 * Node kinds returned by the group tree, lifted from the enum in
 * `processGroupPermission.bundle.js`. Also the accepted `NodeType` values for
 * ReorderTreeNodes (unused in v1 — see PLAN.md §1).
 */
export type TreeItemType =
  | 'documentgroup'
  | 'group'
  | 'process'
  | 'suggested-process'
  | 'vanillaprocess'
  | 'inprogress-process'
  | 'linked-process'
  | 'embeddedprocess';

/** A row from GetChildProcessGroupTreeItems. */
export interface TreeItem {
  id: number;
  uniqueId: string;
  title: string;
  itemType: TreeItemType;
  itemOrder: number;
  hasChild: boolean | null;
  totalSubgroups: number | null;
  totalStakeholderUsers: number | null;
  totalPermissionRoles: number | null;
  totalPermissionUsers: number | null;
  variationSetId: number | null;
}

export interface ChildTreeItemsResponse {
  treeItems: TreeItem[] | null;
  parentUniqueId: string | null;
}

/** Group membership block inside processJson. Shortcuts live here. */
export interface ProcessGroupRef {
  Id: number;
  UniqueId: string;
  Name: string;
}

export interface ProcessGroupItems {
  ProcessGroup: ProcessGroupRef;
  /** null and [] both mean "no shortcuts". */
  ProcessGroupShortcut: ProcessGroupRef[] | null;
}

/**
 * 1 = in progress, 2 = awaiting approval, 3 = published.
 * Derived from the observed 2.0 -> 2.1 -> 2.2 -> 3.0 lifecycle (DESIGN.md).
 */
export type ProcessRevisionStateId = 1 | 2 | 3;

export interface ProcessJson {
  Id: number;
  UniqueId: string;
  Name: string;
  GroupId: number;
  GroupUniqueId: string;
  Group: string;
  Version: string;
  ProcessRevisionEditId: number;
  ProcessRevisionStateId: ProcessRevisionStateId;
  ProcessGroupItems: ProcessGroupItems;
  /** Everything else is passed through untouched on write. */
  [key: string]: unknown;
}

/** Per-process capability flags. Vary by process *and* by user. */
export interface ProcessActions {
  CanPublish: boolean;
  CanPublishAfterEdit: boolean;
  CanSubmitForApproval: boolean;
  CanSubmitForApprovalAfterEdit: boolean;
  CanQuickSave: boolean;
  CanSave: boolean;
  CanPublishWithoutComment: boolean;
  CanSuppressPublishChangeNotification: boolean;
  [key: string]: boolean;
}

export interface ProcessResponse {
  processJson: ProcessJson;
  processActions: ProcessActions;
}

/**
 * PUT body. `ProcessJson` is a JSON *string*, not an object — sending the object
 * directly returns HTTP 500.
 */
export interface ProcessUpdateEnvelope {
  ProcessJson: string;
  ChangeDescription: string;
  DoSubmitForApproval: boolean;
  DoPublish: boolean;
  SuppressChangeNotification: boolean;
  SharedActivityCollectionEditModel: {
    ActivitiesToDelete: unknown[];
    ActivitiesToShare: unknown[];
    ActivitiesToUnlink: unknown[];
  };
  VariantConnectionChangeStates: unknown[];
}

/** POST /Api/v1/Processes/{uuid}/Publish. Note the *string* revision id. */
export interface PublishRequest {
  ProcessRevisionEditId: string;
  IsPublishNow: boolean;
}

/** Server-driven confirmation gate returned by Validate*Action. */
export interface ValidateActionResponse {
  isValid: boolean;
  isCancelled: boolean;
  isPrompt: boolean;
  title: string | null;
  message: string | null;
  continueLabel: string | null;
  cancelLabel: string | null;
  additionalInfos: unknown;
  errorCode: string | null;
}

export interface CreateGroupResponse {
  isValid: boolean;
  parentGroupId: string | null;
  /** Lowercase 'i' — the server's spelling, not a typo here. */
  groupid: string;
  groupName: string;
}

/** Cheap concurrency pre-check. */
export interface LatestRevisionResponse {
  latestProcessRevisionEditId: number;
}

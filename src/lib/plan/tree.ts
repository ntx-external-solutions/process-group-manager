/**
 * In-memory model of the existing group tree, and path resolution against it.
 *
 * The tree is read one level at a time from GetChildProcessGroupTreeItems, so this
 * model is built incrementally and knows which nodes have had their children loaded.
 */

import { matchKey } from '../csv/path.ts';
import type { TreeItem } from '../pm/types.ts';

export interface GroupNode {
  id: number;
  uniqueId: string;
  /** Exactly as stored in Process Manager, including any stray whitespace. */
  title: string;
  /** null for a top-level group. */
  parentUniqueId: string | null;
  isDocumentGroup: boolean;
  childrenLoaded: boolean;
  children: GroupNode[];
}

export interface GroupTree {
  roots: GroupNode[];
  byUniqueId: Map<string, GroupNode>;
}

/** Only these item types participate in group-path resolution. */
function isGroupLike(item: TreeItem): boolean {
  return item.itemType === 'group' || item.itemType === 'documentgroup';
}

export function emptyTree(): GroupTree {
  return { roots: [], byUniqueId: new Map() };
}

function toNode(item: TreeItem, parentUniqueId: string | null): GroupNode {
  return {
    id: item.id,
    uniqueId: item.uniqueId,
    title: item.title,
    parentUniqueId,
    isDocumentGroup: item.itemType === 'documentgroup',
    childrenLoaded: false,
    children: [],
  };
}

/**
 * Attach a loaded level to the tree. `parentUniqueId` is null for the root level.
 * Non-group items (processes and friends) are discarded — this model is only ever
 * asked about groups.
 */
export function addLevel(
  tree: GroupTree,
  parentUniqueId: string | null,
  items: readonly TreeItem[],
): GroupTree {
  const nodes = items.filter(isGroupLike).map((item) => toNode(item, parentUniqueId));

  for (const node of nodes) tree.byUniqueId.set(node.uniqueId, node);

  if (parentUniqueId === null) {
    tree.roots = nodes;
  } else {
    const parent = tree.byUniqueId.get(parentUniqueId);
    if (!parent) {
      throw new Error(`Cannot attach children to unknown group ${parentUniqueId}`);
    }
    parent.children = nodes;
    parent.childrenLoaded = true;
  }

  return tree;
}

/** Direct children of a node, or the roots when `node` is null. */
export function childrenOf(tree: GroupTree, node: GroupNode | null): GroupNode[] {
  return node === null ? tree.roots : node.children;
}

export type Resolution =
  /** Every segment matched an existing group. */
  | { kind: 'found'; node: GroupNode }
  /**
   * Matched `depth` segments; the segment at index `depth` does not exist.
   * `parent` is the deepest existing node (null when nothing matched at all).
   */
  | { kind: 'missing'; depth: number; parent: GroupNode | null }
  /** Two or more siblings share a name at `depth`. We refuse to guess. */
  | { kind: 'ambiguous'; depth: number; candidates: GroupNode[] }
  /** A segment resolved to a document-only group, which cannot hold processes. */
  | { kind: 'documentGroup'; depth: number; node: GroupNode }
  /** Resolution needs a level that has not been loaded yet. */
  | { kind: 'unloaded'; depth: number; parent: GroupNode | null };

/**
 * Walk a path against the tree.
 *
 * Returns the first thing that stops progress rather than a boolean, because callers
 * need to distinguish "create it here" from "I cannot tell which group you mean".
 */
export function resolvePath(tree: GroupTree, segments: readonly string[]): Resolution {
  let parent: GroupNode | null = null;

  for (let depth = 0; depth < segments.length; depth++) {
    const wanted = matchKey(segments[depth] as string);

    if (parent !== null && !parent.childrenLoaded) {
      return { kind: 'unloaded', depth, parent };
    }

    const siblings = childrenOf(tree, parent);
    const matches = siblings.filter((n) => matchKey(n.title) === wanted);

    if (matches.length === 0) {
      return { kind: 'missing', depth, parent };
    }
    if (matches.length > 1) {
      return { kind: 'ambiguous', depth, candidates: matches };
    }

    const node = matches[0] as GroupNode;
    if (node.isDocumentGroup && depth < segments.length - 1) {
      // A document group can be a leaf in someone's mental model, but it cannot be
      // an ancestor of a process group.
      return { kind: 'documentGroup', depth, node };
    }

    parent = node;
  }

  return { kind: 'found', node: parent as GroupNode };
}

/** Every path in the tree, as display-form segment arrays. Used by the exporter. */
export function allPaths(tree: GroupTree): string[][] {
  const out: string[][] = [];
  const walk = (node: GroupNode, prefix: string[]): void => {
    const path = [...prefix, node.title];
    out.push(path);
    for (const child of node.children) walk(child, path);
  };
  for (const root of tree.roots) walk(root, []);
  return out;
}

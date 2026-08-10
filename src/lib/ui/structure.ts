/**
 * The group structure as it would look afterwards.
 *
 * The create list answers "what will this run do"; this answers "what am I building",
 * which is the question a Promaster actually has when they hand over a hierarchy. A
 * flat list of paths cannot show that `Legal | Compliance | Audit` lands next to three
 * groups that already exist, or that a typo has quietly produced a second top-level
 * group rather than a child of the first.
 *
 * Two things it refuses to do:
 *
 *  - draw a group as empty when the tree was never loaded that deep. The tree loads
 *    lazily, so "no children shown" and "no children" are different facts and are
 *    reported differently;
 *  - reorder anything. New groups are appended after existing siblings because that is
 *    where CreateGroup puts them, and v1 does not reorder (PLAN.md §1).
 */

import { pathKey } from '../csv/path.ts';
import type { GroupPlan } from '../plan/groupPlan.ts';
import type { GroupNode, GroupTree } from '../plan/tree.ts';

export interface StructureNode {
  /** Path key, unique within the preview. */
  key: string;
  name: string;
  status: 'existing' | 'new';
  isDocumentGroup: boolean;
  /** CSV line that introduced it. Null for groups that already exist. */
  line: number | null;
  /** Execution order. Null for groups that already exist. */
  seq: number | null;
  children: StructureNode[];
  /** There is more beneath this group than is shown — unloaded, or out of scope. */
  hasHiddenChildren: boolean;
}

export interface StructurePreview {
  roots: StructureNode[];
  /** Groups this run would create. */
  newCount: number;
  /** Everything drawn, new and existing, for a sanity check on size. */
  nodeCount: number;
}

/**
 * Build the resulting tree from the loaded tree and the plan.
 *
 * Scope is deliberately narrow: the branches the file touches, plus one level of
 * existing siblings for context. Drawing the whole tenant would bury the four groups
 * being added in ninety that are not.
 */
export function buildStructurePreview(tree: GroupTree, plan: GroupPlan): StructurePreview {
  // Every path the file named, and every ancestor of one.
  const focus = new Set<string>();
  const addPrefixes = (segments: readonly string[]): void => {
    for (let depth = 1; depth <= segments.length; depth++) {
      focus.add(pathKey(segments.slice(0, depth)));
    }
  };
  for (const create of plan.creates) addPrefixes(create.path);
  for (const existing of plan.existing) addPrefixes(existing.path);

  const fromExisting = (nodes: readonly GroupNode[], parentPath: readonly string[]): StructureNode[] => {
    // Descend only through groups the file named; their children are the context.
    const parentKey = pathKey(parentPath);
    if (parentPath.length > 0 && !focus.has(parentKey)) return [];

    return nodes.map((node) => {
      const path = [...parentPath, node.title];
      const children = fromExisting(node.children, path);
      return {
        key: pathKey(path),
        name: node.title,
        status: 'existing' as const,
        isDocumentGroup: node.isDocumentGroup,
        line: null,
        seq: null,
        children,
        hasHiddenChildren: node.childrenLoaded
          ? node.children.length > children.length
          : node.hasChild,
      };
    });
  };

  const roots = fromExisting(tree.roots, []);

  const byKey = new Map<string, StructureNode>();
  const index = (nodes: readonly StructureNode[]): void => {
    for (const node of nodes) {
      byKey.set(node.key, node);
      index(node.children);
    }
  };
  index(roots);

  // Ascending seq, which the planner guarantees puts a parent before its children.
  for (const create of [...plan.creates].sort((a, b) => a.seq - b.seq)) {
    const node: StructureNode = {
      key: pathKey(create.path),
      name: create.name,
      status: 'new',
      isDocumentGroup: false,
      line: create.line,
      seq: create.seq,
      children: [],
      hasHiddenChildren: false,
    };

    const parentPath = create.path.slice(0, -1);
    // The planner records every existing ancestor in plan.existing and orders creates
    // parent-first, so this lookup succeeds. Falling back to the top level keeps a
    // broken invariant visible rather than throwing away the node.
    const parent = parentPath.length === 0 ? null : byKey.get(pathKey(parentPath));

    // An existing parent here always had its children loaded — the planner only calls
    // a group missing once it has seen that level — so nothing it holds is hidden.
    if (parent) parent.children.push(node);
    else roots.push(node);
    byKey.set(node.key, node);
  }

  return {
    roots,
    newCount: plan.creates.length,
    nodeCount: byKey.size,
  };
}

/**
 * Indented plain text, for pasting into a ticket or an email.
 *
 * The CSV plan is the reviewable artefact; this is the shape, which is what people
 * want to show someone else.
 */
export function structureToText(preview: StructurePreview): string {
  const lines: string[] = [];
  const walk = (nodes: readonly StructureNode[], depth: number): void => {
    for (const node of nodes) {
      const indent = '  '.repeat(depth);
      const suffix = node.status === 'new' ? '   (new)' : '';
      lines.push(`${indent}${node.name}${suffix}`);
      walk(node.children, depth + 1);
      if (node.hasHiddenChildren) lines.push(`${indent}  …`);
    }
  };
  walk(preview.roots, 0);
  return lines.join('\n');
}

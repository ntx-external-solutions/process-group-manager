/**
 * Finding groups that were created but never named.
 *
 * Creating a group in Process Manager is two calls — CreateGroup makes one literally
 * called "New Group", then RenameGroup names it — and the product is known to drop the
 * second half when a lot of groups are created at once. What is left is a group nobody
 * asked for, sitting in the tree under a placeholder name.
 *
 * They matter here for a specific reason: this tool matches groups by name, so an
 * orphan is invisible to it. Run the same file again and it will not recognise the
 * half-made group, and will create a second one beside it. Surfacing them before a run
 * is what stops one interrupted attempt turning into a pile of duplicates.
 */

import { matchKey } from '../csv/path.ts';
import { PLACEHOLDER_GROUP_NAME } from '../pm/groups.ts';
import { displayPath } from '../csv/path.ts';
import type { GroupNode, GroupTree } from './tree.ts';

export interface OrphanGroup {
  uniqueId: string;
  path: string[];
  display: string;
}

/**
 * Every placeholder-named group in the part of the tree that has been loaded.
 *
 * Scoped to what was loaded, which is the branches the file touches — the ones about
 * to be written to, and so the ones where a duplicate would actually be created.
 */
export function findOrphanGroups(tree: GroupTree): OrphanGroup[] {
  const found: OrphanGroup[] = [];
  const placeholder = matchKey(PLACEHOLDER_GROUP_NAME);

  const walk = (node: GroupNode, prefix: readonly string[]): void => {
    const path = [...prefix, node.title];
    if (matchKey(node.title) === placeholder) {
      found.push({ uniqueId: node.uniqueId, path, display: displayPath(path) });
    }
    for (const child of node.children) walk(child, path);
  };

  for (const root of tree.roots) walk(root, []);
  return found;
}

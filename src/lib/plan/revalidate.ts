/**
 * Checking a plan against the tenant one last time, immediately before writing.
 *
 * The planner's tree is the only thing standing between a file and a duplicate group:
 * `runCreates` has no "does this name already exist here?" test of its own, so a group
 * somebody else added since the tree was read is invisible and gets created twice. That
 * was tolerable while every upload re-read the tenant; once the tree can come from a
 * cache it is not, and re-reading the whole tenant to apply a four-row file never was.
 *
 * So this reads only what the plan actually touches: the levels it creates into, and the
 * current homes of the groups it renames or moves. One request per distinct parent,
 * bounded by the size of the plan rather than the size of the tenant.
 *
 * It reads. It never writes and it never repairs — a plan that no longer matches the
 * tenant is one the operator has to look at again, because the preview they approved
 * described a tree that no longer exists.
 */

import { matchKey } from '../csv/path.ts';
import type { PlanGateway } from './orchestrate.ts';
import type { GroupPlan } from './groupPlan.ts';
import type { TreeItem } from '../pm/types.ts';

export interface StaleFinding {
  /** CSV line that asked for the affected step, when there is one. */
  line: number | null;
  display: string;
  message: string;
}

function isGroupLike(item: TreeItem): boolean {
  return item.itemType === 'group' || item.itemType === 'documentgroup';
}

/**
 * Read one level, tolerating failure.
 *
 * A parent we cannot read is not evidence of a conflict, and refusing to apply because
 * a check could not run would make the safety net worse than not having one. Returns
 * null, and the caller skips that comparison.
 */
async function childrenOf(
  gateway: PlanGateway,
  parentUniqueId: string | null,
): Promise<TreeItem[] | null> {
  try {
    const response = await gateway.groupsTree(parentUniqueId);
    return (response.treeItems ?? []).filter(isGroupLike);
  } catch {
    return null;
  }
}

/** Map key for the root level, which has no uniqueId of its own. */
const ROOT = ' root';

const keyOf = (parentUniqueId: string | null): string => parentUniqueId ?? ROOT;
const idOf = (key: string): string | null => (key === ROOT ? null : key);

/**
 * What has changed under the plan since it was built.
 *
 * An empty array means the tenant still looks the way the preview said it did.
 */
export async function revalidateGroupPlan(
  gateway: PlanGateway,
  plan: GroupPlan,
  options: { concurrency?: number } = {},
): Promise<StaleFinding[]> {
  const concurrency = Math.max(1, options.concurrency ?? 6);

  // Every level the plan needs to see, gathered first so each is read exactly once
  // however many steps depend on it.
  const wanted = new Set<string>();
  for (const create of plan.creates) {
    // A parent this same run creates cannot already hold anything.
    if (create.parent.kind === 'existing') wanted.add(keyOf(create.parent.uniqueId));
    else if (create.parent.kind === 'root') wanted.add(ROOT);
  }
  for (const move of plan.moves) wanted.add(keyOf(move.fromParentUniqueId));
  for (const rename of plan.renames) wanted.add(keyOf(rename.fromParentUniqueId));

  const levels = new Map<string, TreeItem[] | null>();
  const keys = [...wanted];
  for (let i = 0; i < keys.length; i += concurrency) {
    const batch = keys.slice(i, i + concurrency);
    const read = await Promise.all(
      batch.map(async (key) => ({ key, items: await childrenOf(gateway, idOf(key)) })),
    );
    for (const { key, items } of read) levels.set(key, items);
  }

  const findings: StaleFinding[] = [];

  for (const create of plan.creates) {
    if (create.parent.kind === 'planned') continue;
    const items = levels.get(
      create.parent.kind === 'existing' ? keyOf(create.parent.uniqueId) : ROOT,
    );
    if (!items) continue;

    const clash = items.find((item) => matchKey(item.title) === matchKey(create.name));
    if (clash) {
      findings.push({
        line: create.line,
        display: create.display,
        message:
          `A group called "${clash.title}" now exists here. It was not there when this ` +
          `plan was built, so applying the plan would create a second one. Upload the ` +
          `file again to plan against the current structure.`,
      });
    }
  }

  for (const move of plan.moves) {
    const items = levels.get(keyOf(move.fromParentUniqueId));
    if (!items) continue;

    if (!items.some((item) => item.uniqueId === move.uniqueId)) {
      findings.push({
        line: move.line,
        display: move.fromDisplay,
        message:
          `"${move.name}" is not in ${move.fromDisplay} any more. Somebody has moved or ` +
          `deleted it since this plan was built. Upload the file again.`,
      });
    }
  }

  for (const rename of plan.renames) {
    const items = levels.get(keyOf(rename.fromParentUniqueId));
    if (!items) continue;

    const self = items.find((item) => item.uniqueId === rename.uniqueId);
    if (!self) {
      findings.push({
        line: rename.line,
        display: rename.fromDisplay,
        message:
          `"${rename.from}" is not where it was when this plan was built. Somebody has ` +
          `moved or deleted it. Upload the file again.`,
      });
      continue;
    }

    if (matchKey(self.title) !== matchKey(rename.from)) {
      findings.push({
        line: rename.line,
        display: rename.fromDisplay,
        message:
          `This group is now called "${self.title}", not "${rename.from}". Somebody has ` +
          `renamed it since this plan was built. Upload the file again to see what that ` +
          `means for your file.`,
      });
      continue;
    }

    const clash = items.find(
      (item) => item.uniqueId !== rename.uniqueId && matchKey(item.title) === matchKey(rename.to),
    );
    if (clash) {
      findings.push({
        line: rename.line,
        display: rename.fromDisplay,
        message:
          `Another group here is already called "${clash.title}", so renaming this one to ` +
          `"${rename.to}" would leave two groups with the same name and nothing could be ` +
          `nested under either by name. Upload the file again.`,
      });
    }
  }

  return findings;
}

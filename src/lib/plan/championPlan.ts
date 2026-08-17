/**
 * Champion planner. Assigns, replaces, and removes — always against a stated before.
 *
 * Pure function of (rows, group plan, directory, current champions) -> plan, for the same
 * reason as every other planner here: the object the operator approves on screen is the
 * object the executor runs.
 *
 * Two things shape it that the other planners do not have to deal with:
 *
 *  - **the group may not exist yet.** A row that creates a group and names its champion
 *    has no uniqueId to point at, so the action names the create's sequence number and
 *    the runner substitutes the real id once it has one;
 *  - **this grants permission.** `isChampion` implies `canManageGroups`, so a champion
 *    change is a change to who may restructure that branch. Nothing here is inferred: a
 *    blank cell produces no action at all, and every action states who is being replaced.
 */

import { pathKey } from '../csv/path.ts';
import { logonKey, regionKey, type RegionalChampionCell } from '../csv/champions.ts';
import type { GroupCsvRow } from '../csv/groups.ts';
import type { DirectoryLookup } from '../pm/scim.ts';
import type { GroupChampions } from '../pm/champions.ts';
import type { GroupPlan, PlanIssue } from './groupPlan.ts';

/** The group an action applies to: one that exists, or one this same run creates. */
export type ChampionTarget =
  | { kind: 'existing'; uniqueId: string }
  | { kind: 'planned'; seq: number };

export interface ChampionPerson {
  userId: number;
  logon: string;
  displayName: string;
}

export interface PrimaryChampionAction {
  /** Stable across resumes: the group's path, which is what the journal keys on. */
  key: string;
  target: ChampionTarget;
  display: string;
  line: number;
  /** null removes the champion. */
  person: ChampionPerson | null;
  /** Who holds it today. Null for a new group, or for one that has nobody. */
  before: string | null;
}

export interface RegionalChampionAction {
  key: string;
  target: ChampionTarget;
  display: string;
  line: number;
  /** The complete list the group will end up with. Empty removes them all. */
  people: Array<ChampionPerson & { region: string }>;
  /** What it has today, for the preview to show what a replace displaces. */
  before: Array<{ region: string; name: string }>;
}

export interface ChampionPlan {
  primary: PrimaryChampionAction[];
  regional: RegionalChampionAction[];
  /** Rows whose champions already match. Counted, not listed. */
  unchanged: number;
  blocked: PlanIssue[];
  /** Applied, but worth a second look — an inactive account, usually. */
  warnings: PlanIssue[];
}

export interface ChampionPlanDeps {
  /** Logon -> user, `'ambiguous'` where two accounts share one, null where none does. */
  resolveUser(logon: string): DirectoryLookup;
  /**
   * The group's champions today, or null when they were not read — a group this run is
   * creating, or one whose read failed. Null means "no before to compare against", which
   * makes the action unconditional rather than skippable.
   */
  currentOf(uniqueId: string): GroupChampions | null;
  /** False when the tenant does not have regional champions turned on. */
  regionalEnabled: boolean;
}

/** Where each row's group will be, once the group plan has run. */
function targetsByLine(plan: GroupPlan): Map<number, { target: ChampionTarget; display: string }> {
  const byLine = new Map<number, { target: ChampionTarget; display: string }>();

  // Existing groups first, then creates, so a row that resolved to both — which cannot
  // happen — would prefer the thing this run is about to make rather than a stale match.
  for (const existing of plan.existing) {
    byLine.set(existing.line, {
      target: { kind: 'existing', uniqueId: existing.uniqueId },
      display: existing.display,
    });
  }
  for (const create of plan.creates) {
    byLine.set(create.line, {
      target: { kind: 'planned', seq: create.seq },
      display: create.display,
    });
  }

  return byLine;
}

/**
 * The entry a row's own path resolves to.
 *
 * `plan.existing` holds one entry per *ancestor* as well as per row, all sharing the
 * row's line number, so the line alone is not enough — a three-level row would otherwise
 * hand its champion to its grandparent. The full path is what picks the row's own group.
 */
function targetFor(
  row: GroupCsvRow,
  plan: GroupPlan,
  byLine: ReadonlyMap<number, { target: ChampionTarget; display: string }>,
): { target: ChampionTarget; display: string } | null {
  const wanted = pathKey(row.segments);

  for (const create of plan.creates) {
    if (create.line === row.line && pathKey(create.path) === wanted) {
      return { target: { kind: 'planned', seq: create.seq }, display: create.display };
    }
  }
  for (const existing of plan.existing) {
    if (existing.line === row.line && pathKey(existing.path) === wanted) {
      return { target: { kind: 'existing', uniqueId: existing.uniqueId }, display: existing.display };
    }
  }

  // A row that is only moving or renaming a group names it by id, and the planner records
  // it under the path it is moving *to* — which the loops above already cover. Anything
  // still unmatched has an id we can use directly.
  if (row.uniqueId !== null) {
    return { target: { kind: 'existing', uniqueId: row.uniqueId }, display: row.display };
  }

  return byLine.get(row.line) ?? null;
}

function samePeople(
  desired: ReadonlyArray<{ userId: number; region: string }>,
  current: ReadonlyArray<{ userId: number; region: string }>,
): boolean {
  if (desired.length !== current.length) return false;
  const key = (entry: { userId: number; region: string }): string =>
    `${entry.userId}@${regionKey(entry.region)}`;
  const currentKeys = new Set(current.map(key));
  return desired.every((entry) => currentKeys.has(key(entry)));
}

/**
 * Plan the champion changes a file asks for.
 *
 * Runs after `planGroups`, which is what supplies the target for each row — including
 * the sequence number of a group that does not exist yet.
 */
export function planChampions(
  rows: readonly GroupCsvRow[],
  groupPlan: GroupPlan,
  deps: ChampionPlanDeps,
): ChampionPlan {
  const primary: PrimaryChampionAction[] = [];
  const regional: RegionalChampionAction[] = [];
  const blocked: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  let unchanged = 0;

  const byLine = targetsByLine(groupPlan);
  // A row the group planner refused has no group to champion. Reporting it twice would
  // just bury the reason it was refused in the first place.
  const alreadyBlocked = new Set(groupPlan.blocked.map((issue) => issue.line));

  /** Resolve one logon, recording why it could not be used. */
  const person = (logon: string, row: GroupCsvRow): ChampionPerson | null => {
    const found = deps.resolveUser(logonKey(logon));

    if (found === null) {
      blocked.push({
        line: row.line,
        display: row.display,
        message:
          `No user has the logon "${logon}". Champions are matched on logon, which is ` +
          `not always the person's email address — check it in Process Manager under ` +
          `Admin, Users.`,
      });
      return null;
    }
    if (found === 'ambiguous') {
      blocked.push({
        line: row.line,
        display: row.display,
        message:
          `More than one account has the logon "${logon}", so there is no telling which ` +
          `person you mean. Deactivate or rename the duplicate in Process Manager.`,
      });
      return null;
    }
    if (!found.active) {
      warnings.push({
        line: row.line,
        display: row.display,
        message:
          `"${logon}" (${found.displayName}) is a deactivated account. It will be set as ` +
          `champion, but a deactivated champion cannot do anything with the group.`,
      });
    }

    return { userId: found.userId, logon: found.logon, displayName: found.displayName };
  };

  for (const row of rows) {
    if (row.champion === null && row.regionalChampions === null) continue;
    if (alreadyBlocked.has(row.line)) continue;

    const resolved = targetFor(row, groupPlan, byLine);
    if (!resolved) {
      blocked.push({
        line: row.line,
        display: row.display,
        message:
          `Could not work out which group this row's champion belongs to. Remove the ` +
          `champion columns from this row, or fix the group path.`,
      });
      continue;
    }

    const { target, display } = resolved;
    const key = pathKey(row.segments);
    const current =
      target.kind === 'existing' ? deps.currentOf(target.uniqueId) : null;

    if (row.champion !== null) {
      const wanted = row.champion === 'clear' ? null : person(row.champion, row);

      // `person` reported why, and applying half a row would be worse than none of it.
      if (row.champion !== 'clear' && wanted === null) continue;

      const currentId = current?.primary?.userId ?? null;
      if (current !== null && currentId === (wanted?.userId ?? null)) {
        unchanged++;
      } else {
        primary.push({
          key,
          target,
          display,
          line: row.line,
          person: wanted,
          before: current?.primary?.name ?? null,
        });
      }
    }

    if (row.regionalChampions !== null) {
      if (!deps.regionalEnabled) {
        blocked.push({
          line: row.line,
          display: row.display,
          message:
            `This tenant does not have regional champions turned on, so the Regional ` +
            `Champions column cannot be applied. Turn the feature on in Process Manager, ` +
            `or clear the column.`,
        });
        continue;
      }

      const cells: RegionalChampionCell[] =
        row.regionalChampions === 'clear' ? [] : row.regionalChampions;

      const people: RegionalChampionAction['people'] = [];
      let failed = false;
      for (const cell of cells) {
        const found = person(cell.logon, row);
        if (!found) {
          failed = true;
          break;
        }
        people.push({ ...found, region: cell.region });
      }
      if (failed) continue;

      const currentRegional = current?.regional ?? null;
      if (currentRegional !== null && samePeople(people, currentRegional)) {
        unchanged++;
      } else {
        regional.push({
          key,
          target,
          display,
          line: row.line,
          people,
          before: (currentRegional ?? []).map((entry) => ({
            region: entry.region,
            name: entry.name,
          })),
        });
      }
    }
  }

  return { primary, regional, unchanged, blocked, warnings };
}

/** True when the plan would change nothing. */
export function isNoOp(plan: ChampionPlan): boolean {
  return plan.primary.length === 0 && plan.regional.length === 0;
}

/** Writes the plan implies, for the progress bar. */
export function championActionCount(plan: ChampionPlan): number {
  return plan.primary.length + plan.regional.length;
}

/** Groups whose current champions have to be read before this file can be planned. */
export function championLookupIds(rows: readonly GroupCsvRow[], plan: GroupPlan): string[] {
  const wanted = new Set<string>();
  const byLine = targetsByLine(plan);

  for (const row of rows) {
    if (row.champion === null && row.regionalChampions === null) continue;
    const resolved = targetFor(row, plan, byLine);
    if (resolved?.target.kind === 'existing') wanted.add(resolved.target.uniqueId);
  }

  return [...wanted];
}

/**
 * Group champion endpoints.
 *
 * The same `/Process/Edit/*` MVC surface as group create and rename, and the same bearer
 * auth — the `__RequestVerificationToken` header in a browser capture of these calls is a
 * session artefact, not a requirement (see client.ts).
 *
 * A champion is not decoration. `GetGroupsAssociatedToCurrentUser` reports `isChampion`,
 * and the product's own gate is `canManageGroups = isBA || isPromaster || isChampion` —
 * so assigning one grants the ability to restructure that branch. Every call here is a
 * permission change and belongs in the preview as one.
 *
 * All four writes are idempotent: each sets state rather than appending to it, so
 * repeating one is harmless and they carry the `read` retry policy on purpose.
 */

import { pmRequest, type PmContext } from './client.ts';

/** How Process Manager returns a user on these endpoints. Its casing, not ours. */
interface ChampionUser {
  UserId: number;
  FirstName: string | null;
  LastName: string | null;
}

interface PrimaryChampionResponse {
  success: boolean;
  data?: {
    champion?: ChampionUser | null;
    /** Whether the tenant has regional champions turned on at all. */
    enableGroupRegionalChampions?: boolean;
  } | null;
}

interface RegionalChampionsResponse {
  success: boolean;
  data?: {
    champions?: Array<{ User?: ChampionUser | null; Region?: string | null }> | null;
  } | null;
}

export interface ChampionRef {
  userId: number;
  /** "Given Family" as the tenant holds it, for showing what is being replaced. */
  name: string;
}

export interface RegionalChampionRef extends ChampionRef {
  region: string;
}

export interface GroupChampions {
  primary: ChampionRef | null;
  regional: RegionalChampionRef[];
  /** False when the tenant does not use regional champions; the column is then refused. */
  regionalEnabled: boolean;
}

function nameOf(user: ChampionUser): string {
  const parts = [user.FirstName, user.LastName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' ') : `User ${user.UserId}`;
}

export async function getPrimaryChampion(
  ctx: PmContext,
  processGroupUniqueId: string,
): Promise<{ champion: ChampionRef | null; regionalEnabled: boolean }> {
  const response = await pmRequest<PrimaryChampionResponse>(ctx, {
    path: '/Process/Edit/GetProcessGroupPrimaryChampion',
    query: { processGroupUniqueId },
  });

  const champion = response.data?.champion ?? null;
  return {
    champion: champion ? { userId: champion.UserId, name: nameOf(champion) } : null,
    regionalEnabled: response.data?.enableGroupRegionalChampions === true,
  };
}

export async function getRegionalChampions(
  ctx: PmContext,
  processGroupUniqueId: string,
): Promise<RegionalChampionRef[]> {
  const response = await pmRequest<RegionalChampionsResponse>(ctx, {
    path: '/Process/Edit/GetProcessGroupRegionalChampions',
    query: { processGroupUniqueId },
  });

  const out: RegionalChampionRef[] = [];
  for (const entry of response.data?.champions ?? []) {
    const user = entry.User;
    // A regional champion with no user or no region is not something we can round-trip,
    // and showing it as one would make a replace look like it was preserving it.
    if (!user || !entry.Region) continue;
    out.push({ userId: user.UserId, name: nameOf(user), region: entry.Region });
  }
  return out;
}

/** Both halves in one call, because the preview always wants both. */
export async function getGroupChampions(
  ctx: PmContext,
  processGroupUniqueId: string,
): Promise<GroupChampions> {
  const primary = await getPrimaryChampion(ctx, processGroupUniqueId);
  // Only worth a second request where the tenant actually has the feature.
  const regional = primary.regionalEnabled
    ? await getRegionalChampions(ctx, processGroupUniqueId)
    : [];

  return {
    primary: primary.champion,
    regional,
    regionalEnabled: primary.regionalEnabled,
  };
}

export function assignPrimaryChampion(
  ctx: PmContext,
  processGroupUniqueId: string,
  championId: number,
): Promise<{ success: boolean }> {
  return pmRequest<{ success: boolean }>(ctx, {
    path: '/Process/Edit/AssignProcessGroupPrimaryChampion',
    method: 'POST',
    body: { processGroupUniqueId, championId },
    retry: 'read',
  });
}

export function removePrimaryChampion(
  ctx: PmContext,
  processGroupUniqueId: string,
): Promise<{ success: boolean }> {
  return pmRequest<{ success: boolean }>(ctx, {
    path: '/Process/Edit/RemoveProcessGroupPrimaryChampion',
    method: 'DELETE',
    body: { processGroupUniqueId },
    retry: 'read',
  });
}

export interface RegionalChampionAssignment {
  userId: number;
  region: string;
}

/**
 * Set the group's regional champions.
 *
 * The endpoint takes the whole array, the way the admin screen sends it, so this
 * replaces rather than adds — anyone not in the array stops being a regional champion of
 * this group. That is an assumption about a write, so the runner re-reads afterwards and
 * reports any difference instead of trusting it.
 */
export function assignRegionalChampions(
  ctx: PmContext,
  processGroupUniqueId: string,
  regionalChampions: readonly RegionalChampionAssignment[],
): Promise<{ success: boolean }> {
  return pmRequest<{ success: boolean }>(ctx, {
    path: '/Process/Edit/AssignProcessGroupRegionalChampions',
    method: 'POST',
    body: { processGroupUniqueId, regionalChampions },
    retry: 'read',
  });
}

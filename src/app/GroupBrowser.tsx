'use client';

/**
 * A browsable copy of the tenant's group structure.
 *
 * It is the first thing someone sees after signing in, and it does two jobs: it proves
 * the connection works against their own data rather than a green tick, and it is the
 * reference they check their spreadsheet against.
 *
 * Branches load when opened, because the API has no "give me everything" call — one
 * request per level. Nodes are held in a flat map keyed by uniqueId rather than a
 * nested structure, so expanding something deep does not mean rebuilding the tree
 * above it.
 */

import { useCallback, useEffect, useState } from 'react';

import { callPm, PmRequestError } from '@/lib/ui/gateway.ts';
import type { ChildTreeItemsResponse, TreeItem } from '@/lib/pm/types.ts';

interface BrowseNode {
  uniqueId: string;
  title: string;
  isDocumentGroup: boolean;
  /** What the server said before anything was fetched. */
  hasChild: boolean;
  /** null until this level has been read. */
  childIds: string[] | null;
  expanded: boolean;
  loading: boolean;
}

function toNode(item: TreeItem): BrowseNode {
  return {
    uniqueId: item.uniqueId,
    title: item.title,
    isDocumentGroup: item.itemType === 'documentgroup',
    hasChild: item.hasChild === true,
    childIds: null,
    expanded: false,
    loading: false,
  };
}

function isGroup(item: TreeItem): boolean {
  return item.itemType === 'group' || item.itemType === 'documentgroup';
}

export function GroupBrowser({ onSignedOut }: { onSignedOut: () => void }) {
  const [nodes, setNodes] = useState<Map<string, BrowseNode>>(new Map());
  const [rootIds, setRootIds] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (cause: unknown) => {
      if (cause instanceof PmRequestError) {
        setError([cause.message, cause.detail].filter(Boolean).join(' — '));
        if (cause.signedOut) onSignedOut();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    },
    [onSignedOut],
  );

  const load = useCallback(
    async (parentUniqueId: string | null): Promise<TreeItem[]> => {
      const response = await callPm<ChildTreeItemsResponse>({
        op: 'groups.tree',
        parentUniqueId,
      });
      return (response.treeItems ?? []).filter(isGroup);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void load(null)
      .then((items) => {
        if (cancelled) return;
        setNodes(new Map(items.map((item) => [item.uniqueId, toNode(item)])));
        setRootIds(items.map((item) => item.uniqueId));
      })
      .catch((cause: unknown) => {
        if (!cancelled) fail(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [load, fail]);

  async function toggle(uniqueId: string) {
    const node = nodes.get(uniqueId);
    if (!node) return;

    if (node.childIds !== null) {
      setNodes((previous) => patch(previous, uniqueId, { expanded: !node.expanded }));
      return;
    }

    setNodes((previous) => patch(previous, uniqueId, { expanded: true, loading: true }));
    setError(null);

    try {
      const items = await load(uniqueId);
      setNodes((previous) => {
        const next = new Map(previous);
        for (const item of items) {
          // Keep whatever is already known about a node; only add what is missing.
          if (!next.has(item.uniqueId)) next.set(item.uniqueId, toNode(item));
        }
        const current = next.get(uniqueId);
        if (current) {
          next.set(uniqueId, {
            ...current,
            childIds: items.map((item) => item.uniqueId),
            loading: false,
          });
        }
        return next;
      });
    } catch (cause) {
      setNodes((previous) => patch(previous, uniqueId, { loading: false, expanded: false }));
      fail(cause);
    }
  }

  if (error !== null && rootIds === null) {
    return (
      <div className="panel error">
        <h2>Could not read your groups</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (rootIds === null) {
    return (
      <div className="panel">
        <h2>Your process groups</h2>
        <p>Reading them from Process Manager…</p>
      </div>
    );
  }

  const branch = (ids: readonly string[]): React.ReactElement => (
    <ul className="tree">
      {ids.map((id) => {
        const node = nodes.get(id);
        if (!node) return null;
        const openable = node.hasChild || node.childIds !== null;

        return (
          <li key={id}>
            {openable ? (
              <button
                type="button"
                className="disclosure"
                onClick={() => void toggle(id)}
                aria-expanded={node.expanded}
              >
                <span className="marker">{node.expanded ? '▾' : '▸'}</span>
                <span className="name">{node.title}</span>
              </button>
            ) : (
              <span className="disclosure leaf">
                <span className="marker" />
                <span className="name">{node.title}</span>
              </span>
            )}
            {node.isDocumentGroup && <span className="tag">documents only</span>}
            {node.loading && <span className="tag">loading…</span>}
            {node.expanded && node.childIds !== null && node.childIds.length > 0
              ? branch(node.childIds)
              : null}
            {node.expanded && node.childIds !== null && node.childIds.length === 0 && (
              <ul className="tree">
                <li className="hidden-children">no subgroups</li>
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="panel">
      <h2>Your process groups</h2>
      <p>
        {rootIds.length.toLocaleString()} top-level {rootIds.length === 1 ? 'group' : 'groups'}.
        Open one to see what is inside — this only reads.
      </p>
      {branch(rootIds)}
      {error !== null && <p className="truncated">{error}</p>}
    </div>
  );
}

function patch(
  nodes: ReadonlyMap<string, BrowseNode>,
  uniqueId: string,
  changes: Partial<BrowseNode>,
): Map<string, BrowseNode> {
  const next = new Map(nodes);
  const node = next.get(uniqueId);
  if (node) next.set(uniqueId, { ...node, ...changes });
  return next;
}

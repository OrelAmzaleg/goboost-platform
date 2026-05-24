/**
 * paperclipTree — builds the issue *forest* shown when an agent is
 * focused in the GoBoost chat panel.
 *
 * Paperclip's model: an issue is the root of a tree of sub-issues, and
 * an agent participates across one or more such trees. GoBoost used to
 * model "1 issue = 1 agent" — this module replaces that with a proper
 * forest derived from Paperclip's `participantAgentId` + `descendantOf`
 * query filters (no backend changes needed).
 *
 * Pipeline (`buildAgentForest`):
 *   1. fetch every issue the agent participated in
 *   2. walk each one's `parentId` chain up to its root (cycle-guarded)
 *   3. for each distinct root, fetch the whole sub-tree in one call
 *   4. assemble nested IssueTreeNodes, tagging `lit` = agent owns it
 */

import type { BookmarkScope } from './bookmarks.js';
import {
  fetchIssueById,
  fetchIssueDescendants,
  fetchParticipantIssues,
  type PaperclipIssue,
} from './paperclipApi.js';

export interface IssueTreeNode {
  issue: PaperclipIssue;
  children: IssueTreeNode[];
  /** True when the focused agent is this issue's current assignee. */
  lit: boolean;
  /** 0 for a root, +1 per level — used for indentation in the picker. */
  depth: number;
}

/**
 * Walk `parentId` upward from `start`, returning the root issue id.
 * Unseen ancestors are fetched and added to the shared `cache`.
 *
 * Two early-exits both treat the current node as a (local) root:
 *   • a `parentId` that points back into the current walk → cycle.
 *   • a `parentId` whose issue can't be fetched (404 / not visible).
 */
async function findRootId(
  start: PaperclipIssue,
  cache: Map<string, PaperclipIssue>,
): Promise<string> {
  const visited = new Set<string>();
  let current = start;
  cache.set(current.id, current);
  while (current.parentId) {
    if (visited.has(current.id)) {
      console.warn(
        `[paperclipTree] parentId cycle detected at issue ${current.id} — treating as root`,
      );
      return current.id;
    }
    visited.add(current.id);
    const parentId: string = current.parentId;
    let parent = cache.get(parentId);
    if (!parent) {
      const fetched = await fetchIssueById(parentId);
      if (!fetched) {
        // Parent not visible to us — current node is a local root.
        return current.id;
      }
      cache.set(fetched.id, fetched);
      parent = fetched;
    }
    current = parent;
  }
  return current.id;
}

/**
 * Group a flat list of issues (one tree's worth) into nested nodes.
 * `rootId` is the issue every node ultimately descends from.
 */
function assembleTree(
  rootId: string,
  issues: PaperclipIssue[],
  focusedAgentUuid: string,
): IssueTreeNode | null {
  const byId = new Map<string, PaperclipIssue>();
  for (const it of issues) byId.set(it.id, it);
  const root = byId.get(rootId);
  if (!root) return null;

  const childrenByParent = new Map<string, PaperclipIssue[]>();
  for (const it of issues) {
    if (it.parentId && it.id !== rootId) {
      const list = childrenByParent.get(it.parentId) ?? [];
      list.push(it);
      childrenByParent.set(it.parentId, list);
    }
  }

  // Guard against a pathological cycle inside the descendant set.
  const built = new Set<string>();
  const build = (issue: PaperclipIssue, depth: number): IssueTreeNode => {
    built.add(issue.id);
    const kids = (childrenByParent.get(issue.id) ?? [])
      .filter((c) => !built.has(c.id))
      // No `sortOrder` column exists — order siblings by createdAt asc.
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return {
      issue,
      lit: !!issue.assigneeAgentId && issue.assigneeAgentId === focusedAgentUuid,
      depth,
      children: kids.map((c) => build(c, depth + 1)),
    };
  };
  return build(root, 0);
}

/**
 * Build the focused agent's issue forest, scoped by the active bookmark.
 *
 * Scope branches:
 *   • general    — participant issues with `projectId === null`.
 *   • project    — participant issues server-filtered to the project.
 *   • issue X    — the whole sub-tree of X, shown only if the agent
 *                  participates in at least one of its nodes.
 *
 * Returns trees sorted by root `updatedAt` descending. An agent with no
 * participation in scope returns `[]`.
 */
export async function buildAgentForest(
  agentUuid: string,
  scope: BookmarkScope,
): Promise<IssueTreeNode[]> {
  if (scope.kind === 'issue') {
    return buildIssueScopedForest(agentUuid, scope.issueId);
  }

  // general / project — gather the participant set, then build forests.
  let participants: PaperclipIssue[];
  if (scope.kind === 'project') {
    participants = await fetchParticipantIssues(agentUuid, {
      projectId: scope.projectId,
    });
  } else {
    // general — no null-project sentinel exists; filter client-side.
    const all = await fetchParticipantIssues(agentUuid);
    participants = all.filter((p) => p.projectId == null);
  }
  if (participants.length === 0) return [];

  // Shared cache so ancestor walks for sibling participants are free.
  const cache = new Map<string, PaperclipIssue>();
  const rootIds = new Set<string>();
  for (const p of participants) {
    const rootId = await findRootId(p, cache);
    rootIds.add(rootId);
  }

  const trees: IssueTreeNode[] = [];
  for (const rootId of rootIds) {
    const root = cache.get(rootId) ?? (await fetchIssueById(rootId));
    if (!root) continue;
    cache.set(root.id, root);
    const descendants = await fetchIssueDescendants(rootId);
    // Merge root + descendants; de-dup defensively.
    const treeIssues = new Map<string, PaperclipIssue>();
    treeIssues.set(root.id, root);
    for (const d of descendants) treeIssues.set(d.id, d);
    const node = assembleTree(rootId, [...treeIssues.values()], agentUuid);
    if (node) trees.push(node);
  }

  trees.sort((a, b) =>
    a.issue.updatedAt < b.issue.updatedAt ? 1 : -1,
  );
  return trees;
}

/**
 * Issue-scoped forest: the sub-tree rooted at `pinnedIssueId`. Shown only
 * if the focused agent participates in at least one node of that tree —
 * matching the rule "a tree shows under an agent iff he's connected to
 * it". The tree itself is identical for every agent; only lit/off varies.
 */
async function buildIssueScopedForest(
  agentUuid: string,
  pinnedIssueId: string,
): Promise<IssueTreeNode[]> {
  const root = await fetchIssueById(pinnedIssueId);
  if (!root) return [];
  const descendants = await fetchIssueDescendants(pinnedIssueId);
  const treeIssues = new Map<string, PaperclipIssue>();
  treeIssues.set(root.id, root);
  for (const d of descendants) treeIssues.set(d.id, d);
  const treeIdSet = new Set(treeIssues.keys());

  // Does the agent participate anywhere in this tree?
  const participants = await fetchParticipantIssues(agentUuid);
  const involved = participants.some((p) => treeIdSet.has(p.id));
  if (!involved) return [];

  const node = assembleTree(root.id, [...treeIssues.values()], agentUuid);
  return node ? [node] : [];
}

/** Flatten a forest into a depth-first list of nodes — handy for lookups. */
export function flattenForest(forest: IssueTreeNode[]): IssueTreeNode[] {
  const out: IssueTreeNode[] = [];
  const walk = (node: IssueTreeNode) => {
    out.push(node);
    for (const c of node.children) walk(c);
  };
  for (const root of forest) walk(root);
  return out;
}

/** Find a node by issue id anywhere in the forest. */
export function findNodeInForest(
  forest: IssueTreeNode[],
  issueId: string,
): IssueTreeNode | null {
  for (const node of flattenForest(forest)) {
    if (node.issue.id === issueId) return node;
  }
  return null;
}

/**
 * bookmarks — the project-scoping layer for GoBoost's chat panel.
 *
 * A bookmark is a *scope*. The bookmarks bar shows one tab per scope;
 * selecting a tab re-filters every agent's issue forest. Three kinds:
 *   • general — issues with no project (`projectId === null`)
 *   • project — issues in a given project
 *   • issue   — issues within a chosen issue's sub-tree
 *
 * The bar is **curated**: it does NOT auto-show every project. It shows
 * exactly the bookmarks the user has loaded (the `order` list). A new
 * user gets all projects seeded once; after that they add/remove tabs
 * themselves (× removes from the bar — it never deletes the project).
 *
 * The arrangement (order, issue-pins, active tab) is a per-user UI
 * preference persisted in localStorage, keyed by company.
 */

import type { PaperclipProject } from './paperclipApi.js';

// ── Scope + bookmark types ──────────────────────────────────────────────────

export type BookmarkScope =
  | { kind: 'general' }
  | { kind: 'project'; projectId: string }
  | { kind: 'issue'; issueId: string };

export interface Bookmark {
  /** Stable id: '__general__' | `project:${id}` | `issue:${id}`. */
  id: string;
  scope: BookmarkScope;
  label: string;
  /** Project color, when the bookmark is a project. */
  color: string | null;
  /** True for project bookmarks — they expose × (remove) + ✏ (edit). */
  isProject: boolean;
  /** Issue-pins/projects can be removed from the bar; general cannot. */
  removable: boolean;
}

export const GENERAL_BOOKMARK_ID = '__general__';

export function projectBookmarkId(projectId: string): string {
  return `project:${projectId}`;
}
export function issueBookmarkId(issueId: string): string {
  return `issue:${issueId}`;
}

/** Extract the project id from a `project:${id}` bookmark id. */
export function projectIdFromBookmarkId(bookmarkId: string): string | null {
  return bookmarkId.startsWith('project:')
    ? bookmarkId.slice('project:'.length)
    : null;
}

// ── Persisted arrangement ───────────────────────────────────────────────────

/** A user-created issue-pin — id plus a cached label so the tab renders
 *  before the issue itself is fetched. */
export interface IssuePinRef {
  issueId: string;
  label: string;
}

/** The shape stored in localStorage (per company). */
export interface BookmarkArrangement {
  /** Bookmark ids in display order — also THE curated set of tabs. */
  order: string[];
  /** User-created issue bookmarks. */
  issuePins: IssuePinRef[];
  /** Currently-selected bookmark id. */
  activeId: string;
}

function storageKey(companyId: string): string {
  return `goboost.bookmarks.${companyId}`;
}

/**
 * Load the saved arrangement, or `null` when the user has none yet —
 * the caller seeds a first-time arrangement once projects are known.
 */
export function loadArrangement(companyId: string): BookmarkArrangement | null {
  try {
    const raw = localStorage.getItem(storageKey(companyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BookmarkArrangement>;
    return {
      order: Array.isArray(parsed.order) ? parsed.order : [GENERAL_BOOKMARK_ID],
      issuePins: Array.isArray(parsed.issuePins) ? parsed.issuePins : [],
      activeId:
        typeof parsed.activeId === 'string'
          ? parsed.activeId
          : GENERAL_BOOKMARK_ID,
    };
  } catch {
    return null;
  }
}

export function saveArrangement(
  companyId: string,
  arrangement: BookmarkArrangement,
): void {
  try {
    localStorage.setItem(storageKey(companyId), JSON.stringify(arrangement));
  } catch {
    // localStorage may be unavailable (private mode) — non-fatal.
  }
}

/**
 * Build the first-time arrangement: General plus every current project,
 * in the order the server returned them. The user prunes from here.
 */
export function seedArrangement(
  projects: PaperclipProject[],
): BookmarkArrangement {
  return {
    order: [
      GENERAL_BOOKMARK_ID,
      ...projects.map((p) => projectBookmarkId(p.id)),
    ],
    issuePins: [],
    activeId: GENERAL_BOOKMARK_ID,
  };
}

// ── Reconcile: curated arrangement × live projects ──────────────────────────

/**
 * Resolve the arrangement's `order` into rendered bookmarks.
 *   • Only ids present in `order` become tabs (the bar is curated).
 *   • Project ids resolve against the live project list; a project that
 *     was removed/archived on the server silently drops out.
 *   • Issue-pin ids resolve against `issuePins`.
 *   • General is always present and always leads.
 */
export function reconcileBookmarks(
  arrangement: BookmarkArrangement,
  projects: PaperclipProject[],
): Bookmark[] {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const issuePinById = new Map(
    arrangement.issuePins.map((p) => [issueBookmarkId(p.issueId), p]),
  );

  const out: Bookmark[] = [];
  const seen = new Set<string>();

  const pushGeneral = () => {
    if (seen.has(GENERAL_BOOKMARK_ID)) return;
    out.push({
      id: GENERAL_BOOKMARK_ID,
      scope: { kind: 'general' },
      label: 'כללי',
      color: null,
      isProject: false,
      removable: false,
    });
    seen.add(GENERAL_BOOKMARK_ID);
  };

  for (const id of arrangement.order) {
    if (seen.has(id)) continue;
    if (id === GENERAL_BOOKMARK_ID) {
      pushGeneral();
      continue;
    }
    const projectId = projectIdFromBookmarkId(id);
    if (projectId) {
      const project = projectById.get(projectId);
      if (!project) continue; // removed/archived server-side
      out.push({
        id,
        scope: { kind: 'project', projectId },
        label: project.name,
        color: project.color,
        isProject: true,
        removable: true,
      });
      seen.add(id);
      continue;
    }
    const pin = issuePinById.get(id);
    if (pin) {
      out.push({
        id,
        scope: { kind: 'issue', issueId: pin.issueId },
        label: pin.label,
        color: null,
        isProject: false,
        removable: true,
      });
      seen.add(id);
    }
  }

  // General always present and first.
  pushGeneral();
  out.sort((a, b) => {
    if (a.id === GENERAL_BOOKMARK_ID) return -1;
    if (b.id === GENERAL_BOOKMARK_ID) return 1;
    return 0;
  });
  return out;
}

/** Projects not currently loaded into the bar — the "+" menu's add list. */
export function availableProjects(
  arrangement: BookmarkArrangement,
  projects: PaperclipProject[],
): PaperclipProject[] {
  const inBar = new Set(arrangement.order);
  return projects.filter((p) => !inBar.has(projectBookmarkId(p.id)));
}

/** The scope of whichever bookmark is active — defaults to general. */
export function activeScopeOf(
  arrangement: BookmarkArrangement,
  bookmarks: Bookmark[],
): BookmarkScope {
  const active = bookmarks.find((b) => b.id === arrangement.activeId);
  return active ? active.scope : { kind: 'general' };
}

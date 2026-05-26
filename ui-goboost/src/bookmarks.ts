/**
 * bookmarks — the project-scoping layer for GoBoost's chat panel.
 *
 * Session 9.2 redesign: the bar is no longer a flat list of mixed
 * "general + projects + issue-pins" tabs. It's now split into:
 *
 *   1. A **Project Selector** chip (first slot) — chooses ONE of:
 *        • dashboard   — show everything, no filter
 *        • general     — issues with no project
 *        • <projectId> — issues in that project
 *
 *   2. **Issue-pin tabs** to the right of the selector — these belong
 *      to the *currently-selected* scope. Switching the selector
 *      swaps the visible pin set. Each scope remembers its own pins
 *      independently.
 *
 * A new ROOT issue (`parentId == null`) auto-pins itself to the
 * matching scope on `issue.created` (forward-only — no backfill).
 * If the operator removes an auto-pin, the issue id lands in
 * `removedAutoPins` and is excluded from future auto-pinning until
 * they re-add it manually (re-adding clears the suppression).
 *
 * The arrangement is persisted in localStorage per company. The
 * loader migrates the pre-9.2 flat schema into a single "dashboard"
 * scope holding the previous pins.
 */

import type { PaperclipProject } from './paperclipApi.js';

// ── Scope types ─────────────────────────────────────────────────────────────

/**
 * ProjectScope — which project filter is selected on the selector.
 * Distinct from BookmarkScope, which also includes the "drilled into
 * a specific issue tree" case that the chat panel needs.
 */
export type ProjectScope =
  | { kind: 'dashboard' }
  | { kind: 'general' }
  | { kind: 'project'; projectId: string };

/**
 * BookmarkScope — what the chat panel reads. Extends ProjectScope
 * with the `issue` variant (when a pin is active within a scope).
 */
export type BookmarkScope =
  | { kind: 'dashboard' }
  | { kind: 'general' }
  | { kind: 'project'; projectId: string }
  | { kind: 'issue'; issueId: string };

export interface Bookmark {
  /** Stable id — `issue:${issueId}` (the only bookmark kind post-9.2). */
  id: string;
  scope: BookmarkScope;
  label: string;
  /** Reserved for future per-pin coloring. */
  color: string | null;
  /** Always false post-9.2 — projects no longer appear as tabs. */
  isProject: boolean;
  /** Issue-pins are always removable. */
  removable: boolean;
}

export function issueBookmarkId(issueId: string): string {
  return `issue:${issueId}`;
}

export function issueIdFromBookmarkId(bookmarkId: string): string | null {
  return bookmarkId.startsWith('issue:')
    ? bookmarkId.slice('issue:'.length)
    : null;
}

// ── Scope serialization (for keying per-scope state) ────────────────────────

export function scopeKey(scope: ProjectScope): string {
  switch (scope.kind) {
    case 'dashboard':
      return 'dashboard';
    case 'general':
      return 'general';
    case 'project':
      return `project:${scope.projectId}`;
  }
}

export function scopeFromKey(key: string): ProjectScope | null {
  if (key === 'dashboard') return { kind: 'dashboard' };
  if (key === 'general') return { kind: 'general' };
  if (key.startsWith('project:')) {
    return { kind: 'project', projectId: key.slice('project:'.length) };
  }
  return null;
}

export function scopesEqual(a: ProjectScope, b: ProjectScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'project' && b.kind === 'project') {
    return a.projectId === b.projectId;
  }
  return true;
}

// ── Persisted arrangement ───────────────────────────────────────────────────

export interface IssuePinRef {
  issueId: string;
  label: string;
}

/** Per-scope state — pinned issues + which pin (if any) is active. */
export interface ScopeArrangement {
  pinnedIssues: IssuePinRef[];
  /** Issue id of the active pin within this scope, or null = scope-root. */
  activePinId: string | null;
}

export interface BookmarkArrangement {
  /** Currently-selected project scope (what the selector shows). */
  activeScope: ProjectScope;
  /** Per-scope state, keyed by `scopeKey(scope)`. */
  scopes: Record<string, ScopeArrangement>;
  /**
   * Issue ids the operator explicitly removed from auto-pinning.
   * Forward-only: an auto-pin won't recreate itself for these. Manual
   * re-add clears the suppression.
   */
  removedAutoPins: string[];
}

function storageKey(companyId: string): string {
  return `goboost.bookmarks.${companyId}`;
}

/**
 * Build a fresh arrangement for a brand-new user — opens on Dashboard
 * (decision locked in 9.2 planning: gives the operator the full picture
 * out of the box; they can narrow with the selector).
 */
export function seedArrangement(): BookmarkArrangement {
  return {
    activeScope: { kind: 'dashboard' },
    scopes: {},
    removedAutoPins: [],
  };
}

/**
 * Load + migrate. Recognizes both the 9.2 schema (with `activeScope`)
 * and the pre-9.2 flat schema (`order` / `issuePins` / `activeId`).
 * Old-format arrangements are migrated into a single "dashboard" scope
 * holding the prior pins — lossless from the operator's perspective.
 */
export function loadArrangement(companyId: string): BookmarkArrangement | null {
  try {
    const raw = localStorage.getItem(storageKey(companyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // ── 9.2+ schema: has `activeScope` and `scopes`. ────────────
    if (
      parsed.activeScope &&
      typeof parsed.activeScope === 'object' &&
      parsed.scopes &&
      typeof parsed.scopes === 'object'
    ) {
      const scope = parsed.activeScope as ProjectScope;
      if (
        scope.kind !== 'dashboard' &&
        scope.kind !== 'general' &&
        scope.kind !== 'project'
      ) {
        // Unknown active kind — fall back to dashboard.
        return seedArrangement();
      }
      return {
        activeScope: scope,
        scopes: parsed.scopes as Record<string, ScopeArrangement>,
        removedAutoPins: Array.isArray(parsed.removedAutoPins)
          ? (parsed.removedAutoPins as string[])
          : [],
      };
    }

    // ── Pre-9.2 schema: migrate flat issuePins into dashboard. ──
    if (Array.isArray(parsed.order) || Array.isArray(parsed.issuePins)) {
      const oldPins: IssuePinRef[] = Array.isArray(parsed.issuePins)
        ? (parsed.issuePins as IssuePinRef[])
        : [];
      return {
        activeScope: { kind: 'dashboard' },
        scopes: {
          dashboard: { pinnedIssues: oldPins, activePinId: null },
        },
        removedAutoPins: [],
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function saveArrangement(
  companyId: string,
  arrangement: BookmarkArrangement,
): void {
  try {
    localStorage.setItem(
      storageKey(companyId),
      JSON.stringify(arrangement),
    );
  } catch {
    // localStorage may be unavailable (private mode) — non-fatal.
  }
}

// ── Per-scope readers ───────────────────────────────────────────────────────

export function getScopeArrangement(
  arr: BookmarkArrangement,
  scope: ProjectScope,
): ScopeArrangement {
  return (
    arr.scopes[scopeKey(scope)] ?? {
      pinnedIssues: [],
      activePinId: null,
    }
  );
}

/**
 * The chat panel reads ONE scope: the active pin if any, else the
 * project scope itself. Maps cleanly to `BookmarkScope` semantics.
 */
export function activeChatScope(arr: BookmarkArrangement): BookmarkScope {
  const here = getScopeArrangement(arr, arr.activeScope);
  if (here.activePinId) {
    return { kind: 'issue', issueId: here.activePinId };
  }
  return arr.activeScope;
}

/**
 * Build the issue-pin tabs visible to the right of the selector. Only
 * the active scope's pins are shown.
 */
export function activeScopeBookmarks(arr: BookmarkArrangement): Bookmark[] {
  const here = getScopeArrangement(arr, arr.activeScope);
  return here.pinnedIssues.map((pin) => ({
    id: issueBookmarkId(pin.issueId),
    scope: { kind: 'issue', issueId: pin.issueId } as BookmarkScope,
    label: pin.label,
    color: null,
    isProject: false,
    removable: true,
  }));
}

// ── Per-scope mutators (pure — return a new arrangement) ────────────────────

function withScopeArrangement(
  arr: BookmarkArrangement,
  scope: ProjectScope,
  patch: ScopeArrangement,
): BookmarkArrangement {
  return {
    ...arr,
    scopes: { ...arr.scopes, [scopeKey(scope)]: patch },
  };
}

export function setActiveScope(
  arr: BookmarkArrangement,
  scope: ProjectScope,
): BookmarkArrangement {
  if (scopesEqual(arr.activeScope, scope)) return arr;
  return { ...arr, activeScope: scope };
}

export function setActivePin(
  arr: BookmarkArrangement,
  scope: ProjectScope,
  pinId: string | null,
): BookmarkArrangement {
  const here = getScopeArrangement(arr, scope);
  if (here.activePinId === pinId) return arr;
  return withScopeArrangement(arr, scope, { ...here, activePinId: pinId });
}

/**
 * Add a pin to a scope. If the issue was previously auto-pin-removed,
 * the removal flag is cleared so future auto-pin attempts work again
 * (manual re-add restores trust). Idempotent — re-pinning an already
 * pinned issue just moves it to active.
 */
export function pinIssue(
  arr: BookmarkArrangement,
  scope: ProjectScope,
  pin: IssuePinRef,
): BookmarkArrangement {
  const here = getScopeArrangement(arr, scope);
  const exists = here.pinnedIssues.some((p) => p.issueId === pin.issueId);
  const nextHere: ScopeArrangement = exists
    ? { ...here, activePinId: pin.issueId }
    : {
        pinnedIssues: [...here.pinnedIssues, pin],
        activePinId: pin.issueId,
      };
  const removedAutoPins = arr.removedAutoPins.filter(
    (id) => id !== pin.issueId,
  );
  return {
    ...withScopeArrangement(arr, scope, nextHere),
    removedAutoPins,
  };
}

/**
 * Remove a pin from a scope. The issue id is added to
 * `removedAutoPins` so the auto-pinner won't recreate it on the next
 * `issue.updated`/refetch cycle. (User can still re-add via the chat
 * panel's pin button — that clears the suppression.)
 */
export function unpinIssue(
  arr: BookmarkArrangement,
  scope: ProjectScope,
  issueId: string,
): BookmarkArrangement {
  const here = getScopeArrangement(arr, scope);
  const nextPins = here.pinnedIssues.filter((p) => p.issueId !== issueId);
  if (nextPins.length === here.pinnedIssues.length) return arr;
  const nextActive =
    here.activePinId === issueId ? null : here.activePinId;
  const removedAutoPins = arr.removedAutoPins.includes(issueId)
    ? arr.removedAutoPins
    : [...arr.removedAutoPins, issueId];
  return {
    ...withScopeArrangement(arr, scope, {
      pinnedIssues: nextPins,
      activePinId: nextActive,
    }),
    removedAutoPins,
  };
}

export function reorderPins(
  arr: BookmarkArrangement,
  scope: ProjectScope,
  orderedIds: string[],
): BookmarkArrangement {
  const here = getScopeArrangement(arr, scope);
  const byId = new Map(here.pinnedIssues.map((p) => [p.issueId, p]));
  const reordered: IssuePinRef[] = [];
  for (const id of orderedIds) {
    const pin = byId.get(id);
    if (pin) reordered.push(pin);
  }
  // Defensive: include any pin not listed in `orderedIds` to avoid
  // accidental loss if the caller passed a partial list.
  for (const pin of here.pinnedIssues) {
    if (!orderedIds.includes(pin.issueId)) reordered.push(pin);
  }
  return withScopeArrangement(arr, scope, {
    ...here,
    pinnedIssues: reordered,
  });
}

/**
 * Auto-pin entry point — called from the App's `issue.created` listener
 * for root issues. Resolves the scope from the issue's `projectId`:
 *   • `null`  → general scope
 *   • <id>    → project scope
 * Auto-pin is suppressed for issues already pinned anywhere, or
 * present in `removedAutoPins`. The dashboard scope is NOT auto-pinned
 * into — by design: dashboard is the "show everything" view, mirroring
 * a scope-specific pin into it would just duplicate.
 */
export function autoPinRootIssue(
  arr: BookmarkArrangement,
  issue: {
    id: string;
    title: string;
    identifier?: string | null;
    projectId?: string | null;
  },
): BookmarkArrangement {
  if (arr.removedAutoPins.includes(issue.id)) return arr;
  // Check if already pinned in ANY scope — avoid duplicates across
  // scopes when an issue's projectId changes after creation.
  for (const here of Object.values(arr.scopes)) {
    if (here.pinnedIssues.some((p) => p.issueId === issue.id)) return arr;
  }
  const scope: ProjectScope = issue.projectId
    ? { kind: 'project', projectId: issue.projectId }
    : { kind: 'general' };
  const label = `${issue.identifier ?? '—'} · ${issue.title}`;
  const here = getScopeArrangement(arr, scope);
  return withScopeArrangement(arr, scope, {
    pinnedIssues: [...here.pinnedIssues, { issueId: issue.id, label }],
    // Auto-pin does NOT steal active focus from whatever the operator
    // is reading; it just appears as a new tab.
    activePinId: here.activePinId,
  });
}

// ── Project-scope readability helpers (for the selector UI) ────────────────

export function isProjectScope(
  scope: ProjectScope,
): scope is { kind: 'project'; projectId: string } {
  return scope.kind === 'project';
}

export function projectScopeLabel(
  scope: ProjectScope,
  projects: PaperclipProject[],
): string {
  if (scope.kind === 'dashboard') return 'דשבורד';
  if (scope.kind === 'general') return 'כללי';
  const p = projects.find((x) => x.id === scope.projectId);
  return p?.name ?? 'פרויקט';
}

export function projectScopeColor(
  scope: ProjectScope,
  projects: PaperclipProject[],
): string | null {
  if (scope.kind !== 'project') return null;
  return projects.find((x) => x.id === scope.projectId)?.color ?? null;
}

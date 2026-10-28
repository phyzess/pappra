import { object as isRecord } from '../infra/validation.js';

export type PaneLayoutDirection = 'right' | 'down';

export interface PaneLayoutArea {
  readonly width: number;
  readonly height: number;
}

export interface PaneLayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PaneLayoutEntry {
  readonly paneId: string;
  readonly rect: PaneLayoutRect;
}

export interface PaneLayoutGeometry {
  readonly area: PaneLayoutArea;
  readonly panes: readonly PaneLayoutEntry[];
  readonly splits?: readonly unknown[];
}

export interface PanePlacementSuccess {
  readonly ok: true;
  readonly anchorPaneId: string;
  readonly direction: PaneLayoutDirection;
  readonly ratio?: number;
}

export interface PanePlacementExhausted {
  readonly ok: false;
  readonly code: 'pane_layout_exhausted';
  readonly message: string;
}

export type PanePlacement = PanePlacementSuccess | PanePlacementExhausted;

export const MIN_NEW_PANE_COLS = 40;
export const MIN_NEW_PANE_ROWS = 10;
export const FIRST_SPLIT_RATIO = 0.6;
export const SIBLING_SPLIT_RATIO = 0.5;

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseRect(value: unknown): PaneLayoutRect | null {
  if (!isRecord(value)) return null;
  const x = value['x'];
  const y = value['y'];
  const width = value['width'];
  const height = value['height'];
  if (
    !isSafeNonNegativeInteger(x) ||
    !isSafeNonNegativeInteger(y) ||
    !isSafePositiveInteger(width) ||
    !isSafePositiveInteger(height)
  )
    return null;
  return { x, y, width, height };
}

function parsePaneEntry(value: unknown): PaneLayoutEntry | null {
  if (!isRecord(value)) return null;
  const paneId = value['pane_id'];
  const rect = parseRect(value['rect']);
  if (typeof paneId !== 'string' || paneId.length === 0 || rect === null)
    return null;
  return { paneId, rect };
}

function parseArea(value: unknown): PaneLayoutArea | null {
  if (!isRecord(value)) return null;
  const width = value['width'];
  const height = value['height'];
  if (!isSafePositiveInteger(width) || !isSafePositiveInteger(height))
    return null;
  return { width, height };
}

export function parsePaneLayout(value: unknown): PaneLayoutGeometry | null {
  if (!isRecord(value)) return null;
  const area = parseArea(value['area']);
  const rawPanes = value['panes'];
  if (area === null || !Array.isArray(rawPanes) || rawPanes.length === 0)
    return null;
  const panes: PaneLayoutEntry[] = [];
  for (const raw of rawPanes) {
    const entry = parsePaneEntry(raw);
    if (entry === null) return null;
    panes.push(entry);
  }
  return { area, panes };
}

function newPaneDimensions(
  rect: PaneLayoutRect,
  direction: PaneLayoutDirection,
  ratio: number,
): { readonly width: number; readonly height: number } {
  if (direction === 'right')
    return { width: rect.width * (1 - ratio), height: rect.height };
  return { width: rect.width, height: rect.height * (1 - ratio) };
}

function meetsMinimumSize(
  rect: PaneLayoutRect,
  direction: PaneLayoutDirection,
  ratio: number,
): boolean {
  const dimensions = newPaneDimensions(rect, direction, ratio);
  return (
    dimensions.width >= MIN_NEW_PANE_COLS &&
    dimensions.height >= MIN_NEW_PANE_ROWS
  );
}

function directionForSplit(rect: PaneLayoutRect): PaneLayoutDirection {
  return rect.width > rect.height * 2 ? 'right' : 'down';
}

export function selectPanePlacement(input: {
  readonly callerPaneId: string;
  readonly layout: PaneLayoutGeometry;
  readonly siblingPaneIds: readonly string[];
  readonly explicitDirection?: PaneLayoutDirection;
}): PanePlacement {
  if (input.explicitDirection !== undefined) {
    return {
      ok: true,
      anchorPaneId: input.callerPaneId,
      direction: input.explicitDirection,
    };
  }

  const paneById = new Map<string, PaneLayoutEntry>();
  for (const pane of input.layout.panes) {
    paneById.set(pane.paneId, pane);
  }

  const caller = paneById.get(input.callerPaneId);
  if (caller === undefined) {
    return {
      ok: false,
      code: 'pane_layout_exhausted',
      message:
        'Caller pane is not present in the current layout; close or reclaim finished panes and retry.',
    };
  }

  const siblingsInLayout = input.siblingPaneIds.filter(
    (id) => id !== input.callerPaneId && paneById.has(id),
  );

  if (siblingsInLayout.length === 0) {
    if (!meetsMinimumSize(caller.rect, 'right', FIRST_SPLIT_RATIO)) {
      return {
        ok: false,
        code: 'pane_layout_exhausted',
        message:
          'Caller pane is too small to host a new pane while keeping its protected share; close or reclaim finished panes or reuse an existing participant.',
      };
    }
    return {
      ok: true,
      anchorPaneId: input.callerPaneId,
      direction: 'right',
      ratio: FIRST_SPLIT_RATIO,
    };
  }

  type Candidate = {
    readonly paneId: string;
    readonly rect: PaneLayoutRect;
    readonly area: number;
    readonly creationIndex: number;
  };

  const candidates: Candidate[] = [];
  for (let index = 0; index < siblingsInLayout.length; index += 1) {
    const paneId = siblingsInLayout[index]!;
    const entry = paneById.get(paneId);
    if (entry === undefined) continue;
    const { width, height } = entry.rect;
    candidates.push({
      paneId,
      rect: entry.rect,
      area: width * height,
      creationIndex: index,
    });
  }

  candidates.sort((left, right) => {
    if (right.area !== left.area) return right.area - left.area;
    return left.creationIndex - right.creationIndex;
  });

  for (const candidate of candidates) {
    const direction = directionForSplit(candidate.rect);
    if (!meetsMinimumSize(candidate.rect, direction, SIBLING_SPLIT_RATIO))
      continue;
    return {
      ok: true,
      anchorPaneId: candidate.paneId,
      direction,
      ratio: SIBLING_SPLIT_RATIO,
    };
  }

  return {
    ok: false,
    code: 'pane_layout_exhausted',
    message:
      'No existing task-owned sibling can host another pane while respecting the coordinator protected share; close or reclaim finished panes or reuse one.',
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_NEW_PANE_COLS,
  MIN_NEW_PANE_ROWS,
  parsePaneLayout,
  selectPanePlacement,
  type PaneLayoutGeometry,
  type PaneLayoutRect,
} from '../../src/app/collab-pane-layout.js';

function rect(
  x: number,
  y: number,
  width: number,
  height: number,
): PaneLayoutRect {
  return { x, y, width, height };
}

function layout(
  area: { width: number; height: number },
  panes: Record<string, PaneLayoutRect>,
): PaneLayoutGeometry {
  return {
    area,
    panes: Object.entries(panes).map(([paneId, rect]) => ({ paneId, rect })),
  };
}

test('first sibling splits the caller to the right with a protected 0.6 ratio', () => {
  const geometry = layout(
    { width: 230, height: 68 },
    { 'w1:p1': rect(0, 0, 230, 68) },
  );
  const result = selectPanePlacement({
    callerPaneId: 'w1:p1',
    layout: geometry,
    siblingPaneIds: [],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.anchorPaneId, 'w1:p1');
  assert.equal(result.direction, 'right');
  assert.equal(result.ratio, 0.6);
});

test('second sibling splits the largest existing sibling along its longer dimension', () => {
  const geometry = layout(
    { width: 230, height: 68 },
    {
      'w1:p1': rect(0, 0, 100, 68),
      'w1:p2': rect(100, 0, 130, 68),
    },
  );
  const result = selectPanePlacement({
    callerPaneId: 'w1:p1',
    layout: geometry,
    siblingPaneIds: ['w1:p2'],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.anchorPaneId, 'w1:p2');
  assert.equal(result.direction, 'down');
  assert.equal(result.ratio, 0.5);
});

test('third sibling still picks the largest sibling and respects creation order on ties', () => {
  const geometry = layout(
    { width: 230, height: 68 },
    {
      'w1:p1': rect(0, 0, 100, 68),
      'w1:p2': rect(100, 0, 130, 34),
      'w1:p3': rect(100, 34, 130, 34),
    },
  );
  const result = selectPanePlacement({
    callerPaneId: 'w1:p1',
    layout: geometry,
    siblingPaneIds: ['w1:p2', 'w1:p3'],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.anchorPaneId, 'w1:p2');
  assert.equal(result.direction, 'right');
  assert.equal(result.ratio, 0.5);
});

test('wide sibling splits right when width is more than twice the height', () => {
  const geometry = layout(
    { width: 300, height: 60 },
    {
      'w1:p1': rect(0, 0, 100, 60),
      'w1:p2': rect(100, 0, 200, 60),
    },
  );
  const result = selectPanePlacement({
    callerPaneId: 'w1:p1',
    layout: geometry,
    siblingPaneIds: ['w1:p2'],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.direction, 'right');
});

test('exhausted when the caller is too small for the protected first split', () => {
  const geometry = layout(
    { width: 80, height: 20 },
    { 'w1:p1': rect(0, 0, 80, 20) },
  );
  const result = selectPanePlacement({
    callerPaneId: 'w1:p1',
    layout: geometry,
    siblingPaneIds: [],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'pane_layout_exhausted');
  assert.ok(result.message.includes('close or reclaim'));
});

test('exhausted when no sibling can host another pane and the coordinator is protected', () => {
  const geometry = layout(
    { width: 230, height: 68 },
    {
      'w1:p1': rect(0, 0, 200, 68),
      'w1:p2': rect(200, 0, 30, 68),
    },
  );
  const result = selectPanePlacement({
    callerPaneId: 'w1:p1',
    layout: geometry,
    siblingPaneIds: ['w1:p2'],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'pane_layout_exhausted');
});

test('explicit direction keeps legacy caller split without a ratio', () => {
  const geometry = layout(
    { width: 230, height: 68 },
    {
      'w1:p1': rect(0, 0, 100, 68),
      'w1:p2': rect(100, 0, 130, 68),
    },
  );
  const result = selectPanePlacement({
    callerPaneId: 'w1:p1',
    layout: geometry,
    siblingPaneIds: ['w1:p2'],
    explicitDirection: 'down',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.anchorPaneId, 'w1:p1');
  assert.equal(result.direction, 'down');
  assert.equal(result.ratio, undefined);
});

test('parsePaneLayout rejects malformed herdr layout payloads', () => {
  assert.equal(parsePaneLayout(null), null);
  assert.equal(parsePaneLayout({ area: { width: 10, height: 10 } }), null);
  assert.equal(
    parsePaneLayout({
      area: { width: 10, height: 10 },
      panes: [
        { pane_id: 'w1:p1', rect: { x: 0, y: 0, width: -1, height: 10 } },
      ],
    }),
    null,
  );
});

test('minimum pane constants are frozen', () => {
  assert.equal(MIN_NEW_PANE_COLS, 40);
  assert.equal(MIN_NEW_PANE_ROWS, 10);
});

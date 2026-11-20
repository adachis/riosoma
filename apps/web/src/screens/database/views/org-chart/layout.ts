import type { FieldMeta, RowData } from '@riosoma/contracts';
import { listModel, type ListModel, type RecordLine } from '../list/model';

export const CARD_WIDTH = 240;
export const COLUMN_GAP = 32;
export const LEVEL_GAP = 64;
export const cardHeight = (fields: number) => 60 + fields * 24;

export interface ChartNode extends RecordLine {
  x: number;
  y: number;
}
export interface ChartLayout {
  tree: ListModel;
  nodes: ChartNode[];
  byId: ReadonlyMap<string, ChartNode>;
  width: number;
  height: number;
  cardHeight: number;
}

/** Lay out leaves first, then center each parent over its children without recursive calls. */
export function chartLayout(
  rows: ReadonlyArray<RowData | undefined>,
  field: FieldMeta,
  collapsed: ReadonlySet<string>,
  height: number,
): ChartLayout {
  const tree = listModel(rows, { kind: 'outline', field }, collapsed, (keys) => keys);
  const nodes = tree.lines
    .filter((line): line is RecordLine => line.kind === 'record')
    .map((line) => ({ ...line, x: 0, y: (line.level - 1) * (height + LEVEL_GAP) }));
  const byId = new Map(nodes.map((node) => [node.key, node]));
  let leaf = 0;
  let bottom = 0;
  for (const node of nodes) {
    if (!node.expanded) {
      node.x = leaf * (CARD_WIDTH + COLUMN_GAP);
      leaf++;
    }
    bottom = Math.max(bottom, node.y + height);
  }
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!;
    if (!node.expanded) continue;
    const children = tree.children.get(node.key)!;
    node.x = (byId.get(children[0]!)!.x + byId.get(children[children.length - 1]!)!.x) / 2;
  }
  return {
    tree,
    nodes,
    byId,
    width: Math.max(0, leaf * (CARD_WIDTH + COLUMN_GAP) - COLUMN_GAP),
    height: bottom,
    cardHeight: height,
  };
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}
export interface Bounds {
  width: number;
  height: number;
}

export function fitChart(layout: ChartLayout, size: Bounds): Camera {
  const zoom = Math.max(
    0.00001,
    Math.min(
      1,
      (size.width - 32) / Math.max(1, layout.width),
      (size.height - 32) / Math.max(1, layout.height),
    ),
  );
  return { zoom, x: (size.width - layout.width * zoom) / 2, y: (size.height - layout.height * zoom) / 2 };
}

export function centerNode(node: ChartNode, height: number, size: Bounds, zoom: number): Camera {
  return {
    zoom,
    x: size.width / 2 - (node.x + CARD_WIDTH / 2) * zoom,
    y: size.height / 2 - (node.y + height / 2) * zoom,
  };
}

/** Only intersecting cards and connectors enter the SVG, plus the focused card for accessibility. */
export function visibleChart(
  layout: ChartLayout,
  camera: Camera,
  size: Bounds,
  active: string | null = null,
) {
  const left = -camera.x / camera.zoom;
  const top = -camera.y / camera.zoom;
  const right = left + size.width / camera.zoom;
  const bottom = top + size.height / camera.zoom;
  const intersects = (x1: number, y1: number, x2: number, y2: number) =>
    x2 >= left && x1 <= right && y2 >= top && y1 <= bottom;
  const nodes = layout.nodes.filter(
    (node) =>
      node.key === active || intersects(node.x, node.y, node.x + CARD_WIDTH, node.y + layout.cardHeight),
  );
  const edges: Array<{ key: string; path: string }> = [];
  const segment = (key: string, x1: number, y1: number, x2: number, y2: number) => {
    if (!intersects(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2))) return;
    // Clip the shared bus to each viewport or print tile instead of repeating its full width.
    edges.push({
      key,
      path: `M${Math.max(left, Math.min(right, x1))},${Math.max(top, Math.min(bottom, y1))} L${Math.max(left, Math.min(right, x2))},${Math.max(top, Math.min(bottom, y2))}`,
    });
  };
  for (const node of layout.nodes) {
    const x = node.x + CARD_WIDTH / 2;
    const parent = node.parent ? layout.byId.get(node.parent) : undefined;
    if (parent)
      segment(`${node.key}:drop`, x, node.y - (parent.children === 1 ? LEVEL_GAP : LEVEL_GAP / 2), x, node.y);
    if (!node.expanded || node.children === 1) continue;
    const children = layout.tree.children.get(node.key)!;
    const first = layout.byId.get(children[0]!)!;
    const last = layout.byId.get(children[children.length - 1]!)!;
    const y = node.y + layout.cardHeight;
    segment(`${node.key}:stub`, x, y, x, y + LEVEL_GAP / 2);
    if (first !== last)
      segment(
        `${node.key}:bus`,
        first.x + CARD_WIDTH / 2,
        y + LEVEL_GAP / 2,
        last.x + CARD_WIDTH / 2,
        y + LEVEL_GAP / 2,
      );
  }
  return { nodes, edges };
}

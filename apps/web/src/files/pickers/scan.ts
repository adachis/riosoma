import { recoverImport } from '../../asset-recovery';
export interface Point {
  x: number;
  y: number;
}
export type Corners = [Point, Point, Point, Point];
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function validCorners(points: Corners): boolean {
  return points.every(
    (point, index) =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      distance(point, points[(index + 1) % 4]!) > 2 &&
      cross(point, points[(index + 1) % 4]!, points[(index + 2) % 4]!) > 4,
  );
}

function hull(points: Point[]): Point[] {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (values: Point[]) => {
    const output: Point[] = [];
    for (const point of values) {
      while (output.length > 1 && cross(output.at(-2)!, output.at(-1)!, point) <= 0) output.pop();
      output.push(point);
    }
    return output.slice(0, -1);
  };
  return [...half(points), ...half([...points].reverse())];
}

/** Threshold the page against its background, then fit four edges to its largest enclosed contour. */
export function detectEdges(image: Raster): Corners {
  const { width, height, data } = image;
  const full: Corners = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const gray = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < gray.length; i++) {
    const value = Math.round(data[i * 4]! * 0.299 + data[i * 4 + 1]! * 0.587 + data[i * 4 + 2]! * 0.114);
    gray[i] = value;
    histogram[value] = histogram[value]! + 1;
    total += value;
  }
  let count = 0,
    sum = 0,
    threshold = 127,
    best = 0;
  for (let value = 0; value < 255; value++) {
    count += histogram[value]!;
    sum += value * histogram[value]!;
    if (!count || count === gray.length) continue;
    const variance =
      count * (gray.length - count) * (sum / count - (total - sum) / (gray.length - count)) ** 2;
    if (variance > best) {
      best = variance;
      threshold = value;
    }
  }
  if (!best) return full;
  let largest = width * height * 0.12;
  let result = full;
  const queue = new Int32Array(gray.length);
  for (const bright of [true, false]) {
    const seen = new Uint8Array(gray.length);
    for (let start = 0; start < gray.length; start++) {
      if (seen[start] || gray[start]! > threshold !== bright) continue;
      let head = 0,
        tail = 1,
        frame = 0;
      queue[0] = start;
      seen[start] = 1;
      const contour: Point[] = [];
      while (head < tail) {
        const index = queue[head++]!,
          x = index % width,
          y = Math.floor(index / width);
        let edge = false;
        if (!x || !y || x === width - 1 || y === height - 1) frame++;
        for (const next of [
          x ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          y ? index - width : -1,
          y < height - 1 ? index + width : -1,
        ]) {
          if (next < 0 || gray[next]! > threshold !== bright) {
            edge = true;
            continue;
          }
          if (!seen[next]) {
            seen[next] = 1;
            queue[tail++] = next;
          }
        }
        if (edge) contour.push({ x, y });
      }
      if (tail <= largest || frame > (width + height) * 0.1) continue;
      const polygon = hull(contour);
      // Removing the least significant hull bends keeps the four dominant page corners.
      while (polygon.length > 4) {
        let remove = 0,
          smallest = Infinity;
        for (let i = 0; i < polygon.length; i++) {
          const area = Math.abs(
            cross(
              polygon[(i + polygon.length - 1) % polygon.length]!,
              polygon[i]!,
              polygon[(i + 1) % polygon.length]!,
            ),
          );
          if (area < smallest) {
            smallest = area;
            remove = i;
          }
        }
        polygon.splice(remove, 1);
      }
      if (polygon.length !== 4) continue;
      let first = 0;
      polygon.forEach((p, i) => {
        if (p.x + p.y < polygon[first]!.x + polygon[first]!.y) first = i;
      });
      const corners = [...polygon.slice(first), ...polygon.slice(0, first)] as Corners;
      if (validCorners(corners)) {
        result = corners;
        largest = tail;
      }
    }
  }
  return result;
}

/** Map a rectangle through a projective homography, with bilinear sampling to avoid jagged text. */
export function perspective(image: Raster, corners: Corners, blackAndWhite = false): Raster {
  if (!validCorners(corners)) throw new Error('invalid scan corners');
  const [a, b, c, d] = corners;
  const width = Math.max(2, Math.round(Math.max(distance(a, b), distance(c, d))));
  const height = Math.max(2, Math.round(Math.max(distance(a, d), distance(b, c))));
  const scale = Math.min(1, 2200 / Math.max(width, height));
  const output: Raster = {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
    data: new Uint8ClampedArray(0),
  };
  output.data = new Uint8ClampedArray(output.width * output.height * 4);
  const dx1 = b.x - c.x,
    dx2 = d.x - c.x,
    dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y,
    dy2 = d.y - c.y,
    dy3 = a.y - b.y + c.y - d.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / determinant;
  const h = (dx1 * dy3 - dx3 * dy1) / determinant;
  for (let y = 0; y < output.height; y++)
    for (let x = 0; x < output.width; x++) {
      const u = x / (output.width - 1),
        v = y / (output.height - 1),
        denominator = g * u + h * v + 1;
      const sx = Math.max(
        0,
        Math.min(
          image.width - 1,
          ((b.x - a.x + g * b.x) * u + (d.x - a.x + h * d.x) * v + a.x) / denominator,
        ),
      );
      const sy = Math.max(
        0,
        Math.min(
          image.height - 1,
          ((b.y - a.y + g * b.y) * u + (d.y - a.y + h * d.y) * v + a.y) / denominator,
        ),
      );
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        fx = sx - x0,
        fy = sy - y0;
      const index = (y * output.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const at = (px: number, py: number) => image.data[(py * image.width + px) * 4 + channel]!;
        output.data[index + channel] =
          at(x0, y0) * (1 - fx) * (1 - fy) +
          at(Math.min(x0 + 1, image.width - 1), y0) * fx * (1 - fy) +
          at(x0, Math.min(y0 + 1, image.height - 1)) * (1 - fx) * fy +
          at(Math.min(x0 + 1, image.width - 1), Math.min(y0 + 1, image.height - 1)) * fx * fy;
      }
      if (blackAndWhite) {
        const value =
          output.data[index]! * 0.299 + output.data[index + 1]! * 0.587 + output.data[index + 2]! * 0.114 >=
          150
            ? 255
            : 0;
        output.data.fill(value, index, index + 3);
      }
      output.data[index + 3] = 255;
    }
  return output;
}

export async function scanPdf(pages: string[], name: string): Promise<File> {
  const pdfmake = await recoverImport(() => import('pdfmake/build/pdfmake'));
  const blob = await pdfmake.default
    .createPdf({
      pageSize: 'LETTER',
      pageMargins: 24,
      content: pages.map((image, index) => ({
        image,
        fit: [564, 744],
        alignment: 'center',
        ...(index ? { pageBreak: 'before' as const } : {}),
      })),
    })
    .getBlob();
  return new File([blob], name, { type: 'application/pdf' });
}

export interface CameraPoint { x: number; y: number }
export interface CameraLimits { minZoom: number; maxZoom: number; fitZoom: number; center: CameraPoint }

export function cameraLimits(nodes: CameraPoint[], width: number, height: number): CameraLimits {
  const finite = nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (!finite.length || width <= 0 || height <= 0) return { minZoom: .1, maxZoom: 8, fitZoom: 1, center: { x: 0, y: 0 } };
  const xs = finite.map(n => n.x), ys = finite.map(n => n.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const fitZoom = Math.max(.01, Math.min(2, Math.max(60, width - 110) / Math.max(70, right - left + 30), Math.max(60, height - 110) / Math.max(70, bottom - top + 30)));
  return { minZoom: fitZoom * .7, maxZoom: Math.max(3, fitZoom * 10), fitZoom, center: { x: (left + right) / 2, y: (top + bottom) / 2 } };
}

/** Constrain the camera itself, never the node layout or a delayed spring animation. */
export function keepGraphVisible(center: CameraPoint, zoom: number, nodes: CameraPoint[], width: number, height: number): CameraPoint {
  if (!nodes.length || !Number.isFinite(zoom) || zoom <= 0) return center;
  const halfWidth = Math.max(15, width / 2 - 45) / zoom;
  const halfHeight = Math.max(15, height / 2 - 45) / zoom;
  if (nodes.some(n => Math.abs(n.x - center.x) <= halfWidth && Math.abs(n.y - center.y) <= halfHeight)) return center;
  const nearest = nodes.reduce((best, n) => Math.hypot(n.x - center.x, n.y - center.y) < Math.hypot(best.x - center.x, best.y - center.y) ? n : best, nodes[0]);
  return { x: Math.max(nearest.x - halfWidth, Math.min(nearest.x + halfWidth, center.x)), y: Math.max(nearest.y - halfHeight, Math.min(nearest.y + halfHeight, center.y)) };
}

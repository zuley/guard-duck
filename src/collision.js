import { segmentTouchesCircle } from './rules.js';

export const QWEN_BLADE_HALF_WIDTH = 1.25;
export const QWEN_BLADE_HEIGHT_PAD = 0.26;
export const QWEN_BLADE_DEPTH_SCALE = 2.7;
export const QWEN_BLADE_FRONT_DEPTH = (0.57 - 0.14) * 0.5 * QWEN_BLADE_DEPTH_SCALE;

export function bladeTouchesEnemy(pos, stride, direction, enemy) {
  const dx = pos.x - enemy.pos.x, dz = pos.z - enemy.pos.z;
  const depth = enemy.radius + QWEN_BLADE_FRONT_DEPTH;
  const width = enemy.radius + QWEN_BLADE_HALF_WIDTH;
  const along = (dx * direction.x + dz * direction.z) / depth;
  const across = (dx * direction.z - dz * direction.x) / width;
  return segmentTouchesCircle(along, across, stride / depth, 0, 0, 0, 1);
}

export function segBlocked(a, b, colliders) {
  const steps = 10;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    for (const c of colliders) {
      if (c.hx !== undefined) {
        if (Math.abs(x - c.x) < c.hx && Math.abs(z - c.z) < c.hz) return true;
      } else if (Math.hypot(x - c.x, z - c.z) < c.r) return true;
    }
  }
  return false;
}

export function pointBlocked(x, z, colliders) {
  for (const c of colliders) {
    if (c.hx !== undefined) {
      if (Math.abs(x - c.x) < c.hx && Math.abs(z - c.z) < c.hz) return true;
    } else if (Math.hypot(x - c.x, z - c.z) < c.r) return true;
  }
  return false;
}

export function blockerTime(x, z, dx, dz, colliders) {
  let first = Infinity;
  const lengthSq = dx * dx + dz * dz;
  for (const c of colliders) {
    const ox = x - c.x, oz = z - c.z;
    if (c.hx !== undefined) {
      if (Math.abs(ox) > c.hx + Math.abs(dx) || Math.abs(oz) > c.hz + Math.abs(dz)) continue;
      let enter = 0, exit = 1;
      for (const [offset, delta, halfSize] of [[ox, dx, c.hx], [oz, dz, c.hz]]) {
        if (delta === 0) {
          if (Math.abs(offset) > halfSize) { enter = Infinity; break; }
        } else {
          const a = (-halfSize - offset) / delta, b = (halfSize - offset) / delta;
          enter = Math.max(enter, Math.min(a, b));
          exit = Math.min(exit, Math.max(a, b));
        }
      }
      if (enter <= exit) first = Math.min(first, enter);
    } else {
      if (Math.abs(ox) > c.r + Math.abs(dx) || Math.abs(oz) > c.r + Math.abs(dz)) continue;
      const offsetSq = ox * ox + oz * oz - c.r * c.r;
      if (offsetSq <= 0) return 0;
      if (!lengthSq) continue;
      const along = ox * dx + oz * dz;
      const disc = along * along - lengthSq * offsetSq;
      if (disc < 0) continue;
      const t = (-along - Math.sqrt(disc)) / lengthSq;
      if (t >= 0 && t <= 1) first = Math.min(first, t);
    }
  }
  return first;
}

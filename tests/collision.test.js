import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  QWEN_BLADE_HALF_WIDTH, QWEN_BLADE_FRONT_DEPTH,
  bladeTouchesEnemy, segBlocked, pointBlocked, blockerTime,
} from '../src/collision.js';

describe('collision 几何与掩体碰撞', () => {
  const boxCollider = { x: 4, z: 0, hx: 1, hz: 2 };
  const circleCollider = { x: -4, z: 0, r: 1.5 };
  const colliders = [boxCollider, circleCollider];

  it('pointBlocked 检测矩形与圆形掩体内部及边界外', () => {
    expect(pointBlocked(4, 0, colliders)).toBe(true);
    expect(pointBlocked(4.99, 1.99, colliders)).toBe(true);
    expect(pointBlocked(5.01, 0, colliders)).toBe(false);
    expect(pointBlocked(-4, 1.49, colliders)).toBe(true);
    expect(pointBlocked(-4, 1.51, colliders)).toBe(false);
  });

  it('segBlocked 检测穿过掩体的线段', () => {
    expect(segBlocked({ x: 0, z: 0 }, { x: 8, z: 0 }, colliders)).toBe(true);
    expect(segBlocked({ x: 0, z: 0 }, { x: -8, z: 0 }, colliders)).toBe(true);
    expect(segBlocked({ x: 0, z: 5 }, { x: 8, z: 5 }, colliders)).toBe(false);
  });

  it('blockerTime 计算射线进入矩形与圆形掩体的最早归一化时刻 [0, 1]', () => {
    // 从 (0,0) 向 (+10, 0) 发射，矩形左边缘在 x = 3，t = 0.3
    expect(blockerTime(0, 0, 10, 0, [boxCollider])).toBeCloseTo(0.3, 5);
    // 从 (0,0) 向 (-10, 0) 发射，圆右边缘在 x = -2.5，t = 0.25
    expect(blockerTime(0, 0, -10, 0, [circleCollider])).toBeCloseTo(0.25, 5);
    // 起点已在圆内返回 0
    expect(blockerTime(-4, 0, 1, 0, [circleCollider])).toBe(0);
    // 无交点返回 Infinity
    expect(blockerTime(0, 5, 10, 0, colliders)).toBe(Infinity);
  });

  it('bladeTouchesEnemy 按半月刀宽幅与前缘深度判定擦边命中', () => {
    const dir = new THREE.Vector3(0, 0, 1);
    const enemy = { pos: new THREE.Vector3(0, 0, 5), radius: 0.5 };
    const hitPos = new THREE.Vector3(QWEN_BLADE_HALF_WIDTH + 0.45, 0, 5.1);
    expect(bladeTouchesEnemy(hitPos, 0.5, dir, enemy)).toBe(true);
    const missPos = new THREE.Vector3(QWEN_BLADE_HALF_WIDTH + 0.55, 0, 5.1);
    expect(bladeTouchesEnemy(missPos, 0.5, dir, enemy)).toBe(false);
    // 纵向尚未进入前缘深度时不命中
    const earlyPos = new THREE.Vector3(0, 0, 5 - QWEN_BLADE_FRONT_DEPTH - 0.6);
    expect(bladeTouchesEnemy(earlyPos, 0.05, dir, enemy)).toBe(false);
  });
});

import * as THREE from 'three';

const NOZZLE_Z = -0.44;
const TRAIL_LIFE = 0.32;
const TRAIL_POINTS = 32;
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _tangent = new THREE.Vector3();
const _side = new THREE.Vector3();
const _edge = new THREE.Vector3();

function lathe(profile) {
  return new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), 16).rotateX(Math.PI / 2);
}

const hullGeo = lathe([[0, -0.41], [0.105, -0.41], [0.14, -0.32], [0.14, 0.18], [0.126, 0.24]]);
const noseGeo = lathe([[0.126, 0.24], [0.112, 0.33], [0.084, 0.43], [0.045, 0.51], [0, 0.55]]);
const collarGeo = new THREE.TorusGeometry(0.137, 0.012, 6, 16);
const nozzleGeo = new THREE.TorusGeometry(0.085, 0.024, 8, 16);
const fin = new THREE.Shape();
fin.moveTo(0.125, -0.13);
fin.lineTo(0.27, -0.34);
fin.lineTo(0.235, -0.41);
fin.lineTo(0.105, -0.37);
fin.closePath();
const finGeo = new THREE.ShapeGeometry(fin).rotateX(Math.PI / 2);
const flameGeo = lathe([[0, -1], [0.035, -0.8], [0.078, -0.44], [0.1, -0.16], [0.073, 0]]);

const ceramic = new THREE.MeshStandardMaterial({ color: 0xffe2c2, roughness: 0.46, metalness: 0.24 });
const copper = new THREE.MeshStandardMaterial({ color: 0xd97757, roughness: 0.44, metalness: 0.4, emissive: 0x502012 });
const graphite = new THREE.MeshStandardMaterial({ color: 0x382622, roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide });
const coreMaterial = new THREE.MeshBasicMaterial({ color: 0xffefd1, toneMapped: false, side: THREE.DoubleSide });
const glowMaterials = new Map();
const trailMaterial = new THREE.MeshBasicMaterial({
  vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
});

function glowMaterial(color) {
  if (!glowMaterials.has(color)) {
    glowMaterials.set(color, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    }));
  }
  return glowMaterials.get(color);
}

export class ClaudeMissileVisual extends THREE.Group {
  constructor(color) {
    super();
    this.airframe = new THREE.Group();
    this.add(this.airframe);
    this.airframe.add(new THREE.Mesh(hullGeo, ceramic), new THREE.Mesh(noseGeo, copper));
    for (const z of [-0.21, 0.17]) {
      const collar = new THREE.Mesh(collarGeo, copper);
      collar.position.z = z;
      this.airframe.add(collar);
    }
    const nozzle = new THREE.Mesh(nozzleGeo, graphite);
    nozzle.position.z = NOZZLE_Z;
    this.airframe.add(nozzle);
    for (let i = 0; i < 4; i++) {
      const wing = new THREE.Mesh(finGeo, graphite);
      wing.rotation.z = (i + 0.5) * Math.PI / 2;
      this.airframe.add(wing);
    }

    this.exhaust = new THREE.Group();
    this.exhaust.position.z = NOZZLE_Z;
    const glow = new THREE.Mesh(flameGeo, glowMaterial(color));
    const core = new THREE.Mesh(flameGeo, coreMaterial);
    core.scale.set(0.56, 0.56, 0.48);
    this.exhaust.add(glow, core);
    this.airframe.add(this.exhaust);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 8), 4).setUsage(THREE.DynamicDrawUsage));
    const indices = [];
    for (let i = 0; i < (TRAIL_POINTS - 1) * 2; i += 2) indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);
    const trail = new THREE.Mesh(geometry, trailMaterial);
    trail.frustumCulled = false;
    this.add(trail);
    this.trailGeometry = geometry;
    this.trailColor = new THREE.Color(color).lerp(new THREE.Color(0xffe0a6), 0.45);
    this.history = [];
    this.age = 0;
    this.heading = new THREE.Vector3();
  }

  advance(velocity, dt, camera) {
    const direction = _dir.copy(velocity).normalize();
    const turn = this.heading.z * direction.x - this.heading.x * direction.z;
    const bank = THREE.MathUtils.clamp(-turn / Math.max(dt, 0.01) * 0.12, -0.68, 0.68);
    this.airframe.rotation.z = THREE.MathUtils.lerp(this.airframe.rotation.z, bank, 1 - Math.exp(-14 * dt));
    this.heading.copy(direction);
    this.lookAt(_look.copy(this.position).add(direction));
    this.age += dt;
    const pulse = Math.sin(this.age * 54);
    this.exhaust.scale.set(1 + pulse * 0.09, 1 + pulse * 0.09, 0.9 + pulse * 0.14);

    const nozzle = direction.clone().multiplyScalar(NOZZLE_Z).add(this.position);
    this.history.push({ point: nozzle, time: this.age });
    while (this.history.length > TRAIL_POINTS || this.age - this.history[0].time > TRAIL_LIFE) this.history.shift();
    this.updateTrail(camera);
    return nozzle;
  }

  updateTrail(camera) {
    const { position, color } = this.trailGeometry.attributes;
    const { r, g, b } = this.trailColor;
    const inverse = _inv.copy(this.quaternion).invert();
    const last = this.history.length - 1;
    for (let i = 0; i <= last; i++) {
      const { point, time } = this.history[i];
      const fade = Math.max(0, 1 - (this.age - time) / TRAIL_LIFE);
      const width = 0.11 * fade;
      _tangent.subVectors(this.history[Math.min(i + 1, last)].point, this.history[Math.max(i - 1, 0)].point);
      _side.subVectors(camera.position, point).cross(_tangent).normalize();
      for (let j = 0; j < 2; j++) {
        _edge.copy(point).addScaledVector(_side, j ? width : -width).sub(this.position).applyQuaternion(inverse);
        position.setXYZ(i * 2 + j, _edge.x, _edge.y, _edge.z);
        color.setXYZW(i * 2 + j, r, g, b, 0.58 * fade * fade);
      }
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.trailGeometry.setDrawRange(0, last * 6);
  }

  dispose() {
    this.trailGeometry.dispose();
  }
}

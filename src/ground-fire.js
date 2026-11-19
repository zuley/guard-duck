import * as THREE from 'three';
import { groundHeight } from './world.js';

export const FIRST_EMBER_LANDING = 0.24;
export const LAST_EMBER_LANDING = 0.82;

const flameGeometry = new THREE.PlaneGeometry(1, 1);

const groundVertex = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const groundFragment = /* glsl */`
  varying vec2 vUv;
  uniform float uTime;
  uniform float uFade;
  uniform vec2 uLanding;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float landing = mix(uLanding.x, uLanding.y, r);
    float lit = smoothstep(landing, landing + 0.09, uTime);
    float rim = smoothstep(0.83, 0.98, r) * (1.0 - smoothstep(0.98, 1.0, r));
    float embers = sin(p.x * 24.0 + p.y * 18.0 + uTime * 2.8) * cos(p.y * 25.0 - p.x * 13.0 - uTime * 2.2);
    float heat = smoothstep(0.32, 0.86, embers) * (1.0 - smoothstep(0.74, 1.0, r));
    vec3 color = mix(vec3(0.27, 0.047, 0.012), vec3(1.0, 0.47, 0.095), max(rim, heat));
    gl_FragColor = vec4(color, (0.23 + rim * 0.35 + heat * 0.24) * uFade * lit);
  }
`;

const flameVertex = /* glsl */`
  uniform float uTime;
  uniform float uRadius;
  uniform float uImpactHeight;
  uniform vec2 uLanding;
  varying vec2 vUv;
  varying float vPhase;
  varying float vLandedFor;
  void main() {
    vUv = uv;
    vec4 foot = instanceMatrix[3];
    vPhase = foot.x * 4.3 + foot.z * 7.1;
    float radiusRatio = length(foot.xz) / uRadius;
    float landing = mix(uLanding.x, uLanding.y, radiusRatio);
    vLandedFor = uTime - landing;
    float flight = clamp(uTime / landing, 0.0, 1.0);
    vec4 air = mix(vec4(0.0, uImpactHeight, 0.0, 1.0), foot, flight);
    air.y += flight * (1.0 - flight) * (2.5 + radiusRatio * 4.2);
    vec4 center = modelViewMatrix * air;
    if (vLandedFor < 0.0) {
      center.xy += vec2(position.x * 0.25, position.y * 0.34);
    } else {
      float pulse = 0.85 + 0.15 * sin(uTime * 11.0 + vPhase);
      float growth = 0.4 + 0.6 * smoothstep(0.0, 0.18, vLandedFor);
      center.xy += vec2(position.x * instanceMatrix[0].x, uv.y * instanceMatrix[1].y * pulse) * growth;
    }
    gl_Position = projectionMatrix * center;
  }
`;

const flameFragment = /* glsl */`
  uniform float uTime;
  uniform float uFade;
  varying vec2 vUv;
  varying float vPhase;
  varying float vLandedFor;
  void main() {
    if (vLandedFor < 0.0) {
      float core = 1.0 - smoothstep(0.05, 0.5, length(vUv - 0.5));
      gl_FragColor = vec4(vec3(1.0, 0.56, 0.12), core * 0.9);
      return;
    }
    float y = vUv.y;
    float sway = 0.24 * y * sin(uTime * 6.0 + vPhase + 5.0 * y);
    float width = mix(0.37, 0.04, y) * (0.89 + 0.11 * sin(16.0 * y + uTime * 12.0 + vPhase));
    float edge = abs(vUv.x - 0.5 - sway) / width;
    float mask = (1.0 - smoothstep(0.12, 1.0, edge)) * smoothstep(0.0, 0.1, y) * (1.0 - smoothstep(0.62, 1.0, y));
    vec3 color = mix(vec3(1.0, 0.16, 0.025), vec3(1.0, 0.75, 0.22), (1.0 - y) * (1.0 - min(edge, 1.0)));
    gl_FragColor = vec4(color, mask * uFade * smoothstep(0.0, 0.12, vLandedFor) * 0.9);
  }
`;

export class GroundFireVisual extends THREE.Group {
  constructor(pos, radius) {
    super();
    this.position.set(pos.x, groundHeight(pos.x, pos.z), pos.z);
    this.uniforms = {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uRadius: { value: radius },
      uImpactHeight: { value: Math.max(0.065, pos.y - this.position.y) },
      uLanding: { value: new THREE.Vector2(FIRST_EMBER_LANDING, LAST_EMBER_LANDING) },
    };
    const ground = new THREE.RingGeometry(0, radius, 48, 8).rotateX(-Math.PI / 2);
    const vertices = ground.attributes.position;
    for (let i = 0; i < vertices.count; i++) {
      vertices.setY(i, groundHeight(pos.x + vertices.getX(i), pos.z + vertices.getZ(i)) - this.position.y + 0.055);
    }
    const groundMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: groundVertex, fragmentShader: groundFragment,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    const groundMesh = new THREE.Mesh(ground, groundMaterial);
    groundMesh.visible = false;
    this.add(groundMesh);

    const flameMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: flameVertex, fragmentShader: flameFragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const count = 24;
    const flames = new THREE.InstancedMesh(flameGeometry, flameMaterial, count);
    flames.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      const distance = radius * Math.sqrt(i / (count - 1));
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      matrix.makeScale(0.75 + (i % 4) * 0.12, 0.65 + (i % 5) * 0.15, 1);
      matrix.setPosition(x, groundHeight(pos.x + x, pos.z + z) - this.position.y + 0.065, z);
      flames.setMatrixAt(i, matrix);
    }
    flames.instanceMatrix.needsUpdate = true;
    flames.renderOrder = 1;
    this.add(flames);
  }

  update(age, remaining) {
    this.children[0].visible = age >= FIRST_EMBER_LANDING;
    this.uniforms.uTime.value = age;
    this.uniforms.uFade.value = Math.min(1, remaining / 0.55);
  }

  dispose() {
    this.children[0].geometry.dispose();
    this.children[0].material.dispose();
    this.children[1].material.dispose();
    this.children[1].dispose();
  }
}

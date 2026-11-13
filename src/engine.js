import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { resolveQuality } from './quality.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.34 },
    uGrain: { value: 0.035 },
    uAberration: { value: 0.0016 },
    uDamage: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberration, uDamage;
    varying vec2 vUv;
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    void main() {
      vec2 uv = vUv;
      vec2 off = (uv - 0.5) * uAberration * (1.0 + uDamage * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, col * vec3(1.04, 1.0, 0.94), smoothstep(0.45, 1.0, l));
      col = mix(col, col * vec3(0.94, 0.98, 1.06), smoothstep(0.45, 0.0, l));
      col = mix(col, vec3(0.75, 0.08, 0.05), uDamage * 0.35 * smoothstep(0.3, 0.9, length(uv - 0.5)));
      float d = length(uv - 0.5) * 1.55;
      col *= 1.0 - uVignette * smoothstep(0.55, 1.35, d);
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7);
      col += (g - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Engine {
  constructor(container, quality = 'high') {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    this.software = /swiftshader|software|llvmpipe|basic render/i.test(String(glRenderer));
    this.preset = resolveQuality(quality, this.software);
    this.quality = this.preset.id;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.preset.pixelCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xdfc0a0, 0.011);
    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 400);
    this.camera.position.set(0, 11, 8.6);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      this.preset.bloomStrength, this.preset.bloomRadius, this.preset.bloomThreshold);
    this.bloom.enabled = this.preset.bloomEnabled;
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);

    this.camPos = new THREE.Vector3(0, 11, 8.6);
    this.camLook = new THREE.Vector3(0, 0, 0);
    this._lead = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._desiredPos = new THREE.Vector3();
    this._shakeOff = new THREE.Vector3();
    this._camOff = new THREE.Vector3(0, 10.6, 8.6);
    this.shake = 0;
    this.damageFlash = 0;
    this.fps = 60;
    this._fpsAcc = 0; this._fpsN = 0;

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
  }

  applyPreset(preset) {
    this.preset = preset;
    this.quality = preset.id;
    this.bloom.strength = preset.bloomStrength;
    this.bloom.radius = preset.bloomRadius;
    this.bloom.threshold = preset.bloomThreshold;
    this.bloom.enabled = preset.bloomEnabled;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelCap));
    this.resize();
  }

  setQuality(q) {
    this.applyPreset(resolveQuality(q, this.software));
  }

  addShake(amount) { this.shake = Math.min(1.2, this.shake + amount); }

  updateCamera(dt, focus, aimPoint) {
    const lead = this._lead.copy(aimPoint).sub(focus);
    lead.y = 0;
    if (lead.length() > 4.5) lead.setLength(4.5);
    const desiredLook = this._desiredLook.copy(focus).add(lead.multiplyScalar(0.4));
    desiredLook.y = 0.6;
    const desiredPos = this._desiredPos.copy(desiredLook).add(this._camOff);
    const k = 1 - Math.exp(-dt * 5.5);
    this.camPos.lerp(desiredPos, k);
    this.camLook.lerp(desiredLook, k);
    this.shake = Math.max(0, this.shake - dt * 3.2);
    const s = this.shake * this.shake * 0.22;
    const t = performance.now() * 0.001;
    this.camera.position.copy(this.camPos).add(this._shakeOff.set(
      Math.sin(t * 47.3) * s, Math.sin(t * 39.1 + 2) * s * 0.7, Math.cos(t * 43.7) * s));
    this.camera.lookAt(this.camLook);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.4);
    this.grade.uniforms.uDamage.value = this.damageFlash;
    this.grade.uniforms.uTime.value = t;
  }

  render(dt) {
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc >= 0.5) {
      this.fps = Math.round(this._fpsN / this._fpsAcc);
      this._fpsAcc = 0; this._fpsN = 0;
    }
    this.composer.render();
  }
}
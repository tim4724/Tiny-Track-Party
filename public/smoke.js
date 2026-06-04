// Infra smoke test: proves the no-build stack works under strict CSP —
// inline importmap (nonced) + external module entry (covered by 'self') +
// vendored Three.js + GLTFLoader loading a Kenney GLB same-origin.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const status = document.getElementById('status');
const smoke = { threeLoaded: false, threeRevision: null, gltfLoaded: false, meshCount: 0, frames: 0, error: null };
window.__smoke = smoke;
const log = (m) => { status.textContent = m; };

try {
  smoke.threeLoaded = true;
  smoke.threeRevision = THREE.REVISION;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(1.6, 1.1, 1.8);
  camera.lookAt(0, 0.2, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(3, 5, 2);
  scene.add(dir);

  let car = null;
  new GLTFLoader().load('/assets/toycar/vehicle-racer.glb', (gltf) => {
    car = gltf.scene;
    car.traverse((o) => { if (o.isMesh) smoke.meshCount++; });
    scene.add(car);
    smoke.gltfLoaded = true;
    log(`three r${THREE.REVISION}  GLB ok  meshes=${smoke.meshCount}`);
  }, undefined, (err) => {
    smoke.error = 'GLB load: ' + (err && err.message ? err.message : String(err));
    log(smoke.error);
  });

  renderer.setAnimationLoop(() => {
    smoke.frames++;
    if (car) car.rotation.y += 0.02;
    renderer.render(scene, camera);
  });
  log(`three r${THREE.REVISION}  loading GLB...`);
} catch (e) {
  smoke.error = String(e && e.stack || e);
  log(smoke.error);
}

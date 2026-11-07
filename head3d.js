// 3D head (Meshy model) for the topbar button.
// The button keeps its emoji until the model loads, and for good if WebGL or the load fails.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const btn = document.querySelector("#moneyBtn");
const SIZE = 84;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(SIZE, SIZE);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
camera.position.set(0, 0, 5.2);

scene.add(new THREE.HemisphereLight(0xfff6ee, 0x4a3a30, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(-2, 3, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffe2cc, 0.8);
fill.position.set(3, 0, 3);
scene.add(fill);

const head = new THREE.Group();
scene.add(head);

const gltf = await new GLTFLoader().loadAsync("reference_head_web.glb");
const model = gltf.scene;
// center the model on the origin and scale it to a ~1.2 radius so the camera framing works for any export size
const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
model.position.sub(sphere.center);
const fit = new THREE.Group();
fit.scale.setScalar(1.2 / sphere.radius);
fit.add(model);
head.add(fit);

// motion: turn toward the cursor, idle bob, quick spin on click
const BASE_Y = 0.15; // slight 3/4 turn
const MAX_NOD = 0.55; // radians of downward tilt at the bottom of the window (~31°)
let targetX = 0, targetY = 0, curX = 0, curY = 0, spin = 0;
addEventListener("pointermove", (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  targetY = THREE.MathUtils.clamp(((e.clientX - (r.left + r.width / 2)) / innerWidth) * 2.2, -0.9, 0.9);
  // nod scales linearly from 0 (cursor level with the head) to MAX_NOD (cursor at the bottom of the window)
  const cy = r.top + r.height / 2;
  targetX = THREE.MathUtils.clamp((e.clientY - cy) / (innerHeight - cy), -0.3, 1) * MAX_NOD;
});
btn.addEventListener("click", () => { if (!reduce) spin = Math.PI * 2; });

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  const ease = 1 - Math.pow(0.001, dt);
  curX += (targetX - curX) * ease;
  curY += (targetY - curY) * ease;
  spin = spin > 0.001 ? spin * Math.pow(0.02, dt) : 0;
  head.rotation.set(curX, BASE_Y + curY + spin, reduce ? 0 : Math.sin(t * 1.3) * 0.04);
  head.position.y = reduce ? 0 : Math.sin(t * 2) * 0.04;
  renderer.render(scene, camera);
});

renderer.domElement.setAttribute("aria-hidden", "true");
btn.replaceChildren(renderer.domElement);

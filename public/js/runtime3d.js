import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";

const loader = new GLTFLoader();
const loaded = new Map();

function loadGltf(uri) {
  if (!uri) return Promise.reject(new Error("No model URI supplied"));
  if (!loaded.has(uri)) loaded.set(uri, new Promise((resolve, reject) => loader.load(uri, resolve, undefined, reject)));
  return loaded.get(uri);
}

function fitObject(object, targetSize = 2) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z) || 1;
  object.scale.multiplyScalar(targetSize / max);
  box.setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y;
  return object;
}

function rendererFor(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  return renderer;
}

function resize(renderer, camera, canvas) {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.floor(width * renderer.getPixelRatio()) || canvas.height !== Math.floor(height * renderer.getPixelRatio())) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

export function initModelPreviews(root = document) {
  root.querySelectorAll("canvas[data-model-preview]").forEach((canvas) => {
    if (canvas.dataset.threeReady) return;
    canvas.dataset.threeReady = "loading";
    const renderer = rendererFor(canvas);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x08101a);
    scene.environment = null;
    const camera = new THREE.PerspectiveCamera(34, 1, .01, 300);
    camera.position.set(3.4, 2.4, 4.8);
    camera.lookAt(0, .8, 0);
    scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x18202d, 2.8));
    const key = new THREE.DirectionalLight(0xffffff, 4.2); key.position.set(4, 7, 5); scene.add(key);
    const rim = new THREE.DirectionalLight(0x25d9ff, 3); rim.position.set(-5, 2, -4); scene.add(rim);
    const grid = new THREE.GridHelper(8, 16, 0x2bc8ff, 0x223044); grid.material.opacity = .3; grid.material.transparent = true; scene.add(grid);
    let model = null;
    let mixer = null;
    loadGltf(canvas.dataset.modelUri).then((gltf) => {
      model = fitObject(cloneSkeleton(gltf.scene), 2.4);
      model.traverse((node) => { if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; } });
      scene.add(model);
      if (gltf.animations?.length) { mixer = new THREE.AnimationMixer(model); mixer.clipAction(gltf.animations[0]).play(); }
      canvas.dataset.threeReady = "true";
    }).catch((error) => {
      canvas.dataset.threeReady = "error";
      canvas.title = `3D model failed validation: ${error.message}`;
    });
    const clock = new THREE.Clock();
    const draw = () => {
      if (!canvas.isConnected) { renderer.dispose(); return; }
      resize(renderer, camera, canvas);
      const delta = clock.getDelta();
      if (model) model.rotation.y += delta * .32;
      if (mixer) mixer.update(delta);
      renderer.render(scene, camera);
      requestAnimationFrame(draw);
    };
    draw();
  });
}

export function initEndlessRacer3D(canvas) {
  if (canvas.dataset.threeRuntime) return;
  canvas.dataset.threeRuntime = "loading";
  const renderer = rendererFor(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06101c);
  scene.fog = new THREE.FogExp2(0x06101c, .018);
  const camera = new THREE.PerspectiveCamera(54, 1, .1, 500);
  camera.position.set(0, 5.6, 10.5);
  camera.lookAt(0, .6, -10);
  scene.add(new THREE.HemisphereLight(0xaedfff, 0x160c24, 2.4));
  const moon = new THREE.DirectionalLight(0xffffff, 5); moon.position.set(-4, 10, 8); moon.castShadow = true; scene.add(moon);
  const cyan = new THREE.PointLight(0x16e8ff, 18, 55); cyan.position.set(-8, 4, -8); scene.add(cyan);
  const magenta = new THREE.PointLight(0xff267f, 14, 50); magenta.position.set(8, 3, -18); scene.add(magenta);

  const road = new THREE.Mesh(new THREE.PlaneGeometry(9, 240), new THREE.MeshStandardMaterial({ color: 0x111722, roughness: .78, metalness: .18 }));
  road.rotation.x = -Math.PI / 2; road.position.z = -92; road.receiveShadow = true; scene.add(road);
  const borders = [-4.45, 4.45].map((x) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(.1, .08, 240), new THREE.MeshStandardMaterial({ color: 0x1de6d0, emissive: 0x0a746c, emissiveIntensity: 2 })); mesh.position.set(x, .04, -92); scene.add(mesh); return mesh; });
  const dashes = [];
  for (let z = -200; z < 30; z += 8) for (const x of [-1.5, 1.5]) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(.08, .035, 3.5), new THREE.MeshBasicMaterial({ color: 0xa7c3d7 }));
    dash.position.set(x, .04, z); scene.add(dash); dashes.push(dash);
  }
  const towers = [];
  for (let z = -190; z < 20; z += 14) for (const side of [-1, 1]) {
    const height = 2.5 + Math.random() * 8;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(.25 + Math.random() * .45, .45 + Math.random() * .5, height, 6), new THREE.MeshStandardMaterial({ color: side < 0 ? 0x12324a : 0x35152f, emissive: side < 0 ? 0x0a7292 : 0x8f164c, emissiveIntensity: .7, roughness: .55 }));
    tower.position.set(side * (6 + Math.random() * 8), height / 2 - .05, z); scene.add(tower); towers.push(tower);
  }

  const lanes = [-2.8, 0, 2.8];
  const state = { running: false, crashed: false, lane: 1, distance: 0, best: Number(localStorage.getItem("comic30-racer-3d-best") || 0), speed: 26, spawn: 0, traffic: [], last: performance.now() };
  let player = null;
  let trafficSource = null;
  const status = document.createElement("div");
  status.className = "xgp-three-hud";
  status.innerHTML = "<strong>LOADING 3D RUNTIME</strong><span>Validating models and scene…</span>";
  canvas.parentElement.append(status);

  const prepare = async () => {
    const [playerGltf, trafficGltf] = await Promise.all([loadGltf(canvas.dataset.playerModel), loadGltf(canvas.dataset.trafficModel)]);
    player = fitObject(cloneSkeleton(playerGltf.scene), 1.65); player.rotation.y = Math.PI; player.position.set(0, .02, 4.8);
    player.traverse((node) => { if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; } }); scene.add(player);
    trafficSource = fitObject(cloneSkeleton(trafficGltf.scene), 1.5); trafficSource.rotation.y = Math.PI;
    canvas.dataset.threeRuntime = "ready";
    status.innerHTML = "<strong>ENDLESS VELOCITY 3D</strong><span>Click to drive · A/D or arrow keys</span>";
  };
  prepare().catch((error) => {
    canvas.dataset.threeRuntime = "error";
    status.innerHTML = `<strong>3D ASSET LOAD FAILED</strong><span>${String(error.message || error).replace(/[<>]/g, "")}</span>`;
  });

  const start = () => {
    if (!player || !trafficSource) return;
    state.traffic.forEach((entry) => scene.remove(entry.object));
    Object.assign(state, { running: true, crashed: false, lane: 1, distance: 0, speed: 26, spawn: .3, traffic: [], last: performance.now() });
    status.innerHTML = `<strong>DISTANCE 0 m</strong><span>BEST ${state.best} m · 94 km/h</span>`;
  };
  const move = (delta) => { if (!state.running) start(); state.lane = Math.max(0, Math.min(2, state.lane + delta)); };
  canvas.addEventListener("pointerdown", (event) => { canvas.focus(); if (!state.running) start(); else move(event.offsetX < canvas.clientWidth / 2 ? -1 : 1); });
  canvas.addEventListener("keydown", (event) => { if (["ArrowLeft", "a", "A"].includes(event.key)) move(-1); if (["ArrowRight", "d", "D"].includes(event.key)) move(1); if (event.key === " ") start(); event.preventDefault(); });

  const clock = new THREE.Clock();
  const draw = (time) => {
    if (!canvas.isConnected) { renderer.dispose(); return; }
    resize(renderer, camera, canvas);
    const dt = Math.min(.04, (time - state.last) / 1000 || clock.getDelta()); state.last = time;
    if (player) { player.position.x += (lanes[state.lane] - player.position.x) * Math.min(1, dt * 10); player.rotation.z = (lanes[state.lane] - player.position.x) * -.04; }
    if (state.running && player && trafficSource) {
      state.distance += dt * state.speed * .72; state.speed = Math.min(66, state.speed + dt * .42); state.spawn -= dt;
      dashes.forEach((dash) => { dash.position.z += state.speed * dt; if (dash.position.z > 20) dash.position.z -= 232; });
      towers.forEach((tower) => { tower.position.z += state.speed * dt; if (tower.position.z > 24) tower.position.z -= 210; });
      if (state.spawn <= 0) {
        const object = cloneSkeleton(trafficSource); const lane = Math.floor(Math.random() * 3); object.position.set(lanes[lane], .02, -85); scene.add(object);
        state.traffic.push({ object, lane }); state.spawn = Math.max(.55, 1.35 - state.speed / 90);
      }
      state.traffic.forEach((entry) => entry.object.position.z += state.speed * dt * .88);
      state.traffic.filter((entry) => entry.object.position.z > 15).forEach((entry) => scene.remove(entry.object));
      state.traffic = state.traffic.filter((entry) => entry.object.position.z <= 15);
      if (state.traffic.some((entry) => entry.lane === state.lane && Math.abs(entry.object.position.z - 4.8) < 1.65)) {
        state.running = false; state.crashed = true; state.best = Math.max(state.best, Math.floor(state.distance)); localStorage.setItem("comic30-racer-3d-best", String(state.best));
        status.innerHTML = `<strong>CRASHED · ${Math.floor(state.distance)} m</strong><span>Click or Space to restart · BEST ${state.best} m</span>`;
      } else status.innerHTML = `<strong>DISTANCE ${Math.floor(state.distance)} m</strong><span>BEST ${state.best} m · ${Math.floor(state.speed * 3.6)} km/h</span>`;
    }
    renderer.render(scene, camera); requestAnimationFrame(draw);
  };
  draw(performance.now());
}

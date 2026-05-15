import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// State
let score = 100;
let keys = { w: false, a: false, s: false, d: false };

// UI Elements
const scoreElement = document.getElementById('score');
const warningContainer = document.getElementById('warning-container');
const speedValueElement = document.getElementById('speed-value');

// Three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color('#87ceeb');
scene.fog = new THREE.FogExp2('#87ceeb', 0.015);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.getElementById('canvas-container').appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(100, 150, 50);
dirLight.castShadow = true;
dirLight.shadow.camera.top = 100;
dirLight.shadow.camera.bottom = -100;
dirLight.shadow.camera.left = -100;
dirLight.shadow.camera.right = 100;
scene.add(dirLight);

const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
const groundMaterial = new THREE.MeshStandardMaterial({ color: '#2a2a2a' });
const ground = new THREE.Mesh(groundGeometry, groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Asset Caching
const models = {
  buildings: [],
  stopSign: null,
  trafficLight: null,
  car: null,
  roadBits: {}
};

// Ensure shadows are cast
const enableShadows = (object) => {
  object.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
};

const manager = new THREE.LoadingManager();
const loader = new GLTFLoader(manager);

// Show a loading text in score temporarily
scoreElement.innerText = "Cargando...";

loader.load('/car.glb', (gltf) => {
  const model = gltf.scene;
  enableShadows(model);
  const box = new THREE.Box3().setFromObject(model);
  const maxDim = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  model.scale.setScalar(4 / maxDim);
  
  const center = box.getCenter(new THREE.Vector3());
  model.position.x = -center.x * (4/maxDim);
  model.position.y = -box.min.y * (4/maxDim);
  model.position.z = -center.z * (4/maxDim);
  
  models.car = model;
});

loader.load('/Stop sign.glb', (gltf) => {
  models.stopSign = gltf.scene;
  enableShadows(models.stopSign);
});

loader.load('/Traffic Light.glb', (gltf) => {
  models.trafficLight = gltf.scene;
  enableShadows(models.trafficLight);
});

const buildingFiles = ['/Building.glb', '/Large Building.glb', '/Small Building.glb', '/Building Red Corner.glb'];
buildingFiles.forEach(file => {
  loader.load(file, (gltf) => {
    enableShadows(gltf.scene);
    models.buildings.push(gltf.scene);
  });
});

loader.load('/Road Bits.glb', (gltf) => {
  const names = ['road_corner', 'road_corner_curved', 'road_junction', 'road_straight', 'road_straight_crossing', 'road_tsplit'];
  gltf.scene.traverse((child) => {
    if (names.includes(child.name)) {
      enableShadows(child);
      const piece = child.clone();
      piece.position.set(0, 0, 0); // Reset local translation
      
      // Auto-scale to fit streetWidth (20)
      const bbox = new THREE.Box3().setFromObject(piece);
      const size = bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.z);
      
      if (maxDim > 0) {
        const bScale = streetWidth / maxDim;
        piece.scale.set(piece.scale.x * bScale, piece.scale.y * bScale, piece.scale.z * bScale);
      }
      
      const group = new THREE.Group();
      group.add(piece);
      models.roadBits[child.name] = group;
    }
  });
});

// Game state variables
const buildings = [];
const trafficZones = [];
const collidableBoxes = [];
const carGroup = new THREE.Group();
const blockSize = 40;
const streetWidth = 20;
const gridSize = 10;

// Car Physics/Movement state
const carState = { speed: 0, maxSpeed: 30, acceleration: 15, deceleration: 10, turnSpeed: 1.5, heading: 0 };

manager.onLoad = () => {
  scoreElement.innerText = score;
  scene.add(carGroup);
  carGroup.add(models.car);
  buildCity();
  
  // The road surface is exactly at Y=1.0 after scaling
  carGroup.position.y = 1.0;
  
  animate(); // Start loop only when loaded
};

manager.onError = (url) => {
  console.error('Error loading model:', url);
};

function buildCity() {
  for (let i = -gridSize / 2; i < gridSize / 2; i++) {
    for (let j = -gridSize / 2; j < gridSize / 2; j++) {
      const cx = i * (blockSize + streetWidth);
      const cz = j * (blockSize + streetWidth);

      // Building
      if (Math.abs(i) >= 1 || Math.abs(j) >= 1) {
        // Pick random building
        const baseBuilding = models.buildings[Math.floor(Math.random() * models.buildings.length)];
        const bModel = baseBuilding.clone();
        
        // Auto-scale building to fit the block size
        const bbox = new THREE.Box3().setFromObject(bModel);
        const size = bbox.getSize(new THREE.Vector3());
        const maxXZ = Math.max(size.x, size.z);
        
        // Target width of building
        const targetSize = blockSize * (0.6 + Math.random() * 0.4);
        const bScale = targetSize / maxXZ;
        bModel.scale.setScalar(bScale);

        bModel.position.x = cx;
        bModel.position.y = -bbox.min.y * bScale; // Base to ground
        bModel.position.z = cz;
        
        scene.add(bModel);
        buildings.push(bModel);
        
        const worldBox = new THREE.Box3().setFromObject(bModel);
        // Slightly reduce building box to allow close driving without snagging
        worldBox.expandByScalar(-0.5);
        collidableBoxes.push(worldBox);
      }

      const halfStep = (blockSize + streetWidth) / 2; // 30
      const qStep = blockSize / 4; // 10

      if (i < gridSize / 2 && j < gridSize / 2) {
        if (models.roadBits.road_junction) {
          const junc = models.roadBits.road_junction.clone();
          junc.position.set(cx + halfStep, 0, cz + halfStep);
          scene.add(junc);
        }

        if (models.roadBits.road_straight) {
          // Vertical road tiles
          const v1 = models.roadBits.road_straight.clone();
          v1.position.set(cx + halfStep, 0, cz - qStep);
          scene.add(v1);

          const v2 = models.roadBits.road_straight.clone();
          v2.position.set(cx + halfStep, 0, cz + qStep);
          scene.add(v2);

          // Horizontal road tiles
          const h1 = models.roadBits.road_straight.clone();
          h1.position.set(cx - qStep, 0, cz + halfStep);
          h1.rotation.y = Math.PI / 2;
          scene.add(h1);

          const h2 = models.roadBits.road_straight.clone();
          h2.position.set(cx + qStep, 0, cz + halfStep);
          h2.rotation.y = Math.PI / 2;
          scene.add(h2);
        }
      }

      // Add traffic sign and zone
      const isJunction = (i < gridSize / 2 && j < gridSize / 2);
      
      // 1. Place Stop Signs or Traffic Lights at junctions
      if (isJunction && Math.random() < 0.7) {
        const type = 'stop';
        const isTrafficLight = Math.random() < 0.5; // Randomly choose between stop sign and traffic light
        const streetCx = cx + halfStep;
        const streetCz = cz - qStep;
        
        const rBox = new THREE.Box3();
        rBox.setFromCenterAndSize(
          new THREE.Vector3(streetCx, 1, streetCz),
          new THREE.Vector3(streetWidth, 2, blockSize)
        );
        
        trafficZones.push({ box: rBox, type: type, limit: 15, active: true, cooldown: 0, wasInside: false, minSpeedInside: 999 });

        const modelToUse = isTrafficLight ? models.trafficLight : models.stopSign;

        if (modelToUse) {
          const signModel = modelToUse.clone();
          const sbox = new THREE.Box3().setFromObject(signModel);
          const sSize = sbox.getSize(new THREE.Vector3());
          const sScale = isTrafficLight ? (8 / sSize.y) : (4 / sSize.y);
          signModel.scale.setScalar(sScale);

          // Place exactly on the right corner before the intersection
          // streetCx and streetCz are the centers of the road.
          // Junction center is (cx + halfStep, cz + halfStep).
          const junctionCenterZ = cz + halfStep;
          
          // Move to right sidewalk (-X in ThreeJS if +Z is forward) and just before the intersection (-Z)
          const signX = streetCx - streetWidth / 2 - 1.5; 
          const signZ = junctionCenterZ - streetWidth / 2 - 1.5;
          
          signModel.position.set(signX, -sbox.min.y * sScale, signZ);
          
          // Rotate so the arm extends over the street and faces the car
          signModel.rotation.y = Math.PI; 
          
          scene.add(signModel);
          
          // Solo añadimos colisiones si NO es un semáforo
          // porque el bounding box del semáforo incluye el espacio bajo su brazo y bloquea el paso
          if (!isTrafficLight) {
            const worldBox = new THREE.Box3().setFromObject(signModel);
            collidableBoxes.push(worldBox);
          }
        }
      }
      
      // 2. Place invisible Speed Cameras (Radar zones) along straight roads
      if (Math.random() < 0.2 && (Math.abs(i) >= 1 || Math.abs(j) >= 1)) {
        const isHorizontal = Math.random() < 0.5;
        const type = 'speed';

        const streetCx = isHorizontal ? cx : cx + halfStep;
        const streetCz = isHorizontal ? cz + halfStep : cz;
        
        const rBox = new THREE.Box3();
        rBox.setFromCenterAndSize(
          new THREE.Vector3(streetCx, 1, streetCz),
          new THREE.Vector3(isHorizontal ? blockSize : streetWidth, 2, isHorizontal ? streetWidth : blockSize)
        );
        
        trafficZones.push({ box: rBox, type: type, limit: 15, active: true, cooldown: 0, wasInside: false, minSpeedInside: 999 });
        // Removed physical model from here so traffic lights only appear at corners.
      }
    }
  }
}

// Audio State
let audioCtx = null;
let engineOscillator = null;
let engineGain = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  engineOscillator = audioCtx.createOscillator();
  engineGain = audioCtx.createGain();
  
  engineOscillator.type = 'sawtooth';
  engineOscillator.frequency.value = 40;
  
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 400;

  engineOscillator.connect(filter);
  filter.connect(engineGain);
  engineGain.connect(audioCtx.destination);
  
  engineGain.gain.value = 0.1;
  engineOscillator.start();
}

// Input handling
window.addEventListener('keydown', (e) => {
  initAudio();
  const k = e.key.toLowerCase();
  if (keys.hasOwnProperty(k)) keys[k] = true;
  if (e.key === 'ArrowUp') keys.w = true;
  if (e.key === 'ArrowDown') keys.s = true;
  if (e.key === 'ArrowLeft') keys.a = true;
  if (e.key === 'ArrowRight') keys.d = true;
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (keys.hasOwnProperty(k)) keys[k] = false;
  if (e.key === 'ArrowUp') keys.w = false;
  if (e.key === 'ArrowDown') keys.s = false;
  if (e.key === 'ArrowLeft') keys.a = false;
  if (e.key === 'ArrowRight') keys.d = false;
});

const bindBtn = (id, key) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); initAudio(); keys[key] = true; });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); keys[key] = false; });
  btn.addEventListener('mousedown', (e) => { initAudio(); keys[key] = true; });
  btn.addEventListener('mouseup', (e) => { keys[key] = false; });
  btn.addEventListener('mouseleave', (e) => { keys[key] = false; });
};

bindBtn('btn-up', 'w');
bindBtn('btn-down', 's');
bindBtn('btn-left', 'a');
bindBtn('btn-right', 'd');

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function showWarning(message) {
  const div = document.createElement('div');
  div.className = 'warning';
  div.innerText = message;
  warningContainer.appendChild(div);
  
  void div.offsetWidth; 
  div.classList.add('active');

  setTimeout(() => {
    div.classList.remove('active');
    setTimeout(() => { div.remove(); }, 300);
  }, 2000);
}

const clock = new THREE.Clock();
const cameraTargetPos = new THREE.Vector3();
const cameraTargetLook = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  if (keys.w) carState.speed += carState.acceleration * dt;
  else if (keys.s) carState.speed -= carState.acceleration * dt;
  else {
    if (carState.speed > 0) {
      carState.speed -= carState.deceleration * dt;
      if (carState.speed < 0) carState.speed = 0;
    } else if (carState.speed < 0) {
      carState.speed += carState.deceleration * dt;
      if (carState.speed > 0) carState.speed = 0;
    }
  }

  if (carState.speed > carState.maxSpeed) carState.speed = carState.maxSpeed;
  if (carState.speed < -carState.maxSpeed / 2) carState.speed = -carState.maxSpeed / 2;

  if (Math.abs(carState.speed) > 0.1) {
    const turnDir = carState.speed > 0 ? 1 : -1;
    if (keys.a) carState.heading += carState.turnSpeed * dt * turnDir;
    if (keys.d) carState.heading -= carState.turnSpeed * dt * turnDir;
  }

  carGroup.rotation.y = carState.heading;

  const dirX = Math.sin(carState.heading);
  const dirZ = Math.cos(carState.heading);
  
  const moveX = dirX * carState.speed * dt;
  const moveZ = dirZ * carState.speed * dt;

  carGroup.position.x += moveX;
  carGroup.position.z += moveZ;
  
  carGroup.updateMatrixWorld();
  let carBox = new THREE.Box3().setFromObject(carGroup);
  
  // Make car box slightly smaller for collisions to avoid snagging
  const collisionBox = carBox.clone().expandByScalar(-0.2); 
  
  let collision = false;
  for(let box of collidableBoxes) {
      if(collisionBox.intersectsBox(box)) {
          collision = true;
          break;
      }
  }
  
  if (collision) {
      // Revert position and stop
      carGroup.position.x -= moveX;
      carGroup.position.z -= moveZ;
      carState.speed = 0;
      carGroup.updateMatrixWorld();
      carBox.setFromObject(carGroup);
  }

  const camOffsetZ = 10;
  const camOffsetY = 4;
  cameraTargetPos.set(
    carGroup.position.x - Math.sin(carState.heading) * camOffsetZ,
    carGroup.position.y + camOffsetY,
    carGroup.position.z - Math.cos(carState.heading) * camOffsetZ
  );

  camera.position.lerp(cameraTargetPos, 5 * dt);

  cameraTargetLook.set(carGroup.position.x, carGroup.position.y + 1, carGroup.position.z);
  const currentLookAt = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position);
  currentLookAt.lerp(cameraTargetLook, 10 * dt);
  camera.lookAt(currentLookAt);

  // Audio & UI Update
  if (speedValueElement) {
    const kmh = Math.abs(carState.speed * 3.6).toFixed(0);
    speedValueElement.innerText = kmh;
  }
  if (engineOscillator && audioCtx) {
    const targetFreq = 40 + Math.abs(carState.speed) * 3.5;
    engineOscillator.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.1);
  }

  const currentSpeed = Math.abs(carState.speed);

  for (let zone of trafficZones) {
    if (zone.cooldown > 0) zone.cooldown -= dt;
    const isInside = carBox.intersectsBox(zone.box);

    if (zone.type === 'speed') {
      if (zone.active && zone.cooldown <= 0 && isInside) {
        if (currentSpeed > zone.limit) {
          score -= 10;
          scoreElement.innerText = score;
          showWarning('¡Exceso de velocidad! -10 puntos');
          zone.cooldown = 5; 
        }
      }
    } else if (zone.type === 'stop') {
      if (isInside) {
        zone.wasInside = true;
        if (currentSpeed < zone.minSpeedInside) zone.minSpeedInside = currentSpeed;
      } else {
        if (zone.wasInside) {
          if (zone.cooldown <= 0 && zone.minSpeedInside > 1.5) { 
            score -= 10;
            scoreElement.innerText = score;
            showWarning('¡Infracción! No te detuviste en el PARE');
            zone.cooldown = 5;
          }
          zone.wasInside = false;
          zone.minSpeedInside = 999;
        }
      }
    }
  }

  renderer.render(scene, camera);
}

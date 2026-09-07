// main.js — 游戏引导与主循环（设置系统 / 菜单 / 死亡界面 / 地形与模型加载）
import * as THREE from 'three';
import { WORLD } from './config.js';
import { Input } from './input.js';
import { ChaseCamera } from './camera.js';
import { Game } from './game.js';
import { HUD } from './hud.js';
import { RealTerrain } from './terrain.js';
import { ModelLibrary } from './assets.js';
import { Settings } from './settings.js';
import { Menu } from './menu.js';

const overlay = document.getElementById('overlay');
const loadBar = document.getElementById('loadbar');
const loadMsg = document.getElementById('loadmsg');
const deathScreen = document.getElementById('deathscreen');
const deathStats = document.getElementById('deathstats');
const pauseTag = document.getElementById('pauseTag');

function setProgress(frac, msg) {
  loadBar.style.width = `${Math.round(frac * 100)}%`;
  if (msg) loadMsg.textContent = msg;
}

// ---------------- 设置 ----------------
Settings.load();

// ---------------- 渲染器（logarithmicDepthBuffer 消除远距深度闪烁）----------------
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbcd6ea, 12000, 46000);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 2, 160000);
camera.position.set(0, 2500, 60);

// ---------------- 天空（含 logdepth 通道，避免深度冲突）----------------
{
  const skyGeo = new THREE.SphereGeometry(70000, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x2b6ecb) },
      midColor: { value: new THREE.Color(0x9cc6ea) },
      botColor: { value: new THREE.Color(0xd9e8f2) },
      sunDir: { value: new THREE.Vector3(0.35, 0.5, 0.2).normalize() },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 topColor; uniform vec3 midColor; uniform vec3 botColor; uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        #include <logdepthbuf_fragment>
        float h = clamp(vDir.y, -1.0, 1.0);
        vec3 col = mix(botColor, midColor, smoothstep(-0.08, 0.25, h));
        col = mix(col, topColor, smoothstep(0.2, 0.75, h));
        float sun = pow(max(dot(normalize(vDir), sunDir), 0.0), 550.0);
        float glow = pow(max(dot(normalize(vDir), sunDir), 0.0), 8.0) * 0.22;
        col += vec3(1.0, 0.95, 0.82) * (sun * 1.6 + glow);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
}

// 光照
const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x51503f, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
sun.position.set(7000, 11000, 4000);
scene.add(sun);

// ---------------- 输入 / 相机 / 游戏 / HUD / 菜单 ----------------
const input = new Input(document.body, Settings);
const chaseCam = new ChaseCamera(camera, Settings);
const game = new Game(scene, camera, input, chaseCam);
const hud = new HUD(document.getElementById('hud'), game);
const modelLib = new ModelLibrary();

const menu = new Menu({
  onStart: () => {
    // 首次开始：按当前设置生成玩家（boot 不再预生成）
    if (!game.player) { game.start(); menu.resetStartLabel(); }
    input.setCamera?.(camera);
    state.running = true;
    state.paused = false;
    input.requestPointerLock();
    deathScreen.classList.add('hidden');
    pauseScreen.classList.add('hidden');
  },
});

// 地形（boot 时加载）
let terrain = null;

// 占位地面（地形加载完成后移除）
let groundMesh = null;
{
  const grid = new THREE.GridHelper(WORLD.terrainSize, 64, 0x39515e, 0x22333d);
  grid.position.y = 0;
  scene.add(grid);
  groundMesh = grid;
}

// ---------------- 状态 ----------------
const state = {
  running: false,
  paused: false,
  time: 0,
};
window.__GAME__ = { renderer, scene, camera, game, input, state, THREE, hud, settings: Settings };
input.setCamera(camera);   // 鼠标飞控圆环 → 世界方向反投影用

// ---------------- 死亡界面 ----------------
let deathShown = false;
function showDeath() {
  deathShown = true;
  const t = Math.floor(game.time);
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  deathStats.innerHTML =
    `最终得分 <b>${game.score}</b> · 击落 <b>${game.kills}</b> 架<br>` +
    `抵达波次 <b>第 ${game.wave} 波</b> · 飞行时长 <b>${mm}:${ss}</b><br>` +
    `机体 <b>${game.player?.spec?.name ?? '—'}</b>`;
  deathScreen.classList.remove('hidden');
  input.exitPointerLock();
}
function restartMission() {
  if (!deathShown) return;
  game.reset();
  chaseCam.reinit();
  deathScreen.classList.add('hidden');
  deathShown = false;
  state.running = true;
  input.requestPointerLock();
  console.log('[game] mission restarted');
}
document.getElementById('btnRestart').addEventListener('click', restartMission);
document.getElementById('btnMenu').addEventListener('click', () => {
  game.reset();
  chaseCam.reinit();
  deathScreen.classList.add('hidden');
  deathShown = false;
  state.running = false;
  state.paused = false;
  pauseTag.classList.add('hidden');
  menu.show();
});

// ---------------- 暂停菜单 ----------------
const pauseScreen = document.getElementById('pausescreen');
function setPaused(v) {
  if (!state.running || deathShown) return;
  state.paused = v;
  pauseScreen.classList.toggle('hidden', !v);
  pauseTag.classList.add('hidden');
  if (v) input.exitPointerLock(); else input.requestPointerLock();
}
document.getElementById('btnResume').addEventListener('click', () => setPaused(false));
document.getElementById('btnPauseRestart').addEventListener('click', () => {
  game.reset();
  chaseCam.reinit();
  pauseScreen.classList.add('hidden');
  state.running = true;
  setPaused(false);
  console.log('[game] mission restarted (pause menu)');
});
document.getElementById('btnPauseMenu').addEventListener('click', () => {
  game.reset();
  chaseCam.reinit();
  pauseScreen.classList.add('hidden');
  state.running = false;
  state.paused = false;
  pauseTag.classList.add('hidden');
  menu.resetStartLabel();
  menu.show();
});

// 暂停中更改配置：进入主菜单设置页（画面冻结在菜单后），改完点「继续任务」无缝恢复
document.getElementById('btnPauseSettings').addEventListener('click', () => {
  pauseScreen.classList.add('hidden');
  state.paused = true;
  menu.showSettings('system');
});

// ---------------- 主循环 ----------------
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  try {
    if (state.running && !state.paused) {
      state.time += dt;
      input.updateAim(dt);
      game.update(dt);
      if (game.player?.alive) chaseCam.update(dt, game.player, input);
      if (game.gameOver && !deathShown) showDeath();
      input.endFrame();
    }
    renderer.render(scene, camera);
    hud.draw(dt);
  } catch (err) {
    console.error('[loop]', err && err.stack || err);
    window.__LAST_LOOP_ERROR__ = String(err && err.stack || err);
    state.running = false;
    alertError(err);
  }
}
loop();

function alertError(err) {
  loadMsg.textContent = `运行错误：${err.message}（见控制台）`;
  loadMsg.style.color = '#ff5d5d';
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 暂停 / 重开（按设置键位）
window.addEventListener('keydown', (e) => {
  const kb = Settings.data.keybinds;
  const menuVisible = menu.overlay && menu.overlay.style.display !== 'none';
  if (e.code === kb.pause && state.running && !menuVisible) {
    setPaused(!state.paused);
    console.log('[game] paused:', state.paused);
  }
  if (e.code === 'Escape' && state.running && state.paused && !menuVisible) setPaused(false);
  if (e.code === 'Enter' && deathShown) restartMission();
});

// ---------------- 引导流程 ----------------
async function boot() {
  try {
    setProgress(0.05, '初始化渲染管线…');
    console.log('[boot] renderer initialized, logDepth =', renderer.capabilities.logarithmicDepthBuffer);
    // 真实地形（失败不阻塞：回退占位地面）
    try {
      const anisotropy = renderer.capabilities.getMaxAnisotropy();
      terrain = await new RealTerrain(scene, { anisotropy }).load((f, m) => setProgress(0.05 + f * 0.55, m));
      if (groundMesh) { scene.remove(groundMesh); groundMesh = null; }
      game.terrain = terrain;
      window.__GAME__.terrain = terrain;
    } catch (err) {
      console.warn('[boot] 地形加载失败，使用占位地面:', err.message);
    }
    // 真实飞机/导弹模型（失败回退占位网格）
    try {
      await modelLib.loadAll((f, m) => setProgress(0.6 + f * 0.35, m));
      game.modelLib = modelLib;
    } catch (err) {
      console.warn('[boot] 模型库加载失败，使用占位网格:', err.message);
    }
    setProgress(1.0, '就绪 · 配置完成后开始任务');
    console.log('[boot] ready');
    menu.enableStart();
  } catch (err) {
    console.error('[boot]', err);
    setProgress(1.0, `加载失败：${err.message}`);
    loadMsg.style.color = '#ff5d5d';
    menu.enableStart();
  }
}
boot();

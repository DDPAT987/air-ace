// assets.js — 模型库：加载 borrow 的真实飞机/导弹 OBJ 模型（含材质贴图），失败回退占位网格
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { buildPlaceholderJet } from './aircraft.js';

// 模型登记：obj 相对路径 / 缩放。
// 朝向不再手调：_loadOne 用「垂尾=全机最高结构 → 垂尾端=尾」几何自动定向（尾端→+Z）。
const REGISTRY = {
  f16: {
    obj: 'public/models/f16/F-16CM%20PoBIT.obj',
    mtl: 'public/models/f16/F-16CM%20PoBIT.mtl',
    scale: 1.0,
  },
  mig29: {
    fbx: 'public/models/mig29/MIG29M.fbx',
    mtl: null,                    // FBX 路线：统一程序材质
    targetLength: 17.32,          // MiG-29M 全长约 17.32m，自动归一化缩放
    fallbackColor: 0x8a97a3,
  },
  su30: {
    fbx: 'public/models/su30/SU30SM2.fbx',
    mtl: null,                    // FBX 路线：统一程序材质
    targetLength: 21.9,           // Su-30SM2 全长约 21.9m，自动归一化缩放
    fallbackColor: 0x5d6b70,
  },
  j10c: {
    fbx: 'public/models/j10c/J10C.fbx',
    mtl: null,
    targetLength: 16.9,          // 歼-10C 全长约 16.9m
    fallbackColor: 0x6d8a9c,
  },
  f15c: {
    fbx: 'public/models/f15c/F15C.fbx',
    mtl: null,
    targetLength: 19.43,         // F-15C 全长约 19.43m
    fallbackColor: 0x9aa4ad,
  },
  pl12: {
    fbx: 'public/models/pl12/PL12.fbx',
    mtl: null,
    targetLength: 3.9,           // PL-12 全长约 3.9m
    fallbackColor: 0xd8dde2,
  },
  pl8: {
    fbx: 'public/models/pl8/PL8B.fbx',
    mtl: null,
    targetLength: 3.0,           // PL-8B 全长约 3.0m
    fallbackColor: 0xcfd6db,
  },
  r73: {
    fbx: 'public/models/r73/R73.fbx',
    mtl: null,
    targetLength: 2.9,           // R-73 全长约 2.9m
    fallbackColor: 0xd8dde2,
  },
  aim120: {
    obj: 'public/models/aim120/us_aim_120a_default.obj',
    mtl: 'public/models/aim120/us_aim_120a_default.mtl',
    scale: 1.0,
  },
  r77: {
    obj: 'public/models/r77/su_r_77_default.obj',
    mtl: null,                    // r77 目录无贴图，使用程序材质
    scale: 1.0,
    fallbackColor: 0xb8bec4,
  },
  aim9: {
    fbx: 'public/models/aim9/AIM9M.fbx',
    mtl: null,                    // FBX 纹理引用不在本目录，统一程序材质
    targetLength: 2.9,            // AIM-9M 全长约 2.87m，自动归一化缩放
    fallbackColor: 0xd9dde2,
  },
};

// 几何自动定向：垂尾/尾翼是全机最高结构（F-16 3.4m / Su-30 3.8m，远超座舱 ~1.7m），
// 最高段所在端 = 尾；返回 -1（尾在 -Z，需转 π）或 +1（尾已在 +Z）。
function computeTailSign(obj) {
  obj.updateMatrixWorld(true);
  const buckets = 16;
  let zMin = Infinity, zMax = -Infinity;
  const verts = [];
  const v = new THREE.Vector3();
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry?.attributes?.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      verts.push(v.x, v.y, v.z);
      if (v.z < zMin) zMin = v.z;
      if (v.z > zMax) zMax = v.z;
    }
  });
  const zSpan = zMax - zMin || 1;
  const maxAbsY = new Array(buckets).fill(0);
  for (let i = 0; i < verts.length; i += 3) {
    const b = Math.min(buckets - 1, Math.max(0, Math.floor((verts[i + 2] - zMin) / zSpan * buckets)));
    const ay = Math.abs(verts[i + 1]);
    if (ay > maxAbsY[b]) maxAbsY[b] = ay;
  }
  let finBucket = 0;
  for (let b = 1; b < buckets; b++) if (maxAbsY[b] > maxAbsY[finBucket]) finBucket = b;
  const finZ = zMin + (finBucket + 0.5) / buckets * zSpan;
  return finZ > 0 ? 1 : -1;
}

export class ModelLibrary {
  constructor() {
    this.models = {};
  }

  // 后台重试：加载失败/被跳过的模型在游戏运行期间静默重试，成功后自动替换占位
  startBackgroundRetry(onLoaded = () => {}) {
    if (this._retryTimer) return;
    this._retryTimer = setInterval(async () => {
      const missing = Object.keys(REGISTRY).filter(k => !this.models[k]);
      if (!missing.length) { clearInterval(this._retryTimer); this._retryTimer = null; return; }
      for (const name of missing) {
        try {
          this.models[name] = await this._loadWithTimeout(REGISTRY[name], 60000);
          console.log(`[assets] ${name} 后台重试成功 ✓`);
          onLoaded(name);
        } catch { /* 继续等下轮 */ }
      }
    }, 20000);
  }

  // 外部调用：跳过剩余模型（网络僵死时让玩家直接进游戏，用占位网格）
  skipRemaining() {
    this._skipRequested = true;
    if (this._skipResolve) this._skipResolve();
  }

  // 并行加载（4 路）+ 优先级排序：玩家机体与其导弹最先，开局等待时间减半
  async loadAll(onProgress = () => {}, priorityNames = []) {
    const all = Object.keys(REGISTRY);
    const names = [...all].sort((a, b) => {
      const pa = priorityNames.indexOf(a), pb = priorityNames.indexOf(b);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    });
    let done = 0;
    const queue = [...names];
    const loadOne = async (name) => {
      if (this._skipRequested) {
        this.models[name] = this.models[name] ?? null;
        done++;
        onProgress(done / names.length, `跳过 ${name} (${done}/${names.length})`);
        return;
      }
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok && !this._skipRequested; attempt++) {
        try {
          this.models[name] = await this._loadWithTimeout(REGISTRY[name], 45000);
          ok = true;
          console.log(`[assets] ${name} loaded ✓${attempt > 1 ? ` (retry ${attempt})` : ''}`);
        } catch (err) {
          console.warn(`[assets] ${name} 第 ${attempt} 次尝试失败: ${err.message}`);
        }
      }
      if (!ok) {
        this.models[name] = null;
        if (!this._skipRequested) console.warn(`[assets] ${name} 使用占位模型`);
      }
      done++;
      onProgress(done / names.length, `模型 ${name} (${done}/${names.length})`);
    };
    const worker = async () => {
      while (queue.length) {
        const name = queue.shift();
        await loadOne(name);
        if (this._skipRequested) continue;   // skip 后快速清空队列
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return this;
  }

  _loadWithTimeout(entry, ms) {
    let skipReject;
    this._skipResolve = () => skipReject(new Error('skipped'));
    return Promise.race([
      this._loadOne(entry),
      new Promise((_, rej) => {
        skipReject = rej;
        setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms);
      }),
    ]).finally(() => { this._skipResolve = null; });
  }

  async _loadOne(entry) {
    let obj;
    if (entry.fbx) {
      // FBX 路线（AIM-9M 等）：纹理不在可达目录，用空 Manager 阻断一切纹理请求（404）
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      const silentManager = new THREE.LoadingManager(
        () => {},                       // onLoad
        () => {},                       // onProgress
        (url) => { /* 纹理不可达：静默（后续统一程序材质） */ },
      );
      const realLoader = THREE.ImageLoader.prototype.load;
      THREE.ImageLoader.prototype.load = function () { return null; };
      const loader = new FBXLoader(silentManager);
      try {
        obj = await loader.loadAsync(entry.fbx);
      } finally {
        THREE.ImageLoader.prototype.load = realLoader;
      }
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const len = Math.max(size.x, size.y, size.z) || 1;
      obj.scale.setScalar((entry.targetLength ?? 3) / len);
      entry.scale = (entry.targetLength ?? 3) / len;
    } else {
      const objLoader = new OBJLoader();
      if (entry.mtl) {
        const mtlLoader = new MTLLoader();
        const basePath = entry.mtl.slice(0, entry.mtl.lastIndexOf('/') + 1);
        mtlLoader.setResourcePath(basePath);
        const materials = await mtlLoader.loadAsync(entry.mtl);
        materials.preload();
        objLoader.setMaterials(materials);
      }
      obj = await objLoader.loadAsync(entry.obj);
      obj.scale.setScalar(entry.scale ?? 1);
    }
    // 尺度/朝向校正 + 材质统一处理
    const group = new THREE.Group();
    // FBX 可能躺倒在 Y/X 轴：先摆到 Z 轴再自动定向
    if (entry.fbx) {
      const b0 = new THREE.Box3().setFromObject(obj);
      const s0 = b0.getSize(new THREE.Vector3());
      if (s0.y > s0.z * 1.5) obj.rotation.x = -Math.PI / 2;
      else if (s0.x > s0.z * 1.5) obj.rotation.z = Math.PI / 2;
    }
    // 几何自动定向：垂尾端（尾）→ +Z（引擎喷口/尾焰挂点约定在 max.z）
    const tailSign = computeTailSign(obj);
    obj.rotation.y = tailSign > 0 ? 0 : Math.PI;
    obj.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        if (!entry.mtl || entry.fallbackColor !== undefined || entry.fbx) {
          child.material = new THREE.MeshStandardMaterial({
            color: entry.fallbackColor ?? 0xcfd4da,
            metalness: 0.55, roughness: 0.4,
          });
        }
      }
    });
    group.add(obj);
    group.userData.fixY = obj.rotation.y;   // 克隆后重新应用（three r170 clone() 不复制旋转）
    return group;
  }

  // 克隆一架飞机（按类型）
  makeJet(kind, isPlayer) {
    const key = kind === 'player_f16' ? 'f16'
      : kind === 'enemy_mig29' ? 'mig29'
      : kind === 'enemy_su30' ? 'su30'
      : kind === 'player_j10c' ? 'j10c'
      : kind === 'enemy_j10c' ? 'j10c'
      : kind === 'enemy_f15c' ? 'f15c' : null;
    const proto = key ? this.models[key] : null;
    if (!proto) {
      return buildPlaceholderJet(isPlayer ? 0x5b7d9e : (kind === 'enemy_su30' ? 0x8a4a3a : 0x7a3535));
    }
    const clone = proto.clone(true);
    // three r170 clone() 的 Euler↔quaternion onChange 回调指向原型（陈旧闭包），
    // 设 rotation.y 不会同步克隆自身的 quaternion/矩阵 → 必须直接写 quaternion：
    const fixY = proto.userData.fixY ?? 0;
    const inner = clone.children.find(c => !c.userData?.baseR);
    if (inner) {
      inner.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), fixY);
      inner.updateMatrix();
      inner.updateMatrixWorld(true);
    }
    return decorateJet(clone, isPlayer, key);
  }

  makeMissile(kind) {
    const key = ['aim120', 'r77', 'aim9', 'pl12', 'pl8', 'r73'].includes(kind) ? kind : 'aim120';
    const proto = this.models[key] || this.models.aim120;
    if (proto) {
      // 真实弹体模型（克隆后直接写 quaternion 应用自动定向结果，理由同 makeJet）
      const clone = proto.clone(true);
      const fixY = proto.userData.fixY ?? 0;
      const inner = clone.children.find(c => !c.userData?.baseR);
      if (inner) {
        inner.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), fixY);
        inner.updateMatrix();
      }
      return clone;
    }
    // 回退：程序化弹体
    const geo = new THREE.CapsuleGeometry(0.28, 2.6, 4, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 0.6, roughness: 0.4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;   // capsule 沿 Y → 弹轴沿 Z
    const g = new THREE.Group();
    g.add(mesh);
    return g;
  }
}

// 喷口布局（模型空间实测，分组空间尾部 = +Z）
// f16: 单发 F110；mig29: 双发 RD-33 间距 ~1.2m；su30: 双发 AL-31F 间距 ~1.8m
const NOZZLE_LAYOUT = {
  f16:   { nozzles: [{ x: 0.0, y: -0.22 }], r: 0.52, len: 2.6 },
  mig29: { nozzles: [{ x: -0.62, y: 0.02 }, { x: 0.62, y: 0.02 }], r: 0.44, len: 2.4 },
  su30:  { nozzles: [{ x: -0.9, y: -0.54 }, { x: 0.9, y: -0.54 }], r: 0.5, len: 2.8 },
  j10c:  { nozzles: [{ x: 0.0, y: -0.25 }], r: 0.5, len: 2.6 },            // AL-31FN 单发
  f15c:  { nozzles: [{ x: -0.68, y: 0.0 }, { x: 0.68, y: 0.0 }], r: 0.5, len: 2.8 },  // F100 双发大间距
};

// 给飞机加尾喷特效挂点（升级版：外焰锥 + 内焰芯 + 光晕 sprite；userData.nozzles 数组协议）
function decorateJet(group, isPlayer, kind = 'f16') {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3(); box.getSize(size);
  const layout = NOZZLE_LAYOUT[kind] ?? NOZZLE_LAYOUT.f16;
  const tailZ = box.max.z - size.z * 0.015;

  const outerMat = new THREE.MeshBasicMaterial({
    color: 0xff8c2e, transparent: true, opacity: 0.62,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xfff3c8, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glowTex = makeGlowTexture();
  const nozzles = [];
  for (const n of layout.nozzles) {
    const holder = new THREE.Group();
    holder.position.set(n.x, n.y, tailZ);

    // 外焰（锥形，底在喷口、尖朝后 +Z）
    const outer = new THREE.Mesh(new THREE.ConeGeometry(layout.r, layout.len, 12, 1, true), outerMat.clone());
    outer.rotation.x = Math.PI / 2;            // +Y → +Z：锥尖朝后
    outer.position.z = layout.len / 2;
    // 内焰芯（更短更亮）
    const core = new THREE.Mesh(new THREE.ConeGeometry(layout.r * 0.55, layout.len * 0.55, 10, 1, true), coreMat.clone());
    core.rotation.x = Math.PI / 2;
    core.position.z = layout.len * 0.275;
    // 马赫环（小亮盘）
    const diamond = new THREE.Mesh(
      new THREE.CircleGeometry(layout.r * 0.34, 12),
      new THREE.MeshBasicMaterial({ color: 0xbfe2ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    diamond.position.z = 0.12;
    // 光晕
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffb46a, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.scale.setScalar(layout.r * 7);

    holder.add(outer, core, diamond, glow);
    group.add(holder);
    nozzles.push({ holder, outer, core, diamond, glow, baseR: layout.r, baseLen: layout.len });
  }
  group.userData.nozzles = nozzles;
  group.userData.nozzle = nozzles[0]?.outer ?? null;   // 兼容旧协议
  return group;
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,220,170,0.9)');
  g.addColorStop(0.4, 'rgba(255,150,60,0.45)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

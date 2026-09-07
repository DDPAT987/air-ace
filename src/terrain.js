// terrain.js — 真实地形：本地 terrarium 高程瓦片 → 位移网格 + Tacview 式地势分层涂色（山体阴影）
import * as THREE from 'three';
import { clamp } from './aero.js';

export class RealTerrain {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.anisotropy = opts.anisotropy ?? 8;
    this.heightSampler = null;      // (worldX, worldZ) => 海拔 m
    this.maxElevation = 0;
  }

  async load(onProgress = () => {}) {
    const manifest = await (await fetch('public/geo/manifest.json')).json();
    const { zoom, x0, x1, y0, y1, tileSize } = manifest;
    const satZoom = manifest.satZoom ?? zoom;
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;

    onProgress(0.1, '解码高程瓦片…');
    // ---- 高程：拼接为 Float32 网格 ----
    const gw = nx * tileSize, gh = ny * tileSize;
    const elevGrid = new Float32Array(gw * gh);
    let peak = 0;
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        const img = await loadImage(`public/geo/elev/${zoom}-${x0 + ix}-${y0 + iy}.png`);
        const data = getImageData(img, tileSize);
        for (let py = 0; py < tileSize; py++) {
          for (let px = 0; px < tileSize; px++) {
            const i = (py * tileSize + px) * 4;
            // terrarium 编码：h = R*256 + G + B/256 - 32768
            const h = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
            const gx = ix * tileSize + px, gy = iy * tileSize + py;
            elevGrid[gy * gw + gx] = h;
            if (h > peak) peak = h;
          }
        }
      }
      onProgress(0.1 + 0.5 * (ix + 1) / nx, `高程 ${ix + 1}/${nx}…`);
    }
    this.maxElevation = peak;

    // 世界尺寸：按纬度校准（z11 瓦片地面尺寸）
    const latC = (manifest.bbox.latMin + manifest.bbox.latMax) / 2;
    const metersPerTileX = (40075016.686 * Math.cos(latC * Math.PI / 180)) / 2 ** zoom;
    const worldW = metersPerTileX * nx;
    const worldD = metersPerTileX * ny;   // 近似方形
    this.worldW = worldW;
    this.worldD = worldD;
    this.gw = gw; this.gh = gh;

    // 采样器：世界 XZ → 网格（世界中心为原点）
    const halfW = worldW / 2, halfD = worldD / 2;
    this.heightSampler = (wx, wz) => {
      const u = (wx + halfW) / worldW;
      const v = (wz + halfD) / worldD;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
      const fx = u * (gw - 1), fy = v * (gh - 1);
      const x = Math.floor(fx), y = Math.floor(fy);
      const x2 = Math.min(x + 1, gw - 1), y2 = Math.min(y + 1, gh - 1);
      const tx = fx - x, ty = fy - y;
      const h00 = elevGrid[y * gw + x], h10 = elevGrid[y * gw + x2];
      const h01 = elevGrid[y2 * gw + x], h11 = elevGrid[y2 * gw + x2];
      return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
    };

    // ---- 网格（512 段提升山体轮廓精度）----
    onProgress(0.65, '生成地形网格…');
    const SEG = 512;
    const geo = new THREE.PlaneGeometry(worldW, worldD, SEG, SEG);
    geo.rotateX(-Math.PI / 2);   // XZ 平面，+Y 上
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i), wz = pos.getZ(i);
      const h = this.heightSampler(wx, wz);
      pos.setY(i, h);
    }
    geo.computeVertexNormals();

    // ---- Tacview 式地势涂色（高程分层设色 + 山体阴影，无需卫星影像）----
    onProgress(0.7, '生成地势涂色…');
    const tex = new Uint8ClampedArray(gw * gh * 4);
    const mPerPxX = worldW / (gw - 1), mPerPxY = worldD / (gh - 1);
    // 光照方向（西北高角度）
    const lx = -0.55, ly = -0.35, lz = 0.76;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const h = elevGrid[i];
        // 分层设色
        const [r, g, b] = hypsoColor(h);
        // 山体阴影：中心差分求法线
        const xl = elevGrid[y * gw + Math.max(x - 1, 0)], xr = elevGrid[y * gw + Math.min(x + 1, gw - 1)];
        const yl = elevGrid[Math.max(y - 1, 0) * gw + x], yr = elevGrid[Math.min(y + 1, gh - 1) * gw + x];
        const dhdx = (xr - xl) / (2 * mPerPxX);
        const dhdy = (yr - yl) / (2 * mPerPxY);
        const inv = 1 / Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
        const shade = clamp((-dhdx * lx - dhdy * ly + lz) * inv, 0, 1);
        const light = 0.5 + 0.5 * shade;
        const j = i * 4;
        tex[j] = r * light;
        tex[j + 1] = g * light;
        tex[j + 2] = b * light;
        tex[j + 3] = 255;
      }
      if (y % 256 === 0) onProgress(0.7 + 0.2 * y / gh, `涂色 ${Math.round(y / gh * 100)}%…`);
    }
    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = gw;
    colorCanvas.height = gh;
    const cctx = colorCanvas.getContext('2d');
    cctx.putImageData(new ImageData(tex, gw, gh), 0, 0);
    const texture = new THREE.CanvasTexture(colorCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.anisotropy;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;

    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.94,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0, 0);
    this.scene.add(mesh);
    this.mesh = mesh;

    // ---- 海洋平面（不写深度避免与近海地形闪烁；略低于海平面基准）----
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(worldW * 2.4, worldD * 2.4),
      new THREE.MeshStandardMaterial({
        color: 0x1d4e6e, roughness: 0.25, metalness: 0.1,
        transparent: true, opacity: 0.93, depthWrite: false,
      }),
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.y = 0.5;
    ocean.renderOrder = 1;
    this.scene.add(ocean);

    onProgress(1.0, '地形就绪');
    console.log(`[terrain] ${worldW.toFixed(0)}m x ${worldD.toFixed(0)}m, peak ${peak.toFixed(0)}m`);
    return this;
  }

  heightAt(wx, wz) { return this.heightSampler ? this.heightSampler(wx, wz) : 0; }
}

// Tacview 式高程分层设色（水/低地绿 → 丘陵黄褐 → 高山灰白）
const HYPSO_STOPS = [
  [-500, 26, 58, 102],     // 深水
  [0, 58, 112, 148],       // 浅水
  [1, 62, 108, 74],        // 海岸低地
  [300, 92, 132, 72],
  [700, 138, 152, 78],
  [1200, 176, 158, 88],
  [1800, 190, 146, 98],
  [2400, 178, 130, 108],
  [3000, 168, 158, 150],
  [3600, 225, 222, 218],   // 雪线
  [4200, 250, 250, 250],
];
function hypsoColor(h) {
  if (h <= HYPSO_STOPS[0][0]) return [HYPSO_STOPS[0][1], HYPSO_STOPS[0][2], HYPSO_STOPS[0][3]];
  for (let i = 1; i < HYPSO_STOPS.length; i++) {
    const [h1, r1, g1, b1] = HYPSO_STOPS[i];
    const [h0, r0, g0, b0] = HYPSO_STOPS[i - 1];
    if (h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t];
    }
  }
  const last = HYPSO_STOPS[HYPSO_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('加载失败: ' + url));
    img.src = url;
  });
}

function getImageData(img, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, size, size).data;
}

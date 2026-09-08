// hud.js — 战术 HUD：分数/机体/弹药/速度(KM/H+马赫)/准星/雷达/敌机标记/目标点/告警/干扰对策
import * as THREE from 'three';
import { KMH_PER_MS, HUD_COLOR, WEAPONS } from './config.js';
import { machNumber, clamp } from './aero.js';

export class HUD {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this._v = new THREE.Vector3();
    this.radarSweep = 0;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
  }

  draw(dt) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const game = this.game;
    const p = game.player;
    if (!p) return;

    this.radarSweep = (this.radarSweep + dt * 1.4) % (Math.PI * 2);

    ctx.save();
    ctx.lineWidth = 1.4;
    ctx.font = '12px Consolas, monospace';
    ctx.strokeStyle = HUD_COLOR.main;
    ctx.fillStyle = HUD_COLOR.main;

    this.drawScore();
    if (p.alive) {
      this.drawGLoad(p);
      this.drawSpeedBlock(p);
      this.drawThrottleBlock(p);
      this.drawHullBlock(p);
      this.drawWeaponsBlock();
      this.drawCrosshair(p);
      this.drawFlightPathMarker(p);
      this.drawEnemyMarkers(p);
      this.drawTargetDesignator(p);
      this.drawFlightControlRing(p);
      this.drawRadar(p);
      this.drawRWR(p);
      this.drawSupplyMarker(p);
      this.drawWarnings(p);
    }
    this.drawMessages();
    this.drawDamageVignette();
    ctx.restore();
  }

  // ---------------- 计分区 ----------------
  drawScore() {
    // Tab 锁定提示音（目标切换检测）
    if (this.game.targetIdx !== this._lastTargetIdx) {
      this._lastTargetIdx = this.game.targetIdx;
      if (this.game.targetIdx >= 0) this.game.audio?.lockTone();
    }
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    ctx.font = 'bold 15px Consolas, monospace';
    ctx.fillStyle = HUD_COLOR.main;
    ctx.fillText(`SCORE ${this.game.score}`, 22, 34);
    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = HUD_COLOR.dim;
    ctx.fillText(`击落 ${this.game.kills}   阵亡 ${this.game.deaths}   第 ${this.game.wave} 波   敌机 ${this.game.enemies.length}`, 22, 54);
    // 任务状态行（第 3 行）
    const st = this.game.missionState;
    const mi = this.game.mission;
    if (st && !st.done) {
      ctx.font = 'bold 12px Consolas, monospace';
      if (st.type === 'survival') {
        const s = Math.ceil(st.timeLeft);
        ctx.fillStyle = s <= 30 ? HUD_COLOR.danger : HUD_COLOR.warn;
        ctx.fillText(`任务：${mi?.name ?? ''} — 坚持剩余 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, 22, 72);
      } else if (st.type === 'ace') {
        const ace = this.game.enemies.find(e => e.isAce && e.alive);
        ctx.fillStyle = HUD_COLOR.danger;
        ctx.fillText(ace ? `任务：猎杀王牌 — ACE 在空（HP ${Math.ceil(ace.hp)}/${ace.maxHp}）` : '任务：猎杀王牌 — 等待王牌抵达…', 22, 72);
      } else {
        ctx.fillStyle = HUD_COLOR.info;
        ctx.fillText(`任务：${mi?.name ?? '拦截巡逻'} — 无限波次`, 22, 72);
      }
    } else if (st?.done) {
      ctx.font = 'bold 12px Consolas, monospace';
      ctx.fillStyle = HUD_COLOR.main;
      ctx.fillText('任务完成 ★', 22, 72);
    }
  }

  // ---------------- 速度（飞控圆环左侧，随屏幕自适应）----------------
  drawSpeedBlock(p) {
    const ctx = this.ctx;
    // 圆环左侧约 1/3 屏处（min 保底小屏不贴边）
    const x = Math.max(200, this.w / 2 - this.w / 6) - 74;
    const y = this.h / 2;
    const kmh = p.telemetry.speed * KMH_PER_MS;
    const mach = machNumber(p.telemetry.speed, p.telemetry.alt);
    ctx.save();
    ctx.strokeStyle = HUD_COLOR.main;
    ctx.fillStyle = HUD_COLOR.main;
    ctx.textAlign = 'right';
    // 刻度尺
    const ticks = 9;
    const base = Math.round(kmh / 100) * 100;
    for (let i = 0; i < ticks; i++) {
      const v = base + (Math.floor(ticks / 2) - i) * 100;
      const ty = y + (i - ticks / 2) * 22 + 11;
      if (v < 0) continue;
      ctx.globalAlpha = Math.abs(i - ticks / 2 + 0.5) > 3.5 ? 0.35 : 0.9;
      ctx.beginPath();
      ctx.moveTo(x + 62, ty);
      ctx.lineTo(x + (v % 200 === 0 ? 74 : 68), ty);
      ctx.stroke();
      if (v % 200 === 0) ctx.fillText(String(v), x + 58, ty + 4);
    }
    ctx.globalAlpha = 1;
    // 当前值框（下移错开刻度尺，避免与数字重叠）
    const by = y + 40;
    ctx.strokeRect(x - 26, by - 11, 92, 22);
    ctx.font = 'bold 16px Consolas, monospace';
    ctx.fillText(String(Math.round(kmh)).padStart(4, ' '), x + 60, by + 6);
    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = HUD_COLOR.dim;
    ctx.fillText('KM/H', x + 60, by + 26);
    // 马赫 / 高度（值框上方堆叠；G 已移至屏幕顶部）
    ctx.fillStyle = mach > 1 ? HUD_COLOR.warn : HUD_COLOR.main;
    ctx.font = 'bold 15px Consolas, monospace';
    ctx.fillText(`M ${mach.toFixed(2)}`, x + 60, y - 22);
    const alt = p.telemetry.alt;
    ctx.fillStyle = HUD_COLOR.main;
    ctx.fillText(`${Math.round(alt).toLocaleString()} m`, x + 60, y - 40);
    ctx.restore();
  }

  // ---------------- 过载（屏幕顶部中央，避免与速度块拥挤）----------------
  drawGLoad(p) {
    const ctx = this.ctx;
    const g = p.telemetry.gLoad;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 18px Consolas, monospace';
    ctx.fillStyle = Math.abs(g) > 8 ? HUD_COLOR.danger
      : Math.abs(g) > 6 ? HUD_COLOR.warn : HUD_COLOR.main;
    ctx.fillText(`${g >= 0 ? '+' : ''}${g.toFixed(1)} G`, this.w / 2, 46);
    // 过载刻度条（0 居中，±10G）
    const bw = 150, bx = this.w / 2 - bw / 2, by = 54;
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = HUD_COLOR.main;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + bw, by); ctx.stroke();
    for (let gg = -10; gg <= 10; gg += 5) {
      const tx = bx + (gg + 10) / 20 * bw;
      ctx.beginPath(); ctx.moveTo(tx, by); ctx.lineTo(tx, by - 4); ctx.stroke();
    }
    const gv = Math.max(-10, Math.min(10, g));
    ctx.globalAlpha = 1;
    ctx.fillStyle = Math.abs(g) > 8 ? HUD_COLOR.danger : Math.abs(g) > 6 ? HUD_COLOR.warn : HUD_COLOR.main;
    ctx.beginPath();
    ctx.moveTo(bx + (gv + 10) / 20 * bw, by + 4); ctx.lineTo(bx + (gv + 10) / 20 * bw - 4, by + 10);
    ctx.lineTo(bx + (gv + 10) / 20 * bw + 4, by + 10); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ---------------- 油门/燃油（飞控圆环右侧，随屏幕自适应）----------------
  drawThrottleBlock(p) {
    const ctx = this.ctx;
    const x = Math.min(this.w - 240, this.w / 2 + this.w / 6) - 8;
    const y = this.h / 2 - 60;
    ctx.save();
    // 油门竖条
    ctx.strokeRect(x, y, 14, 120);
    const th = p.telemetry.throttle;
    ctx.fillStyle = th >= 0.99 ? HUD_COLOR.warn : HUD_COLOR.main;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x + 1, y + 120 - 118 * th, 12, 118 * th);
    ctx.globalAlpha = 1;
    ctx.fillStyle = HUD_COLOR.main;
    ctx.textAlign = 'left';
    ctx.fillText(`THR ${Math.round(th * 100)}%`, x + 22, y + 12);
    ctx.fillText(p.telemetry.afterburner ? 'AB 加力' : 'MIL', x + 22, y + 28);
    // 燃油
    const fuelFrac = p.fuel / (p.spec.fuel ?? 1);
    ctx.fillStyle = fuelFrac < 0.2 ? HUD_COLOR.danger : HUD_COLOR.main;
    ctx.fillText(`FUEL ${Math.round(p.fuel)}`, x + 22, y + 48);
    ctx.strokeRect(x + 22, y + 56, 80, 7);
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x + 23, y + 57, 78 * clamp(fuelFrac, 0, 1), 5);
    ctx.restore();
  }

  // ---------------- 机体状况（左下）----------------
  drawHullBlock(p) {
    const ctx = this.ctx;
    const x = 30, y = this.h - 96;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.fillStyle = HUD_COLOR.main;
    ctx.fillText('AIRFRAME 机体', x, y);
    const frac = p.hp / p.maxHp;
    ctx.strokeRect(x, y + 8, 170, 12);
    ctx.fillStyle = frac > 0.55 ? HUD_COLOR.main : frac > 0.25 ? HUD_COLOR.warn : HUD_COLOR.danger;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(x + 1, y + 9, 168 * clamp(frac, 0, 1), 10);
    ctx.globalAlpha = 1;
    ctx.fillText(`${Math.round(p.hp)}%`, x + 178, y + 18);
    // 迎角/侧滑
    ctx.fillStyle = p.telemetry.stallWarn ? HUD_COLOR.warn : HUD_COLOR.dim;
    ctx.fillText(`AoA ${p.telemetry.alpha.toFixed(1)}°  AoS ${p.telemetry.beta.toFixed(1)}°`, x, y + 38);
    ctx.restore();
  }

  // ---------------- 弹药（左下：弹种名称 × 数字）----------------
  drawWeaponsBlock() {
    const ctx = this.ctx;
    const x = 30, y = this.h - 42;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = '13px Consolas, monospace';
    // 航炮
    const gunMax = this.game._maxGunRounds ?? WEAPONS.gun.rounds;
    ctx.fillStyle = this.game.gunRounds > gunMax * 0.3 ? HUD_COLOR.main : HUD_COLOR.warn;
    ctx.fillText(`GUN ${this.game.gunRounds}`, x, y);
    if (this.game.gunHeat > 0.7) {
      ctx.fillStyle = HUD_COLOR.danger;
      ctx.fillText('过热', x + 86, y);
    }
    // 导弹：弹种 × 数字（当前选中高亮框）
    const m9 = this.game.missile9Count ?? 0;
    const max120 = this.game._maxMissiles ?? WEAPONS.aim120.count;
    const max9 = this.game._maxMissiles9 ?? WEAPONS.aim9.count;
    const sel = this.game.selectedWeapon;
    const drawW = (label, n, max, x0, selected) => {
      const w = ctx.measureText(label).width;
      if (selected) {
        ctx.strokeStyle = HUD_COLOR.main;
        ctx.globalAlpha = 0.9;
        ctx.strokeRect(x0 - 5, y - 14, w + 34, 18);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = n > 0 ? (selected ? HUD_COLOR.warn : HUD_COLOR.main) : HUD_COLOR.danger;
      ctx.fillText(label, x0, y);
      ctx.fillStyle = n > 0 ? HUD_COLOR.warn : HUD_COLOR.danger;
      ctx.font = 'bold 14px Consolas, monospace';
      ctx.fillText(`×${n}`, x0 + w + 6, y);
      ctx.font = '13px Consolas, monospace';
      ctx.fillStyle = HUD_COLOR.dim;
      ctx.fillText(`/${max}`, x0 + w + 26, y);
      ctx.fillStyle = HUD_COLOR.main;
    };
    const lo = this.game._loadout ?? { mr: 'aim120', ir: 'aim9' };
    drawW(WEAPONS[lo.mr]?.name ?? 'AIM-120', this.game.missileCount, max120, x + 130, sel === lo.mr);
    drawW(WEAPONS[lo.ir]?.name ?? 'AIM-9', m9, max9, x + 260, sel === lo.ir);
    // 干扰对策余量（常驻显示）
    const maxF = 36, maxC = 24;
    ctx.fillStyle = this.game.flareCount > 6 ? HUD_COLOR.main : HUD_COLOR.warn;
    ctx.fillText(`FLR ${'▮'.repeat(Math.ceil(this.game.flareCount / maxF * 12))} ${this.game.flareCount}`, x + 380, y);
    ctx.fillStyle = this.game.chaffCount > 4 ? HUD_COLOR.main : HUD_COLOR.warn;
    ctx.fillText(`CHF ${'▮'.repeat(Math.ceil(this.game.chaffCount / maxC * 8))} ${this.game.chaffCount}`, x + 540, y);
    ctx.restore();
  }

  // ---------------- 准星（机炮 pipper）----------------
  drawCrosshair(p) {
    const ctx = this.ctx;
    const cx = this.w / 2, cy = this.h / 2 + 20;
    ctx.save();
    ctx.strokeStyle = HUD_COLOR.main;
    ctx.globalAlpha = 0.9;
    // 中心十字
    ctx.beginPath();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      ctx.moveTo(cx + dx * 8, cy + dy * 8);
      ctx.lineTo(cx + dx * 22, cy + dy * 22);
    }
    ctx.stroke();
    // 外圈
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------- 速度矢量标记（flight path marker）----------------
  drawFlightPathMarker(p) {
    // 将速度方向投影到屏幕
    const dir = p.velocity.clone().normalize();
    const proj = this.projectAlong(p.position, dir);
    if (!proj) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = HUD_COLOR.info;
    ctx.globalAlpha = 0.85;
    const { x, y } = proj;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.moveTo(x - 14, y); ctx.lineTo(x - 7, y);
    ctx.moveTo(x + 7, y); ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 7);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------- 敌机标记 + 目点 ----------------
  drawEnemyMarkers(p) {
    const ctx = this.ctx;
    const cam = this.game.camera;
    for (const e of this.game.enemies) {
      if (!e.alive) continue;
      const dist = e.position.distanceTo(p.position);
      const v = e.position.clone().project(cam);
      const onScreen = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      const x = (v.x * 0.5 + 0.5) * this.w;
      const y = (-v.y * 0.5 + 0.5) * this.h;
      const isTarget = e === this.game.target;
      const isAce = !!e.isAce;
      ctx.save();
      ctx.strokeStyle = isTarget ? HUD_COLOR.warn : 'rgba(255,110,110,0.85)';
      ctx.lineWidth = isTarget ? 2 : 1.2;
      if (onScreen) {
        const s = clamp(2600 / Math.max(dist, 200), 10, 34);
        if (isAce) {
          ctx.font = 'bold 11px Consolas, monospace';
          ctx.fillStyle = '#ff5d5d';
          ctx.textAlign = 'center';
          ctx.fillText('ACE', x, y - s - 8);
        }
        // 角框
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.moveTo(x + sx * s, y + sy * s - sy * s * 0.5);
          ctx.lineTo(x + sx * s, y + sy * s);
          ctx.lineTo(x + sx * s - sx * s * 0.5, y + sy * s);
        }
        ctx.stroke();
        // 信息
        ctx.font = '11px Consolas, monospace';
        ctx.fillStyle = isTarget ? HUD_COLOR.warn : 'rgba(255,140,140,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText(`${(dist / 1000).toFixed(1)}km`, x, y + s + 14);
        if (isTarget) {
          ctx.fillStyle = HUD_COLOR.warn;
          ctx.fillText('TGT', x, y - s - 8);
          // 机炮前置点（lead pipper）
          this.drawGunLead(p, e);
        }
      } else {
        // 屏幕边缘方向箭头
        const dir2 = e.position.clone().sub(p.position);
        const fwd = p.forward();
        const angle = Math.atan2(
          dir2.dot(p.right().clone().negate()),
          dir2.dot(fwd),
        );
        const edgeR = Math.min(this.w, this.h) * 0.42;
        const ex = this.w / 2 - Math.sin(angle) * edgeR;
        const ey = this.h / 2 - Math.cos(angle) * edgeR * 0.6 + 20;
        ctx.translate(ex, ey);
        ctx.rotate(-angle);
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.lineTo(6, 4);
        ctx.lineTo(-6, 4);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ---------------- 机炮前置点 ----------------
  drawGunLead(p, e) {
    // 前置拦截点投影
    const dist = e.position.distanceTo(p.position);
    const tGo = dist / WEAPONS.gun.muzzleVel;
    const aim = e.position.clone().addScaledVector(e.velocity, tGo)
      .addScaledVector(p.velocity.clone().negate(), tGo);
    const v = aim.project(this.game.camera);
    if (v.z >= 1) return;
    const x = (v.x * 0.5 + 0.5) * this.w;
    const y = (-v.y * 0.5 + 0.5) * this.h;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,220,120,0.9)';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.moveTo(x - 9, y); ctx.lineTo(x - 5, y);
    ctx.moveTo(x + 5, y); ctx.lineTo(x + 9, y);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------- 目标点（雷达导引目标/锁定状态）----------------
  drawTargetDesignator(p) {
    const t = this.game.target;
    if (!t) return;
    const ctx = this.ctx;
    // 导弹发射包线提示：接近率与偏角
    const toT = t.position.clone().sub(p.position);
    const dist = toT.length();
    const closing = toT.clone().multiplyScalar(-1).dot(t.velocity.clone().sub(p.velocity)) / dist;
    const offAngle = Math.acos(clamp(toT.clone().normalize().dot(p.forward()), -1, 1)) * 180 / Math.PI;
    const inRange = dist < 15000 && offAngle < 25;
    const rWr = t.ai?.missileCooldown !== undefined;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 13px Consolas, monospace';
    ctx.fillStyle = inRange ? HUD_COLOR.warn : HUD_COLOR.dim;
    ctx.fillText(inRange ? '⊙ IN RNG  SHOOT' : 'OUT OF RNG', this.w / 2, this.h / 2 + 76);
    ctx.font = '11px Consolas, monospace';
    ctx.fillStyle = HUD_COLOR.dim;
    ctx.fillText(`接近率 ${Math.round(closing)} m/s  偏角 ${offAngle.toFixed(0)}°  距离 ${(dist / 1000).toFixed(1)}km`, this.w / 2, this.h / 2 + 92);
    ctx.restore();
  }

  // ---------------- 雷达（右下：B-Scope 方框，竖线 15° 分格，无伞形）----------------
  drawRadar(p) {
    const ctx = this.ctx;
    const S = 196;                        // 固定方框边长
    const x0 = this.w - S - 34, y0 = this.h - S - 34;
    const rangeKm = this.game.settings?.data?.radarRange ?? 20;
    const range = rangeKm * 1000;
    const scanDeg = Math.min(85, this.game.settings?.data?.radarScan ?? 65);  // B-scope 视场上限 85°（>90° tan 发散）
    const halfAngle = scanDeg * Math.PI / 180;
    const scale = (S - 30) / range;       // m → px（前方满幅）
    ctx.save();
    // 面板底
    ctx.fillStyle = 'rgba(6,16,12,0.55)';
    ctx.fillRect(x0, y0, S, S);
    ctx.strokeStyle = HUD_COLOR.main;
    ctx.globalAlpha = 0.8;
    ctx.strokeRect(x0, y0, S, S);
    // 距离网格（水平线，按范围 1/4 步进）
    ctx.globalAlpha = 0.28;
    ctx.font = '9px Consolas, monospace';
    ctx.textAlign = 'left';
    const cy = y0 + S - 26;
    for (let i = 1; i <= 3; i++) {
      const km = Math.round(rangeKm) / 4 * i;
      const gy = cy - km * 1000 * scale;
      if (gy < y0 + 16) break;
      ctx.beginPath(); ctx.moveTo(x0 + 4, gy); ctx.lineTo(x0 + S - 4, gy); ctx.stroke();
      ctx.fillStyle = HUD_COLOR.dim;
      ctx.fillText(`${Math.round(km * 10) / 10}`, x0 + 4, gy - 3);
    }
    // 方位竖线：间隔 = 15° 扫描角（自中心向两侧，至扫描角边界）
    ctx.globalAlpha = 0.22;
    for (let d = 15; d <= scanDeg; d += 15) {
      for (const s of [-1, 1]) {
        const vx = x0 + S / 2 + s * Math.tan(d * Math.PI / 180) / Math.tan(halfAngle) * (S / 2 - 8);
        if (vx <= x0 + 4 || vx >= x0 + S - 4) continue;
        ctx.beginPath(); ctx.moveTo(vx, y0 + 18); ctx.lineTo(vx, y0 + S - 22); ctx.stroke();
      }
    }
    // 中心线（机头方位，稍亮）
    ctx.globalAlpha = 0.4;
    ctx.beginPath(); ctx.moveTo(x0 + S / 2, y0 + 18); ctx.lineTo(x0 + S / 2, y0 + S - 22); ctx.stroke();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = HUD_COLOR.main;
    // ---- 接触点（平面俯视，机头朝上；水平角线性映射到面板宽）----
    const fwd = p.forward().clone(); fwd.y = 0; fwd.normalize();
    const right = p.right().clone(); right.y = 0; right.normalize();
    const plot = (rel) => {
      const fx = rel.dot(right);
      const fy = rel.dot(fwd);            // 前方为正
      const dist = Math.hypot(fx, fy);
      const ang = Math.atan2(fx, fy);     // +：右偏
      const nx = clamp(Math.tan(ang) / Math.tan(halfAngle), -1, 1);   // B-scope 线性角
      const ny = clamp(dist / range, 0, 1);
      return { x: x0 + S / 2 + nx * (S / 2 - 8), y: cy - ny * (S - 34), clipped: dist > range || Math.abs(ang) > halfAngle };
    };
    // 补给点（青色菱形）
    const sz = this.game.supplyZone;
    if (sz) {
      const q = plot(sz.position.clone().sub(p.position));
      ctx.fillStyle = '#37e6ff';
      if (!q.clipped) {
        ctx.beginPath();
        ctx.moveTo(q.x, q.y - 5); ctx.lineTo(q.x + 5, q.y); ctx.lineTo(q.x, q.y + 5); ctx.lineTo(q.x - 5, q.y);
        ctx.closePath(); ctx.fill();
      } else { ctx.fillRect(q.x - 3, q.y - 3, 6, 6); }
    }
    // 敌机（红色三角，锁定目标加框+数据；距离或方位超出扫描范围不显示）
    for (const e of this.game.enemies) {
      if (!e.alive) continue;
      const rel = e.position.clone().sub(p.position);
      if (rel.length() > range) continue;
      const rfx = rel.dot(right), rfy = rel.dot(fwd);
      if (Math.abs(Math.atan2(rfx, rfy)) > (this.game.settings?.data?.radarScan ?? 65) * Math.PI / 180) continue;
      const q = plot(rel);
      ctx.fillStyle = 'rgba(255,110,110,0.95)';
      ctx.beginPath();
      ctx.moveTo(q.x, q.y - 5); ctx.lineTo(q.x + 4.5, q.y + 4); ctx.lineTo(q.x - 4.5, q.y + 4);
      ctx.closePath(); ctx.fill();
      if (e === this.game.target) {
        ctx.strokeStyle = HUD_COLOR.warn;
        ctx.strokeRect(q.x - 8, q.y - 8, 16, 16);
        const dKm = (e.position.distanceTo(p.position) / 1000).toFixed(1);
        const dAlt = Math.round((e.position.y - p.position.y) / 100) / 10;
        ctx.fillStyle = HUD_COLOR.warn;
        ctx.font = '9px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${dKm}km ${dAlt >= 0 ? '+' : ''}${dAlt}`, q.x, q.y - 12);
      }
    }
    // 来袭导弹（闪烁三角）
    if (Math.floor(this.game.time * 4) % 2 === 0) {
      ctx.fillStyle = '#ff5d5d';
      for (const m of this.game.missiles) {
        if (!m.alive || m.target !== p) continue;
        const q = plot(m.position.clone().sub(p.position));
        ctx.beginPath();
        ctx.moveTo(q.x, q.y - 5); ctx.lineTo(q.x + 4, q.y + 4); ctx.lineTo(q.x - 4, q.y + 4);
        ctx.closePath(); ctx.fill();
      }
    }
    // 本机符号（底部中央箭头）
    ctx.globalAlpha = 1;
    ctx.fillStyle = HUD_COLOR.main;
    ctx.beginPath();
    ctx.moveTo(x0 + S / 2, cy - 7); ctx.lineTo(x0 + S / 2 + 5, cy + 6); ctx.lineTo(x0 + S / 2, cy + 3); ctx.lineTo(x0 + S / 2 - 5, cy + 6);
    ctx.closePath(); ctx.fill();
    // 标签
    ctx.fillStyle = HUD_COLOR.dim;
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('RADAR', x0 + 8, y0 + 14);
    ctx.textAlign = 'right';
    ctx.fillText(`${rangeKm}KM ±${this.game.settings?.data?.radarScan ?? 65}°`, x0 + S - 8, y0 + 14);
    ctx.restore();
  }

  // ---------------- RWR 雷达告警接收机（正左：左边缘垂直居中圆盘）----------------
  drawRWR(p) {
    const ctx = this.ctx;
    const R = 84;
    const cx = R + 30, cy = this.h / 2;
    const threats = this.game.rwrThreats ? this.game.rwrThreats() : [];
    // 威胁音：来袭导弹急促 / 被锁定常规
    const missileInbound = threats.some(t => t.kind === 'missile');
    const locked = threats.some(t => t.kind === 'lock');
    if (missileInbound) this.game.audio?.rwrBeep(true);
    else if (locked) this.game.audio?.rwrBeep(false);
    ctx.save();
    // 底盘
    ctx.strokeStyle = HUD_COLOR.main;
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = 'rgba(20,8,8,0.5)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    // 方位刻度（每 30°）
    ctx.font = '8px Consolas, monospace';
    ctx.fillStyle = HUD_COLOR.dim;
    ctx.textAlign = 'center';
    for (let a = 0; a < 360; a += 30) {
      const rad1 = (a - 90) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(rad1) * (R - 6), cy + Math.sin(rad1) * (R - 6));
      ctx.lineTo(cx + Math.cos(rad1) * R, cy + Math.sin(rad1) * R);
      ctx.stroke();
    }
    ctx.fillText('0', cx, cy - R - 4);
    // 本机
    ctx.globalAlpha = 1;
    ctx.fillStyle = HUD_COLOR.main;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5); ctx.lineTo(cx + 4, cy + 4); ctx.lineTo(cx - 4, cy + 4);
    ctx.closePath(); ctx.fill();
    // 辐射源（方位-only，机头为上）
    const fwd = p.forward().clone(); fwd.y = 0; fwd.normalize();
    const right = p.right().clone(); right.y = 0; right.normalize();
    const blink = Math.floor(this.game.time * 5) % 2 === 0;
    let shown = 0;
    // 优先级：导弹 > 锁定 > 跟踪
    const ordered = threats.sort((a, b) =>
      (a.kind === 'missile' ? 0 : a.kind === 'lock' ? 1 : 2) - (b.kind === 'missile' ? 0 : b.kind === 'lock' ? 1 : 2));
    for (const t of ordered) {
      if (shown >= 7) break;
      const rel = t.bearingFrom.clone(); rel.y = 0;
      const brg = Math.atan2(rel.dot(right), rel.dot(fwd));    // 0=正前
      const px = cx + Math.sin(brg) * (R - 18);
      const py = cy - Math.cos(brg) * (R - 18);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(brg);
      if (t.kind === 'missile') {
        if (blink) {
          ctx.fillStyle = '#ff4de1';
          ctx.beginPath();
          ctx.moveTo(0, -6); ctx.lineTo(5, 5); ctx.lineTo(-5, 5);
          ctx.closePath(); ctx.fill();
        }
      } else if (t.kind === 'lock') {
        ctx.fillStyle = '#ff5d5d';
        ctx.beginPath();
        ctx.moveTo(0, -6); ctx.lineTo(5, 5); ctx.lineTo(-5, 5);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = '#ffd24d';
        ctx.beginPath();
        ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      shown++;
    }
    ctx.fillStyle = HUD_COLOR.dim;
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('RWR', cx, cy + R + 14);
    ctx.restore();
  }

  // ---------------- 战雷式飞控圆环（机头追逐圆环=世界瞄准方向）----------------
  drawFlightControlRing(p) {
    const input = this.game.input;
    if (!input?.aimDir) return;
    const ctx = this.ctx;
    // 圆环画在瞄准方向射线的屏幕投影处（从相机沿 aimDir 取远点投影，
    // 与 input._projectCursor 的反投影互逆 → 圆环精确跟随鼠标位置，机头追上后自然回中）
    const cam = this.game.camera;
    const v = cam.position.clone().addScaledVector(input.aimDir, 10000).project(cam);
    let cx = (v.x * 0.5 + 0.5) * this.w;
    let cy = (-v.y * 0.5 + 0.5) * this.h;
    const offScreen = v.z >= 1 || cx < -80 || cx > this.w + 80 || cy < -80 || cy > this.h + 80;
    // 屏外钳制到边缘（方向仍可读）
    cx = clamp(cx, 36, this.w - 36);
    cy = clamp(cy, 36, this.h - 36);
    const dcx = cx - this.w / 2, dcy = cy - this.h / 2;
    const mag = Math.hypot(dcx, dcy) / (Math.min(this.w, this.h) / 2);
    const alpha = input.cursorActive ? 0.95 : Math.max(0.3, 0.75 - mag * 0.6);
    ctx.save();
    ctx.strokeStyle = HUD_COLOR.warn;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2); ctx.stroke();
    // 中心点
    ctx.fillStyle = HUD_COLOR.warn;
    ctx.beginPath(); ctx.arc(cx, cy, 2.4, 0, Math.PI * 2); ctx.fill();
    // 上方小标线（指示环的"上"）
    ctx.beginPath(); ctx.moveTo(cx, cy - 30); ctx.lineTo(cx, cy - 22); ctx.stroke();
    // 指挥线（机头 → 圆环，弱化虚线）
    if (mag > 0.05) {
      ctx.globalAlpha = alpha * 0.35;
      ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.moveTo(this.w / 2, this.h / 2); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 1.4;
    ctx.restore();
  }

  // ---------------- 补给点标记（屏内菱形 / 屏外箭头）----------------
  drawSupplyMarker(p) {
    const sz = this.game.supplyZone;
    if (!sz) return;
    const ctx = this.ctx;
    const dist = p.position.distanceTo(sz.position);
    const v = sz.position.clone().project(this.game.camera);
    if (v.z >= 1) return;
    let x = (v.x * 0.5 + 0.5) * this.w;
    let y = (-v.y * 0.5 + 0.5) * this.h;
    const onScreen = x > 40 && x < this.w - 40 && y > 40 && y < this.h - 40;
    ctx.save();
    ctx.strokeStyle = '#37e6ff';
    ctx.fillStyle = '#37e6ff';
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'center';
    if (onScreen) {
      ctx.beginPath();
      ctx.moveTo(x, y - 12); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 12); ctx.lineTo(x - 9, y);
      ctx.closePath(); ctx.stroke();
      ctx.fillText(`补给 ${(dist / 1000).toFixed(1)}km`, x, y + 26);
    } else {
      // 屏外：边缘箭头
      const dx = x - this.w / 2, dy = y - this.h / 2;
      const ang = Math.atan2(dy, dx);
      const rx = this.w / 2 - 60, ry = this.h / 2 - 60;
      const t = Math.min(Math.abs(rx / (Math.cos(ang) || 1e-6)), Math.abs(ry / (Math.sin(ang) || 1e-6)));
      x = this.w / 2 + Math.cos(ang) * t;
      y = this.h / 2 + Math.sin(ang) * t;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(10, 0); ctx.lineTo(-6, 6); ctx.lineTo(-6, -6);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillText(`补给 ${(dist / 1000).toFixed(0)}km`, x, y + 20);
    }
    ctx.restore();
  }

  // ---------------- 告警 ----------------
  drawWarnings(p) {
    const ctx = this.ctx;
    const t = p.telemetry;
    const blink = Math.floor(performance.now() / 250) % 2 === 0;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 18px Consolas, monospace';
    if (t.stall && blink) {
      ctx.fillStyle = HUD_COLOR.danger;
      ctx.fillText('⚠ STALL 失速', this.w / 2, this.h / 2 - 120);
    } else if (t.stallWarn && blink) {
      ctx.fillStyle = HUD_COLOR.warn;
      ctx.fillText('⚠ LOW SPEED 低速', this.w / 2, this.h / 2 - 120);
    }
    if (Math.abs(t.gLoad) > 8.4 && blink) {
      ctx.fillStyle = HUD_COLOR.danger;
      ctx.fillText('⚠ OVER-G 过载', this.w / 2, this.h / 2 - 96);
    }
    // 导弹告警 + 对抗提示（按弹种给对策）
    const inbound = this.game.missiles.find(m => m.alive && m.target === p);
    if (inbound && blink) {
      const irTag = (inbound.spec.flareDecoyFactor ?? 1) >= 0.5;
      ctx.fillStyle = HUD_COLOR.danger;
      ctx.font = 'bold 20px Consolas, monospace';
      ctx.fillText(`⚠ ${inbound.spec.name} ${irTag ? '红外弹' : '雷达弹'} 来袭`, this.w / 2, this.h / 2 - 144);
    }
    if (inbound) {
      const isIR = (inbound.spec.flareDecoyFactor ?? 1) >= 0.5;
      const kb = this.game.settings.data.keybinds;
      const fKey = keyName(kb.flare), cKey = keyName(kb.chaff);
      ctx.font = 'bold 14px Consolas, monospace';
      if (isIR) {
        ctx.fillStyle = this.game.flareCount > 0 ? HUD_COLOR.warn : 'rgba(120,120,120,0.8)';
        ctx.fillText(`[${fKey}] 热诱弹 ×${this.game.flareCount}（红外弹克星）`, this.w / 2, this.h / 2 - 122);
      } else {
        // 雷达弹：显示 39 机动（beaming）执行质量
        const los = inbound.position.clone().sub(p.position);
        const dist = Math.max(los.length(), 1);
        const losHat = los.divideScalar(dist);
        const spd = p.velocity.length();
        const beam = spd > 40 ? Math.abs(p.velocity.dot(losHat)) / spd : 1;
        const chaffFresh = this.game.chaffs.some(c =>
          c.alive && c.owner === p && c.position.distanceTo(p.position) < 1400);
        if (beam < 0.35) {
          ctx.fillStyle = chaffFresh ? '#7dff9a' : HUD_COLOR.warn;
          ctx.fillText(chaffFresh
            ? '39 机动 ✓ 箔条生效中 — 导弹即将脱锁'
            : `39 机动 ✓ 径向速度低 — 立即撒箔条 [${cKey}] ×${this.game.chaffCount}`,
            this.w / 2, this.h / 2 - 122);
        } else {
          ctx.fillStyle = '#ffb84d';
          ctx.fillText(`侧转脱离弹轴线（39 机动）→ 箔条 [${cKey}] ×${this.game.chaffCount}`, this.w / 2, this.h / 2 - 122);
        }
      }
    }
    // FCS 状态
    ctx.font = '11px Consolas, monospace';
    ctx.fillStyle = HUD_COLOR.dim;
    const fcs = p.fcs.telemetry;
    const modes = [];
    if (fcs.keyboardActive) modes.push('KEYB');
    if (fcs.mouseActive) modes.push('MOUSE-PID');
    if (fcs.gLimited) modes.push('G-LIM');
    if (fcs.alphaLimited) modes.push('AOA-LIM');
    if (fcs.energyLimited) modes.push('ENERGY');
    if (fcs.stall) modes.push('STALL');
    ctx.fillText(`FCS: ${modes.join(' · ') || 'DAMP'}`, this.w / 2, this.h - 16);
    ctx.restore();
  }

  // ---------------- 消息 ----------------
  drawMessages() {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = '13px Consolas, monospace';
    let y = 96;
    for (const m of this.game.messages) {
      ctx.globalAlpha = clamp(m.time, 0, 1);
      ctx.fillStyle = m.color;
      ctx.fillText(m.text, 22, y);
      y += 20;
    }
    ctx.restore();
  }

  drawDamageVignette() {
    const g = this.game;
    if (g.hitFlash <= 0.01) return;
    const ctx = this.ctx;
    const grad = ctx.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.3, this.w / 2, this.h / 2, this.h * 0.75);
    grad.addColorStop(0, 'rgba(255,40,40,0)');
    grad.addColorStop(1, `rgba(255,40,40,${0.4 * g.hitFlash})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  projectAlong(origin, dir) {
    // 从 origin 沿 dir 的远点投影（用于 flight path marker）
    const far = origin.clone().addScaledVector(dir, 500);
    const v = far.project(this.game.camera);
    if (v.z >= 1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h };
  }
}

function keyName(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = { Space: '空格', ShiftLeft: 'L-Shift', ControlLeft: 'L-Ctrl' };
  return map[code] ?? code;
}

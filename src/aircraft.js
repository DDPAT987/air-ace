// aircraft.js — 飞机实体：气动状态积分 + FCS + 燃油 + 生命值 + 视觉网格管理
import * as THREE from 'three';
import { computeForces, integrateAttitude, computeAeroAngles, clamp, damp, deg } from './aero.js';
import { FlightController } from './fcs.js';
import { G, airDensity } from './config.js';

let nextId = 1;

export class Aircraft {
  constructor(spec, { position, velocity, quat, isPlayer = false, team = 'blue' } = {}) {
    this.id = nextId++;
    this.spec = spec;
    this.isPlayer = isPlayer;
    this.team = team;
    this.position = position.clone();
    this.velocity = velocity.clone();
    this.quat = quat ? quat.clone() : new THREE.Quaternion();
    this.rates = { p: 0, q: 0, r: 0 };       // 当前机体角速度 rad/s
    this.throttle = 0.8;
    this.afterburner = false;
    this.fuel = spec.fuel ?? Infinity;
    this.hp = 100;
    this.maxHp = 100;
    this.alive = true;
    this.fcs = new FlightController(spec);
    // 遥测显示用
    this.telemetry = {
      speed: 0, alt: 0, mach: 0, alpha: 0, beta: 0, gLoad: 1,
      stall: false, stallWarn: false, throttle: 0.8, afterburner: false, fuel: 0,
    };
    // 视觉（由 game 注入 object3D）
    this.object3D = null;
    this.trailEmitter = null;
  }

  // dt: 秒；command: { pitch, roll, yaw, throttle } -1..1（来自键盘/AI）
  // mouseInput: { pitch, roll } 或 null（玩家时由 game 提供）
  update(dt, command, mouseInput = null) {
    if (!this.alive) return;
    const spec = this.spec;

    // ---- 油门 ----
    if (command.throttle !== undefined) {
      this.throttle = clamp(command.throttle, 0, 1);
    }
    this.afterburner = this.throttle >= 0.99 && this.fuel > 0;

    // ---- 燃油 ----
    if (this.fuel !== Infinity) {
      const burn = this.afterburner ? spec.fuelBurnAB : spec.fuelBurnMil * this.throttle;
      this.fuel = Math.max(0, this.fuel - burn * dt);
      if (this.fuel <= 0) this.throttle = Math.min(this.throttle, 0.3); // 亏油推力受限
    }

    // ---- FCS：包线保护 + 键盘优先 + 鼠标 PID ----
    const fcsCmd = this.fcs.update(dt, {
      keyboard: { pitch: command.pitch || 0, roll: command.roll || 0, yaw: command.yaw || 0 },
      mouse: mouseInput ?? { pitch: 0, roll: 0, yaw: 0 },
      state: this,
      rates: this.rates,
    });

    // ---- 姿态：角速度跟踪（一阶滞后模拟舵机响应）+ 轻微滚转阻尼 ----
    const resp = 8.0;
    const pDamp = -0.45 * this.rates.p;
    this.rates.p = damp(this.rates.p, fcsCmd.p + pDamp, resp, dt);
    this.rates.q = damp(this.rates.q, fcsCmd.q, resp, dt);
    this.rates.r = damp(this.rates.r, fcsCmd.r, resp, dt);
    this.quat = integrateAttitude(this.quat, this.rates, dt);

    // ---- 速度矢量动力学（混合模型：路径跟随 + 能量管理）----
    // 模型：
    //   1) 路径方向以一阶滞后对准机头（气动导向，动压相关）——升力使轨迹弯曲
    //   2) 重力持续使路径下弯 —— 与 1) 平衡得到配平迎角 α_trim ≈ g/(V·k_align)
    //   3) 速度标量由 推力/阻力/重力沿路径分量 积分
    const speed = this.velocity.length();
    const vDir = speed > 0.5 ? this.velocity.clone().divideScalar(speed) : this.forward();
    const fwd = this.forward();
    const rho = airDensity(Math.max(0, this.position.y));
    const dynP = clamp(speed / 160, 0.15, 1) * clamp(rho / 1.225 + 0.25, 0.3, 1);

    // 当前迎角/侧滑（用于阻力与遥测）
    const { alpha, beta } = computeAeroAngles(this.velocity, this.quat);
    const alphaDeg = Math.abs(alpha * 180 / Math.PI);

    // 对准速率（rad/s）：迎角越大转得越快，受结构 G 限制
    const alignK = 2.2 * dynP;
    const angleNF = Math.acos(clamp(vDir.dot(fwd), -1, 1));   // 机头-路径夹角
    const alignRate = Math.min(alignK * angleNF, (spec.maxG * G) / Math.max(speed, 60));
    if (angleNF > 1e-5 && alignRate > 0) {
      const axis = new THREE.Vector3().crossVectors(vDir, fwd);
      if (axis.lengthSq() > 1e-10) {
        axis.normalize();
        vDir.applyAxisAngle(axis, Math.min(alignRate * dt, angleNF));
      }
    }

    // 重力弯曲路径（垂直于路径的分量；旋转轴 = vDir×gPerp 才是向下的正确旋向）
    const gPerp = new THREE.Vector3(0, -1, 0).addScaledVector(vDir, vDir.y); // 垂直于 vDir 的向下分量
    if (gPerp.lengthSq() > 1e-8) {
      const gRate = (G * gPerp.length() * Math.min(1, dynP + 0.15)) / Math.max(speed, 40);
      const sink = Math.min(gRate * dt, 0.35);
      const axis = new THREE.Vector3().crossVectors(vDir, gPerp).normalize();
      vDir.applyAxisAngle(axis, sink);
      // 失速裕度不足时下沉加剧（升力不足）
      const stallMargin = clamp((speed - this._vStall(rho)) / (this._vStall(rho) * 0.5), 0, 1);
      if (stallMargin < 1) {
        vDir.y -= (1 - stallMargin) * 0.5 * dt;
        vDir.normalize();
      }
    }

    // ---- 速度标量：推力 - 阻力 - 重力沿路径 ----
    const CL = clamp(spec.CLalpha * Math.abs(alpha) * 0.5 + 0.25, 0, spec.CLmax);
    const CD = spec.CD0 + spec.kInduced * CL * CL;
    const drag = 0.5 * rho * speed * speed * spec.wingArea * CD;
    const thrustAvail = this.afterburner
      ? spec.thrustMax : spec.thrustMil * clamp(this.throttle, 0, 1);
    const thrust = thrustAvail * Math.pow(rho / 1.225, 0.75) * (this.fuel <= 0 ? 0.35 : 1);
    const dSpeed = (thrust - drag) / spec.mass - G * vDir.y;
    const newSpeed = Math.max(20, speed + dSpeed * dt);

    this.velocity.copy(vDir).multiplyScalar(newSpeed);
    this.position.addScaledVector(this.velocity, dt);

    // ---- 遥测 ----
    this.telemetry.speed = newSpeed;
    this.telemetry.alt = this.position.y;
    this.telemetry.alpha = alphaDeg * Math.sign(alpha || 1);
    this.telemetry.beta = beta * 180 / Math.PI;
    // 体感 G：路径弯曲角速度 × V / g
    const pathRate = alignRate;
    this.telemetry.gLoad = 1 + (newSpeed * pathRate * Math.cos(alpha * 0.5)) / G * 0.9;
    this.telemetry.stall = this.fcs.telemetry.stall;
    this.telemetry.stallWarn = this.fcs.telemetry.stallWarn;
    this.telemetry.throttle = this.throttle;
    this.telemetry.afterburner = this.afterburner;
    this.telemetry.fuel = this.fuel;
  }

  _vStall(rho) {
    const spec = this.spec;
    return Math.sqrt((2 * spec.mass * G) / ((rho ?? 1.225) * spec.wingArea * spec.CLmax));
  }

  // 姿态朝向的快捷向量
  forward() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat); }
  up() { return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat); }
  right() { return new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat); }

  applyDamage(dmg) {
    if (!this.alive) return false;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      return true;   // 被击落
    }
    return false;
  }

  syncVisual() {
    if (this.object3D) {
      this.object3D.position.copy(this.position);
      this.object3D.quaternion.copy(this.quat);
    }
  }
}

// ---------------- 占位网格（未加载真实模型前使用，之后替换）----------------
export function buildPlaceholderJet(color = 0x4a6d8c) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.55 });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x222a31, metalness: 0.5, roughness: 0.6 });
  // 机身
  const fus = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 9, 6, 12), mat);
  fus.rotation.x = Math.PI / 2;
  g.add(fus);
  // 机头锥
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 3.4, 12), mat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -6.2;
  g.add(nose);
  // 主翼
  const wing = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.18, 3.4), mat);
  wing.position.set(0, -0.15, 0.4);
  g.add(wing);
  // 平尾
  const tail = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.14, 1.8), mat);
  tail.position.set(0, 0.1, 4.4);
  g.add(tail);
  // 双垂尾
  for (const s of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.9, 2.0), matDark);
    fin.position.set(s * 1.1, 0.95, 4.3);
    fin.rotation.z = s * 0.16;
    g.add(fin);
  }
  // 座舱
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.72, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2b3d66, metalness: 0.7, roughness: 0.15 }));
  canopy.position.set(0, 0.55, -3.0);
  canopy.scale.set(1, 0.75, 2.1);
  g.add(canopy);
  // 发动机喷口辉光（加力时放大）
  const nozzle = new THREE.Mesh(
    new THREE.ConeGeometry(0.65, 1.6, 10),
    new THREE.MeshBasicMaterial({ color: 0xffa53d, transparent: true, opacity: 0.85 }));
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.z = 5.6;
  g.add(nozzle);
  g.userData.nozzle = nozzle;
  return g;
}

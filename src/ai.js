// ai.js — 敌机 AI：有限状态机（巡逻/接敌/攻击/规避/脱离）+ 波次管理
import * as THREE from 'three';
import { clamp, rad, deg } from './aero.js';
import { G } from './config.js';

// ---------------- 单机 AI ----------------
// 决策输出：{ pitch, roll, yaw, throttle, fireGun, fireMissile }（喂给 FlightController）
export class EnemyAI {
  constructor(params = {}) {
    this.state = 'PATROL';
    this.stateTime = 0;
    this.aggression = params.aggression ?? 0.8;
    this.skill = params.skill ?? 0.7;         // 0~1 影响瞄准误差与规避质量
    this.patrolCenter = params.patrolCenter ?? new THREE.Vector3(0, 3000, -5000);
    this.patrolRadius = params.patrolRadius ?? 4000;
    this.maneuverSeed = Math.random() * 1000;
    this.gunCooldown = 0;
    this.missileCooldown = 8 + Math.random() * 6;
    this.breakOffTime = 0;
    this.evadeDir = Math.random() < 0.5 ? 1 : -1;
    this.lastTarget = null;
  }

  // self: 本机 { position, velocity, quat, alive, hp }
  // target: 玩家 { position, velocity, quat, alive }
  // threat: 来袭导弹或 null { position, velocity }
  update(dt, self, target, threat) {
    this.stateTime += dt;
    this.gunCooldown -= dt;
    this.missileCooldown -= dt;

    const out = { pitch: 0, roll: 0, yaw: 0, throttle: 0.85, fireGun: false, fireMissile: false, fireFlare: false, fireChaff: false };

    const toT = target.position.clone().sub(self.position);
    const dist = toT.length();
    const selfSpeed = self.velocity.length();

    // ---- 状态转移 ----
    const threatDanger = threat && threat.alive !== false
      ? this._threatLevel(self, threat) : 0;

    let nextState = this.state;
    switch (this.state) {
      case 'PATROL':
        if (dist < 16000 && target.alive !== false) nextState = 'ENGAGE';
        break;
      case 'ENGAGE':
        if (threatDanger > 0.55) nextState = 'EVADE';
        else if (dist < 15000) nextState = 'ATTACK';
        else if (dist > 22000) nextState = 'PATROL';
        break;
      case 'ATTACK':
        if (threatDanger > 0.55) nextState = 'EVADE';
        else if (dist > 15000) nextState = 'ENGAGE';
        if (self.hp < 30 && Math.random() < 0.01) nextState = 'FLEE';
        break;
      case 'EVADE':
        if (this.stateTime > 4.5 && threatDanger < 0.3) nextState = 'ENGAGE';
        break;
      case 'FLEE':
        if (this.stateTime > 20 || dist > 20000) nextState = 'PATROL';
        break;
    }
    if (nextState !== this.state) {
      this.state = nextState;
      this.stateTime = 0;
      this.evadeDir = Math.random() < 0.5 ? 1 : -1;
    }

    // ---- 各状态行为 ----
    switch (this.state) {
      case 'PATROL':
        this._patrol(dt, self, out);
        break;
      case 'ENGAGE':
        this._pursue(self, target, out, { desiredDist: 6000 });
        break;
      case 'ATTACK':
        this._attack(dt, self, target, out, dist);
        break;
      case 'EVADE':
        this._evade(dt, self, threat, out);
        break;
      case 'FLEE':
        this._flee(self, target, out);
        break;
    }

    // 地形/高度防撞：低于安全高度强制拉起（覆盖机动）；terrainCB 提供地形高度
    const safeAlt = this.terrainClearance ? this.terrainClearance(self) : 800;
    if (self.position.y < safeAlt) {
      out.pitch = 1;
      out.roll *= 0.2;
    }
    return out;
  }

  _threatLevel(self, threat) {
    // 导弹逼近程度 0~1
    const rel = threat.position.clone().sub(self.position);
    const dist = rel.length();
    const closing = rel.clone().multiplyScalar(-1).dot(
      threat.velocity.clone().sub(self.velocity)) / Math.max(dist, 1);
    const rwr = closing > 150 && dist < 7000;
    return clamp((9000 - dist) / 9000, 0, 1) * (rwr ? 1 : 0.35);
  }

  _patrol(dt, self, out) {
    // 绕巡逻中心盘旋（航点高度感知地形）
    const t = performance.now?.() ?? (Date.now());
    const ang = (t / 1000) * 0.08 + this.maneuverSeed;
    const wp = this.patrolCenter.clone().add(new THREE.Vector3(
      Math.cos(ang) * this.patrolRadius, Math.sin(ang * 0.3) * 300, Math.sin(ang) * this.patrolRadius));
    if (this.terrainHeight) wp.y = Math.max(wp.y, this.terrainHeight(wp.x, wp.z) + 1200);
    this._steerTo(self, wp, out, { arriveRadius: 800 });
    out.throttle = 0.75;
  }

  _steerTo(self, wp, out, { arriveRadius = 500 } = {}) {
    // 朝航点：先转向（坡度转弯），俯仰对准高度差
    const toWp = wp.clone().sub(self.position);
    const dist = toWp.length();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(self.quat);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(self.quat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(self.quat);
    const dir = toWp.clone().normalize();
    // 偏航误差 → 滚转朝向（bank 定义：右压坡为正，即 right.y<0）
    const lateral = dir.dot(right);
    const headingErr = dir.dot(fwd);
    const bankTarget = clamp(Math.atan2(lateral, Math.max(headingErr, 0.05)) * 1.6, -rad(70), rad(70));
    // 当前坡度（右压坡为正）
    const bankNow = Math.asin(clamp(-right.y, -1, 1));
    const bankErr = bankTarget - bankNow;
    // roll 输入：右滚为正（增大右压坡）
    out.roll = clamp(bankErr * 2.2, -1, 1);
    // 俯仰：对准航点仰角 + 拉起维持高度（带坡度补偿）
    const pitchAngle = Math.asin(clamp(dir.y, -1, 1));
    const climb = clamp(pitchAngle * 2.0, -0.7, 1);
    const bankComp = Math.abs(bankNow) > rad(45) ? 0.35 : 0.12;
    out.pitch = clamp(climb + bankComp, -1, 1);
    if (dist < arriveRadius) out.pitch *= 0.3;
  }

  _pursue(self, target, out, { desiredDist }) {
    const behind = target.velocity.clone().normalize();
    const aim = target.position.clone().addScaledVector(behind, -desiredDist * 0.6);
    this._steerTo(self, aim, out);
    out.throttle = 1.0;
  }

  _attack(dt, self, target, out, dist) {
    // 追尾攻击：瞄准目标前置点
    const selfSpeed = self.velocity.length();
    const toT = target.position.clone().sub(self.position);
    // 前置角（gun aim）
    const tFuse = clamp(dist / 1050, 0.2, 2.5);
    const aim = target.position.clone().addScaledVector(target.velocity, tFuse);
    this._steerTo(self, aim, out);
    out.throttle = dist > 3000 ? 1.0 : 0.8;

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(self.quat);
    const dirToAim = aim.clone().sub(self.position).normalize();
    const angleErr = Math.acos(clamp(fwd.dot(dirToAim), -1, 1));
    const aimErrDeg = deg(angleErr) * (1.3 - this.skill * 0.6);

    // 航炮：距离近且对准
    if (dist < 1400 && aimErrDeg < 3.5 && this.gunCooldown <= 0) {
      out.fireGun = true;
      this.gunCooldown = 0.12;
    }
    // 导弹：中距雷达弹 + 近距红外弹
    if (this.missileCooldown <= 0) {
      if (dist > 1800 && dist < 9000 && aimErrDeg < 12) {
        out.fireMissile = 'radar';                               // R-77 主动雷达弹
        this.missileCooldown = 10 + (1 - this.aggression) * 8 + Math.random() * 4;
      } else if (dist >= 900 && dist < 2800 && aimErrDeg < 30) {
        out.fireMissile = 'ir';                                  // R-73 红外格斗弹
        this.missileCooldown = 7 + (1 - this.aggression) * 5 + Math.random() * 3;
      }
    }
  }

  _evade(dt, self, threat, out) {
    if (!threat) { this._patrol(dt, self, out); return; }
    // 判别威胁弹种：红外弹 → 桶滚+热诱弹；雷达弹 → 39机动（beaming）+箔条
    const isIR = (threat.spec?.flareDecoyFactor ?? 1) >= 0.5;
    const toThreat = threat.position.clone().sub(self.position);
    const dist = toThreat.length();

    if (isIR) {
      // 红外弹：大机动破坏追踪锥 + 热诱弹
      const t = this.stateTime;
      const bar = Math.sin(t * 3.1 + this.maneuverSeed);
      out.roll = clamp(bar * 1.6 * this.evadeDir, -1, 1);
      out.pitch = clamp(Math.sin(t * 2.2 + 1) * 0.9 + 0.35, -1, 1);
      out.throttle = 1.0;
      out.fireFlare = dist < 3000;
    } else {
      // 雷达弹：转入威胁 3/9 点钟方向（径向速度→0，落入多普勒凹口），保持速度
      const losDir = toThreat.clone().normalize();
      const up = new THREE.Vector3(0, 1, 0);
      // LOS 的水平垂直方向（beaming 航向），选与当前航向夹角较小的一侧以省能量
      let beamDir = new THREE.Vector3().crossVectors(losDir, up);
      if (beamDir.lengthSq() < 1e-6) beamDir.set(1, 0, 0);
      beamDir.normalize();
      if (beamDir.dot(self.velocity) < 0) beamDir.negate();
      const wp = self.position.clone().addScaledVector(beamDir, 5000);
      wp.y = Math.max(self.position.y + 200, 2500);   // 保高度轻微爬升耗能换安全
      this._steerTo(self, wp, out);
      out.throttle = 1.0;
      out.fireChaff = dist < 3200;
    }
  }

  _flee(self, target, out) {
    const away = self.position.clone().sub(target.position).normalize();
    const wp = self.position.clone().addScaledVector(away, 8000);
    wp.y = Math.max(wp.y, 3500);
    this._steerTo(self, wp, out);
    out.throttle = 1.0;
  }
}

// ---------------- 波次管理 ----------------
export class WaveManager {
  constructor({ origin, spawnRadius = 9000, baseAltitude = 2800 } = {}) {
    this.wave = 0;
    this.origin = origin.clone();
    this.spawnRadius = spawnRadius;
    this.baseAltitude = baseAltitude;
    this.spawnTimer = 3;
    this.activeEnemies = [];
  }

  get waveSpec() {
    const w = this.wave;
    return {
      count: Math.min(2 + Math.floor(w / 2), 6),
      skill: clamp(0.35 + w * 0.08, 0.35, 0.95),
      aggression: clamp(0.5 + w * 0.07, 0.5, 0.98),
    };
  }

  // 返回本波需要生成的敌机参数数组
  update(dt, aliveEnemies) {
    this.spawnTimer -= dt;
    const spawns = [];
    if (this.spawnTimer <= 0 && aliveEnemies === 0) {
      this.wave += 1;
      const spec = this.waveSpec;
      for (let i = 0; i < spec.count; i++) spawns.push(this._spawnSpec(i, spec));
      this.spawnTimer = 8;
    }
    return spawns;
  }

  _spawnSpec(i, spec) {
    const ang = (i / 4) * Math.PI * 2 + Math.random();
    const pos = this.origin.clone().add(new THREE.Vector3(
      Math.cos(ang) * this.spawnRadius,
      this.baseAltitude + Math.random() * 800,
      Math.sin(ang) * this.spawnRadius));
    return {
      position: pos,
      velocity: new THREE.Vector3(Math.cos(ang + 1.6) * 180, 0, Math.sin(ang + 1.6) * 180),
      skill: spec.skill,
      aggression: spec.aggression,
      type: Math.random() < 0.35 ? 'enemy_su30' : 'enemy_mig29',
    };
  }
}

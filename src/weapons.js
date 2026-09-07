// weapons.js — 武器系统：航炮弹道 + 导弹（比例导引 PN + 复合制导：惯性中段+主动末段）
//               + 干扰对策机制（热诱弹诱骗 / 箔条干扰）
import * as THREE from 'three';
import { clamp, rad, deg } from './aero.js';
import { G, airDensity, COUNTERMEASURES } from './config.js';

// ---------------- 航炮弹丸 ----------------
export class Bullet {
  constructor(pos, vel, owner, damage) {
    this.position = pos.clone();
    this.velocity = vel.clone();
    this.owner = owner;
    this.damage = damage;
    this.life = 4.0;
    this.alive = true;
    this.trailTime = 0;
  }
  update(dt) {
    // 弹道：重力 + 简化阻力
    this.velocity.y -= G * dt;
    const dragK = 0.000045;
    const v = this.velocity.length();
    if (v > 1) {
      const a = dragK * v * v;
      this.velocity.addScaledVector(this.velocity.clone().normalize(), -a * dt);
    }
    this.position.addScaledVector(this.velocity, dt);
    this.life -= dt;
    if (this.life <= 0) this.alive = false;
    return this;
  }
}

export function fireGun(state, aimDir, spec, owner) {
  const bullets = [];
  const base = state.position.clone().addScaledVector(aimDir.clone().normalize(), 12);
  const spread = spec.spread;
  for (let i = 0; i < 2; i++) {  // 双联发（射速游戏化）
    const dir = aimDir.clone().normalize();
    dir.x += (Math.random() - 0.5) * 2 * spread;
    dir.y += (Math.random() - 0.5) * 2 * spread;
    dir.z += (Math.random() - 0.5) * 2 * spread;
    dir.normalize();
    const vel = dir.multiplyScalar(spec.muzzleVel).add(state.velocity);
    bullets.push(new Bullet(base, vel, owner, spec.damage));
  }
  return bullets;
}

// ---------------- 导弹 ----------------
// 制导模式：
//   MIDCOURSE  惯性中段：按发射时/数据链更新的预测拦截点直线飞（带 loft 抬升）
//   TERMINAL   主动末段：导引头开机，纯比例导引 PN 追踪目标
//   BALLISTIC  动力耗尽：弹道飞行（仍按最后导引方向修正的 PN 惯性延伸）
export class Missile {
  constructor({ position, velocity, direction, target, spec, owner, id, rng = Math.random }) {
    this.id = id;
    this.spec = spec;
    this.owner = owner;
    this.rng = rng;                   // 可注入确定性随机（测试用）
    this.target = target;             // 目标实体 { position, velocity, alive, ... }
    this.position = position.clone();
    this.velocity = velocity.clone();
    this.quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, -1), direction.clone().normalize());
    this.age = 0;
    this.alive = true;
    this.phase = 'MIDCOURSE';         // 复合制导阶段
    this.seekerLocked = false;
    this.decoyed = false;             // 被热诱弹诱骗
    this.chaffed = false;             // 被箔条干扰
    this.fuseRadius = spec.fuseRadius;
    this.maxG = spec.maxG;
    this.detected = false;            // 是否曾被目标 RWR 检测
    // 数据链更新的预测拦截点（中段目标）
    this.aimPoint = new THREE.Vector3();
    this._updateAimPoint();
    this._decoyTimer = 0;
    this.trailPoints = [];
  }

  _updateAimPoint() {
    // 预测拦截点（按当前相对距离/导弹平均速度估计）
    const rel = this.target.position.clone().sub(this.position);
    const dist = rel.length();
    const closing = Math.max(300, this.spec.maxSpeed * 0.7);
    const tGo = dist / closing;
    this.aimPoint.copy(this.target.position).addScaledVector(this.target.velocity, tGo);
  }

  // PN 比例导引：a_cmd = N * Vc * LOS_rate，垂直于速度方向
  _proportionalNavigation(dt) {
    const relPos = this.target.position.clone().sub(this.position);
    const relVel = this.target.velocity.clone().sub(this.velocity);
    const dist = relPos.length();
    const vClosing = -relPos.dot(relVel) / Math.max(dist, 1e-3); // 接近速度（>0 接近）
    // LOS 角速度 ω = (r × ṙ)/|r|²
    const omega = new THREE.Vector3().crossVectors(relPos, relVel).divideScalar(Math.max(dist * dist, 1e-6));
    // a_cmd = N * Vc * (ω × û_v)（垂直于导弹速度；推导验证 ω×V̂ 指向 LOS 旋转方向）
    const vDir = this.velocity.clone().normalize();
    const aCmd = new THREE.Vector3().crossVectors(omega, vDir).multiplyScalar(this.spec.N * Math.max(vClosing, 100));
    // 若接近速度为负（远离），仍然修正转向
    if (vClosing <= 0) {
      aCmd.addScaledVector(relPos.clone().normalize(), 30);
    }
    return { aCmd, dist, vClosing };
  }

  // ---- 干扰对策判定（世界中的热诱弹/箔条，仅作用于本弹目标所属方）----
  _applyCountermeasures(dt, world) {
    if (!world || this.target.alive === false || this.target.isFlare) return;
    const cm = COUNTERMEASURES;

    // 热诱弹：导引头视场内的强热源可被咬住（末段最易受诱）
    this._decoyTimer -= dt;
    if (!this.decoyed && this._decoyTimer <= 0) {
      this._decoyTimer = cm.decoyCheckInterval;
      const vDir = this.velocity.clone().normalize();
      for (const f of (world.flares ?? [])) {
        if (!f.alive || f.owner !== this.target) continue;
        // 每枚诱弹对每枚导弹只判定一次（避免反复roll累积成必然诱骗）
        f._triedBy ??= new Set();
        if (f._triedBy.has(this.id)) continue;
        const toF = f.position.clone().sub(this.position);
        const dist = toF.length();
        if (dist > cm.decoyRange || dist < 1) continue;
        const ang = Math.acos(clamp(toF.divideScalar(dist).dot(vDir), -1, 1));
        if (ang > cm.decoyConeRad) continue;
        f._triedBy.add(this.id);
        const closeness = 1 - dist / cm.decoyRange;
        // 雷达导弹（主动导引头）对红外诱饵有较强鉴别力：概率按弹种系数打折
        const susc = this.spec.flareDecoyFactor ?? 1;
        if (this.rng() < (cm.decoyBaseProb + cm.decoyCloseProb * closeness) * susc) {
          this.target = f;              // 导引头转移至热源
          this.decoyed = true;
          this.phase = 'TERMINAL';
          this.seekerLocked = true;
          break;
        }
      }
    }

    // 箔条：干扰中段数据链（瞄准点一次性大偏差 + 停止更新 + 锁定距离压缩）
    if (!this.chaffed && this.phase === 'MIDCOURSE') {
      for (const c of (world.chaffs ?? [])) {
        if (!c.alive || c.owner !== this.target) continue;
        if (c.position.distanceTo(this.target.position) < cm.chaffAffectRadius) {
          this.chaffed = true;
          const err = new THREE.Vector3(this.rng() - 0.5, (this.rng() - 0.5) * 0.4, this.rng() - 0.5)
            .normalize().multiplyScalar(cm.chaffAimError * (0.6 + 0.4 * this.rng()));
          this.aimPoint.add(err);
          break;
        }
      }
    }

    // ---- 39机动（beaming）+ 箔条 → 破解雷达弹末段锁定 ----
    // 原理：目标径向速度趋零落入 PD 雷达多普勒凹口被当作地杂波滤除，箔条云提供假回波，导引头脱锁
    const isRadarMissile = (this.spec.flareDecoyFactor ?? 1) < 0.5;
    this._notchTimer = (this._notchTimer ?? 0) - dt;
    if (isRadarMissile && this.phase === 'TERMINAL' && !this.notched && this._notchTimer <= 0) {
      this._notchTimer = cm.decoyCheckInterval;    // 每 0.2s 判定一次，累计概率趋近必然
      const los = this.target.position.clone().sub(this.position);
      const dist = los.length();
      if (dist > cm.notchMinDist) {
        const losHat = los.divideScalar(dist);
        const tVel = this.target.velocity.length();
        if (tVel > 40) {
          const beam = Math.abs(this.target.velocity.dot(losHat)) / tVel;   // 0 = 正横（理想 beaming）
          if (beam < cm.notchBeamMax) {
            const chaffNear = (world.chaffs ?? []).some(c =>
              c.alive && c.owner === this.target
              && c.position.distanceTo(this.target.position) < cm.chaffAffectRadius);
            if (chaffNear) {
              const closeness = 1 - Math.min(dist / cm.decoyRange, 1);
              if (this.rng() < cm.notchBreakBase + cm.notchBreakClose * closeness) {
                this.notched = true;
                this.phase = 'BALLISTIC';      // 脱锁：导引头放弃，惯性直飞
                this.seekerLocked = false;
              }
            }
          }
        }
      }
    }
  }

  update(dt, world = null) {
    this.age += dt;
    const spec = this.spec;

    // ---- 推进 ----
    let thrust = 0;
    if (this.age < spec.boostTime) thrust = spec.boostAccel;
    else if (this.age < spec.boostTime + spec.sustainTime) thrust = spec.sustainAccel;
    this.motorBurnt = this.age >= spec.boostTime + spec.sustainTime;

    // ---- 干扰对策判定（针对本弹目标所属方的对抗）----
    this._applyCountermeasures(dt, world);

    // ---- 制导逻辑（复合：中段惯性/数据链 → 末段主动 PN）----
    const relDist = this.target.position.clone().sub(this.position).length();
    let guidanceAccel = new THREE.Vector3();
    if (this.target.alive === false) {
      // 目标已毁：惯性直飞
      this.phase = 'BALLISTIC';
    } else if (this.phase === 'MIDCOURSE') {
      // 中段：定期数据链更新瞄准点 + loft 弹道 + 少量修正
      if ((this.updateCount = (this.updateCount || 0) + 1) % 10 === 0 && !this.chaffed) this._updateAimPoint();
      const toAim = this.aimPoint.clone().sub(this.position);
      const vDir = this.velocity.clone().normalize();
      // loft：飞行前半程爬升（energetic 弹道），后半段对准瞄准点
      const progress = this.age / (spec.boostTime + spec.sustainTime);
      const desired = toAim.clone().normalize();
      if (progress < 0.45 && this.position.y < this.target.position.y + 800) {
        desired.y = Math.max(desired.y, Math.sin(spec.loftAngle));
        desired.normalize();
      }
      // 方向误差 → 转向加速度：沿 desired 的垂直于速度分量（几何正确）
      const desiredPerp = desired.clone().addScaledVector(vDir, -desired.dot(vDir));
      if (desiredPerp.lengthSq() > 1e-10) {
        const angleErr = Math.acos(clamp(vDir.dot(desired), -1, 1));
        desiredPerp.normalize();
        const turnRate = Math.min(angleErr / dt, (this.maxG * G) / Math.max(this.velocity.length(), 200));
        guidanceAccel.addScaledVector(desiredPerp, this.velocity.length() * turnRate);
      }
      // 末段切换：距离进入导引头范围（箔条干扰时有效距离打折）
      const seekerEff = spec.seekerRange * (this.chaffed ? COUNTERMEASURES.chaffSeekerCut : 1);
      if (relDist < seekerEff) {
        this.phase = 'TERMINAL';
        this.seekerLocked = true;
      }
    } else if (this.phase === 'TERMINAL') {
      const { aCmd } = this._proportionalNavigation(dt);
      guidanceAccel.copy(aCmd);
    } else {
      // BALLISTIC：无制导
    }

    // ---- 法向加速度限制（导弹结构/气动极限）----
    const aLatMax = this.maxG * G;
    if (guidanceAccel.length() > aLatMax) {
      guidanceAccel.setLength(aLatMax);
    }

    // ---- 合加速度 ----
    const accel = guidanceAccel.clone();
    // 推力沿弹轴
    const bodyFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
    accel.addScaledVector(bodyFwd, thrust);
    // 气动阻力
    const rho = airDensity(Math.max(0, this.position.y));
    const v = this.velocity.length();
    accel.addScaledVector(this.velocity.clone().normalize(), -spec.dragCD * rho * v * v / 1.225);
    // 重力（导弹升力近似平衡重力的一半，游戏化处理）
    accel.y -= G * 0.55;

    // ---- 积分 ----
    this.velocity.addScaledVector(accel, dt);
    if (this.velocity.length() > spec.maxSpeed) this.velocity.setLength(spec.maxSpeed);
    this.position.addScaledVector(this.velocity, dt);

    // 姿态对准速度方向（视觉）
    const vDir2 = this.velocity.clone().normalize();
    if (vDir2.lengthSq() > 0.5) {
      const targetQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), vDir2);
      this.quat.slerp(targetQuat, Math.min(1, dt * 8));
    }

    // ---- 引信 ----
    if (this.target.alive !== false) {
      const rel = this.target.position.clone().sub(this.position);
      const relVel = this.target.velocity.clone().sub(this.velocity);
      const dist = rel.length();
      // 脱靶距离估计：若正在接近且下一帧将穿越最近点
      const tClosest = clamp(-rel.dot(relVel) / Math.max(relVel.lengthSq(), 1e-6), 0, dt * 2);
      const missDist = rel.clone().addScaledVector(relVel, tClosest).length();
      if (missDist < this.fuseRadius) {
        this.hit = true;
        this.alive = false;
      }
    }

    // ---- 寿命 ----
    if (this.age > 35 || this.position.y < -50) {
      this.alive = false;
      this.expired = true;
    }
    return this;
  }
}

// 发射导弹（opts: { offset, rng }，rng 可注入确定性随机，测试用）
export function fireMissile(state, target, spec, owner, id, opts = {}) {
  const offset = opts.offset ?? new THREE.Vector3(0, -1.5, -2);
  const pos = state.position.clone().add(offset.clone().applyQuaternion(state.quat));
  const vel = state.velocity.clone().addScaledVector(
    new THREE.Vector3(0, 0, -1).applyQuaternion(state.quat), 30);
  return new Missile({ position: pos, velocity: vel, direction: vel.clone().normalize(), target, spec, owner, id, rng: opts.rng });
}

// fcs.js — 飞行控制系统：PID 控制器 + 包线保护（G/AoA/侧滑限制）+ 失速保护与防失控
import { clamp, rad, deg, computeAeroAngles } from './aero.js';
import { G } from './config.js';

// ---------------- 通用 PID ----------------
export class PID {
  constructor(kp = 1, ki = 0, kd = 0, { outMin = -1, outMax = 1, iLimit = 0.5 } = {}) {
    this.kp = kp; this.ki = ki; this.kd = kd;
    this.outMin = outMin; this.outMax = outMax; this.iLimit = iLimit;
    this.i = 0; this.prevErr = 0; this.prevTime = null;
  }
  reset() { this.i = 0; this.prevErr = 0; this.prevTime = null; }
  update(error, dt) {
    this.i = clamp(this.i + error * dt, -this.iLimit, this.iLimit);
    const dErr = this.prevTime === null ? 0 : (error - this.prevErr) / Math.max(dt, 1e-4);
    this.prevErr = error; this.prevTime = 1;
    const out = this.kp * error + this.ki * this.i + this.kd * dErr;
    return clamp(out, this.outMin, this.outMax);
  }
}

// ---------------- 飞行控制器 ----------------
// 输入通道约定（航空习惯）：
//   pitch ∈ [-1,1]：+1 = 拉杆抬头；roll：+1 = 右滚；yaw：+1 = 机头右
// 键盘优先级高于鼠标：任一键盘通道超出死区即屏蔽鼠标同通道
export class FlightController {
  constructor(plane) {
    this.plane = plane;
    // 鼠标飞控 PID（速率外环）：误差 = 目标角速率 - 当前角速率，输出 = 绝对速率指令
    this.pidPitch = new PID(1.8, 2.0, 0.10, { outMin: -3.6, outMax: 3.6, iLimit: 1.5 });
    this.pidRoll = new PID(2.0, 2.2, 0.10, { outMin: -5.0, outMax: 5.0, iLimit: 1.5 });
    this.pidYaw = new PID(1.5, 1.8, 0.08, { outMin: -1.0, outMax: 1.0, iLimit: 0.6 });
    // 遥测
    this.telemetry = {
      gLoad: 1, alphaDeg: 0, betaDeg: 0, stall: false, stallWarn: false,
      gLimited: false, alphaLimited: false, energyLimited: false,
      keyboardActive: false, mouseActive: false,
      overload: false, departed: false,
    };
  }

  // inputs: {
  //   keyboard: { pitch, roll, yaw },           // -1..1
  //   mouse:    { pitch, roll },                 // -1..1（屏幕虚拟摇杆）
  //   state:    { position, velocity, quat },
  //   rates:    { p, q, r },                     // 当前机体角速度 rad/s
  // }
  // 返回 { p, q, r }：指令角速度 rad/s（已含全部保护）
  update(dt, inputs) {
    const plane = this.plane;
    const { keyboard, mouse, state, rates } = inputs;
    const tel = this.telemetry;

    const speed = state.velocity.length();
    const { alpha, beta } = computeAeroAngles(state.velocity, state.quat);
    const alphaDeg = deg(alpha), betaDeg = deg(beta);
    tel.alphaDeg = alphaDeg; tel.betaDeg = betaDeg;

    // ---- 键盘优先级：任一通道活跃则屏蔽鼠标 ----
    const dz = 0.08;
    const kb = {
      pitch: Math.abs(keyboard.pitch) > dz ? clamp(keyboard.pitch, -1, 1) : 0,
      roll: Math.abs(keyboard.roll) > dz ? clamp(keyboard.roll, -1, 1) : 0,
      yaw: Math.abs(keyboard.yaw) > dz ? clamp(keyboard.yaw, -1, 1) : 0,
    };
    const kbActive = kb.pitch !== 0 || kb.roll !== 0 || kb.yaw !== 0;
    tel.keyboardActive = kbActive;
    tel.mouseActive = !kbActive && (Math.abs(mouse.pitch) > dz || Math.abs(mouse.roll) > dz);

    // ---- 合成原始指令（键盘优先）----
    let qCmd, pCmd, rCmd;
    if (kbActive) {
      qCmd = kb.pitch * plane.pitchRateMax;
      pCmd = kb.roll * plane.rollRateMax;
      rCmd = kb.yaw * plane.yawRateMax;
      this.pidPitch.reset(); this.pidRoll.reset(); this.pidYaw.reset();
    } else {
      // 鼠标通道：PID 速率外环平滑跟踪目标角速率（输出即速率指令，防过量）
      const tq = clamp(mouse.pitch, -1, 1) * plane.pitchRateMax * 0.75;
      const tp = clamp(mouse.roll, -1, 1) * plane.rollRateMax * 0.85;
      const tr = clamp(mouse.yaw || 0, -1, 1) * plane.yawRateMax * 0.8;
      qCmd = this.pidPitch.update(tq - rates.q, dt);
      pCmd = this.pidRoll.update(tp - rates.p, dt);
      rCmd = this.pidYaw.update(tr - rates.r, dt);
    }

    // ---- 包线保护 1：G 限制 ----
    // 由俯仰速率引起的法向过载近似：n ≈ 1 + V*q/G（拉杆为正）
    tel.gLimited = false;
    const qForG = (n) => Math.abs(((n - 1) * G) / Math.max(speed, 30));
    const qMax = qForG(plane.maxG), qMin = -qForG(-plane.minG + 2); // 负 G 侧留余量
    if (qCmd > qMax) { qCmd = qMax; tel.gLimited = true; }
    if (qCmd < qMin) { qCmd = qMin; tel.gLimited = true; }

    // ---- 包线保护 2：迎角限制（低速大拉杆时衰减）----
    tel.alphaLimited = false;
    const alphaMargin = rad(plane.alphaStall) * 0.92;
    const qAlphaIncr = qCmd * 0.35;                    // 未来 ~0.35s 迎角增量估计
    const alphaProj = alpha + qAlphaIncr;
    if (alphaProj > alphaMargin && qCmd > 0) {
      const scale = clamp((alphaMargin - alpha) / Math.max(qAlphaIncr, 1e-4), 0, 1);
      qCmd *= Math.max(scale, 0.05);
      tel.alphaLimited = true;
    } else if (alphaProj < -alphaMargin && qCmd < 0) {
      const scale = clamp((-alphaMargin - alpha) / Math.min(qAlphaIncr, -1e-4), 0, 1);
      qCmd *= Math.max(scale, 0.05);
      tel.alphaLimited = true;
    }

    // ---- 能量保护：速度逼近失速时强制低头俯冲恢能（防止速度耗尽迎角发散）----
    {
      const vStall = Math.sqrt((2 * plane.mass * G) / ((state.rho ?? 1.225) * plane.wingArea * plane.CLmax));
      const energyRatio = speed / vStall;
      if (energyRatio < 1.25) {
        const dive = -rad(6) * clamp((1.25 - energyRatio) / 0.25, 0, 1);
        if (qCmd > dive) { qCmd = dive; tel.energyLimited = true; } else tel.energyLimited = false;
      } else tel.energyLimited = false;
    }

    // ---- 失速判定与保护 ----
    // 失速速度：Vs = sqrt(2*m*g/(rho*S*CLmax))
    const rho = state.rho ?? 1.225;
    const vStall = Math.sqrt((2 * plane.mass * G) / (rho * plane.wingArea * plane.CLmax));
    const stallRatio = speed / vStall;
    tel.stall = stallRatio < 1.0 || alphaDeg > plane.alphaStall;
    tel.stallWarn = stallRatio < 1.25 || alphaDeg > plane.alphaStall * 0.85;
    if (tel.stall) {
      // 操纵效率随动压下降；自动推杆改出
      const eff = clamp(stallRatio, 0.25, 1);
      qCmd *= eff;
      pCmd *= eff * 0.8;
      rCmd *= eff * 0.5;
      if (alphaDeg > plane.alphaStall) {
        qCmd = Math.min(qCmd, -rad(8));   // 推杆降低迎角
        // 机翼自动改平：向 up.y 增大的方向滚转（upright 右压坡→左滚回正）
        const up = new (state.velocity.constructor)(0, 1, 0).applyQuaternion(state.quat);
        const right = new (state.velocity.constructor)(1, 0, 0).applyQuaternion(state.quat);
        const bankSign = (up.y >= 0) === (right.y <= 0)
          ? -Math.sign(right.y || 1)      // upright：右压坡(right.y<0) → 左滚(-)
          : Math.sign(right.y || 1);      // inverted：镜像
        pCmd = bankSign * plane.rollRateMax * 0.5;
      }
    }

    // ---- 无输入阻尼（防止残余角速度累积；置于协调之前，不覆盖自动舵）----
    if (!kbActive && !tel.mouseActive) {
      qCmd = rates.q * 0.85;
      pCmd = rates.p * 0.85;
      rCmd = rates.r * 0.85;
    }

    // ---- 侧滑协调（自动舵）：beta>0 = 路径在机头右侧 → 右舵对齐（r>0）----
    rCmd += clamp(betaDeg / 10, -0.4, 0.4) * plane.yawRateMax;

    // ---- 防失控（departure protection）：异常侧滑/过大迎角时强制阻尼 ----
    tel.departed = Math.abs(betaDeg) > 20 || Math.abs(alphaDeg) > plane.alphaStall + 8;
    if (tel.departed) {
      // 强烈衰减所有角速度指令并叠加恢复力矩（侧滑方向修正同样取 +beta）
      qCmd = clamp(qCmd, -rad(6), rad(6));
      pCmd = clamp(pCmd, -rad(30), rad(30));
      rCmd += clamp(betaDeg / 5, -1, 1) * plane.yawRateMax;
    }

    // ---- 角速度硬限制（结构强度）----
    qCmd = clamp(qCmd, -plane.pitchRateMax, plane.pitchRateMax);
    pCmd = clamp(pCmd, -plane.rollRateMax, plane.rollRateMax);
    rCmd = clamp(rCmd, -plane.yawRateMax, plane.yawRateMax);

    // 遥测 G（俯仰速率贡献的法向过载）
    tel.gLoad = 1 + (speed * qCmd) / G;

    return { p: pCmd, q: qCmd, r: rCmd };
  }
}

// aero.js — 简化飞行动力学模型（点质量 + 姿态运动学）
// 坐标系（three.js 右手系，机体前向 = -Z，上 = +Y，右 = +X）
// 欧拉序：'YXZ'（先偏航 Y、再俯仰 X、后滚转 Z）——航空习惯 pitch/yaw/roll
import { G, airDensity, soundSpeed } from './config.js';

// ---------------- 基础数学 ----------------
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function deg(r) { return (r * 180) / Math.PI; }
export function rad(d) { return (d * Math.PI) / 180; }
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

// ---------------- 迎角 / 侧滑 ----------------
// velocity: 世界系速度向量；quat: 机体姿态四元数
// 返回 { alpha, beta, vForward, vRight, vDown }(机体系分量)
export function computeAeroAngles(velocity, quat) {
  // 世界 -> 机体
  const vBody = velocity.clone().applyQuaternion(quat.clone().invert());
  const vx = vBody.x, vy = vBody.y, vz = vBody.z; // x右 y上 z后(three机体系前向为 -z)
  const u = -vz, v = vx, w = -vy;                  // u前 v右 w上（航空习惯）
  const V = Math.sqrt(u * u + v * v + w * w) || 1e-6;
  const alpha = Math.atan2(w, Math.max(u, 1e-6));  // 迎角：上方来流为正（抬头）
  const beta = Math.asin(clamp(v / V, -1, 1));     // 侧滑：右滑为正
  return { alpha, beta, u, v, w, V };
}

// ---------------- 升力/阻力系数（线性 + 失速后骤降）----------------
export function liftCoefficient(alphaDeg, CLalpha, CLmax, alphaStall) {
  const a = Math.abs(alphaDeg);
  const sign = alphaDeg >= 0 ? 1 : -1;
  if (a <= alphaStall) {
    return clamp(CLalpha * rad(a) * sign, -CLmax, CLmax);
  }
  // 失速后：升力线性衰减到 35%
  const t = clamp((a - alphaStall) / 25, 0, 1);
  const cl = CLmax * (1 - 0.65 * t);
  return cl * sign;
}

export function dragCoefficient(CL, CD0, kInduced) {
  return CD0 + kInduced * CL * CL;
}

// ---------------- 完整气动一步（平移动力学）----------------
// plane: { mass, wingArea, CLalpha, CLmax, alphaStall, CD0, kInduced, thrustMax, thrustMil }
// input: { throttle 0..1 (1=加力), ... }
// state: { position:Vector3, velocity:Vector3, quat:Quaternion }
// 返回加速度（世界系, m/s^2）
export function computeForces(plane, state, throttle) {
  const vel = state.velocity;
  const speed = vel.length();
  const alt = Math.max(0, state.position.y);
  const rho = airDensity(alt);

  // 推力（高度衰减：简单指数，11000m 处约 42%）
  const thrustAvail = throttle >= 0.99
    ? plane.thrustMax * Math.pow(rho / 1.225, 0.75)
    : plane.thrustMil * Math.pow(rho / 1.225, 0.75) * clamp(throttle, 0, 1);
  const forward = new (vel.constructor)(0, 0, -1).applyQuaternion(state.quat); // 机体前向（世界系）
  const thrustAccel = forward.multiplyScalar(thrustAvail / plane.mass);

  // 气动
  const { alpha, beta, V } = computeAeroAngles(vel, state.quat);
  const CL = liftCoefficient(deg(alpha), plane.CLalpha, plane.CLmax, plane.alphaStall);
  const CD = dragCoefficient(CL, plane.CD0, plane.kInduced);
  const q = 0.5 * rho * speed * speed * plane.wingArea; // 动压*面积
  const liftAccelMag = (q * CL) / plane.mass;
  const dragAccelMag = (q * CD) / plane.mass;

  // 升力方向：垂直于速度、在机体对称面内（近似取机体 -up × 速度方向修正）
  // 简化：升力沿机体向上方向在垂直速度平面内的分量
  const up = new (vel.constructor)(0, 1, 0).applyQuaternion(state.quat);
  const velDir = vel.clone().normalize();
  // 将机体 up 投影到垂直于速度的平面
  const liftDir = up.clone().sub(velDir.clone().multiplyScalar(up.dot(velDir)));
  if (liftDir.lengthSq() < 1e-8) liftDir.set(0, 1, 0);
  liftDir.normalize();

  const dragDir = velDir.clone().multiplyScalar(-1);
  const aLift = liftDir.multiplyScalar(liftAccelMag);
  const aDrag = dragDir.multiplyScalar(dragAccelMag);

  const accel = thrustAccel.add(aLift).add(aDrag);
  accel.y -= G;
  return accel;
}

// ---------------- 姿态运动学：由角速度积分四元数 ----------------
export function integrateAttitude(quat, angVelBody, dt) {
  // angVelBody: 机体系角速度 {p roll, q pitch, r yaw} rad/s
  // three.js 机体轴：roll 绕 -Z(前向) 、pitch 绕 +X(右)、yaw 绕 -Y(上)
  // 绕机体轴旋转 = quat * localAxisRotation
  const { p, q, r } = angVelBody;
  // 微小旋转：绕机体前向(-Z)滚转 p、绕机体右(+X)俯仰 q、绕机体上(+Y)偏航 r
  // three: 绕本地 X 正转 = 抬头？验证：机体前向 -Z，绕 +X 旋转正角会把 -Z 转向 -Y（低头）。
  // 因此 pitch 输入约定：q>0 = 抬头 → 绕本地 X 负角。roll: 绕 -Z 正 p = 右滚。
  // three: 绕机体 +X 正旋转 = 抬头（前向 -Z 转向 +Y）；绕 +Y 正 = 机头向左；绕 +Z 正 = 左滚
  // 航空习惯输入：q>0 抬头、r>0 机头右、p>0 右滚
  const wx = q, wy = -r, wz = -p; // 转换为 three 本地角速度
  const half = dt / 2;
  const dqLocal = new (quat.constructor)(wx * half, wy * half, wz * half, 1).normalize();
  const out = quat.clone().multiply(dqLocal).normalize(); // 本地轴旋转：q' = q * dq_local
  return out;
}

// ---------------- G 力计算 ----------------
// 返回飞行员体感 G（沿机体向上轴），= (升力+推力垂直分量)/mg 近似 → 用加速度差
export function computeG(state, accelWorld, upBody) {
  // 体感 = (a - g) 在机体 up 上的投影 / G
  const aRel = accelWorld.clone().sub(new (accelWorld.constructor)(0, -G, 0));
  // a - gravityVec? gravityVec=(0,-G,0); aRel = a - (0,-G,0) = a + (0,G,0)
  return aRel.dot(upBody) / G;
}

// ---------------- 马赫数 ----------------
export function machNumber(speed, altitude) {
  return speed / soundSpeed(altitude);
}

// config.js — 全局配置：单位、大气、飞机/导弹/武器/AI 参数、输入映射、HUD 配色
export const G = 9.81;                 // 重力 m/s^2
export const KMH_PER_MS = 3.6;         // m/s -> km/h
export const FT_PER_M = 3.28084;

// 简化 ISA 大气模型（对流层+平流层近似）
export const ATMOSPHERE = {
  seaLevelDensity: 1.225,              // kg/m^3
  seaLevelPressure: 101325,            // Pa
  tempLapse: 0.0065,                   // K/m
  seaLevelTemp: 288.15,                // K
  gasConstant: 287.05,                 // J/(kg·K)
  stratosphereTemp: 216.65,            // K（11km 以上恒温）
};

// 声速（m/s），随高度变化
export function soundSpeed(altitude) {
  const T = Math.max(216.65, 288.15 - 0.0065 * Math.max(0, altitude));
  return Math.sqrt(1.4 * ATMOSPHERE.gasConstant * T);
}

// 空气密度（kg/m^3），随高度
export function airDensity(altitude) {
  const h = Math.max(0, altitude);
  if (h <= 11000) {
    const T = ATMOSPHERE.seaLevelTemp - ATMOSPHERE.tempLapse * h;
    const p = ATMOSPHERE.seaLevelPressure * Math.pow(T / ATMOSPHERE.seaLevelTemp, 5.2561);
    return p / (ATMOSPHERE.gasConstant * T);
  }
  const p11 = 22632.1 * Math.exp(-(h - 11000) / 6341.6);
  return p11 / (ATMOSPHERE.gasConstant * ATMOSPHERE.stratosphereTemp);
}

// ---------------- 机体参数（简化气动）----------------
// CLalpha: 升力线斜率 /rad；CD0: 零升阻力；S: 机翼面积 m^2；mass: kg
// thrustMax: 最大推力 N（加力）；thrustMil: 军用推力
export const AIRCRAFT = {
  player_f16: {
    name: 'F-16CM',
    mass: 9500,                 // 作战重量
    wingArea: 27.87,
    CLalpha: 4.6,               // 1/rad（含涡升力等效）
    CLmax: 1.60,                // ≈ CLalpha·rad(alphaStall)
    alphaStall: 20,             // deg，失速迎角（简化）
    CD0: 0.021,
    kInduced: 0.11,             // 诱导阻力系数 k: CD = CD0 + k*CL^2
    thrustMax: 129000,          // N（加力）
    thrustMil: 76000,
    pitchRateMax: 3.0,          // rad/s（结构/气动包线限制由 FCS 进一步约束）
    rollRateMax: 4.5,
    yawRateMax: 0.9,
    maxG: 9, minG: -3,
    fuel: 3200,                 // kg
    fuelBurnAB: 18.0,           // kg/s at max thrust（近似，游戏化）
    fuelBurnMil: 3.2,
  },
  enemy_mig29: {
    name: 'MiG-29M',
    mass: 11000,
    wingArea: 43.0,
    CLalpha: 4.3,
    CLmax: 1.50,
    alphaStall: 20,
    CD0: 0.024,
    kInduced: 0.12,
    thrustMax: 176000,
    thrustMil: 98000,
    pitchRateMax: 3.0,
    rollRateMax: 4.0,
    yawRateMax: 0.9,
    maxG: 9, minG: -3,
  },
  enemy_su30: {
    name: 'Su-30SM2',
    mass: 21500,
    wingArea: 62.0,
    CLalpha: 4.2,
    CLmax: 1.47,
    alphaStall: 20,
    CD0: 0.027,
    kInduced: 0.13,
    thrustMax: 250000,
    thrustMil: 140000,
    pitchRateMax: 2.6,
    rollRateMax: 3.4,
    yawRateMax: 0.8,
    maxG: 9, minG: -3.5,
  },
};

// ---------------- 武器参数 ----------------
export const WEAPONS = {
  gun: {
    name: 'M61A2 20mm',
    rpm: 6600,                  // 发/分
    muzzleVel: 1050,            // m/s
    rounds: 510,
    damage: 12,
    spread: 0.0022,             // rad
    range: 3600,
  },
  aim120: {
    name: 'AIM-120C',
    boostAccel: 350,            // m/s^2 助推段
    boostTime: 3.2,             // s
    sustainAccel: 60,
    sustainTime: 5.0,
    dragCD: 0.000028,           // 简化：a_drag = dragCD * v^2
    maxSpeed: 1200,             // m/s
    N: 4.5,                     // 比例导引系数
    seekerRange: 18000,         // 末段主动导引头锁定距离 m
    loftAngle: 0.22,            // 中段爬升角 rad
    fuseRadius: 25,             // 近炸引信 m（游戏化：对抗机动目标）
    damage: 110,                // 一发击落 100hp 战斗机；140hp 重型机需两发
    maxG: 40,
    flareDecoyFactor: 0.05,    // 雷达弹：红外诱饵基本无效（真实 AIM-120 为主动雷达制导）
    count: 6,
  },
  r77: {                        // 敌机用（主动雷达弹）
    name: 'R-77-1',
    boostAccel: 330,
    boostTime: 3.0,
    sustainAccel: 55,
    sustainTime: 4.5,
    dragCD: 0.000030,
    maxSpeed: 1100,
    N: 4.5,
    seekerRange: 16000,
    loftAngle: 0.18,
    fuseRadius: 22,
    damage: 95,
    maxG: 38,
    flareDecoyFactor: 0.05,     // 雷达弹：红外诱饵基本无效
    count: 4,
  },
  r73: {                        // 敌机近距红外弹（热诱弹完全有效，箔条无效）
    name: 'R-73',
    boostAccel: 320,
    boostTime: 2.4,
    sustainAccel: 70,
    sustainTime: 3.2,
    dragCD: 0.000026,
    maxSpeed: 950,
    N: 4.0,
    seekerRange: 3600,          // 红外导引头：发射即锁
    loftAngle: 0.0,
    fuseRadius: 16,
    damage: 75,
    maxG: 35,
    flareDecoyFactor: 1.0,      // 红外弹：热诱弹完全有效
    count: 4,
  },
  aim9: {                       // 玩家近距红外弹（AIM-9M 响尾蛇）
    name: 'AIM-9M',
    boostAccel: 330,
    boostTime: 2.2,
    sustainAccel: 75,
    sustainTime: 3.0,
    dragCD: 0.000025,
    maxSpeed: 950,
    N: 4.0,
    seekerRange: 4000,          // 红外导引头：发射即锁
    loftAngle: 0.0,
    fuseRadius: 16,
    damage: 80,
    maxG: 35,
    flareDecoyFactor: 1.0,      // 红外弹：敌机热诱弹有效反制
    count: 2,
  },
};

// ---------------- 输入映射（可在主菜单重绑，存于 settings.js）----------------
export const KEYS = {
  pitchUp: 'KeyS',        // S 抬头
  pitchDown: 'KeyW',      // W 低头
  rollLeft: 'KeyA',
  rollRight: 'KeyD',
  yawLeft: 'KeyQ',
  yawRight: 'KeyE',
  freeLook: 'KeyC',       // 按住 C 自由视角
  throttleUp: 'ShiftLeft',
  throttleDown: 'ControlLeft',
  fireGun: 'Mouse0',      // 固定为鼠标左键
  fireMissile: 'Space',
  weapon1: 'Digit1',      // 选择 AIM-120（雷达弹）
  weapon2: 'Digit2',      // 选择 AIM-9（红外弹）
  cycleTarget: 'Tab',
  flare: 'KeyF',          // 热诱弹
  chaff: 'KeyX',          // 箔条
  pause: 'KeyP',
  radarToggle: 'KeyR',
};

// ---------------- 干扰对策 ----------------
export const COUNTERMEASURES = {
  flareCount: 36,               // 玩家热诱弹
  chaffCount: 24,               // 玩家箔条
  flareCooldown: 0.22,          // s
  chaffCooldown: 0.55,
  enemyFlares: 10,              // 敌机热诱弹（防红外弹）
  enemyChaffs: 6,               // 敌机箔条（防雷达弹）
  flareLife: 4.5,               // s
  chaffLife: 6.0,
  decoyConeRad: 0.42,           // 导引头视场（rad，约 24°）内热诱弹可诱骗
  decoyCheckInterval: 0.2,      // s
  decoyBaseProb: 0.10,          // 每次判定的基础诱骗概率
  decoyCloseProb: 0.30,         // 距离越近叠加的上限概率
  decoyRange: 6000,             // 热诱弹有效诱骗距离
  chaffAffectRadius: 1400,      // 箔条对数据链/末段锁定的作用半径（相对目标）
  chaffSeekerCut: 0.55,         // 被箔条干扰时导引头有效距离倍率
  chaffAimError: 850,           // 中段瞄准点最大随机偏差 m
  // ---- 39机动（径向/多普勒凹陷）破解雷达弹 ----
  notchBeamMax: 0.35,           // 径向速度比 |Vr|/|V| 低于此值视为有效 beaming
  notchBreakBase: 0.16,         // 每次判定的基础脱锁概率（每 0.2s 判定一次，累计趋近必然）
  notchBreakClose: 0.30,        // 导弹逼近叠加概率
  notchMinDist: 800,            // 距离过近（引信即将动作）无法脱锁
};

// ---------------- HUD 配色 ----------------
export const HUD_COLOR = {
  main: '#7dffb0',
  warn: '#ffcf4d',
  danger: '#ff5d5d',
  info: '#7dd4ff',
  dim: 'rgba(125,255,176,0.45)',
};

// ---------------- 世界 ----------------
export const WORLD = {
  terrainSize: 52000,          // 地形边长 m
  spawnAltitude: 2500,
  ceiling: 15000,              // 游戏高度上限 m
  killFloor: -200,             // 低于此高度判定坠毁（地形碰撞另有检测）
};

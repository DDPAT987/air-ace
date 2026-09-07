// settings.js — 用户设置：键位 / 鼠标 / 机体选择与参数覆盖 / 任务载弹，localStorage 持久化
import { KEYS, WEAPONS } from './config.js';

const STORAGE_KEY = 'airace.settings.v1';

const DEFAULTS = {
  keybinds: { ...KEYS },
  invertMousePitch: true,        // true：鼠标下拉 = 拉杆抬头（摇杆习惯）；false：鼠标上推 = 抬头
  mouseSensitivity: 1.0,
  cameraShake: true,
  aircraft: 'player_f16',        // player_f16 | enemy_mig29 | enemy_su30（均可作玩家机）
  overrides: {
    thrustMul: 1.0,              // 推力倍率 0.6~1.6
    massMul: 1.0,                // 重量倍率 0.7~1.4
    liftMul: 1.0,                // 升力倍率 0.7~1.5
    alphaStall: 0,               // 0 = 使用机体默认失速迎角，否则 14~26
    maxG: 0,                     // 0 = 机体默认正过载；4~17G（用户可调）
    minG: 0,                     // 0 = 机体默认负过载；-8~-1G（存负值）
    missiles: 0,                 // 0 = 默认（6，AIM-120）
    aim9: 0,                     // 0 = 默认（2，AIM-9 红外弹）
    gunRounds: 0,                // 0 = 默认（510）
    fuelMul: 1.0,                // 燃油倍率 0.5~2.0
  },
  radarRange: 20,                  // 雷达距离 km（系统设置可调 5~40）
  radarScan: 65,                   // 雷达水平扫描半角 °（±60~±120）
};

function clone(d) { return JSON.parse(JSON.stringify(d)); }

export const Settings = {
  data: clone(DEFAULTS),
  load() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = { ...clone(DEFAULTS), ...parsed };
        this.data.keybinds = { ...clone(DEFAULTS).keybinds, ...(parsed.keybinds ?? {}) };
        this.data.overrides = { ...clone(DEFAULTS).overrides, ...(parsed.overrides ?? {}) };
      }
    } catch { /* 损坏则用默认 */ }
    return this.data;
  },
  save() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch { /* 隐私模式忽略 */ }
  },
  resetKeys() { this.data.keybinds = clone(DEFAULTS).keybinds; this.save(); },
  resetAll() { this.data = clone(DEFAULTS); this.save(); },
};

// 由基础参数 + 用户覆盖生成玩家机体参数
export function buildPlayerSpec(base, ov = {}) {
  const changed = (ov.thrustMul ?? 1) !== 1 || (ov.massMul ?? 1) !== 1 || (ov.liftMul ?? 1) !== 1
    || (ov.alphaStall > 0) || (ov.fuelMul ?? 1) !== 1
    || (ov.maxG > 0 && ov.maxG !== base.maxG) || (ov.minG < 0 && ov.minG !== base.minG);
  const s = { ...base };
  s.mass = Math.round(base.mass * (ov.massMul ?? 1));
  s.thrustMax = Math.round(base.thrustMax * (ov.thrustMul ?? 1));
  s.thrustMil = Math.round(base.thrustMil * (ov.thrustMul ?? 1));
  const liftMul = ov.liftMul ?? 1;
  s.CLmax = +(base.CLmax * liftMul).toFixed(2);
  s.CLalpha = +(base.CLalpha * liftMul).toFixed(2);
  s.alphaStall = ov.alphaStall > 0 ? Math.round(ov.alphaStall) : base.alphaStall;
  s.maxG = ov.maxG > 0 ? Math.round(ov.maxG) : base.maxG;      // 正过载 4~17G
  s.minG = ov.minG < 0 ? Math.round(ov.minG) : base.minG;      // 负过载 -8~-1G
  s.fuel = Math.round((base.fuel ?? 3500) * (ov.fuelMul ?? 1));
  s.fuelBurnAB = base.fuelBurnAB ?? 16;
  s.fuelBurnMil = base.fuelBurnMil ?? 3;
  if (changed) s.name = `${base.name}·改`;
  return s;
}

export function missionCounts(ov = {}) {
  return {
    missiles: ov.missiles > 0 ? Math.round(ov.missiles) : WEAPONS.aim120.count,
    aim9: ov.aim9 > 0 ? Math.round(ov.aim9) : WEAPONS.aim9.count,
    gunRounds: ov.gunRounds > 0 ? Math.round(ov.gunRounds) : WEAPONS.gun.rounds,
  };
}

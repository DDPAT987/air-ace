// menu.js — 主菜单逻辑：标签页 / 按键重绑 / 机体选择与参数 / 系统设置
import { AIRCRAFT, WEAPONS } from './config.js';
import { Settings } from './settings.js';

const KEY_LABELS = [
  ['pitchUp', '俯仰 · 抬头'],
  ['pitchDown', '俯仰 · 低头'],
  ['rollLeft', '滚转 · 左'],
  ['rollRight', '滚转 · 右'],
  ['yawLeft', '偏航 · 左'],
  ['yawRight', '偏航 · 右'],
  ['freeLook', '自由视角（按住）'],
  ['throttleUp', '油门 +'],
  ['throttleDown', '油门 −'],
  ['fireMissile', '发射导弹'],
  ['weapon1', '武器1 · AIM-120 雷达弹'],
  ['weapon2', '武器2 · AIM-9 红外弹'],
  ['cycleTarget', '切换目标'],
  ['flare', '热诱弹'],
  ['chaff', '箔条'],
  ['pause', '暂停'],
];

const FLYABLE = [
  ['player_f16', 'F-16CM', '轻战 · 高滚转率，敏捷均衡'],
  ['enemy_mig29', 'MiG-29M', '推重比高 · 加速凶悍'],
  ['enemy_su30', 'Su-30SM2', '重型 · 血厚弹多，惯性大'],
];

const SLIDERS = [
  ['thrustMul', '推力倍率', 0.6, 1.6, 0.05, (v) => `×${v.toFixed(2)}`],
  ['massMul', '重量倍率', 0.7, 1.4, 0.05, (v) => `×${v.toFixed(2)}`],
  ['liftMul', '升力倍率', 0.7, 1.5, 0.05, (v) => `×${v.toFixed(2)}`],
  ['alphaStall', '失速迎角', 0, 26, 1, (v) => v > 0 ? `${v}°` : '默认'],
  ['maxG', '最大正过载', 4, 17, 1, (v) => `${v}G`, (base) => base.overrides.maxG > 0 ? base.overrides.maxG : 9],
  ['minG', '最大负过载', -8, -1, 1, (v) => `${v}G`, (base) => base.overrides.minG < 0 ? base.overrides.minG : -3],
  ['missiles', 'AIM-120 数量', 0, 8, 1, (v) => v > 0 ? String(v) : `默认${WEAPONS.aim120.count}`],
  ['aim9', 'AIM-9 数量', 0, 6, 1, (v) => v > 0 ? String(v) : `默认${WEAPONS.aim9.count}`],
  ['gunRounds', '航炮弹量', 0, 800, 10, (v) => v > 0 ? String(v) : `默认${WEAPONS.gun.rounds}`],
  ['fuelMul', '燃油倍率', 0.5, 2.0, 0.1, (v) => `×${v.toFixed(1)}`],
];

function codeLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt', Space: '空格', Tab: 'Tab', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Minus: '-', Equal: '=', CapsLock: 'CapsLock', Enter: 'Enter',
  };
  return map[code] ?? code;
}

export class Menu {
  constructor({ onStart }) {
    this.onStart = onStart;
    this.overlay = document.getElementById('overlay');
    this.startBtn = document.getElementById('startbtn');
    this.data = Settings.data;

    this._bindTabs();
    this._buildKeyList();
    this._buildAircraft();
    this._buildSystem();
    this.startBtn.addEventListener('click', () => this._start());
    document.getElementById('keysReset').addEventListener('click', () => { Settings.resetKeys(); this._buildKeyList(); });
    document.getElementById('acReset').addEventListener('click', () => {
      this.data.overrides = { thrustMul: 1, massMul: 1, liftMul: 1, alphaStall: 0, maxG: 0, minG: 0, missiles: 0, gunRounds: 0, fuelMul: 1 };
      Settings.save();
      this._buildAircraft();
    });

    // 重绑监听
    this._listening = null;
    window.addEventListener('keydown', (e) => {
      if (!this._listening) return;
      e.preventDefault(); e.stopPropagation();
      if (e.code !== 'Escape') {
        this.data.keybinds[this._listening.action] = e.code;
        Settings.save();
      }
      this._listening = null;
      this._buildKeyList();
    }, true);
  }

  _bindTabs() {
    const tabs = document.querySelectorAll('.tabs button');
    const panes = document.querySelectorAll('.tabpane');
    tabs.forEach(btn => btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.toggle('active', b === btn));
      panes.forEach(p => p.classList.toggle('hidden', p.id !== `tab-${btn.dataset.tab}`));
    }));
  }

  _buildKeyList() {
    const box = document.getElementById('keylist');
    box.innerHTML = '';
    for (const [action, label] of KEY_LABELS) {
      const row = document.createElement('div');
      row.className = 'keyrow';
      const lab = document.createElement('span');
      lab.className = 'label';
      lab.textContent = label;
      const btn = document.createElement('button');
      btn.className = 'keybtn';
      btn.textContent = codeLabel(this.data.keybinds[action]);
      btn.addEventListener('click', () => {
        document.querySelectorAll('.keybtn.listening').forEach(b => b.classList.remove('listening'));
        btn.classList.add('listening');
        btn.textContent = '按下新按键…';
        this._listening = { action, btn };
      });
      row.append(lab, btn);
      box.append(row);
    }
    // 航炮固定键提示
    const fixed = document.createElement('div');
    fixed.className = 'keyrow';
    fixed.innerHTML = '<span class="label">航炮（固定）</span><span class="keybtn" style="cursor:default">鼠标左键</span>';
    box.append(fixed);
  }

  _buildAircraft() {
    const grid = document.getElementById('acgrid');
    grid.innerHTML = '';
    for (const [key, name, desc] of FLYABLE) {
      const spec = AIRCRAFT[key];
      const card = document.createElement('div');
      card.className = 'accard' + (this.data.aircraft === key ? ' selected' : '');
      card.innerHTML = `<div class="acname">${name}</div>` +
        `<div>${desc}</div>` +
        `<div>推力 ${Math.round(spec.thrustMax / 1000)}kN · 重量 ${(spec.mass / 1000).toFixed(1)}t</div>` +
        `<div>翼面 ${spec.wingArea}m² · 失速 ${spec.alphaStall}°</div>` +
        `<div>滚转 ${Math.round(spec.rollRateMax * 57.3)}°/s</div>`;
      card.addEventListener('click', () => {
        this.data.aircraft = key;
        Settings.save();
        this._buildAircraft();
      });
      grid.append(card);
    }

    const box = document.getElementById('acsliders');
    box.innerHTML = '';
    for (const [prop, label, min, max, step, fmt, initFn] of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'slider-row';
      const lab = document.createElement('label');
      lab.textContent = label;
      const range = document.createElement('input');
      range.type = 'range'; range.min = min; range.max = max; range.step = step;
      const stored = this.data.overrides[prop];
      range.value = initFn ? initFn(this.data) : (stored ?? min);
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = fmt(Number(range.value));
      range.addEventListener('input', () => {
        this.data.overrides[prop] = Number(range.value);
        val.textContent = fmt(Number(range.value));
        Settings.save();
      });
      row.append(lab, range, val);
      box.append(row);
    }
  }

  _buildSystem() {
    // 雷达距离（km）：锁定目标与雷达面板的探测距离
    const rr = document.getElementById('optRadarRange');
    const rrVal = document.getElementById('optRadarRangeVal');
    rr.value = this.data.radarRange ?? 20;
    rrVal.textContent = `${rr.value} km`;
    rr.addEventListener('input', () => {
      this.data.radarRange = Number(rr.value);
      rrVal.textContent = `${rr.value} km`;
      Settings.save();
    });

    // 雷达水平扫描半角（°）：机头 ±角度
    const rs = document.getElementById('optRadarScan');
    const rsVal = document.getElementById('optRadarScanVal');
    rs.value = this.data.radarScan ?? 65;
    rsVal.textContent = `±${rs.value}°`;
    rs.addEventListener('input', () => {
      this.data.radarScan = Number(rs.value);
      rsVal.textContent = `±${rs.value}°`;
      Settings.save();
    });

    const sens = document.getElementById('optSens');
    const sensVal = document.getElementById('optSensVal');
    sens.value = this.data.mouseSensitivity ?? 1.0;
    sensVal.textContent = `×${Number(sens.value).toFixed(1)}`;
    sens.addEventListener('input', () => {
      this.data.mouseSensitivity = Number(sens.value);
      sensVal.textContent = `×${Number(sens.value).toFixed(1)}`;
      Settings.save();
    });

    const shake = document.getElementById('optShake');
    shake.checked = this.data.cameraShake ?? true;
    shake.addEventListener('change', () => { this.data.cameraShake = shake.checked; Settings.save(); });
  }

  enableStart() {
    this.startBtn.disabled = false;
  }

  _start() {
    Settings.save();
    this.overlay.style.display = 'none';
    this.onStart?.();
  }

  show() {
    this.overlay.style.display = 'flex';
  }

  // 从暂停菜单进入配置：显示主菜单并切到指定标签页（默认系统设置）
  showSettings(tab = 'system') {
    this.overlay.style.display = 'flex';
    const btn = document.querySelector(`.tabs button[data-tab="${tab}"]`);
    if (btn) btn.click();
    this.startBtn.textContent = '继 续 任 务';
  }

  resetStartLabel() {
    this.startBtn.textContent = '开 始 任 务';
  }
}

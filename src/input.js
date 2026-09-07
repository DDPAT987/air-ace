// input.js — 键鼠输入：可重绑键位 + 战雷式鼠标飞控（圆环=世界瞄准方向 aimDir，
//             机头受 FCS 控制追逐该方向；鼠标停住后方向固定于世界，机头转过去时
//             圆环投影自然渐回屏幕中心——渐进过程，无定时回中）+ 按键事件
import * as THREE from 'three';
import { Settings } from './settings.js';

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export class Input {
  constructor(domElement = document.body, settings = Settings) {
    this.dom = domElement;
    this.settings = settings;
    this.keybinds = settings.data.keybinds;   // 活引用：菜单重绑后立即生效
    this.keys = new Set();            // 按下的 code
    this.pressed = new Set();         // 本帧刚按下（edge）
    this.mouse = { x: 0, y: 0 };      // 像素位置
    // 战雷式飞控圆环：cursor 为控制位置（相对屏幕中心归一化，x右 y下）
    this.cursor = { x: 0, y: 0 };
    this.aimDir = new THREE.Vector3(0, 0, -1);   // 世界瞄准方向（机头追逐目标）
    this.camera = null;               // 由 main 注入（屏幕→世界反投影）
    this.cursorActive = false;        // 鼠标正在驱动（HUD 高亮）
    this.activeHold = 1.2;            // 移动后高亮保持 s
    this.recenterDelay = 0.35;        // 松手后开始回中的延迟 s
    this._lastMove = -10;
    this._now = 0;
    this.buttons = new Set();
    this.buttonPressed = new Set();
    this.freeDX = 0;                  // 自由视角鼠标增量（相机消费后清零）
    this.freeDY = 0;
    this.pointerLocked = false;
    this.sensitivity = 0.55;          // 指针锁定时：鼠标增量 → 圆环位移系数
    this.virtualEnabled = true;       // 鼠标飞控总开关

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Tab', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });

    this.dom.addEventListener('mousedown', (e) => {
      this.buttons.add(e.button);
      this.buttonPressed.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.freeDX += e.movementX || 0;   // 自由视角原始增量（相机消费）
      this.freeDY += e.movementY || 0;
      // 按住自由视角键时鼠标专用于看视角，不驱动飞控圆环
      if (this.keys.has(this.keybinds.freeLook)) return;
      if (!this.virtualEnabled) return;
      const clampR = 0.88;
      if (this.pointerLocked) {
        // 锁定：增量驱动圆环（虚拟绝对位置）
        const k = this.sensitivity * (this.settings.data.mouseSensitivity ?? 1) * 0.004;
        this.cursor.x = clamp(this.cursor.x + (e.movementX || 0) * k, -clampR, clampR);
        this.cursor.y = clamp(this.cursor.y + (e.movementY || 0) * k, -clampR, clampR);
      } else {
        // 未锁定：圆环 = 鼠标在屏幕上的位置
        this.cursor.x = clamp((e.clientX - window.innerWidth / 2) / (window.innerWidth / 2), -clampR, clampR);
        this.cursor.y = clamp((e.clientY - window.innerHeight / 2) / (window.innerHeight / 2), -clampR, clampR);
      }
      // 关键：移动瞬间把圆环反投影为【世界方向】并冻结。此后相机随机头转动，
      // 该方向固定不变——机头渐进追上时，其屏幕投影（=绘制的圆环）自然滑回中心。
      this._projectCursor();
      this._lastMove = this._now;
      this.cursorActive = true;
    });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
    });
  }

  setCamera(camera) {
    this.camera = camera;
    if (camera) this.aimDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  }

  // 任务开始/重开时重置瞄准方向为当前机头
  resetAim(forwardDir) {
    if (forwardDir) this.aimDir.copy(forwardDir).normalize();
    this.cursor.x = 0; this.cursor.y = 0;
    this.cursorActive = false;
  }

  // 每帧调用（战雷式圆环）：
  //   按住不动（recenterDelay 内）：aimDir 冻结于世界方向，机头渐进追上圆环；
  //   松手超时：cursor 弹性衰减回屏幕中心，同时每帧经当前相机重投影 →
  //   圆环滑回中心的过程中持续带动飞机机头转向——渐进、可中途继续拖动。
  updateAim(dt) {
    this._now += dt;
    if (this._now - this._lastMove > this.activeHold) this.cursorActive = false;
    if (this._now - this._lastMove > this.recenterDelay) {
      const decay = Math.exp(-2.6 * dt);   // 回中速率：约 0.4s 走完 65%
      this.cursor.x *= decay;
      this.cursor.y *= decay;
      if (Math.abs(this.cursor.x) < 0.004 && Math.abs(this.cursor.y) < 0.004) {
        this.cursor.x = 0; this.cursor.y = 0;
      }
      this._projectCursor();               // 衰减中随相机/机头实时重投影
    }
  }

  // 屏幕圆环位置 → 世界瞄准方向（经当前相机反投影）
  _projectCursor() {
    if (!this.camera) return;
    const v = new THREE.Vector3(this.cursor.x, -this.cursor.y, 0.5)
      .unproject(this.camera)
      .sub(this.camera.position)
      .normalize();
    this.aimDir.copy(v);
  }

  requestPointerLock() { this.dom.requestPointerLock?.(); }
  exitPointerLock() { document.exitPointerLock?.(); }

  // 鼠标上下方向：true（默认）= 圆环在下 = 拉杆抬头（摇杆习惯）；false = 圆环在上 = 抬头
  _pitchSign() { return (this.settings.data.invertMousePitch ?? true) ? 1 : -1; }

  // 兼容旧接口：由圆环位置派生的粗略通道（仅供诊断；飞控用 game.buildMouseCommands）
  get virtual() {
    return {
      pitch: clamp(this.cursor.y * this._pitchSign(), -1, 1),
      roll: clamp(this.cursor.x, -1, 1),
      yaw: 0,
    };
  }

  // 动作查询（按当前键位）
  actionDown(name) { return this.keys.has(this.keybinds[name]); }
  actionJustPressed(name) { return this.pressed.has(this.keybinds[name]); }
  codeOf(name) { return this.keybinds[name]; }

  down(code) { return this.keys.has(code); }
  justPressed(code) { return this.pressed.has(code); }
  buttonDown(b) { return this.buttons.has(b); }
  buttonJustPressed(b) { return this.buttonPressed.has(b); }

  // 键盘飞行通道（航空习惯：+pitch = 拉杆抬头）
  channels() {
    return {
      pitch: (this.actionDown('pitchUp') ? 1 : 0) + (this.actionDown('pitchDown') ? -1 : 0),
      roll: (this.actionDown('rollRight') ? 1 : 0) + (this.actionDown('rollLeft') ? -1 : 0),
      yaw: (this.actionDown('yawRight') ? 1 : 0) + (this.actionDown('yawLeft') ? -1 : 0),
    };
  }

  throttleDelta() {
    return (this.actionDown('throttleUp') ? 1 : 0) + (this.actionDown('throttleDown') ? -1 : 0);
  }

  endFrame() {
    this.pressed.clear();
    this.buttonPressed.clear();
  }
}


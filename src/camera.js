// camera.js — 第三人称追尾相机 + 按住自由视角键环绕（键位可设）
import * as THREE from 'three';
import { clamp, damp } from './aero.js';

export class ChaseCamera {
  constructor(camera, settings = null) {
    this.camera = camera;
    this.settings = settings;        // 用于抖动开关
    this.mode = 'CHASE';             // CHASE | FREE
    // 追尾参数（近距贴身视角：机身占画面下 1/3，准星区留空）
    this.distance = 24;
    this.height = 5.5;
    this.sideOffset = 0;
    this.fovBase = 62;
    this.fovBoost = 78;              // 高速时扩展 FOV（速度感）
    this.lookLift = 8;               // 视点上仰量：把飞机压到画面下方
    this.posSmooth = new THREE.Vector3(0, 3000, 100);
    this.lookSmooth = new THREE.Vector3(0, 3000, -50);
    this.shake = 0;
    // 自由视角
    this.freeYaw = 0;                // 相对机尾的方位偏移 rad
    this.freePitch = 0.15;
    this.freeSensitivity = 0.0026;
    this._initPos = false;
  }

  // input: Input 实例；target: { position, quat, velocity }
  update(dt, target, input) {
    // ---- 模式切换：按住自由视角键（默认 C，可重绑）----
    const freeHeld = input.actionDown ? input.actionDown('freeLook') : input.down('KeyC');
    if (freeHeld) {
      if (this.mode !== 'FREE') {
        this.mode = 'FREE';
        // 无缝起始：从当前追尾相机位置反解球坐标，视角从"现在看到的画面"开始旋转
        const dist = this.distance * 1.05;
        const inv = target.quat.clone().invert();
        const local = this.camera.position.clone().sub(target.position).applyQuaternion(inv);
        const len = local.length() || 1;
        this.freeYaw = Math.atan2(local.x, local.z);
        this.freePitch = -Math.asin(clamp(local.y / len, -1, 1));
        // 归一到与渲染公式一致的距离尺度
        this.camera.position.copy(target.position).add(
          new THREE.Vector3(0, 0, dist).applyQuaternion(target.quat.clone()
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.freeYaw))
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.freePitch))));
      }
      // 累积视角（Input 提供原始增量）
      this.freeYaw = clamp(this.freeYaw - input.freeDX * this.freeSensitivity, -Math.PI * 0.95, Math.PI * 0.95);
      this.freePitch = clamp(this.freePitch - input.freeDY * this.freeSensitivity, -1.2, 1.2);
      input.freeDX = 0; input.freeDY = 0;
    } else if (this.mode === 'FREE') {
      this.mode = 'CHASE';
      this.freeYaw = 0; this.freePitch = 0.15;
    }

    const speed = target.velocity.length();
    const machFoV = clamp((speed - 180) / 420, 0, 1);
    const targetFov = this.fovBase + (this.fovBoost - this.fovBase) * machFoV;
    this.camera.fov = damp(this.camera.fov, this.mode === 'FREE' ? this.fovBase : targetFov, 3, dt);
    this.camera.updateProjectionMatrix();

    if (this.mode === 'CHASE') {
      // ---- 追尾：机体后上方，带速度感拉近与抖动 ----
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(target.quat);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(target.quat);
      const desired = target.position.clone()
        .addScaledVector(back, this.distance * (1 - machFoV * 0.18))
        .addScaledVector(up, this.height);
      const lookAt = target.position.clone()
        .addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(target.quat), 60)
        .addScaledVector(up, this.lookLift);

      if (!this._initPos) {
        this.posSmooth.copy(desired);
        this.lookSmooth.copy(lookAt);
        this._initPos = true;
      }
      // 平滑（速度越高跟随越紧）
      const lambda = 6 + machFoV * 6;
      this.posSmooth.x = damp(this.posSmooth.x, desired.x, lambda, dt);
      this.posSmooth.y = damp(this.posSmooth.y, desired.y, lambda, dt);
      this.posSmooth.z = damp(this.posSmooth.z, desired.z, lambda, dt);
      this.lookSmooth.x = damp(this.lookSmooth.x, lookAt.x, 10, dt);
      this.lookSmooth.y = damp(this.lookSmooth.y, lookAt.y, 10, dt);
      this.lookSmooth.z = damp(this.lookSmooth.z, lookAt.z, 10, dt);

      this.camera.position.copy(this.posSmooth);
      this._applyShake(dt, speed);
      this.camera.up.copy(up.clone().lerp(new THREE.Vector3(0, 1, 0), 0.35).normalize());
      this.camera.lookAt(this.lookSmooth);
    } else {
      // ---- 自由视角：绕机体球坐标 ----
      const dist = this.distance * 1.05;
      const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.freeYaw);
      const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.freePitch);
      const rot = target.quat.clone().multiply(yawQ).multiply(pitchQ);
      const offset = new THREE.Vector3(0, 0, dist).applyQuaternion(rot);
      this.camera.position.copy(target.position).add(offset);
      this._applyShake(dt, speed);
      this.camera.up.set(0, 1, 0).applyQuaternion(rot);
      this.camera.lookAt(target.position);
    }
  }

  _applyShake(dt, speed) {
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const shakeOn = this.settings?.data?.cameraShake ?? true;
    const amp = shakeOn
      ? this.shake * 0.5 + clamp((speed - 320) / 600, 0, 1) * 0.06
      : 0;
    if (amp > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * amp;
      this.camera.position.y += (Math.random() - 0.5) * amp;
      this.camera.position.z += (Math.random() - 0.5) * amp;
    }
  }

  addShake(amount) {
    if (this.settings?.data?.cameraShake ?? true) this.shake = Math.min(this.shake + amount, 2.5);
  }

  // 重开任务后重置平滑跟随点
  reinit() {
    this._initPos = false;
    this.mode = 'CHASE';
    this.freeYaw = 0;
    this.freePitch = 0.15;
    this.shake = 0;
  }
}

// game.js — 游戏编排：实体管理、武器发射、碰撞、计分、波次、特效、干扰对策
import * as THREE from 'three';
import { AIRCRAFT, WEAPONS, WORLD, HUD_COLOR, COUNTERMEASURES } from './config.js';
import { Aircraft, buildPlaceholderJet } from './aircraft.js';
import { EnemyAI, WaveManager } from './ai.js';
import { fireGun, fireMissile } from './weapons.js';
import { clamp, damp } from './aero.js';
import { Settings, buildPlayerSpec, missionCounts } from './settings.js';

export class Game {
  constructor(scene, camera, input, chaseCam) {
    this.scene = scene;
    this.camera = camera;
    this.input = input;
    this.chaseCam = chaseCam;
    this.settings = Settings;

    this.player = null;
    this.enemies = [];
    this.bullets = [];
    this.missiles = [];
    this.explosions = [];
    this.flares = [];               // 热诱弹实体
    this.chaffs = [];               // 箔条云实体
    this.score = 0;
    this.kills = 0;
    this.deaths = 0;
    this.wave = 0;
    this.messages = [];            // { text, time, color }
    this.gunRounds = WEAPONS.gun.rounds;
    this.missileCount = WEAPONS.aim120.count;
    this.flareCount = COUNTERMEASURES.flareCount;
    this.chaffCount = COUNTERMEASURES.chaffCount;
    this._flareCd = 0;
    this._chaffCd = 0;
    this.gunHeat = 0;
    this.targetIdx = -1;
    this.time = 0;
    this.gameOver = false;
    this.hitFlash = 0;
    this.killFeedTimer = 0;
    this.terrain = null;          // 由 main 注入
    this.modelLib = null;         // 由 main 注入

    // 弹丸/导弹视觉池
    this.tracerGeo = new THREE.SphereGeometry(0.35, 6, 4);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd28a });
    this.missileGeo = new THREE.CapsuleGeometry(0.28, 2.6, 4, 8);
    this.missileMat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 0.6, roughness: 0.4 });

    // 爆炸粒子纹理（程序化）
    this.sparkTexture = makeSparkTexture();
    this.flareTexture = makeFlareTexture();

    // 导弹尾迹
    this.trailMat = new THREE.LineBasicMaterial({ color: 0xffe9c0, transparent: true, opacity: 0.55 });
  }

  start() {
    // 玩家：按设置选择机体与参数
    const acKey = this.settings.data.aircraft in AIRCRAFT ? this.settings.data.aircraft : 'player_f16';
    const spec = buildPlayerSpec(AIRCRAFT[acKey], this.settings.data.overrides);
    const counts = missionCounts(this.settings.data.overrides);
    this.missileCount = counts.missiles;          // AIM-120
    this.missile9Count = counts.aim9;             // AIM-9
    this.selectedWeapon = 'aim120';
    this.gunRounds = counts.gunRounds;
    this._maxMissiles = counts.missiles;
    this._maxMissiles9 = counts.aim9;
    this._maxGunRounds = counts.gunRounds;
    this.flareCount = COUNTERMEASURES.flareCount;
    this.chaffCount = COUNTERMEASURES.chaffCount;
    this._playerSpecKey = acKey;

    const spawnX = 0, spawnZ = Math.min(this.terrain ? this.terrain.worldD / 2 - 6000 : 8000, 12000);
    const groundAt = this.terrain ? this.terrain.heightAt(spawnX, spawnZ) : 0;
    this.player = new Aircraft(spec, {
      position: new THREE.Vector3(spawnX, Math.max(groundAt + 2200, WORLD.spawnAltitude), spawnZ),
      velocity: new THREE.Vector3(0, 0, -240),
      isPlayer: true, team: 'blue',
    });
    // 瞄准方向重置为当前机头（换机/重开不残留旧指令）
    if (this.input?.resetAim) this.input.resetAim(this.player.forward());
    const mesh = this.modelLib
      ? this.modelLib.makeJet(acKey, true)
      : buildPlaceholderJet(0x5b7d9e);
    this.scene.add(mesh);
    this.player.object3D = mesh;
    // 敌机波次
    this.waveMgr = new WaveManager({ origin: new THREE.Vector3(0, 3200, -6000) });
    this.spawnWave();
    this.spawnSupplyZone();
    this.addMessage(`出击：${spec.name}`, HUD_COLOR.info);
  }

  // ---------------- 补给点（穿环补满弹药/干扰物/燃油）----------------
  spawnSupplyZone() {
    if (this.supplyZone) {
      this.scene.remove(this.supplyZone.group);
      this.supplyZone.group.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    }
    const x = 0, z = 7000;
    const groundAt = this.terrain ? this.terrain.heightAt(x, z) : 0;
    const y = Math.max(groundAt + 1800, 3200);
    const group = new THREE.Group();
    // 主环（水平大圆环，穿环判定半径 1000m；视觉半径 380）
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(380, 16, 10, 48),
      new THREE.MeshBasicMaterial({ color: 0x37e6ff, transparent: true, opacity: 0.75 }),
    );
    ring.rotation.x = Math.PI / 2;
    // 内环
    const ring2 = new THREE.Mesh(
      new THREE.TorusGeometry(220, 8, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0x9ff3ff, transparent: true, opacity: 0.5 }),
    );
    ring2.rotation.x = Math.PI / 2;
    // 光柱
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(60, 60, 4200, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x37e6ff, transparent: true, opacity: 0.12,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beam.position.y = -1600;
    group.add(ring, ring2, beam);
    group.position.set(x, y, z);
    this.scene.add(group);
    this.supplyZone = { group, ring, ring2, position: new THREE.Vector3(x, y, z), radius: 1000 };
    this._supplyCd = 0;
  }

  updateSupplyZone(dt) {
    const sz = this.supplyZone;
    if (!sz) return;
    sz.group.rotation.y += dt * 0.5;
    sz.ring2.rotation.z += dt * 0.8;
    this._supplyCd = Math.max(0, this._supplyCd - dt);
    const p = this.player;
    if (!p?.alive || this._supplyCd > 0) return;
    if (p.position.distanceTo(sz.position) < sz.radius) {
      const needRefill = this.missileCount < this._maxMissiles
        || (this.missile9Count ?? 0) < (this._maxMissiles9 ?? 2)
        || this.gunRounds < this._maxGunRounds
        || this.flareCount < COUNTERMEASURES.flareCount
        || this.chaffCount < COUNTERMEASURES.chaffCount;
      this.missileCount = this._maxMissiles;
      this.missile9Count = this._maxMissiles9 ?? 2;
      this.gunRounds = this._maxGunRounds;
      this.flareCount = COUNTERMEASURES.flareCount;
      this.chaffCount = COUNTERMEASURES.chaffCount;
      if (p.spec?.fuel) p.fuel = p.spec.fuel;
      this._supplyCd = 25;
      this.addMessage(needRefill ? '✈ 补给点：弹药/干扰物/燃油已补满' : '✈ 补给点：状态已恢复', HUD_COLOR.info);
    }
  }

  // 原地重开：清空全部实体并重建玩家与波次（不刷新页面，保留设置）
  reset() {
    for (const e of this.enemies) this.scene.remove(e.object3D);
    for (const b of this.bullets) this.scene.remove(b.mesh);
    for (const m of this.missiles) {
      this.scene.remove(m.mesh);
      if (m.trailLine) { this.scene.remove(m.trailLine); m.trailLine.geometry.dispose(); }
    }
    for (const f of this.flares) if (f.mesh) this.scene.remove(f.mesh);
    for (const c of this.chaffs) for (const s of (c.meshes ?? [])) this.scene.remove(s);
    for (const ex of this.explosions) ex.kill();
    if (this.player?.object3D) this.scene.remove(this.player.object3D);
    this.enemies = []; this.bullets = []; this.missiles = []; this.explosions = [];
    this.flares = []; this.chaffs = [];
    this.score = 0; this.kills = 0; this.wave = 0;
    this.messages = []; this.targetIdx = -1;
    this.hitFlash = 0; this.gunHeat = 0;
    this._gunAcc = 0; this._flareCd = 0; this._chaffCd = 0;
    this.gameOver = false;
    this.time = 0;
    this.start();
  }

  spawnWave() {
    this.waveMgr.wave += 1;
    this.wave = this.waveMgr.wave;
    const spec = this.waveMgr.waveSpec;
    for (let i = 0; i < spec.count; i++) {
      const s = this.waveMgr._spawnSpec(i, spec);
      // 地形安全：出生点抬高到地形之上
      const gY = this.terrain ? this.terrain.heightAt(s.position.x, s.position.z) : 0;
      s.position.y = Math.max(s.position.y, gY + 1800);
      const enemy = new Aircraft(AIRCRAFT[s.type], {
        position: s.position,
        velocity: s.velocity,
        team: 'red',
      });
      enemy.ai = new EnemyAI({ skill: s.skill, aggression: s.aggression, patrolCenter: s.position.clone() });
      // 地形感知：防撞用地面相对高度 + 巡航航点抬高
      const terrain = this.terrain;
      enemy.ai.terrainClearance = (self) =>
        (terrain ? terrain.heightAt(self.position.x, self.position.z) : 0) + 700;
      enemy.ai.terrainHeight = (x, z) => terrain ? terrain.heightAt(x, z) : 0;
      enemy._flares = COUNTERMEASURES.enemyFlares;
      enemy._chaffs = COUNTERMEASURES.enemyChaffs;
      enemy.hp = s.type === 'enemy_su30' ? 140 : 100;
      enemy.maxHp = enemy.hp;
      const mesh = this.modelLib
        ? this.modelLib.makeJet(s.type, false)
        : buildPlaceholderJet(s.type === 'enemy_su30' ? 0x8a4a3a : 0x7a3535);
      this.scene.add(mesh);
      enemy.object3D = mesh;
      this.enemies.push(enemy);
    }
    this.addMessage(`第 ${this.wave} 波：${spec.count} 架敌机接近`, HUD_COLOR.warn);
  }

  addMessage(text, color = HUD_COLOR.main) {
    this.messages.unshift({ text, color, time: 4 });
    if (this.messages.length > 5) this.messages.pop();
  }

  get target() {
    if (this.enemies.length === 0) return null;
    const idx = this.targetIdx % this.enemies.length;
    return this.enemies[idx] ?? null;
  }

  cycleTarget() {
    // 雷达距离 + 机头水平扫描角（均可设置）内才能选择锁定目标
    const rangeM = (this.settings.data.radarRange ?? 20) * 1000;
    const scan = (this.settings.data.radarScan ?? 65) * Math.PI / 180;
    const fwd = this.player.forward(); fwd.y = 0; fwd.normalize();
    const right = this.player.right(); right.y = 0; right.normalize();
    const inRange = this.enemies
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        if (!e.alive) return false;
        const rel = e.position.clone().sub(this.player.position);
        if (rel.length() > rangeM) return false;
        const dist = Math.hypot(rel.x, rel.z);
        if (dist < 1e-3) return true;
        const ang = Math.atan2(rel.dot(right), rel.dot(fwd));   // +：右偏
        return Math.abs(ang) <= scan;
      });
    if (inRange.length === 0) {
      this.targetIdx = -1;
      this.addMessage('雷达范围内无目标', HUD_COLOR.warn);
      return;
    }
    const cur = inRange.findIndex(({ i }) => i === this.targetIdx);
    this.targetIdx = inRange[(cur + 1) % inRange.length].i;
  }

  // 战雷式教练机指令：机头追逐飞控圆环指示的世界瞄准方向（aimDir）
  // 圆环=方向语义：圆环在上→抬头，在下→低头（直接映射，无需反转选项）
  // 输出归一化 pitch/roll（FCS 继续做速率限制与包线保护）
  buildMouseCommands(p) {
    const input = this.input;
    if (!input?.aimDir || input.actionDown('freeLook')) return { pitch: 0, roll: 0, yaw: 0 };
    // 圆环回到屏幕中心 = 零输入（战雷语义：环在中心即杆回中）
    if (Math.abs(input.cursor.x) < 0.02 && Math.abs(input.cursor.y) < 0.02) {
      return { pitch: 0, roll: 0, yaw: 0 };
    }
    const inv = p.quat.clone().invert();
    const e = input.aimDir.clone().applyQuaternion(inv);
    if (e.lengthSq() < 1e-8) return { pitch: 0, roll: 0, yaw: 0 };
    e.normalize();
    const yawErr = Math.atan2(e.x, -e.z);                        // +：目标在右
    const pitchErr = Math.atan2(e.y, Math.hypot(e.x, e.z));      // +：目标在上
    const pitch = clamp(pitchErr * 2.2 + Math.abs(yawErr) * 0.35, -1, 1);
    const roll = clamp(yawErr * 2.4, -1, 1);
    return { pitch, roll, yaw: 0 };
  }

  update(dt) {
    this.time += dt;
    const input = this.input;

    // ---- 玩家输入 ----
    if (this.player?.alive) {
      const ch = input.channels();
      const tDelta = input.throttleDelta();
      this.player.throttle = clamp(this.player.throttle + tDelta * dt * 0.7, 0, 1);
      const mouse = this.buildMouseCommands(this.player);
      this.player.update(dt, {
        pitch: ch.pitch, roll: ch.roll, yaw: ch.yaw,
        throttle: this.player.throttle,
      }, mouse);

      // 武器选择（1=AIM-120 雷达弹 / 2=AIM-9 红外弹）
      if (input.actionJustPressed('weapon1')) {
        this.selectedWeapon = 'aim120';
        this.addMessage(`武器：${WEAPONS.aim120.name} 雷达弹`, HUD_COLOR.info);
      }
      if (input.actionJustPressed('weapon2')) {
        this.selectedWeapon = 'aim9';
        this.addMessage(`武器：${WEAPONS.aim9.name} 红外弹`, HUD_COLOR.info);
      }

      // 开火
      if (input.buttonDown(0) && this.gunRounds > 0 && this.gunHeat < 1) {
        this.firePlayerGun(dt);
      }
      if (input.buttonJustPressed(2) || input.actionJustPressed('fireMissile')) {
        this.firePlayerMissile();
      }
      if (input.actionJustPressed('cycleTarget')) this.cycleTarget();

      // 干扰对策
      this._flareCd -= dt; this._chaffCd -= dt;
      if (input.actionJustPressed('flare') && this.flareCount > 0 && this._flareCd <= 0) {
        this.deployFlares(this.player, 2);
        this.flareCount -= 2;
        this._flareCd = COUNTERMEASURES.flareCooldown;
      }
      if (input.actionJustPressed('chaff') && this.chaffCount > 0 && this._chaffCd <= 0) {
        this.deployChaff(this.player);
        this.chaffCount -= 1;
        this._chaffCd = COUNTERMEASURES.chaffCooldown;
      }

      // 地形碰撞/坠毁判定
      const groundY = this.terrain ? this.terrain.heightAt(this.player.position.x, this.player.position.z) : 0;
      if (this.player.position.y < groundY + 15) {
        this.destroyPlayer('撞击地形');
      }
    }
    // 兜底：任何路径导致玩家不存活（如外部伤害注入）都进入死亡流程
    if (this.player && !this.player.alive && !this.gameOver) this.destroyPlayer('机体损毁');
    this.gunHeat = Math.max(0, this.gunHeat - dt * 0.8);

    // ---- 敌机 ----
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const threat = this.inboundMissileFor(e);
      const cmd = e.ai.update(dt, e, this.player?.alive ? this.player : { position: new THREE.Vector3(), velocity: new THREE.Vector3(), alive: false }, threat);
      e.update(dt, cmd);
      // 敌机干扰对策：红外弹→热诱弹 / 雷达弹→箔条（AI 按弹种请求）
      if (cmd.fireFlare && threat && e._flares > 0 && this.time > (e._flareCd ?? 0)) {
        this.deployFlares(e, 2);
        e._flares -= 2;
        e._flareCd = this.time + 0.9;
      }
      if (cmd.fireChaff && threat && (e._chaffs ?? 0) > 0 && this.time > (e._chaffCd ?? 0)) {
        this.deployChaff(e);
        e._chaffs -= 1;
        e._chaffCd = this.time + 1.0;
      }
      if (cmd.fireGun && this.time > (e._nextGun ?? 0)) {
        this.fireEnemyGun(e);
        e._nextGun = this.time + 0.1;
      }
      if (cmd.fireMissile && this.time > (e._nextMsl ?? 0)) {
        e._nextMsl = this.time + 9;
        const spec = cmd.fireMissile === 'ir' ? WEAPONS.r73 : WEAPONS.r77;
        this.launchMissile(e, this.player, spec, 'red');
        if (this.player?.alive) this.addMessage(`${e.spec.name} 发射 ${spec.name}！`, HUD_COLOR.danger);
      }
      if (e.position.y < (this.terrain ? this.terrain.heightAt(e.position.x, e.position.z) : 0) + 60) {
        e.applyDamage(1000); // 撞地
      }
    }

    // ---- 弹丸 ----
    for (const b of this.bullets) {
      b.update(dt);
      b.mesh.position.copy(b.position);
      // 命中检测（分段）
      if (b.owner === 'player') {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          if (b.position.distanceTo(e.position) < 16) {
            const killed = e.applyDamage(b.damage);
            this.spawnHitSpark(b.position, 0xffca7a);
            b.alive = false;
            if (killed) this.onEnemyKilled(e, 'gun');
            break;
          }
        }
      } else if (this.player?.alive && b.position.distanceTo(this.player.position) < 16) {
        const killed = this.player.applyDamage(b.damage);
        this.spawnHitSpark(b.position, 0xff7a5a);
        this.hitFlash = Math.min(1, this.hitFlash + 0.35);
        this.chaseCam.addShake(0.4);
        b.alive = false;
        if (killed) this.destroyPlayer('被航炮击落');
      }
    }

    // ---- 导弹（含干扰对策上下文）----
    const cmWorld = { flares: this.flares, chaffs: this.chaffs };
    for (const m of this.missiles) {
      m.update(dt, cmWorld);
      // 我方导弹被目标 39+箔条破解 → 战报
      if (m.notched && !m._notchReported) {
        m._notchReported = true;
        if (m.owner === 'player') this.addMessage('目标 39 机动+箔条 · 导弹脱锁！', HUD_COLOR.warn);
      }
      // 我方导弹被热诱弹诱骗 → 战报
      if (m.decoyed && !m._decoyReported) {
        m._decoyReported = true;
        if (m.owner === 'player') this.addMessage('导弹被热诱弹诱骗', HUD_COLOR.warn);
      }
      m.mesh.position.copy(m.position);
      m.mesh.quaternion.copy(m.quat);
      this.updateMissileTrail(m, dt);
      if (m.hit && m.target) {
        if (m.target.isFlare) {
          // 命中热诱弹：小爆炸，诱饵消耗
          this.spawnExplosion(m.position, 0.5);
          m.target.alive = false;
        } else {
          this.spawnExplosion(m.position);
          const killed = m.target.applyDamage(m.spec.damage);
          this.chaseCam.addShake(m.target === this.player ? 1.2 : 0.25);
          if (m.target === this.player && !killed) this.hitFlash = 1;
          if (killed) {
            if (m.target === this.player) this.destroyPlayer('被导弹击落');
            else this.onEnemyKilled(m.target, 'missile');
          }
        }
      } else if (!m.alive && m.expired) {
        this.spawnExplosion(m.position, 0.6);
      }
    }

    // ---- 干扰对策实体 ----
    this.updateCountermeasures(dt);

    // ---- 补给点 ----
    this.updateSupplyZone(dt);

    // ---- 清理 ----
    this.bullets = this.bullets.filter(b => {
      if (!b.alive || b.life <= 0) { this.scene.remove(b.mesh); return false; }
      return true;
    });
    this.missiles = this.missiles.filter(m => {
      if (!m.alive) {
        this.scene.remove(m.mesh);
        if (m.trailLine) { this.scene.remove(m.trailLine); m.trailLine.geometry.dispose(); }
        return false;
      }
      return true;
    });
    this.flares = this.flares.filter(f => {
      if (!f.alive) { if (f.mesh) this.scene.remove(f.mesh); return false; }
      return true;
    });
    this.chaffs = this.chaffs.filter(c => {
      if (!c.alive) { for (const s of (c.meshes ?? [])) this.scene.remove(s); return false; }
      return true;
    });

    // ---- 爆炸特效 ----
    for (const ex of this.explosions) ex.update(dt);
    this.explosions = this.explosions.filter(e => e.alive);

    // ---- 消息 ----
    for (const msg of this.messages) msg.time -= dt;
    this.messages = this.messages.filter(m => m.time > 0);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 1.5);

    // ---- 敌机清理与下一波 ----
    const before = this.enemies.length;
    this.enemies = this.enemies.filter(e => {
      if (!e.alive) { this.scene.remove(e.object3D); return false; }
      e.syncVisual();
      return true;
    });
    if (before > 0 && this.enemies.length === 0) {
      this.addMessage(`第 ${this.wave} 波清空！+${200 * this.wave}分`, HUD_COLOR.main);
      this.score += 200 * this.wave;
      // 波次补给：清空一波奖励少量弹药与干扰物
      this.missileCount = Math.min(this.missileCount + 2, this._maxMissiles ?? this.missileCount);
      this.missile9Count = Math.min((this.missile9Count ?? 0) + 1, this._maxMissiles9 ?? this.missile9Count ?? 2);
      this.flareCount = Math.min(this.flareCount + 6, COUNTERMEASURES.flareCount);
      this.chaffCount = Math.min(this.chaffCount + 4, COUNTERMEASURES.chaffCount);
      this.addMessage(`空投补给 +2 AIM-120 +1 AIM-9 +6 热诱弹 +4 箔条`, HUD_COLOR.info);
      this.spawnWave();
    }

    // ---- 玩家视觉同步 ----
    this.player?.syncVisual();
    this.updateAfterburnerVisual();
  }

  firePlayerGun(dt) {
    const p = this.player;
    const rate = WEAPONS.gun.rpm / 60; // 发/秒
    this._gunAcc = (this._gunAcc ?? 0) + rate * dt;
    const dir = p.forward();
    while (this._gunAcc >= 1 && this.gunRounds > 0) {
      this._gunAcc -= 1;
      this.gunRounds -= 1;
      const bullets = fireGun(p, dir, WEAPONS.gun, 'player');
      for (const b of bullets) {
        const mesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
        mesh.position.copy(b.position);
        this.scene.add(mesh);
        b.mesh = mesh;
        this.bullets.push(b);
      }
      this.gunHeat = Math.min(1.2, this.gunHeat + 0.02);
    }
  }

  fireEnemyGun(e) {
    // 前置瞄准
    const toP = this.player.position.clone().sub(e.position);
    const dist = toP.length();
    const tGo = clamp(dist / WEAPONS.gun.muzzleVel, 0, 2);
    const aim = this.player.position.clone().addScaledVector(this.player.velocity, tGo);
    const dir = aim.sub(e.position).normalize();
    // 精度误差
    const err = (1 - (e.ai?.skill ?? 0.5)) * 0.02;
    dir.x += (Math.random() - 0.5) * err;
    dir.y += (Math.random() - 0.5) * err;
    dir.z += (Math.random() - 0.5) * err;
    const bullets = fireGun(e, dir.normalize(), WEAPONS.gun, 'enemy');
    for (const b of bullets) {
      const mesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
      mesh.position.copy(b.position);
      this.scene.add(mesh);
      b.mesh = mesh;
      this.bullets.push(b);
    }
  }

  firePlayerMissile() {
    if (!this.target) { this.addMessage('无锁定目标', HUD_COLOR.warn); return; }
    const isIR = this.selectedWeapon === 'aim9';
    if (isIR && this.missile9Count <= 0) { this.addMessage('AIM-9 耗尽', HUD_COLOR.warn); return; }
    if (!isIR && this.missileCount <= 0) { this.addMessage('AIM-120 耗尽', HUD_COLOR.warn); return; }
    const spec = isIR ? WEAPONS.aim9 : WEAPONS.aim120;
    if (isIR) this.missile9Count -= 1;
    else this.missileCount -= 1;
    this.launchMissile(this.player, this.target, spec, 'player', !isIR);
    this.addMessage(isIR ? 'FOX 2 — AIM-9 发射' : 'FOX 3 — AIM-120 发射', HUD_COLOR.info);
  }

  launchMissile(owner, target, spec, team, alternate = false) {
    const side = alternate ? (this.missileCount % 2 === 0 ? 1 : -1) : 1;
    const offset = new THREE.Vector3(side * 1.6, -1.2, -1);
    const m = fireMissile(owner, target, spec, team, Math.random(), { offset });
    const mesh = this.modelLib
      ? this.modelLib.makeMissile(spec === WEAPONS.aim120 ? 'aim120' : (spec === WEAPONS.aim9 ? 'aim9' : 'r77'))
      : new THREE.Mesh(this.missileGeo, this.missileMat);
    if (!this.modelLib) mesh.rotation.x = Math.PI / 2;
    mesh.quaternion.copy(m.quat);
    this.scene.add(mesh);
    m.mesh = mesh;
    // 尾迹
    const trailGeo = new THREE.BufferGeometry().setFromPoints([m.position.clone(), m.position.clone()]);
    const trailLine = new THREE.Line(trailGeo, this.trailMat);
    this.scene.add(trailLine);
    m.trailLine = trailLine;
    m.trailPoints = [];
    this.missiles.push(m);
    this.spawnMissileFlame(m.position);
  }

  updateMissileTrail(m, dt) {
    m.trailTime = (m.trailTime ?? 0) + dt;
    if (m.trailTime > 0.02) {
      m.trailTime = 0;
      m.trailPoints.push(m.position.clone());
      if (m.trailPoints.length > 70) m.trailPoints.shift();
      if (m.trailLine) {
        // 重建 geometry：setFromPoints 复用旧 attribute 时按旧 count 迭代，数组变短会越界
        m.trailLine.geometry.dispose();
        m.trailLine.geometry = new THREE.BufferGeometry().setFromPoints(m.trailPoints);
      }
    }
  }

  inboundMissileFor(aircraft) {
    // 找来袭导弹（针对该飞机的敌方导弹）
    for (const m of this.missiles) {
      if (m.alive && m.target === aircraft) return m;
    }
    return null;
  }

  // RWR 辐射源列表（供 HUD 告警圆盘）
  rwrThreats() {
    const p = this.player;
    if (!p?.alive) return [];
    const out = [];
    for (const e of this.enemies) {
      if (!e.alive || !e.ai) continue;
      const rel = e.position.clone().sub(p.position);
      const dist = rel.length();
      if (dist > 32000) continue;
      // 敌机机头对准我方 → 火控锁定（强信号）；否则搜索/跟踪
      const eFwd = e.forward();
      const pointing = eFwd.dot(rel.clone().negate().normalize()) > 0.906;  // cos25°
      const kind = (e.ai.state === 'ATTACK' && pointing) ? 'lock' : 'track';
      out.push({ kind, dist, bearingFrom: rel });
    }
    for (const m of this.missiles) {
      if (!m.alive || m.target !== p) continue;
      out.push({
        kind: 'missile',
        dist: m.position.distanceTo(p.position),
        bearingFrom: m.position.clone().sub(p.position),
      });
    }
    return out;
  }

  // ---------------- 干扰对策 ----------------
  deployFlares(owner, count = 2) {
    for (let i = 0; i < count; i++) {
      const back = owner.forward().multiplyScalar(-1);
      const pos = owner.position.clone().addScaledVector(back, 10)
        .add(new THREE.Vector3(rand(3), -2.5, rand(3)));
      const vel = owner.velocity.clone().multiplyScalar(0.55)
        .add(new THREE.Vector3(rand(35), -18 + rand(12), rand(35)));
      const mesh = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flareTexture, color: 0xffd9a0, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.position.copy(pos);
      mesh.scale.setScalar(6);
      this.scene.add(mesh);
      this.flares.push({
        position: pos, velocity: vel, age: 0, alive: true,
        isFlare: true, owner, mesh, life: COUNTERMEASURES.flareLife,
      });
    }
    if (owner === this.player) this.chaseCam.addShake(0.12);
  }

  deployChaff(owner) {
    const pos = owner.position.clone().addScaledVector(owner.forward(), -6);
    const vel = owner.velocity.clone().multiplyScalar(0.85).add(new THREE.Vector3(rand(12), rand(6), rand(12)));
    const meshes = [];
    for (let i = 0; i < 7; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flareTexture, color: 0xcfd8e8, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      s.position.copy(pos).add(new THREE.Vector3(rand(14), rand(8), rand(14)));
      s.scale.setScalar(1.6 + Math.random() * 1.4);
      this.scene.add(s);
      meshes.push(s);
    }
    this.chaffs.push({
      position: pos, velocity: vel, age: 0, alive: true,
      isChaff: true, owner, meshes, life: COUNTERMEASURES.chaffLife,
    });
  }

  updateCountermeasures(dt) {
    for (const f of this.flares) {
      f.age += dt;
      // 曳光弹：重力 + 强气动阻力 + 下坠减速
      f.velocity.y -= 9.81 * 0.55 * dt;
      f.velocity.multiplyScalar(Math.max(0, 1 - 1.15 * dt));
      f.position.addScaledVector(f.velocity, dt);
      if (f.mesh) {
        f.mesh.position.copy(f.position);
        const t = f.age / f.life;
        f.mesh.material.opacity = Math.max(0, 1 - t * t);
        f.mesh.scale.setScalar(6 * (1 - t * 0.4) + Math.sin(f.age * 30) * 0.5);
      }
      if (f.age > f.life) f.alive = false;
    }
    for (const c of this.chaffs) {
      c.age += dt;
      c.velocity.multiplyScalar(Math.max(0, 1 - 0.8 * dt));
      c.position.addScaledVector(c.velocity, dt);
      for (const s of (c.meshes ?? [])) {
        s.position.addScaledVector(c.velocity, dt * 0.6);
        s.material.opacity = Math.max(0, 0.85 * (1 - c.age / c.life)) * (0.6 + 0.4 * Math.sin(c.age * 22 + s.position.x));
      }
      if (c.age > c.life) c.alive = false;
    }
  }

  onEnemyKilled(e, by) {
    this.kills += 1;
    this.score += by === 'missile' ? 300 : 200;
    this.addMessage(`击落 ${e.spec.name}！+${by === 'missile' ? 300 : 200}`, HUD_COLOR.main);
    this.spawnExplosion(e.position, 1.6);
    // 目标索引修正
    if (this.targetIdx >= this.enemies.length) this.targetIdx = 0;
  }

  destroyPlayer(reason) {
    if (this.gameOver || !this.player) return;
    this.player.alive = false;
    this.deaths += 1;
    this.score = Math.max(0, this.score - 100);
    this.spawnExplosion(this.player.position, 2.0);
    this.addMessage(`机体损毁：${reason}`, HUD_COLOR.danger);
    this.gameOver = true;
  }

  updateAfterburnerVisual() {
    const sync = (a) => {
      const nozzles = a?.object3D?.userData?.nozzles;
      if (!Array.isArray(nozzles) || !nozzles.length) {
        // 兼容旧单喷口协议
        const nz = a?.object3D?.userData?.nozzle;
        if (nz) {
          const target = a.afterburner ? 1.9 : 0.5 + a.throttle * 0.5;
          nz.scale.set(1, damp(nz.scale.y ?? 1, target, 6, 1 / 60), 1);
          nz.visible = a.throttle > 0.05;
        }
        return;
      }
      const flick = 1 + Math.sin(this.time * 47) * 0.08 + Math.sin(this.time * 89) * 0.05;
      for (const nz of nozzles) {
        const th = a.throttle;
        const ab = a.afterburner ? 1 : 0;
        // 长度/半径：军推随油门，加力大幅延伸
        const lenK = (0.35 + th * 0.55 + ab * 0.9) * flick;
        const radK = 0.75 + th * 0.25 + ab * 0.35;
        nz.outer.scale.set(radK, lenK, radK);
        nz.core.scale.set(radK, Math.max(0.2, lenK * 0.6), radK);
        nz.diamond.position.z = 0.12 + lenK * nz.baseLen * 0.18;
        nz.diamond.material.opacity = ab ? 0.85 : th * 0.3;
        nz.glow.material.opacity = (0.25 + th * 0.35 + ab * 0.4) * flick;
        nz.glow.scale.setScalar(nz.baseR * (5 + th * 3 + ab * 5));
        nz.holder.visible = th > 0.04;
        nz.outer.material.opacity = 0.35 + th * 0.25 + ab * 0.3;
        nz.core.material.opacity = 0.5 + th * 0.35 + ab * 0.15;
      }
    };
    sync(this.player);
    for (const e of this.enemies) sync(e);
  }

  // ---------------- 特效 ----------------
  spawnHitSpark(pos, color = 0xffca7a) {
    const n = 6;
    const pts = [];
    for (let i = 0; i < n; i++) {
      pts.push(pos.clone().add(new THREE.Vector3(rand(6), rand(6), rand(6))));
    }
    this.explosions.push(new ExplosionEffect(pts.map(p => ({ p, color, size: 2.2, life: 0.3 })), this.scene, this.sparkTexture));
  }

  spawnMissileFlame(pos) {
    this.explosions.push(new ExplosionEffect([{ p: pos.clone(), color: 0xffc27a, size: 5, life: 0.25 }], this.scene, this.sparkTexture));
  }

  spawnExplosion(pos, scale = 1) {
    const parts = [];
    const n = Math.round(10 * scale);
    for (let i = 0; i < n; i++) {
      parts.push({
        p: pos.clone().add(new THREE.Vector3(rand(9 * scale), rand(9 * scale), rand(9 * scale))),
        color: i % 3 === 0 ? 0xff5a3a : (i % 3 === 1 ? 0xffb066 : 0x777777),
        size: (3 + Math.random() * 5) * scale,
        life: 0.6 + Math.random() * 0.7,
        vel: new THREE.Vector3(rand(28 * scale), rand(20 * scale) + 6, rand(28 * scale)),
      });
    }
    this.explosions.push(new ExplosionEffect(parts, this.scene, this.sparkTexture));
    this.chaseCam?.addShake(0.3 * scale);
  }
}

function rand(s) { return (Math.random() - 0.5) * 2 * s; }

// ---------------- 爆炸粒子效果 ----------------
export class ExplosionEffect {
  constructor(parts, scene, texture) {
    this.sprites = parts.map(pt => {
      const mat = new THREE.SpriteMaterial({
        map: texture, color: pt.color, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      s.position.copy(pt.p);
      s.scale.setScalar(pt.size);
      scene.add(s);
      return { s, vel: pt.vel ?? new THREE.Vector3(), life: pt.life, maxLife: pt.life };
    });
    this.scene = scene;
    this.alive = true;
  }
  update(dt) {
    for (const it of this.sprites) {
      it.life -= dt;
      it.s.position.addScaledVector(it.vel, dt);
      it.vel.multiplyScalar(1 - 1.6 * dt);
      it.s.material.opacity = Math.max(0, it.life / it.maxLife);
      it.s.scale.multiplyScalar(1 + 1.2 * dt);
      if (it.life <= 0) { this.scene.remove(it.s); it.s.material.dispose(); }
    }
    this.sprites = this.sprites.filter(i => i.life > 0);
    if (this.sprites.length === 0) this.alive = false;
  }

  kill() {
    for (const it of this.sprites) { this.scene.remove(it.s); it.s.material.dispose(); }
    this.sprites = [];
    this.alive = false;
  }
}

function makeSparkTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,220,160,0.9)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function makeFlareTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,240,1)');
  g.addColorStop(0.25, 'rgba(255,230,170,1)');
  g.addColorStop(0.6, 'rgba(255,160,60,0.55)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

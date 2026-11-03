import * as THREE from "three";

const REFERENCE_HEIGHT = 1.7; // the avatar is modelled at this height, then scaled

// A little character that walks on the scan's collision blocks: gravity, jumping,
// automatic step-up onto ledges, and a third-person camera that won't clip into walls.
// Scroll all the way in (or press V) for first person.
export class WalkControls {
  constructor(camera, domElement, scene) {
    this.camera = camera;
    this.dom = domElement;
    this.enabled = false;
    this.grid = null;

    this.height = 1.7;            // player height in scan units (meters for most phone scans)
    this.walkSpeed = 2.5;         // units per second
    this.runMultiplier = 2.2;     // while Shift is held
    this.jumpHeight = 0.9;
    this.gravity = 9.8;
    this.lookSensitivity = 0.0022;
    this.cameraDistance = 2.5;    // 0 = first person

    this.position = new THREE.Vector3();   // feet
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.yaw = 0;                 // camera look direction
    this.pitch = -0.25;
    this.facing = 0;              // which way the character's body points
    this.keys = new Set();
    this.jumpQueued = false;
    this.lastSafe = new THREE.Vector3();
    this.safeTimer = 0;
    this.walkPhase = 0;
    this.lastThirdPersonDistance = 2.5;

    this.avatar = createAvatar();
    this.avatar.visible = false;
    scene.add(this.avatar);

    this._euler = new THREE.Euler(0, 0, 0, "YXZ");
    this._wish = new THREE.Vector3();
    this._pivot = new THREE.Vector3();
    this._desired = new THREE.Vector3();

    window.addEventListener("keydown", (e) => this._onKey(e, true));
    window.addEventListener("keyup", (e) => this._onKey(e, false));
    window.addEventListener("blur", () => this.keys.clear());
    this.dom.addEventListener("click", () => {
      if (this.enabled && !this.isLocked) this.dom.requestPointerLock();
    });
    document.addEventListener("mousemove", (e) => this._onMouseMove(e));
    this.dom.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
  }

  get isLocked() {
    return document.pointerLockElement === this.dom;
  }

  get scale() {
    return this.height / REFERENCE_HEIGHT;
  }

  get halfWidth() {
    return 0.2 * this.scale;
  }

  get stepHeight() {
    return 0.35 * this.scale;
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  setEnabled(on) {
    this.enabled = on;
    this.avatar.visible = on && this.cameraDistance > 0;
    if (!on) {
      if (this.isLocked) document.exitPointerLock();
      this.keys.clear();
    }
  }

  // Drop the character at a standing spot near (x, z), as close to refY as possible.
  spawn(x, z, refY, lookYaw) {
    const spot = this.grid?.findSpawn(x, z, refY, this.height);
    if (!spot) return false;
    this.position.copy(spot);
    this._unstick();
    this.velocity.set(0, 0, 0);
    this.lastSafe.copy(this.position);
    if (lookYaw !== undefined) {
      this.yaw = lookYaw;
      this.facing = lookYaw;
    }
    this.pitch = -0.25;
    return true;
  }

  respawn() {
    this.position.copy(this.lastSafe);
    this._unstick();
    this.velocity.set(0, 0, 0);
  }

  toggleView() {
    if (this.cameraDistance > 0) {
      this.lastThirdPersonDistance = this.cameraDistance;
      this.cameraDistance = 0;
    } else {
      this.cameraDistance = this.lastThirdPersonDistance || 2.5 * this.scale;
    }
    this.avatar.visible = this.enabled && this.cameraDistance > 0;
  }

  update(dt) {
    if (!this.enabled || !this.grid) return;
    this.avatar.scale.setScalar(this.scale);

    // --- Intent: WASD relative to where the camera looks, flattened onto the ground.
    const k = this.keys;
    const forward = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const right = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this._wish.set(-sin * forward + cos * right, 0, -cos * forward - sin * right);
    if (this._wish.lengthSq() > 0) this._wish.normalize();
    const running = k.has("ShiftLeft") || k.has("ShiftRight");
    this._wish.multiplyScalar(this.walkSpeed * this.scale * (running ? this.runMultiplier : 1));

    // Snappy on the ground, floaty in the air.
    const response = this.onGround ? 0.08 : 0.5;
    const blend = 1 - Math.exp(-dt / response);
    this.velocity.x += (this._wish.x - this.velocity.x) * blend;
    this.velocity.z += (this._wish.z - this.velocity.z) * blend;

    if (this.jumpQueued && this.onGround) {
      this.velocity.y = Math.sqrt(2 * this.gravity * this.scale * this.jumpHeight * this.scale);
    }
    this.jumpQueued = false;
    this.velocity.y -= this.gravity * this.scale * dt;
    this.velocity.y = Math.max(this.velocity.y, -25 * this.scale);

    // --- Move in small sub-steps so fast falls can't tunnel through a thin floor.
    const wasOnGround = this.onGround;
    this.onGround = false;
    const move = this.velocity.clone().multiplyScalar(dt);
    const maxStep = this.grid.size * 0.45;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(move.x), Math.abs(move.y), Math.abs(move.z)) / maxStep));
    move.divideScalar(steps);
    for (let i = 0; i < steps; i++) {
      this._moveVertical(move.y);
      this._moveHorizontal("x", move.x, wasOnGround || this.onGround);
      this._moveHorizontal("z", move.z, wasOnGround || this.onGround);
    }

    // Stick to the ground when walking down stairs instead of hopping off each step.
    if (wasOnGround && !this.onGround && this.velocity.y <= 0) this._snapDown();

    // Remember recent solid ground; fall back to it if we drop out of the world.
    if (this.onGround) {
      this.safeTimer += dt;
      if (this.safeTimer > 0.5) {
        this.lastSafe.copy(this.position);
        this.safeTimer = 0;
      }
    }
    if (this.position.y < this.grid.min.y - this.height * 2) this.respawn();

    this._animate(dt);
    this._placeCamera();
  }

  // ---------- collision ----------

  _hits(x = this.position.x, y = this.position.y, z = this.position.z) {
    const w = this.halfWidth, eps = 1e-4;
    return this.grid.boxHitsSolid(x - w + eps, y + eps, z - w + eps, x + w - eps, y + this.height - eps, z + w - eps);
  }

  _moveVertical(dy) {
    if (dy === 0) return;
    this.position.y += dy;
    if (this._hits()) {
      this.position.y -= dy;
      if (dy < 0) this.onGround = true;
      this.velocity.y = 0;
    }
  }

  _moveHorizontal(axis, d, canStep) {
    if (d === 0) return;
    this.position[axis] += d;
    if (!this._hits()) return;

    // Blocked: try climbing a small ledge first.
    if (canStep) {
      for (let lift = this.grid.size; lift <= this.stepHeight + 1e-6; lift += this.grid.size) {
        if (!this._hits(this.position.x, this.position.y + lift, this.position.z)) {
          this.position.y += lift;
          this.onGround = true;
          return;
        }
      }
    }
    this.position[axis] -= d;
    this.velocity[axis] = 0;
  }

  _snapDown() {
    for (let drop = this.grid.size; drop <= this.stepHeight + 1e-6; drop += this.grid.size) {
      if (this._hits(this.position.x, this.position.y - drop, this.position.z)) {
        this.position.y -= drop - this.grid.size;
        this.onGround = true;
        return;
      }
    }
  }

  // If we start inside something, rise until free.
  _unstick() {
    for (let i = 0; i < 200 && this._hits(); i++) this.position.y += this.grid.size;
  }

  // ---------- presentation ----------

  _animate(dt) {
    const speed = this.speed;
    if (speed > 0.05 * this.scale) {
      const target = Math.atan2(-this.velocity.x, -this.velocity.z);
      let diff = target - this.facing;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.facing += diff * (1 - Math.exp(-dt / 0.08));
    }

    const stride = Math.min(1, speed / (this.walkSpeed * this.scale));
    this.walkPhase += dt * speed / this.scale * 4.2;
    const swing = this.onGround ? Math.sin(this.walkPhase) * 0.7 * stride : 0.5;
    const parts = this.avatar.userData;
    parts.legL.rotation.x = swing;
    parts.legR.rotation.x = this.onGround ? -swing : -0.3;
    parts.armL.rotation.x = -swing * 0.8;
    parts.armR.rotation.x = this.onGround ? swing * 0.8 : 2.4; // arm up when jumping
    parts.body.position.y = Math.abs(Math.cos(this.walkPhase)) * 0.04 * stride;

    this.avatar.position.copy(this.position);
    this.avatar.rotation.y = this.facing;
  }

  _placeCamera() {
    this._euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this._euler);

    if (this.cameraDistance <= 0) {
      this.camera.position.copy(this.position).y += this.height * 0.93;
      return;
    }
    // Orbit the character's head, pulled in if a wall is in the way.
    this._pivot.copy(this.position).y += this.height * 0.9;
    this._desired.set(0, 0, this.cameraDistance).applyQuaternion(this.camera.quaternion).add(this._pivot);
    const free = this.grid.freeDistance(this._pivot, this._desired);
    const dist = Math.max(0, Math.min(this.cameraDistance, free - this.grid.size));
    this.camera.position.copy(this._pivot)
      .addScaledVector(this._desired.sub(this._pivot).normalize(), dist);
    // Squeezed against a wall, the body would fill the screen; hide it.
    this.avatar.visible = dist > 0.7 * this.scale;
  }

  // ---------- input ----------

  _onKey(e, down) {
    if (e.target instanceof HTMLInputElement) return;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (!this.enabled) return;
    if (e.code === "Space") {
      e.preventDefault(); // don't "click" a focused settings button
      if (down && !e.repeat) this.jumpQueued = true;
    }
    if (e.code.startsWith("Alt")) e.preventDefault();
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.isLocked) return;
    this.yaw -= e.movementX * this.lookSensitivity;
    this.pitch -= e.movementY * this.lookSensitivity;
    const limit = Math.PI / 2 - 0.05;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -limit, limit);
  }

  _onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const zoomIn = e.deltaY < 0;
    if (this.cameraDistance <= 0) {
      if (!zoomIn) this.cameraDistance = 0.8 * this.scale;
    } else {
      this.cameraDistance *= zoomIn ? 1 / 1.15 : 1.15;
      if (this.cameraDistance < 0.6 * this.scale) this.cameraDistance = 0;
      this.cameraDistance = Math.min(this.cameraDistance, 10 * this.scale);
    }
    if (this.cameraDistance > 0) this.lastThirdPersonDistance = this.cameraDistance;
    this.avatar.visible = this.cameraDistance > 0;
  }
}

// A small blocky-but-friendly character, 1.7 units tall, facing -Z.
function createAvatar() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const shirt = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.6 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x2f4b7c, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xf2c9a0, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.4 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.38, 6, 16), shirt);
  torso.position.y = 1.1;
  body.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16), skin);
  head.position.y = 1.53;
  body.add(head);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 8), dark);
    eye.position.set(side * 0.06, 1.56, -0.15);
    body.add(eye);
  }

  // Limbs hang from a pivot so rotation.x swings them.
  const limb = (material, radius, length, x, y) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 12), material);
    mesh.position.y = -(length / 2 + radius);
    pivot.add(mesh);
    body.add(pivot);
    return pivot;
  };
  const legL = limb(pants, 0.08, 0.66, -0.1, 0.82);
  const legR = limb(pants, 0.08, 0.66, 0.1, 0.82);
  const armL = limb(shirt, 0.06, 0.4, -0.27, 1.32);
  const armR = limb(shirt, 0.06, 0.4, 0.27, 1.32);

  root.userData = { body, legL, legR, armL, armR };
  return root;
}

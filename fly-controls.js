import * as THREE from "three";

// First-person flying camera: pointer-lock mouse look plus WASD/QE movement.
// Velocity eases toward the target so starts and stops feel smooth instead of jerky.
export class FlyControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.enabled = false;

    this.speed = 1;                 // units per second at normal pace
    this.minSpeed = 0.001;
    this.maxSpeed = 1000;
    this.boost = 4;                 // multiplier while Shift is held
    this.slow = 0.25;               // multiplier while Alt is held
    this.lookSensitivity = 0.0022;  // radians per pixel of mouse movement
    this.smoothing = 0.12;          // seconds to reach ~63% of target velocity (0 = instant)
    this.onSpeedChange = null;

    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();

    this._euler = new THREE.Euler(0, 0, 0, "YXZ");
    this._move = new THREE.Vector3();

    window.addEventListener("keydown", (e) => this._onKey(e, true));
    window.addEventListener("keyup", (e) => this._onKey(e, false));
    window.addEventListener("blur", () => this.keys.clear());
    this.dom.addEventListener("click", () => {
      if (this.enabled && !this.isLocked) this.lock();
    });
    document.addEventListener("mousemove", (e) => this._onMouseMove(e));
    this.dom.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
  }

  get isLocked() {
    return document.pointerLockElement === this.dom;
  }

  lock() {
    this.dom.requestPointerLock();
  }

  unlock() {
    if (this.isLocked) document.exitPointerLock();
  }

  // Take over from wherever the camera currently points (e.g. after orbiting).
  syncFromCamera() {
    this._euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this._euler.y;
    this.pitch = this._euler.x;
    this.velocity.set(0, 0, 0);
  }

  setSpeed(speed) {
    this.speed = THREE.MathUtils.clamp(speed, this.minSpeed, this.maxSpeed);
    this.onSpeedChange?.(this.speed);
  }

  update(dt) {
    if (!this.enabled) return;

    this._euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this._euler);

    const k = this.keys;
    const right = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const up = (k.has("KeyE") ? 1 : 0) - (k.has("KeyQ") ? 1 : 0);
    const back = (k.has("KeyS") ? 1 : 0) - (k.has("KeyW") ? 1 : 0);

    // Forward/strafe follow the view direction; up/down is always world-vertical.
    this._move.set(right, 0, back).applyQuaternion(this.camera.quaternion);
    this._move.y += up;
    if (this._move.lengthSq() > 0) this._move.normalize();

    let pace = this.speed;
    if (k.has("ShiftLeft") || k.has("ShiftRight")) pace *= this.boost;
    else if (k.has("AltLeft") || k.has("AltRight")) pace *= this.slow;
    this._move.multiplyScalar(pace);

    const blend = this.smoothing > 0 ? 1 - Math.exp(-dt / this.smoothing) : 1;
    this.velocity.lerp(this._move, blend);
    this.camera.position.addScaledVector(this.velocity, dt);
  }

  _onKey(e, down) {
    if (e.target instanceof HTMLInputElement) return;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    // Stop Alt from focusing the browser menu while flying slowly.
    if (this.enabled && e.code.startsWith("Alt")) e.preventDefault();
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.isLocked) return;
    this.yaw -= e.movementX * this.lookSensitivity;
    this.pitch -= e.movementY * this.lookSensitivity;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -limit, limit);
  }

  _onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.setSpeed(this.speed * Math.pow(1.15, -Math.sign(e.deltaY)));
  }
}

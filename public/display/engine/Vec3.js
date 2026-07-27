// Vec3 — the sim's own mutable 3D vector, replacing THREE.Vector3 on the data
// path (TrackBuilder → Centerline → Game → AiDriver) so the engine has zero
// three.js coupling. The JS engine is the reference implementation the future
// native (C++) port will be conformance-tested against, so this class must be
// numerically BIT-IDENTICAL to THREE.Vector3 (r184, the test-only devDependency):
// every method body below copies three's arithmetic verbatim, preserving the
// exact operation order (float rounding differs if you reassociate). Only the
// method surface the sim actually uses is implemented — nothing speculative.
// Mutating methods return `this` for chaining, exactly like THREE.
import * as dmath from './math.js';

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  clone() {
    return new this.constructor(this.x, this.y, this.z);
  }

  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  multiplyScalar(scalar) {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    return this;
  }

  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  // THREE: divideScalar(this.length() || 1), where divideScalar multiplies by
  // the reciprocal (NOT three component divisions) — kept for bit-identity.
  normalize() {
    return this.multiplyScalar(1 / (this.length() || 1));
  }

  lerp(v, alpha) {
    this.x += (v.x - this.x) * alpha;
    this.y += (v.y - this.y) * alpha;
    this.z += (v.z - this.z) * alpha;
    return this;
  }

  // Mutating cross: this = this × v (THREE's cross(v) → crossVectors(this, v)).
  cross(v) {
    const ax = this.x, ay = this.y, az = this.z;
    const bx = v.x, by = v.y, bz = v.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  distanceTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Rotate about a UNIT axis by `angle` radians. THREE routes this through
  // Quaternion.setFromAxisAngle + applyQuaternion; that exact composition is
  // inlined here (NOT the Rodrigues formula — its float rounding differs).
  applyAxisAngle(axis, angle) {
    // Quaternion.setFromAxisAngle (assumes a normalized axis)
    const halfAngle = angle / 2, s = dmath.sin(halfAngle);
    const qx = axis.x * s, qy = axis.y * s, qz = axis.z * s;
    const qw = dmath.cos(halfAngle);
    // Vector3.applyQuaternion (quaternion assumed unit length)
    const vx = this.x, vy = this.y, vz = this.z;
    // t = 2 * cross( q.xyz, v );
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // v + q.w * t + cross( q.xyz, t );
    this.x = vx + qw * tx + qy * tz - qz * ty;
    this.y = vy + qw * ty + qz * tx - qx * tz;
    this.z = vz + qw * tz + qx * ty - qy * tx;
    return this;
  }
}

// Interop flag, same as THREE.Vector3's. Render-side three APIs that receive a
// centerline frame vector branch on it (e.g. Matrix4.setPosition in
// render/FinishGate.js reads .x/.y/.z only when isVector3 is truthy).
Vec3.prototype.isVector3 = true;

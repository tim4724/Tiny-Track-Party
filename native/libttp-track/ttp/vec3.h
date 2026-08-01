// Vec3 — a literal transliteration of THREE.Vector3 (r184), method body for
// method body. The operation ORDER is the contract, not the arithmetic: float
// rounding changes if you reassociate, so `normalize()` multiplies by a
// reciprocal rather than dividing componentwise, and no expression here may be
// "simplified". double only, no float temporaries (fp-profile §1).
// Transcendentals route through the vendored fdlibm (ttp_fd_sin/cos,
// fp-profile §2); sqrt stays std::sqrt (correctly rounded everywhere).
#pragma once

#include <cmath>

extern "C" {
double ttp_fd_sin(double);
double ttp_fd_cos(double);
}

namespace ttp {

struct Vec3 {
  double x, y, z;

  Vec3() : x(0), y(0), z(0) {}
  Vec3(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}

  Vec3 clone() const { return Vec3(x, y, z); }

  Vec3& copy(const Vec3& v) {
    x = v.x;
    y = v.y;
    z = v.z;
    return *this;
  }

  Vec3& sub(const Vec3& v) {
    x -= v.x;
    y -= v.y;
    z -= v.z;
    return *this;
  }

  Vec3& addScaledVector(const Vec3& v, double s) {
    x += v.x * s;
    y += v.y * s;
    z += v.z * s;
    return *this;
  }

  Vec3& multiplyScalar(double scalar) {
    x *= scalar;
    y *= scalar;
    z *= scalar;
    return *this;
  }

  double dot(const Vec3& v) const {
    return x * v.x + y * v.y + z * v.z;
  }

  double lengthSq() const {
    return x * x + y * y + z * z;
  }

  double length() const {
    return std::sqrt(x * x + y * y + z * z);
  }

  // THREE: divideScalar(this.length() || 1), where divideScalar multiplies by
  // the reciprocal (NOT componentwise division) — kept for bit-identity. The
  // `|| 1` is falsy on 0 (and -0); length() is >= 0 so only +0 reaches it.
  Vec3& normalize() {
    double l = length();
    return multiplyScalar(1.0 / (l != 0.0 ? l : 1.0));
  }

  Vec3& lerp(const Vec3& v, double alpha) {
    x += (v.x - x) * alpha;
    y += (v.y - y) * alpha;
    z += (v.z - z) * alpha;
    return *this;
  }

  // Mutating cross: this = this × v.
  Vec3& cross(const Vec3& v) {
    double ax = x, ay = y, az = z;
    double bx = v.x, by = v.y, bz = v.z;
    x = ay * bz - az * by;
    y = az * bx - ax * bz;
    z = ax * by - ay * bx;
    return *this;
  }

  double distanceTo(const Vec3& v) const {
    double dx = x - v.x, dy = y - v.y, dz = z - v.z;
    return std::sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Rotate about a UNIT axis by `angle` radians, via the inlined
  // Quaternion.setFromAxisAngle + Vector3.applyQuaternion composition (NOT
  // Rodrigues — its float rounding differs). Vec3.js:96 → dmath.sin/cos.
  Vec3& applyAxisAngle(const Vec3& axis, double angle) {
    // Quaternion.setFromAxisAngle (assumes a normalized axis)
    double halfAngle = angle / 2, s = ttp_fd_sin(halfAngle);
    double qx = axis.x * s, qy = axis.y * s, qz = axis.z * s;
    double qw = ttp_fd_cos(halfAngle);
    // Vector3.applyQuaternion (quaternion assumed unit length)
    double vx = x, vy = y, vz = z;
    // t = 2 * cross( q.xyz, v );
    double tx = 2 * (qy * vz - qz * vy);
    double ty = 2 * (qz * vx - qx * vz);
    double tz = 2 * (qx * vy - qy * vx);
    // v + q.w * t + cross( q.xyz, t );
    x = vx + qw * tx + qy * tz - qz * ty;
    y = vy + qw * ty + qz * tx - qx * tz;
    z = vz + qw * tz + qx * ty - qy * tx;
    return *this;
  }
};

}  // namespace ttp

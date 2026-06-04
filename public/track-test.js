// M1 verification harness: build the oval, render it, and auto-drive a car
// around the centerline ribbon to prove the track is drivable.
import { SceneRenderer } from '/display/SceneRenderer.js';
import { buildTrack, OVAL } from '/display/TrackBuilder.js';

const { CAR_COLORS } = window;
const hud = document.getElementById('hud');

const m1 = { loaded: false, closed: null, gap: null, length: null, instances: null, s: 0, carPos: null, error: null };
window.__m1 = m1;

(async () => {
  try {
    const track = buildTrack(OVAL);
    m1.closed = track.closed; m1.gap = +track.gap.toFixed(3); m1.length = +track.length.toFixed(2);
    m1.instances = track.instances.length;

    const scene = new SceneRenderer(document.getElementById('scene'), CAR_COLORS);
    await scene.load();
    m1.loaded = true;
    scene.setTrack(track, { debug: true });

    window.__scene = scene;
    // Auto-drive two demo cars at different speeds + lateral offsets.
    scene.addCar('a', 0);
    scene.addCar('b', 2);
    let s = 0;
    scene.onFrame = (dt) => {
      s += 9 * dt; // m/s along the ribbon
      const fa = track.centerline.sampleAt(s);
      const fb = track.centerline.sampleAt(s * 0.85 + 6);
      const pa = fa.pos.clone().addScaledVector(fa.lateral, -0.25);
      const pb = fb.pos.clone().addScaledVector(fb.lateral, 0.25);
      const la = track.centerline.sampleAt(s + 8).pos;
      const lb = track.centerline.sampleAt(s * 0.85 + 14).pos;
      // demo steer ~ upcoming curvature so the lean + front wheels are visible
      const curv = (sAt) => { const t1 = track.centerline.sampleAt(sAt).tangent, t2 = track.centerline.sampleAt(sAt + 4).tangent; return Math.atan2(t1.clone().cross(t2).y, t1.dot(t2)) * 6; };
      const sa = Math.max(-1, Math.min(1, curv(s)));
      const sb = Math.max(-1, Math.min(1, curv(s * 0.85 + 6)));
      scene.setCarPose('a', pa, fa.tangent, fa.up, fa.tangent, la, sa, 0.7, false);
      scene.setCarPose('b', pb, fb.tangent, fb.up, fb.tangent, lb, sb, 0.9, false);
      m1.s = +s.toFixed(1);
      m1.carPos = [+pa.x.toFixed(2), +pa.y.toFixed(2), +pa.z.toFixed(2)];
      hud.textContent = `closed=${track.closed} gap=${m1.gap} len=${m1.length} pieces=${m1.instances}  car=[${m1.carPos}]`;
    };
    scene.start();
  } catch (e) {
    m1.error = String(e && e.stack || e);
    hud.textContent = m1.error;
    console.error(e);
  }
})();

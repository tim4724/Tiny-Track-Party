// Track-independent world dressing: sky dome, drifting clouds, horizon hills,
// the toy lighting rig and the lawn ground plane. Built once per renderer;
// returns the pieces the frame loop / per-track fitting need to touch.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeCloudTexture, makeLawnTexture } from './textures.js';

const DEF_KEY_LIGHT = 1.4;   // warm key-light intensity (the plastic "shine")

export function buildEnvironment(scene) {
  let horizonHills = null; // returned so setTrack can push the ring out past a large track
  // Sky dome: a vertex-coloured backdrop — deeper blue overhead easing to a
  // pale warm band at the horizon (the same hue the fog uses, so distant
  // geometry dissolves into the sky instead of hitting a flat backdrop).
  // fog:false (the dome IS the backdrop) and depthWrite:false + renderOrder
  // -1 so it always paints first and everything draws over it.
  {
    const R = 420;
    const skyGeo = new THREE.SphereGeometry(R, 24, 12);
    const sp = skyGeo.attributes.position;
    const skyCol = new Float32Array(sp.count * 3);
    const top = new THREE.Color(0x59a7e8).convertSRGBToLinear(); // zenith
    const hor = new THREE.Color(0x8ecae6).convertSRGBToLinear(); // horizon = fog colour
    const low = new THREE.Color(0xc8e9f2).convertSRGBToLinear(); // below-horizon haze
    const c = new THREE.Color();
    for (let i = 0; i < sp.count; i++) {
      const t = sp.getY(i) / R; // -1 (nadir) .. 1 (zenith)
      if (t >= 0) c.copy(hor).lerp(top, Math.pow(t, 0.65));
      else c.copy(hor).lerp(low, Math.min(1, -t * 3));
      skyCol[i * 3] = c.r; skyCol[i * 3 + 1] = c.g; skyCol[i * 3 + 2] = c.b;
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(skyCol, 3));
    const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false
    }));
    sky.renderOrder = -1;
    scene.add(sky);
  }

  // Clouds: a handful of soft sprite puffs drifting slowly. Sprites billboard
  // per camera, so they read correctly in every split-screen cell; fog:false
  // because they live past the fog's far end. Drift is stepped in _loop.
  const clouds = [];
  {
    const cloudTex = makeCloudTexture();
    for (let i = 0; i < 8; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.8, fog: false, depthWrite: false
      }));
      const a = (i / 8) * Math.PI * 2 + (i % 3) * 0.45;
      const r = 180 + (i % 4) * 38;
      sprite.position.set(Math.cos(a) * r, 42 + (i % 3) * 16, Math.sin(a) * r);
      const w = 50 + (i % 3) * 20;
      sprite.scale.set(w, w * 0.42, 1);
      clouds.push(sprite);
      scene.add(sprite);
    }
  }

  // Horizon hills: one merged ring of squashed toy domes, far outside any
  // track and deep in the fog tail, so they render as soft pale silhouettes —
  // depth for the diorama without competing with it. Built once; never
  // disposed (they're track-independent, like the ground plane).
  {
    const hillProto = new THREE.SphereGeometry(1, 10, 6);
    hillProto.deleteAttribute('uv');
    const geoms = [];
    const hc = new THREE.Color();
    for (let i = 0; i < 18; i++) {
      const g = hillProto.clone();
      g.scale(26 + (i % 4) * 9, 7 + (i % 3) * 4, 22 + ((i + 1) % 4) * 8);
      const a = (i / 18) * Math.PI * 2 + (i % 5) * 0.13;
      const r = 150 + (i % 3) * 18;
      g.translate(Math.cos(a) * r, -1.0, Math.sin(a) * r); // base sunk to the grass plane
      // pastel greens — distance haze should make them recede, not loom
      hc.set([0x8cc578, 0x7cb86a, 0x9bce86][i % 3]).convertSRGBToLinear();
      const n = g.attributes.position.count;
      const colA = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { colA[k * 3] = hc.r; colA[k * 3 + 1] = hc.g; colA[k * 3 + 2] = hc.b; }
      g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
      geoms.push(g);
    }
    hillProto.dispose();
    const hills = new THREE.Mesh(
      mergeGeometries(geoms, false),
      new THREE.MeshStandardMaterial({ vertexColors: true })
    );
    for (const g of geoms) g.dispose(); // copied into the merge
    scene.add(hills);
    horizonHills = hills;
  }

  // Toy lighting: a soft sky/ground hemisphere for even fill, PLUS a warm key light
  // that also casts the "Sunny Circuit" shadow. The key's specular highlight is the
  // "shiny plastic" dot that sells the injection-moulded-toy read; the hemisphere
  // keeps shadowed sides from going black.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa68f, 2.2));
  const key = new THREE.DirectionalLight(0xfff1d0, DEF_KEY_LIGHT);
  key.position.set(6, 12, 4); // high and slightly to one side → raking gloss + sun shadow
  // Shadow camera bounds/placement are set per-track in setTrack (needs the track
  // extent); _loop refreshes the map once per frame (see renderer.shadowMap.autoUpdate
  // above). 4096² keeps the per-texel size small even on the biggest track's fitted
  // frustum (~0.03 world units/texel), so the cast shadow's edge stays crisp instead
  // of shimmering as the car moves — coarse texels were the source of the flicker.
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.05; // curved road → bias along the normal kills acne
  scene.add(key);
  scene.add(key.target);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    // Lawn texture (mowing stripes) instead of a flat colour — the colour
    // lives in the texture, so the material tint stays white.
    new THREE.MeshStandardMaterial({ map: makeLawnTexture() })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.0;
  // The grass does NOT receive shadows. Cars only ever drive on road tiles (which
  // do receive), so on-track shadows are unaffected — but an ELEVATED car on an
  // overpass would otherwise cast a detached blob onto the grass far below the
  // narrow deck (the light is raked, so the shadow lands off the deck edge). With
  // the grass opted out, that car's shadow stays on the deck under it; only the
  // part that would spill past the deck onto grass is clipped (invisible anyway).
  ground.receiveShadow = false;
  scene.add(ground);

  return { clouds, key, ground, hills: horizonHills };
}

'use strict';

// Connector PROFILE for a track GLB: the road surface height y(z) sampled along
// the centreline (x≈0), plus the surface SLOPE (pitch) at the entry (-Z) and
// exit (+Z) connectors. inspect-piece.js gives connector positions; this gives
// the pitch ANGLE at each end so elevation pieces (hills/ramps/bumps) get
// correct 3D connector frames (entry/exit `up` vectors) and mate seamlessly.
// Usage: node profile-piece.js <glb-path>

const { loadVerts } = require('./glb');

const file=process.argv[2];
const verts=loadVerts(file);

const r3=n=>Math.round(n*1000)/1000;
// Top-surface height profile: for thin Z-slices near the centreline (|x|<0.3),
// take the MAX y (road top) in each slice. Gives y(z) for the drivable surface.
// reduce(), not Math.min(...big) — a high-poly GLB has enough verts to blow the
// call stack when spread as arguments.
const zmin=verts.reduce((a,v)=>Math.min(a,v[2]),Infinity), zmax=verts.reduce((a,v)=>Math.max(a,v[2]),-Infinity);
const N=22, prof=[];
for(let i=0;i<=N;i++){
  const z=zmin+(zmax-zmin)*i/N;
  // Road TOP across the full width (no x filter — low-poly meshes have few verts
  // near the centreline). Per z-bin, the max y is the drivable surface.
  const slab=verts.filter(v=>Math.abs(v[2]-z) <= (zmax-zmin)/N*0.6);
  if(!slab.length){prof.push([z,null]);continue;}
  prof.push([z, slab.reduce((a,v)=>Math.max(a,v[1]),-Infinity)]);
}
console.log('FILE:',file.split('/').pop());
console.log('z range', r3(zmin), '..', r3(zmax));
console.log('surface y(z) along centreline:');
console.log(prof.map(p=>`  z=${r3(p[0])}  y=${p[1]==null?'-':r3(p[1])}`).join('\n'));
// Pitch at each end from the first/last two valid samples.
const valid=prof.filter(p=>p[1]!=null);
function slope(a,b){const dz=b[0]-a[0];return dz?Math.atan2(b[1]-a[1],dz):0;}
if(valid.length>=3){
  const inS=slope(valid[0],valid[1]);
  const outS=slope(valid[valid.length-2],valid[valid.length-1]);
  console.log(`entry pitch ~ ${r3(inS)} rad (${r3(inS*180/Math.PI)} deg)`);
  console.log(`exit  pitch ~ ${r3(outS)} rad (${r3(outS*180/Math.PI)} deg)`);
}

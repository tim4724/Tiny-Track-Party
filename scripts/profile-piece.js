'use strict';

// Connector PROFILE for a track GLB: the road surface height y(z) sampled along
// the centreline (x≈0), plus the surface SLOPE (pitch) at the entry (-Z) and
// exit (+Z) connectors. inspect-piece.js gives connector positions; this gives
// the pitch ANGLE at each end so elevation pieces (hills/ramps/bumps) get
// correct 3D connector frames (entry/exit `up` vectors) and mate seamlessly.
// Usage: node profile-piece.js <glb-path>

const fs = require('fs');

function identity() { return [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]; }
function multiply(a,b){const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];}return o;}
function fromTRS(t,q,s){t=t||[0,0,0];q=q||[0,0,0,1];s=s||[1,1,1];const[x,y,z,w]=q;const x2=x+x,y2=y+y,z2=z+z;const xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;const[sx,sy,sz]=s;return[(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0,(xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,(xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0,t[0],t[1],t[2],1];}

function parseGLB(buf){let off=12,json=null,bin=null;while(off<buf.length){const len=buf.readUInt32LE(off);const type=buf.readUInt32LE(off+4);const data=buf.slice(off+8,off+8+len);if(type===0x4e4f534a)json=JSON.parse(data.toString('utf8'));else if(type===0x004e4942)bin=data;off+=8+len;}return {json,bin};}
const COMP={5126:Float32Array,5123:Uint16Array,5125:Uint32Array,5121:Uint8Array};
const NUM={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
function readAccessor(gltf,bin,idx){const acc=gltf.accessors[idx];const bv=gltf.bufferViews[acc.bufferView];const Ctor=COMP[acc.componentType];const n=NUM[acc.type];const byteOffset=(bv.byteOffset||0)+(acc.byteOffset||0);return new Ctor(bin.buffer,bin.byteOffset+byteOffset,acc.count*n);}

const file=process.argv[2];
const {json,bin}=parseGLB(fs.readFileSync(file));
const nodes=json.nodes||[],meshes=json.meshes||[];
const verts=[];
function visit(idx,parent){const node=nodes[idx];const world=multiply(parent,node.matrix?node.matrix.slice():fromTRS(node.translation,node.rotation,node.scale));if(node.mesh!=null){for(const prim of meshes[node.mesh].primitives){const pos=readAccessor(json,bin,prim.attributes.POSITION);for(let i=0;i<pos.length;i+=3){verts.push([pos[i],pos[i+1],pos[i+2]].map((_,k)=>{const x=pos[i],y=pos[i+1],z=pos[i+2];return [world[0]*x+world[4]*y+world[8]*z+world[12],world[1]*x+world[5]*y+world[9]*z+world[13],world[2]*x+world[6]*y+world[10]*z+world[14]][k];}));}}}for(const c of node.children||[])visit(c,world);}
for(const r of json.scenes[json.scene||0].nodes)visit(r,identity());

const r3=n=>Math.round(n*1000)/1000;
// Top-surface height profile: for thin Z-slices near the centreline (|x|<0.3),
// take the MAX y (road top) in each slice. Gives y(z) for the drivable surface.
const zmin=Math.min(...verts.map(v=>v[2])), zmax=Math.max(...verts.map(v=>v[2]));
const N=22, prof=[];
for(let i=0;i<=N;i++){
  const z=zmin+(zmax-zmin)*i/N;
  // Road TOP across the full width (no x filter — low-poly meshes have few verts
  // near the centreline). Per z-bin, the max y is the drivable surface.
  const slab=verts.filter(v=>Math.abs(v[2]-z) <= (zmax-zmin)/N*0.6);
  if(!slab.length){prof.push([z,null]);continue;}
  prof.push([z, Math.max(...slab.map(v=>v[1]))]);
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

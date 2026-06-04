'use strict';

// Decode POSITION vertices of a GLB and locate connector cross-sections by
// clustering vertices onto each bounding-box face. For a track piece, a face
// that carries the drivable road shows up as a dense vertex cluster; its
// centroid is the connector position and the face axis is the connector
// direction. Used to verify Kenney pieces chain into a clean centerline.
// Usage: node inspect-piece.js <glb-path>

const fs = require('fs');

function identity() { return [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]; }
function multiply(a,b){const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];}return o;}
function fromTRS(t,q,s){t=t||[0,0,0];q=q||[0,0,0,1];s=s||[1,1,1];const[x,y,z,w]=q;const x2=x+x,y2=y+y,z2=z+z;const xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;const[sx,sy,sz]=s;return[(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0,(xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,(xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0,t[0],t[1],t[2],1];}
function tp(m,p){const[x,y,z]=p;return[m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]];}

function parseGLB(buf){
  let off=12,json=null,bin=null;
  while(off<buf.length){const len=buf.readUInt32LE(off);const type=buf.readUInt32LE(off+4);const data=buf.slice(off+8,off+8+len);if(type===0x4e4f534a)json=JSON.parse(data.toString('utf8'));else if(type===0x004e4942)bin=data;off+=8+len;}
  return {json,bin};
}

const COMP={5126:Float32Array,5123:Uint16Array,5125:Uint32Array,5121:Uint8Array};
const NUM={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
function readAccessor(gltf,bin,idx){
  const acc=gltf.accessors[idx];const bv=gltf.bufferViews[acc.bufferView];
  const Ctor=COMP[acc.componentType];const n=NUM[acc.type];
  const byteOffset=(bv.byteOffset||0)+(acc.byteOffset||0);
  return new Ctor(bin.buffer,bin.byteOffset+byteOffset,acc.count*n);
}

const file=process.argv[2];
const {json,bin}=parseGLB(fs.readFileSync(file));
const nodes=json.nodes||[],meshes=json.meshes||[];
const verts=[];
function visit(idx,parent){
  const node=nodes[idx];const world=multiply(parent,node.matrix?node.matrix.slice():fromTRS(node.translation,node.rotation,node.scale));
  if(node.mesh!=null){for(const prim of meshes[node.mesh].primitives){const pos=readAccessor(json,bin,prim.attributes.POSITION);for(let i=0;i<pos.length;i+=3){verts.push(tp(world,[pos[i],pos[i+1],pos[i+2]]));}}}
  for(const c of node.children||[])visit(c,world);
}
for(const r of json.scenes[json.scene||0].nodes)visit(r,identity());

const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
for(const v of verts)for(let k=0;k<3;k++){if(v[k]<min[k])min[k]=v[k];if(v[k]>max[k])max[k]=v[k];}
const r3=n=>Math.round(n*1000)/1000;
console.log('FILE:',file.split('/').pop());
console.log('verts:',verts.length,' bbox min',min.map(r3),'max',max.map(r3));
console.log('size:',[max[0]-min[0],max[1]-min[1],max[2]-min[2]].map(r3));
console.log('');

const AX=['X','Y','Z'];const eps=0.06;
for(let axis=0;axis<3;axis++){
  for(const dir of [0,1]){
    const plane=dir?max[axis]:min[axis];
    const cluster=verts.filter(v=>Math.abs(v[axis]-plane)<eps);
    if(cluster.length<6) continue;
    const c=[0,0,0];for(const v of cluster)for(let k=0;k<3;k++)c[k]+=v[k];for(let k=0;k<3;k++)c[k]/=cluster.length;
    // cross-section extent on the other two axes
    const o1=(axis+1)%3,o2=(axis+2)%3;
    let lo1=Infinity,hi1=-Infinity,lo2=Infinity,hi2=-Infinity;
    for(const v of cluster){if(v[o1]<lo1)lo1=v[o1];if(v[o1]>hi1)hi1=v[o1];if(v[o2]<lo2)lo2=v[o2];if(v[o2]>hi2)hi2=v[o2];}
    console.log(`face ${dir?'+':'-'}${AX[axis]} @ ${r3(plane)}:  verts=${cluster.length}  centroid=[${c.map(r3)}]  ${AX[o1]}span=${r3(hi1-lo1)}  ${AX[o2]}span=${r3(hi2-lo2)}`);
  }
}

'use strict';
// Vertical profile of a track piece: bucket vertices by height (Y) and show the
// X/Z spread at each level. Reveals the real DRIVING SURFACE (wide X-span across
// the full road) vs raised CURBS (narrow X-span at the road edges) vs the base.
// Usage: node profile.js <glb>
const fs = require('fs');
function identity(){return [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];}
function multiply(a,b){const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];}return o;}
function fromTRS(t,q,s){t=t||[0,0,0];q=q||[0,0,0,1];s=s||[1,1,1];const[x,y,z,w]=q;const x2=x+x,y2=y+y,z2=z+z;const xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;const[sx,sy,sz]=s;return[(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0,(xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,(xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0,t[0],t[1],t[2],1];}
function tp(m,p){const[x,y,z]=p;return[m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]];}
function parseGLB(buf){let off=12,json=null,bin=null;while(off<buf.length){const len=buf.readUInt32LE(off);const type=buf.readUInt32LE(off+4);const data=buf.slice(off+8,off+8+len);if(type===0x4e4f534a)json=JSON.parse(data.toString('utf8'));else if(type===0x004e4942)bin=data;off+=8+len;}return{json,bin};}
const COMP={5126:Float32Array,5123:Uint16Array,5125:Uint32Array,5121:Uint8Array};const NUM={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
function readAccessor(g,bin,idx){const a=g.accessors[idx];const bv=g.bufferViews[a.bufferView];const C=COMP[a.componentType];const n=NUM[a.type];const bo=(bv.byteOffset||0)+(a.byteOffset||0);return new C(bin.buffer,bin.byteOffset+bo,a.count*n);}

const {json,bin}=parseGLB(fs.readFileSync(process.argv[2]));
const nodes=json.nodes||[],meshes=json.meshes||[];const verts=[];
for(const root of json.scenes[json.scene||0].nodes)(function visit(idx,parent){const node=nodes[idx];const w=multiply(parent,node.matrix?node.matrix.slice():fromTRS(node.translation,node.rotation,node.scale));if(node.mesh!=null){for(const prim of meshes[node.mesh].primitives){const pos=readAccessor(json,bin,prim.attributes.POSITION);for(let i=0;i<pos.length;i+=3)verts.push(tp(w,[pos[i],pos[i+1],pos[i+2]]));}}for(const c of node.children||[])visit(c,w);})(root,identity());

const r3=n=>Math.round(n*1000)/1000;
const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
for(const v of verts)for(let k=0;k<3;k++){if(v[k]<min[k])min[k]=v[k];if(v[k]>max[k])max[k]=v[k];}
console.log(process.argv[2].split('/').pop(),'  bbox', min.map(r3),'→',max.map(r3),' size',[max[0]-min[0],max[1]-min[1],max[2]-min[2]].map(r3));
console.log('  Y level   n     Xspan            Zspan');
const buckets={};
for(const v of verts){const b=Math.round(v[1]*20)/20;(buckets[b]=buckets[b]||[]).push(v);}
for(const y of Object.keys(buckets).map(Number).sort((a,b)=>a-b)){
  const vs=buckets[y];let xl=Infinity,xh=-Infinity,zl=Infinity,zh=-Infinity;
  for(const v of vs){if(v[0]<xl)xl=v[0];if(v[0]>xh)xh=v[0];if(v[2]<zl)zl=v[2];if(v[2]>zh)zh=v[2];}
  console.log(`  ${String(r3(y)).padStart(6)}  ${String(vs.length).padStart(4)}   [${r3(xl)}, ${r3(xh)}] w=${r3(xh-xl)}   [${r3(zl)}, ${r3(zh)}]`);
}

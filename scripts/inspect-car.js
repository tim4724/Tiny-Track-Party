'use strict';
// Dump a vehicle GLB's node tree (names + per-node mesh bbox in world space) to
// see whether wheels are separate nodes, and find the true ground contact (minY).
const fs = require('fs');
function identity(){return [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];}
function multiply(a,b){const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];}return o;}
function fromTRS(t,q,s){t=t||[0,0,0];q=q||[0,0,0,1];s=s||[1,1,1];const[x,y,z,w]=q;const x2=x+x,y2=y+y,z2=z+z;const xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;const[sx,sy,sz]=s;return[(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0,(xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,(xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0,t[0],t[1],t[2],1];}
function tp(m,p){const[x,y,z]=p;return[m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]];}
function parseGLB(buf){let off=12,json=null,bin=null;while(off<buf.length){const len=buf.readUInt32LE(off);const type=buf.readUInt32LE(off+4);const data=buf.slice(off+8,off+8+len);if(type===0x4e4f534a)json=JSON.parse(data.toString('utf8'));else if(type===0x004e4942)bin=data;off+=8+len;}return{json,bin};}
const COMP={5126:Float32Array,5123:Uint16Array,5125:Uint32Array,5121:Uint8Array};const NUM={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
function readAcc(g,bin,idx){const a=g.accessors[idx];const bv=g.bufferViews[a.bufferView];const C=COMP[a.componentType];const n=NUM[a.type];const bo=(bv.byteOffset||0)+(a.byteOffset||0);return new C(bin.buffer,bin.byteOffset+bo,a.count*n);}

const {json,bin}=parseGLB(fs.readFileSync(process.argv[2]));
const nodes=json.nodes||[],meshes=json.meshes||[];
const r3=n=>Math.round(n*1000)/1000;
let globalMinY=Infinity;
function visit(idx,parent,depth){
  const node=nodes[idx];
  const world=multiply(parent,node.matrix?node.matrix.slice():fromTRS(node.translation,node.rotation,node.scale));
  let info='';
  if(node.mesh!=null){
    const mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
    for(const prim of meshes[node.mesh].primitives){const pos=readAcc(json,bin,prim.attributes.POSITION);for(let i=0;i<pos.length;i+=3){const w=tp(world,[pos[i],pos[i+1],pos[i+2]]);for(let k=0;k<3;k++){if(w[k]<mn[k])mn[k]=w[k];if(w[k]>mx[k])mx[k]=w[k];}}}
    globalMinY=Math.min(globalMinY,mn[1]);
    info=`  mesh[${node.mesh}] bbox y[${r3(mn[1])},${r3(mx[1])}] x[${r3(mn[0])},${r3(mx[0])}] z[${r3(mn[2])},${r3(mx[2])}]`;
  }
  console.log('  '.repeat(depth)+(node.name||('node'+idx))+info);
  for(const c of node.children||[])visit(c,world,depth+1);
}
console.log('FILE',process.argv[2].split('/').pop());
for(const r of json.scenes[json.scene||0].nodes)visit(r,identity(),0);
console.log('GLOBAL minY =',r3(globalMinY),'(should be ~0 to sit on the road)');

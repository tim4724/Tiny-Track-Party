'use strict';
// Targeted probe of the looping piece: where does its road meet the neighbours?
// Decodes POSITION verts and (a) histograms Y at each Z-extreme, (b) shows where
// the road sits at ground height, to decide how the loop chains inline.
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
(function visit(idx,parent){const node=nodes[idx];const w=multiply(parent,node.matrix?node.matrix.slice():fromTRS(node.translation,node.rotation,node.scale));if(node.mesh!=null){for(const prim of meshes[node.mesh].primitives){const pos=readAccessor(json,bin,prim.attributes.POSITION);for(let i=0;i<pos.length;i+=3)verts.push(tp(w,[pos[i],pos[i+1],pos[i+2]]));}}for(const c of node.children||[])visit(c,w);})(json.scenes[json.scene||0].nodes[0],identity());
for(const r of (json.scenes[json.scene||0].nodes.slice(1))) (function visit(idx,parent){const node=nodes[idx];const w=multiply(parent,node.matrix?node.matrix.slice():fromTRS(node.translation,node.rotation,node.scale));if(node.mesh!=null){for(const prim of meshes[node.mesh].primitives){const pos=readAccessor(json,bin,prim.attributes.POSITION);for(let i=0;i<pos.length;i+=3)verts.push(tp(w,[pos[i],pos[i+1],pos[i+2]]));}}for(const c of node.children||[])visit(c,w);})(r,identity());

const r3=n=>Math.round(n*1000)/1000;
const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
for(const v of verts)for(let k=0;k<3;k++){if(v[k]<min[k])min[k]=v[k];if(v[k]>max[k])max[k]=v[k];}
console.log('verts',verts.length,'bbox min',min.map(r3),'max',max.map(r3));

function faceProbe(label, zPlane){
  const cl=verts.filter(v=>Math.abs(v[2]-zPlane)<0.08);
  console.log(`\n[${label}] Z≈${zPlane}: ${cl.length} verts`);
  // Y histogram
  const buckets={};
  for(const v of cl){const b=Math.round(v[1]*4)/4;buckets[b]=(buckets[b]||0)+1;}
  const ys=Object.keys(buckets).map(Number).sort((a,b)=>a-b);
  for(const y of ys){
    const at=cl.filter(v=>Math.round(v[1]*4)/4===y);
    let xlo=Infinity,xhi=-Infinity;for(const v of at){if(v[0]<xlo)xlo=v[0];if(v[0]>xhi)xhi=v[0];}
    console.log(`   Y=${y.toString().padStart(6)}  n=${String(buckets[y]).padStart(3)}  Xrange=[${r3(xlo)}, ${r3(xhi)}]`);
  }
}
faceProbe('entry end', min[2]);
faceProbe('exit end', max[2]);

// Where does the road touch ground (Y near min)?
const groundY=min[1];
const ground=verts.filter(v=>Math.abs(v[1]-groundY)<0.08);
let zlo=Infinity,zhi=-Infinity,xlo=Infinity,xhi=-Infinity;
for(const v of ground){if(v[2]<zlo)zlo=v[2];if(v[2]>zhi)zhi=v[2];if(v[0]<xlo)xlo=v[0];if(v[0]>xhi)xhi=v[0];}
console.log(`\n[ground Y≈${r3(groundY)}] ${ground.length} verts  Zrange=[${r3(zlo)}, ${r3(zhi)}]  Xrange=[${r3(xlo)}, ${r3(xhi)}]`);

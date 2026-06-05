'use strict';

// Decode POSITION vertices of a GLB and locate connector cross-sections by
// clustering vertices onto each bounding-box face. For a track piece, a face
// that carries the drivable road shows up as a dense vertex cluster; its
// centroid is the connector position and the face axis is the connector
// direction. Used to verify Kenney pieces chain into a clean centerline.
// Usage: node inspect-piece.js <glb-path>

const { loadVerts } = require('./glb');

const file=process.argv[2];
const verts=loadVerts(file);

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

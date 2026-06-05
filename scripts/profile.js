'use strict';
// Vertical profile of a track piece: bucket vertices by height (Y) and show the
// X/Z spread at each level. Reveals the real DRIVING SURFACE (wide X-span across
// the full road) vs raised CURBS (narrow X-span at the road edges) vs the base.
// Usage: node profile.js <glb>
const { loadVerts } = require('./glb');

const file = process.argv[2];
const verts = loadVerts(file);

const r3=n=>Math.round(n*1000)/1000;
const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
for(const v of verts)for(let k=0;k<3;k++){if(v[k]<min[k])min[k]=v[k];if(v[k]>max[k])max[k]=v[k];}
console.log(file.split('/').pop(),'  bbox', min.map(r3),'→',max.map(r3),' size',[max[0]-min[0],max[1]-min[1],max[2]-min[2]].map(r3));
console.log('  Y level   n     Xspan            Zspan');
const buckets={};
for(const v of verts){const b=Math.round(v[1]*20)/20;(buckets[b]=buckets[b]||[]).push(v);}
for(const y of Object.keys(buckets).map(Number).sort((a,b)=>a-b)){
  const vs=buckets[y];let xl=Infinity,xh=-Infinity,zl=Infinity,zh=-Infinity;
  for(const v of vs){if(v[0]<xl)xl=v[0];if(v[0]>xh)xh=v[0];if(v[2]<zl)zl=v[2];if(v[2]>zh)zh=v[2];}
  console.log(`  ${String(r3(y)).padStart(6)}  ${String(vs.length).padStart(4)}   [${r3(xl)}, ${r3(xh)}] w=${r3(xh-xl)}   [${r3(zl)}, ${r3(zh)}]`);
}

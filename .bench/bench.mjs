import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

function sphere(R=20, seg=96, rings=64){
  const geo = new THREE.SphereGeometry(R, seg, rings);
  geo.index ||= null;
  return geo;
}
for (const N of [48,64,80,96]) {
  const geo = sphere();
  const pos = geo.attributes.position; const idx = geo.index.array;
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const bvh = new MeshBVH(geo);
  const min=box.min,max=box.max; const R=3;
  const h = (Math.max(max.x-min.x,max.y-min.y,max.z-min.z)+2*R)/(N-1);
  let n=0; const t0=performance.now();
  const p=new THREE.Vector3();
  const threshold=R;
  for(let k=0;k<N;k++) for(let j=0;j<N;j++) for(let i=0;i<N;i++){
    p.set(min.x-R+i*h, min.y-R+j*h, min.z-R+k*h);
    const hit=bvh.closestPointToPoint(p, undefined, 0, threshold);
    if(hit) n++;
  }
  const t1=performance.now();
  console.log(`N=${N} grid=${N**3} hits=${n} closestMs=${(t1-t0).toFixed(0)} tris=${idx.length/3}`);
}
// raycast benchmark
{
  const geo=sphere(); const bvh=new MeshBVH(geo); const box=new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  const N=64; const min=box.min,max=box.max; const R=3;
  const h=(Math.max(max.x-min.x,max.y-min.y,max.z-min.z)+2*R)/(N-1);
  const t0=performance.now(); let cross=0;
  const ray=new THREE.Ray();
  for(let k=0;k<N;k++) for(let j=0;j<N;j++){
    ray.origin.set(min.x-R-1, min.y-R+j*h+1e-5, min.z-R+k*h+2e-5); ray.direction.set(1,0,0);
    const hits=bvh.raycast(ray, THREE.DoubleSide);
    cross += hits.length;
  }
  console.log('rays',N*N,'hits',cross,'ms',(performance.now()-t0).toFixed(0));
}

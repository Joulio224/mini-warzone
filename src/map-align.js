// ---------------------------------------------------------------------------
// Alignement vertical de la map visible (map.glb) sur les collisions
// (map-colliders.glb, dont le sol est à Y = 0, là où les joueurs apparaissent
// avec les yeux à 1,7 m — voir les spawns dans map-data.json).
//
// Avant, le décalage était écrit en dur (+46 m). Or avec le fichier actuel du
// dépôt, le sol du map.glb est déjà à Y = 0 : le décalage de 46 m posait le sol
// visible 46 m AU-DESSUS des joueurs (on voyait des murs mais plus de sol).
// Plutôt que de deviner dans un sens ou dans l'autre, on mesure : on lance un
// rayon vers le bas dans le coin de départ (toujours dégagé) et on prend la
// surface horizontale la plus basse comme sol ; le décalage est ce qu'il faut
// pour la ramener à Y = 0. Fichier déjà bien placé => décalage 0.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const PROBE_POINTS = [
  [-68, -68],
  [68, -68],
  [-68, 68],
  [68, 68],
];

// `root` : la scène du GLB, SANS décalage appliqué (position 0), matrices à jour.
export function computeMapOffsetY(root) {
  root.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const normal = new THREE.Vector3();
  const floors = [];

  PROBE_POINTS.forEach(([x, z]) => {
    raycaster.set(new THREE.Vector3(x, 500, z), down);
    raycaster.far = 1000;
    const hits = raycaster.intersectObject(root, true);
    // surfaces tournées vers le haut (un sol, pas le dessous d'un plafond)
    const upward = hits.filter((hit) => {
      if (!hit.face) return false;
      normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      return normal.y > 0.5;
    });
    if (upward.length) floors.push(upward[upward.length - 1].point.y); // la plus basse
  });

  if (floors.length === 0) return 0;
  floors.sort((a, b) => a - b);
  const floorY = floors[Math.floor(floors.length / 2)]; // médiane : insensible à un coin atypique
  return Math.abs(floorY) < 0.05 ? 0 : -floorY;
}

// Les 4 murs d'enceinte font 100 m de haut : avec un vrai soleil (surtout bas, en
// fin de journée), leur ombre recouvrirait une grande partie de l'arène et la
// plongerait dans le noir. Ils continuent de RECEVOIR des ombres, mais n'en
// projettent plus. `root` : la scène du GLB (matrices à jour).
export function disableTallWallShadows(root, minHeight = 60) {
  const box = new THREE.Box3();
  let count = 0;
  root.traverse((child) => {
    if (!child.isMesh) return;
    box.setFromObject(child);
    if (box.max.y - box.min.y > minHeight) {
      child.castShadow = false;
      count += 1;
    }
  });
  return count;
}

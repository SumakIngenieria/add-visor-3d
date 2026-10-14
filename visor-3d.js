// ADD. Visor 3D
// Muestra las capas exportadas de SketchUp según los módulos elegidos en el configurador.
// No depende de la lógica de precios: lee qué módulos están prendidos desde los
// elementos [data-module-id][aria-pressed="true"] que ya existen en la página.
//
// Requiere en el HTML:
//   <div id="visor-3d"></div>  (data-base="…/" opcional: carpeta de los .glb)
//   un importmap con "three" y "three/addons/" (ver visor-3d-prueba.html)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Reglas de visibilidad (fuente: reglas-3d.json). s = Set con los id de módulo prendidos:
// base · rest (Descanso) · social (Encuentro) · suite (Confort) · grow (Crecer) · garage · asador
const CAPAS = [
  { archivo: 'INICIO',              seVe: s => !s.has('social') && !s.has('suite') },
  { archivo: 'INICIO_SIN_DESCANSO', seVe: s => !s.has('rest') },
  { archivo: 'ENCUENTRO',           seVe: s => s.has('social') && !s.has('suite') },
  { archivo: 'CONFORT',             seVe: s => s.has('suite') && !s.has('social') },
  { archivo: 'CONFORT_ENCUENTRO',   seVe: s => s.has('suite') && s.has('social') },
  { archivo: 'DESCANSO',            seVe: s => s.has('rest') && !s.has('grow') },
  { archivo: 'CRECER',              seVe: s => s.has('grow') },
  { archivo: 'AMENITIES_COCHERA',   seVe: s => s.has('garage') },
  { archivo: 'AMENITIES_ASADOR',    seVe: s => s.has('asador') }
];

// Cajas de cada capa en metros (ejes glTF: Y arriba), medidas sobre los .glb sin comprimir.
// El encuadre fijo se calcula con todas, así la casa completa entra justa en el recuadro.
const CAJAS = [
  [9.38, 0.10, -9.79, 10.88, 5.10, -9.00],   // AMENITIES_ASADOR
  [1.77, 0.10, -9.06, 5.47, 2.72, -3.76],    // AMENITIES_COCHERA
  [5.32, 0.00, -16.98, 10.88, 5.65, -3.63],  // INICIO / ENCUENTRO / CONFORT (y sus combinaciones)
  [1.75, 0.00, -16.98, 5.47, 3.77, -9.04]    // DESCANSO / CRECER
].map(c => new THREE.Box3(new THREE.Vector3(c[0], c[1], c[2]), new THREE.Vector3(c[3], c[4], c[5])));
const CASA = CAJAS.reduce((u, c) => u.union(c), new THREE.Box3());

const contenedor = document.getElementById('visor-3d');
if (contenedor) iniciar(contenedor);

function iniciar(contenedor) {
  // Por defecto los .glb están en la carpeta glb/ junto a este script.
  const base = contenedor.dataset.base || new URL('glb/', import.meta.url).href;
  contenedor.style.position = contenedor.style.position || 'relative';

  const estado = document.createElement('p');
  estado.className = 'visor-3d-estado';
  estado.textContent = 'Cargando modelo 3D…';
  contenedor.appendChild(estado);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  contenedor.appendChild(renderer.domElement);

  const escena = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  escena.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const sol = new THREE.DirectionalLight(0xffffff, 1.6);
  const centro = CASA.getCenter(new THREE.Vector3());
  sol.position.set(centro.x + 14, 22, centro.z + 12);
  sol.target.position.copy(centro);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  Object.assign(sol.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 70 });
  sol.shadow.bias = -0.0005;
  escena.add(sol, sol.target, new THREE.HemisphereLight(0xffffff, 0xd8d8d8, 0.6));

  const piso = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.18 }));
  piso.rotation.x = -Math.PI / 2;
  piso.position.set(centro.x, -0.01, centro.z);
  piso.receiveShadow = true;
  escena.add(piso);

  const camara = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  const controles = new OrbitControls(camara, renderer.domElement);
  controles.target.copy(centro);
  controles.enableDamping = true;
  controles.enablePan = false;
  controles.minDistance = 6;
  controles.maxDistance = 45;
  controles.maxPolarAngle = Math.PI * 0.48;

  // Dos modos de cámara, según el atributo data-camara del contenedor:
  //   (sin atributo) fija: encuadra la casa completa y no se mueve al prender o apagar módulos,
  //                  así cada módulo aparece o desaparece en su lugar.
  //   "seguir":      al cambiar la selección, la cámara se desliza para encuadrar solo lo visible.
  const SEGUIR = contenedor.dataset.camara === 'seguir';
  const DIRECCION = new THREE.Vector3(1, 0.75, 0.9).normalize();
  const auxiliar = new THREE.PerspectiveCamera();

  // Calcula objetivo y distancia para que las cajas ocupen ~88 % del recuadro, mirando desde dir.
  function calcularEncuadre(cajas, dir) {
    const esquinas = [];
    for (const c of cajas) for (const x of [c.min.x, c.max.x]) for (const y of [c.min.y, c.max.y]) for (const z of [c.min.z, c.max.z]) esquinas.push(new THREE.Vector3(x, y, z));
    auxiliar.copy(camara);
    const objetivo = cajas.reduce((u, c) => u.union(c), new THREE.Box3()).getCenter(new THREE.Vector3());
    let dist = 30;
    for (let i = 0; i < 4; i++) {
      auxiliar.position.copy(objetivo).addScaledVector(dir, dist);
      auxiliar.lookAt(objetivo);
      auxiliar.updateMatrixWorld();
      const min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
      for (const p of esquinas) { const v = p.clone().project(auxiliar); min.min(v); max.max(v); }
      // corre el objetivo hacia el centro del dibujo, en el plano de la cámara
      const centroPantalla = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, 0.5).unproject(auxiliar);
      objetivo.add(centroPantalla.sub(auxiliar.position).normalize().multiplyScalar(dist).add(auxiliar.position).sub(objetivo));
      dist *= Math.max(max.x - min.x, max.y - min.y) / 2 / 0.88;
    }
    return { objetivo, posicion: objetivo.clone().addScaledVector(dir, dist), dist };
  }

  const viaje = { t: 1, desdeT: new THREE.Vector3(), hastaT: new THREE.Vector3(), desdeP: new THREE.Vector3(), hastaP: new THREE.Vector3() };
  function avanzarViaje(paso) {
    if (viaje.t >= 1) return;
    viaje.t = Math.min(1, viaje.t + paso);
    const k = 1 - Math.pow(1 - viaje.t, 3);
    controles.target.lerpVectors(viaje.desdeT, viaje.hastaT, k);
    camara.position.lerpVectors(viaje.desdeP, viaje.hastaP, k);
  }

  // Encuadre de la casa completa (punto de partida en los dos modos y límites del zoom).
  function encuadrar() {
    const e = calcularEncuadre(CAJAS, DIRECCION);
    controles.minDistance = e.dist * 0.35;
    controles.maxDistance = e.dist * 1.6;
    if (SEGUIR && capas.size) return seguirVisible(false);
    viaje.t = 1;
    controles.target.copy(e.objetivo);
    camara.position.copy(e.posicion);
    controles.update();
  }

  // Modo "seguir": encuadra las capas visibles, respetando el ángulo que eligió el usuario.
  function seguirVisible(animar) {
    const cajas = [...capas.values()].filter(g => g.visible).map(g => g.userData.caja);
    if (!cajas.length) return;
    const dir = camara.position.clone().sub(controles.target).normalize();
    const e = calcularEncuadre(cajas, dir);
    viaje.desdeT.copy(controles.target); viaje.hastaT.copy(e.objetivo);
    viaje.desdeP.copy(camara.position); viaje.hastaP.copy(e.posicion);
    viaje.t = 0;
    if (!animar) { avanzarViaje(1); controles.update(); }
  }

  function ajustarTamano() {
    const w = contenedor.clientWidth, h = contenedor.clientHeight || 420;
    renderer.setSize(w, h, false);
    camara.aspect = w / h;
    camara.updateProjectionMatrix();
    encuadrar();
  }
  const capas = new Map(); // archivo -> THREE.Group
  new ResizeObserver(ajustarTamano).observe(contenedor);
  ajustarTamano();

  // Solo dibuja mientras el visor está en pantalla. El reloj hace que el movimiento
  // de cámara dure 0,5 s aunque el equipo dibuje pocos cuadros por segundo.
  const reloj = new THREE.Clock();
  let visible = false;
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    renderer.setAnimationLoop(visible ? () => { avanzarViaje(reloj.getDelta() / 0.5); controles.update(); renderer.render(escena, camara); } : null);
    if (visible) cargarTodo();
  }).observe(contenedor);

  let cargando = null;
  function cargarTodo() {
    if (cargando) return cargando;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const seleccion = leerSeleccion();
    // primero las capas que se ven ahora, después el resto
    const orden = [...CAPAS].sort((a, b) => b.seVe(seleccion) - a.seVe(seleccion));
    let listas = 0;
    cargando = Promise.all(orden.map(capa =>
      loader.loadAsync(base + capa.archivo + '.glb').then(gltf => {
        const grupo = gltf.scene;
        grupo.traverse(o => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach(m => { if (m.transparent) o.castShadow = false; });
          }
        });
        grupo.userData.caja = new THREE.Box3().setFromObject(grupo);
        capas.set(capa.archivo, grupo);
        escena.add(grupo);
        aplicar();
        listas++;
        estado.textContent = listas < CAPAS.length ? `Cargando modelo 3D… ${listas}/${CAPAS.length}` : '';
      }).catch(err => {
        console.error('Visor 3D: no se pudo cargar', capa.archivo, err);
        estado.textContent = 'No se pudo cargar el modelo 3D.';
      })
    ));
    return cargando;
  }

  function leerSeleccion() {
    const ids = [...document.querySelectorAll('[data-module-id][aria-pressed="true"]')].map(e => e.dataset.moduleId);
    return new Set(['base', ...ids]);
  }

  // Prende y apaga capas. En modo fijo la cámara queda donde está; en modo "seguir" se reencuadra.
  let ultimaSeleccion = '';
  function aplicar() {
    const s = leerSeleccion();
    for (const capa of CAPAS) {
      const g = capas.get(capa.archivo);
      if (g) g.visible = capa.seVe(s);
    }
    if (!SEGUIR) return;
    const clave = [...s].sort().join(',') + '|' + capas.size;
    if (clave !== ultimaSeleccion) {
      // mientras carga, encuadra sin animar; después, desliza la cámara
      seguirVisible(capas.size === CAPAS.length && ultimaSeleccion !== '');
      ultimaSeleccion = clave;
    }
  }

  new MutationObserver(aplicar).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  window.ADD3D = { aplicar, encuadrar, leerSeleccion };
}

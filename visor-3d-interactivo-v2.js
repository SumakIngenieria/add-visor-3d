// ADD. Visor 3D — versión interactiva v2 (prueba)
// Cambio respecto de visor-3d-interactivo.js: los módulos no elegidos se dibujan con archivos
// "fantasma" que tienen solo la parte propia de cada módulo (sin las piezas de Inicio o de
// Descanso que traen las capas combinadas). Así el gris y el resaltado marcan solo ese módulo.
// Igual que visor-3d.js, más dos cosas:
//   1. Los módulos no elegidos se ven igual, en gris translúcido ("desactivados").
//   2. Tocando un módulo en el 3D se agrega o se quita, como en la planta.
// Muestra las capas exportadas de SketchUp según los módulos elegidos en el configurador.
// No depende de la lógica de precios: lee qué módulos están prendidos desde los
// elementos [data-module-id][aria-pressed="true"] que ya existen en la página.
//
// Requiere en el HTML:
//   <div id="visor-3d"></div>
// Atributos opcionales del div (los genera ajustar-visor.html):
//   data-camara="seguir"      la cámara acompaña a los módulos elegidos (si no, queda fija)
//   data-direccion="x,y,z"    ángulo desde el que se mira la casa
//   data-zoom="1.00"          1 = encuadre automático; menos de 1 acerca, más de 1 aleja
//   data-etiqueta="no"        no muestra el nombre del módulo al pasar el mouse
//   data-base="…/"            carpeta de los .glb (por defecto, glb/ junto a este script)
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

// Qué se dibuja en gris cuando un módulo NO está elegido.
// FANTASMA_* se generan comparando triángulo por triángulo cada capa con su base y quedándose
// con lo propio dentro de la zona del módulo (ver LEEME-visor-3d.md).
const FANTASMAS = {
  rest:   'DESCANSO',
  grow:   'FANTASMA_CRECER',
  social: 'FANTASMA_ENCUENTRO',
  suite:  'FANTASMA_CONFORT',
  garage: 'AMENITIES_COCHERA',
  asador: 'AMENITIES_ASADOR'
};
const ARCHIVOS = [...new Set([...CAPAS.map(c => c.archivo), ...Object.values(FANTASMAS)])];

// Cajas de cada capa en metros (ejes glTF: Y arriba), medidas sobre los .glb sin comprimir.
// El encuadre fijo se calcula con todas, así la casa completa entra justa en el recuadro.
const CAJAS = [
  [9.38, 0.10, -9.79, 10.88, 5.10, -9.00],   // AMENITIES_ASADOR
  [1.77, 0.10, -9.06, 5.47, 2.72, -3.76],    // AMENITIES_COCHERA
  [5.32, 0.00, -16.98, 10.88, 5.65, -3.63],  // INICIO / ENCUENTRO / CONFORT (y sus combinaciones)
  [1.75, 0.00, -16.98, 5.47, 3.77, -9.04]    // DESCANSO / CRECER
].map(c => new THREE.Box3(new THREE.Vector3(c[0], c[1], c[2]), new THREE.Vector3(c[3], c[4], c[5])));
const CASA = CAJAS.reduce((u, c) => u.union(c), new THREE.Box3());

const NOMBRES = { base: 'ADD. INICIO', rest: 'ADD. DESCANSO', grow: 'ADD. CRECER', social: 'ADD. ENCUENTRO', suite: 'ADD. CONFORT', garage: 'COCHERA', asador: 'ASADOR' };

// A qué módulo pertenece un punto tocado de una capa ELEGIDA, según la capa y la posición (metros).
// Las capas de Encuentro y Confort traen su propio Inicio: se separan por zona.
// Zonas medidas comparando cada capa contra Inicio (ver LEEME-visor-3d.md).
// (Los módulos en gris no pasan por acá: cada archivo fantasma es de un solo módulo.)
function moduloDe(capa, p) {
  const enEncuentro = p.z > -6.8;
  const enConfort = p.x > 9.4 && p.z < -12.1;
  switch (capa) {
    case 'AMENITIES_COCHERA': return 'garage';
    case 'AMENITIES_ASADOR': return 'asador';
    case 'DESCANSO': return 'rest';
    case 'CRECER': return p.z > -12.2 ? 'grow' : 'rest';
    case 'ENCUENTRO': return enEncuentro ? 'social' : 'base';
    case 'CONFORT': return enConfort ? 'suite' : 'base';
    case 'CONFORT_ENCUENTRO': return enEncuentro ? 'social' : enConfort ? 'suite' : 'base';
    default: return 'base';
  }
}

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

  const etiqueta = document.createElement('p');
  etiqueta.className = 'visor-3d-etiqueta';
  if (contenedor.dataset.etiqueta !== 'no') contenedor.appendChild(etiqueta);

  // Gris translúcido para los módulos no elegidos. polygonOffset lo empuja hacia atrás:
  // donde coincide con una pieza activa (el Inicio repetido en otras capas), gana la activa.
  const FANTASMA = new THREE.MeshStandardMaterial({
    color: 0x9aa3ad, roughness: 1, metalness: 0, transparent: true, opacity: 0.28, depthWrite: false, flatShading: true,
    polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4
  });
  const FANTASMA_RESALTADO = FANTASMA.clone();
  FANTASMA_RESALTADO.opacity = 0.5;
  FANTASMA_RESALTADO.color.set(0x6f7883);

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
  // Vista más alta que en visor-3d.js para que Descanso y Crecer no queden tapados por Inicio y se puedan tocar.
  const leida = (contenedor.dataset.direccion || '').split(',').map(Number);
  let DIRECCION = (leida.length === 3 && leida.every(Number.isFinite) ? new THREE.Vector3(...leida) : new THREE.Vector3(0.8, 1.7, 0.9)).normalize();
  let ZOOM = parseFloat(contenedor.dataset.zoom) || 1;
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
    e.posicion = e.objetivo.clone().addScaledVector(DIRECCION, e.dist * ZOOM);
    controles.minDistance = e.dist * 0.3;
    controles.maxDistance = e.dist * 2.5;
    if (SEGUIR && capas.size) return seguirVisible(false);
    viaje.t = 1;
    controles.target.copy(e.objetivo);
    camara.position.copy(e.posicion);
    controles.update();
  }

  // Modo "seguir": encuadra las capas visibles, respetando el ángulo que eligió el usuario.
  function seguirVisible(animar) {
    const visibles = [...capas.values()].filter(g => g.visible);
    const activas = visibles.filter(g => !g.userData.fantasma);
    if (!activas.length) return;
    const dir = camara.position.clone().sub(controles.target).normalize();
    const e = encuadreCombinado(activas.flatMap(g => g.userData.puntos), visibles.flatMap(g => g.userData.puntos), dir);
    viaje.desdeT.copy(controles.target); viaje.hastaT.copy(e.objetivo);
    viaje.desdeP.copy(camara.position); viaje.hastaP.copy(e.objetivo).addScaledVector(dir, e.dist * ZOOM);
    viaje.t = 0;
    if (!animar) { avanzarViaje(1); controles.update(); }
  }

  // Encuadre combinado: la cámara se corre a mitad de camino entre el centro de la casa completa
  // y el centro de lo elegido. Lo elegido entra siempre con margen; los módulos en gris pueden
  // llegar justo al borde, pero quedan a la vista para tocarlos.
  const MARGEN_ELEGIDO = 0.8, MARGEN_GRIS = 0.98, CORRIMIENTO = 0.5;
  function centroEnPantalla(puntos, objetivo, dir, dist) {
    auxiliar.position.copy(objetivo).addScaledVector(dir, dist);
    auxiliar.lookAt(objetivo);
    auxiliar.updateMatrixWorld();
    const min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
    for (const p of puntos) { const v = p.clone().project(auxiliar); min.min(v); max.max(v); }
    const c = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, 0.5).unproject(auxiliar);
    return c.sub(auxiliar.position).normalize().multiplyScalar(dist).add(auxiliar.position);
  }
  function encuadreCombinado(elegidos, todos, dir) {
    auxiliar.copy(camara);
    const objetivo = new THREE.Box3().setFromPoints(todos).getCenter(new THREE.Vector3());
    let dist = 30;
    for (let i = 0; i < 6; i++) {
      const cTodos = centroEnPantalla(todos, objetivo, dir, dist);
      const cElegidos = centroEnPantalla(elegidos, objetivo, dir, dist);
      objetivo.copy(cTodos.lerp(cElegidos, CORRIMIENTO));
      auxiliar.position.copy(objetivo).addScaledVector(dir, dist);
      auxiliar.lookAt(objetivo);
      auxiliar.updateMatrixWorld();
      let m = 0;
      for (const p of elegidos) { const v = p.clone().project(auxiliar); m = Math.max(m, Math.abs(v.x) / MARGEN_ELEGIDO, Math.abs(v.y) / MARGEN_ELEGIDO); }
      for (const p of todos) { const v = p.clone().project(auxiliar); m = Math.max(m, Math.abs(v.x) / MARGEN_GRIS, Math.abs(v.y) / MARGEN_GRIS); }
      dist *= m;
    }
    return { objetivo, posicion: objetivo.clone().addScaledVector(dir, dist), dist };
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
    const seVeAhora = a => { const c = CAPAS.find(x => x.archivo === a); return c ? c.seVe(seleccion) : false; };
    const orden = [...ARCHIVOS].sort((a, b) => seVeAhora(b) - seVeAhora(a)).map(archivo => ({ archivo }));
    let listas = 0;
    cargando = Promise.all(orden.map(capa =>
      loader.loadAsync(base + capa.archivo + '.glb').then(gltf => {
        const grupo = gltf.scene;
        grupo.traverse(o => {
          if (o.isMesh) {
            o.userData.capa = capa.archivo;
            o.userData.grupo = grupo;
            o.userData.original = o.material;
            o.castShadow = true;
            o.receiveShadow = true;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach(m => { if (m.transparent) o.castShadow = false; });
          }
        });
        grupo.userData.caja = new THREE.Box3().setFromObject(grupo);
        // esquinas de la caja de cada pieza: contorno más justo que la caja de toda la capa
        grupo.userData.puntos = [];
        grupo.traverse(o => {
          if (!o.isMesh) return;
          const c = new THREE.Box3().setFromObject(o);
          for (const x of [c.min.x, c.max.x]) for (const y of [c.min.y, c.max.y]) for (const z of [c.min.z, c.max.z]) grupo.userData.puntos.push(new THREE.Vector3(x, y, z));
        });
        capas.set(capa.archivo, grupo);
        escena.add(grupo);
        aplicar();
        listas++;
        estado.textContent = listas < ARCHIVOS.length ? `Cargando modelo 3D… ${listas}/${ARCHIVOS.length}` : '';
      }).catch(err => {
        console.error('Visor 3D: no se pudo cargar', capa.archivo, err);
        estado.textContent = 'No se pudo cargar el modelo 3D.';
      })
    ));
    return cargando;
  }

  // Qué módulos están elegidos. En el configurador se lee de selectedIds (la memoria de la página),
  // así el visor funciona aunque se saque el esquema de planta. Si no existe (páginas de prueba),
  // se lee de los elementos [data-module-id][aria-pressed="true"].
  function leerSeleccion() {
    // eslint-disable-next-line no-undef
    if (typeof selectedIds !== 'undefined' && selectedIds instanceof Set) return new Set(['base', ...selectedIds]);
    const ids = [...document.querySelectorAll('[data-module-id][aria-pressed="true"]')].map(e => e.dataset.moduleId);
    return new Set(['base', ...ids]);
  }

  // Pasa una capa a "desactivada" (gris translúcido) o la devuelve a sus materiales.
  function ponerFantasma(grupo, si) {
    if (grupo.userData.fantasma === si) return;
    grupo.userData.fantasma = si;
    grupo.traverse(o => {
      if (!o.isMesh) return;
      o.material = si ? FANTASMA : o.userData.original;
      o.castShadow = !si && !(Array.isArray(o.material) ? o.material : [o.material]).some(m => m.transparent);
      o.renderOrder = si ? 1 : 0;
    });
  }

  // Prende y apaga capas: las elegidas se ven normales; cada módulo no elegido, en gris con su fantasma.
  // En modo fijo la cámara queda donde está; en modo "seguir" se reencuadra.
  let ultimaSeleccion = '';
  let ultimoAplicado = '';
  function aplicar() {
    const s = leerSeleccion();
    // Se llama ante cualquier cambio de la página: solo actúa si cambió la selección o se cargó una capa.
    const huella = [...s].sort().join(',') + '|' + capas.size;
    if (huella === ultimoAplicado) return;
    ultimoAplicado = huella;
    const fantasmaDe = new Map(); // archivo -> módulo no elegido que representa
    for (const [modulo, archivo] of Object.entries(FANTASMAS)) if (!s.has(modulo)) fantasmaDe.set(archivo, modulo);
    for (const archivo of ARCHIVOS) {
      const g = capas.get(archivo);
      if (!g) continue;
      const capa = CAPAS.find(c => c.archivo === archivo);
      const activa = capa ? capa.seVe(s) : false;
      const fantasma = !activa && fantasmaDe.has(archivo);
      g.visible = activa || fantasma;
      g.userData.moduloFantasma = fantasma ? fantasmaDe.get(archivo) : null;
      ponerFantasma(g, fantasma);
    }
    resaltar(null);
    if (!SEGUIR) return;
    const clave = [...s].sort().join(',') + '|' + capas.size;
    if (clave !== ultimaSeleccion) {
      seguirVisible(capas.size === ARCHIVOS.length && ultimaSeleccion !== '');
      ultimaSeleccion = clave;
    }
  }

  // ---- Interacción: pasar el mouse muestra el nombre; tocar agrega o quita el módulo ----
  const rayo = new THREE.Raycaster();
  const puntero = new THREE.Vector2();
  function moduloBajo(evento) {
    const r = renderer.domElement.getBoundingClientRect();
    puntero.set(((evento.clientX - r.left) / r.width) * 2 - 1, -((evento.clientY - r.top) / r.height) * 2 + 1);
    rayo.setFromCamera(puntero, camara);
    const visibles = [...capas.values()].filter(g => g.visible);
    const hit = rayo.intersectObjects(visibles, true)[0];
    if (!hit) return null;
    const g = hit.object.userData.grupo;
    return { id: g.userData.fantasma ? g.userData.moduloFantasma : moduloDe(hit.object.userData.capa, hit.point) };
  }

  // "Despierta" (oscurece) solo el fantasma del módulo bajo el mouse.
  let resaltado = null;
  function resaltar(id) {
    if (id === resaltado) return;
    resaltado = id;
    capas.forEach(g => {
      if (!g.userData.fantasma) return;
      const mat = id && g.userData.moduloFantasma === id ? FANTASMA_RESALTADO : FANTASMA;
      g.traverse(o => { if (o.isMesh) o.material = mat; });
    });
  }

  function textoEtiqueta(id) {
    if (id === 'base') return NOMBRES.base + ' · vivienda base';
    const s = leerSeleccion();
    if (s.has(id)) return NOMBRES[id] + ' · tocá para quitar';
    if (id === 'grow' && !s.has('rest')) return NOMBRES.grow + ' · primero agregá ADD. DESCANSO';
    return NOMBRES[id] + ' · tocá para agregar';
  }

  function alternar(id) {
    if (id === 'base') return;
    if (id === 'grow' && !leerSeleccion().has('rest')) { etiqueta.textContent = textoEtiqueta(id); return; }
    // En la página del configurador existe toggleModule(id); en la página de prueba, los botones.
    if (typeof window.toggleModule === 'function') { window.toggleModule(id); aplicar(); }
    else { const el = document.querySelector('[data-module-id="' + id + '"]'); if (el) el.click(); }
    etiqueta.textContent = textoEtiqueta(id);
  }

  const lienzo = renderer.domElement;
  let inicioToque = null;
  lienzo.addEventListener('pointerdown', e => { inicioToque = { x: e.clientX, y: e.clientY }; });
  lienzo.addEventListener('pointerup', e => {
    // Si el dedo o el mouse se movió, fue un giro de cámara, no un toque.
    if (!inicioToque || Math.hypot(e.clientX - inicioToque.x, e.clientY - inicioToque.y) > 6) return;
    inicioToque = null;
    const m = moduloBajo(e);
    if (m) alternar(m.id);
  });
  lienzo.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const m = moduloBajo(e);
    resaltar(m && m.id !== 'base' ? m.id : null);
    lienzo.style.cursor = m && m.id !== 'base' ? 'pointer' : 'grab';
    etiqueta.textContent = m ? textoEtiqueta(m.id) : '';
  });
  lienzo.addEventListener('pointerleave', () => { resaltar(null); etiqueta.textContent = ''; });

  // La página no avisa cuando cambia la selección: se revisa ante cualquier cambio en el DOM
  // (precios, resumen, planta), como máximo una vez por cuadro. Los cambios dentro del visor se ignoran.
  let pendiente = false;
  new MutationObserver(registros => {
    if (pendiente || registros.every(r => contenedor.contains(r.target))) return;
    pendiente = true;
    requestAnimationFrame(() => { pendiente = false; aplicar(); });
  }).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
  // Para ajustar-visor.html: lee la vista actual (ángulo y zoom relativo al encuadre automático)
  // y la fija como punto de partida.
  function vista() {
    const dir = camara.position.clone().sub(controles.target);
    const dist = dir.length(); dir.normalize();
    let base;
    if (SEGUIR && capas.size) {
      const visibles = [...capas.values()].filter(g => g.visible);
      const activas = visibles.filter(g => !g.userData.fantasma);
      base = encuadreCombinado(activas.flatMap(g => g.userData.puntos), visibles.flatMap(g => g.userData.puntos), dir).dist;
    } else base = calcularEncuadre(CAJAS, dir).dist;
    return { direccion: dir.toArray().map(v => +v.toFixed(3)), zoom: +(dist / base).toFixed(2) };
  }
  // Sin argumento: frena la inercia del giro, toma la vista actual y la fija. Devuelve la vista fijada.
  function fijarVista(v) {
    if (!v) {
      const amortiguado = controles.enableDamping;
      controles.enableDamping = false; controles.update(); controles.enableDamping = amortiguado;
      viaje.t = 1;
      v = vista();
    }
    DIRECCION = new THREE.Vector3(...v.direccion).normalize();
    ZOOM = v.zoom;
    const amortiguado = controles.enableDamping;
    controles.enableDamping = false;
    camara.position.copy(controles.target).addScaledVector(DIRECCION, 1);  // deja la cámara mirando desde DIRECCION
    encuadrar();
    controles.update();
    controles.enableDamping = amortiguado;
    return v;
  }
  window.ADD3D = { aplicar, encuadrar, leerSeleccion, camara, capas, vista, fijarVista };
}

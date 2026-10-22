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
//   data-camara="seguir"      la cámara acompaña a los módulos elegidos ("fija" o sin atributo: no se mueve)
//   data-direccion="x,y,z"    ángulo desde el que se mira la casa
//   data-zoom="1.00"          1 = encuadre automático; menos de 1 acerca, más de 1 aleja
//   data-al-tocar="encuadrar" en "seguir", reencuadra aunque el usuario se haya acercado (por defecto: "quieta")
//   data-desplazar="no"       sin desplazamiento lateral
//   data-arrastre="desplazar" clic izquierdo / un dedo desplaza y el derecho gira (por defecto: el izquierdo gira y el derecho desplaza). La ruedita apretada siempre gira
//   data-zoom-cursor="no"     el zoom va al centro (por defecto: hacia el mouse o los dedos)
//   data-margen-arriba="0.70" aire arriba de la casa (1 = pegada al borde, menos = más aire)
//   data-etiqueta="no"        no muestra el tooltip del módulo
//   data-base="…/"            carpeta de los .glb (por defecto, glb/ junto a este script)
// Configuración publicada: si junto a este script hay un config.json ({"atributos": {"gris": "tenue", …}},
// el que genera "Marcar como definitiva" en el panel de prueba), completa los atributos que el div no trae.
// Así la página puede llevar solo <div id="visor-3d"></div> y el estilo viaja con cada versión del visor.
//   un importmap con "three" y "three/addons/" (ver visor-3d-prueba.html)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

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
// Capas con caja de toque invisible (piezas con huecos, como la pérgola).
const CON_CAJA_DE_TOQUE = ['AMENITIES_COCHERA'];
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
const CASA_HOLGADA = CASA.clone().expandByScalar(0.3);

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

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;  // animaciones de crecer y bajar
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  contenedor.appendChild(renderer.domElement);

  // Tooltip con el mismo texto y estilo que tenían las tarjetas del esquema de planta (.plan-room::after).
  if (!document.getElementById('visor-3d-estilos')) {
    const estilos = document.createElement('style');
    estilos.id = 'visor-3d-estilos';
    estilos.textContent = `
      .visor-3d-tooltip { position: absolute; z-index: 20; left: 0; top: 0; width: max-content; max-width: min(220px, 70vw);
        padding: .65rem .75rem; border: 1px solid var(--black, #000); background: #363636; color: var(--white, #fff);
        font-size: .72rem; line-height: 1.4; font-weight: 500; letter-spacing: 0; text-transform: none; white-space: pre-line;
        box-shadow: 3px 3px 0 rgba(0,0,0,.18); pointer-events: none; opacity: 0; visibility: hidden;
        transition: opacity .16s ease, visibility .16s ease; }
      .visor-3d-tooltip.visible { opacity: 1; visibility: visible; }
      .visor-3d-tooltip::first-line { font-weight: 700; }
      .visor-3d-etiquetas { position: absolute; inset: 0; z-index: 10; overflow: hidden; pointer-events: none; }
      .visor-3d-chip { position: absolute; left: 0; top: 0; pointer-events: auto; cursor: pointer; white-space: nowrap;
        padding: 5px 7px; border: 1px solid #363636; border-radius: 0; background: rgba(255,255,255,.92); color: #363636;
        font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; }
      .visor-3d-chip.elegido { background: #363636; color: #fff; }
      .visor-3d-chip[data-modulo="base"] { cursor: default; }
      .visor-3d-chip.bloqueado { opacity: .45; }
      .visor-3d-chip:not([data-modulo="base"]):hover { border-color: #0042AB; box-shadow: 0 0 0 1px #0042AB; }
      .visor-3d-tooltip.con-boton { pointer-events: auto; }
      .visor-3d-tooltip button { display: block; margin-top: .5rem; width: 100%; padding: .45rem .6rem; border: 1px solid #fff; border-radius: 0;
        background: #fff; color: #363636; font: 700 .7rem/1 Inter, system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; }
      .visor-3d-pista { position: absolute; left: 50%; bottom: .75rem; z-index: 11; transform: translateX(-50%); pointer-events: none;
        padding: .45rem .7rem; background: rgba(54,54,54,.9); color: #fff; font: 600 .7rem/1 Inter, system-ui, sans-serif; letter-spacing: .06em;
        opacity: 0; transition: opacity .4s ease; white-space: nowrap; }
      .visor-3d-pista.visible { opacity: 1; }
      .visor-3d-aviso { display: flex; align-items: center; gap: .45rem; transition-duration: .3s; padding: .4rem .6rem;
        background: none; color: #363636; font-family: inherit; font-size: .68rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
        text-shadow: 0 0 2px #fff, 0 0 6px #fff, 0 0 12px #fff, 0 0 18px #fff; }
      .visor-3d-aviso svg { flex: none; width: 13px; height: 13px; filter: drop-shadow(0 0 3px #fff) drop-shadow(0 0 6px #fff); }
      .visor-3d-barra { display: flex; justify-content: flex-start; margin-top: .75rem; }
      .visor-3d-barra[hidden] { display: none; }
      .visor-3d-solo { display: flex; align-items: center; gap: .75rem;
        padding: 0; border: 0; border-radius: 0; background: none; color: #363636; cursor: pointer;
        font: 600 12px/1 Inter, system-ui, sans-serif; letter-spacing: .02em; white-space: nowrap; }
      .visor-3d-solo:focus-visible { outline: 2px solid #0042AB; outline-offset: 2px; }
      .visor-3d-solo .interruptor { position: relative; flex: none; width: 34px; height: 20px; border-radius: 999px; background: #585858; transition: background-color .2s ease; }
      .visor-3d-solo .interruptor::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%;
        background: #fff; transition: transform .2s ease; }
      .visor-3d-solo[aria-checked="true"] .interruptor { background: #0042AB; }
      .visor-3d-solo[aria-checked="true"] .interruptor::after { transform: translateX(14px); }
      .visor-3d-cubo { position: absolute; top: .5rem; right: .5rem; z-index: 12; width: 88px; height: 106px; user-select: none;
        filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.10)) drop-shadow(0 3px 6px rgba(0,0,0,.06)); }
      .visor-3d-cubo .escena { position: absolute; left: 50%; top: 44%; width: 0; height: 0; transform-style: preserve-3d; }
      .visor-3d-cubo .cara { position: absolute; left: -19px; top: -19px; width: 38px; height: 38px; box-sizing: border-box;
        display: grid; grid-template: 7px 1fr 7px / 7px 1fr 7px; background: #e6e6e6; border: 0;
        box-shadow: inset 0 0 0 .6px rgba(255,255,255,.55); backface-visibility: hidden; -webkit-backface-visibility: hidden; }
      .visor-3d-cubo .cara > span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none;
        color: rgba(40,40,40,.42); font: 600 5.5px/1 Inter, system-ui, sans-serif; letter-spacing: .05em; text-transform: uppercase; }
      .visor-3d-cubo .cara > button { padding: 0; border: 0; background: transparent; cursor: pointer; }
      .visor-3d-cubo .cara > button:hover { background: rgba(0, 66, 171, .22); }
      .visor-3d-cubo .flecha { position: absolute; padding: 0; border: 0; background: none; color: #8a8a8a; cursor: pointer; line-height: 0; }
      .visor-3d-cubo .flecha:hover { color: #0042AB; }
      .visor-3d-cubo .flecha svg { display: block; overflow: visible; }
      .visor-3d-cubo .flecha[hidden] { display: none; }
      .visor-3d-cubo .proyeccion { position: absolute; right: 4px; top: 92px; display: flex; gap: 8px; white-space: nowrap; }
      .visor-3d-cubo .proyeccion[hidden] { display: none; }
      .visor-3d-cubo .proyeccion button { padding: 2px 0; border: 0; border-bottom: 1px solid transparent; background: none; cursor: pointer;
        color: #9a9a9a; font: 600 7px/1 Inter, system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase; }
      .visor-3d-cubo .proyeccion button:hover { color: #0042AB; }
      .visor-3d-cubo .proyeccion button[aria-pressed="true"] { color: #363636; border-bottom-color: #363636; }`;
    document.head.appendChild(estilos);
  }
  const tooltip = document.createElement('div');
  tooltip.className = 'visor-3d-tooltip';
  tooltip.setAttribute('role', 'status');
  if (contenedor.dataset.etiqueta !== 'no') contenedor.appendChild(tooltip);
  // "Solo mi selección": switch en la esquina superior derecha que oculta los módulos no elegidos.
  const botonSolo = document.createElement('button');
  botonSolo.type = 'button';
  botonSolo.className = 'visor-3d-solo';
  botonSolo.setAttribute('role', 'switch');
  botonSolo.setAttribute('aria-checked', 'false');
  botonSolo.innerHTML = '<span class="interruptor" aria-hidden="true"></span><span>Solo mi selección</span>';
  const barra = document.createElement('div');
  barra.className = 'visor-3d-barra';
  barra.appendChild(botonSolo);
  contenedor.after(barra);
  let SOLO = false;
  let AXO_PEDIDA = false, BOTON_PROYECCION = false;
  let MARCA_PLANTA = 'nombre';

  // ---- Cómo se ven los módulos no elegidos y el resaltado (interruptores de estilo) ----
  //   data-gris              "translucido" (o sin atributo) · "tenue" · "caja" · "huella"
  //                          · "planta" (solo la huella en el piso con un +)
  //   data-proyeccion        "perspectiva" (o sin atributo) · "axonometrica" (vista paralela, sin fuga)
  //   data-boton-proyeccion  "si": debajo del cubo, un selector Perspectiva / Axonométrica para el usuario
  //   data-marca-planta      (solo con data-gris="planta") cómo se marca la huella: "nombre" (o sin atributo) · "piso" (+ dibujado
  //                          en el piso) · "nombre" (el nombre pintado en el piso, sobre el lado largo libre) · "circulo"
  //                          (+ en un círculo, en el centro) · "ambos" (círculo y nombre). Los nombres se esconden si se pisan
  //   data-gris-hover        color del módulo no elegido bajo el mouse: "medio" (o sin atributo: #616161)
  //                          · "oscuro" (#363636) · "neutro" (#8c8c8c)
  //   data-resaltar-elegido  al pasar el mouse por un módulo elegido: "no" (o sin atributo)
  //                          · "contorno" (silueta de la caja del módulo; Llegada, que es una pérgola, no lleva) · "tinte"
  //   data-atenuar           al pasar el mouse por un módulo, el resto de la casa: "no" (o sin atributo)
  //                          · "si" (se atenúa con un velo blanco) · "bn" (pasa a blanco y negro)
  //   data-barrido           "si": al entrar el mouse en un módulo elegido, una franja de luz lo cruza una vez
  //   data-vista-previa      "si": al pasar el mouse se ve cómo quedaría (el gris con sus materiales; el elegido,
  //                          lavado), y el cartel suma "Clic para sumar / quitar"
  //   data-dependencias      "si": Descanso y Crecer reaccionan juntos (quitar Descanso quita Crecer)
  //   data-animacion         "crecer": al sumar, el módulo crece desde el piso; al quitarlo, baja
  //   data-destello          "si": al sumar un módulo, se ilumina un instante
  //   data-pista             "si": al abrir, los módulos no elegidos laten una vez y aparece "Tocá un módulo para sumarlo"
  //   data-marca-inicio      "etiqueta" (INICIO siempre rotulado)
  //   data-toque             "boton": en celular, el primer toque abre el cartel con un botón Sumar / Quitar
  //   data-sombras           "no": sin sombras
  //   data-etiquetas         "si": etiquetas tocables sobre cada módulo (+ para sumar, ✓ elegido)
  //   data-acento            color del resaltado (por defecto #0042AB)
  //   data-solo-seleccion    "no": sin el switch "Solo mi selección" (por defecto se muestra)
  let GRIS, GRIS_HOVER, RESALTAR_ELEGIDO, ATENUAR_BN, BARRIDO, DESTELLO, SOMBRAS, ETIQUETAS, ATENUAR, VISTA_PREVIA, DEPENDENCIAS, ANIMACION, PISTA, MARCA_INICIO, TOQUE_BOTON;
  const ACENTO = new THREE.Color();
  // [color, opacidad] del gris normal y bajo el mouse; null = color de acento.
  const GRISES = {
    translucido: [[0x9aa3ad, 0.28], [0x6f7883, 0.5]],
    tenue:       [[0xc3c9cf, 0.12], [0x8a939c, 0.38]],
    caja:        [[0x9aa3ad, 0.05], [null, 0.14]],
    huella:      [[0x8a939c, 0.55], [0x6f7883, 0.35]],
    planta:      [[0x9aa3ad, 0.28], [0x6f7883, 0.4]]
  };
  // Color del gris bajo el mouse (data-gris-hover); null = color de acento. La opacidad sigue siendo la del estilo.
  const GRISES_HOVER = { oscuro: 0x363636, medio: 0x616161, neutro: 0x8c8c8c };
  // polygonOffset empuja el gris hacia atrás: donde coincide con una pieza activa (el Inicio repetido
  // en otras capas), gana la activa.
  const nuevoGris = () => new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, transparent: true, depthWrite: false,
    flatShading: true, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 });
  const FANTASMA = nuevoGris(), FANTASMA_RESALTADO = nuevoGris();
  const TECHO = 6.5;  // altura desde la que bajan los recortes de las animaciones
  const CAJA_LINEA = new THREE.LineDashedMaterial({ color: 0x6f7883, dashSize: 0.3, gapSize: 0.18 });
  const CAJA_LINEA_RESALTADA = new THREE.LineDashedMaterial({ dashSize: 0.3, gapSize: 0.18 });
  // Resaltado de módulos elegidos y destello: se dibujan encima, con la geometría propia del módulo
  // (sus archivos de gris). polygonOffset negativo los adelanta sobre la pieza que tapan.
  const TINTE = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const DESTELLO_MAT = TINTE.clone();
  const PULSO_MAT = TINTE.clone();
  // Vista previa de quitar: el módulo elegido se ve "lavado", como a punto de irse.
  const LAVADO = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.62, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // Contorno: la silueta de la caja del módulo, con líneas de grosor fijo en pantalla.
  const CONTORNO_MAT = new LineMaterial({ linewidth: 3, toneMapped: false });
  // Barrido: una franja de luz que cruza el módulo en diagonal de pantalla. uPos avanza en metros sobre uDir.
  // Blanco cálido sumado a lo que hay (mezcla aditiva): se ve como un brillo que pasa, no como una sombra.
  const BARRIDO_MAT = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xfff6e0) }, uDir: { value: new THREE.Vector3(1, 0, 0) }, uPos: { value: 0 }, uAncho: { value: 1 } },
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: `uniform vec3 uDir; varying float vS;
      void main() {
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        vS = dot((modelMatrix * p).xyz, uDir);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * p;
      }`,
    fragmentShader: `uniform vec3 uColor; uniform float uPos, uAncho; varying float vS;
      void main() {
        float d = (vS - uPos) / uAncho;
        gl_FragColor = linearToOutputTexel(vec4(uColor, 0.5 * exp(-d * d)));
      }`
  });
  // "Resto en blanco y negro" (data-atenuar="bn"): los materiales originales se desaturan y aclaran según
  // DESATURAR (0 a 1). Las copias del módulo bajo el mouse no llevan este agregado y quedan a color.
  const DESATURAR = { value: 0 };
  function desaturable(m) {
    if (m.userData.desaturable) return;
    m.userData.desaturable = true;
    m.onBeforeCompile = sh => {
      sh.uniforms.uDesaturar = DESATURAR;
      sh.fragmentShader = 'uniform float uDesaturar;\n' + sh.fragmentShader.replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\n{ float g = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n' +
        '  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(mix(g, 1.0, 0.3)), uDesaturar); }');
    };
    m.needsUpdate = true;
  }
  // Huella en el piso ("planta").
  const PLANTA_RELLENO = new THREE.MeshBasicMaterial({ color: 0xe3e6ea, transparent: true, opacity: 0.85, depthWrite: false });
  const PLANTA_RELLENO_RESALTADO = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false });
  const PLANTA_SIGNO = new THREE.MeshBasicMaterial({ color: 0x6f7883 });
  function prepararMateriales() {
    const [n, r] = GRISES[GRIS];
    FANTASMA.color.set(n[0] ?? ACENTO); FANTASMA.opacity = n[1];
    FANTASMA_RESALTADO.color.set((GRIS_HOVER in GRISES_HOVER ? GRISES_HOVER[GRIS_HOVER] : r[0]) ?? ACENTO); FANTASMA_RESALTADO.opacity = r[1];
    for (const m of [FANTASMA, FANTASMA_RESALTADO]) { m.transparent = m.opacity < 1; m.depthWrite = !m.transparent; m.needsUpdate = true; }
    for (const m of [CAJA_LINEA_RESALTADA, CONTORNO_MAT, TINTE, DESTELLO_MAT, PULSO_MAT, PLANTA_RELLENO_RESALTADO]) m.color.copy(ACENTO);
    TINTE.opacity = RESALTAR_ELEGIDO === 'tinte' ? 0.25 : 0.07;
  }

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
  const cielo = new THREE.HemisphereLight(0xffffff, 0xd8d8d8, 0.6);
  escena.add(sol, sol.target, cielo);
  // Capa 1: lo que queda nítido cuando se atenúa el resto (data-atenuar). Las luces tienen que estar en las dos.
  sol.layers.enable(1); cielo.layers.enable(1);
  // Atenuar (data-atenuar): la casa se dibuja una sola vez, normal. La parte visible del módulo bajo el
  // mouse se marca en el stencil (MASCARA, capa 2) y el velo se pinta solo fuera de esa marca: el módulo
  // queda exactamente como sin atenuar, sin nada encima.
  const STENCIL = { stencilWrite: true, stencilRef: 1 };
  const velo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false,
    ...STENCIL, stencilFunc: THREE.NotEqualStencilFunc }));
  const escenaVelo = new THREE.Scene(), camaraVelo = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  escenaVelo.add(velo);
  // La marca: la geometría del módulo, sin color, adelantada lo justo para coincidir con lo ya dibujado.
  const MASCARA = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    ...STENCIL, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
  const MASCARA_DOBLE = MASCARA.clone();
  MASCARA_DOBLE.side = THREE.DoubleSide;
  const mascara = m => Array.isArray(m) ? m.map(mascara) : m.side === THREE.FrontSide ? MASCARA : MASCARA_DOBLE;
  // En blanco y negro el resto se desatura en su propio material; al módulo se le devuelve el color con una
  // imagen de la casa a color (colorCasa), pegada solo dentro de la marca.
  const colorCasa = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
  const escenaColor = new THREE.Scene();
  escenaColor.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: colorCasa.texture, depthTest: false, depthWrite: false,
    ...STENCIL, stencilFunc: THREE.EqualStencilFunc })));
  const TAM = new THREE.Vector2();
  let nivelVelo = 0;  // 0 a 1, animado

  const piso = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.18 }));
  piso.rotation.x = -Math.PI / 2;
  piso.position.set(centro.x, -0.01, centro.z);
  piso.receiveShadow = true;
  escena.add(piso);

  const camara = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  const controles = new OrbitControls(camara, renderer.domElement);
  // Arreglo del zoom con dos dedos (22/10): three r160 toma el punto medio de los dedos con pageX/pageY
  // (medidos desde el principio de la página) y lo compara con el visor medido en pantalla. Con la página
  // scrolleada, como siempre en el celular, el zoom iba hacia un punto más arriba de los dedos.
  // Antes de que los vea OrbitControls, pageX/pageY pasan a valer lo mismo que clientX/clientY
  // (giro y desplazamiento usan diferencias, así que no cambian).
  for (const tipo of ['pointerdown', 'pointermove', 'pointerup']) {
    contenedor.addEventListener(tipo, e => {
      if (e.target !== renderer.domElement) return;
      Object.defineProperties(e, { pageX: { value: e.clientX }, pageY: { value: e.clientY } });
    }, { capture: true });
  }
  controles.target.copy(centro);
  controles.enableDamping = true;
  controles.screenSpacePanning = true;
  controles.minDistance = 6;
  controles.maxDistance = 45;
  controles.maxPolarAngle = Math.PI * 0.48;
  // El punto al que mira la cámara no sale de la casa (con 1 m de aire): no se pierde de vista al desplazar.
  const LIMITE = CASA.clone().expandByScalar(1);
  function limitarDesplazamiento() {
    const t = controles.target;
    const d = t.clone().clamp(LIMITE.min, LIMITE.max).sub(t);
    if (d.lengthSq()) { t.add(d); camara.position.add(d); }
  }

  // Interruptores: se leen de los atributos data-… del contenedor y se vuelven a leer si cambian,
  // así un panel de prueba (o Canva) los puede cambiar sin recargar la página.
  //   data-camara      "fija" (o sin atributo): encuadra la casa completa y no se mueve al prender o
  //                    apagar módulos, así cada módulo aparece o desaparece en su lugar.
  //                    "seguir": al cambiar la selección, la cámara se desliza para encuadrar lo visible.
  //   data-al-tocar    (solo en "seguir") qué pasa si el usuario se acercó o desplazó y toca un módulo:
  //                    "quieta" (o sin atributo): la cámara se queda donde la dejó; "encuadrar": vuelve a encuadrar.
  //   data-desplazar   "no": sin desplazamiento lateral.
  //   data-arrastre    "desplazar": arrastrar con clic izquierdo o un dedo desplaza la casa (si no: la gira).
  //   data-zoom-cursor "no": el zoom va al centro (si no: hacia el mouse o el centro de los dedos).
  //   data-margen-arriba  aire arriba de la casa, en fracción de medio recuadro (1 = pegada al borde).
  //   data-direccion, data-zoom  ángulo y zoom del encuadre automático.
  // En todos los modos, doble clic (o doble toque) en un espacio vacío vuelve al encuadre automático.
  let SEGUIR, AL_TOCAR_ENCUADRA, MARGEN_ARRIBA, DIRECCION, ZOOM, AIRE;
  const LADOS_POR_DEFECTO = 0.88;
  function leerInterruptores() {
    const d = contenedor.dataset;
    SEGUIR = d.camara === 'seguir';
    AL_TOCAR_ENCUADRA = d.alTocar === 'encuadrar';
    controles.enablePan = d.desplazar !== 'no';
    // Apretar la ruedita y arrastrar siempre gira (como en SketchUp); girar la ruedita hace zoom.
    // Arrastrar con clic izquierdo o un dedo gira; el clic derecho o dos dedos desplazan.
    // data-arrastre="desplazar" invierte: el izquierdo o un dedo desplaza y el derecho o dos dedos giran.
    const desplaza = controles.enablePan && d.arrastre === 'desplazar';
    controles.mouseButtons = { LEFT: desplaza ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: desplaza ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN };
    controles.touches = { ONE: desplaza ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: desplaza ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN };
    controles.zoomToCursor = d.zoomCursor !== 'no';
    // data-giro: sensibilidad del giro con mouse, touchpad o dedo (1 = la de la librería; menos = más lento).
    controles.rotateSpeed = Math.min(2, Math.max(0.1, parseFloat(d.giro) || 1));
    MARGEN_ARRIBA = Math.min(1, parseFloat(d.margenArriba) || 0.7);
    // Vista más alta que en visor-3d.js para que Descanso y Crecer no queden tapados por Inicio y se puedan tocar.
    const leida = (d.direccion || '').split(',').map(Number);
    DIRECCION = (leida.length === 3 && leida.every(Number.isFinite) ? new THREE.Vector3(...leida) : new THREE.Vector3(0.8, 1.7, 0.9)).normalize();
    ZOOM = parseFloat(d.zoom) || 1;
    // data-aire: parte del recuadro que ocupa la casa en el encuadre fijo (0.94 = 3 % de aire por lado).
    AIRE = Math.min(0.99, Math.max(0.5, parseFloat(d.aire) || LADOS_POR_DEFECTO));
    GRIS = GRISES[d.gris] ? d.gris : 'translucido';
    GRIS_HOVER = d.grisHover in GRISES_HOVER ? d.grisHover : 'medio';
    RESALTAR_ELEGIDO = ['contorno', 'tinte'].includes(d.resaltarElegido) ? d.resaltarElegido : 'no';
    DESTELLO = d.destello === 'si';
    SOMBRAS = d.sombras !== 'no';
    ETIQUETAS = d.etiquetas === 'si';
    ATENUAR = d.atenuar === 'si' || d.atenuar === 'bn';
    ATENUAR_BN = d.atenuar === 'bn';
    BARRIDO = d.barrido === 'si';
    VISTA_PREVIA = d.vistaPrevia === 'si';
    DEPENDENCIAS = d.dependencias === 'si';
    ANIMACION = d.animacion === 'crecer';
    PISTA = d.pista === 'si';
    MARCA_INICIO = d.marcaInicio === 'etiqueta' ? 'etiqueta' : 'no';
    TOQUE_BOTON = d.toque === 'boton';
    barra.hidden = d.soloSeleccion === 'no';
    AXO_PEDIDA = d.proyeccion === 'axonometrica';
    BOTON_PROYECCION = d.botonProyeccion === 'si';
    MARCA_PLANTA = ['piso', 'circulo', 'ambos'].includes(d.marcaPlanta) ? d.marcaPlanta : 'nombre';
    ACENTO.set(d.acento || '#0042AB');
    prepararMateriales();
  }
  leerInterruptores();
  // Ángulo de partida aunque el visor arranque oculto (el modo "seguir" toma el ángulo de la cámara).
  camara.position.copy(centro).addScaledVector(DIRECCION, 30);
  const auxiliar = new THREE.PerspectiveCamera();

  // Calcula objetivo y distancia para que las cajas ocupen ~88 % del recuadro, mirando desde dir,
  // dejando arriba el aire de MARGEN_ARRIBA (la casa baja un poco dentro del recuadro).
  const LADOS = 0.88;
  // cajas: Box3 (se usan sus esquinas) o directamente puntos. lados: parte del recuadro que ocupa la casa.
  function calcularEncuadre(cajas, dir, lados = LADOS) {
    const arriba = Math.min(lados, MARGEN_ARRIBA), corrimientoY = (arriba - lados) / 2;
    const esquinas = [];
    if (cajas[0] && cajas[0].isVector3) esquinas.push(...cajas);
    else for (const c of cajas) for (const x of [c.min.x, c.max.x]) for (const y of [c.min.y, c.max.y]) for (const z of [c.min.z, c.max.z]) esquinas.push(new THREE.Vector3(x, y, z));
    auxiliar.copy(camara);
    const objetivo = new THREE.Box3().setFromPoints(esquinas).getCenter(new THREE.Vector3());
    let dist = 30;
    for (let i = 0; i < 4; i++) {
      auxiliar.position.copy(objetivo).addScaledVector(dir, dist);
      auxiliar.lookAt(objetivo);
      auxiliar.updateMatrixWorld();
      const min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
      for (const p of esquinas) { const v = p.clone().project(auxiliar); min.min(v); max.max(v); }
      // corre el objetivo hacia el centro del dibujo, en el plano de la cámara
      const centroPantalla = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2 - corrimientoY, 0.5).unproject(auxiliar);
      objetivo.add(centroPantalla.sub(auxiliar.position).normalize().multiplyScalar(dist).add(auxiliar.position).sub(objetivo));
      dist *= Math.max((max.x - min.x) / 2 / lados, (max.y - min.y) / (arriba + lados));
    }
    return { objetivo, posicion: objetivo.clone().addScaledVector(dir, dist), dist };
  }

  const viaje = { t: 1, desdeT: new THREE.Vector3(), hastaT: new THREE.Vector3(), desdeP: new THREE.Vector3(), hastaP: new THREE.Vector3() };
  function avanzarViaje(paso) {
    if (viaje.t >= 1) return;
    viaje.t = Math.min(1, viaje.t + paso);
    const k = 1 - Math.pow(1 - viaje.t, 3);
    controles.target.lerpVectors(viaje.desdeT, viaje.hastaT, k);
    if (!viaje.orbita) { camara.position.lerpVectors(viaje.desdeP, viaje.hastaP, k); return; }
    // Cubo de vistas: ángulos y distancia interpolados, así la cámara rodea la casa y no la atraviesa.
    const [a, b] = viaje.orbita;
    let dt = b.theta - a.theta;
    dt = Math.atan2(Math.sin(dt), Math.cos(dt));
    esferica.set(a.radius + (b.radius - a.radius) * k, a.phi + (b.phi - a.phi) * k, a.theta + dt * k);
    camara.position.setFromSpherical(esferica).add(controles.target);
  }
  const esferica = new THREE.Spherical();

  // Último encuadre automático (objetivo y distancia): sirve para saber si el usuario se acercó o desplazó.
  const auto = { objetivo: new THREE.Vector3(), dist: 0 };
  function usuarioMovio() {
    if (!auto.dist) return false;
    const dist = camara.position.distanceTo(controles.target);
    return controles.target.distanceTo(auto.objetivo) > 0.3 || Math.abs(dist / auto.dist - 1) > 0.05;
  }

  // Límite del zoom out: la distancia a la que la casa completa entra con el mismo aire del encuadre
  // (LADOS) mirando desde cualquier ángulo que permite el giro. Más lejos no se puede alejar, así la casa
  // nunca queda chica, y en ese límite no se corta ni arriba ni abajo aunque se la gire.
  function distanciaSinCortes() {
    let maxima = 0;
    const dir = new THREE.Vector3();
    for (let polar = 0.04; polar <= controles.maxPolarAngle + 1e-6; polar += (controles.maxPolarAngle - 0.04) / 6)
      for (let giro = 0; giro < 2 * Math.PI; giro += Math.PI / 12)
        maxima = Math.max(maxima, calcularEncuadre(CAJAS, dir.setFromSphericalCoords(1, polar, giro)).dist);
    return maxima;
  }

  // Encuadre de la casa completa (punto de partida en los dos modos y límites del zoom).
  // Contorno real de la casa completa (vértices de todas las capas, también las que hoy están ocultas: así
  // ningún módulo que se pueda sumar queda cortado), cuando ya cargó todo.
  // Mucho más justo que CAJAS: con data-aire se deja un margen mínimo y parejo alrededor.
  let todoCargado = false;
  const contornoCasa = () => todoCargado ? [...capas.values()].flatMap(g => g.userData.vertices) : CAJAS;
  function encuadrar() {
    const e = calcularEncuadre(contornoCasa(), DIRECCION, AIRE);
    e.posicion = e.objetivo.clone().addScaledVector(DIRECCION, e.dist * ZOOM);
    controles.minDistance = e.dist * 0.3;
    controles.maxDistance = Math.max(e.dist * ZOOM, distanciaSinCortes());
    if (SEGUIR && capas.size) return seguirVisible(false);
    if (introDura) {  // durante la entrada (la página puede cambiar el tamaño del recuadro): cambia el destino, sin saltar
      viaje.hastaT.copy(e.objetivo);
      viaje.orbita[1] = new THREE.Spherical().setFromVector3(e.posicion.clone().sub(e.objetivo));
      auto.objetivo.copy(e.objetivo); auto.dist = e.dist * ZOOM;
      return;
    }
    viaje.t = 1;
    controles.target.copy(e.objetivo);
    camara.position.copy(e.posicion);
    auto.objetivo.copy(e.objetivo); auto.dist = e.dist * ZOOM;
    controles.update();
  }

  // Doble clic en un espacio vacío: vuelve al encuadre automático, con el ángulo inicial y animado.
  function reencuadrar() {
    if (SEGUIR && capas.size) {
      const dir = DIRECCION.clone();
      return seguirVisible(true, dir);
    }
    const e = calcularEncuadre(contornoCasa(), DIRECCION, AIRE);
    viaje.orbita = null; viaje.desdeT.copy(controles.target); viaje.hastaT.copy(e.objetivo);
    viaje.desdeP.copy(camara.position); viaje.hastaP.copy(e.objetivo).addScaledVector(DIRECCION, e.dist * ZOOM);
    viaje.t = 0;
    auto.objetivo.copy(e.objetivo); auto.dist = e.dist * ZOOM;
  }

  // Modo "seguir": encuadra las capas visibles, respetando el ángulo que eligió el usuario.
  function seguirVisible(animar, direccion) {
    const visibles = [...capas.values()].filter(g => g.visible);
    const activas = visibles.filter(g => !g.userData.fantasma);
    if (!activas.length) return;
    let dir = direccion || camara.position.clone().sub(controles.target).normalize();
    if (![dir.x, dir.y, dir.z].every(Number.isFinite) || !dir.lengthSq()) dir = DIRECCION.clone();
    const e = encuadreCombinado(activas.flatMap(g => g.userData.puntos), visibles.flatMap(g => g.userData.puntos), dir);
    viaje.orbita = null; viaje.desdeT.copy(controles.target); viaje.hastaT.copy(e.objetivo);
    viaje.desdeP.copy(camara.position); viaje.hastaP.copy(e.objetivo).addScaledVector(dir, e.dist * ZOOM);
    viaje.t = 0;
    auto.objetivo.copy(e.objetivo); auto.dist = e.dist * ZOOM;
    if (!animar) { avanzarViaje(1); controles.update(); }
  }

  // Encuadre combinado: la cámara se corre a mitad de camino entre el centro de la casa completa
  // y el centro de lo elegido. Lo elegido entra siempre con margen; los módulos en gris pueden
  // llegar casi al borde, pero quedan a la vista para tocarlos. Arriba se deja el aire de MARGEN_ARRIBA.
  const MARGEN_ELEGIDO = 0.8, MARGEN_GRIS = 0.95, CORRIMIENTO = 0.5;
  function centroEnPantalla(puntos, objetivo, dir, dist) {
    auxiliar.position.copy(objetivo).addScaledVector(dir, dist);
    auxiliar.lookAt(objetivo);
    auxiliar.updateMatrixWorld();
    const min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
    for (const p of puntos) { const v = p.clone().project(auxiliar); min.min(v); max.max(v); }
    const c = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2 - (Math.min(MARGEN_GRIS, MARGEN_ARRIBA) - MARGEN_GRIS) / 2, 0.5).unproject(auxiliar);
    return c.sub(auxiliar.position).normalize().multiplyScalar(dist).add(auxiliar.position);
  }
  // Cuánto se pasa un punto proyectado del recuadro permitido (más de 1 = queda afuera).
  const exceso = (v, margen) => Math.max(Math.abs(v.x) / margen, v.y > 0 ? v.y / Math.min(margen, MARGEN_ARRIBA) : -v.y / margen);
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
      for (const p of elegidos) m = Math.max(m, exceso(p.clone().project(auxiliar), MARGEN_ELEGIDO));
      for (const p of todos) m = Math.max(m, exceso(p.clone().project(auxiliar), MARGEN_GRIS));
      dist *= m;
    }
    return { objetivo, posicion: objetivo.clone().addScaledVector(dir, dist), dist };
  }

  function ajustarTamano() {
    const w = contenedor.clientWidth, h = contenedor.clientHeight || 420;
    if (!w) return;  // visor oculto (por ejemplo, en otra vista de la página): se encuadra al mostrarse
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
    if (visible) animarEntrada();
    renderer.setAnimationLoop(visible ? () => { const dt = reloj.getDelta(); avanzarViaje(dt / (introDura || 0.5)); if (viaje.t >= 1) introDura = 0; animarProyeccion(dt); animarEstilo(dt); actualizarPlanta(dt); controles.update(); limitarDesplazamiento(); dibujar(); ubicarEtiquetas(); } : null);
  }).observe(contenedor);

  // Animación de entrada: la primera vez que el visor se ve con la casa cargada, la cámara llega con un
  // acercamiento y un giro cortos y suaves, para que se note que el modelo se puede mover. Una sola vez por
  // visita. Si la persona toca el modelo o hace zoom mientras tanto, se corta y queda donde está.
  const ENTRADA = { giro: -0.35, alejar: 1.12, dura: 1.4 };  // radianes (~20°), factor de distancia, segundos
  let entradaHecha = false, introDura = 0;
  function animarEntrada() {
    if (entradaHecha || !visible || !capas.size || !contenedor.clientWidth) return;
    entradaHecha = true;
    ajustarTamano();  // deja la cámara en el encuadre final con el tamaño actual; el primer cuadro ya es el de partida
    const destino = camara.position.clone().sub(controles.target);
    const desde = destino.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ENTRADA.giro).multiplyScalar(ENTRADA.alejar);
    viaje.desdeT.copy(controles.target); viaje.hastaT.copy(controles.target);
    viaje.orbita = [new THREE.Spherical().setFromVector3(desde), new THREE.Spherical().setFromVector3(destino)];
    camara.position.copy(controles.target).add(desde);
    introDura = ENTRADA.dura;
    viaje.t = 0;
  }
  const cortarEntrada = () => { if (introDura) { viaje.t = 1; introDura = 0; } };

  // Teclado (notebooks sin mouse, accesibilidad): con el recuadro elegido (clic o Tab),
  // ← → giran, ↑ ↓ suben o bajan la cámara, + − acercan o alejan e Inicio (o 0) vuelve a la vista inicial.
  // Mantener apretada una flecha gira de forma continua.
  contenedor.tabIndex = 0;
  contenedor.setAttribute('aria-label', 'Vista 3D de la vivienda. Flechas: girar. Más y menos: acercar y alejar. Inicio: vista inicial.');
  renderer.domElement.addEventListener('pointerdown', () => contenedor.focus({ preventScroll: true }));
  const esfericaTeclado = new THREE.Spherical();
  function moverConTeclado(giro, altura, factor) {
    cortarEntrada();
    viaje.t = 1;
    esfericaTeclado.setFromVector3(camara.position.clone().sub(controles.target));
    esfericaTeclado.theta += giro;
    esfericaTeclado.phi = Math.min(controles.maxPolarAngle, Math.max(controles.minPolarAngle + 0.05, esfericaTeclado.phi + altura));
    esfericaTeclado.radius = Math.min(controles.maxDistance, Math.max(controles.minDistance, esfericaTeclado.radius * factor));
    camara.position.setFromSpherical(esfericaTeclado).add(controles.target);
    controles.update();
  }
  contenedor.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const paso = Math.PI / 36;  // 5°
    const acciones = {
      ArrowLeft: () => moverConTeclado(-paso, 0, 1), ArrowRight: () => moverConTeclado(paso, 0, 1),
      ArrowUp: () => moverConTeclado(0, -paso * 0.8, 1), ArrowDown: () => moverConTeclado(0, paso * 0.8, 1),
      '+': () => moverConTeclado(0, 0, 0.9), '=': () => moverConTeclado(0, 0, 0.9), '-': () => moverConTeclado(0, 0, 1.1),
      Home: () => reencuadrar(), '0': () => reencuadrar()
    };
    const accion = acciones[e.key];
    if (!accion) return;
    e.preventDefault();  // que las flechas no muevan la página
    accion();
  });
  renderer.domElement.addEventListener('pointerdown', cortarEntrada);
  renderer.domElement.addEventListener('wheel', cortarEntrada, { passive: true });

  // Carga en dos tandas: primero lo que se ve con la selección actual (capas elegidas y módulos
  // en gris), así la casa aparece cuanto antes; después el resto, en segundo plano.
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const pedidos = new Map(); // archivo -> Promise (cada archivo se pide una sola vez)
  function archivosNecesarios(s) {
    const activas = CAPAS.filter(c => c.seVe(s)).map(c => c.archivo);
    const grises = Object.entries(FANTASMAS).filter(([m]) => !s.has(m)).map(([, a]) => a);
    return [...new Set([...activas, ...grises])];
  }
  function cargar(archivo) {
    if (pedidos.has(archivo)) return pedidos.get(archivo);
    const pedido = loader.loadAsync(base + archivo + '.glb').then(gltf => {
      const grupo = gltf.scene;
      grupo.userData.archivo = archivo;
      grupo.traverse(o => {
        if (o.isMesh) {
          o.userData.capa = archivo;
          o.userData.grupo = grupo;
          o.userData.original = o.material;
          [].concat(o.material).forEach(desaturable);
          o.castShadow = true;
          o.receiveShadow = true;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(m => { if (m.transparent) o.castShadow = false; });
        }
      });
      grupo.userData.caja = new THREE.Box3().setFromObject(grupo);
      // esquinas de la caja de cada pieza: contorno más justo que la caja de toda la capa
      grupo.userData.puntos = [];
      grupo.userData.vertices = [];  // muestra de vértices reales (hasta ~1500 por pieza): contorno exacto para el encuadre fijo
      grupo.updateMatrixWorld(true);
      grupo.traverse(o => {
        if (!o.isMesh) return;
        const c = new THREE.Box3().setFromObject(o);
        for (const x of [c.min.x, c.max.x]) for (const y of [c.min.y, c.max.y]) for (const z of [c.min.z, c.max.z]) grupo.userData.puntos.push(new THREE.Vector3(x, y, z));
        // Solo vértices que forman triángulos: los modelos guardan vértices sueltos de piezas quitadas
        // (la platea, por ejemplo) que no se ven y agrandarían el contorno.
        const pos = o.geometry.attributes.position, ind = o.geometry.index;
        if (!pos) return;
        const total = ind ? ind.count : pos.count, paso = Math.max(1, Math.ceil(total / 1500));
        // Solo los que caen dentro de la caja medida de la casa: algunas capas traen piezas planas sueltas
        // en el piso, lejos de la casa (x ≈ −1, z ≈ 1), que no se ven y correrían el encuadre.
        for (let i = 0; i < total; i += paso) {
          const v = new THREE.Vector3().fromBufferAttribute(pos, ind ? ind.getX(i) : i).applyMatrix4(o.matrixWorld);
          if (CASA_HOLGADA.containsPoint(v)) grupo.userData.vertices.push(v);
        }
      });
      // La pérgola de Llegada se toca en toda su superficie, no solo sobre los tablones: una caja
      // invisible (solo para el mouse) cubre los espacios entre ellos. En "huella" se aplasta con la capa.
      if (CON_CAJA_DE_TOQUE.includes(archivo)) {
        const c = grupo.userData.caja, toque = new THREE.Mesh(new THREE.BoxGeometry(...c.getSize(new THREE.Vector3()).toArray()), new THREE.MeshBasicMaterial({ visible: false }));
        c.getCenter(toque.position);
        Object.assign(toque.userData, { capa: archivo, grupo, soloToque: true });
        grupo.add(toque);
      }
      grupo.visible = false;
      capas.set(archivo, grupo);
      escena.add(grupo);
      aplicar();
      if (visible && !entradaHecha) animarEntrada();
    }).catch(err => {
      console.error('Visor 3D: no se pudo cargar', archivo, err);
      estado.textContent = 'No se pudo cargar el modelo 3D.';
    });
    pedidos.set(archivo, pedido);
    return pedido;
  }
  let cargando = null;
  function cargarTodo() {
    if (cargando) return cargando;
    const primeros = archivosNecesarios(leerSeleccion());
    cargando = Promise.all(primeros.map(cargar))
      .then(() => Promise.all(ARCHIVOS.filter(a => !primeros.includes(a)).map(cargar)))
      .then(() => {
        todoCargado = true;
        if (SEGUIR || !contenedor.clientWidth) return;
        if (introDura) encuadrar();
        else if (!usuarioMovio()) reencuadrar();
      });
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

  // Estilo "caja": el volumen del módulo dibujado como una caja de líneas punteadas, como en un plano
  // se dibuja lo que está proyectado y todavía no se construyó.
  function cajaPunteada(g) {
    const c = g.userData.caja, tam = c.getSize(new THREE.Vector3());
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(tam.x, tam.y, tam.z)), CAJA_LINEA);
    c.getCenter(l.position);
    l.computeLineDistances();
    l.raycast = sinRayo;
    l.renderOrder = 2;
    g.add(l);
    return l;
  }
  const sinRayo = () => {};

  // Contorno de elegidos (data-resaltar-elegido="contorno"): la silueta de la caja del módulo. Son las
  // aristas de la caja entre una cara que mira a la cámara y otra que no: una línea cerrada, exacta con
  // cualquier zoom o ángulo. La caja se agranda 5 cm para que la línea no se pelee con los muros, y lo
  // que tapa otro módulo no se dibuja. Llegada (pérgola) no lleva contorno: su caja no es su forma.
  const SIN_CONTORNO = ['garage'];
  const HOLGURA_CONTORNO = 0.05;
  const contorno = new LineSegments2(new LineSegmentsGeometry(), CONTORNO_MAT);
  contorno.visible = false;
  contorno.frustumCulled = false;
  contorno.renderOrder = 4;
  contorno.raycast = sinRayo;
  contorno.layers.enable(1);  // nítido sobre el velo de "atenuar"
  escena.add(contorno);
  let cajaContorno = null, claveContorno = '';
  function actualizarContorno() {
    if (!contorno.visible || !cajaContorno) return;
    CONTORNO_MAT.resolution.set(contenedor.clientWidth, contenedor.clientHeight);
    const mn = cajaContorno.min, mx = cajaContorno.max, p = camara.position;
    // ¿La cara del eje e, lado 0 (mínimo) o 1 (máximo), mira a la cámara?
    const mira = (e, lado) => lado ? p.getComponent(e) > mx.getComponent(e) : p.getComponent(e) < mn.getComponent(e);
    const clave = [0, 1, 2].map(e => +mira(e, 0) + '' + +mira(e, 1)).join('');
    if (clave === claveContorno) return;  // las aristas solo cambian cuando cambia qué caras se ven
    claveContorno = clave;
    const pos = [], a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let k = 0; k < 3; k++) {
      const [j, l] = [0, 1, 2].filter(e => e !== k);
      for (const lj of [0, 1]) for (const ll of [0, 1]) {
        if (mira(j, lj) === mira(l, ll)) continue;
        a.setComponent(k, mn.getComponent(k)); b.setComponent(k, mx.getComponent(k));
        for (const [e, lado] of [[j, lj], [l, ll]]) { const v = (lado ? mx : mn).getComponent(e); a.setComponent(e, v); b.setComponent(e, v); }
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    contorno.geometry.dispose();
    contorno.geometry = new LineSegmentsGeometry().setPositions(pos);
  }
  function mostrarContorno(ids) {
    const cajas = ids.filter(m => !SIN_CONTORNO.includes(m)).map(m => capas.get(FANTASMAS[m])).filter(Boolean).map(g => g.userData.caja);
    if (!cajas.length) return;
    cajaContorno = cajas.reduce((u, c) => u.union(c), new THREE.Box3()).expandByScalar(HOLGURA_CONTORNO);
    cajaContorno.min.y = Math.max(cajaContorno.min.y, 0.005);  // sobre el piso, que también escribe profundidad
    claveContorno = '';
    contorno.visible = true;
  }

  // Barrido (data-barrido): al entrar el mouse en un módulo elegido, una franja de luz lo cruza una vez,
  // de izquierda a derecha de la pantalla y un poco hacia arriba.
  const DURA_BARRIDO = 0.9;
  let barrido = null;  // { sup, desde, hasta, t }
  function barrer(id) {
    const s = superpuesto(id, 'barrido'), g = capas.get(FANTASMAS[id]);
    if (!s || !g) return;
    const dir = new THREE.Vector3(1, 0.35, 0).normalize().applyQuaternion(camara.quaternion);
    const c = g.userData.caja;
    let min = Infinity, max = -Infinity;
    for (const x of [c.min.x, c.max.x]) for (const y of [c.min.y, c.max.y]) for (const z of [c.min.z, c.max.z]) {
      const v = x * dir.x + y * dir.y + z * dir.z; min = Math.min(min, v); max = Math.max(max, v);
    }
    const ancho = (max - min) * 0.12;
    BARRIDO_MAT.uniforms.uDir.value.copy(dir);
    BARRIDO_MAT.uniforms.uAncho.value = ancho;
    barrido = { sup: s, desde: min - 2 * ancho, hasta: max + 2 * ancho, t: 0 };
    BARRIDO_MAT.uniforms.uPos.value = barrido.desde;
    s.visible = true;
  }
  let resaltado = null;        // módulo bajo el mouse
  let afectados = new Set();   // el módulo bajo el mouse y, con data-dependencias, el que reacciona con él

  // Copias de los materiales originales: con el recorte de la animación de bajar, y semitransparentes
  // (vista previa de un módulo no elegido).
  const PLANO_BAJA = new THREE.Plane(new THREE.Vector3(0, -1, 0), TECHO);
  const clones = { baja: new Map(), previa: new Map() };
  function clon(tipo, m) {
    if (Array.isArray(m)) return m.map(x => clon(tipo, x));
    if (!clones[tipo].has(m)) {
      const c = m.clone();
      c.clipIntersection = false;
      c.clippingPlanes = tipo === 'baja' ? [PLANO_BAJA] : [];
      if (tipo === 'previa') { c.transparent = true; c.opacity = 0.6 * m.opacity; c.depthWrite = false; }
      clones[tipo].set(m, c);
    }
    return clones[tipo].get(m);
  }

  // Pinta una capa según su estado: elegida (materiales propios) o módulo no elegido (el gris del
  // estilo elegido, más marcado si está bajo el mouse). En "huella" el módulo no elegido queda chato
  // y se levanta al pasar el mouse; en "planta" solo se ve su huella en el piso.
  function pintar(g) {
    const gris = !!g.userData.fantasma, bajo = gris && afectados.has(g.userData.moduloFantasma);
    const primera = g.userData.escalaObjetivo === undefined;
    g.userData.escalaObjetivo = gris && GRIS === 'huella' && !bajo ? 0.04 : 1;
    if (primera) g.scale.y = g.userData.escalaObjetivo;
    const enPlanta = gris && GRIS === 'planta', enFoco = bajo && ATENUAR;
    g.traverse(o => {
      if (!o.isMesh || o.userData.soloToque || o.userData.deEstilo) return;
      o.material = !gris ? o.userData.original : !bajo ? FANTASMA : VISTA_PREVIA ? clon('previa', o.userData.original) : FANTASMA_RESALTADO;
      // En "planta" las piezas no se ven pero se pueden tocar (el rayo no mira la visibilidad).
      o.visible = !enPlanta || bajo;
      o.castShadow = !gris && !(Array.isArray(o.material) ? o.material : [o.material]).some(m => m.transparent);
      o.renderOrder = gris ? 1 : 0;
      if (enFoco) o.layers.enable(1); else o.layers.disable(1);
    });
    const conCaja = gris && GRIS === 'caja';
    if (conCaja && !g.userData.cajaLineas) g.userData.cajaLineas = cajaPunteada(g);
    if (g.userData.cajaLineas) { g.userData.cajaLineas.visible = conCaja; g.userData.cajaLineas.material = bajo ? CAJA_LINEA_RESALTADA : CAJA_LINEA; }
    if (enPlanta && !g.userData.planta) g.userData.planta = huellaPlanta(g);
    if (g.userData.planta) {
      g.userData.planta.visible = enPlanta;
      g.userData.planta.userData.relleno.material = bajo ? PLANTA_RELLENO_RESALTADO : PLANTA_RELLENO;
      g.userData.planta.traverse(o => { if (enFoco) o.layers.enable(1); else o.layers.disable(1); });
    }
  }
  function ponerFantasma(grupo, si) { grupo.userData.fantasma = si; pintar(grupo); }

  // Estilo "planta": la huella del módulo en el piso y su marca (data-marca-planta). El relleno y las marcas
  // son tocables: llevan la capa y el grupo como las piezas del modelo. Medidas y bordes: actualizarPlanta.
  function huellaPlanta(g) {
    const h = new THREE.Group();
    const toque = { capa: g.userData.archivo, grupo: g, deEstilo: true };
    const relleno = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), PLANTA_RELLENO);
    relleno.renderOrder = 1;
    Object.assign(relleno.userData, toque);
    h.add(relleno);
    // + en el piso (marca "piso"), que se gira para leerse derecho desde la cámara (si no, parece una ×).
    const signos = [];
    for (const [w, d] of [[1, 0.16], [0.16, 1]]) {
      const signo = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), PLANTA_SIGNO);
      signo.raycast = sinRayo;
      signo.userData.deEstilo = true;
      signo.renderOrder = 2;
      h.add(signo);
      signos.push(signo);
    }
    // Nombre y círculo con +, pintados en el piso: los tapa lo que esté delante (depthTest) y siguen el plano.
    const nombre = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), nuevoMatMarca());
    const circulo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), nuevoMatMarca(texturaCirculo()));
    circulo.scale.set(CIRCULO, 1, CIRCULO);
    for (const m of [nombre, circulo]) { m.renderOrder = 3; Object.assign(m.userData, toque); m.visible = false; h.add(m); }
    Object.assign(h.userData, { id: ARCHIVO_A_MODULO[g.userData.archivo], relleno, signos, nombre, circulo, clave: '' });
    g.add(h);
    return h;
  }

  // Las cajas de los módulos difieren unos centímetros (espesores de muro): las coordenadas a menos de
  // 20 cm se unifican, así los vecinos comparten el borde exacto. Los bordes se dibujan una sola vez por
  // tramo y cada tramo empieza y termina con raya en sus vértices.
  const ARCHIVO_A_MODULO = Object.fromEntries(Object.entries(FANTASMAS).map(([id, a]) => [a, id]));
  const CAJA_INICIO = { x0: 5.32, x1: 10.88, z0: -16.98, z1: -6.83 };
  function agrupar(valores) {
    const v = [...new Set(valores)].sort((a, b) => a - b), mapa = new Map();
    let grupo = [];
    const cerrar = () => { const m = grupo.reduce((a, b) => a + b, 0) / grupo.length; grupo.forEach(x => mapa.set(x, m)); };
    for (const x of v) { if (grupo.length && x - grupo[grupo.length - 1] >= 0.2) { cerrar(); grupo = []; } grupo.push(x); }
    if (grupo.length) cerrar();
    return mapa;
  }
  let rects = new Map(), claveRects = '';
  function medirRects() {
    const ids = Object.keys(FANTASMAS).filter(id => capas.has(FANTASMAS[id]));
    if (ids.join() === claveRects) return false;
    claveRects = ids.join();
    const cajas = ids.map(id => capas.get(FANTASMAS[id]).userData.caja);
    const mx = agrupar(cajas.flatMap(c => [c.min.x, c.max.x])), mz = agrupar(cajas.flatMap(c => [c.min.z, c.max.z]));
    rects = new Map(ids.map((id, i) => { const c = cajas[i]; return [id, { x0: mx.get(c.min.x), x1: mx.get(c.max.x), z0: mz.get(c.min.z), z1: mz.get(c.max.z) }]; }));
    return true;
  }
  const bordesPlanta = new THREE.LineSegments(new THREE.BufferGeometry(), CAJA_LINEA);
  bordesPlanta.raycast = sinRayo; bordesPlanta.renderOrder = 2; bordesPlanta.frustumCulled = false; bordesPlanta.visible = false;
  escena.add(bordesPlanta);
  const RAYA = 0.3, HUECO = 0.18;
  function armarBordes(lista) {
    const xs = lista.flatMap(r => [r.x0, r.x1]), zs = lista.flatMap(r => [r.z0, r.z1]);
    const tramos = new Map();
    const agregar = (a, b) => tramos.set([a, b].map(p => p.map(v => v.toFixed(3)).join()).sort().join('|'), [a, b]);
    const cortes = (desde, hasta, valores) => [desde, ...[...new Set(valores)].filter(v => v > desde + 1e-6 && v < hasta - 1e-6).sort((a, b) => a - b), hasta];
    for (const r of lista) {
      for (const z of [r.z0, r.z1]) { const c = cortes(r.x0, r.x1, xs); for (let i = 1; i < c.length; i++) agregar([c[i - 1], z], [c[i], z]); }
      for (const x of [r.x0, r.x1]) { const c = cortes(r.z0, r.z1, zs); for (let i = 1; i < c.length; i++) agregar([x, c[i - 1]], [x, c[i]]); }
    }
    const pos = [], dist = [];
    tramos.forEach(([a, b]) => {
      const largo = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(0, Math.round((largo - RAYA) / (RAYA + HUECO)));
      pos.push(a[0], 0.03, a[1], b[0], 0.03, b[1]);
      dist.push(0, n * (RAYA + HUECO) + RAYA);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(dist, 1));
    bordesPlanta.geometry.dispose();
    bordesPlanta.geometry = geo;
  }

  // Marcas en el piso: texturas dibujadas en un canvas (en blanco; el color lo pone el material).
  const TEXTO_ALTO = 0.34, CIRCULO = 0.4, SEPARACION = 0.14, RETIRO = 0.3, FUERA = 0.25;
  const GRIS_MARCA = new THREE.Color(0x585858);
  const nuevoMatMarca = (map = null) => new THREE.MeshBasicMaterial({ map, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    color: GRIS_MARCA, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const ANISO = renderer.capabilities.getMaxAnisotropy();
  function texturaDe(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = ANISO;
    return t;
  }
  let circuloTex = null;
  function texturaCirculo() {
    if (circuloTex) return circuloTex;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    x.strokeStyle = '#fff'; x.lineWidth = 6;
    x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 7;
    x.beginPath(); x.moveTo(40, 64); x.lineTo(88, 64); x.moveTo(64, 40); x.lineTo(64, 88); x.stroke();
    return (circuloTex = texturaDe(c));
  }
  // Mayúsculas espaciadas en Inter 700, como un rótulo de plano. Devuelve la textura y las medidas en metros.
  const FUENTE = 96, ESPACIADO = 0.16;
  function texturaTexto(texto) {
    const c = document.createElement('canvas'), x = c.getContext('2d'), fuente = `700 ${FUENTE}px Inter, system-ui, sans-serif`;
    x.font = fuente;
    const anchos = [...texto].map(ch => x.measureText(ch).width), esp = FUENTE * ESPACIADO;
    const largo = anchos.reduce((a, b) => a + b, 0) + esp * (texto.length - 1), margen = 8;
    c.width = Math.ceil(largo) + margen * 2; c.height = Math.ceil(FUENTE * 1.3);
    x.font = fuente; x.fillStyle = '#fff'; x.textBaseline = 'middle';
    let px = margen;
    [...texto].forEach((ch, i) => { x.fillText(ch, px, c.height / 2 + FUENTE * 0.04); px += anchos[i] + esp; });
    const m = TEXTO_ALTO / FUENTE;
    return { tex: texturaDe(c), ancho: c.width * m, alto: c.height * m, largo: largo * m };
  }
  let fuenteLista = !document.fonts;
  if (document.fonts) document.fonts.load(`700 ${FUENTE}px Inter`).catch(() => {}).then(() => { fuenteLista = true; });

  // Dónde va el nombre: sobre un lado libre (que no da a otro módulo ni a Inicio), primero los largos.
  // Adentro, desde la esquina más alejada del centro de la casa; si no entra, por fuera y centrado.
  function ubicarMarca(id, largoMarca) {
    const r = rects.get(id), lx = r.x1 - r.x0, lz = r.z1 - r.z0, largoMax = Math.max(lx, lz);
    const dentro = (q, x, z) => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1;
    const ocupado = (x, z) => dentro(CAJA_INICIO, x, z) || [...rects].some(([o, q]) => o !== id && dentro(q, x, z));
    const lados = [['z', r.z0, -1, lx], ['z', r.z1, 1, lx], ['x', r.x0, -1, lz], ['x', r.x1, 1, lz]].map(([fijo, v, fuera, largo]) => {
      const mx = fijo === 'z' ? (r.x0 + r.x1) / 2 : v + 0.6 * fuera, mz = fijo === 'z' ? v + 0.6 * fuera : (r.z0 + r.z1) / 2;
      return { fijo, v, fuera, largo, libre: !ocupado(mx, mz), lejos: Math.hypot(mx - centro.x, mz - centro.z) };
    });
    const puntaje = l => l.libre * 2 + (l.largo === largoMax);
    lados.sort((a, b) => puntaje(b) - puntaje(a) || b.lejos - a.lejos);
    const l = lados[0];
    // Sobre el eje del lado: arranca en la punta más alejada del centro y avanza hacia la otra (u).
    const [a0, a1, c] = l.fijo === 'z' ? [r.x0, r.x1, centro.x] : [r.z0, r.z1, centro.z];
    const desdeA0 = Math.abs(a0 - c) >= Math.abs(a1 - c);
    const sentido = desdeA0 ? 1 : -1, esquina = desdeA0 ? a0 : a1;
    const u = l.fijo === 'z' ? [sentido, 0] : [0, sentido];
    const n = l.fijo === 'z' ? [0, -l.fuera] : [-l.fuera, 0];  // hacia adentro
    let inicio, corrido;
    if (largoMarca + 2 * RETIRO <= l.largo) { inicio = esquina + sentido * RETIRO; corrido = RETIRO + TEXTO_ALTO / 2; }
    else { inicio = (a0 + a1) / 2 - sentido * largoMarca / 2; corrido = -(FUERA + TEXTO_ALTO / 2); }
    const base = l.fijo === 'z' ? [inicio, l.v] : [l.v, inicio];
    return { base: [base[0] + n[0] * corrido, base[1] + n[1] * corrido], u };
  }

  // Cada cuadro: medidas, bordes y marcas (giro para leerse derecho, color al pasar el mouse). Si los
  // nombres se pisan en pantalla o la cámara está muy baja, se esconden con un fundido.
  let claveBordes = '', nombresVisibles = true;
  const dirCam = new THREE.Vector3(), esq = new THREE.Vector3();
  function actualizarPlanta(dt) {
    const enPlanta = GRIS === 'planta';
    bordesPlanta.visible = enPlanta;
    if (!enPlanta) return;
    const cambiaron = medirRects();
    const huellas = [...capas.values()].filter(g => g.userData.planta && g.visible && g.userData.planta.visible).map(g => g.userData.planta);
    const clave = claveRects + '|' + huellas.map(h => h.userData.id).sort().join();
    if (clave !== claveBordes || cambiaron) { claveBordes = clave; armarBordes(huellas.map(h => rects.get(h.userData.id)).filter(Boolean)); }
    camara.getWorldDirection(dirCam);
    const giroCam = Math.atan2(-dirCam.x, -dirCam.z);
    const elevacion = Math.asin(Math.min(1, -dirCam.y)) * 180 / Math.PI;
    const conNombre = (MARCA_PLANTA === 'nombre' || MARCA_PLANTA === 'ambos') && fuenteLista;
    const conCirculo = MARCA_PLANTA === 'circulo' || MARCA_PLANTA === 'ambos';
    const W = contenedor.clientWidth, H = contenedor.clientHeight, enPantalla = [];
    let altoMin = Infinity;
    for (const h of huellas) {
      const d = h.userData, r = rects.get(d.id);
      if (!r) continue;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      if (d.clave !== claveRects) {
        d.clave = claveRects;
        d.relleno.position.set(cx, 0.02, cz); d.relleno.scale.set(r.x1 - r.x0, 1, r.z1 - r.z0);
        const lado = Math.max(0.3, Math.min(r.x1 - r.x0, r.z1 - r.z0) * 0.2);
        d.signos.forEach(s => { s.position.set(cx, 0.035, cz); s.scale.set(lado, 1, lado); });
        d.ubicacion = null;
      }
      d.signos.forEach(s => { s.visible = MARCA_PLANTA === 'piso'; s.rotation.y = giroCam; });
      const color = afectados.has(d.id) ? ACENTO : GRIS_MARCA;
      d.nombre.material.color.copy(color); d.circulo.material.color.copy(color);
      d.circulo.visible = conCirculo; d.nombre.visible = conNombre;
      d.circulo.material.opacity = 1;
      d.circulo.rotation.y = giroCam;
      if (MARCA_PLANTA === 'circulo') d.circulo.position.set(cx, 0.04, cz);
      if (!conNombre) continue;
      if (!d.texto) {
        d.texto = texturaTexto(NOMBRES[d.id].replace('ADD. ', ''));
        d.nombre.material.map = d.texto.tex; d.nombre.material.needsUpdate = true;
        d.nombre.scale.set(d.texto.ancho, 1, d.texto.alto);
      }
      const previo = MARCA_PLANTA === 'ambos' ? CIRCULO + SEPARACION : 0;
      if (!d.ubicacion || d.ubicacion.forma !== MARCA_PLANTA) d.ubicacion = { forma: MARCA_PLANTA, ...ubicarMarca(d.id, previo + d.texto.largo) };
      const { base, u } = d.ubicacion;
      // El texto corre a lo largo de u y la parte de arriba de las letras queda en (u.z, −u.x): si eso
      // apunta hacia la cámara, se lee al revés y se da vuelta. El círculo va siempre antes del nombre,
      // en el sentido de lectura: dado vuelta, pasa a la otra punta.
      let ux = u[0], uz = u[1];
      const vuelta = uz * dirCam.x - ux * dirCam.z < 0;
      if (vuelta) { ux = -ux; uz = -uz; }
      const tc = vuelta ? d.texto.largo + SEPARACION + CIRCULO / 2 : CIRCULO / 2;
      const t = vuelta ? d.texto.largo / 2 : previo + d.texto.largo / 2, nx = base[0] + u[0] * t, nz = base[1] + u[1] * t;
      if (conCirculo) d.circulo.position.set(base[0] + u[0] * tc, 0.04, base[1] + u[1] * tc);
      d.nombre.position.set(nx, 0.04, nz);
      d.nombre.rotation.y = Math.atan2(-uz, ux);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const su of [-1, 1]) for (const sv of [-1, 1]) {
        const a = su * d.texto.largo / 2, b = sv * TEXTO_ALTO / 2;
        esq.set(nx + ux * a + uz * b, 0.04, nz + uz * a - ux * b).project(camara);
        const px = (esq.x + 1) / 2 * W, py = (1 - esq.y) / 2 * H;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      enPantalla.push([x0, y0, x1, y1]);
      // Alto de las letras en pantalla (de la base al tope, en el centro del nombre).
      esq.set(nx + uz * TEXTO_ALTO / 2, 0.04, nz - ux * TEXTO_ALTO / 2).project(camara);
      const ax = (esq.x + 1) / 2 * W, ay = (1 - esq.y) / 2 * H;
      esq.set(nx - uz * TEXTO_ALTO / 2, 0.04, nz + ux * TEXTO_ALTO / 2).project(camara);
      altoMin = Math.min(altoMin, Math.hypot((esq.x + 1) / 2 * W - ax, (1 - esq.y) / 2 * H - ay));
    }
    // Con margen de vuelta (histéresis), para que no titilen en el límite.
    const m = nombresVisibles ? 0 : 10;
    const sePisan = enPantalla.some((a, i) => enPantalla.some((b, j) => j > i && a[0] - m < b[2] && b[0] - m < a[2] && a[1] - m < b[3] && b[1] - m < a[3]));
    nombresVisibles = !sePisan && altoMin > (nombresVisibles ? 5 : 6.5) && elevacion > (nombresVisibles ? 25 : 30);
    const k = 1 - Math.exp(-dt * 10);
    for (const h of huellas) { const mat = h.userData.nombre.material; mat.opacity += ((nombresVisibles ? 1 : 0) - mat.opacity) * k; }
  }

  // Recorte de una capa elegida por zona (animación de crecer): borra lo que está
  // dentro de la zona del módulo y por encima de una altura. Los planos se combinan por intersección:
  // se borra solo lo que cumple todos a la vez, así el resto de la capa (el Inicio que traen) no se toca.
  // En three.js un plano borra donde normal·p + constante < 0.
  const ZONAS = {
    social: [[[0, 0, -1], -6.8]],                    // z > −6,8
    suite:  [[[-1, 0, 0], 9.4], [[0, 0, 1], 12.1]],  // x > 9,4 y z < −12,1
    grow:   [[[0, 0, -1], -12.2]],                   // z > −12,2 (dentro de CRECER)
    rest:   [[[0, 0, 1], 12.2]]                      // z < −12,2 (dentro de CRECER)
  };
  const CAPAS_PURAS = ['DESCANSO', 'AMENITIES_COCHERA', 'AMENITIES_ASADOR'];
  const zonaDe = (id, archivo) => CAPAS_PURAS.includes(archivo) ? [] : ZONAS[id] || [];
  // Capa elegida en la que está dibujado el módulo, según la selección.
  function capaDe(id, s) {
    const a = { social: s.has('suite') ? 'CONFORT_ENCUENTRO' : 'ENCUENTRO', suite: s.has('social') ? 'CONFORT_ENCUENTRO' : 'CONFORT',
      rest: s.has('grow') ? 'CRECER' : 'DESCANSO', grow: 'CRECER', garage: 'AMENITIES_COCHERA', asador: 'AMENITIES_ASADOR' }[id];
    return a && capas.has(a) ? a : null;
  }
  const ARRIBA = new THREE.Vector3(0, -1, 0);
  function planosDe(archivo) {
    const g = capas.get(archivo);
    if (!g.userData.planos) {
      // Arranca sin borrar nada: el primero borra solo por encima de 1000 m.
      const planos = [new THREE.Plane(ARRIBA, 1000), new THREE.Plane(ARRIBA, -1000), new THREE.Plane(ARRIBA, -1000)];
      g.traverse(o => {
        if (!o.isMesh || o.userData.soloToque || o.userData.deEstilo) return;
        for (const m of [].concat(o.userData.original)) { m.clippingPlanes = planos; m.clipIntersection = true; m.needsUpdate = true; }
      });
      g.userData.planos = planos;
    }
    return g.userData.planos;
  }
  function recortar(archivo, zona, altura) {
    const p = planosDe(archivo);
    p[0].set(ARRIBA, altura);
    for (let i = 1; i < 3; i++) {
      const z = zona[i - 1];
      if (z) { p[i].normal.set(...z[0]); p[i].constant = z[1]; } else p[i].set(ARRIBA, -1000);  // un plano que borra todo no limita
    }
  }
  const sinRecortar = archivo => { const g = capas.get(archivo); if (g && g.userData.planos) recortar(archivo, [], 1000); };

  // Copia de la geometría propia de un módulo, para dibujarla encima (resaltado de elegidos, vista previa,
  // destello, pulso y animaciones). relleno: un material, o una función que recibe el material original.
  function construirSuperpuesto(id, relleno) {
    const g = capas.get(FANTASMAS[id]);
    if (!g) return null;
    const sup = new THREE.Group();
    g.updateWorldMatrix(true, true);
    const inversa = g.matrixWorld.clone().invert();  // sin la escala de "huella"
    g.traverse(o => {
      if (!o.isMesh || o.userData.soloToque || o.userData.deEstilo) return;
      const m = inversa.clone().multiply(o.matrixWorld);
      const material = typeof relleno === 'function' ? relleno(o.userData.original) : relleno;
      // Las piezas repetidas (por ejemplo, las varillas de la pérgola de Llegada) vienen como una sola
      // malla con sus copias: hay que copiarla con todas sus posiciones, si no queda una varilla suelta.
      const malla = o.isInstancedMesh ? new THREE.InstancedMesh(o.geometry, material, o.count) : new THREE.Mesh(o.geometry, material);
      if (o.isInstancedMesh) malla.instanceMatrix.copy(o.instanceMatrix);
      malla.matrixAutoUpdate = false; malla.matrix.copy(m); malla.renderOrder = 2;
      malla.raycast = sinRayo;
      sup.add(malla);
    });
    sup.visible = false;
    escena.add(sup);
    return sup;
  }
  // Tipos de superpuesto: tinte · barrido · lavado (vista previa de quitar) · foco (la marca del módulo que
  // el velo de "atenuar" respeta) · baja (animación de quitar) · pulso (pista) · destello.
  const superpuestos = new Map();  // "id|tipo" -> grupo
  function superpuesto(id, tipo) {
    const clave = id + '|' + tipo;
    if (!superpuestos.has(clave)) {
      const relleno = { tinte: TINTE, barrido: BARRIDO_MAT, lavado: LAVADO, pulso: PULSO_MAT, destello: DESTELLO_MAT,
        foco: mascara, baja: m => clon('baja', m) }[tipo];
      const s = construirSuperpuesto(id, relleno);
      if (!s) return null;
      // Lo que acompaña al resaltado queda nítido sobre el velo de "atenuar"; el foco (la marca) va en su capa.
      if (tipo === 'foco') s.traverse(o => o.layers.set(2));
      else if (DE_HOVER.includes(tipo)) s.traverse(o => o.layers.enable(1));
      superpuestos.set(clave, s);
    }
    return superpuestos.get(clave);
  }
  const DE_HOVER = ['tinte', 'barrido', 'lavado', 'foco'];
  function ocultarHover() {
    superpuestos.forEach((s, clave) => { if (DE_HOVER.includes(clave.split('|')[1])) { s.visible = false; s.position.y = 0; } });
    contorno.visible = false; cajaContorno = null; claveContorno = '';
    barrido = null;
  }

  let destello = null;
  function destellar(id) {
    const s = superpuesto(id, 'destello');
    if (!s) return;
    if (destello) destello.sup.visible = false;
    destello = { sup: s, t: 0 };
    s.visible = true;
  }

  // Animaciones de sumar (el módulo crece desde el piso) y quitar (baja hasta su gris).
  const DURA_CRECER = 0.65, DURA_BAJAR = 0.45;
  const crecimientos = new Map();  // archivo -> { zona, desde, t }
  function crecer(id, s) {
    const archivo = capaDe(id, s);
    if (!archivo) return;
    const c = { zona: zonaDe(id, archivo), desde: 0, t: 0 };
    crecimientos.set(archivo, c);
    recortar(archivo, c.zona, c.desde);
  }
  let bajada = null;
  function bajar(id) {
    const s = superpuesto(id, 'baja');
    if (!s) return;
    if (bajada) bajada.sup.visible = false;
    bajada = { sup: s, t: 0, hasta: 0 };
    PLANO_BAJA.constant = TECHO;
    s.visible = true;
  }

  // Pista inicial (data-pista): los módulos no elegidos laten una vez y aparece un cartelito abajo.
  const pista = document.createElement('div');
  pista.className = 'visor-3d-pista';
  pista.textContent = matchMedia('(pointer: fine)').matches ? 'Hacé clic en un módulo para sumarlo' : 'Tocá un módulo para sumarlo';
  contenedor.appendChild(pista);
  let pistaHecha = false, pulso = null;
  function mostrarPista() {
    pistaHecha = true;
    const s = leerSeleccion();
    pulso = { sups: Object.keys(FANTASMAS).filter(id => !s.has(id)).map(id => superpuesto(id, 'pulso')).filter(Boolean), t: 0 };
    pulso.sups.forEach(x => { x.visible = true; });
    pista.classList.add('visible');
    clearTimeout(pista.reloj);
    pista.reloj = setTimeout(ocultarPista, 6000);
  }
  function ocultarPista() { pista.classList.remove('visible'); }

  // Mini tutorial del celular (22/10): un renglón sin recuadro abajo del visor, una vez por visita.
  //   paso 1, al ver la casa por primera vez: "Tocá un módulo para ver más";
  //   paso 2, después del primer toque a un módulo: "Doble tap para seleccionar" (o "para quitar");
  //   con el primer doble tap que suma o quita, se va hasta la próxima visita (sessionStorage: una recarga no lo repite).
  //   Si después dos toques al mismo módulo llegan lentos (no le salió el doble tap), el paso 2 vuelve una vez.
  // En la computadora no aparece (ahí es un clic).
  const aviso = document.createElement('div');
  aviso.className = 'visor-3d-pista visor-3d-aviso';
  aviso.setAttribute('aria-hidden', 'true');
  aviso.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="6.5"/></svg><span></span>';
  contenedor.appendChild(aviso);
  const CLAVE_TUTORIAL = 'add3d-tutorial-hecho';
  let tutorialHecho = matchMedia('(pointer: fine)').matches;
  try { tutorialHecho = tutorialHecho || sessionStorage.getItem(CLAVE_TUTORIAL) === '1'; } catch (e) { /* sin almacenamiento: se muestra igual */ }
  let paso1Mostrado = false, recordatorioUsado = false, ultimoToque = null;
  function mostrarAviso(texto) {
    aviso.lastChild.textContent = texto;
    aviso.classList.add('visible');
  }
  const textoPaso2 = id => 'Doble tap para ' + (leerSeleccion().has(id) ? 'quitar' : 'seleccionar');
  function ocultarAviso() { aviso.classList.remove('visible'); }
  function terminarTutorial() {
    ocultarAviso();
    if (tutorialHecho) return;
    tutorialHecho = true;
    try { sessionStorage.setItem(CLAVE_TUTORIAL, '1'); } catch (e) { /* solo dura esta página */ }
  }

  let objetivoVelo = 0;
  function animarEstilo(dt) {
    const k = 1 - Math.exp(-dt * 12);
    if (barrido) {
      barrido.t = Math.min(1, barrido.t + dt / DURA_BARRIDO);
      const e = barrido.t < 0.5 ? 2 * barrido.t * barrido.t : 1 - Math.pow(-2 * barrido.t + 2, 2) / 2;
      BARRIDO_MAT.uniforms.uPos.value = barrido.desde + (barrido.hasta - barrido.desde) * e;
      if (barrido.t >= 1) { barrido.sup.visible = false; barrido = null; }
    }
    capas.forEach(g => {
      const obj = g.userData.escalaObjetivo ?? 1;
      g.scale.y = Math.abs(g.scale.y - obj) > 0.002 ? g.scale.y + (obj - g.scale.y) * k : obj;
    });
    nivelVelo += (objetivoVelo - nivelVelo) * k;
    if (destello) {
      destello.t += dt;
      DESTELLO_MAT.opacity = 0.45 * Math.max(0, 1 - destello.t / 0.9);
      if (destello.t >= 0.9) { destello.sup.visible = false; destello = null; }
    }
    crecimientos.forEach((c, archivo) => {
      c.t = Math.min(1, c.t + dt / DURA_CRECER);
      const e = 1 - Math.pow(1 - c.t, 3);
      if (c.t >= 1) { crecimientos.delete(archivo); sinRecortar(archivo); }
      else recortar(archivo, c.zona, c.desde + (TECHO - c.desde) * e);
    });
    if (bajada) {
      bajada.t = Math.min(1, bajada.t + dt / DURA_BAJAR);
      PLANO_BAJA.constant = TECHO + (bajada.hasta - TECHO) * (1 - Math.pow(1 - bajada.t, 2));
      if (bajada.t >= 1) { bajada.sup.visible = false; bajada = null; }
    }
    if (PISTA && !pistaHecha && !estado.textContent && capas.size === ARCHIVOS.length) mostrarPista();
    // Paso 1 del tutorial: esto solo corre con el visor en pantalla, así que aparece cuando se ve la casa.
    if (!tutorialHecho && !paso1Mostrado && !PISTA && !estado.textContent && capas.size === ARCHIVOS.length) {
      paso1Mostrado = true;
      mostrarAviso('Tocá un módulo para ver más');
    }
    if (pulso) {
      pulso.t += dt;
      PULSO_MAT.opacity = 0.32 * Math.pow(Math.sin(Math.PI * pulso.t / 0.8), 2);
      if (pulso.t >= 1.6) { pulso.sups.forEach(x => { x.visible = false; }); pulso = null; }
    }
  }
  function refrescarEstilo() {
    sol.castShadow = SOMBRAS;
    piso.visible = SOMBRAS;
    resaltado = null;
    afectados = new Set();
    objetivoVelo = 0;
    ocultarHover();
    if (!PISTA) { pistaHecha = false; ocultarPista(); }
    capas.forEach(pintar);
  }
  function dibujar() {
    actualizarContorno();
    if (nivelVelo < 0.01) { DESATURAR.value = 0; renderer.render(escena, camara); return; }
    const sombras = renderer.shadowMap.autoUpdate;
    renderer.autoClear = false;
    if (ATENUAR_BN) {
      renderer.getDrawingBufferSize(TAM);
      if (colorCasa.width !== TAM.x || colorCasa.height !== TAM.y) colorCasa.setSize(TAM.x, TAM.y);
      DESATURAR.value = 0;
      renderer.setRenderTarget(colorCasa);
      renderer.clear();
      renderer.render(escena, camara);
      renderer.setRenderTarget(null);
      renderer.shadowMap.autoUpdate = false;
    }
    // La casa (desaturada en "bn"), la marca del módulo, el color devuelto al módulo y el velo fuera de la marca.
    DESATURAR.value = ATENUAR_BN ? nivelVelo : 0;
    renderer.clear();
    renderer.render(escena, camara);
    renderer.shadowMap.autoUpdate = false;
    camara.layers.set(2);
    renderer.render(escena, camara);
    if (ATENUAR_BN) renderer.render(escenaColor, camaraVelo);
    // En "bn" el resto ya se desaturó y aclaró: el velo casi no hace falta.
    velo.material.opacity = (ATENUAR_BN ? 0.08 : 0.55) * nivelVelo;
    renderer.render(escenaVelo, camaraVelo);
    // Por último, lo de la capa 1 (contorno, el gris que reacciona con data-dependencias), nítido.
    camara.layers.set(1);
    renderer.render(escena, camara);
    camara.layers.set(0);
    renderer.shadowMap.autoUpdate = sombras;
    renderer.autoClear = true;
  }


  // Etiquetas sobre cada módulo (data-etiquetas="si"): + para sumar, ✓ elegido. Se tocan como el módulo.
  const etiquetas = document.createElement('div');
  etiquetas.className = 'visor-3d-etiquetas';
  contenedor.appendChild(etiquetas);
  const chips = {};
  const ANCLA_INICIO = new THREE.Vector3(7.4, 3.4, -9.6);
  for (const id of ['base', ...Object.keys(FANTASMAS)]) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'visor-3d-chip'; b.dataset.modulo = id; b.hidden = true;
    b.addEventListener('click', e => { e.stopPropagation(); alternar(id); });
    b.addEventListener('pointerenter', () => {
      resaltar(id !== 'base' ? id : null);
      const r = b.getBoundingClientRect(), c = contenedor.getBoundingClientRect();
      mostrarTooltip(id, r.left - c.left, r.bottom - c.top - 10);
    });
    b.addEventListener('pointerleave', () => { resaltar(null); ocultarTooltip(); });
    etiquetas.appendChild(b);
    chips[id] = b;
  }
  const ancla = new THREE.Vector3();
  function ubicarEtiquetas() {
    const W = contenedor.clientWidth, H = contenedor.clientHeight;
    girarCubo();
    // Con data-marca-inicio="etiqueta", INICIO queda rotulado aunque las etiquetas estén apagadas.
    const soloInicio = !ETIQUETAS && MARCA_INICIO === 'etiqueta';
    etiquetas.hidden = (!ETIQUETAS && !soloInicio) || !!estado.textContent;
    if (etiquetas.hidden) return;
    const s = leerSeleccion();
    for (const [id, b] of Object.entries(chips)) {
      if (soloInicio && id !== 'base') { b.hidden = true; continue; }
      if (id === 'base') ancla.copy(ANCLA_INICIO);
      else {
        const g = capas.get(FANTASMAS[id]);
        if (!g) { b.hidden = true; continue; }
        const c = g.userData.caja;
        ancla.set((c.min.x + c.max.x) / 2, c.max.y * g.scale.y + 0.2, (c.min.z + c.max.z) / 2);
      }
      ancla.project(camara);
      b.hidden = ancla.z > 1 || Math.abs(ancla.x) > 1 || Math.abs(ancla.y) > 1;
      if (b.hidden) continue;
      b.style.transform = `translate(${((ancla.x + 1) / 2 * W).toFixed(1)}px, ${((1 - ancla.y) / 2 * H).toFixed(1)}px) translate(-50%, -100%)`;
      const elegido = s.has(id) || (soloInicio && id === 'base'), nombre = NOMBRES[id].replace('ADD. ', '');
      const texto = id === 'base' ? nombre : (elegido ? '✓ ' : '+ ') + nombre;
      if (b.textContent !== texto) b.textContent = texto;
      b.classList.toggle('elegido', elegido);
      b.classList.toggle('bloqueado', id === 'grow' && !s.has('rest'));
    }
  }

  // Prende y apaga capas: las elegidas se ven normales; cada módulo no elegido, en gris con su fantasma.
  // En modo fijo la cámara queda donde está; en modo "seguir" se reencuadra.
  let ultimaSeleccion = '';
  let ultimoAplicado = '';
  let seleccionPrevia = null;
  function aplicar() {
    const s = leerSeleccion();
    // Se llama ante cualquier cambio de la página: solo actúa si cambió la selección o se cargó una capa.
    const huella = [...s].sort().join(',') + '|' + capas.size + '|' + SOLO;
    if (huella === ultimoAplicado) return;
    // Si falta descargar algo de lo que hay que mostrar, se pide ya y se espera: así nunca se
    // ve la casa a medio armar (por ejemplo, sin Inicio mientras baja la capa de Encuentro).
    const faltan = archivosNecesarios(s).filter(a => !capas.has(a));
    if (faltan.length) {
      estado.textContent = 'Cargando modelo 3D…';
      faltan.forEach(cargar);
      return;
    }
    estado.textContent = '';
    ultimoAplicado = huella;
    const fantasmaDe = new Map(); // archivo -> módulo no elegido que representa
    for (const [modulo, archivo] of Object.entries(FANTASMAS)) if (!s.has(modulo)) fantasmaDe.set(archivo, modulo);
    for (const archivo of ARCHIVOS) {
      const g = capas.get(archivo);
      if (!g) continue;
      const capa = CAPAS.find(c => c.archivo === archivo);
      const activa = capa ? capa.seVe(s) : false;
      const fantasma = !activa && fantasmaDe.has(archivo);
      g.visible = activa || (fantasma && !SOLO);
      g.userData.moduloFantasma = fantasma ? fantasmaDe.get(archivo) : null;
      ponerFantasma(g, fantasma);
    }
    resaltar(null);
    if (seleccionPrevia) {
      for (const id of s) if (id !== 'base' && !seleccionPrevia.has(id)) { if (DESTELLO) destellar(id); if (ANIMACION) crecer(id, s); }
      if (ANIMACION) for (const id of seleccionPrevia) if (!s.has(id)) bajar(id);
    }
    seleccionPrevia = s;
    if (!SEGUIR) return;
    // Solo se reencuadra si cambió la selección (no cuando termina de bajar un modelo que no se ve),
    // y no si el usuario se acercó o desplazó: la cámara queda donde la dejó.
    const clave = [...s].sort().join(',');
    if (clave !== ultimaSeleccion) {
      if (ultimaSeleccion === '' || AL_TOCAR_ENCUADRA || !usuarioMovio()) seguirVisible(ultimaSeleccion !== '');
      ultimaSeleccion = clave;
    }
  }

  // Con "Solo mi selección" los grises se ocultan (y no se pueden tocar); en modo "seguir" la cámara
  // se acomoda a lo que queda a la vista.
  function ponerSolo(si) {
    SOLO = si;
    botonSolo.setAttribute('aria-checked', String(si));
    ocultarTooltip();
    aplicar();
    if (SEGUIR && capas.size) seguirVisible(true);
  }
  botonSolo.addEventListener('click', () => ponerSolo(!SOLO));

  // Cubo de vistas, como el de Revit o AutoCAD: gira con la cámara y cada cara se divide en 3 × 3. El
  // centro lleva a la vista de esa cara; los bordes, a la vista entre dos caras; las esquinas, a la
  // perspectiva entre tres. Las caras son grises con un degradé que sigue a una luz fija respecto de la
  // pantalla (arriba clara, un costado medio y el otro oscuro), sin bordes. La flecha curva de abajo gira
  // la vista 90° alrededor de la casa. Frente = +Z (la calle).
  const CARAS = [
    ['Superior', [0, 1, 0], [1, 0, 0], [0, 0, -1], 'rotateX(90deg)'],
    ['Frente', [0, 0, 1], [1, 0, 0], [0, 1, 0], ''],
    ['Derecha', [1, 0, 0], [0, 0, -1], [0, 1, 0], 'rotateY(90deg)'],
    ['Atrás', [0, 0, -1], [-1, 0, 0], [0, 1, 0], 'rotateY(180deg)'],
    ['Izquierda', [-1, 0, 0], [0, 0, 1], [0, 1, 0], 'rotateY(-90deg)'],
    ['Inferior', [0, -1, 0], [1, 0, 0], [0, 0, 1], 'rotateX(-90deg)']
  ];
  const MEDIO_CUBO = 19;
  const cubo = document.createElement('div');
  cubo.className = 'visor-3d-cubo';
  // La flecha: un arco debajo del cubo, de izquierda a derecha. Gira la casa hacia la derecha (el frente se va a la derecha).
  cubo.innerHTML = '<div class="escena"></div><button type="button" class="flecha" style="left:22px;top:71px" aria-label="Girar la vista 90°">' +
    '<svg width="44" height="14" viewBox="0 0 44 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 3 Q21.5 14 38.6 4.3"/><path d="M42.2 2.1 36.4 1.8 39.6 7.2Z" fill="currentColor" stroke-width="1.2"/></svg></button>';
  const escenaCubo = cubo.querySelector('.escena');
  const carasCubo = [];
  for (const [nombre, n, der, arr, giro] of CARAS) {
    const cara = document.createElement('div');
    cara.className = 'cara';
    cara.style.transform = `${giro} translateZ(${MEDIO_CUBO}px)`;
    for (let fila = 0; fila < 3; fila++) for (let col = 0; col < 3; col++) {
      const b = document.createElement('button');
      b.type = 'button';
      const dir = new THREE.Vector3(...n).addScaledVector(new THREE.Vector3(...der), col - 1).addScaledVector(new THREE.Vector3(...arr), 1 - fila);
      b.setAttribute('aria-label', 'Vista ' + nombre.toLowerCase() + (fila === 1 && col === 1 ? '' : ' (inclinada)'));
      b.addEventListener('click', e => { e.stopPropagation(); irAVista(dir); });
      cara.appendChild(b);
    }
    const rotulo = document.createElement('span');
    rotulo.textContent = nombre;
    cara.appendChild(rotulo);
    escenaCubo.appendChild(cara);
    carasCubo.push({ el: cara, normal: new THREE.Vector3(...n) });
  }
  cubo.querySelector('.flecha').addEventListener('click', e => { e.stopPropagation(); girarVista(-1); });
  contenedor.appendChild(cubo);
  // Gira la vista 90° alrededor de la casa, con la misma altura y distancia. Si ya estaba girando, suma
  // a partir de donde iba a terminar (así dos clics seguidos giran 180°).
  function girarVista(sentido) {
    const desde = new THREE.Spherical().setFromVector3(camara.position.clone().sub(controles.target));
    const base = viaje.orbita && viaje.t < 1 ? viaje.orbita[1] : desde;
    const hasta = new THREE.Spherical(base.radius, base.phi, base.theta + sentido * Math.PI / 2);
    viaje.desdeT.copy(controles.target); viaje.hastaT.copy(controles.target);
    viaje.orbita = [desde, hasta];
    viaje.t = 0;
  }
  // Axonométrica: la misma cámara con un ángulo de visión de 3° y mucho más lejos. Las paralelas quedan
  // paralelas (a la vista, igual que una proyección paralela) y todo lo demás (encuadres, cubo, zoom, mouse,
  // nombres en el piso) sigue igual, porque los encuadres se calculan con el ángulo de la cámara.
  // El cambio se anima: el ángulo se cierra mientras la cámara se aleja, y la casa conserva su tamaño.
  const FOV_PERSPECTIVA = 35, FOV_AXO = 3, DURA_PROYECCION = 0.6;
  const esAxo = () => (proyeccion ? proyeccion.hasta : camara.fov) < 10;
  let proyeccion = null;  // { desde, hasta, t }
  function ponerProyeccion(axo, animar = true) {
    const hasta = axo ? FOV_AXO : FOV_PERSPECTIVA;
    if (!animar) { cambiarFov(hasta); proyeccion = null; }
    else proyeccion = { desde: camara.fov, hasta, t: 0 };
    marcarProyeccion(axo);
  }
  // Cambia el ángulo y aleja (o acerca) la cámara en la misma proporción: el tamaño en pantalla no cambia.
  function cambiarFov(fov) {
    const k = Math.tan(camara.fov * Math.PI / 360) / Math.tan(fov * Math.PI / 360);
    const desdeObjetivo = camara.position.clone().sub(controles.target).multiplyScalar(k);
    camara.position.copy(controles.target).add(desdeObjetivo);
    controles.minDistance *= k; controles.maxDistance *= k; auto.dist *= k;
    if (viaje.t < 1) {
      viaje.desdeP.sub(viaje.desdeT).multiplyScalar(k).add(viaje.desdeT);
      viaje.hastaP.sub(viaje.hastaT).multiplyScalar(k).add(viaje.hastaT);
      if (viaje.orbita) viaje.orbita.forEach(o => { o.radius *= k; });
    }
    camara.fov = fov;
    // Planos de recorte en la misma proporción que la distancia (la axonométrica mira desde ~12 veces más lejos).
    const lejania = Math.tan(FOV_PERSPECTIVA * Math.PI / 360) / Math.tan(fov * Math.PI / 360);
    camara.near = 0.1 * lejania; camara.far = 200 * lejania;
    camara.updateProjectionMatrix();
  }
  function animarProyeccion(dt) {
    if (!proyeccion) return;
    proyeccion.t = Math.min(1, proyeccion.t + dt / DURA_PROYECCION);
    const e = proyeccion.t < 0.5 ? 2 * proyeccion.t * proyeccion.t : 1 - Math.pow(-2 * proyeccion.t + 2, 2) / 2;
    // Interpolado en la tangente del semiángulo: el alejamiento se ve parejo de punta a punta.
    const ta = Math.tan(proyeccion.desde * Math.PI / 360), tb = Math.tan(proyeccion.hasta * Math.PI / 360);
    cambiarFov(Math.atan(ta * Math.pow(tb / ta, e)) * 360 / Math.PI);
    if (proyeccion.t >= 1) proyeccion = null;
  }
  const selectorProyeccion = document.createElement('div');
  selectorProyeccion.className = 'proyeccion';
  selectorProyeccion.innerHTML = '<button type="button" data-axo="no">Perspectiva</button><button type="button" data-axo="si">Axonométrica</button>';
  selectorProyeccion.querySelectorAll('button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); ponerProyeccion(b.dataset.axo === 'si'); }));
  cubo.appendChild(selectorProyeccion);
  function marcarProyeccion(axo) {
    selectorProyeccion.hidden = !BOTON_PROYECCION;
    selectorProyeccion.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.axo === 'si') === axo)));
  }
  ponerProyeccion(AXO_PEDIDA, false);

  // La cámara no baja del horizonte (maxPolarAngle): las vistas de costado quedan apenas por encima.
  const ELEVACION_MIN = Math.cos(controles.maxPolarAngle) + 0.01;
  function irAVista(d) {
    const dir = d.clone().normalize();
    if (dir.y < ELEVACION_MIN) { dir.y = ELEVACION_MIN; dir.normalize(); }
    // Vista superior: se conserva el giro actual (si no, la dirección queda indefinida).
    if (dir.y > 0.999) { const actual = camara.position.clone().sub(controles.target); dir.set(actual.x, 0, actual.z).normalize().multiplyScalar(0.02); dir.y = 1; dir.normalize(); }
    const e = calcularEncuadre(contornoCasa(), dir, AIRE);
    const hasta = e.objetivo.clone().addScaledVector(dir, e.dist * ZOOM);
    viaje.orbita = null; viaje.desdeT.copy(controles.target); viaje.hastaT.copy(e.objetivo);
    viaje.desdeP.copy(camara.position); viaje.hastaP.copy(hasta);
    viaje.orbita = [new THREE.Spherical().setFromVector3(camara.position.clone().sub(controles.target)), new THREE.Spherical().setFromVector3(dir.clone().multiplyScalar(e.dist * ZOOM))];
    viaje.t = 0;
    auto.objetivo.copy(e.objetivo); auto.dist = e.dist * ZOOM;
  }
  // Cada cuadro, el cubo copia el giro de la cámara (ejes de three.js pasados a los de CSS, con Y hacia abajo).
  const matrizCubo = new Array(16);
  function girarCubo() {
    const m = camara.matrixWorldInverse.elements;
    for (let c = 0; c < 4; c++) for (let f = 0; f < 4; f++) {
      const i = c * 4 + f;
      matrizCubo[i] = c === 3 || f === 3 ? (c === f ? 1 : 0) : ((f === 1) !== (c === 1) ? -m[i] : m[i]);
    }
    escenaCubo.style.transform = `matrix3d(${matrizCubo.map(v => v.toFixed(5)).join(',')})`;
    // Luz desde arriba a la izquierda y un poco de frente (en coordenadas de la cámara).
    for (const c of carasCubo) {
      const k = normalCam.copy(c.normal).transformDirection(camara.matrixWorldInverse).dot(LUZ_CUBO);
      // Gris de la cara según la luz (arriba ~235, costados ~210 y ~170) y un degradé suave dentro de la cara.
      const v = Math.min(240, Math.max(155, 182 + 62 * k));
      const gris = x => { const g = Math.round(Math.min(250, Math.max(150, x))); return `rgb(${g},${g},${Math.min(255, g + 1)})`; };
      const fondo = `linear-gradient(150deg, ${gris(v + 10)}, ${gris(v - 8)})`;
      if (c.fondo !== fondo) { c.fondo = fondo; c.el.style.background = fondo; }
    }
  }
  const normalCam = new THREE.Vector3(), LUZ_CUBO = new THREE.Vector3(-0.6, 0.7, 0.4).normalize();

  // ---- Interacción: pasar el mouse muestra el nombre; tocar agrega o quita el módulo ----
  const rayo = new THREE.Raycaster();
  const puntero = new THREE.Vector2();
  function moduloBajo(evento) {
    const r = renderer.domElement.getBoundingClientRect();
    puntero.set(((evento.clientX - r.left) / r.width) * 2 - 1, -((evento.clientY - r.top) / r.height) * 2 + 1);
    rayo.setFromCamera(puntero, camara);
    const visibles = [...capas.values()].filter(g => g.visible);
    // El rayo de three.js no mira la visibilidad: en "planta" los volúmenes de los no elegidos están
    // invisibles y tapaban la huella de otro módulo (por ejemplo, Encuentro delante de Cochera). Ahí solo
    // cuentan la huella y su marca; en los demás estilos, solo lo que se ve.
    const tocable = o => o.visible && !(GRIS === 'planta' && o.userData.grupo && o.userData.grupo.userData.fantasma && !o.userData.deEstilo);
    const hit = rayo.intersectObjects(visibles, true).find(h => tocable(h.object));
    if (!hit) return null;
    const g = hit.object.userData.grupo;
    return { id: g.userData.fantasma ? g.userData.moduloFantasma : moduloDe(hit.object.userData.capa, hit.point) };
  }

  // Módulo bajo el mouse. Si está en gris, se "despierta" según el estilo (más marcado, se levanta en
  // "huella"; con vista previa, se ve con sus materiales). Si está elegido, recibe el
  // resaltado de elegidos (data-resaltar-elegido) y, con vista previa, se ve lavado, como a punto de irse.
  // Con data-atenuar el resto de la casa se atenúa; con data-dependencias Descanso y Crecer van juntos.
  function dependientes(id, s) {
    if (!DEPENDENCIAS) return [];
    if (id === 'rest' && s.has('grow')) return ['grow'];   // quitar Descanso quita Crecer
    if (id === 'grow' && !s.has('rest')) return ['rest'];  // Crecer necesita Descanso
    return [];
  }
  function resaltar(id) {
    if (id === resaltado) return;
    resaltado = id;
    const s = leerSeleccion();
    afectados = new Set(id ? [id, ...dependientes(id, s)] : []);
    capas.forEach(g => { if (g.userData.fantasma) pintar(g); });
    ocultarHover();
    const elegidos = [...afectados].filter(m => s.has(m));
    const mostrar = (m, tipo) => { const x = superpuesto(m, tipo); if (x) x.visible = true; };
    if (RESALTAR_ELEGIDO === 'contorno') mostrarContorno(elegidos);
    // El barrido se dispara solo al entrar en un módulo (resaltar sale antes si el módulo no cambió).
    if (BARRIDO && elegidos.length) barrer(elegidos[0]);
    for (const m of elegidos) {
      if (RESALTAR_ELEGIDO === 'tinte') mostrar(m, 'tinte');
      // Con velo, el elegido bajo el mouse se ve tal cual: el velo sobre el resto ya lo destaca.
      if (ATENUAR) mostrar(m, 'foco');
      else if (VISTA_PREVIA) mostrar(m, 'lavado');
    }
    // El velo es solo para los elegidos: los no elegidos ya tienen su propio resaltado (el gris).
    objetivoVelo = ATENUAR && elegidos.length ? 1 : 0;
  }

  // Texto del tooltip: el mismo que armaba la página para cada tarjeta (moduleTooltip), así incluye
  // descripción, superficie y precio individual del sistema constructivo elegido.
  function textoTooltip(id) {
    try {
      // eslint-disable-next-line no-undef
      const catalogo = typeof MODULE_CATALOG !== 'undefined' ? MODULE_CATALOG : null;
      const modulo = catalogo && catalogo.find(m => m.id === id);
      if (modulo && typeof window.moduleTooltip === 'function') {
        if (id === 'grow' && !leerSeleccion().has('rest')) return modulo.name + '\nPrimero incorporá ADD. DESCANSO para habilitar este módulo.';
        return window.moduleTooltip(modulo);
      }
    } catch (e) { /* páginas de prueba: sin catálogo */ }
    if (id === 'grow' && !leerSeleccion().has('rest')) return NOMBRES.grow + '\nPrimero incorporá ADD. DESCANSO para habilitar este módulo.';
    return NOMBRES[id] || '';
  }

  // Muestra el tooltip junto al puntero (x, y relativos al visor), sin salirse del recuadro.
  // modo "mouse" o "toque": cambia el texto de la acción (data-vista-previa) y, en celular con
  // data-toque="boton", agrega un botón Sumar / Quitar.
  function mostrarTooltip(id, x, y, modo = 'mouse') {
    const s = leerSeleccion(), sePuede = id !== 'base' && !(id === 'grow' && !s.has('rest'));
    const verbo = s.has(id) ? 'quitar' : 'sumar';
    const conBoton = modo === 'toque' && TOQUE_BOTON && sePuede;
    let texto = textoTooltip(id);
    if (VISTA_PREVIA && sePuede && !conBoton) texto += '\n' + (modo === 'toque' ? 'Tocá de nuevo para ' : 'Clic para ') + verbo;
    tooltip.textContent = texto;
    tooltip.classList.toggle('con-boton', conBoton);
    if (conBoton) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = verbo === 'sumar' ? 'Sumar' : 'Quitar';
      b.addEventListener('click', e => { e.stopPropagation(); ocultarTooltip(); resaltar(null); alternar(id); });
      tooltip.appendChild(b);
    }
    tooltip.classList.add('visible');
    const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    const W = contenedor.clientWidth, H = contenedor.clientHeight;
    let left = x + 14, top = y + 18;
    if (left + w > W - 6) left = x - w - 14;
    if (top + h > H - 6) top = y - h - 14;
    tooltip.style.left = Math.max(6, left) + 'px';
    tooltip.style.top = Math.max(6, top) + 'px';
  }
  function ocultarTooltip() { tooltip.classList.remove('visible', 'con-boton'); }

  function alternar(id) {
    if (id === 'base') return;
    if (id === 'grow' && !leerSeleccion().has('rest')) return;
    // En la página del configurador existe toggleModule(id); en la página de prueba, los botones.
    if (typeof window.toggleModule === 'function') { window.toggleModule(id); aplicar(); }
    else { const el = document.querySelector('[data-module-id="' + id + '"]'); if (el) el.click(); }
  }

  // Mismo comportamiento que tenían las tarjetas:
  //   computadora: pasar el mouse muestra el tooltip; un clic agrega o quita.
  //   celular: el primer toque muestra el tooltip; un segundo toque al mismo módulo
  //            dentro de 650 ms lo agrega o lo quita.
  const lienzo = renderer.domElement;
  const local = e => { const r = contenedor.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  let inicioToque = null, toqueAnterior = null, relojToque = null;
  // Toques en un espacio vacío: dos seguidos vuelven al encuadre automático.
  let vacioAnterior = 0;
  function toqueVacio() {
    const ahora = performance.now();
    if (ahora - vacioAnterior < (parseInt(contenedor.dataset.dobleToque, 10) || 650)) { vacioAnterior = 0; reencuadrar(); }
    else vacioAnterior = ahora;
  }
  // Con dos dedos (zoom o desplazamiento) no hay toque hasta que se levantan todos.
  const dedos = new Set();
  let variosDedos = false;
  // Sin esto, en Windows apretar la ruedita activa el desplazamiento automático de la página.
  lienzo.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  lienzo.addEventListener('pointerdown', e => {
    ocultarPista();
    dedos.add(e.pointerId);
    if (dedos.size > 1) variosDedos = true;
    // Solo el botón izquierdo cuenta como clic; el derecho desplaza.
    inicioToque = !variosDedos && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });
  const soltar = e => { dedos.delete(e.pointerId); if (!dedos.size) setTimeout(() => { variosDedos = false; }); };
  lienzo.addEventListener('pointercancel', e => { soltar(e); inicioToque = null; });
  lienzo.addEventListener('pointerup', e => {
    soltar(e);
    // Si el dedo o el mouse se movió, fue un giro o desplazamiento de cámara, no un toque.
    if (variosDedos || !inicioToque || Math.hypot(e.clientX - inicioToque.x, e.clientY - inicioToque.y) > 6) return;
    inicioToque = null;
    const m = moduloBajo(e);
    const [x, y] = local(e);
    if (e.pointerType === 'mouse') {
      if (!m) return toqueVacio();
      vacioAnterior = 0;
      alternar(m.id);
      mostrarTooltip(m.id, x, y);
      return;
    }
    // Tocar afuera cierra el cartel; el renglón del tutorial queda.
    if (!m) { ocultarTooltip(); if (tutorialHecho) ocultarAviso(); resaltar(null); toqueAnterior = null; toqueVacio(); return; }
    vacioAnterior = 0;
    const mismoToque = toqueAnterior === m.id;
    clearTimeout(relojToque);
    if (!mismoToque) {
      toqueAnterior = m.id;
      resaltar(m.id !== 'base' ? m.id : null);
      mostrarTooltip(m.id, x, y, 'toque');
      // Paso 2 (o el recordatorio), salvo en Inicio (no se quita), en Crecer sin Descanso (no se puede)
      // y con el botón Sumar / Quitar. En esos, si el tutorial sigue, el renglón queda como estaba.
      const ahora = performance.now();
      const lento = ultimoToque && ultimoToque.id === m.id && ahora - ultimoToque.t < 2000;
      ultimoToque = { id: m.id, t: ahora };
      const sePuede = m.id !== 'base' && !(m.id === 'grow' && !leerSeleccion().has('rest')) && !TOQUE_BOTON;
      if (sePuede && !tutorialHecho) mostrarAviso(textoPaso2(m.id));
      else if (sePuede && lento && !recordatorioUsado) { recordatorioUsado = true; mostrarAviso(textoPaso2(m.id)); }
      else if (tutorialHecho) ocultarAviso();
      relojToque = setTimeout(() => { toqueAnterior = null; }, parseInt(contenedor.dataset.dobleToque, 10) || 650);
      return;
    }
    toqueAnterior = null;
    ultimoToque = null;
    ocultarTooltip();
    terminarTutorial();
    alternar(m.id);
  });
  lienzo.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const m = moduloBajo(e);
    resaltar(m && m.id !== 'base' ? m.id : null);
    lienzo.style.cursor = m && m.id !== 'base' ? 'pointer' : 'grab';
    if (m) { const [x, y] = local(e); mostrarTooltip(m.id, x, y); } else ocultarTooltip();
  });
  lienzo.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { resaltar(null); ocultarTooltip(); } });

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
    } else base = calcularEncuadre(contornoCasa(), dir, AIRE).dist;
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
  // Si cambia un interruptor (panel de prueba o Canva), se aplica en el momento y se vuelve a encuadrar.
  // Los de cámara reencuadran; los de estilo solo vuelven a pintar.
  const DE_CAMARA = ['data-camara', 'data-al-tocar', 'data-desplazar', 'data-arrastre', 'data-zoom-cursor', 'data-margen-arriba', 'data-direccion', 'data-zoom', 'data-aire'];
  // data-giro se lee en vivo (leerInterruptores) pero no reencuadra.
  const DE_MANEJO = ['data-giro'];
  const DE_ESTILO = ['data-gris', 'data-gris-hover', 'data-resaltar-elegido', 'data-barrido', 'data-destello', 'data-sombras', 'data-etiquetas', 'data-acento',
    'data-atenuar', 'data-vista-previa', 'data-dependencias', 'data-animacion', 'data-pista', 'data-marca-inicio', 'data-toque', 'data-solo-seleccion', 'data-marca-planta', 'data-proyeccion', 'data-boton-proyeccion'];
  new MutationObserver(registros => {
    leerInterruptores();
    refrescarEstilo();
    if (barra.hidden && SOLO) ponerSolo(false);
    if (AXO_PEDIDA !== esAxo()) ponerProyeccion(AXO_PEDIDA);
    else marcarProyeccion(esAxo());
    if (registros.some(r => DE_CAMARA.includes(r.attributeName))) reencuadrar();
  }).observe(contenedor, { attributes: true, attributeFilter: [...DE_CAMARA, ...DE_ESTILO, ...DE_MANEJO] });
  refrescarEstilo();
  window.ADD3D = { aplicar, encuadrar, reencuadrar, leerSeleccion, camara, controles, capas, vista, fijarVista };

  // La descarga empieza apenas carga la página, aunque el visor todavía no esté a la vista.
  cargarTodo();

  // config.json junto al script: completa los atributos que no trae el div (lo que dice el div gana).
  // Los atributos se releen en vivo, así que se aplica aunque llegue después de arrancar.
  fetch(new URL('config.json', import.meta.url), { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(c => {
      if (!c || !c.atributos) return;
      for (const [k, v] of Object.entries(c.atributos)) if (!contenedor.hasAttribute('data-' + k)) contenedor.setAttribute('data-' + k, String(v));
    })
    .catch(() => {});
}

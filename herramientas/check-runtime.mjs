#!/usr/bin/env node
/**
 * Oraculo: la fecha de compatibilidad con la que corren las pruebas del Durable
 * Object tiene que estar ESCRITA, no adivinada por el reloj de la maquina.
 *
 * Este archivo nacio afirmando otra cosa. Decia que miniflare, ante una
 * `compatibility_date` que el workerd instalado no soporta, "baja la fecha en
 * silencio y sigue". Eso es cierto de la version vieja de miniflare — es el
 * aviso que aparecio cuando se evaluo quedarse en vitest 2 — y es FALSO del
 * stack instalado: miniflare 5 tira `ERR_FUTURE_COMPATIBILITY_DATE` y workerd
 * tira "the newest date supported by this server binary is ...". Los dos fallan
 * a los gritos, con el numero exacto. Ese agujero no existe, y el oraculo que
 * lo cuidaba tampoco tiene sentido.
 *
 * Tambien comparaba la fecha pedida contra la version del paquete `workerd`,
 * suponiendo que la fecha del paquete era el techo de compatibilidad soportado.
 * Medido contra el binario: `workerd 1.20260811.1` soporta hasta **2026-08-18**,
 * siete dias mas que su propia fecha de build, porque registra banderas con
 * fecha de activacion futura. Esa comparacion era una hipotesis comoda, y su
 * error caia del lado que rompe el CI: cualquier fecha del 12 al 18 de agosto
 * daba rojo sobre una corrida perfectamente fiel, y no habia wrangler mas nuevo
 * que lo arreglara.
 *
 * Lo que SI falla en silencio, y es la razon por la que este archivo se queda:
 *
 *     node_modules/miniflare/dist/src/index.js
 *     compatibility_date: config.compatibility_date ?? getTodaysCompatDate()
 *
 * Si la configuracion no declara una fecha para el entorno con el que corren las
 * pruebas, miniflare pone **la fecha de hoy del sistema**. Nadie avisa. El mismo
 * commit pasa hoy y falla el miercoles, o pasa en el CI y falla en la maquina
 * del dueño. Es el defecto n.º 6 de la Fase 0 tal cual — un veredicto que
 * depende de la maquina y no del codigo — y es facil de producir sin querer:
 * alcanza con dejar la fecha comentada mientras se prueba algo.
 *
 * Asi que el oraculo hace tres cosas, y ninguna mas:
 *
 *   1. Lee de `vitest.runtime.config.ts` con QUE entorno corren las pruebas, en
 *      vez de suponer "staging". Si el arnes y el oraculo miran entornos
 *      distintos, el oraculo no mide lo que corre.
 *   2. Resuelve la fecha efectiva de ese entorno como la resuelve wrangler:
 *      `env.<entorno>.compatibility_date` gana sobre la de la raiz.
 *   3. Falla si no hay ninguna. Un comentario de bloque no cuenta como fecha.
 *
 * Uso:  node herramientas/check-runtime.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** La raiz del repositorio, derivada de la ubicacion de este archivo y no del
 *  directorio desde el que se lo invoca: un oraculo cuyo veredicto depende de
 *  donde estabas parado es la clase de cosa que este archivo existe para
 *  impedir. */
const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/**
 * Convierte JSONC en JSON parseable: saca comentarios de linea y de bloque, y
 * las comas colgantes.
 *
 * Va caracter por caracter porque tiene que saber cuando esta ADENTRO de una
 * cadena. La version anterior de este archivo usaba una expresion regular sobre
 * el texto y descartaba las lineas que arrancaban con `//`, y eso fallaba en
 * tres formas medidas: un comentario al final de una linea de codigo contaba
 * como una segunda fecha, un comentario de bloque con una fecha vieja
 * adentro contaba como fecha valida, y la fecha de un `env.<nombre>` contaba
 * como conflicto cuando en realidad es la que manda.
 */
export function normalizarJsonc(texto) {
  let salida = ''
  let i = 0
  let enCadena = false

  /** Emite un caracter, y si es `}` o `]`, borra la coma colgante que quedo
   *  atras. JSONC las permite; JSON.parse no. */
  const emitir = (c) => {
    if (c === '}' || c === ']') {
      const recortado = salida.replace(/\s+$/, '')
      if (recortado.endsWith(',')) salida = recortado.slice(0, -1)
    }
    salida += c
  }

  while (i < texto.length) {
    const c = texto[i]
    const d = texto[i + 1]

    if (enCadena) {
      if (c === '\\') {
        salida += c + (d ?? '')
        i += 2
        continue
      }
      if (c === '"') enCadena = false
      salida += c
      i += 1
      continue
    }

    if (c === '"') {
      enCadena = true
      salida += c
      i += 1
      continue
    }

    if (c === '/' && d === '/') {
      while (i < texto.length && texto[i] !== '\n') i += 1
      continue
    }

    if (c === '/' && d === '*') {
      i += 2
      while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) i += 1
      i += 2
      continue
    }

    emitir(c)
    i += 1
  }

  return salida
}

/** Lee y parsea un wrangler.jsonc. Separado de la resolucion para que la
 *  resolucion se pueda probar sobre objetos, sin disco. */
export function leerConfig(texto) {
  const limpio = normalizarJsonc(texto)
  try {
    return JSON.parse(limpio)
  } catch (e) {
    throw new Error(`wrangler.jsonc no se pudo parsear despues de quitar comentarios: ${e.message}`)
  }
}

/**
 * Con que entorno corren las pruebas del runtime, segun el propio arnes.
 *
 * Se lee de `vitest.runtime.config.ts` en vez de escribir 'staging' aca. Si
 * alguien apunta el arnes a otro entorno, el oraculo lo sigue — y si el arnes no
 * declara ninguno, esto falla, porque un entorno implicito significa que la
 * fecha efectiva sale de la raiz y nadie lo escribio.
 */
export function extraerEntornoDelArnes(texto) {
  const limpio = normalizarJsonc(texto)
  const encontrados = [...limpio.matchAll(/environment\s*:\s*'([^']+)'|environment\s*:\s*"([^"]+)"/g)].map(
    (m) => m[1] ?? m[2],
  )

  if (encontrados.length === 0) {
    throw new Error('vitest.runtime.config.ts no declara con que `environment` corren las pruebas')
  }
  if (encontrados.length > 1) {
    throw new Error(
      `vitest.runtime.config.ts declara ${encontrados.length} entornos y no se sabe cual corre: ${encontrados.join(', ')}`,
    )
  }
  return encontrados[0]
}

/**
 * La fecha efectiva, resuelta como la resuelve wrangler: la del entorno gana
 * sobre la de la raiz. Devuelve tambien de donde salio, para que el mensaje de
 * error sirva para algo.
 *
 * `null` no es un caso raro que se pueda ignorar: es EL caso que este oraculo
 * existe para agarrar, porque ahi entra el reloj del sistema.
 */
export function fechaEfectiva(config, entorno) {
  const delEntorno = config?.env?.[entorno]?.compatibility_date
  if (typeof delEntorno === 'string') return { fecha: delEntorno, origen: `env.${entorno}` }

  const deLaRaiz = config?.compatibility_date
  if (typeof deLaRaiz === 'string') return { fecha: deLaRaiz, origen: 'raiz' }

  return { fecha: null, origen: null }
}

/** Que sea una fecha, y una que exista. `2026-02-30` no existe, y JavaScript la
 *  corre en silencio a 2026-03-02: una fecha corrida dos dias es peor que un
 *  error, porque el oraculo compara contra algo que nadie escribio. */
export function esFechaReal(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false
  const d = new Date(`${fecha}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(fecha)
}

function main() {
  let entorno
  let resuelta

  try {
    entorno = extraerEntornoDelArnes(
      readFileSync(new URL('vitest.runtime.config.ts', `file://${RAIZ}`), 'utf8'),
    )
    const config = leerConfig(readFileSync(new URL('wrangler.jsonc', `file://${RAIZ}`), 'utf8'))
    resuelta = fechaEfectiva(config, entorno)
  } catch (e) {
    // El mismo formato que el camino de falla de abajo. Un oraculo que se cae
    // con un stack de Node le hace perder media hora al que lo lee con el CI en
    // rojo, y este archivo es el que mas se va a leer en ese estado.
    console.error('')
    console.error('  check-runtime: NO SE PUDO DETERMINAR LA FECHA DE COMPATIBILIDAD')
    console.error('')
    console.error(`    ${e.message}`)
    console.error('')
    console.error('  Sin esa fecha, miniflare usa la de HOY del reloj del sistema y las')
    console.error('  pruebas del Durable Object pasan a depender del dia en que se corren.')
    console.error('')
    process.exit(1)
  }

  if (resuelta.fecha === null) {
    console.error('')
    console.error('  check-runtime: NO HAY compatibility_date PARA EL ENTORNO DE PRUEBAS')
    console.error('')
    console.error(`    el arnes corre con el entorno    : ${entorno}`)
    console.error('    fecha en env.' + entorno + '            : no hay')
    console.error('    fecha en la raiz                 : no hay')
    console.error('')
    console.error('  miniflare NO falla por esto. Pone la fecha de hoy del sistema:')
    console.error('')
    console.error('      compatibility_date: config.compatibility_date ?? getTodaysCompatDate()')
    console.error('')
    console.error('  Eso hace que el mismo commit pase hoy y falle el miercoles, y que el CI')
    console.error("")
    console.error('  y la maquina del dueño no den el mismo veredicto. Es el defecto n.º 6 de')
    console.error('  la Fase 0: un oraculo cuyo resultado depende de la maquina no es un')
    console.error('  oraculo.')
    console.error('')
    console.error('  Un comentario NO cuenta como fecha: si la dejaste comentada mientras')
    console.error('  probabas algo, esto es exactamente lo que tenia que pasar.')
    console.error('')
    process.exit(1)
  }

  if (!esFechaReal(resuelta.fecha)) {
    console.error('')
    console.error('  check-runtime: LA compatibility_date NO ES UNA FECHA REAL')
    console.error('')
    console.error(`    ${resuelta.origen} declara : ${resuelta.fecha}`)
    console.error('')
    console.error('  Se espera YYYY-MM-DD y una fecha que exista. Ojo con las que parecen')
    console.error('  validas: JavaScript convierte 2026-02-30 en 2026-03-02 sin avisar.')
    console.error('')
    process.exit(1)
  }

  console.log(
    `  check-runtime: OK — el arnes corre con el entorno ${entorno}, compatibility_date ${resuelta.fecha} (de ${resuelta.origen})`,
  )
}

// `import.meta.main` y no `argv[1].endsWith(...)`: con el nombre, invocarlo por
// un symlink o una copia con otro nombre importaba el modulo, no verificaba nada
// y salia con 0 — el peor final posible para un oraculo.
if (import.meta.main) main()

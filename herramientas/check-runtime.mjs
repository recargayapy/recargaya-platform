#!/usr/bin/env node
/**
 * Oraculo: la fecha de compatibilidad con la que corren las pruebas del Durable
 * Object tiene que estar ESCRITA, no adivinada por el reloj de la maquina.
 *
 * El agujero, medido en `node_modules/miniflare/dist/src/index.js` (linea 38872):
 *
 *     compatibility_date: config3.compatibility_date ?? getTodaysCompatDate(),
 *
 * Si la configuracion no declara una fecha para el entorno con el que corren las
 * pruebas, miniflare pone **la fecha de hoy del reloj del sistema**. Nadie avisa.
 * El mismo commit pasa hoy y falla el miercoles, o pasa en el CI y falla en la
 * maquina del dueño. Es la misma categoria que el defecto n.º 6 de la Fase 0 —un
 * veredicto que depende de la maquina y no del codigo, aunque ahi el mecanismo
 * eran los fines de linea— y es facil de producir sin querer: alcanza con dejar
 * la fecha comentada un rato mientras se prueba algo.
 *
 * Lo que este archivo NO hace, y por que:
 *
 * No compara la fecha pedida contra la version del paquete `workerd`. Lo hizo, y
 * estaba mal de dos formas. Primero, suponia que la fecha del paquete era el
 * techo de compatibilidad soportado: sondeado contra el binario, `1.20260811.1`
 * soporta hasta 2026-08-18, siete dias mas que su propia fecha de build, porque
 * registra banderas con fecha de activacion futura. Y segundo, no hacia falta:
 * una fecha que el motor no soporta ya falla a los gritos, y esta medido en los
 * dos caminos —`workerd` dice «the newest date supported by this server binary
 * is ...» con el numero exacto, y miniflare rechaza aparte toda fecha posterior a
 * la de hoy con `ERR_FUTURE_COMPATIBILITY_DATE`, sin decir cual si soporta.
 *
 * (El aviso que motivo esa comparacion —«Falling back to ...», miniflare bajando
 * la fecha en silencio— es real, pero del stack VIEJO: aparecio al evaluar
 * quedarse en vitest 2. Con el instalado no existe.)
 *
 * Asi que el oraculo hace cuatro cosas, y ninguna mas:
 *
 *   1. Lee de `pruebas-runtime/arnes-del-runtime.json` con QUE entorno y contra
 *      QUE configuracion corren las pruebas — el mismo archivo que lee el arnes.
 *      Si el arnes y el oraculo miraran entornos distintos, el oraculo no mediria
 *      lo que corre.
 *   2. Exige que ese entorno exista en `wrangler.jsonc`. Un entorno que la
 *      configuracion no declara resolveria contra la nada.
 *   3. Resuelve la fecha efectiva como la resuelve wrangler:
 *      `env.<entorno>.compatibility_date` gana sobre la de la raiz.
 *   4. Falla si no hay ninguna, y falla si el arnes tiene una LINEA DE CODIGO con
 *      un `compatibilityDate` de miniflare — porque ahi la fecha efectiva ya no
 *      es la que este oraculo acaba de aprobar. Un comentario que la mencione no
 *      cuenta: lo que se busca es una forma de codigo, no la palabra.
 *   5. Y comprueba que el `migrationsDir` del arnes sea el MISMO que declara la
 *      base D1 de ese entorno en `wrangler.jsonc`. El arnes aplica esas
 *      migraciones a la D1 local antes de correr las pruebas del publicador: si
 *      apuntara a otra carpeta, las pruebas aprobarian un esquema de D1 que no es
 *      el que se despliega. Es la misma categoria que la tabla de juguete que
 *      motivo sacar el DDL del Durable Object a `src/`.
 *
 * Uso:  node herramientas/check-runtime.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { invocadoDirecto } from './invocado-directo.mjs'
import { leerArnesDesde } from './arnes-del-runtime.mjs'

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
 * El arnes no puede imponer la fecha por su cuenta.
 *
 * El pool acepta un bloque `miniflare: { ... }` que pasa opciones crudas al
 * runtime, y `compatibilityDate` es una opcion LEGITIMA y bien tipada de
 * miniflare: ningun compilador se va a quejar de ella nunca, por estricto que
 * sea. Puesta ahi, gana sobre todo lo que este oraculo resuelve, y quedaria
 * imprimiendo OK sobre una fecha que no es la efectiva. Medido: con
 * `miniflare: { compatibilityDate: '2023-01-01' }` el oraculo decia OK y las
 * pruebas corrian con 2023.
 *
 * No se intenta resolverlo: se prohibe.
 *
 * El patron esta anclado al comienzo de linea y exige los dos puntos, o sea que
 * busca una FORMA DE CODIGO y no la palabra. La version anterior era
 * `/compatibilityDate|compatibility_date/` sobre todo el texto, y una auditoria
 * la rompio con el comentario mas natural que existe: el que documenta esta
 * misma regla. Un oraculo que se rompe cuando alguien documenta la regla es un
 * oraculo que alguien va a borrar.
 *
 * Lo que esto NO cubre, y se dice: el literal movido a otro archivo e importado
 * (`miniflare: opcionesCrudas`). Eso no lo agarra ningun grep de un solo archivo.
 * Lo que si quedo cubierto es el `configPath`, que era el agujero grande de la
 * misma familia: ahora vive en `arnes-del-runtime.json` y lo valida
 * `leerArnes()`.
 */
export function buscarFechaImpuestaPorElArnes(texto) {
  const m = /^[^\n]*?\b(compatibilityDate|compatibility_date)\s*:/m.exec(texto)
  if (m === null) return null
  // Una linea que arranca con `//` o `*` es comentario: no impone nada.
  const linea = m[0]
  if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return null
  return m[1]
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

/**
 * Las carpetas de migraciones que declaran las bases D1 del entorno, sin repetidos.
 *
 * Devuelve una LISTA y no la primera que encuentre, y eso es un arreglo de
 * auditoria: la version anterior hacia `for (…) if (typeof b?.migrations_dir ===
 * 'string') return b.migrations_dir`, o sea que ignoraba el resto. Hoy hay una sola
 * base y acertaba; el dia que haya dos, compararia la carpeta equivocada y
 * aprobaria en verde. Es la misma clase de defecto de «medio lado de la frontera»
 * que este archivo ya documenta haber arreglado dos veces.
 *
 * Con la lista, el que decide puede exigir que haya exactamente una: el arnes
 * aplica UNA carpeta de migraciones, asi que dos bases con carpetas distintas es un
 * estado que no se puede probar, y hay que decirlo en vez de elegir una.
 *
 * Separada y pura para poder probarla sobre objetos, sin disco.
 */
export function migracionesDeclaradas(config, entorno) {
  const bases = config?.env?.[entorno]?.d1_databases
  if (!Array.isArray(bases)) return []
  const carpetas = bases
    .map((b) => b?.migrations_dir)
    .filter((d) => typeof d === 'string' && d !== '')
  return [...new Set(carpetas)]
}

function main() {
  let entorno
  let config
  let resuelta

  try {
    const arnes = readFileSync(join(RAIZ, 'vitest.runtime.config.ts'), 'utf8')
    const impuesta = buscarFechaImpuestaPorElArnes(arnes)
    if (impuesta !== null) {
      throw new Error(
        `vitest.runtime.config.ts tiene una linea de codigo con \`${impuesta}:\`, y eso gana sobre la fecha de wrangler.jsonc`,
      )
    }

    const declarado = leerArnesDesde(RAIZ)
    entorno = declarado.environment
    config = leerConfig(readFileSync(join(RAIZ, 'wrangler.jsonc'), 'utf8'))

    if (config?.env?.[entorno] === undefined) {
      throw new Error(`wrangler.jsonc no declara el entorno "${entorno}" que el arnes dice usar`)
    }

    const deWrangler = migracionesDeclaradas(config, entorno)
    if (deWrangler.length === 0) {
      throw new Error(
        `ninguna base D1 de env.${entorno} declara \`migrations_dir\`, y el arnes necesita saber que migraciones aplicar a la base local`,
      )
    }
    if (deWrangler.length > 1) {
      throw new Error(
        `env.${entorno} declara mas de una carpeta de migraciones (${deWrangler.join(', ')}) y el arnes aplica una sola: elegir en silencio seria aprobar un esquema al azar`,
      )
    }
    if (deWrangler[0] !== declarado.migrationsDir) {
      throw new Error(
        `el arnes aplica las migraciones de "${declarado.migrationsDir}" y env.${entorno} despliega las de "${deWrangler[0]}": las pruebas correrian contra un esquema de D1 que no es el que se despliega`,
      )
    }

    resuelta = fechaEfectiva(config, entorno)
  } catch (e) {
    // El mismo formato que los caminos de falla de abajo. Un oraculo que se cae
    // con un stack de Node le hace perder media hora al que lo lee con el CI en
    // rojo, y este archivo es el que mas se va a leer en ese estado.
    console.error('')
    console.error('  check-runtime: EL ARNES DEL RUNTIME NO ESTA BIEN DECLARADO')
    console.error('')
    console.error(`    ${e.message}`)
    console.error('')
    console.error('  Este oraculo comprueba dos cosas sobre el arnes, y las dos terminan igual:')
    console.error('  una prueba que aprueba algo distinto de lo que se despliega.')
    console.error('')
    console.error('    · Sin una compatibility_date escrita, miniflare usa la de HOY del reloj')
    console.error('      del sistema y el veredicto pasa a depender del dia en que corre.')
    console.error('    · Con un migrations_dir distinto del que despliega wrangler, las pruebas')
    console.error('      corren contra un esquema de D1 que nadie va a tener en produccion.')
    console.error('')
    process.exit(1)
  }

  if (resuelta.fecha === null) {
    console.error('')
    console.error('  check-runtime: NO HAY compatibility_date PARA EL ENTORNO DE PRUEBAS')
    console.error('')
    console.error(`    el arnes corre con el entorno    : ${entorno}`)
    console.error(`    fecha en env.${entorno}            : no hay`)
    console.error('    fecha en la raiz                 : no hay')
    console.error('')
    console.error('  miniflare NO falla por esto. Pone la fecha de hoy del sistema:')
    console.error('')
    console.error('      compatibility_date: config3.compatibility_date ?? getTodaysCompatDate(),')
    console.error('')
    console.error('  Eso hace que el mismo commit pase hoy y falle el miercoles, y que el CI y')
    console.error('  la maquina del dueño no den el mismo veredicto: un oraculo cuyo resultado')
    console.error('  depende de la maquina no es un oraculo.')
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

// El guard vive en `invocado-directo.mjs`, compartido por los tres oraculos: la
// primera version de este arreglo lo cambio solo aca y dejo `check-esquema.mjs`
// con el guard por nombre. Se arregla la categoria, no el caso.
if (invocadoDirecto(import.meta)) main()

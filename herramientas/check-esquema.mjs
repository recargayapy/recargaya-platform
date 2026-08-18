#!/usr/bin/env node
/**
 * Compara los tipos cerrados de TypeScript contra los `CHECK` gemelos que viven
 * en el SQL de las migraciones. Y, para las bolsas, tambien contra el esquema del
 * SQLite que vive adentro del Durable Object.
 *
 * ---------------------------------------------------------------------------
 * EL DEFECTO QUE LO MOTIVO
 *
 * `retenido` se agrego a `TipoBolsa` y nadie lo agrego al CHECK de
 * `ledger_copia`. `npm run verificar` no lo agarraba porque tipos, pruebas y
 * mutacion corren todos sobre TypeScript — el CHECK vive del otro lado de esa
 * frontera, en SQL.
 *
 * ---------------------------------------------------------------------------
 * POR QUE AHORA ES UNA LISTA DE FRONTERAS Y NO UNA COMPROBACION DE `bolsa`
 *
 * La entrega 1.2 escribe `type Capacidad = 'cliente' | 'vendedor' | 'creador' |
 * 'distribuidor'` en TypeScript, cuando esa lista ya existia —desde 0001— en el
 * `CHECK` de la columna `capacidad`. O sea: la MISMA frontera, con otro
 * sustantivo. Alguien agrega `afiliado` al tipo, se olvida del CHECK, y el
 * `INSERT` falla en runtime con la cuenta ya creada.
 *
 * El metodo del proyecto dice que se arregla la categoria del defecto y nunca el
 * caso. Agregar una segunda comprobacion copiada para `capacidad` habria sido
 * arreglar el caso, y habria dejado a `personas.estado` —que es exactamente lo
 * mismo por tercera vez— sin nadie que la mire. Asi que las fronteras se
 * DECLARAN, y agregar la proxima es una linea en `FRONTERAS`.
 *
 * ---------------------------------------------------------------------------
 * POR QUE HAY QUE MIRAR LA TABLA Y NO ALCANZA CON EL NOMBRE DE LA COLUMNA
 *
 * La version anterior buscaba `bolsa ... CHECK (bolsa IN (...))` en cualquier
 * lado, y con una sola frontera alcanzaba. Con tres no: la columna `estado`
 * existe en `personas` (activa/suspendida/cerrada) Y en `pedidos`
 * (creado/pagado/repartido/cancelado). Comparar por nombre de columna haria que
 * cada una fallara contra el tipo de la otra.
 *
 * Y mirar la tabla tiene su propia trampa, que es la razon por la que hay
 * resolucion de renombres: 0002 crea `ledger_copia_nueva` y despues la renombra a
 * `ledger_copia`; 0003 hace lo mismo con `personas` y `capacidades`. Buscando la
 * tabla por su nombre final, esos CREATE TABLE quedarian invisibles — y son
 * justamente los que gobiernan, porque son los ultimos. Es el mismo defecto que
 * esta herramienta ya tuvo una vez (leer solo `0001_cimientos.sql`) con otro
 * disfraz: el oraculo aprobando la definicion de una tabla que ya no existe.
 *
 * Uso: node herramientas/check-esquema.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invocadoDirecto } from './invocado-directo.mjs'

// La raiz sale de la ubicacion de este archivo y no del directorio desde el que
// se lo invoca. Antes eran rutas relativas al cwd: corrido desde `herramientas/`
// moria con un ENOENT y un stack pelado. Un oraculo cuyo veredicto depende de
// donde estabas parado es lo mismo que el defecto n.º 6 de la Fase 0 con otro
// disfraz.
const RAIZ = fileURLToPath(new URL('..', import.meta.url))
const DIR_MIGRACIONES = join(RAIZ, 'migraciones', 'core')
const ARCHIVO_ESQUEMA_DO = join(RAIZ, 'src', 'billetera', 'esquema.ts')

/**
 * Las fronteras, declaradas. Cada linea es "este tipo de TypeScript y el CHECK de
 * esta columna de esta tabla dicen lo mismo".
 *
 * `pedidos.estado` NO esta, y es una ausencia deliberada: todavia no existe un
 * tipo de TypeScript que la nombre, porque el flujo de pedidos es de otra
 * entrega. Declarar la frontera hoy la haria fallar contra un tipo inexistente.
 * Cuando `EstadoPedido` se escriba, se agrega la linea acá — y esta frase es el
 * recordatorio de que hay que hacerlo.
 */
export const FRONTERAS = [
  {
    tipo: 'TipoBolsa',
    archivo: ['src', 'dinero', 'bolsas.ts'],
    tabla: 'ledger_copia',
    columna: 'bolsa',
  },
  {
    tipo: 'Capacidad',
    archivo: ['src', 'identidad', 'capacidades.ts'],
    tabla: 'capacidades',
    columna: 'capacidad',
  },
  {
    tipo: 'EstadoPersona',
    archivo: ['src', 'identidad', 'capacidades.ts'],
    tabla: 'personas',
    columna: 'estado',
  },
]

/**
 * Los valores de un tipo union de TypeScript declarado en una sola linea.
 *
 * Generalizacion de la version anterior, que solo sabia leer `TipoBolsa`. El
 * nombre entra por parametro para que agregar una frontera no pida una funcion
 * nueva.
 */
export function extraerTipo(contenido, nombre) {
  const m = contenido.match(new RegExp(`export type ${nombre} = ([^\\n]+)`))
  if (m === null) throw new Error(`no se encontro "export type ${nombre}" en el archivo`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** El de siempre, para que las pruebas que lo nombran sigan apuntando a algo. */
export function extraerTipoBolsa(contenido) {
  return extraerTipo(contenido, 'TipoBolsa')
}

/**
 * Saca los comentarios de linea antes de mirar el SQL.
 *
 * NO ES HIGIENE: es lo que separa el DDL de la prosa. Los encabezados de este
 * proyecto CITAN DDL viejo textualmente —0002 y 0003 lo hacen— y la segunda vuelta
 * de auditoria midio la consecuencia: una migracion cuyo comentario citaba un
 * `CREATE TABLE capacidades (…) STRICT;` con la lista completa hacia que el oraculo
 * comparara EL COMENTARIO, dijera OK, y encima nombrara el archivo correcto en el
 * mensaje. La tabla de verdad, que admitia un solo valor, no se comparo contra nada.
 *
 * Los comentarios de bloque no se sacan: este proyecto no los usa en SQL, y una
 * implementacion a medias que no lo diga es peor que ninguna.
 */
export function sinComentarios(sql) {
  return sql.replace(/--[^\n]*/g, '')
}

/**
 * Cada `CREATE TABLE` de un archivo SQL, con su nombre, su cuerpo y si es `STRICT`.
 *
 * El terminador es `\n)` seguido de lo que haya hasta el `;`, y ese "lo que haya"
 * admite comas: `) STRICT, WITHOUT ROWID;` es SQL legitimo —y lo correcto para una
 * tabla puente con clave compuesta— y con el terminador anterior (`[A-Za-z ]*`) la
 * coma no cerraba, asi que la expresion seguia hasta el `);` de la tabla SIGUIENTE
 * y se la comia. Es EL MISMO defecto que la primera vuelta reporto para `);` pelado,
 * resucitado por su propio arreglo: se tapo la forma exacta y quedo abierta la
 * categoria. Lo midio la segunda vuelta.
 *
 * `estricta` mira si aparece la palabra, no si el sufijo es exactamente `STRICT`.
 */
export function tablasDeclaradas(sql) {
  const salida = []
  const re = /CREATE TABLE (?:IF NOT EXISTS )?["'`\[]?(\w+)["'`\]]?\s*\(([\s\S]*?)\n\)([^;]*);/g
  for (const m of sinComentarios(sql).matchAll(re)) {
    salida.push({
      tabla: m[1],
      cuerpo: m[2],
      estricta: /\bSTRICT\b/i.test(m[3]),
      posicion: m.index,
    })
  }
  return salida
}

/**
 * Los renombres, con la POSICION en la que aparecen.
 *
 * La posicion no es un adorno: un renombre solo puede afectar a una tabla creada
 * ANTES que el. La version anterior los buscaba por nombre sin mirar el orden, y la
 * segunda vuelta de auditoria midio el patron que eso rompe — renombrar la tabla
 * vieja a `x_historica` y despues crear una `x` nueva. El oraculo concluia que la
 * tabla NUEVA se llamaba `x_historica`, la perdia de vista, y firmaba.
 */
export function renombresDeclarados(sql) {
  return [...sinComentarios(sql).matchAll(/ALTER TABLE (\w+) RENAME TO (\w+);/g)].map((m) => ({
    de: m[1],
    a: m[2],
    posicion: m.index,
  }))
}

/**
 * A que nombre termina llamandose una tabla, siguiendo la cadena de renombres.
 *
 * Se sigue la cadena entera y no un solo salto: `a → b → c` tiene que dar `c`. El
 * tope de vueltas evita que un renombre circular escrito por error cuelgue al
 * oraculo — un oraculo que no termina es peor que uno que se equivoca, porque no
 * da veredicto ninguno.
 */
export function nombreFinal(tabla, renombres, desde = -1) {
  let actual = tabla
  let posicion = desde
  for (let i = 0; i < renombres.length + 1; i += 1) {
    // Solo cuenta un renombre POSTERIOR al punto en el que estamos. Sin esto, un
    // `ALTER TABLE x RENAME TO x_historica` escrito ARRIBA del `CREATE TABLE x`
    // se le aplicaba igual a la tabla nueva.
    const siguiente = renombres.find(
      (r) => r.de === actual && (r.posicion === undefined || r.posicion > posicion),
    )
    if (siguiente === undefined) return actual
    actual = siguiente.a
    posicion = siguiente.posicion ?? posicion
  }
  throw new Error(`cadena de renombres circular alrededor de ${tabla}`)
}

/** El CHECK de una columna, leido de su definicion adentro del cuerpo de la tabla. */
export function checkDeColumna(cuerpo, columna) {
  const re = new RegExp(`${columna}\\s+TEXT NOT NULL CHECK \\(${columna} IN \\(([^)]+)\\)\\)`)
  const m = cuerpo.match(re)
  if (m === null) return null
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/**
 * Toda tabla del nucleo tiene que ser `STRICT`, y esto se comprueba aparte de las
 * fronteras a proposito.
 *
 * Dos motivos. El primero es del dominio: los guaranies viven en columnas INTEGER,
 * y sin `STRICT` un `'100000'` de TEXTO entra y ordena como texto —`'9' > '100000'`—.
 * El segundo es del oraculo: `tablasDeclaradas` corta cada tabla en su `);`, y una
 * tabla sin `STRICT` que nadie mire es la puerta por la que se cuela una definicion
 * que no se comparo contra nada. Comprobarlo solo sobre las tablas de una frontera
 * dejaria justo afuera a la tabla que causa el problema, que fue el primer intento.
 */
export function tablasFlojas(archivos, leer) {
  const salida = []
  for (const archivo of archivos) {
    for (const t of tablasDeclaradas(leer(archivo))) {
      if (!t.estricta) salida.push({ archivo, tabla: t.tabla })
    }
  }
  return salida
}

/**
 * El orden en que wrangler las APLICA, que no es el orden alfabetico.
 *
 * wrangler compara el prefijo numerico con `parseInt`; `readdirSync().sort()`
 * compara texto. Con un archivo sin relleno a cuatro digitos las dos listas se
 * separan — medido: wrangler aplica `9_novena.sql` y despues `0010_decima.sql`,
 * mientras el orden alfabetico pone `0010` primero y deja a `9_novena` de ultima.
 *
 * Con «comparar todas las declaraciones» esto no importaba. El arreglo que paso a
 * comparar solo la ultima introdujo la dependencia del orden sin garantizarlo, y lo
 * midio la segunda vuelta de auditoria. El desempate por nombre mantiene el
 * resultado estable cuando dos archivos comparten numero.
 */
export function enOrdenDeAplicacion(archivos) {
  return [...archivos].sort((a, b) => {
    const na = Number.parseInt(a, 10)
    const nb = Number.parseInt(b, 10)
    if (Number.isNaN(na) || Number.isNaN(nb) || na === nb) return a < b ? -1 : a > b ? 1 : 0
    return na - nb
  })
}

/**
 * Cual de las declaraciones manda: la ULTIMA.
 *
 * Existe como funcion propia y no como un `enSql[enSql.length - 1]` escrito en dos
 * lugares porque el arnes de mutacion lo pidio — con la expresion repetida, la
 * mutacion que la ataca es ambigua y `mutar.mjs` la rechaza en vez de correrla. Un
 * invariante que se decide en dos lugares no se puede atacar en uno.
 */
export function laQueGobierna(enSql) {
  return enSql[enSql.length - 1]
}

export function checksDeLaFrontera(archivos, leer, tabla, columna) {
  const salida = []
  for (const archivo of archivos) {
    const sql = leer(archivo)
    const renombres = renombresDeclarados(sql)
    for (const t of tablasDeclaradas(sql)) {
      if (nombreFinal(t.tabla, renombres, t.posicion) !== tabla) continue
      const check = checkDeColumna(t.cuerpo, columna)
      if (check !== null) salida.push({ archivo, declarada: t.tabla, check })
    }
  }
  return salida
}

/**
 * Los tipos de bolsa que declara el esquema del SQLite del Durable Object.
 *
 * Es la copia mas peligrosa de todas: es la que gobierna la tabla donde NACE el
 * asiento. Las otras son TypeScript (que el compilador cuida) y el CHECK de D1
 * (que solo recibe copias).
 */
export function extraerTiposDelEsquemaDO(contenido) {
  const m = contenido.match(/export const TIPOS_DE_BOLSA = \[([^\]]+)\]/)
  if (m === null) {
    throw new Error('no se encontro "export const TIPOS_DE_BOLSA" en el esquema del DO')
  }
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** Pura, para que la mutacion la pueda atacar sin tocar disco ni procesos. */
export function compararEsquemas(tipos, check) {
  const enCheck = new Set(check)
  const enTipos = new Set(tipos)
  const faltantes = tipos.filter((t) => !enCheck.has(t))
  const sobrantes = check.filter((t) => !enTipos.has(t))
  return { ok: faltantes.length === 0 && sobrantes.length === 0, faltantes, sobrantes }
}

/**
 * El orden tambien importa, y solo entre TypeScript y el esquema del DO.
 *
 * En `bolsas.ts` el orden de `TipoBolsa` es documental, pero en `esquema.ts` la
 * lista se interpola dentro de los `CHECK` del DDL. Que las dos listas tengan los
 * mismos elementos EN EL MISMO ORDEN hace que el DDL generado sea reproducible y
 * que un diff del esquema se lea. No es una ley del dominio: es higiene, y se
 * reporta aparte para que no se confunda con un descuadre de contenido.
 */
export function compararOrden(tipos, delDO) {
  return { ok: tipos.join('|') === delDO.join('|'), tipos, delDO }
}

function main() {
  const migraciones = enOrdenDeAplicacion(readdirSync(DIR_MIGRACIONES).filter((n) => n.endsWith('.sql')))
  const leer = (n) => readFileSync(join(DIR_MIGRACIONES, n), 'utf8')

  const flojas = tablasFlojas(migraciones, leer)
  if (flojas.length > 0) {
    console.error('\n  check-esquema: hay tablas declaradas SIN STRICT\n')
    for (const f of flojas) console.error(`  ${f.archivo}: ${f.tabla}`)
    console.error('\n  Sin STRICT, un guarani escrito como texto entra y ordena como texto:')
    console.error("  '9' > '100000'. Y para este oraculo es peor todavia — una tabla que")
    console.error('  no cierra donde tiene que cerrar hace desaparecer a la que viene detras.\n')
    process.exit(1)
  }

  for (const frontera of FRONTERAS) {
    const tipos = extraerTipo(readFileSync(join(RAIZ, ...frontera.archivo), 'utf8'), frontera.tipo)
    const enSql = checksDeLaFrontera(migraciones, leer, frontera.tabla, frontera.columna)

    // El bucle de mas abajo recorre una lista; una lista vacia no se queja. Es la
    // forma que tomaria un cambio en como se escribe la columna —la expresion
    // regular deja de encontrarla— o una tabla renombrada a otra cosa: el oraculo
    // diria OK sin haber comparado nada, que es el unico resultado inaceptable.
    if (enSql.length === 0) {
      console.error(
        `\n  check-esquema: NINGUNA migracion declara el CHECK de ${frontera.tabla}.${frontera.columna}\n`,
      )
      console.error(`  Lo necesita el tipo ${frontera.tipo}, que quedaria sin nadie enfrente.`)
      console.error('  O se borro la columna, o cambio la forma en que se declara, o la tabla')
      console.error('  se renombro. Las tres terminan igual: un oraculo que dice OK sin comparar.\n')
      process.exit(1)
    }

    // SOLO LA ULTIMA, que es la que gobierna. Comparar TODAS las declaraciones
    // historicas parecia mas estricto y era un defecto: una auditoria midio que
    // agregar un valor al tipo obligaba a editar `0001_cimientos.sql` —una migracion
    // YA APLICADA en staging— porque su CHECK viejo dejaba de coincidir. La unica
    // salida verde era reescribir la historia, que es lo contrario de lo que este
    // proyecto sostiene sobre migraciones. La declaracion que manda es la ultima,
    // igual que en la base.
    const ultima = laQueGobierna(enSql)
    for (const { archivo, declarada, check } of [ultima]) {
      const r = compararEsquemas(tipos, check)
      if (r.ok) continue

      const donde = declarada === frontera.tabla ? declarada : `${declarada} → ${frontera.tabla}`
      console.error(`\n  check-esquema: ${frontera.tipo} y el CHECK de ${donde}`)
      console.error(`  en ${archivo} se desincronizaron\n`)
      if (r.faltantes.length > 0) {
        console.error(`  en ${frontera.tipo} pero no en el CHECK: ${r.faltantes.join(', ')}`)
      }
      if (r.sobrantes.length > 0) {
        console.error(`  en el CHECK pero no en ${frontera.tipo}: ${r.sobrantes.join(', ')}`)
      }
      console.error('\n  El dia que se escriba una fila con el valor que falta, el INSERT viola el')
      console.error('  CHECK: falla en runtime, con la operacion ya empezada, y no acá.\n')
      process.exit(1)
    }
  }

  // La copia de los tipos de bolsa que no vive en SQL sino en el DDL que el
  // Durable Object ejecuta. No entra en `FRONTERAS` porque no es una columna de
  // una migracion: es otra clase de frontera, con su propio extractor.
  const tiposDeBolsa = extraerTipo(
    readFileSync(join(RAIZ, 'src', 'dinero', 'bolsas.ts'), 'utf8'),
    'TipoBolsa',
  )
  const delDO = extraerTiposDelEsquemaDO(readFileSync(ARCHIVO_ESQUEMA_DO, 'utf8'))

  const contraDO = compararEsquemas(tiposDeBolsa, delDO)
  if (!contraDO.ok) {
    console.error('\n  check-esquema: TipoBolsa y el esquema del Durable Object se desincronizaron\n')
    if (contraDO.faltantes.length > 0) {
      console.error(`  en TipoBolsa pero no en el esquema del DO: ${contraDO.faltantes.join(', ')}`)
    }
    if (contraDO.sobrantes.length > 0) {
      console.error(`  en el esquema del DO pero no en TipoBolsa: ${contraDO.sobrantes.join(', ')}`)
    }
    console.error('\n  Esta es la peor de las fronteras: el esquema del DO gobierna la tabla')
    console.error('  donde NACE el asiento. Un tipo de bolsa que le falte hace que el INSERT')
    console.error('  falle con la plata adentro de la operacion, no en una copia posterior.\n')
    process.exit(1)
  }

  const orden = compararOrden(tiposDeBolsa, delDO)
  if (!orden.ok) {
    console.error('\n  check-esquema: TipoBolsa y el esquema del DO tienen los mismos tipos en')
    console.error('  DISTINTO ORDEN\n')
    console.error(`  TipoBolsa          : ${orden.tipos.join(', ')}`)
    console.error(`  esquema del DO     : ${orden.delDO.join(', ')}`)
    console.error('\n  El contenido coincide, asi que ninguna operacion se rompe. Pero la lista')
    console.error('  del DO se interpola dentro de los CHECK del DDL, y con el orden distinto el')
    console.error('  esquema generado cambia sin que haya cambiado nada.\n')
    process.exit(1)
  }

  // El mensaje dice de DONDE salio cada comparacion, no solo que hubo tres. Lo pidio
  // una auditoria: con el texto anterior, el OK del camino sano y el OK de un
  // oraculo que habia dejado de ver una declaracion eran byte por byte identicos. Un
  // veredicto que no distingue «compare la de 0003» de «compare la de 0001» no deja
  // ver que se quedo ciego.
  const detalle = FRONTERAS.map((f) => {
    const enSql = checksDeLaFrontera(migraciones, leer, f.tabla, f.columna)
    const ultima = laQueGobierna(enSql)
    return `${f.tipo}↔${f.tabla}.${f.columna} (${ultima.archivo})`
  }).join(', ')
  console.log(`  check-esquema: el esquema del DO y ${detalle}`)
}

if (invocadoDirecto(import.meta)) main()

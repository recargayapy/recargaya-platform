#!/usr/bin/env node
/**
 * Pruebas propias de check-esquema.mjs.
 *
 * Node plano, no vitest, a proposito: es la herramienta que prueba a la
 * herramienta que existe justamente porque `npm run probar` (vitest) no
 * alcanza a este archivo — no tiene sentido atar su propia verificacion a lo
 * mismo que no la cubria.
 *
 * Uso: node herramientas/check-esquema.pruebas.mjs
 */

import assert from 'node:assert/strict'
import {
  FRONTERAS,
  enOrdenDeAplicacion,
  sinComentarios,
  checkDeColumna,
  checksDeLaFrontera,
  declaracionesDeLaTabla,
  compararEsquemas,
  compararOrden,
  extraerTipo,
  extraerTipoBolsa,
  extraerTiposDelEsquemaDO,
  nombreFinal,
  renombresDeclarados,
  tablasDeclaradas,
} from './check-esquema.mjs'

// --- comparacion pura ------------------------------------------------------

assert.deepEqual(compararEsquemas(['disponible', 'retenido'], ['disponible', 'retenido']), {
  ok: true,
  faltantes: [],
  sobrantes: [],
})

assert.deepEqual(compararEsquemas(['disponible', 'retenido'], ['disponible']), {
  ok: false,
  faltantes: ['retenido'],
  sobrantes: [],
})

assert.deepEqual(compararEsquemas(['disponible'], ['disponible', 'fantasma']), {
  ok: false,
  faltantes: [],
  sobrantes: ['fantasma'],
})

// --- lectura del tipo de TypeScript ---------------------------------------

assert.deepEqual(extraerTipoBolsa(`export type TipoBolsa = 'disponible' | 'retenido'\n`), [
  'disponible',
  'retenido',
])

// El nombre entra por parametro: es lo que hace que agregar una frontera no pida
// una funcion nueva. Si esto se rompiera, `Capacidad` y `EstadoPersona` quedarian
// sin extractor.
assert.deepEqual(extraerTipo(`export type Capacidad = 'cliente' | 'vendedor'\n`, 'Capacidad'), [
  'cliente',
  'vendedor',
])

// Y que no se confunda de tipo cuando hay dos declarados en el mismo archivo,
// que es exactamente el caso de `capacidades.ts`.
{
  const archivo = `export type Capacidad = 'cliente' | 'vendedor'\nexport type EstadoPersona = 'activa' | 'cerrada'\n`
  assert.deepEqual(extraerTipo(archivo, 'EstadoPersona'), ['activa', 'cerrada'])
}

assert.throws(() => extraerTipo('nada por aca', 'TipoBolsa'), /no se encontro/)

// --- lectura del SQL -------------------------------------------------------

const SQL_DE_JUGUETE = `
CREATE TABLE personas (
  id     TEXT PRIMARY KEY,
  estado TEXT NOT NULL CHECK (estado IN ('activa', 'cerrada'))
) STRICT;

CREATE TABLE pedidos (
  id     TEXT PRIMARY KEY,
  estado TEXT NOT NULL CHECK (estado IN ('creado', 'pagado'))
) STRICT;
`

assert.deepEqual(
  tablasDeclaradas(SQL_DE_JUGUETE).map((t) => t.tabla),
  ['personas', 'pedidos'],
)

// EL CASO QUE SE COMIA UNA TABLA. Con el terminador anterior —que buscaba
// `) STRICT;`— una tabla sin STRICT no cortaba, y la expresion seguia hasta el
// terminador de la SIGUIENTE, haciendola desaparecer del oraculo.
{
  const conUnaSinStrict = `
CREATE TABLE juguete (
  id TEXT PRIMARY KEY
);

CREATE TABLE capacidades (
  capacidad TEXT NOT NULL CHECK (capacidad IN ('cliente'))
) STRICT;
`
  const tablas = tablasDeclaradas(conUnaSinStrict)
  assert.deepEqual(
    tablas.map((t) => [t.tabla, t.estricta]),
    [
      ['juguete', false],
      ['capacidades', true],
    ],
  )
}

assert.deepEqual(checkDeColumna(tablasDeclaradas(SQL_DE_JUGUETE)[0].cuerpo, 'estado'), [
  'activa',
  'cerrada',
])

// Una columna que la tabla no declara devuelve null, no una lista vacia: la
// diferencia importa porque `checksDeLaFrontera` cuenta cuantas encontro, y una
// lista vacia contaria como "la encontre y no tiene valores".
assert.equal(checkDeColumna(tablasDeclaradas(SQL_DE_JUGUETE)[0].cuerpo, 'bolsa'), null)

// EL CASO QUE OBLIGO A MIRAR LA TABLA Y NO SOLO LA COLUMNA.
//
// `estado` existe en las dos tablas con listas distintas. Buscando por nombre de
// columna, cada una fallaba contra el tipo de la otra. Esta prueba es el oraculo
// de esa decision.
{
  const enPersonas = checksDeLaFrontera(['x.sql'], () => SQL_DE_JUGUETE, 'personas', 'estado')
  const enPedidos = checksDeLaFrontera(['x.sql'], () => SQL_DE_JUGUETE, 'pedidos', 'estado')
  assert.deepEqual(
    enPersonas.map((x) => x.check),
    [['activa', 'cerrada']],
  )
  assert.deepEqual(
    enPedidos.map((x) => x.check),
    [['creado', 'pagado']],
  )
}

// EL SQL QUE ESTA ADENTRO DE UN COMENTARIO NO ES SQL.
//
// Los encabezados de este proyecto CITAN DDL viejo textualmente. La segunda vuelta
// de auditoria midio la consecuencia: el oraculo comparaba el COMENTARIO, decia OK,
// y encima nombraba el archivo correcto en el mensaje.
{
  const conCita = `
-- La version anterior decia:
--   CREATE TABLE capacidades (
--     capacidad TEXT NOT NULL CHECK (capacidad IN ('cliente', 'vendedor')),
--   ) STRICT;
CREATE TABLE capacidades (
  capacidad TEXT NOT NULL CHECK (capacidad IN ('cliente'))
) STRICT;
`
  assert.equal(sinComentarios('SELECT 1; -- y esto no\nSELECT 2;'), 'SELECT 1; \nSELECT 2;')
  const hallado = checksDeLaFrontera(['x.sql'], () => conCita, 'capacidades', 'capacidad')
  assert.deepEqual(
    hallado.map((h) => h.check),
    [['cliente']],
    'el oraculo comparo la cita del comentario en vez de la tabla',
  )
}

// `) STRICT, WITHOUT ROWID;` es SQL legitimo y no puede comerse la tabla siguiente.
// Es el defecto de la primera vuelta (`);` pelado) resucitado por su propio arreglo:
// el terminador nuevo no admitia la coma.
{
  const conSufijoCompuesto = `
CREATE TABLE puente (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  PRIMARY KEY (a, b)
) STRICT, WITHOUT ROWID;

CREATE TABLE capacidades (
  capacidad TEXT NOT NULL CHECK (capacidad IN ('cliente'))
) STRICT;
`
  const tablas = tablasDeclaradas(conSufijoCompuesto)
  assert.deepEqual(
    tablas.map((t) => [t.tabla, t.estricta]),
    [
      ['puente', true],
      ['capacidades', true],
    ],
  )
}

// --- el orden de aplicacion ------------------------------------------------
// wrangler compara el prefijo con `parseInt`; `sort()` compara texto. Con un archivo
// sin relleno a cuatro digitos, «la ultima» del oraculo no es la ultima que aplica
// la base — y desde que el oraculo compara SOLO la ultima, eso decide el veredicto.
assert.deepEqual(enOrdenDeAplicacion(['0010_decima.sql', '9_novena.sql']), [
  '9_novena.sql',
  '0010_decima.sql',
])
assert.deepEqual(
  enOrdenDeAplicacion(['0003_c.sql', '0001_a.sql', '0002_b.sql']),
  ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
)

// --- renombres -------------------------------------------------------------

// Lleva `posicion`: un renombre solo puede afectar a una tabla creada ANTES que el.
assert.deepEqual(renombresDeclarados('ALTER TABLE a_nueva RENAME TO a;'), [
  { de: 'a_nueva', a: 'a', posicion: 0 },
])

assert.equal(nombreFinal('a_nueva', [{ de: 'a_nueva', a: 'a' }]), 'a')
assert.equal(nombreFinal('sin_renombre', []), 'sin_renombre')

// La cadena entera, no un solo salto.
assert.equal(
  nombreFinal('a', [
    { de: 'a', a: 'b' },
    { de: 'b', a: 'c' },
  ]),
  'c',
)

// Un renombre circular tiene que tirar, no colgarse. Un oraculo que no termina no
// da veredicto, que es peor que uno que se equivoca.
assert.throws(
  () =>
    nombreFinal('a', [
      { de: 'a', a: 'b' },
      { de: 'b', a: 'a' },
    ]),
  /circular/,
)

// LA TABLA RECONSTRUIDA. Es el caso de 0002 (`ledger_copia_nueva`) y de 0003
// (`personas_nueva`, `capacidades_nueva`): el CREATE TABLE que gobierna lleva el
// nombre provisorio. Sin resolver el renombre, el oraculo no lo ve — y es
// justamente el ultimo, o sea el que manda.
{
  const sql = `
CREATE TABLE IF NOT EXISTS personas_nueva (
  estado TEXT NOT NULL CHECK (estado IN ('activa', 'suspendida'))
) STRICT;
ALTER TABLE personas_nueva RENAME TO personas;
`
  const hallado = checksDeLaFrontera(['x.sql'], () => sql, 'personas', 'estado')
  assert.deepEqual(
    hallado.map((h) => [h.declarada, h.check]),
    [['personas_nueva', ['activa', 'suspendida']]],
  )
}

// UN RENOMBRE ESCRITO ARRIBA DEL CREATE NO LE APLICA A LA TABLA NUEVA.
//
// El patron es renombrar la vieja a `x_historica` y despues crear una `x` nueva.
// Buscando el renombre por nombre sin mirar el orden, el oraculo concluia que la
// tabla NUEVA se llamaba `x_historica`, la perdia de vista, y firmaba.
{
  const renombrarYRecrear = `
ALTER TABLE capacidades RENAME TO capacidades_historica;

CREATE TABLE capacidades (
  capacidad TEXT NOT NULL CHECK (capacidad IN ('cliente'))
) STRICT;
`
  const hallado = checksDeLaFrontera(['x.sql'], () => renombrarYRecrear, 'capacidades', 'capacidad')
  assert.deepEqual(
    hallado.map((h) => [h.declarada, h.check]),
    [['capacidades', ['cliente']]],
    'el renombre de arriba se le aplico a la tabla creada abajo',
  )
}

// --- el esquema del Durable Object ----------------------------------------

assert.deepEqual(
  extraerTiposDelEsquemaDO(
    "export const TIPOS_DE_BOLSA = [\n  'disponible',\n  'retenido',\n] as const\n",
  ),
  ['disponible', 'retenido'],
)

assert.throws(() => extraerTiposDelEsquemaDO('nada por aca'), /no se encontro/)

assert.equal(compararOrden(['a', 'b'], ['a', 'b']).ok, true)
assert.equal(compararOrden(['a', 'b'], ['b', 'a']).ok, false)
assert.deepEqual(compararOrden(['a', 'b'], ['b', 'a']), {
  ok: false,
  tipos: ['a', 'b'],
  delDO: ['b', 'a'],
})

// Las fronteras declaradas no pueden quedar en cero por un descuido de edicion:
// con la lista vacia, `main()` no compara nada y sale 0.
assert.ok(FRONTERAS.length >= 4, 'se esperaban al menos cuatro fronteras declaradas')

// Y que cada frontera apunte a un archivo que existe y a un tipo que se puede leer.
// Sin esto, una frontera con la ruta mal escrita hace fallar `main()` con un ENOENT
// pelado — que se lee como «se rompio la herramienta» y no como «alguien declaro mal
// una frontera».
for (const f of FRONTERAS) {
  assert.ok(Array.isArray(f.archivo) && f.archivo.length > 0, `frontera ${f.tipo} sin archivo`)
  assert.ok(typeof f.tabla === 'string' && f.tabla.length > 0, `frontera ${f.tipo} sin tabla`)
  assert.ok(typeof f.columna === 'string' && f.columna.length > 0, `frontera ${f.tipo} sin columna`)
}

// --- de punta a punta ------------------------------------------------------
// Las de arriba prueban las funciones puras. Sin esto, `main()` no lo ejercita
// nadie: la mutacion del guard del CLI —invocarlo y que no verifique nada—
// sobrevivia, porque estas pruebas nunca corrian el proceso.

const { spawnSync } = await import('node:child_process')
const { mkdtempSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import(
  'node:fs'
)
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { fileURLToPath } = await import('node:url')

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/** Copia lo que el oraculo necesita, aplica una perturbacion y lo corre ahi. El
 *  arbol de verdad no se toca: es un archivo versionado el que se rompe. */
function correrSobreCopia(perturbar) {
  const dir = mkdtempSync(join(tmpdir(), 'check-esquema-'))
  try {
    // Si el oraculo crece y necesita otro archivo, agregalo a esta lista.
    for (const x of ['herramientas', 'src', 'migraciones']) {
      cpSync(join(RAIZ, x), join(dir, x), { recursive: true })
    }
    perturbar(dir)
    const r = spawnSync(process.execPath, [join(dir, 'herramientas', 'check-esquema.mjs')], {
      cwd: tmpdir(),
      encoding: 'utf8',
    })
    return { codigo: r.status, salida: `${r.stdout}${r.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CARPETA = ['migraciones', 'core']

/** Los .sql, ordenados. */
function migracionesDe(dir) {
  return readdirSync(join(dir, ...CARPETA))
    .filter((n) => n.endsWith('.sql'))
    .sort()
}

/**
 * La ULTIMA migracion que declara cierto texto, que es la que gobierna.
 *
 * Va "la ultima que lo declara" y no "la ultima" a secas, y ese es un arreglo que
 * pidio esta misma entrega: la version anterior perturbaba `migraciones.pop()`
 * sin mas, y funcionaba porque el CHECK de `bolsa` casualmente vivia en la
 * ultima. Con 0003 —que no toca `bolsa`— esa prueba se rompia sin que nada
 * estuviera mal. Una prueba que depende de que la proxima migracion hable del
 * mismo tema no es un oraculo: es una casualidad con fecha de vencimiento.
 */
function ultimaQueDeclara(dir, textoBuscado) {
  const candidatas = migracionesDe(dir).filter((n) =>
    readFileSync(join(dir, ...CARPETA, n), 'utf8').includes(textoBuscado),
  )
  assert.ok(candidatas.length > 0, `ninguna migracion declara ${textoBuscado}`)
  return candidatas.pop()
}

function reemplazarEn(dir, archivo, de, a) {
  const p = join(dir, ...CARPETA, archivo)
  const texto = readFileSync(p, 'utf8')
  assert.ok(texto.includes(de), `${archivo} no contiene el fragmento a perturbar`)
  writeFileSync(p, texto.replace(de, a))
}

const CHECK_BOLSA =
  "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion', 'retenido'))"
const CHECK_CAPACIDAD = "CHECK (capacidad IN ('cliente', 'vendedor', 'creador', 'distribuidor'))"
const CHECK_ESTADO = "CHECK (estado IN ('activa', 'suspendida', 'cerrada'))"

// Camino sano.
{
  const r = correrSobreCopia(() => {})
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /check-esquema: el esquema del DO y/)
}

// FRONTERA 1 — un tipo de bolsa que le falta al CHECK, en la ULTIMA migracion que
// lo declara. 0002 reconstruye `ledger_copia` para arreglarle la clave primaria,
// asi que el CHECK que gobierna de verdad es el suyo, no el de 0001.
{
  const r = correrSobreCopia((dir) => {
    reemplazarEn(
      dir,
      ultimaQueDeclara(dir, CHECK_BOLSA),
      CHECK_BOLSA,
      "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion'))",
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /se desincronizaron/)
  assert.match(r.salida, /retenido/)
}

// FRONTERA 2 — la capacidad que se agrega en TypeScript y se olvida en el SQL.
// Es EL defecto que la entrega 1.2 trajo con ella, y se comprueba en la direccion
// en que va a ocurrir: primero el tipo, despues el olvido.
{
  const r = correrSobreCopia((dir) => {
    const p = join(dir, 'src', 'identidad', 'capacidades.ts')
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace(
        "export type Capacidad = 'cliente' | 'vendedor' | 'creador' | 'distribuidor'",
        "export type Capacidad = 'cliente' | 'vendedor' | 'creador' | 'distribuidor' | 'afiliado'",
      ),
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /Capacidad/)
  assert.match(r.salida, /afiliado/)
}

// Y en la direccion contraria: el CHECK que pierde un valor que el tipo si tiene.
{
  const r = correrSobreCopia((dir) => {
    reemplazarEn(
      dir,
      ultimaQueDeclara(dir, CHECK_CAPACIDAD),
      CHECK_CAPACIDAD,
      "CHECK (capacidad IN ('cliente', 'vendedor', 'creador'))",
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /distribuidor/)
}

// FRONTERA 3 — `personas.estado`. Es la que prueba que mirar la tabla sirve: si
// el oraculo comparara por nombre de columna, esta perturbacion tambien haria
// fallar a `pedidos.estado` y el mensaje hablaria de la tabla equivocada.
{
  const r = correrSobreCopia((dir) => {
    reemplazarEn(
      dir,
      ultimaQueDeclara(dir, CHECK_ESTADO),
      CHECK_ESTADO,
      "CHECK (estado IN ('activa', 'suspendida'))",
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /EstadoPersona/)
  assert.match(r.salida, /cerrada/)
}

// `pedidos.estado` NO puede hacer fallar a nada: no es una frontera declarada.
// Sin esta prueba, un oraculo que confunda las tablas pasaria las de arriba y se
// notaria recien cuando alguien tocara pedidos.
{
  const r = correrSobreCopia((dir) => {
    reemplazarEn(
      dir,
      ultimaQueDeclara(dir, "CHECK (estado IN ('creado', 'pagado', 'repartido', 'cancelado'))"),
      "CHECK (estado IN ('creado', 'pagado', 'repartido', 'cancelado'))",
      "CHECK (estado IN ('creado', 'pagado', 'repartido'))",
    )
  })
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
}

// Un tipo de bolsa que le falta al esquema del DO. Es la frontera mas peligrosa:
// gobierna la tabla donde nace el asiento.
{
  const r = correrSobreCopia((dir) => {
    const p = join(dir, 'src', 'billetera', 'esquema.ts')
    writeFileSync(p, readFileSync(p, 'utf8').replace("  'retenido',\n", ''))
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /esquema del Durable Object se desincronizaron/)
  assert.match(r.salida, /retenido/)
}

// Los mismos tipos en distinto orden: no rompe ninguna operacion, pero cambia el
// DDL generado, y se reporta aparte para no confundirlo con un descuadre.
{
  const r = correrSobreCopia((dir) => {
    const p = join(dir, 'src', 'billetera', 'esquema.ts')
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace(
        "  'disponible',\n  'ganancia_creador',",
        "  'ganancia_creador',\n  'disponible',",
      ),
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /DISTINTO ORDEN/)
}

// Y si NINGUNA migracion declara el CHECK de una frontera, el oraculo tiene que
// fallar en vez de decir OK sin haber comparado nada. Es la forma que tomaria un
// cambio en como se escribe la columna: la expresion regular deja de encontrarla,
// la lista queda vacia, y un bucle sobre una lista vacia no se queja.
{
  const r = correrSobreCopia((dir) => {
    for (const n of migracionesDe(dir)) {
      const p = join(dir, ...CARPETA, n)
      writeFileSync(p, readFileSync(p, 'utf8').replaceAll('CHECK (bolsa IN', 'CHECK (bolsita IN'))
    }
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NINGUNA migracion/)
}

// UN RENOMBRE QUE EL ORACULO NO SIGUE.
//
// Se perturba EL RENOMBRE, no el CHECK. La version anterior de este bloque decia
// eso y hacia otra cosa: repetia byte por byte la perturbacion del bloque de mas
// arriba, con una asercion `/a → b|a/` cuya segunda alternativa aceptaba cualquier
// mensaje que mencionara la tabla. Lo encontro una auditoria.
//
// Rompiendo el renombre, la tabla reconstruida de 0003 queda llamandose
// `capacidades_nueva` para el oraculo. La declaracion que gobierna desaparece de la
// lista y la que manda pasa a ser la de 0001 — o sea que el oraculo compara contra
// una definicion que la base ya no tiene. Se comprueba haciendo que las dos digan
// cosas distintas: se le agrega `afiliado` SOLO a la de 0003. Con el renombre
// resuelto, el oraculo mira la de 0003 y falla; sin resolverlo, mira la de 0001,
// coincide, y firma.
{
  const r = correrSobreCopia((dir) => {
    const archivo = ultimaQueDeclara(dir, CHECK_CAPACIDAD)
    reemplazarEn(
      dir,
      archivo,
      CHECK_CAPACIDAD,
      "CHECK (capacidad IN ('cliente', 'vendedor', 'creador', 'distribuidor', 'afiliado'))",
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /capacidades_nueva → capacidades/)
  assert.match(r.salida, /afiliado/)
}

// UNA TABLA SIN STRICT NO PUEDE PASAR DESAPERCIBIDA.
//
// Es el defecto de arriba visto desde el proceso entero: antes, agregar una tabla
// sin STRICT delante de `capacidades_nueva` la borraba del oraculo y la salida
// seguia siendo `exit 0`. Ahora corta con un error que la nombra.
{
  const r = correrSobreCopia((dir) => {
    const archivo = ultimaQueDeclara(dir, CHECK_CAPACIDAD)
    reemplazarEn(
      dir,
      archivo,
      'CREATE TABLE capacidades_nueva (',
      'CREATE TABLE floja (\n  id TEXT PRIMARY KEY\n);\n\nCREATE TABLE capacidades_nueva (',
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /SIN STRICT/)
  assert.match(r.salida, /floja/)
}

// EL ESQUEMA TIENE QUE PODER EVOLUCIONAR SIN REESCRIBIR LA HISTORIA.
//
// Agregar un valor al tipo y una migracion nueva que reconstruya la tabla con el
// CHECK correcto es EXACTAMENTE lo que el proyecto haria. Con la version que
// comparaba TODAS las declaraciones historicas, esto fallaba contra el CHECK de
// `0001_cimientos.sql` —una migracion ya aplicada en staging— y la unica salida
// verde era editarla. Lo midio una auditoria.
{
  const r = correrSobreCopia((dir) => {
    const p = join(dir, 'src', 'identidad', 'capacidades.ts')
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace(
        "export type Capacidad = 'cliente' | 'vendedor' | 'creador' | 'distribuidor'",
        "export type Capacidad = 'cliente' | 'vendedor' | 'creador' | 'distribuidor' | 'afiliado'",
      ),
    )
    writeFileSync(
      join(dir, ...CARPETA, '0004_afiliado.sql'),
      [
        'CREATE TABLE capacidades_v2 (',
        '  persona_id  TEXT NOT NULL REFERENCES personas(id),',
        "  capacidad   TEXT NOT NULL CHECK (capacidad IN ('cliente', 'vendedor', 'creador', 'distribuidor', 'afiliado')),",
        '  otorgada_en TEXT NOT NULL,',
        '  hasta       TEXT,',
        '  PRIMARY KEY (persona_id, capacidad, otorgada_en)',
        ') STRICT;',
        'INSERT INTO capacidades_v2 SELECT * FROM capacidades;',
        'DROP TABLE capacidades;',
        'ALTER TABLE capacidades_v2 RENAME TO capacidades;',
        '',
      ].join('\n'),
    )
  })
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /0004_afiliado\.sql/)
}

// DE PUNTA A PUNTA: una migracion nueva cuyo comentario cita el DDL viejo completo
// y cuya tabla real achica la lista. Es la forma exacta que midio la auditoria.
{
  const r = correrSobreCopia((dir) => {
    writeFileSync(
      join(dir, ...CARPETA, '0004_recorte.sql'),
      [
        '-- La version anterior de esta tabla decia:',
        '--   CREATE TABLE capacidades (',
        "--     capacidad TEXT NOT NULL CHECK (capacidad IN ('cliente', 'vendedor', 'creador', 'distribuidor')),",
        '--   ) STRICT;',
        'DROP TABLE capacidades;',
        'CREATE TABLE capacidades (',
        '  persona_id  TEXT NOT NULL REFERENCES personas(id),',
        "  capacidad   TEXT NOT NULL CHECK (capacidad IN ('cliente')),",
        '  otorgada_en TEXT NOT NULL,',
        '  hasta       TEXT,',
        '  PRIMARY KEY (persona_id, capacidad, otorgada_en)',
        ') STRICT;',
        '',
      ].join('\n'),
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /se desincronizaron/)
  assert.match(r.salida, /0004_recorte\.sql/)
}

// --- la ultima declaracion legible tiene que ser la ultima declaracion -------
// LO ENCONTRO LA SEGUNDA VUELTA DE AUDITORIA DE LA 1.3, y es la tercera vez que esta
// herramienta tiene el mismo defecto con otro disfraz: aprobar la definicion de una
// tabla que ya no gobierna. Acá el disfraz es un CHECK escrito a nivel de TABLA, que
// `checkDeColumna` no sabe leer — asi que la declaracion nueva no entraba a la lista y
// se comparaba contra la vieja, en verde.

{
  const CON_CHECK_DE_TABLA = `
CREATE TABLE pedidos_v2 (
  id     TEXT PRIMARY KEY,
  estado TEXT NOT NULL,
  CHECK (estado IN ('creado', 'pagado'))
) STRICT;
DROP TABLE pedidos;
ALTER TABLE pedidos_v2 RENAME TO pedidos;
`
  // La declaracion existe y se ve...
  const decls = declaracionesDeLaTabla(['0005.sql'], () => CON_CHECK_DE_TABLA, 'pedidos')
  assert.equal(decls.length, 1, 'la declaracion con CHECK de tabla tiene que verse')
  assert.equal(decls[0].declarada, 'pedidos_v2')

  // ...y su CHECK NO se puede leer. Las dos cosas juntas son el agujero.
  const checks = checksDeLaFrontera(['0005.sql'], () => CON_CHECK_DE_TABLA, 'pedidos', 'estado')
  assert.equal(checks.length, 0, 'el CHECK a nivel de tabla no lo lee `checkDeColumna`')
}

{
  const r = correrSobreCopia((dir) => {
    writeFileSync(
      join(dir, 'migraciones', 'core', '0005_prueba.sql'),
      `CREATE TABLE pedidos_v2 (
  id     TEXT PRIMARY KEY,
  estado TEXT NOT NULL,
  CHECK (estado IN ('creado', 'pagado'))
) STRICT;
DROP TABLE pedidos;
ALTER TABLE pedidos_v2 RENAME TO pedidos;
`,
    )
  })
  assert.equal(r.codigo, 1, 'una tabla redeclarada con un CHECK ilegible tiene que fallar')
  assert.match(r.salida, /la ultima declaracion de pedidos esta en 0005_prueba\.sql/)
}

console.log(`  check-esquema.pruebas: OK (${FRONTERAS.length} fronteras, renombres, comentarios, orden, STRICT, la ultima declaracion y punta a punta)`)

#!/usr/bin/env node
/**
 * Pruebas propias de emitir-token.mjs.
 *
 * Node plano, no vitest, por lo mismo que las de los otros oraculos: es la
 * herramienta que prueba a una herramienta que vitest no alcanza.
 *
 * LA PRUEBA QUE IMPORTA es la ultima: el token que emite esta herramienta lo
 * VERIFICA `verificarToken()`, o sea el mismo codigo que corre en la puerta. Es lo
 * unico que hace que «no se duplica la logica de firma» sea un hecho y no una
 * intencion — si algun dia alguien copia el HMAC acá, esta prueba sigue pasando…
 * hasta que las dos versiones se separen, que es justo cuando tiene que fallar.
 * Por eso ademas se comprueba que el bundle traiga la funcion de verdad.
 *
 * Uso: node herramientas/emitir-token.pruebas.mjs
 */

import assert from 'node:assert/strict'
import { buscarSecreto, cargarActor, interpretarArgumentos } from './emitir-token.mjs'

// --- los argumentos --------------------------------------------------------

assert.deepEqual(interpretarArgumentos(['--entorno', 'staging']), {
  actor: 'plataforma',
  persona_id: null,
  entorno: 'staging',
  secreto: null,
})

assert.deepEqual(interpretarArgumentos(['--entorno', 'staging', '--persona', 'p-42']), {
  actor: 'persona',
  persona_id: 'p-42',
  entorno: 'staging',
  secreto: null,
})

// El entorno es obligatorio: el token lo lleva adentro de la firma, y uno emitido
// para el entorno equivocado se rechaza con un 401 que no dice por que.
assert.throws(() => interpretarArgumentos([]), /falta --entorno/)

// `--persona` sin valor no puede caer en «la plataforma»: un token de plataforma
// puede cosas que uno de persona no.
assert.throws(() => interpretarArgumentos(['--entorno', 'staging', '--persona']), /necesita un valor/)
assert.throws(
  () => interpretarArgumentos(['--entorno', 'staging', '--persona', '--secreto', 'x']),
  /necesita un valor/,
)
assert.throws(() => interpretarArgumentos(['--entorno']), /necesita un valor/)

// Un argumento que no existe se rechaza en vez de ignorarse: `--persona-id p1`
// ignorado en silencio emite un token de plataforma que el que llama cree de
// persona.
assert.throws(() => interpretarArgumentos(['--entorno', 'staging', '--persona-id', 'p1']), /desconocido/)

// --- de donde sale el secreto ---------------------------------------------

// Lo explicito gana sobre lo guardado, para que nadie firme con un secreto que no
// sabia que estaba ahi.
assert.equal(
  buscarSecreto({ delArgumento: 'del-arg', delEntorno: 'del-env', contenidoDevVars: 'SECRETO_SERVICIO=del-archivo' }),
  'del-arg',
)
assert.equal(
  buscarSecreto({ delArgumento: null, delEntorno: 'del-env', contenidoDevVars: 'SECRETO_SERVICIO=del-archivo' }),
  'del-env',
)
assert.equal(
  buscarSecreto({ delArgumento: null, delEntorno: undefined, contenidoDevVars: 'SECRETO_SERVICIO=del-archivo' }),
  'del-archivo',
)

// Con comillas, con espacios, y con otras lineas alrededor.
assert.equal(
  buscarSecreto({
    delArgumento: null,
    delEntorno: undefined,
    contenidoDevVars: 'OTRA=1\n  SECRETO_SERVICIO = "con comillas"  \nMAS=2\n',
  }),
  'con comillas',
)

// Una variable que solo se PARECE no cuenta.
assert.equal(
  buscarSecreto({ delArgumento: null, delEntorno: undefined, contenidoDevVars: 'OTRO_SECRETO_SERVICIO=x' }),
  null,
)
assert.equal(buscarSecreto({ delArgumento: null, delEntorno: undefined, contenidoDevVars: null }), null)

// Una cadena vacia no es un secreto: sin esto, `SECRETO_SERVICIO=` en el entorno
// tapa al de `.dev.vars` y despues falla con un mensaje sobre el largo minimo.
assert.equal(
  buscarSecreto({ delArgumento: '', delEntorno: '', contenidoDevVars: 'SECRETO_SERVICIO=el-bueno' }),
  'el-bueno',
)

// --- lo que de verdad importa: el token entra por la puerta ---------------

const actor = await cargarActor()

// Que el bundle sea el codigo de verdad y no un cascaron: si `cargarActor` dejara
// de traer estas funciones, todo lo de abajo se caeria con un TypeError confuso.
for (const nombre of ['emitirToken', 'verificarToken', 'secretoDelServicio', 'VENTANA_MS']) {
  assert.ok(actor[nombre] !== undefined, `el bundle no trajo ${nombre}`)
}

const SECRETO = 'un-secreto-de-prueba-largo-y-que-no-vale-nada'
const AHORA = new Date().toISOString()

// LA PRUEBA. Emitir con la herramienta, verificar con la puerta.
{
  const token = await actor.emitirToken(
    { actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: 'staging' },
    SECRETO,
  )
  const quien = await actor.verificarToken(token, SECRETO, 'staging', AHORA)
  assert.deepEqual(quien, { tipo: 'plataforma' })
}

{
  const token = await actor.emitirToken(
    { actor: { tipo: 'persona', persona_id: 'p-42' }, emitido_en: AHORA, entorno: 'staging' },
    SECRETO,
  )
  assert.deepEqual(await actor.verificarToken(token, SECRETO, 'staging', AHORA), {
    tipo: 'persona',
    persona_id: 'p-42',
  })
}

// Y que el entorno del token sea el que se pidio, no uno cualquiera: emitir para
// staging y que sirva en produccion seria justo lo que el campo existe para impedir.
{
  const token = await actor.emitirToken(
    { actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: 'staging' },
    SECRETO,
  )
  await assert.rejects(
    () => actor.verificarToken(token, SECRETO, 'produccion', AHORA),
    /entorno_ajeno/,
  )
}

// El piso del secreto es el mismo que el de la puerta. Sin esta comprobacion, la
// herramienta emitiria tokens que el Worker rechaza y el que los use va a pensar
// que el problema es el token.
assert.throws(() => actor.secretoDelServicio({ SECRETO_SERVICIO: 'corto' }), /secreto_debil/)

console.log('  emitir-token.pruebas: OK (argumentos, secreto, y el token verifica en la puerta)')

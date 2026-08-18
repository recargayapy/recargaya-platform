/**
 * Pruebas de la puerta: quien llama.
 *
 * Lo que importa acá no es que un token bueno entre —eso es lo facil— sino que
 * los malos no entren, que el orden en que se los rechaza no le regale
 * informacion a quien prueba, y que la ausencia del secreto cierre la puerta en
 * vez de abrirla.
 */

import { describe, it, expect } from 'vitest'
import {
  MARGEN_FUTURO_MS,
  TokenInvalido,
  VENTANA_MS,
  type Actor,
  actorDeLaPeticion,
  actorId,
  desdeBase64Url,
  emitirToken,
  frescura,
  haciaBase64Url,
  interpretarCuerpo,
  partirToken,
  secretoDelServicio,
  verificarToken,
} from '../src/identidad/actor.js'
import { instante } from '../src/dinero/momento.js'

const SECRETO = 'un-secreto-de-prueba-que-no-vale-nada-y-es-largo'
const ENTORNO = 'staging'
const AHORA = instante('2026-08-18T12:00:00.000Z')

const motivoDe = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
  } catch (e) {
    if (e instanceof TokenInvalido) return e.motivo
    throw e
  }
  throw new Error('no tiro')
}

describe('la forma del token', () => {
  it('tres partes o nada', () => {
    expect(() => partirToken('v1.solo-dos')).toThrow(/forma_invalida/)
    expect(() => partirToken('v1.a.b.c')).toThrow(/forma_invalida/)
    expect(() => partirToken('')).toThrow(/forma_invalida/)
  })

  it('una version que no conocemos se rechaza, no se interpreta', () => {
    expect(() => partirToken('v2.cuerpo.firma')).toThrow(/version_desconocida/)
  })

  it('partes vacias no pasan', () => {
    expect(() => partirToken('v1..firma')).toThrow(/forma_invalida/)
    expect(() => partirToken('v1.cuerpo.')).toThrow(/forma_invalida/)
  })

  it('lo que se firma incluye la version', () => {
    // Si la firma cubriera solo el cuerpo, cambiar `v1` por `v2` no la
    // invalidaria — y el dia que exista un v2 con otras reglas, eso seria una
    // forma de elegir cual se aplica.
    expect(partirToken('v1.abc.def').firmado).toBe('v1.abc')
  })
})

describe('base64url', () => {
  it('ida y vuelta, con y sin relleno', () => {
    for (const texto of ['a', 'ab', 'abc', 'abcd', 'hola mundo', '{"actor":"plataforma"}']) {
      const bytes = new TextEncoder().encode(texto)
      expect(new TextDecoder().decode(desdeBase64Url(haciaBase64Url(bytes)))).toBe(texto)
    }
  })

  it('no emite los caracteres que rompen una URL', () => {
    const codificado = haciaBase64Url(new Uint8Array([251, 255, 190, 254]))
    expect(codificado).not.toMatch(/[+/=]/)
  })

  it('basura adentro sale como rechazo con motivo, no como error de plataforma', () => {
    expect(() => desdeBase64Url('no es base64 !!!')).toThrow(TokenInvalido)
  })
})

describe('el cuerpo del token', () => {
  it('la plataforma', () => {
    expect(interpretarCuerpo({ actor: 'plataforma', emitido_en: AHORA, entorno: ENTORNO })).toEqual({
      actor: { tipo: 'plataforma' },
      emitido_en: AHORA,
      entorno: ENTORNO,
    })
  })

  it('una persona', () => {
    expect(interpretarCuerpo({ actor: 'persona', persona_id: 'p1', emitido_en: AHORA, entorno: ENTORNO })).toEqual({
      actor: { tipo: 'persona', persona_id: 'p1' },
      emitido_en: AHORA,
      entorno: ENTORNO,
    })
  })

  it('persona sin id NO cae en un valor por defecto', () => {
    // Un `?? ''` acá deja filas de bitacora con el actor en blanco, que es peor
    // que no tener bitacora: parece que hay registro.
    expect(() => interpretarCuerpo({ actor: 'persona', emitido_en: AHORA, entorno: ENTORNO })).toThrow(
      /cuerpo_invalido/,
    )
    expect(() =>
      interpretarCuerpo({ actor: 'persona', persona_id: '', emitido_en: AHORA, entorno: ENTORNO }),
    ).toThrow(/cuerpo_invalido/)
  })

  it('un actor que no conocemos se rechaza', () => {
    expect(() => interpretarCuerpo({ actor: 'root', emitido_en: AHORA, entorno: ENTORNO })).toThrow(/cuerpo_invalido/)
    expect(() => interpretarCuerpo({ emitido_en: AHORA, entorno: ENTORNO })).toThrow(/cuerpo_invalido/)
  })

  it('un instante mal escrito se rechaza', () => {
    expect(() => interpretarCuerpo({ actor: 'plataforma', emitido_en: '2026-08-18', entorno: ENTORNO })).toThrow(
      /cuerpo_invalido/,
    )
    expect(() => interpretarCuerpo({ actor: 'plataforma', entorno: ENTORNO })).toThrow(/cuerpo_invalido/)
  })

  it('lo que ni siquiera es un objeto', () => {
    expect(() => interpretarCuerpo(null)).toThrow(/cuerpo_invalido/)
    expect(() => interpretarCuerpo('texto')).toThrow(/cuerpo_invalido/)
  })
})

describe('la ventana de frescura', () => {
  const mas = (ms: number) => instante(new Date(Date.parse(AHORA) + ms).toISOString())

  it('recien emitido esta fresco', () => {
    expect(frescura(AHORA, AHORA)).toBe('fresco')
  })

  it('un milisegundo antes del limite todavia sirve', () => {
    expect(frescura(AHORA, mas(VENTANA_MS - 1))).toBe('fresco')
  })

  it('en el limite exacto ya no', () => {
    // El borde esta declarado: se rechaza cuando la edad ALCANZA la ventana. Que
    // el limite sea el primer instante invalido se lee de una sola forma.
    expect(frescura(AHORA, mas(VENTANA_MS))).toBe('vencido')
  })

  it('un reloj apenas adelantado se perdona', () => {
    expect(frescura(mas(MARGEN_FUTURO_MS), AHORA)).toBe('fresco')
  })

  it('un reloj muy adelantado no', () => {
    expect(frescura(mas(MARGEN_FUTURO_MS + 1), AHORA)).toBe('del_futuro')
  })
})

describe('firmar y verificar', () => {
  it('un token propio entra', async () => {
    const token = await emitirToken({ actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: ENTORNO }, SECRETO)
    await expect(verificarToken(token, SECRETO, ENTORNO, AHORA)).resolves.toEqual({ tipo: 'plataforma' })
  })

  it('un token de persona conserva el id', async () => {
    const actor: Actor = { tipo: 'persona', persona_id: 'p-42' }
    const token = await emitirToken({ actor, emitido_en: AHORA, entorno: ENTORNO }, SECRETO)
    await expect(verificarToken(token, SECRETO, ENTORNO, AHORA)).resolves.toEqual(actor)
  })

  it('con otro secreto NO entra', async () => {
    const token = await emitirToken({ actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: ENTORNO }, SECRETO)
    expect(await motivoDe(() => verificarToken(token, 'otro-secreto', ENTORNO, AHORA))).toBe('firma_invalida')
  })

  it('cambiarle el cuerpo lo invalida', async () => {
    // El caso que importa: alguien toma un token de persona y le cambia el
    // persona_id por el de otro. Sin firma sobre el cuerpo, eso es una cuenta
    // ajena.
    const token = await emitirToken(
      { actor: { tipo: 'persona', persona_id: 'p1' }, emitido_en: AHORA, entorno: ENTORNO },
      SECRETO,
    )
    const { firma } = partirToken(token)
    const otroCuerpo = haciaBase64Url(
      new TextEncoder().encode(JSON.stringify({ actor: 'persona', persona_id: 'p2', emitido_en: AHORA })),
    )
    expect(await motivoDe(() => verificarToken(`v1.${otroCuerpo}.${firma}`, SECRETO, ENTORNO, AHORA))).toBe(
      'firma_invalida',
    )
  })

  it('un token viejo se rechaza por vencido', async () => {
    const token = await emitirToken({ actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: ENTORNO }, SECRETO)
    const tarde = instante(new Date(Date.parse(AHORA) + VENTANA_MS).toISOString())
    expect(await motivoDe(() => verificarToken(token, SECRETO, ENTORNO, tarde))).toBe('token_vencido')
  })

  it('la firma se comprueba ANTES que la fecha', async () => {
    // Al reves, un token vencido con firma mala y uno vencido con firma buena
    // darian motivos distintos: un oraculo gratis para el que prueba tokens.
    const token = await emitirToken({ actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: ENTORNO }, SECRETO)
    const tarde = instante(new Date(Date.parse(AHORA) + VENTANA_MS).toISOString())
    expect(await motivoDe(() => verificarToken(token, 'secreto-equivocado', ENTORNO, tarde))).toBe(
      'firma_invalida',
    )
  })

  it('una firma bien formada pero ajena no entra', async () => {
    const cuerpo = haciaBase64Url(
      new TextEncoder().encode(JSON.stringify({ actor: 'plataforma', emitido_en: AHORA })),
    )
    const firmaInventada = haciaBase64Url(new Uint8Array(32).fill(7))
    expect(
      await motivoDe(() => verificarToken(`v1.${cuerpo}.${firmaInventada}`, SECRETO, ENTORNO, AHORA)),
    ).toBe('firma_invalida')
  })
})

describe('el token pertenece a un entorno', () => {
  it('uno de otro entorno no entra, aunque la firma y la fecha esten bien', async () => {
    const token = await emitirToken(
      { actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: 'produccion' },
      SECRETO,
    )
    expect(await motivoDe(() => verificarToken(token, SECRETO, 'staging', AHORA))).toBe(
      'entorno_ajeno',
    )
  })

  it('el entorno se comprueba DESPUES de la firma', async () => {
    // Si se mirara antes, un token de otro entorno con firma inventada daria una
    // respuesta distinta que uno con firma buena: otro oraculo gratis.
    const token = await emitirToken(
      { actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: 'produccion' },
      'un-secreto-que-no-es-el-nuestro-y-es-largo',
    )
    expect(await motivoDe(() => verificarToken(token, SECRETO, 'staging', AHORA))).toBe(
      'firma_invalida',
    )
  })

  it('un cuerpo sin entorno se rechaza', () => {
    expect(() => interpretarCuerpo({ actor: 'plataforma', emitido_en: AHORA })).toThrow(
      /cuerpo_invalido/,
    )
  })
})

describe('el secreto que falta', () => {
  it('sin secreto la puerta se cierra, no se abre', () => {
    expect(() => secretoDelServicio({})).toThrow(/sin_secreto/)
    expect(() => secretoDelServicio({ SECRETO_SERVICIO: '' })).toThrow(/sin_secreto/)
  })

  it('el secreto corto tiene su PROPIO motivo', async () => {
    // Con un solo motivo para los dos casos, el operador que puso un secreto de 24
    // caracteres leia «no esta configurado» en el log y salia a buscar el
    // `wrangler secret put` que ya habia hecho. Lo midio la segunda vuelta.
    expect(await motivoDe(async () => secretoDelServicio({}))).toBe('sin_secreto')
    expect(await motivoDe(async () => secretoDelServicio({ SECRETO_SERVICIO: '' }))).toBe(
      'sin_secreto',
    )
    expect(await motivoDe(async () => secretoDelServicio({ SECRETO_SERVICIO: 'abc' }))).toBe(
      'secreto_debil',
    )
  })

  it('un secreto corto tampoco abre la puerta', () => {
    // Lo pidio una auditoria con la medicion al lado: con un secreto de tres letras,
    // recuperarlo por fuerza bruta desde un token capturado corre a ~14.000
    // candidatos por segundo en UN hilo de Node. `secretoDelServicio` fallaba cerrado
    // ante la AUSENCIA y abierto ante la DEBILIDAD.
    expect(() => secretoDelServicio({ SECRETO_SERVICIO: 'abc' })).toThrow(/secreto_debil/)
    expect(() => secretoDelServicio({ SECRETO_SERVICIO: 'x'.repeat(31) })).toThrow(/secreto_debil/)
    expect(secretoDelServicio({ SECRETO_SERVICIO: 'x'.repeat(32) })).toHaveLength(32)
  })

  it('con secreto lo devuelve tal cual', () => {
    expect(secretoDelServicio({ SECRETO_SERVICIO: SECRETO })).toBe(SECRETO)
  })
})

describe('de la peticion al actor', () => {
  const pedir = (encabezados: Record<string, string>) =>
    new Request('https://ejemplo.test/personas', { headers: encabezados })

  it('sin encabezado no hay actor', async () => {
    expect(
      await motivoDe(() => actorDeLaPeticion(pedir({}), { SECRETO_SERVICIO: SECRETO, ENTORNO }, AHORA)),
    ).toBe('sin_encabezado')
  })

  it('con otro esquema de autorizacion tampoco', async () => {
    expect(
      await motivoDe(() =>
        actorDeLaPeticion(
          pedir({ authorization: 'Basic dXNlcjpwYXNz' }),
          { SECRETO_SERVICIO: SECRETO, ENTORNO },
          AHORA,
        ),
      ),
    ).toBe('sin_encabezado')
  })

  it('Bearer sin token tampoco', async () => {
    expect(
      await motivoDe(() =>
        actorDeLaPeticion(pedir({ authorization: 'Bearer ' }), { SECRETO_SERVICIO: SECRETO, ENTORNO }, AHORA),
      ),
    ).toBe('sin_encabezado')
  })

  it('el esquema no distingue mayusculas', async () => {
    const token = await emitirToken({ actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: ENTORNO }, SECRETO)
    await expect(
      actorDeLaPeticion(
        pedir({ authorization: `bearer ${token}` }),
        { SECRETO_SERVICIO: SECRETO, ENTORNO },
        AHORA,
      ),
    ).resolves.toEqual({ tipo: 'plataforma' })
  })

  it('con el secreto ausente, un token perfecto tampoco entra', async () => {
    const token = await emitirToken({ actor: { tipo: 'plataforma' }, emitido_en: AHORA, entorno: ENTORNO }, SECRETO)
    expect(
      await motivoDe(() => actorDeLaPeticion(pedir({ authorization: `Bearer ${token}` }), { ENTORNO }, AHORA)),
    ).toBe('sin_secreto')
  })
})

describe('lo que la segunda vuelta encontro en la puerta', () => {
  it('una FIRMA ilegible dice que la firma es ilegible, no el cuerpo', async () => {
    // Antes salia `cuerpo_ilegible` y el que investigaba el log iba a mirar el cuerpo
    // del token, que estaba perfecto.
    const cuerpo = haciaBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ actor: 'plataforma', emitido_en: AHORA, entorno: ENTORNO }),
      ),
    )
    expect(
      await motivoDe(() => verificarToken(`v1.${cuerpo}.no es base64 !!!`, SECRETO, ENTORNO, AHORA)),
    ).toBe('firma_ilegible')
  })

  it('un token de persona no puede llamarse como la plataforma', async () => {
    // `IDS_RESERVADOS` cerraba la puerta de creacion; este es el unico camino por el
    // que entra un `persona_id` que nunca paso por `POST /personas`. Que hoy no haga
    // daño depende de que ninguna ruta deje a un actor `persona` escribir bitacora —
    // o sea de un accidente de las autorizaciones, no del guarda.
    expect(() =>
      interpretarCuerpo({
        actor: 'persona',
        persona_id: 'plataforma',
        emitido_en: AHORA,
        entorno: ENTORNO,
      }),
    ).toThrow(/cuerpo_invalido/)

    expect(() =>
      interpretarCuerpo({
        actor: 'persona',
        persona_id: 'PLATAFORMA',
        emitido_en: AHORA,
        entorno: ENTORNO,
      }),
    ).toThrow(/cuerpo_invalido/)
  })
})

describe('como se escribe el actor en la bitacora', () => {
  it('la plataforma tambien deja rastro', () => {
    expect(actorId({ tipo: 'plataforma' })).toBe('plataforma')
  })

  it('una persona deja su id', () => {
    expect(actorId({ tipo: 'persona', persona_id: 'p1' })).toBe('p1')
  })
})

/**
 * La entrega 1.2 de punta a punta, adentro de workerd: la migracion 0003 sobre
 * SQLite de verdad, el endpoint por HTTP de verdad, y el Durable Object del otro
 * lado.
 *
 * POR QUE ESTAS PRUEBAS NO PODIAN SER DEL NUCLEO
 *
 * Todo lo que se prueba acá es lo que el TypeScript no puede prometer: que el
 * indice unico parcial exista, que el CHECK del instante rechace, que un `batch`
 * de D1 sea de verdad una transaccion, y que la bitacora quede escrita ANTES de
 * que la plata se mueva. Un doble de D1 probaria el doble.
 */

import { env, SELF, applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { emitirToken } from '../src/identidad/actor.js'
import { derivarBilleteraId } from '../src/identidad/personas.js'

/** Ver el encabezado del binding en `vitest.runtime.config.ts`. */
const SECRETO = (env as unknown as { SECRETO_SERVICIO: string }).SECRETO_SERVICIO
const MIGRACIONES = (env as unknown as { MIGRACIONES: D1Migration[] }).MIGRACIONES

beforeAll(async () => {
  expect(Array.isArray(MIGRACIONES)).toBe(true)
  expect(MIGRACIONES.length).toBeGreaterThan(0)
  await applyD1Migrations(env.CORE, MIGRACIONES)
})

const ahora = () => new Date().toISOString()

async function tokenDePlataforma(): Promise<string> {
  return emitirToken({ actor: { tipo: 'plataforma' }, emitido_en: ahora() as never, entorno: env.ENTORNO }, SECRETO)
}

async function tokenDePersona(persona_id: string): Promise<string> {
  return emitirToken(
    { actor: { tipo: 'persona', persona_id }, emitido_en: ahora() as never, entorno: env.ENTORNO },
    SECRETO,
  )
}

interface Opciones {
  token?: string
  cuerpo?: unknown
  correlacion?: string
}

async function llamar(metodo: string, ruta: string, o: Opciones = {}): Promise<Response> {
  const encabezados: Record<string, string> = {}
  if (o.token !== undefined) encabezados['authorization'] = `Bearer ${o.token}`
  if (o.correlacion !== undefined) encabezados['x-correlacion-id'] = o.correlacion
  if (o.cuerpo !== undefined) encabezados['content-type'] = 'application/json'

  // El cuerpo se agrega solo si lo hay: con `exactOptionalPropertyTypes`, pasar
  // `undefined` explicito no es lo mismo que no pasar la clave, y el tipo de
  // `RequestInit` no admite el primero.
  return SELF.fetch(`https://prueba.test${ruta}`, {
    method: metodo,
    headers: encabezados,
    ...(o.cuerpo === undefined ? {} : { body: JSON.stringify(o.cuerpo) }),
  })
}

/** Crea una persona con las capacidades pedidas y devuelve su id. Cada prueba usa
 *  el suyo: D1 se comparte entre pruebas del mismo archivo. */
async function personaCon(id: string, capacidades: readonly string[]): Promise<string> {
  const token = await tokenDePlataforma()
  const r = await llamar('POST', '/personas', { token, cuerpo: { persona_id: id } })
  expect(r.status).toBe(201)
  for (const capacidad of capacidades) {
    const c = await llamar('POST', `/personas/${id}/capacidades`, { token, cuerpo: { capacidad } })
    expect(c.status).toBe(201)
  }
  return id
}

// ---------------------------------------------------------------------------
// El esquema que trajo la 0003
// ---------------------------------------------------------------------------

describe('la migracion 0003, medida y no supuesta', () => {
  it('personas tiene billetera_id obligatoria y unica', async () => {
    await env.CORE.prepare(
      "INSERT INTO personas (id, creada_en, estado, billetera_id) VALUES ('esq-1', ?, 'activa', 'billetera:esq-1')",
    )
      .bind(ahora())
      .run()

    // Dos personas compartiendo billetera es plata de uno contada como del otro.
    // Es la clase de defecto que no da error: da un saldo.
    await expect(
      env.CORE.prepare(
        "INSERT INTO personas (id, creada_en, estado, billetera_id) VALUES ('esq-2', ?, 'activa', 'billetera:esq-1')",
      )
        .bind(ahora())
        .run(),
    ).rejects.toThrow()
  })

  it('una persona sin billetera_id no entra', async () => {
    await expect(
      env.CORE.prepare(
        "INSERT INTO personas (id, creada_en, estado, billetera_id) VALUES ('esq-3', ?, 'activa', NULL)",
      )
        .bind(ahora())
        .run(),
    ).rejects.toThrow()
  })

  it('NO puede haber dos ventanas abiertas de la misma capacidad', async () => {
    await personaCon('esq-ventanas', [])
    const abrir = (otorgada_en: string) =>
      env.CORE.prepare(
        "INSERT INTO capacidades (persona_id, capacidad, otorgada_en, hasta) VALUES ('esq-ventanas', 'vendedor', ?, NULL)",
      )
        .bind(otorgada_en)
        .run()

    // Los dos `otorgada_en` son DISTINTOS y el mensaje se afirma: sin eso, la
    // segunda fila viola tambien la clave primaria `(persona_id, capacidad,
    // otorgada_en)` y la prueba no puede distinguir un motivo del otro. Lo midio
    // una auditoria: dos llamadas seguidas a `ahora()` devuelven el MISMO
    // milisegundo, asi que la version anterior pasaba por casualidad del reloj.
    await abrir('2026-03-01T00:00:00.000Z')
    await expect(abrir('2026-04-01T00:00:00.000Z')).rejects.toThrow(
      /UNIQUE constraint failed: capacidades\.persona_id, capacidades\.capacidad/,
    )
  })

  it('pero SI puede haber muchas ventanas cerradas — eso es la historia', async () => {
    await personaCon('esq-historia', [])
    await env.CORE.batch([
      env.CORE.prepare(
        "INSERT INTO capacidades (persona_id, capacidad, otorgada_en, hasta) VALUES ('esq-historia', 'vendedor', '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')",
      ),
      env.CORE.prepare(
        "INSERT INTO capacidades (persona_id, capacidad, otorgada_en, hasta) VALUES ('esq-historia', 'vendedor', '2026-04-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')",
      ),
      env.CORE.prepare(
        "INSERT INTO capacidades (persona_id, capacidad, otorgada_en, hasta) VALUES ('esq-historia', 'vendedor', '2026-07-01T00:00:00.000Z', NULL)",
      ),
    ])

    const { results } = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM capacidades WHERE persona_id = 'esq-historia'",
    ).all<{ n: number }>()
    expect(results[0]?.n).toBe(3)
  })

  it('una ventana que termina antes de empezar no entra', async () => {
    await personaCon('esq-invertida', [])
    await expect(
      env.CORE.prepare(
        "INSERT INTO capacidades (persona_id, capacidad, otorgada_en, hasta) VALUES ('esq-invertida', 'creador', '2026-07-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')",
      ).run(),
    ).rejects.toThrow()
  })

  it('un instante con otro huso no entra en la base', async () => {
    // El CHECK del ancho, del lado de adentro. `otorgada_en` y `hasta` se COMPARAN
    // como texto: con anchos distintos, "vigente" y "vencida" dejan de significar
    // lo que dicen.
    await personaCon('esq-huso', [])
    await expect(
      env.CORE.prepare(
        "INSERT INTO capacidades (persona_id, capacidad, otorgada_en, hasta) VALUES ('esq-huso', 'creador', '2026-07-01T00:00:00.000-03:00', NULL)",
      ).run(),
    ).rejects.toThrow()
  })

  it('un instante sin milisegundos tampoco', async () => {
    await personaCon('esq-corto', [])
    await expect(
      env.CORE.prepare(
        "INSERT INTO capacidades (persona_id, capacidad, otorgada_en, hasta) VALUES ('esq-corto', 'creador', '2026-07-01T00:00:00Z', NULL)",
      ).run(),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// La puerta
// ---------------------------------------------------------------------------

describe('la puerta rechaza', () => {
  it('sin encabezado, 401 y sin decir por que', async () => {
    const r = await llamar('POST', '/personas', { cuerpo: {} })
    expect(r.status).toBe(401)
    const cuerpo = (await r.json()) as Record<string, unknown>
    expect(cuerpo['error']).toBe('no_autorizado')
    // El motivo se conoce y va al log, NO a la respuesta: decirle a quien golpea
    // la puerta si fallo la firma o la fecha le regala la mitad del trabajo.
    expect(JSON.stringify(cuerpo)).not.toMatch(/firma|vencido|encabezado/)
  })

  it('un token firmado con otro secreto, 401', async () => {
    const ajeno = await emitirToken(
      { actor: { tipo: 'plataforma' }, emitido_en: ahora() as never, entorno: env.ENTORNO },
      'otro-secreto-cualquiera',
    )
    const r = await llamar('POST', '/personas', { token: ajeno, cuerpo: {} })
    expect(r.status).toBe(401)
  })

  it('un token viejo, 401', async () => {
    const viejo = await emitirToken(
      { actor: { tipo: 'plataforma' }, emitido_en: '2026-01-01T00:00:00.000Z' as never, entorno: env.ENTORNO },
      SECRETO,
    )
    const r = await llamar('POST', '/personas', { token: viejo, cuerpo: {} })
    expect(r.status).toBe(401)
  })

  it('/salud sigue abierta, porque el CI la mira sin credenciales', async () => {
    const r = await SELF.fetch('https://prueba.test/salud')
    expect(r.status).toBe(200)
  })

  it('una ruta que no existe, 404 — y despues de identificar, no antes', async () => {
    const token = await tokenDePlataforma()
    expect((await llamar('GET', '/no-existe', { token })).status).toBe(404)
    expect((await llamar('GET', '/no-existe')).status).toBe(401)
  })
})

describe('las cuentas ajenas son de la plataforma', () => {
  it('una persona no puede crear personas', async () => {
    const token = await tokenDePersona('cualquiera')
    const r = await llamar('POST', '/personas', { token, cuerpo: {} })
    expect(r.status).toBe(403)
    expect((await r.json() as Record<string, unknown>)['error']).toBe('solo_la_plataforma')
  })

  it('una persona no puede ver el saldo de otra', async () => {
    await personaCon('ajena-duena', ['cliente'])
    const token = await tokenDePersona('ajena-intrusa')
    const r = await llamar('GET', '/billetera/ajena-duena/saldo', { token })
    expect(r.status).toBe(403)
  })

  it('pero si el suyo', async () => {
    await personaCon('propia', ['cliente'])
    const token = await tokenDePersona('propia')
    const r = await llamar('GET', '/billetera/propia/saldo', { token })
    expect(r.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

describe('crear una persona', () => {
  it('nace activa, con su billetera, y queda en la bitacora', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/personas', {
      token,
      cuerpo: { persona_id: 'crear-1' },
      correlacion: 'corr-crear-1',
    })
    expect(r.status).toBe(201)

    const cuerpo = (await r.json()) as Record<string, unknown>
    expect(cuerpo['estado']).toBe('activa')
    expect(cuerpo['billetera_id']).toBe(derivarBilleteraId('crear-1'))
    expect(cuerpo['capacidades_vigentes']).toEqual([])

    const fila = await env.CORE.prepare(
      "SELECT actor_id, accion, objetivo, correlacion_id FROM bitacora WHERE correlacion_id = 'corr-crear-1'",
    ).first<{ actor_id: string; accion: string; objetivo: string; correlacion_id: string }>()
    expect(fila).toEqual({
      actor_id: 'plataforma',
      accion: 'persona.creada',
      objetivo: 'crear-1',
      correlacion_id: 'corr-crear-1',
    })
  })

  it('el mismo id dos veces es 409, no una segunda cuenta', async () => {
    const token = await tokenDePlataforma()
    await llamar('POST', '/personas', { token, cuerpo: { persona_id: 'crear-2' } })
    const r = await llamar('POST', '/personas', { token, cuerpo: { persona_id: 'crear-2' } })
    expect(r.status).toBe(409)

    // Y no quedo una segunda fila.
    const { results } = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM personas WHERE id = 'crear-2'",
    ).all<{ n: number }>()
    expect(results[0]?.n).toBe(1)
  })

  it('sin id, la plataforma le pone uno', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/personas', { token, cuerpo: {} })
    expect(r.status).toBe(201)
    const cuerpo = (await r.json()) as Record<string, unknown>
    expect(typeof cuerpo['persona_id']).toBe('string')
    expect((cuerpo['persona_id'] as string).length).toBeGreaterThan(0)
  })

  it('toda persona creada por el endpoint tiene su renglon de bitacora', async () => {
    // ESTO NO PRUEBA LA ATOMICIDAD DEL `batch`, y la primera version de esta prueba
    // decia que si. Una auditoria lo midio: saco `sentenciaDeBitacora` del `batch()`
    // y lo dejo como dos escrituras sueltas —destruyendo la ley 5 en este camino— y
    // las 39 pruebas del runtime siguieron en verde. El `arrange` ya garantiza el
    // `assert`: toda creacion exitosa escribe las dos filas, haya o no transaccion.
    //
    // Lo que prueba es el camino feliz, que igual vale. La transaccion la prueba
    // `pruebas-runtime/auditoria.test.ts`, forzando el fallo de la SEGUNDA sentencia
    // y mirando si la PRIMERA quedo.
    const token = await tokenDePlataforma()
    await llamar('POST', '/personas', { token, cuerpo: { persona_id: 'atomica-1' } })

    // Sobre TODAS las personas que entraron por la puerta, no sobre un prefijo.
    // Se excluyen las `esq-%` porque esas se insertaron con SQL directo para
    // probar el esquema y nunca pasaron por el endpoint: incluirlas haria fallar
    // la prueba por el motivo equivocado.
    const huerfanas = await env.CORE.prepare(
      `SELECT COUNT(*) AS n FROM personas p
       WHERE p.id NOT LIKE 'esq-%' AND NOT EXISTS (
         SELECT 1 FROM bitacora b WHERE b.objetivo = p.id AND b.accion = 'persona.creada')`,
    ).first<{ n: number }>()
    expect(huerfanas?.n).toBe(0)
  })
})

describe('otorgar y revocar', () => {
  it('otorgar deja la capacidad vigente', async () => {
    const token = await tokenDePlataforma()
    await personaCon('cap-1', [])
    const r = await llamar('POST', '/personas/cap-1/capacidades', {
      token,
      cuerpo: { capacidad: 'vendedor' },
    })
    expect(r.status).toBe(201)

    const leida = await llamar('GET', '/personas/cap-1', { token })
    expect(((await leida.json()) as Record<string, unknown>)['capacidades_vigentes']).toEqual([
      'vendedor',
    ])
  })

  it('otorgar dos veces la misma es 409', async () => {
    const token = await tokenDePlataforma()
    await personaCon('cap-2', ['creador'])
    const r = await llamar('POST', '/personas/cap-2/capacidades', {
      token,
      cuerpo: { capacidad: 'creador' },
    })
    expect(r.status).toBe(409)
  })

  it('una capacidad que no existe es 400, no un 500', async () => {
    const token = await tokenDePlataforma()
    await personaCon('cap-3', [])
    const r = await llamar('POST', '/personas/cap-3/capacidades', {
      token,
      cuerpo: { capacidad: 'afiliado' },
    })
    expect(r.status).toBe(400)
  })

  it('sobre una persona que no existe es 404', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/personas/no-nacio/capacidades', {
      token,
      cuerpo: { capacidad: 'cliente' },
    })
    expect(r.status).toBe(404)
  })

  it('revocar cierra la ventana SIN borrar la historia', async () => {
    const token = await tokenDePlataforma()
    await personaCon('rev-1', ['vendedor'])

    const r = await llamar('DELETE', '/personas/rev-1/capacidades/vendedor', { token })
    expect(r.status).toBe(200)
    expect(((await r.json()) as Record<string, unknown>)['revocada']).toBe(true)

    // La fila sigue ahi, con su fecha de baja. Ese es todo el punto.
    const fila = await env.CORE.prepare(
      "SELECT otorgada_en, hasta FROM capacidades WHERE persona_id = 'rev-1' AND capacidad = 'vendedor'",
    ).first<{ otorgada_en: string; hasta: string | null }>()
    expect(fila?.hasta).not.toBeNull()
    expect(fila!.hasta! > fila!.otorgada_en).toBe(true)

    const leida = await llamar('GET', '/personas/rev-1', { token })
    expect(((await leida.json()) as Record<string, unknown>)['capacidades_vigentes']).toEqual([])
  })

  it('se puede volver a otorgar despues de revocar, y quedan las dos ventanas', async () => {
    const token = await tokenDePlataforma()
    await personaCon('rev-2', ['creador'])
    await llamar('DELETE', '/personas/rev-2/capacidades/creador', { token })

    const otra = await llamar('POST', '/personas/rev-2/capacidades', {
      token,
      cuerpo: { capacidad: 'creador' },
    })
    expect(otra.status).toBe(201)

    const { results } = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM capacidades WHERE persona_id = 'rev-2' AND capacidad = 'creador'",
    ).all<{ n: number }>()
    expect(results[0]?.n).toBe(2)

    const leida = await llamar('GET', '/personas/rev-2', { token })
    expect(((await leida.json()) as Record<string, unknown>)['capacidades_vigentes']).toEqual([
      'creador',
    ])
  })

  it('revocar dos veces NO escribe un segundo renglon de bitacora', async () => {
    // LA prueba de `sentenciaDeBitacoraSi`. Sin la condicion, la segunda llamada
    // deja escrito "se revoco" sobre una revocacion que no ocurrio — un registro
    // de auditoria que dice algo que no paso es peor que no tener registro.
    const token = await tokenDePlataforma()
    await personaCon('rev-3', ['distribuidor'])

    const primera = await llamar('DELETE', '/personas/rev-3/capacidades/distribuidor', { token })
    expect(((await primera.json()) as Record<string, unknown>)['revocada']).toBe(true)

    const segunda = await llamar('DELETE', '/personas/rev-3/capacidades/distribuidor', { token })
    expect(segunda.status).toBe(200)
    expect(((await segunda.json()) as Record<string, unknown>)['revocada']).toBe(false)

    const { results } = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM bitacora WHERE objetivo = 'rev-3' AND accion = 'capacidad.revocada'",
    ).all<{ n: number }>()
    expect(results[0]?.n).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// La plata
// ---------------------------------------------------------------------------

describe('el primer endpoint a la billetera', () => {
  it('acredita, y la bitacora queda con la misma correlacion', async () => {
    const token = await tokenDePlataforma()
    await personaCon('plata-1', ['cliente'])

    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      correlacion: 'corr-plata-1',
      cuerpo: {
        persona_id: 'plata-1',
        monto: 150_000,
        bolsa: 'disponible',
        clave_idem: 'carga:plata-1:001',
      },
    })
    expect(r.status).toBe(200)
    const cuerpo = (await r.json()) as Record<string, unknown>
    expect(cuerpo['saldo_retirable']).toBe(150_000)
    expect(cuerpo['repetida']).toBe(false)
    expect(r.headers.get('x-correlacion-id')).toBe('corr-plata-1')

    const fila = await env.CORE.prepare(
      "SELECT actor_id, accion, objetivo FROM bitacora WHERE correlacion_id = 'corr-plata-1'",
    ).first<{ actor_id: string; accion: string; objetivo: string }>()
    expect(fila).toEqual({
      actor_id: 'plataforma',
      accion: 'billetera.acreditacion.pedida',
      objetivo: derivarBilleteraId('plata-1'),
    })
  })

  it('la misma clave de idempotencia no mueve plata dos veces', async () => {
    const token = await tokenDePlataforma()
    await personaCon('plata-2', ['cliente'])

    const cuerpo = {
      persona_id: 'plata-2',
      monto: 50_000,
      bolsa: 'disponible',
      clave_idem: 'carga:plata-2:001',
    }
    const primera = await llamar('POST', '/billetera/acreditar', { token, cuerpo })
    const segunda = await llamar('POST', '/billetera/acreditar', { token, cuerpo })

    expect(((await primera.json()) as Record<string, unknown>)['repetida']).toBe(false)
    const dos = (await segunda.json()) as Record<string, unknown>
    expect(dos['repetida']).toBe(true)
    expect(dos['saldo_retirable']).toBe(50_000)
  })

  it('a alguien que NO es cliente no se le acredita', async () => {
    const token = await tokenDePlataforma()
    await personaCon('plata-3', ['vendedor'])

    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'plata-3',
        monto: 10_000,
        bolsa: 'disponible',
        clave_idem: 'carga:plata-3:001',
      },
    })
    expect(r.status).toBe(403)
    const cuerpo = (await r.json()) as Record<string, unknown>
    expect(cuerpo['error']).toBe('no_puede')
    expect(cuerpo['motivo']).toBe('sin_capacidad')
  })

  it('a alguien a quien se le revoco la capacidad, tampoco', async () => {
    // Ley 4 en el camino de verdad: la pregunta lleva momento, y despues de la
    // revocacion el momento cae afuera de la ventana.
    const token = await tokenDePlataforma()
    await personaCon('plata-4', ['cliente'])
    await llamar('DELETE', '/personas/plata-4/capacidades/cliente', { token })

    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'plata-4',
        monto: 10_000,
        bolsa: 'disponible',
        clave_idem: 'carga:plata-4:001',
      },
    })
    expect(r.status).toBe(403)
    expect(((await r.json()) as Record<string, unknown>)['motivo']).toBe('capacidad_vencida')
  })

  it('SIN registro no hay plata: si la bitacora no se puede escribir, no se acredita', async () => {
    // ESTA es la prueba del orden, y por lo tanto de toda la decision de donde se
    // escribe la bitacora. Se rompe la tabla de verdad —se la saca del medio— en
    // vez de simular un fallo, porque un doble que falle cuando uno quiere prueba
    // el doble.
    //
    // Lo que se mide NO es que devuelva 500: es que despues del intento el saldo
    // siga en cero. Si la bitacora se escribiera DESPUES de mover la plata, acá
    // habria 99.000 guaranies sin un solo renglon que diga quien los pidio.
    const token = await tokenDePlataforma()
    await personaCon('plata-5', ['cliente'])

    await env.CORE.prepare('ALTER TABLE bitacora RENAME TO bitacora_escondida').run()
    let estado: number
    try {
      const r = await llamar('POST', '/billetera/acreditar', {
        token,
        cuerpo: {
          persona_id: 'plata-5',
          monto: 99_000,
          bolsa: 'disponible',
          clave_idem: 'carga:plata-5:001',
        },
      })
      estado = r.status
    } finally {
      await env.CORE.prepare('ALTER TABLE bitacora_escondida RENAME TO bitacora').run()
    }

    expect(estado).toBe(500)

    const saldo = await llamar('GET', '/billetera/plata-5/saldo', { token })
    expect(saldo.status).toBe(200)
    const cuerpo = (await saldo.json()) as { bolsas: unknown[]; asientos: number }
    expect(cuerpo.asientos).toBe(0)
    expect(cuerpo.bolsas).toEqual([])
  })

  it('y con la bitacora sana, la misma llamada si acredita', async () => {
    // El contraste. Sin esta, la de arriba pasaria igual si el endpoint estuviera
    // roto por cualquier otro motivo: "no acredito" no prueba nada si nunca
    // acredita.
    const token = await tokenDePlataforma()
    await personaCon('plata-5b', ['cliente'])
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'plata-5b',
        monto: 99_000,
        bolsa: 'disponible',
        clave_idem: 'carga:plata-5b:001',
      },
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as Record<string, unknown>)['saldo_retirable']).toBe(99_000)
  })

  it('rechaza un monto que no es un guarani', async () => {
    const token = await tokenDePlataforma()
    await personaCon('plata-6', ['cliente'])

    for (const monto of [0, -1, 1.5, '100000']) {
      const r = await llamar('POST', '/billetera/acreditar', {
        token,
        cuerpo: {
          persona_id: 'plata-6',
          monto,
          bolsa: 'disponible',
          clave_idem: `carga:plata-6:${String(monto)}`,
        },
      })
      expect(r.status).toBe(400)
    }
  })

  it('no se acredita directo a retenido', async () => {
    // A esa bolsa solo se entra reservando. El nucleo tambien lo rechaza; la
    // puerta lo rechaza antes para que salga un 400 con nombre y no un 500.
    const token = await tokenDePlataforma()
    await personaCon('plata-7', ['cliente'])
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'plata-7',
        monto: 1_000,
        bolsa: 'retenido',
        clave_idem: 'carga:plata-7:001',
      },
    })
    expect(r.status).toBe(400)
  })

  it('sin clave de idempotencia no se acredita', async () => {
    // Generarla del lado del servidor seria generar una distinta en cada
    // reintento: acreditar dos veces cuando la primera respuesta se pierde.
    const token = await tokenDePlataforma()
    await personaCon('plata-8', ['cliente'])
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: { persona_id: 'plata-8', monto: 1_000, bolsa: 'disponible' },
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('falta_clave_idem')
  })

  it('a una persona que no existe, 404 y sin tocar ninguna billetera', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'no-nacio',
        monto: 1_000,
        bolsa: 'disponible',
        clave_idem: 'carga:fantasma',
      },
    })
    expect(r.status).toBe(404)

    const registros = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM bitacora WHERE objetivo = 'billetera:no-nacio'",
    ).first<{ n: number }>()
    expect(registros?.n).toBe(0)
  })

  it('un cuerpo que no es JSON es 400, no un 500', async () => {
    const token = await tokenDePlataforma()
    const r = await SELF.fetch('https://prueba.test/billetera/acreditar', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'esto no es json',
    })
    expect(r.status).toBe(400)
  })
})

describe('la correlacion vuelve siempre', () => {
  it('aunque el llamador no la haya mandado', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('GET', '/personas/no-nacio', { token })
    expect(r.status).toBe(404)
    const devuelta = r.headers.get('x-correlacion-id')
    expect(devuelta).not.toBeNull()
    expect(devuelta!.length).toBeGreaterThan(0)
    expect(((await r.json()) as Record<string, unknown>)['correlacion_id']).toBe(devuelta)
  })

  it('y tambien cuando se rechaza el token', async () => {
    const r = await llamar('GET', '/personas/quien-sea')
    expect(r.status).toBe(401)
    expect(r.headers.get('x-correlacion-id')).not.toBeNull()
  })
})

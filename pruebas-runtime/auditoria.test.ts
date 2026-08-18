/**
 * Las regresiones de las auditorias adversariales de la entrega 1.2.
 *
 * Van en su propio archivo a proposito. Cada bloque de acá nace de un defecto que
 * una auditoria MIDIO —no de una idea— y el nombre de cada prueba dice cual. Que
 * esten juntas hace que se lea de un vistazo que encontro cada vuelta, y que la
 * proxima entrega no las pueda borrar sin darse cuenta de lo que borra.
 *
 * Varias solo se pueden escribir fijando el reloj. La costura para hacerlo existia
 * desde el primer dia de esta entrega y no la usaba nadie: todas las pruebas
 * entraban por `SELF.fetch`, o sea con `new Date()` real, mientras `src/index.ts`
 * decia que «una prueba puede fijar el instante». Una auditoria lo midio.
 */

import { env, SELF, applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { emitirToken } from '../src/identidad/actor.js'
import { derivarBilleteraId } from '../src/identidad/personas.js'
import { guaranies } from '../src/dinero/monto.js'
import { atender } from '../src/api/rutas.js'

const SECRETO = (env as unknown as { SECRETO_SERVICIO: string }).SECRETO_SERVICIO
const MIGRACIONES = (env as unknown as { MIGRACIONES: D1Migration[] }).MIGRACIONES

beforeAll(async () => {
  expect(Array.isArray(MIGRACIONES)).toBe(true)
  expect(MIGRACIONES.length).toBeGreaterThan(0)
  await applyD1Migrations(env.CORE, MIGRACIONES)
})

const ahora = () => new Date().toISOString()

const tokenDePlataforma = () =>
  emitirToken(
    { actor: { tipo: 'plataforma' }, emitido_en: ahora() as never, entorno: env.ENTORNO },
    SECRETO,
  )

const tokenDePersona = (persona_id: string) =>
  emitirToken(
    { actor: { tipo: 'persona', persona_id }, emitido_en: ahora() as never, entorno: env.ENTORNO },
    SECRETO,
  )

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

  return SELF.fetch(`https://prueba.test${ruta}`, {
    method: metodo,
    headers: encabezados,
    ...(o.cuerpo === undefined ? {} : { body: JSON.stringify(o.cuerpo) }),
  })
}

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

/** Cuantas intenciones de acreditacion quedaron escritas para una persona. */
async function intenciones(persona_id: string): Promise<number> {
  const r = await env.CORE.prepare(
    "SELECT COUNT(*) AS n FROM bitacora WHERE objetivo = ? AND accion = 'billetera.acreditacion.pedida'",
  )
    .bind(derivarBilleteraId(persona_id))
    .first<{ n: number }>()
  return r?.n ?? 0
}

// ---------------------------------------------------------------------------
// El reloj fijo: lo unico que permite probar las carreras de milisegundo
// ---------------------------------------------------------------------------

describe('con el reloj fijo', () => {
  const deps = () => env as unknown as Parameters<typeof atender>[1]

  /** El token se emite EN el instante fijo: si se emitiera con el reloj real, la
   *  frescura lo rechazaria por venir del futuro respecto del momento fijado. */
  const tokenEn = (momento: string) =>
    emitirToken(
      { actor: { tipo: 'plataforma' }, emitido_en: momento as never, entorno: env.ENTORNO },
      SECRETO,
    )

  async function conReloj(
    momento: string,
    metodo: string,
    ruta: string,
    o: { token: string; cuerpo?: unknown },
  ): Promise<Response> {
    const encabezados: Record<string, string> = { authorization: `Bearer ${o.token}` }
    const peticion = new Request(`https://prueba.test${ruta}`, {
      method: metodo,
      headers: encabezados,
      ...(o.cuerpo === undefined ? {} : { body: JSON.stringify(o.cuerpo) }),
    })
    let n = 0
    return atender(
      peticion,
      deps(),
      () => momento,
      () => `fijo-${(n += 1)}`,
    )
  }

  it('dos revocaciones en el MISMO milisegundo dejan UN solo renglon de bitacora', async () => {
    // EL DEFECTO: la bitacora iba condicionada a `hasta = <momento>`, que no
    // significa «el UPDATE toco una fila» sino «existe alguna ventana cerrada en
    // este instante». Con el mismo milisegundo, la segunda revocacion no revocaba
    // nada y escribia igual «se revoco» — con un comentario al lado declarandolo
    // imposible. La prueba que creia cubrirlo mandaba las dos llamadas en
    // secuencia, o sea con milisegundos distintos, y por eso pasaba.
    // La capacidad se otorga con el reloj fijo tambien: si se otorgara con el reloj
    // real, su `otorgada_en` seria posterior al momento de la revocacion y el CHECK
    // `hasta >= otorgada_en` haria fallar la prueba por un motivo que no es el suyo.
    await personaCon('ms-1', [])
    const OTORGADA = '2026-08-18T15:00:00.000Z'
    const T = '2026-08-18T15:00:01.000Z'
    const token = await tokenEn(T)

    const abierta = await conReloj(OTORGADA, 'POST', '/personas/ms-1/capacidades', {
      token: await tokenEn(OTORGADA),
      cuerpo: { capacidad: 'vendedor' },
    })
    expect(abierta.status).toBe(201)

    const a = await conReloj(T, 'DELETE', '/personas/ms-1/capacidades/vendedor', { token })
    const b = await conReloj(T, 'DELETE', '/personas/ms-1/capacidades/vendedor', { token })

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(((await a.json()) as Record<string, unknown>)['revocada']).toBe(true)
    expect(((await b.json()) as Record<string, unknown>)['revocada']).toBe(false)

    const r = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM bitacora WHERE objetivo = 'ms-1' AND accion = 'capacidad.revocada'",
    ).first<{ n: number }>()
    expect(r?.n).toBe(1)
  })

  it('otorgar y revocar en el MISMO milisegundo no es un 500', async () => {
    // EL DEFECTO: el CHECK era `hasta > otorgada_en` estricto, asi que revocar en el
    // mismo milisegundo del otorgamiento salia como `fallo_interno` y la capacidad
    // quedaba ABIERTA. Como `cliente` es la capacidad que habilita acreditar, una
    // cuenta seguia pudiendo recibir plata despues de que la plataforma pidiera
    // sacarsela.
    await personaCon('ms-2', [])
    const T = '2026-08-18T16:00:00.000Z'
    const token = await tokenEn(T)

    const otorgada = await conReloj(T, 'POST', '/personas/ms-2/capacidades', {
      token,
      cuerpo: { capacidad: 'creador' },
    })
    expect(otorgada.status).toBe(201)

    const revocada = await conReloj(T, 'DELETE', '/personas/ms-2/capacidades/creador', { token })
    expect(revocada.status).toBe(200)
    expect(((await revocada.json()) as Record<string, unknown>)['revocada']).toBe(true)

    const fila = await env.CORE.prepare(
      "SELECT otorgada_en, hasta FROM capacidades WHERE persona_id = 'ms-2' AND capacidad = 'creador'",
    ).first<{ otorgada_en: string; hasta: string | null }>()
    expect(fila).toEqual({ otorgada_en: T, hasta: T })

    // Y la capacidad NO quedo abierta, que era la parte cara del defecto.
    const leida = await conReloj(T, 'GET', '/personas/ms-2', { token })
    expect(((await leida.json()) as Record<string, unknown>)['capacidades_vigentes']).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// La puerta
// ---------------------------------------------------------------------------

describe('el token dice a que entorno pertenece', () => {
  it('un token de otro entorno no entra, aunque el secreto sea el mismo', async () => {
    // El secreto lo pone una persona a mano con `wrangler secret put`, dos veces, y
    // poner el mismo valor en los dos entornos es el movimiento natural — nada en el
    // repositorio lo desaconsejaba. Sin este campo, un token emitido para probar en
    // staging acredita guaranies en produccion.
    const ajeno = await emitirToken(
      { actor: { tipo: 'plataforma' }, emitido_en: ahora() as never, entorno: 'produccion' },
      SECRETO,
    )
    const r = await llamar('POST', '/personas', { token: ajeno, cuerpo: {} })
    expect(r.status).toBe(401)
  })

  it('y el del entorno propio si', async () => {
    const r = await llamar('POST', '/personas', {
      token: await tokenDePlataforma(),
      cuerpo: { persona_id: 'entorno-ok' },
    })
    expect(r.status).toBe(201)
  })
})

describe('una persona no puede crear plata', () => {
  it('un actor persona recibe 403 en acreditar — el guarda que no tenia oraculo', async () => {
    // No existia ni una prueba de esto: los dos 403 de la seccion de acreditar eran
    // de capacidad, no de autorizacion. El unico guarda que protege la creacion de
    // dinero era el unico sin nadie que lo mirara.
    await personaCon('guarda-1', ['cliente'])
    const token = await tokenDePersona('guarda-1')
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'guarda-1',
        monto: 1_000_000,
        bolsa: 'disponible',
        clave_idem: 'guarda:1',
      },
    })
    expect(r.status).toBe(403)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('solo_la_plataforma')
  })

  it('y el rechazo llega ANTES de leer el cuerpo', async () => {
    // Con el orden al reves, un token de persona valido obligaba al Worker a
    // materializar y parsear un cuerpo arbitrariamente grande antes de rechazarlo.
    // El sintoma observable: un cuerpo roto contestaba 400 —o sea que se parseo— en
    // vez de 403. Era la unica de las seis rutas con el guarda despues del cuerpo, y
    // justo la que crea dinero.
    const token = await tokenDePersona('guarda-1')
    const r = await SELF.fetch('https://prueba.test/billetera/acreditar', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'esto no es json',
    })
    expect(r.status).toBe(403)
  })
})

describe('el persona_id tiene alfabeto', () => {
  it('lo que no se puede volver a pedir por la URL no se crea', async () => {
    // Sin esto: 201 al crear y 404 para siempre al leer, porque el enrutador parte
    // `url.pathname` sin decodificar. La cuenta queda inalcanzable, con su
    // `billetera_id` ya quemado en el indice unico y sin ninguna ruta para borrarla.
    const token = await tokenDePlataforma()
    for (const persona_id of ['ana bonita', 'a/b', '..', 'x'.repeat(65)]) {
      const r = await llamar('POST', '/personas', { token, cuerpo: { persona_id } })
      expect(r.status).toBe(400)
      expect(((await r.json()) as Record<string, unknown>)['error']).toBe('persona_id_invalido')
    }
  })

  it('nadie puede llamarse plataforma', async () => {
    // `actorId()` escribe `plataforma` para la plataforma. Una persona con ese id
    // hace que la fila que dice quien pidio mover plata deje de ser decidible. No da
    // acceso a nada —el guarda mira `actor.tipo`— pero el registro es el entregable.
    const token = await tokenDePlataforma()
    for (const persona_id of ['plataforma', 'PLATAFORMA']) {
      const r = await llamar('POST', '/personas', { token, cuerpo: { persona_id } })
      expect(r.status).toBe(400)
    }
  })
})

describe('lo que la puerta ya sabe rechazar no sale como 500', () => {
  // La clave se arma con un contador y no con el JSON del caso: desde que
  // `clave_idem` tiene alfabeto, un `JSON.stringify` adentro la volvia invalida y la
  // puerta contestaba `clave_idem_invalida` antes de llegar al campo que se queria
  // probar. La prueba habria pasado igual —400 es 400— mirando otra cosa.
  let n = 0
  const cuerpoBase = (extra: Record<string, unknown>) => ({
    persona_id: 'campos-1',
    monto: 10_000,
    bolsa: 'disponible',
    clave_idem: `campos:${(n += 1)}`,
    ...extra,
  })

  it('un vence_en mal escrito es 400 y NO deja intencion escrita', async () => {
    // Antes salia 500, y salia DESPUES de haber escrito la intencion: quedaba un
    // renglon de bitacora de una acreditacion que nunca ocurrio. El `monto` y la
    // `bolsa` ya se validaban en la puerta «para que un cuerpo mal armado salga como
    // 400 y no como 500» y los otros cuatro campos pasaban en crudo: la categoria
    // estaba arreglada en dos lugares de seis.
    const token = await tokenDePlataforma()
    await personaCon('campos-1', ['cliente'])
    const antes = await intenciones('campos-1')

    for (const vence_en of ['2026-08-18', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00.000-03:00']) {
      const r = await llamar('POST', '/billetera/acreditar', {
        token,
        cuerpo: cuerpoBase({ vence_en }),
      })
      expect(r.status).toBe(400)
      expect(((await r.json()) as Record<string, unknown>)['error']).toBe('vence_en_invalido')
    }

    expect(await intenciones('campos-1')).toBe(antes)
  })

  it('una acreditacion que nace vencida no entra', async () => {
    // Entraba al ledger, contaba en los totales, pasaba los invariantes — y era
    // inconsumible para siempre. El panel, leyendo el read model como manda la ley
    // 1, mostraba plata que la billetera no tiene, y no hay ruta que la compense.
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: cuerpoBase({ vence_en: '2020-01-01T00:00:00.000Z' }),
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('vence_en_ya_vencido')
  })

  it('un credito de promocion sin vencimiento no entra (ley 11)', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: cuerpoBase({ bolsa: 'credito_promocion' }),
    })
    expect(r.status).toBe(400)
  })

  it('un concepto de cien mil caracteres no llega al ledger', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: cuerpoBase({ concepto: 'x'.repeat(100_000) }),
    })
    expect(r.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// El read model, la bitacora y la transaccion
// ---------------------------------------------------------------------------

describe('el read model se puede unir con la persona (ley 1)', () => {
  it('personas.billetera_id y ledger_copia.billetera_id hablan del mismo espacio', async () => {
    // EL DEFECTO: `personas.billetera_id` guardaba el NOMBRE del Durable Object y
    // `ledger_copia.billetera_id` su hash hexadecimal. Tres columnas con el mismo
    // nombre, dos espacios de identificadores, ninguna consulta que las una — y
    // nada fallaba. La ley 1 dice que el panel lee el read model, y desde D1 no
    // habia forma de ir de una persona a sus asientos: `idFromName` solo se puede
    // calcular adentro de un Worker con el binding.
    const token = await tokenDePlataforma()
    await personaCon('join-1', ['cliente'])
    await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'join-1',
        monto: 77_000,
        bolsa: 'disponible',
        clave_idem: 'carga:join-1:001',
      },
    })

    // El outbox se vacia desde la alarma; acá se lo empuja para no depender de ella.
    const billetera = env.BILLETERA.get(env.BILLETERA.idFromName(derivarBilleteraId('join-1')))
    await billetera.publicar()

    const fila = await env.CORE.prepare(
      `SELECT p.id AS persona_id, l.monto AS monto
       FROM ledger_copia l JOIN personas p ON p.billetera_id = l.billetera_id
       WHERE p.id = 'join-1'`,
    ).first<{ persona_id: string; monto: number }>()

    expect(fila).toEqual({ persona_id: 'join-1', monto: 77_000 })
  })
})

describe('la bitacora es append-only de verdad', () => {
  it('no se puede editar ni borrar un registro de auditoria', async () => {
    // Se describia como append-only y no lo era: `ledger_copia` y
    // `eventos_billetera` tienen triggers desde 0001 y 0002, y `bitacora` no los
    // tenia. Medido por una auditoria: el UPDATE y el DELETE pasaban. Y la palabra
    // «append-only» era ademas la justificacion para no ponerle un CHECK a `accion`.
    await personaCon('append-1', [])

    await expect(
      env.CORE.prepare("UPDATE bitacora SET accion = 'mentira' WHERE objetivo = 'append-1'").run(),
    ).rejects.toThrow(/no se edita/)

    await expect(
      env.CORE.prepare("DELETE FROM bitacora WHERE objetivo = 'append-1'").run(),
    ).rejects.toThrow(/no se borra/)
  })
})

describe('el batch de D1 es una transaccion, medido', () => {
  it('si la PERSONA no puede entrar, tampoco queda su renglon de bitacora', async () => {
    // ESTA es la prueba que discrimina, y nacio de la segunda vuelta de auditoria.
    // La de mas abajo esconde la tabla `bitacora` para que falle la SEGUNDA
    // sentencia — y no distingue una transaccion de dos escrituras sueltas en las
    // que la bitacora va primero: ahi falla la primera y la persona nunca se
    // intenta, o sea que el assert se cumple sin transaccion ninguna. Medido: con
    // `crearPersona` reescrito como dos `await ... .run()` sueltos, las 108 pruebas
    // del runtime seguian en verde.
    //
    // Acá la que falla es la PRIMERA sentencia: se siembra otra persona que ya se
    // quedo con el `billetera_id` que a esta le tocaria, asi que el INSERT choca
    // contra `idx_personas_billetera`. Si la bitacora estuviera suelta, quedaria un
    // renglon huerfano.
    const token = await tokenDePlataforma()

    await env.CORE.prepare(
      "INSERT INTO personas (id, creada_en, estado, billetera_id) VALUES ('la-que-ocupa', ?, 'activa', ?)",
    )
      .bind(ahora(), derivarBilleteraId('choque'))
      .run()

    const r = await llamar('POST', '/personas', { token, cuerpo: { persona_id: 'choque' } })
    expect(r.status).toBe(500)

    const huerfana = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM bitacora WHERE objetivo = 'choque'",
    ).first<{ n: number }>()
    expect(huerfana?.n).toBe(0)

    const persona = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM personas WHERE id = 'choque'",
    ).first<{ n: number }>()
    expect(persona?.n).toBe(0)
  })

  it('y si el renglon de bitacora no puede entrar, la persona tampoco queda', async () => {
    // La prueba anterior contaba personas sin bitacora y pasaba aunque las dos
    // escrituras fueran independientes: el `arrange` ya garantizaba el `assert`. Una
    // auditoria la rompio a proposito —saco `sentenciaDeBitacora` del `batch`— y las
    // 39 pruebas del runtime siguieron en verde. Esto fuerza el fallo de la SEGUNDA
    // sentencia y mira si la PRIMERA quedo, que es lo unico que prueba la
    // transaccion.
    const token = await tokenDePlataforma()

    await env.CORE.prepare('ALTER TABLE bitacora RENAME TO bitacora_escondida').run()
    let estado: number
    try {
      const r = await llamar('POST', '/personas', { token, cuerpo: { persona_id: 'atomica-2' } })
      estado = r.status
    } finally {
      await env.CORE.prepare('ALTER TABLE bitacora_escondida RENAME TO bitacora').run()
    }
    expect(estado).toBe(500)

    const quedo = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM personas WHERE id = 'atomica-2'",
    ).first<{ n: number }>()
    expect(quedo?.n).toBe(0)
  })
})


// ---------------------------------------------------------------------------
// Lo que encontro la SEGUNDA vuelta: defectos nacidos de los arreglos
// ---------------------------------------------------------------------------

describe('restringida_a: null no congela la plata', () => {
  it('un null explicito acredita plata GASTABLE, no plata contada y muerta', async () => {
    // EL DEFECTO, que dos auditores midieron por separado: el helper `texto()` se
    // uso con `porDefecto: ''`, asi que un `null` explicito —la forma en que
    // cualquier cliente serializa un opcional ausente— llegaba a la bolsa como `''`.
    // Y `''` no es `null` para `bolsas.ts`: la bolsa queda restringida a un proposito
    // que nadie pide nunca. Pero SI cuenta en `saldoRetirable`. Resultado: 200 OK
    // con saldo, y un debito que contesta «saldo insuficiente».
    //
    // Es la MISMA categoria que el guarda de `vence_en_ya_vencido` cerro cinco
    // lineas mas arriba, reabierta por el campo de al lado del mismo bloque.
    const token = await tokenDePlataforma()
    await personaCon('restr-1', ['cliente'])

    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'restr-1',
        monto: 50_000,
        bolsa: 'disponible',
        clave_idem: 'carga:restr-1:001',
        restringida_a: null,
      },
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as Record<string, unknown>)['saldo_retirable']).toBe(50_000)

    // Lo que hace que esta prueba pruebe: la plata se puede MOVER. Con `''` adentro,
    // esto tiraba «saldo insuficiente» mientras el saldo decia 50.000.
    const billetera = env.BILLETERA.get(env.BILLETERA.idFromName(derivarBilleteraId('restr-1')))
    await expect(
      billetera.debitar(
        { clave_idem: 'gasto:restr-1:001', correlacion_id: 'c-restr-1', momento: ahora() },
        { monto: guaranies(10_000), concepto: 'compra' },
      ),
    ).resolves.toBeDefined()

    const despues = await llamar('GET', '/billetera/restr-1/saldo', { token })
    const bolsas = ((await despues.json()) as { bolsas: { monto: number }[] }).bolsas
    expect(bolsas.reduce((a, b) => a + b.monto, 0)).toBe(40_000)
  })

  it('una cadena vacia se trata igual que la ausencia', async () => {
    const token = await tokenDePlataforma()
    await personaCon('restr-2', ['cliente'])
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'restr-2',
        monto: 30_000,
        bolsa: 'disponible',
        clave_idem: 'carga:restr-2:001',
        restringida_a: '',
      },
    })
    expect(r.status).toBe(200)

    const billetera = env.BILLETERA.get(env.BILLETERA.idFromName(derivarBilleteraId('restr-2')))
    await expect(
      billetera.debitar(
        { clave_idem: 'gasto:restr-2:001', correlacion_id: 'c-restr-2', momento: ahora() },
        { monto: guaranies(30_000), concepto: 'compra' },
      ),
    ).resolves.toBeDefined()
  })
})

describe('la clave de idempotencia esta acotada', () => {
  it('no entra una clave de cien mil caracteres', async () => {
    // `clave_idem` no es decorativa: `nucleo.ts` arma el `asiento_id` como
    // `${clave_idem}:${sufijo}`, o sea la mitad de la clave primaria de
    // `ledger_copia`, y ademas viaja al detalle de la bitacora, que no se puede
    // borrar. El tope se le habia puesto a los tres campos decorativos y no a este.
    const token = await tokenDePlataforma()
    await personaCon('idem-1', ['cliente'])
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'idem-1',
        monto: 1_000,
        bolsa: 'disponible',
        clave_idem: 'x'.repeat(100_000),
      },
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('clave_idem_invalida')

    const filas = await env.CORE.prepare(
      "SELECT COUNT(*) AS n FROM bitacora WHERE length(detalle) > 1000",
    ).first<{ n: number }>()
    expect(filas?.n).toBe(0)
  })

  it('ni una con saltos de linea', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/billetera/acreditar', {
      token,
      cuerpo: {
        persona_id: 'idem-1',
        monto: 1_000,
        bolsa: 'disponible',
        clave_idem: 'carga\nfalsa',
      },
    })
    expect(r.status).toBe(400)
  })
})

describe('la ventana de duracion cero no deja la capacidad inalcanzable', () => {
  const deps = () => env as unknown as Parameters<typeof atender>[1]

  it('otorgar, revocar y volver a otorgar en el mismo milisegundo da 409, no 500', async () => {
    // Nacio del arreglo del `>=`: desde que una ventana `[T, T)` es legitima, ocupa
    // la clave primaria `(persona_id, capacidad, otorgada_en)`. El re-otorgamiento
    // chocaba y salia como `fallo_interno` opaco, con la persona sin la capacidad y
    // sin forma de entender por que. En Workers el reloj esta congelado hasta la
    // primera E/S, asi que los tres pasos en el mismo milisegundo no es exotico.
    await personaCon('cero-1', [])
    const T = '2026-08-18T17:00:00.000Z'
    const token = await emitirToken(
      { actor: { tipo: 'plataforma' }, emitido_en: T as never, entorno: env.ENTORNO },
      SECRETO,
    )
    const pedir = (metodo: string, ruta: string, cuerpo?: unknown) =>
      atender(
        new Request(`https://prueba.test${ruta}`, {
          method: metodo,
          headers: { authorization: `Bearer ${token}` },
          ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
        }),
        deps(),
        () => T,
        () => 'fijo',
      )

    expect((await pedir('POST', '/personas/cero-1/capacidades', { capacidad: 'cliente' })).status).toBe(201)
    expect((await pedir('DELETE', '/personas/cero-1/capacidades/cliente')).status).toBe(200)

    const tercera = await pedir('POST', '/personas/cero-1/capacidades', { capacidad: 'cliente' })
    expect(tercera.status).toBe(409)
    expect(((await tercera.json()) as Record<string, unknown>)['error']).toBe('ventana_ya_ocupada')
  })
})

describe('un persona_id no puede parecerse a una billetera', () => {
  it('los dos puntos ya no entran en el alfabeto', async () => {
    // `derivarBilleteraId` dice que «el prefijo es lo unico que impide» que algo que
    // use `idFromName` sobre un id de persona caiga sobre su billetera. Con `:` en el
    // alfabeto, la persona `billetera:p1` era creable — y cualquier modulo futuro que
    // hiciera `idFromName(persona_id)` sobre ella aterrizaba en la billetera de `p1`.
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/personas', { token, cuerpo: { persona_id: 'billetera:p1' } })
    expect(r.status).toBe(400)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('persona_id_invalido')
  })

  it('y un UUID sigue entrando', async () => {
    const token = await tokenDePlataforma()
    const r = await llamar('POST', '/personas', { token, cuerpo: {} })
    expect(r.status).toBe(201)
  })
})

describe('la bitacora tampoco se pisa con un REPLACE', () => {
  it('INSERT OR REPLACE sobre una fila existente aborta', async () => {
    // `INSERT OR REPLACE` borra la fila en conflicto SIN disparar el trigger de
    // DELETE, salvo que `recursive_triggers` este en ON — y en D1 vale 0, medido por
    // una auditoria. Con los dos triggers de append-only puestos, un REPLACE pisaba
    // un registro de auditoria en silencio.
    await personaCon('replace-1', [])
    const fila = await env.CORE.prepare(
      "SELECT id FROM bitacora WHERE objetivo = 'replace-1'",
    ).first<{ id: number }>()
    expect(fila).not.toBeNull()

    await expect(
      env.CORE.prepare(
        'INSERT OR REPLACE INTO bitacora (id, actor_id, accion, objetivo, detalle, correlacion_id, ocurrido_en) ' +
          "VALUES (?, 'intruso', 'persona.creada', 'replace-1', NULL, 'c', ?)",
      )
        .bind(fila!.id, ahora())
        .run(),
    ).rejects.toThrow(/no se pisa/)
  })
})

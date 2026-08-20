/**
 * La entrega 1.3 de punta a punta, adentro de workerd: la migracion 0004 sobre
 * SQLite de verdad, las tres rutas por HTTP, `SecuenciaDO` numerando y `BilleteraDO`
 * reteniendo plata del otro lado.
 *
 * POR QUE NADA DE ESTO PODIA SER UNA PRUEBA DEL NUCLEO
 *
 * La maquina de estados es pura y se prueba en `tests/pedido.test.ts`. Lo que se
 * prueba ACA es todo lo que TypeScript no puede prometer: que el indice unico sobre
 * `clave_idem` exista, que el trigger de los terminales aborte, que el numero salga
 * de un solo escritor, y —lo mas importante— QUE LA PLATA ESTE DONDE EL ESTADO DICE
 * QUE ESTA. Un doble de D1 o de la billetera probaria el doble.
 */

import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { derivarBilleteraId } from '../src/identidad/personas.js'
import { claveDeReserva, VENTANA_DE_RESERVA_MS } from '../src/pedidos/pedidos.js'
/** El arnes es compartido — ver el encabezado de `arnes.ts`. */
import {
  acreditar,
  ahora,
  aplicarMigraciones,
  bolsas,
  llamar,
  pedir,
  personaCon,
  renglones,
  sumar,
  tokenDePersona,
  tokenDePlataforma,
} from './arnes.js'

beforeAll(aplicarMigraciones)

// ---------------------------------------------------------------------------
// El esquema que trajo la 0004
// ---------------------------------------------------------------------------

describe('la migracion 0004, medida y no supuesta', () => {
  const base = (id: string, estado: string) =>
    env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 1000, ?, ?, NULL, ?, ?)',
    ).bind(id, 'esquema-p', estado, `k:${id}`, ahora(), ahora())

  beforeAll(async () => {
    await personaCon('esquema-p', ['cliente'])
  })

  it('`reservado` es un estado legal, y uno inventado no', async () => {
    await base('RY-2026-900001', 'reservado').run()
    await expect(base('RY-2026-900002', 'reembolsado').run()).rejects.toThrow()
  })

  it('la clave_idem es UNICA — es lo unico que impide el pedido duplicado', async () => {
    // LA PRIMERA VERSION DE ESTA PRUEBA PASABA POR EL MOTIVO EQUIVOCADO, y lo midio
    // el arnes de mutacion: la segunda fila llevaba `'clave-repetida'` tambien en la
    // columna `estado`, asi que el INSERT moria contra el CHECK de estados y nunca
    // llegaba al indice. Con el indice degradado a no-unico la prueba seguia en
    // verde. Ahora las dos filas son legales en todo salvo en la clave.
    await base('RY-2026-900010', 'creado').run()

    await expect(
      env.CORE.prepare(
        'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 1000, ?, ?, NULL, ?, ?)',
      )
        .bind('RY-2026-900011', 'esquema-p', 'creado', 'k:RY-2026-900010', ahora(), ahora())
        .run(),
    ).rejects.toThrow(/UNIQUE/i)

    // Y el control: con OTRA clave, la misma fila entra. Sin esto, la prueba de
    // arriba pasaria igual si `pedidos` rechazara cualquier segundo INSERT.
    await expect(base('RY-2026-900012', 'creado').run()).resolves.toBeDefined()
  })

  it('un pedido cancelado NO vuelve a otro estado', async () => {
    // Sin este trigger, un `UPDATE pedidos SET estado = 'creado'` sobre un pedido
    // terminal pasa sin una queja, y ese pedido vuelve a ser reservable y cobrable.
    await base('RY-2026-900020', 'cancelado').run()
    await expect(
      env.CORE.prepare("UPDATE pedidos SET estado = 'creado' WHERE id = 'RY-2026-900020'").run(),
    ).rejects.toThrow()
  })

  it('un pedido repartido tampoco', async () => {
    await base('RY-2026-900021', 'repartido').run()
    await expect(
      env.CORE.prepare("UPDATE pedidos SET estado = 'pagado' WHERE id = 'RY-2026-900021'").run(),
    ).rejects.toThrow()
  })

  it('pero un UPDATE que NO cambia el estado sigue pasando', async () => {
    // El trigger tiene `NEW.estado <> OLD.estado` a proposito: sin eso, tocarle
    // cualquier otra columna a un pedido terminal —el `actualizado_en` de una
    // correccion— abortaria.
    await base('RY-2026-900022', 'cancelado').run()
    await expect(
      env.CORE.prepare(
        "UPDATE pedidos SET actualizado_en = ? WHERE id = 'RY-2026-900022'",
      )
        .bind(ahora())
        .run(),
    ).resolves.toBeDefined()
  })

  it('el numero de pedido no se reescribe', async () => {
    await base('RY-2026-900030', 'creado').run()
    await expect(
      env.CORE.prepare(
        "UPDATE pedidos SET id = 'RY-2026-900031' WHERE id = 'RY-2026-900030'",
      ).run(),
    ).rejects.toThrow()
  })

  it('un instante mal escrito no entra', async () => {
    // Defensa en profundidad contra un SQL a mano. La puerta de verdad es
    // `instante()`, del lado de TypeScript.
    await expect(
      env.CORE.prepare(
        "INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES ('RY-2026-900040', 'esquema-p', 1000, 'creado', 'k:900040', '2026-08-18T12:00:00Z', ?, ?)",
      )
        .bind(ahora(), ahora())
        .run(),
    ).rejects.toThrow()
  })

  it('el monto de un pedido no se reescribe', async () => {
    // Es lo que su reserva retiene. Con el monto cambiado, el cobro pide consumir mas
    // (o menos) de lo que hay retenido, y el pedido queda clavado o deja plata
    // huerfana. Lo midio la primera vuelta de auditoria: un UPDATE de 30.000 a 90.000
    // pasaba sin una queja.
    await base('RY-2026-900050', 'reservado').run()
    await expect(
      env.CORE.prepare("UPDATE pedidos SET monto = 90000 WHERE id = 'RY-2026-900050'").run(),
    ).rejects.toThrow()
  })

  it('el comprador de un pedido no se reescribe', async () => {
    // Su billetera es la que retiene. Con el comprador cambiado, cancelar sale 500
    // —«reserva desconocida», porque busca en la billetera equivocada— y la plata
    // queda retenida en la billetera vieja. Tambien medido.
    await personaCon('esquema-q', ['cliente'])
    await base('RY-2026-900051', 'reservado').run()
    await expect(
      env.CORE.prepare("UPDATE pedidos SET comprador_id = 'esquema-q' WHERE id = 'RY-2026-900051'").run(),
    ).rejects.toThrow()
  })

  it('una fila no se puede modificar antes de existir', async () => {
    // El `CHECK (actualizado_en >= creado_en)` es el protagonista del encabezado de
    // `selloDe`, con la salida de su explosion pegada — y no lo miraba ningun oraculo.
    // Lo encontro la segunda vuelta de auditoria mutandolo y viendolo sobrevivir.
    await base('RY-2026-900060', 'creado').run()
    await expect(
      env.CORE.prepare("UPDATE pedidos SET actualizado_en = ? WHERE id = 'RY-2026-900060'")
        .bind('2020-01-01T00:00:00.000Z')
        .run(),
    ).rejects.toThrow()
  })

  it('un creado_en sin milisegundos tampoco entra', async () => {
    // Los tres CHECK de forma del instante son el mismo criterio; solo el de
    // `reserva_vence_en` tenia prueba. Un instante de ancho distinto ordena al reves de
    // como corren los relojes, y el indice de 0001 ordena por `creado_en DESC`.
    await expect(
      env.CORE.prepare(
        "INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES ('RY-2026-900061', 'esquema-p', 1000, 'creado', 'k:900061', NULL, '2026-08-18T12:00:00Z', ?)",
      )
        .bind(ahora())
        .run(),
    ).rejects.toThrow()
  })

  it('los indices de 0001 sobrevivieron a la reconstruccion', async () => {
    // La tabla se dropea y se renombra, asi que los indices de 0001 se van con
    // ella. Si no se vuelven a crear, todo sigue funcionando — mas lento, y sin
    // que nadie se entere hasta que haya cien mil pedidos.
    const r = await env.CORE.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pedidos'",
    ).all<{ name: string }>()
    const nombres = r.results.map((x) => x.name)
    expect(nombres).toContain('idx_pedidos_comprador_creado')
    expect(nombres).toContain('idx_pedidos_creado_estado')
    expect(nombres).toContain('idx_pedidos_clave_idem')
    expect(nombres).toContain('idx_pedidos_reserva_vence')
  })
})

// ---------------------------------------------------------------------------
// El pedido nace y reserva
// ---------------------------------------------------------------------------

describe('POST /pedidos', () => {
  it('crea el pedido, lo deja en reservado y la plata queda RETENIDA', async () => {
    const p = await personaCon('ped-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:ped-1')

    const antes = await bolsas(p)
    expect(sumar(antes, 'disponible')).toBe(100_000)
    expect(sumar(antes, 'retenido')).toBe(0)

    const r = await pedir(p, 30_000, 'pedido:ped-1:1')
    expect(r.status).toBe(201)
    const cuerpo = (await r.json()) as Record<string, unknown>

    expect(cuerpo['estado']).toBe('reservado')
    expect(cuerpo['monto']).toBe(30_000)
    expect(cuerpo['repetido']).toBe(false)
    expect(String(cuerpo['pedido_id'])).toMatch(/^RY-\d{4}-\d{6}$/)
    expect(cuerpo['reserva_vence_en']).not.toBeNull()

    // LO QUE IMPORTA: la plata se movio de verdad, y a la bolsa correcta.
    const despues = await bolsas(p)
    expect(sumar(despues, 'disponible')).toBe(70_000)
    expect(sumar(despues, 'retenido')).toBe(30_000)
  })

  it('la reserva se llama COMO EL PEDIDO, que es toda la gracia', async () => {
    const p = await personaCon('ped-2', ['cliente'])
    await acreditar(p, 50_000, 'carga:ped-2')
    const r = await pedir(p, 20_000, 'pedido:ped-2:1')
    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])

    // Mirando la bolsa retenida se sabe de que pedido es cada guarani, sin
    // consultar nada. Eso es la decision `reserva_id = pedido_id`, medida.
    const retenidas = (await bolsas(p)).filter((b) => b.tipo === 'retenido')
    expect(retenidas.length).toBeGreaterThan(0)
    for (const b of retenidas) expect(b.origen).toBe(pedido_id)
  })

  it('el vencimiento de la reserva sale del creado_en, no del reloj de cada intento', async () => {
    const p = await personaCon('ped-3', ['cliente'])
    await acreditar(p, 50_000, 'carga:ped-3')
    const r = await pedir(p, 10_000, 'pedido:ped-3:1')
    const c = (await r.json()) as Record<string, string>

    expect(Date.parse(c['reserva_vence_en'] as string) - Date.parse(c['creado_en'] as string)).toBe(
      VENTANA_DE_RESERVA_MS,
    )
  })

  it('deja los dos renglones de bitacora: el hecho y la intencion', async () => {
    const p = await personaCon('ped-4', ['cliente'])
    await acreditar(p, 50_000, 'carga:ped-4')
    const r = await pedir(p, 10_000, 'pedido:ped-4:1')
    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])

    expect(await renglones(pedido_id, 'pedido.creado')).toBe(1)
    expect(await renglones(pedido_id, 'pedido.reserva.pedida')).toBe(1)
    expect(await renglones(pedido_id, 'pedido.reservado')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// La idempotencia, que es la mitad de esta entrega
// ---------------------------------------------------------------------------

describe('la clave_idem', () => {
  it('el reintento devuelve EL MISMO pedido y NO retiene plata dos veces', async () => {
    const p = await personaCon('idem-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:idem-1')

    const primera = await pedir(p, 40_000, 'pedido:idem-1:1')
    expect(primera.status).toBe(201)
    const a = (await primera.json()) as Record<string, unknown>

    const segunda = await pedir(p, 40_000, 'pedido:idem-1:1')
    // 200 y no 201: con 201 siempre, un reintento parece haber creado un segundo
    // pedido.
    expect(segunda.status).toBe(200)
    const b = (await segunda.json()) as Record<string, unknown>

    expect(b['pedido_id']).toBe(a['pedido_id'])
    expect(b['repetido']).toBe(true)

    // Y ESTO es lo que la prueba existe para medir: 40.000 retenidos, no 80.000.
    const f = await bolsas(p)
    expect(sumar(f, 'retenido')).toBe(40_000)
    expect(sumar(f, 'disponible')).toBe(60_000)

    // Un solo pedido en la base, no dos.
    const n = await env.CORE.prepare('SELECT COUNT(*) AS n FROM pedidos WHERE comprador_id = ?')
      .bind(p)
      .first<{ n: number }>()
    expect(n?.n).toBe(1)
  })

  it('la MISMA clave con otro monto es un 409, no el pedido ajeno', async () => {
    // El defecto que una clave de idempotencia mal implementada regala: devolver el
    // pedido que ya existia sin mirar si es el mismo pedido.
    const p = await personaCon('idem-2', ['cliente'])
    await acreditar(p, 100_000, 'carga:idem-2')
    expect((await pedir(p, 10_000, 'pedido:idem-2:1')).status).toBe(201)

    const r = await pedir(p, 25_000, 'pedido:idem-2:1')
    expect(r.status).toBe(409)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe(
      'clave_idem_ya_usada_para_otro_pedido',
    )
  })

  it('la MISMA clave desde otra persona tampoco entrega el pedido ajeno', async () => {
    const a = await personaCon('idem-3a', ['cliente'])
    const b = await personaCon('idem-3b', ['cliente'])
    await acreditar(a, 50_000, 'carga:idem-3a')
    await acreditar(b, 50_000, 'carga:idem-3b')
    expect((await pedir(a, 10_000, 'clave-compartida')).status).toBe(201)

    const r = await pedir(b, 10_000, 'clave-compartida')
    expect(r.status).toBe(409)
    // Y sobre todo: `b` no se llevo el pedido de `a`.
    const cuerpo = (await r.json()) as Record<string, unknown>
    expect(cuerpo['pedido_id']).toBeUndefined()
  })

  it('un pedido a MEDIO NACER lo termina el reintento', async () => {
    // Es el peor estado alcanzable de la creacion: el INSERT entro y el Worker
    // murio antes de reservar. Se reproduce escribiendo la fila a mano, que es
    // exactamente lo que queda.
    const p = await personaCon('idem-4', ['cliente'])
    await acreditar(p, 80_000, 'carga:idem-4')

    const creado_en = ahora()
    await env.CORE.prepare(
      "INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES ('RY-2026-800001', ?, 25000, 'creado', 'pedido:idem-4:1', NULL, ?, ?)",
    )
      .bind(p, creado_en, creado_en)
      .run()

    expect(sumar(await bolsas(p), 'retenido')).toBe(0)

    const r = await pedir(p, 25_000, 'pedido:idem-4:1')
    expect(r.status).toBe(200)
    const c = (await r.json()) as Record<string, unknown>
    expect(c['pedido_id']).toBe('RY-2026-800001')
    expect(c['estado']).toBe('reservado')

    // La plata quedo retenida ahora, en el reintento.
    expect(sumar(await bolsas(p), 'retenido')).toBe(25_000)
  })
})

// ---------------------------------------------------------------------------
// Sin saldo
// ---------------------------------------------------------------------------

describe('cuando no hay plata', () => {
  it('contesta 409 y deja el pedido CANCELADO, no colgado en creado', async () => {
    const p = await personaCon('sin-1', ['cliente'])
    await acreditar(p, 10_000, 'carga:sin-1')

    const r = await pedir(p, 50_000, 'pedido:sin-1:1')
    expect(r.status).toBe(409)
    const c = (await r.json()) as Record<string, unknown>
    expect(c['error']).toBe('saldo_insuficiente')
    expect(typeof c['pedido_id']).toBe('string')

    // Un pedido que no pudo reservar es basura: no tiene plata, no avanza, y ocupa
    // un numero. Se cancela en el momento.
    const fila = await env.CORE.prepare('SELECT estado FROM pedidos WHERE id = ?')
      .bind(c['pedido_id'])
      .first<{ estado: string }>()
    expect(fila?.estado).toBe('cancelado')

    // Y la plata que si tenia sigue disponible, sin un guarani retenido.
    const f = await bolsas(p)
    expect(sumar(f, 'disponible')).toBe(10_000)
    expect(sumar(f, 'retenido')).toBe(0)
  })

  it('el error dice que hay que mandar OTRA clave, porque la vieja ya no sirve', async () => {
    const p = await personaCon('sin-2', ['cliente'])
    await acreditar(p, 5_000, 'carga:sin-2')
    const r = await pedir(p, 50_000, 'pedido:sin-2:1')
    expect(String(((await r.json()) as Record<string, unknown>)['que_hacer'])).toMatch(/clave_idem/)

    // Y se comprueba que sea verdad: con saldo cargado y la MISMA clave, se sigue
    // llevando el pedido cancelado. Es lo que una clave de idempotencia significa.
    await acreditar(p, 100_000, 'carga:sin-2:b')
    const segunda = await pedir(p, 50_000, 'pedido:sin-2:1')
    expect(segunda.status).toBe(200)
    expect(((await segunda.json()) as Record<string, unknown>)['estado']).toBe('cancelado')
    expect(sumar(await bolsas(p), 'retenido')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------------------

describe('POST /pedidos/:id/cancelar', () => {
  it('devuelve la plata a la bolsa de la que salio', async () => {
    const p = await personaCon('can-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:can-1')
    const r = await pedir(p, 60_000, 'pedido:can-1:1')
    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])
    expect(sumar(await bolsas(p), 'retenido')).toBe(60_000)

    const c = await llamar('POST', `/pedidos/${pedido_id}/cancelar`, {
      token: await tokenDePlataforma(),
    })
    expect(c.status).toBe(200)
    const cuerpo = (await c.json()) as Record<string, unknown>
    expect(cuerpo['estado']).toBe('cancelado')
    expect(cuerpo['cancelado']).toBe(true)
    // La columna vuelve a NULL: el pedido ya no tiene plata retenida, y dejarla
    // escrita haria que el barrido de vencimientos lo encuentre para siempre.
    expect(cuerpo['reserva_vence_en']).toBeNull()

    const f = await bolsas(p)
    expect(sumar(f, 'retenido')).toBe(0)
    expect(sumar(f, 'disponible')).toBe(100_000)
  })

  it('cancelar dos veces es inofensivo', async () => {
    const p = await personaCon('can-2', ['cliente'])
    await acreditar(p, 50_000, 'carga:can-2')
    const r = await pedir(p, 20_000, 'pedido:can-2:1')
    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])
    const token = await tokenDePlataforma()

    expect((await llamar('POST', `/pedidos/${pedido_id}/cancelar`, { token })).status).toBe(200)

    const segunda = await llamar('POST', `/pedidos/${pedido_id}/cancelar`, { token })
    expect(segunda.status).toBe(200)
    // `cancelado: false` y no un 409: reintentar una cancelacion ya aplicada tiene
    // que ser inofensivo.
    expect(((await segunda.json()) as Record<string, unknown>)['cancelado']).toBe(false)

    expect(sumar(await bolsas(p), 'disponible')).toBe(50_000)
    // Y un solo renglon de bitacora, no dos. Un registro que dice que paso algo que
    // no paso es peor que no tener registro.
    expect(await renglones(pedido_id, 'pedido.cancelado')).toBe(1)
  })

  it('cancelar un pedido en `creado` no toca la billetera', async () => {
    const p = await personaCon('can-3', ['cliente'])
    const creado_en = ahora()
    await env.CORE.prepare(
      "INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES ('RY-2026-800100', ?, 5000, 'creado', 'pedido:can-3:1', NULL, ?, ?)",
    )
      .bind(p, creado_en, creado_en)
      .run()

    const c = await llamar('POST', '/pedidos/RY-2026-800100/cancelar', {
      token: await tokenDePlataforma(),
    })
    // Si llamara a `liberarReserva` sobre una reserva que no existe, el nucleo tira
    // «reserva desconocida» y esto seria un 500.
    expect(c.status).toBe(200)
    expect(((await c.json()) as Record<string, unknown>)['estado']).toBe('cancelado')
  })

  it('un pedido cancelado NO se puede volver a reservar aunque se mande la clave vieja', async () => {
    const p = await personaCon('can-4', ['cliente'])
    await acreditar(p, 50_000, 'carga:can-4')
    const r = await pedir(p, 20_000, 'pedido:can-4:1')
    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])
    await llamar('POST', `/pedidos/${pedido_id}/cancelar`, { token: await tokenDePlataforma() })

    // Es el precio declarado de `reserva_id = pedido_id`: un pedido reserva UNA vez
    // en su vida. El reintento devuelve el pedido cancelado y no vuelve a retener.
    const segunda = await pedir(p, 20_000, 'pedido:can-4:1')
    expect(segunda.status).toBe(200)
    expect(((await segunda.json()) as Record<string, unknown>)['estado']).toBe('cancelado')
    expect(sumar(await bolsas(p), 'retenido')).toBe(0)
  })

  it('un pedido repartido no se cancela', async () => {
    const p = await personaCon('can-5', ['cliente'])
    const creado_en = ahora()
    await env.CORE.prepare(
      "INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES ('RY-2026-800110', ?, 5000, 'repartido', 'pedido:can-5:1', NULL, ?, ?)",
    )
      .bind(p, creado_en, creado_en)
      .run()

    const c = await llamar('POST', '/pedidos/RY-2026-800110/cancelar', {
      token: await tokenDePlataforma(),
    })
    expect(c.status).toBe(409)
    const cuerpo = (await c.json()) as Record<string, unknown>
    expect(cuerpo['error']).toBe('pedido_no_cancelable')
    expect(cuerpo['motivo']).toBe('estado_terminal')
  })
})

// ---------------------------------------------------------------------------
// Quien puede que
// ---------------------------------------------------------------------------

describe('los permisos', () => {
  it('una persona puede pedir para si misma', async () => {
    const p = await personaCon('perm-1', ['cliente'])
    await acreditar(p, 50_000, 'carga:perm-1')
    const r = await pedir(p, 10_000, 'pedido:perm-1:1', await tokenDePersona(p))
    expect(r.status).toBe(201)
  })

  it('pero NO para otro', async () => {
    const a = await personaCon('perm-2a', ['cliente'])
    const b = await personaCon('perm-2b', ['cliente'])
    await acreditar(b, 50_000, 'carga:perm-2b')

    const r = await pedir(b, 10_000, 'pedido:perm-2:1', await tokenDePersona(a))
    expect(r.status).toBe(403)
    // Y no quedo ningun pedido escrito.
    const n = await env.CORE.prepare('SELECT COUNT(*) AS n FROM pedidos WHERE comprador_id = ?')
      .bind(b)
      .first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  it('no se puede LEER el pedido ajeno', async () => {
    const a = await personaCon('perm-3a', ['cliente'])
    const b = await personaCon('perm-3b', ['cliente'])
    await acreditar(b, 50_000, 'carga:perm-3b')
    const r = await pedir(b, 10_000, 'pedido:perm-3:1')
    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])

    const leer = await llamar('GET', `/pedidos/${pedido_id}`, { token: await tokenDePersona(a) })
    expect(leer.status).toBe(403)
  })

  it('ni CANCELAR el ajeno', async () => {
    const a = await personaCon('perm-4a', ['cliente'])
    const b = await personaCon('perm-4b', ['cliente'])
    await acreditar(b, 50_000, 'carga:perm-4b')
    const r = await pedir(b, 10_000, 'pedido:perm-4:1')
    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])

    const c = await llamar('POST', `/pedidos/${pedido_id}/cancelar`, {
      token: await tokenDePersona(a),
    })
    expect(c.status).toBe(403)
    // La plata sigue retenida: el 403 no toco nada.
    expect(sumar(await bolsas(b), 'retenido')).toBe(10_000)
  })

  it('sin la capacidad de cliente, no se pide', async () => {
    const p = await personaCon('perm-5', ['vendedor'])
    await acreditar(p, 50_000, 'carga:perm-5').catch(() => undefined)
    const r = await pedir(p, 10_000, 'pedido:perm-5:1')
    expect(r.status).toBe(403)
  })

  it('sin token no entra nadie', async () => {
    const r = await llamar('POST', '/pedidos', {
      cuerpo: { comprador_id: 'perm-1', monto: 1000, clave_idem: 'x' },
    })
    expect(r.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// La entrada
// ---------------------------------------------------------------------------

describe('lo que la puerta rechaza', () => {
  it('un monto que no es numero, o con decimales, o negativo', async () => {
    const p = await personaCon('val-1', ['cliente'])
    await acreditar(p, 50_000, 'carga:val-1')
    const token = await tokenDePlataforma()

    for (const monto of ['1000', 1000.5, -1000, 0, null]) {
      const r = await llamar('POST', '/pedidos', {
        token,
        cuerpo: { comprador_id: p, monto, clave_idem: `val-1:${String(monto)}` },
      })
      expect(r.status, String(monto)).toBe(400)
    }
  })

  it('una clave_idem sin tope llegaria a la clave primaria del read model', async () => {
    const p = await personaCon('val-2', ['cliente'])
    await acreditar(p, 50_000, 'carga:val-2')
    const r = await llamar('POST', '/pedidos', {
      token: await tokenDePlataforma(),
      cuerpo: { comprador_id: p, monto: 1000, clave_idem: 'x'.repeat(200) },
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('clave_idem_invalida')
  })

  it('un pedido_id que no tiene la forma NO llega a la base', async () => {
    const token = await tokenDePlataforma()

    // MEDIDO Y ANOTADO, porque la primera version de esta prueba usaba `..` como
    // ejemplo de id peligroso y pasaba por el motivo equivocado: `new URL()` colapsa
    // el `..` ANTES de que el enrutador parta el pathname, y lo hace tambien con la
    // forma escapada — `/pedidos/..`, `/pedidos/%2e%2e` y `/pedidos/%2E%2E` los tres
    // llegan como `/`, o sea 404 por ruta desconocida y no 400 por id invalido.
    // (`%2f` SI sobrevive: `/pedidos/a%2fb` llega entero, y ese si lo rechaza el
    // guarda de forma.)
    expect((await llamar('GET', '/pedidos/..', { token })).status).toBe(404)
    expect((await llamar('GET', '/pedidos/a%2fb', { token })).status).toBe(400)
    expect((await llamar('GET', '/pedidos/no-es-un-numero', { token })).status).toBe(400)
    expect((await llamar('GET', '/pedidos/RY-2026-1', { token })).status).toBe(400)
    expect((await llamar('GET', `/pedidos/${'x'.repeat(500)}`, { token })).status).toBe(400)
  })

  it('un pedido que no existe es 404', async () => {
    const r = await llamar('GET', '/pedidos/RY-2026-999999', { token: await tokenDePlataforma() })
    expect(r.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// El numero
// ---------------------------------------------------------------------------

describe('la numeracion', () => {
  it('es correlativa y del año de Asuncion', async () => {
    const p = await personaCon('num-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:num-1')

    const a = String(
      ((await (await pedir(p, 1_000, 'num-1:a')).json()) as Record<string, unknown>)['pedido_id'],
    )
    const b = String(
      ((await (await pedir(p, 1_000, 'num-1:b')).json()) as Record<string, unknown>)['pedido_id'],
    )

    const [, anioA, nA] = /^RY-(\d{4})-(\d{6})$/.exec(a) as RegExpExecArray
    const [, anioB, nB] = /^RY-(\d{4})-(\d{6})$/.exec(b) as RegExpExecArray

    expect(anioA).toBe(anioB)
    expect(Number(nB)).toBe(Number(nA) + 1)

    // El año es el de la zona del proyecto, no el de UTC. Coinciden salvo tres
    // horas cada 31 de diciembre — el borde lo mide `tests/momento.test.ts`.
    const esperado = new Intl.DateTimeFormat('en-US', {
      timeZone: env.ZONA_HORARIA,
      year: 'numeric',
      numberingSystem: 'latn',
    }).format(new Date())
    expect(anioA).toBe(esperado)
  })

  it('la secuencia entrega la forma que arma `numeroDePedido`', async () => {
    // El guarda del AÑO no se prueba acá y eso es deliberado: es una regla pura y
    // vive en `pedidos/numero.ts`, con sus pruebas en `tests/numero.test.ts`.
    //
    // Se intento probarlo desde acá —llamando al objeto con `2026.5` y esperando el
    // rechazo— y se midio el precio: un metodo RPC que tira ANTES de su primer
    // `await` sube ademas como «unhandled error» del runtime, y vitest los cuenta
    // aunque las 158 pruebas pasen. La corrida terminaba con `Errors 3` y salida
    // distinta de cero, o sea con el oraculo del runtime en rojo — y sobre un arbol
    // en rojo toda mutacion se reporta muerta. Ver el encabezado de `numero.ts`.
    const s = env.SECUENCIA.get(env.SECUENCIA.idFromName('secuencia:prueba'))
    expect(await s.siguiente(2026)).toBe('RY-2026-000001')
    expect(await s.siguiente(2026)).toBe('RY-2026-000002')
    // Un año distinto lleva su propio contador, aunque caiga en el mismo objeto.
    expect(await s.siguiente(2027)).toBe('RY-2027-000001')
  })

  /**
   * LA PRUEBA DISCRIMINANTE DE LA ATOMICIDAD.
   *
   * «El cambio y su renglon de bitacora entran juntos o no entra ninguno» es una
   * afirmacion sobre `batch()`, y probarla exige que una de las dos sentencias
   * FALLE. Cual de las dos NO es un detalle, y esta es la segunda version de esta
   * prueba: la primera hacia fallar la PRIMERA sentencia, y el arnes de mutacion la
   * volteo — reescrito `enUnLote` como `.run()` sueltos en orden, si la primera
   * muere la segunda ni corre, asi que tampoco queda huerfano y la prueba pasa. No
   * distinguia una transaccion de dos escrituras sueltas.
   *
   * Es EXACTAMENTE el mismo defecto que la segunda vuelta de auditoria de la 1.2
   * encontro en la prueba de atomicidad de `crearPersona`, con otro disfraz.
   *
   * Asi que se hace fallar la SEGUNDA. En `asegurarReserva` el `batch` es
   * [bitacora, UPDATE], y el UPDATE se puede hacer fallar sin tocar el codigo:
   * `pedidos` tiene `CHECK (actualizado_en >= creado_en)`, asi que un pedido con
   * `creado_en` en el futuro no se puede actualizar hoy. Con transaccion, el renglon
   * de bitacora se va con el UPDATE; sin transaccion, queda escrito diciendo que el
   * pedido reservo — sobre un pedido que sigue en `creado`.
   */
  it('si el UPDATE falla, NO queda un renglon de bitacora que mienta', async () => {
    const p = await personaCon('atom-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:atom-1')

    // Un pedido a medio nacer: el INSERT entro y el Worker murio antes de reservar.
    const creado_en = ahora()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 5000, ?, ?, NULL, ?, ?)',
    )
      .bind('RY-2026-810001', p, 'creado', 'atom-1:medio', creado_en, creado_en)
      .run()

    // Y un trigger de laboratorio que hace fallar la SEGUNDA sentencia del `batch`
    // —el UPDATE— dejando pasar la primera, que es el renglon de bitacora.
    //
    // La primera version de esta prueba hacia fallar la PRIMERA, y el arnes de
    // mutacion la volteo: reescrito `enUnLote` como `.run()` sueltos en orden, si la
    // primera muere la segunda ni corre, asi que tampoco queda huerfano. La segunda
    // version usaba el `CHECK (actualizado_en >= creado_en)` con un `creado_en` en el
    // futuro, y dejo de servir cuando `selloDe` arreglo justamente ese defecto. La
    // tercera se fabrica el fallo, que es lo unico que no depende de que otro defecto
    // siga vivo.
    await env.CORE.prepare(
      "CREATE TRIGGER zzz_prueba_atomicidad BEFORE UPDATE ON pedidos WHEN NEW.id = 'RY-2026-810001' BEGIN SELECT RAISE(ABORT, 'trigger de la prueba de atomicidad'); END",
    ).run()

    try {
      const r = await pedir(p, 5_000, 'atom-1:medio')
      expect(r.status).toBe(500)

      // LO QUE SE MIDE: no quedo escrito «este pedido reservo». Con `batch()` el
      // renglon se va con el UPDATE; con dos escrituras sueltas queda, afirmando algo
      // que no pasó.
      expect(await renglones('RY-2026-810001', 'pedido.reservado')).toBe(0)
    } finally {
      await env.CORE.prepare('DROP TRIGGER zzz_prueba_atomicidad').run()
    }

    // Y el pedido sigue donde estaba, no a mitad de camino.
    const fila = await env.CORE.prepare('SELECT estado FROM pedidos WHERE id = ?')
      .bind('RY-2026-810001')
      .first<{ estado: string }>()
    expect(fila?.estado).toBe('creado')
  })

  it('la clave de idempotencia de la reserva se DERIVA del pedido', async () => {
    // Es lo que hace que un reintento entre por la puerta de idempotencia de la
    // billetera en vez de chocar contra «un reserva_id no se reusa». Si esta clave
    // la eligiera el llamador, el reintento saldria como 500.
    expect(claveDeReserva('RY-2026-000007')).toBe('pedido:RY-2026-000007:reserva')
  })

  it('la billetera del comprador es la de su columna, no una derivada al vuelo', async () => {
    const p = await personaCon('num-2', ['cliente'])
    await acreditar(p, 50_000, 'carga:num-2')
    await pedir(p, 10_000, 'num-2:a')

    // El JOIN que la 1.2 hizo posible: de la persona a sus asientos. Si la reserva
    // hubiera ido a una billetera con otro nombre, esto da cero filas y nada falla.
    const r = await env.CORE.prepare(
      'SELECT COUNT(*) AS n FROM ledger_copia JOIN personas ON personas.billetera_id = ledger_copia.billetera_id WHERE personas.id = ?',
    )
      .bind(p)
      .first<{ n: number }>()
    expect(r?.n ?? 0).toBeGreaterThan(0)
    expect(derivarBilleteraId(p)).toBe(`billetera:${p}`)
  })
})

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /pedidos/:id', () => {
  it('devuelve lo que la base tiene', async () => {
    const p = await personaCon('get-1', ['cliente'])
    await acreditar(p, 50_000, 'carga:get-1')
    const r = await pedir(p, 12_345, 'get-1:a')
    const creado = (await r.json()) as Record<string, unknown>

    const leido = await llamar('GET', `/pedidos/${String(creado['pedido_id'])}`, {
      token: await tokenDePlataforma(),
    })
    expect(leido.status).toBe(200)
    const c = (await leido.json()) as Record<string, unknown>
    expect(c['pedido_id']).toBe(creado['pedido_id'])
    expect(c['monto']).toBe(12_345)
    expect(c['estado']).toBe('reservado')
    expect(c['comprador_id']).toBe(p)
  })

  it('la correlacion del llamador vuelve en el encabezado', async () => {
    const p = await personaCon('get-2', ['cliente'])
    await acreditar(p, 50_000, 'carga:get-2')
    const r = await llamar('POST', '/pedidos', {
      token: await tokenDePlataforma(),
      correlacion: 'trazando:get-2',
      cuerpo: { comprador_id: p, monto: 1_000, clave_idem: 'get-2:a' },
    })
    expect(r.headers.get('x-correlacion-id')).toBe('trazando:get-2')

    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])
    const n = await env.CORE.prepare(
      'SELECT COUNT(*) AS n FROM bitacora WHERE objetivo = ? AND correlacion_id = ?',
    )
      .bind(pedido_id, 'trazando:get-2')
      .first<{ n: number }>()
    // Los tres renglones del pedido llevan la misma correlacion, que es lo que
    // despues permite preguntar «¿que paso con esta llamada?».
    expect(n?.n).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// El guarda del arnes
// ---------------------------------------------------------------------------

it('SELF y env son los de verdad', () => {
  expect(typeof SELF.fetch).toBe('function')
  expect(env.SECUENCIA).toBeDefined()
  expect(env.ZONA_HORARIA).toBe('America/Asuncion')
})

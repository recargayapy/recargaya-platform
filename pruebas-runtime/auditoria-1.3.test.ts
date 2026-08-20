/**
 * Las regresiones de las dos vueltas de auditoria adversarial de la entrega 1.3.
 *
 * Van en su propio archivo a proposito, con el mismo criterio que `auditoria.test.ts`
 * de la 1.2: cada bloque de acá nace de un defecto que una auditoria MIDIO —no de una
 * idea— y el nombre de cada prueba dice cual. Que esten juntas hace que se lea de un
 * vistazo que encontro cada vuelta, y que la proxima entrega no las pueda borrar sin
 * darse cuenta de lo que borra.
 *
 * ---------------------------------------------------------------------------
 * LA CATEGORIA QUE LAS DOS VUELTAS ENCONTRARON, dicha una vez
 *
 * Los dos auditores llegaron por caminos distintos a la misma frase:
 *
 *     el orquestador escribia en D1 lo que EL CREIA que iba a pasar, en vez de lo
 *     que la billetera le contesto que paso.
 *
 * De ahi salieron cuatro sintomas que parecian cuatro defectos: un pedido diciendo
 * `reservado` sin plata detras (por tres causas distintas), y plata retenida en un
 * pedido terminal que nadie podia soltar. Las pruebas de este archivo atacan las
 * causas; el sintoma comun es que `pedidos.estado` y las bolsas de la billetera
 * digan cosas distintas.
 */

import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { derivarBilleteraId } from '../src/identidad/personas.js'
import { TOPE_DE_CONCILIACION, claveDeReserva } from '../src/pedidos/pedidos.js'
import { claveAplicada } from '../src/billetera/nucleo.js'
import { CLAVE_IDEM_VALIDA, atender } from '../src/api/rutas.js'
import { emitirToken } from '../src/identidad/actor.js'
/** El arnes es compartido — ver el encabezado de `arnes.ts`. */
import {
  SECRETO,
  acreditar,
  ahora,
  aplicarMigraciones,
  bolsas,
  elQueSigue,
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
// Un solo espacio de claves de idempotencia para las cinco operaciones
// ---------------------------------------------------------------------------

describe('el espacio de claves de idempotencia no es uno solo', () => {
  it('una ACREDITACION no puede hacerse pasar por la reserva de un pedido', async () => {
    // El hallazgo mas caro de la primera vuelta, medido de punta a punta. El
    // `pedido_id` es correlativo, o sea PREDECIBLE: alguien acredita 1 Gs. con
    // `clave_idem = "pedido:<el numero que viene>:reserva"` y el pedido siguiente
    // «reserva» por la puerta de idempotencia — 201, `estado: reservado`, y cero
    // guaranies retenidos. Medido entonces: 50.000 Gs. que el comprador se gasta en
    // otra cosa mientras el pedido dice tenerlos.
    //
    // No hace falta un atacante: el comentario de `CLAVE_IDEM_VALIDA` sugiere claves
    // de la forma `carga:<pedido>:<paso>`. Alcanza con un integrador ordenado.
    const p = await personaCon('idem-x1', ['cliente'])
    await acreditar(p, 100_000, 'carga:idem-x1')

    const sonda = String(
      ((await (await pedir(p, 1_000, 'idem-x1:sonda')).json()) as Record<string, unknown>)[
        'pedido_id'
      ],
    )
    const proximo = elQueSigue(sonda)

    // El veneno: una acreditacion con la clave derivada del pedido que viene.
    await acreditar(p, 1, claveDeReserva(proximo))

    const r = await pedir(p, 50_000, 'idem-x1:real')
    expect(r.status).toBe(201)
    const c = (await r.json()) as Record<string, unknown>
    expect(c['pedido_id']).toBe(proximo)
    expect(c['estado']).toBe('reservado')

    // LO QUE SE MIDE: la reserva se hizo DE VERDAD. Antes del arreglo, lo retenido
    // eran los 1.000 de la sonda y nada mas.
    expect(sumar(await bolsas(p), 'retenido')).toBe(51_000)
  })

  it('una RESERVA no puede hacerse pasar por una acreditacion', async () => {
    // La direccion contraria, tambien medida: despues de que el pedido reservo, una
    // acreditacion con esa misma clave salia 200 con `repetida: true` y NO entraba al
    // ledger. La respuesta ni siquiera traia `saldo_retirable`, porque el valor
    // guardado era el de `reservar` (`{reserva_id}`). Medido entonces: 500.000 Gs.
    // que desaparecian con la respuesta en 200.
    const p = await personaCon('idem-x2', ['cliente'])
    await acreditar(p, 100_000, 'carga:idem-x2')
    const r = await pedir(p, 20_000, 'idem-x2:1')
    const pedido_id = String(((await r.json()) as Record<string, unknown>)['pedido_id'])

    const antes = sumar(await bolsas(p), 'disponible')
    await acreditar(p, 500_000, claveDeReserva(pedido_id))
    expect(sumar(await bolsas(p), 'disponible')).toBe(antes + 500_000)
  })

  it('las cinco operaciones tienen espacios distintos, y no se pueden fabricar de afuera', () => {
    // La categoria y no el caso: el nombre de la operacion es parte de la clave, asi
    // que ninguna de las cinco puede encontrarse con lo que aplico otra. Y el
    // separador no esta en el alfabeto de `CLAVE_IDEM_VALIDA`, asi que ninguna clave
    // que entre por la puerta puede fabricar el prefijo de otra operacion.
    expect(claveAplicada('acreditar', 'x')).not.toBe(claveAplicada('debitar', 'x'))
    expect(claveAplicada('reservar', 'x')).not.toBe(claveAplicada('liberar', 'x'))
    expect(claveAplicada('consumir', 'x')).not.toBe(claveAplicada('reservar', 'x'))

    const separador = claveAplicada('acreditar', 'x').replace('acreditar', '').replace('x', '')
    expect(separador.length).toBe(1)
    expect(CLAVE_IDEM_VALIDA.test(`reservar${separador}x`)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// El estado no puede afirmar una retencion que no existe
// ---------------------------------------------------------------------------

describe('el estado del pedido no afirma una retencion que no existe', () => {
  it('una ventana de reserva que ya vencio NO se anota como reservada', async () => {
    // `venceEnDeLaReserva` deriva del `creado_en` —a proposito, para que los dos
    // intentos calculen lo mismo— asi que un pedido que quedo en `creado` hace mas de
    // media hora reservaria con un vencimiento EN EL PASADO. Medido en la primera
    // version: 200 con `estado: reservado`, y la alarma devolviendo la plata 1,5
    // segundos despues. El pedido quedaba mintiendo para siempre.
    const p = await personaCon('venc-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:venc-1')

    const viejo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 20000, ?, ?, NULL, ?, ?)',
    )
      .bind('RY-2026-820001', p, 'creado', 'venc-1:k', viejo, viejo)
      .run()

    const r = await pedir(p, 20_000, 'venc-1:k')
    expect(r.status).toBe(409)
    const c = (await r.json()) as Record<string, unknown>
    expect(c['error']).toBe('ventana_de_reserva_vencida')
    expect(String(c['que_hacer'])).toMatch(/clave_idem/)

    // Y el pedido queda CERRADO, no colgado en `creado` ocupando un numero.
    const fila = await env.CORE.prepare('SELECT estado FROM pedidos WHERE id = ?')
      .bind('RY-2026-820001')
      .first<{ estado: string }>()
    expect(fila?.estado).toBe('cancelado')
    expect(sumar(await bolsas(p), 'retenido')).toBe(0)

    // Y NO SE ESCRIBIO LA INTENCION, que es lo que hace observable el guarda del
    // orquestador. Sin esta linea, el arnes de mutacion lo volteaba: sacando el
    // `if (vence_en <= ctx.momento)` la respuesta salia igual —el guarda del NUCLEO
    // la sostiene, y el `catch` la traduce al mismo 409— y ninguna prueba se daba
    // cuenta de que se estaba pidiendo a la billetera algo que ya se sabia imposible,
    // dejando en la bitacora append-only una intencion que nunca pudo cumplirse.
    expect(await renglones('RY-2026-820001', 'pedido.reserva.pedida')).toBe(0)
  })

  it('un pedido cuya reserva MURIO se cierra, en vez de quedar colgado', async () => {
    // El otro camino, y es distinto del de arriba: acá la ventana TODAVIA no vencio
    // —asi que el guarda del orquestador deja pasar— pero la reserva ya no esta
    // abierta. Es el estado que queda cuando el Worker muere despues de reservar, la
    // alarma libera, y el reintento llega antes de que la ventana pase.
    //
    // La puerta de idempotencia de la billetera contesta «esto ya se aplico»; el
    // guarda nuevo mira la reserva VIVA y descubre que esta cerrada. Y como
    // `reserva_id = pedido_id` no se reusa, ese pedido no puede reservar nunca mas:
    // esta muerto y hay que cerrarlo, no dejarlo esperando un reintento que no existe.
    const p = await personaCon('muerta-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:muerta-1')

    const creado_en = ahora()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 15000, ?, ?, NULL, ?, ?)',
    )
      .bind('RY-2026-860001', p, 'creado', 'muerta-1:k', creado_en, creado_en)
      .run()

    // Se reserva y se libera POR AFUERA, con las claves derivadas: es exactamente lo
    // que dejo el intento que murio, mas la alarma haciendo su trabajo.
    const billetera = env.BILLETERA.get(env.BILLETERA.idFromName(derivarBilleteraId(p)))
    const opBase = { correlacion_id: 'c', momento: ahora() }
    await billetera.reservar(
      { ...opBase, clave_idem: claveDeReserva('RY-2026-860001') },
      {
        reserva_id: 'RY-2026-860001',
        monto: 15_000 as never,
        vence_en: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      },
    )
    await billetera.liberarReserva(
      { ...opBase, clave_idem: 'la-alarma-lo-solto' },
      { reserva_id: 'RY-2026-860001' },
    )
    expect(sumar(await bolsas(p), 'retenido')).toBe(0)

    const r = await pedir(p, 15_000, 'muerta-1:k')
    expect(r.status).toBe(409)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('ventana_de_reserva_vencida')

    // LO QUE SE MIDE: el pedido queda cerrado y NO anotado como `reservado`. La
    // version anterior contestaba 200 con `estado: reservado` sobre una reserva
    // muerta, y ese pedido mentia para siempre.
    const fila = await env.CORE.prepare('SELECT estado FROM pedidos WHERE id = ?')
      .bind('RY-2026-860001')
      .first<{ estado: string }>()
    expect(fila?.estado).toBe('cancelado')
    expect(await renglones('RY-2026-860001', 'pedido.reservado')).toBe(0)
    expect(sumar(await bolsas(p), 'retenido')).toBe(0)
  })

  // El guarda del NUCLEO —que `reservar()` se niegue a crear una reserva que naceria
  // vencida— se prueba en `tests/reservas.test.ts`, o sea del lado puro y no acá.
  //
  // No es una preferencia: se midio. Un metodo RPC de un Durable Object que rechaza
  // sube ADEMAS como «unhandled error» del runtime, y vitest los cuenta aunque las
  // 171 pruebas pasen: la corrida termina en verde con `Errors 1` y codigo de salida
  // distinto de cero. Con el oraculo del runtime en rojo, el arnes de mutacion no vale
  // nada. Es el mismo motivo por el que el guarda del año vive en `pedidos/numero.ts`.

  it('la ventana vencida SUELTA la plata antes de cerrar el pedido', async () => {
    // EL DEFECTO NACIDO DEL ARREGLO, y el arnes de mutacion encontro despues que la
    // prueba de arriba no lo cubria: usa un pedido SIN reserva, asi que un cierre que
    // no suelte nada pasa igual.
    //
    // Acá el pedido rancio tiene la reserva VIVA — que es el estado real cuando el
    // Worker muere entre `billetera.reservar()` y el UPDATE de D1, y la alarma se
    // atrasa o se pierde (`index.ts` declara que puede perderse). La primera version
    // del guarda cancelaba por un atajo que no le preguntaba nada a la billetera, y
    // `cancelado` es TERMINAL: quedaban 45.000 Gs. retenidos sin ninguna ruta que los
    // soltara — ni cancelar (contesta `cancelado: false` y sale antes de liberar) ni
    // el conciliador (filtra por `estado = 'reservado'`).
    const p = await personaCon('venc-2', ['cliente'])
    await acreditar(p, 100_000, 'carga:venc-2')

    // Un pedido de hace mas de la ventana: `venceEnDeLaReserva` lo da por vencido.
    const viejo = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 45000, ?, ?, NULL, ?, ?)',
    )
      .bind('RY-2026-880001', p, 'creado', 'venc-2:k', viejo, viejo)
      .run()

    // Y la reserva viva a su nombre, hecha por afuera: es lo que dejo el intento que
    // murio. Vence en el futuro, asi que la alarma no la va a tocar.
    const billetera = env.BILLETERA.get(env.BILLETERA.idFromName(derivarBilleteraId(p)))
    await billetera.reservar(
      { clave_idem: claveDeReserva('RY-2026-880001'), correlacion_id: 'c', momento: ahora() },
      {
        reserva_id: 'RY-2026-880001',
        monto: 45_000 as never,
        vence_en: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      },
    )
    expect(sumar(await bolsas(p), 'retenido')).toBe(45_000)

    const r = await pedir(p, 45_000, 'venc-2:k')
    expect(r.status).toBe(409)
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('ventana_de_reserva_vencida')

    // LO QUE SE MIDE: la plata volvio ANTES de que el pedido quedara terminal.
    expect(sumar(await bolsas(p), 'retenido')).toBe(0)
    expect(sumar(await bolsas(p), 'disponible')).toBe(100_000)

    const fila = await env.CORE.prepare('SELECT estado FROM pedidos WHERE id = ?')
      .bind('RY-2026-880001')
      .first<{ estado: string }>()
    expect(fila?.estado).toBe('cancelado')

    // Y quedo el rastro de que se pidio soltar, que es lo que distingue este cierre
    // del atajo que no preguntaba nada.
    expect(await renglones('RY-2026-880001', 'pedido.liberacion.pedida')).toBe(1)
  })

  it('el sello no deja RETROCEDER a `actualizado_en`', async () => {
    // La primera version de `selloDe` comparaba contra `creado_en` —lo justo para que
    // el CHECK no explotara— y con eso la columna podia retroceder respecto de su
    // propio valor anterior. Medido por la segunda vuelta: diez minutos para atras, con
    // el CHECK sin enterarse porque solo mira `creado_en`.
    //
    // La prueba de arriba no lo cubria: usa `creado_en === actualizado_en`, y ahi las
    // dos versiones del sello dan lo mismo. Lo encontro el arnes de mutacion.
    const p = await personaCon('sello-2', ['cliente'])
    await acreditar(p, 100_000, 'carga:sello-2')

    const nacio = ahora()
    const tocado = new Date(Date.now() + 10 * 60 * 1_000).toISOString()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 20000, ?, ?, NULL, ?, ?)',
    )
      .bind('RY-2026-890001', p, 'creado', 'sello-2:k', nacio, tocado)
      .run()

    const r = await pedir(p, 20_000, 'sello-2:k')
    expect(r.status).toBe(200)
    const c = (await r.json()) as Record<string, string>
    expect(c['estado']).toBe('reservado')

    // LO QUE SE MIDE: `actualizado_en` no retrocedio. Con el sello viejo quedaba en el
    // momento de la peticion, diez minutos ANTES de lo que la fila ya decia.
    expect(Date.parse(c['actualizado_en'] as string)).toBeGreaterThanOrEqual(Date.parse(tocado))
    expect(c['actualizado_en']).toBe(tocado)
  })

  it('un instante anterior al nacimiento de la fila NO deja el pedido colgado', async () => {
    // El `CHECK (actualizado_en >= creado_en)` explotaba DESPUES de que `reservar()`
    // ya habia movido la plata. Medido por la segunda vuelta: tres intentos con 500,
    // 25.000 Gs. retenidos, el pedido huerfano en `creado` para siempre y su
    // `clave_idem` quemada. Se alcanza sin ningun reloj roto: dos peticiones con la
    // misma clave donde la que arranco antes es la mas lenta.
    //
    // Se reproduce con una fila cuyo `creado_en` esta 5 s adelante del momento de la
    // peticion, que es exactamente lo que ve el intento lento.
    const p = await personaCon('sello-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:sello-1')

    const adelante = new Date(Date.now() + 5_000).toISOString()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 25000, ?, ?, NULL, ?, ?)',
    )
      .bind('RY-2026-850001', p, 'creado', 'sello-1:k', adelante, adelante)
      .run()

    const r = await pedir(p, 25_000, 'sello-1:k')
    expect(r.status).toBe(200)
    const c = (await r.json()) as Record<string, unknown>
    expect(c['estado']).toBe('reservado')

    // El sello nunca miente hacia adelante: `actualizado_en` queda igual al
    // `creado_en`, que es la respuesta correcta a «esto se modifico antes de que mi
    // reloj se enterara».
    expect(c['actualizado_en']).toBe(adelante)
    expect(sumar(await bolsas(p), 'retenido')).toBe(25_000)
  })
})

// ---------------------------------------------------------------------------
// Cancelar suelta lo que haya
// ---------------------------------------------------------------------------

describe('cancelar suelta lo que haya, no lo que el estado dice', () => {
  it('cancelar desde `creado` LIBERA la reserva que D1 todavia no anoto', async () => {
    // El defecto mas caro de la entrega, medido por las dos vueltas. El orquestador
    // reserva y DESPUES anota, asi que `creado` con la reserva viva es alcanzable —y
    // no hace falta que el Worker muera: alcanza con que una cancelacion le gane la
    // carrera al UPDATE. Con el efecto derivado solo de `RETIENEN_PLATA`, cancelar
    // desde `creado` daba `ninguno`: quedaban 45.000 Gs. retenidos en un pedido
    // TERMINAL, sin ningun camino de codigo que los soltara.
    const p = await personaCon('suelta-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:suelta-1')

    const creado_en = ahora()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 45000, ?, ?, NULL, ?, ?)',
    )
      .bind('RY-2026-830001', p, 'creado', 'suelta-1:k', creado_en, creado_en)
      .run()

    const billetera = env.BILLETERA.get(env.BILLETERA.idFromName(derivarBilleteraId(p)))
    await billetera.reservar(
      { clave_idem: claveDeReserva('RY-2026-830001'), correlacion_id: 'c', momento: ahora() },
      {
        reserva_id: 'RY-2026-830001',
        monto: 45_000 as never,
        vence_en: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      },
    )
    expect(sumar(await bolsas(p), 'retenido')).toBe(45_000)

    const c = await llamar('POST', '/pedidos/RY-2026-830001/cancelar', {
      token: await tokenDePlataforma(),
    })
    expect(c.status).toBe(200)
    expect(((await c.json()) as Record<string, unknown>)['cancelado']).toBe(true)

    // LO QUE SE MIDE: la plata volvio. `cancelado` es terminal, asi que si no vuelve
    // acá no vuelve nunca por codigo.
    expect(sumar(await bolsas(p), 'retenido')).toBe(0)
    expect(sumar(await bolsas(p), 'disponible')).toBe(100_000)
  })

  it('cancelar un pedido que nunca reservo sigue siendo inofensivo', async () => {
    // El otro lado del mismo arreglo: como ahora se pide liberar SIEMPRE, la mayoria
    // de las cancelaciones desde `creado` le piden a la billetera soltar una reserva
    // que no existe. Eso tiene que ser un no-op y no un 500.
    const p = await personaCon('suelta-2', ['cliente'])
    const creado_en = ahora()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 5000, ?, ?, NULL, ?, ?)',
    )
      .bind('RY-2026-830002', p, 'creado', 'suelta-2:k', creado_en, creado_en)
      .run()

    const c = await llamar('POST', '/pedidos/RY-2026-830002/cancelar', {
      token: await tokenDePlataforma(),
    })
    expect(c.status).toBe(200)
    expect(((await c.json()) as Record<string, unknown>)['estado']).toBe('cancelado')
  })
})

// ---------------------------------------------------------------------------
// El conciliador que el indice estaba esperando
// ---------------------------------------------------------------------------

describe('el conciliador de reservas vencidas', () => {
  it('cancela los pedidos cuya ventana ya paso, y no toca los demas', async () => {
    // `reserva_vence_en` se escribia en dos lugares y no la comparaba contra el reloj
    // NADIE: el indice parcial de 0004 estaba creado para un barrido que no existia, y
    // habia tres comentarios prometiendolo. Las dos vueltas lo midieron con el mismo
    // `grep`. Un comentario que promete lo que el codigo no hace es la causa raiz
    // declarada del proyecto, y estaba tres veces en la misma entrega.
    const p = await personaCon('conc-1', ['cliente'])
    await acreditar(p, 200_000, 'carga:conc-1')

    // Uno vigente, por la ruta de verdad.
    const vivo = String(
      ((await (await pedir(p, 10_000, 'conc-1:vivo')).json()) as Record<string, unknown>)[
        'pedido_id'
      ],
    )

    // Y uno cuya ventana ya paso: la alarma de la billetera ya le devolvio la plata,
    // pero D1 sigue diciendo `reservado`. Es exactamente el estado que quedaba colgado
    // para siempre, y el que el panel muestra como plata retenida que no existe.
    const viejo = new Date(Date.now() - 60 * 60 * 1_000).toISOString()
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 30000, ?, ?, ?, ?, ?)',
    )
      .bind('RY-2026-840001', p, 'reservado', 'conc-1:viejo', viejo, viejo, viejo)
      .run()

    // Y uno que YA se cobro y quedo con su `reserva_vence_en` viejo escrito. El
    // conciliador NO lo tiene que tocar: su plata ya salio de la billetera, y
    // «cancelarlo» seria decir que no se cobro. Sin esta fila, el filtro por
    // `estado = 'reservado'` no lo mide nadie — lo encontro el arnes de mutacion.
    await env.CORE.prepare(
      'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 7000, ?, ?, ?, ?, ?)',
    )
      .bind('RY-2026-840002', p, 'pagado', 'conc-1:pagado', viejo, viejo, viejo)
      .run()

    const r = await llamar('POST', '/pedidos/conciliar', { token: await tokenDePlataforma() })
    expect(r.status).toBe(200)
    const c = (await r.json()) as Record<string, number>
    expect(c['revisados']).toBe(1)
    expect(c['cancelados']).toBe(1)
    expect(c['quedan']).toBe(0)

    const cobrado = await env.CORE.prepare('SELECT estado FROM pedidos WHERE id = ?')
      .bind('RY-2026-840002')
      .first<{ estado: string }>()
    expect(cobrado?.estado).toBe('pagado')

    const vencido = await env.CORE.prepare(
      'SELECT estado, reserva_vence_en FROM pedidos WHERE id = ?',
    )
      .bind('RY-2026-840001')
      .first<{ estado: string; reserva_vence_en: string | null }>()
    expect(vencido?.estado).toBe('cancelado')
    expect(vencido?.reserva_vence_en).toBeNull()

    // El vigente no se toca, y su plata sigue retenida. Sin esta mitad, un conciliador
    // que cancelara todo pasaria la prueba de arriba.
    const sigue = await env.CORE.prepare('SELECT estado FROM pedidos WHERE id = ?')
      .bind(vivo)
      .first<{ estado: string }>()
    expect(sigue?.estado).toBe('reservado')
    expect(sumar(await bolsas(p), 'retenido')).toBe(10_000)
  })

  it('`quedan` dice CUANTOS quedan, no si queda alguno', async () => {
    // La primera version pedia un pedido de mas y contestaba `1` o `0`: un booleano
    // disfrazado de contador, con el encabezado prometiendo un conteo. Medido por la
    // segunda vuelta: 57 vencidos con tope 50, la respuesta decia `quedan: 1` con 7
    // atrasados. Es peor que el tope silencioso que el encabezado dice querer evitar —
    // «queda uno» invita a un barrido mas y a dar el trabajo por cerrado.
    const p = await personaCon('conc-3', ['cliente'])
    const viejo = new Date(Date.now() - 60 * 60 * 1_000).toISOString()

    const cuantos = TOPE_DE_CONCILIACION + 7
    for (let i = 0; i < cuantos; i += 1) {
      await env.CORE.prepare(
        'INSERT INTO pedidos (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en) VALUES (?, ?, 1000, ?, ?, ?, ?, ?)',
      )
        .bind(`RY-2026-87${String(i).padStart(4, '0')}`, p, 'reservado', `conc-3:${i}`, viejo, viejo, viejo)
        .run()
    }

    const r = await llamar('POST', '/pedidos/conciliar', { token: await tokenDePlataforma() })
    expect(r.status).toBe(200)
    const c = (await r.json()) as Record<string, number>
    expect(c['revisados']).toBe(TOPE_DE_CONCILIACION)
    expect(c['cancelados']).toBe(TOPE_DE_CONCILIACION)
    // LO QUE SE MIDE: SIETE, no uno.
    expect(c['quedan']).toBe(7)

    // Y una segunda pasada los termina, sin dejar nada.
    const segunda = await llamar('POST', '/pedidos/conciliar', { token: await tokenDePlataforma() })
    const c2 = (await segunda.json()) as Record<string, number>
    expect(c2['revisados']).toBe(7)
    expect(c2['quedan']).toBe(0)
  })

  it('correrlo de nuevo no cancela nada', async () => {
    const r = await llamar('POST', '/pedidos/conciliar', { token: await tokenDePlataforma() })
    expect(r.status).toBe(200)
    const c = (await r.json()) as Record<string, number>
    expect(c['revisados']).toBe(0)
    expect(c['cancelados']).toBe(0)
  })

  it('solo la plataforma lo puede correr', async () => {
    const p = await personaCon('conc-2', ['cliente'])
    const r = await llamar('POST', '/pedidos/conciliar', { token: await tokenDePersona(p) })
    expect(r.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// El mismo milisegundo
// ---------------------------------------------------------------------------

describe('con el reloj fijo', () => {
  // La costura del reloj inyectado, la misma que uso `auditoria.test.ts` de la 1.2.
  // Es lo unico que permite provocar el MISMO MILISEGUNDO: por `SELF.fetch` cada
  // llamada trae su `new Date()` y el caso no se puede reproducir.
  const deps = () => env as unknown as Parameters<typeof atender>[1]

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
    const peticion = new Request(`https://prueba.test${ruta}`, {
      method: metodo,
      headers: { authorization: `Bearer ${o.token}` },
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

  it('dos cancelaciones en el MISMO milisegundo: solo UNA contesta que cancelo', async () => {
    // EL DEFECTO, medido por la segunda vuelta: `cancelado` salia de
    // `releido.estado === 'cancelado'` —«la fila esta cancelada»— y no de si ESTE
    // UPDATE toco una fila. En secuencia el veredicto salia bien, porque la segunda
    // llamada caia por `mismo_estado`; en el mismo milisegundo las dos contestaban
    // `cancelado: true`.
    //
    // Es exactamente la distincion que `sentenciaDeBitacoraSi` documenta, aplicada a
    // la bitacora en la primera version y no a la respuesta. Un llamador que dispara
    // «te devolvimos la plata» cuando ve `true` mandaba dos avisos por una sola
    // devolucion.
    const p = await personaCon('ms13-1', ['cliente'])
    await acreditar(p, 100_000, 'carga:ms13-1')
    const creado = await pedir(p, 30_000, 'ms13-1:k')
    const pedido_id = String(((await creado.json()) as Record<string, unknown>)['pedido_id'])

    const T = '2026-08-19T15:00:00.000Z'
    const token = await tokenEn(T)

    const [a, b] = await Promise.all([
      conReloj(T, 'POST', `/pedidos/${pedido_id}/cancelar`, { token }),
      conReloj(T, 'POST', `/pedidos/${pedido_id}/cancelar`, { token }),
    ])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const ca = (await a.json()) as Record<string, unknown>
    const cb = (await b.json()) as Record<string, unknown>

    // Las dos ven el pedido cancelado — eso es correcto y es lo que la version
    // anterior devolvia como `cancelado`.
    expect(ca['estado']).toBe('cancelado')
    expect(cb['estado']).toBe('cancelado')

    // LO QUE SE MIDE: UNA sola dice que cancelo.
    expect([ca['cancelado'], cb['cancelado']].filter((x) => x === true).length).toBe(1)

    // Y un solo renglon de bitacora, que es la mitad que la 1.2 ya habia resuelto.
    expect(await renglones(pedido_id, 'pedido.cancelado')).toBe(1)

    // La plata volvio una sola vez.
    expect(sumar(await bolsas(p), 'disponible')).toBe(100_000)
    expect(sumar(await bolsas(p), 'retenido')).toBe(0)
  })
})

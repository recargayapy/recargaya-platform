/**
 * Pruebas del ORACULO, no del codigo.
 *
 * `verificarInvariantes` es lo que el spike usa para decidir si un reparto
 * quedo bien. Si el oraculo no puede fallar, el spike entero es teatro: se
 * corren treinta pruebas contra un juez que siempre dice que si.
 *
 * Estas pruebas existen porque la mutacion las pidio: al romper a proposito
 * las comprobaciones de descuadre y de asiento duplicado, ninguna prueba se
 * dio cuenta. Ahora si.
 */

import { describe, it, expect } from 'vitest'
import { guaranies } from '../src/dinero/monto.js'
import {
  type EstadoBilletera,
  billeteraVacia,
  acreditar,
  verificarInvariantes,
  verificarDelta,
} from '../src/billetera/nucleo.js'

const OP = { clave_idem: 'k1', correlacion_id: 'c1', momento: '2026-08-14T12:00:00.000Z' }

function conSaldo(monto: number): EstadoBilletera {
  return acreditar(billeteraVacia('b1'), OP, {
    monto: guaranies(monto),
    bolsa: 'disponible',
    concepto: 'seed',
    origen: 'semilla',
  }).estado
}

describe('el oraculo detecta lo que tiene que detectar', () => {
  it('acepta un estado sano', () => {
    expect(() => verificarInvariantes(conSaldo(100_000))).not.toThrow()
  })

  it('grita si una bolsa quedo en negativo', () => {
    const sano = conSaldo(100_000)
    const roto: EstadoBilletera = {
      ...sano,
      bolsas: [{ ...sano.bolsas[0]!, monto: guaranies(-1) }],
    }
    expect(() => verificarInvariantes(roto)).toThrow(/negativo/)
  })

  it('grita si el ledger y las bolsas no cuadran', () => {
    // Plata que aparecio en la bolsa sin asiento que la respalde. Es
    // exactamente la forma que toma un pago doble mal absorbido.
    const sano = conSaldo(100_000)
    const roto: EstadoBilletera = {
      ...sano,
      bolsas: [{ ...sano.bolsas[0]!, monto: guaranies(150_000) }],
    }
    expect(() => verificarInvariantes(roto)).toThrow(/descuadre/)
  })

  it('grita si un asiento aparece dos veces en la misma operacion', () => {
    // Esta comprobacion se mudo de `verificarInvariantes` a `verificarDelta`
    // cuando el estado se angosto: los asientos ya no vuelven del nucleo, salen
    // como delta. No se perdio nada — entre operaciones lo hace cumplir la
    // PRIMARY KEY de la tabla `asientos`, que es mas fuerte que un Set en
    // memoria porque no depende de que alguien llame a una funcion.
    const asiento = {
      asiento_id: 'k1:cr',
      concepto: 'seed',
      monto: guaranies(100_000),
      bolsa: 'disponible' as const,
      clave_idem: 'k1',
      correlacion_id: 'c1',
      asentado_en: OP.momento,
    }
    expect(() => verificarDelta([asiento, asiento])).toThrow(/duplicado/)
    expect(() => verificarDelta([asiento])).not.toThrow()
  })

  it('el nucleo solo mira la clave de idempotencia de SU operacion', () => {
    // El repositorio carga `aplicadas` con UNA sola clave: la de la operacion.
    // Eso es correcto porque el nucleo nunca mira otra — y esto es el oraculo de
    // esa afirmacion, no un comentario que la promete. Con una clave señuelo
    // adentro, el resultado tiene que ser identico.
    const conSenuelo: EstadoBilletera = {
      ...billeteraVacia('b1'),
      aplicadas: new Map([['otra-clave-cualquiera', '{"saldo_retirable":999}']]),
    }
    const r = acreditar(conSenuelo, OP, {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'seed',
      origen: 'semilla',
    })
    expect(r.repetida).toBe(false)
    expect(r.valor.saldo_retirable).toBe(100_000)
  })

  it('grita si retenido no cuadra con las reservas abiertas', () => {
    // Plata "retenido" sin ninguna reserva abierta que la explique: exactamente
    // la forma de una reserva huerfana. No hay asiento que la respalde, asi
    // que el punto 2 (ledger vs bolsas) no la ve — el punto 4 es la unica
    // comprobacion que puede notar este descuadre especifico.
    const sano = conSaldo(100_000)
    const roto: EstadoBilletera = {
      ...sano,
      bolsas: [
        ...sano.bolsas,
        { tipo: 'retenido', monto: guaranies(10_000), vence_en: null, origen: 'r-fantasma', restringida_a: null },
      ],
    }
    expect(() => verificarInvariantes(roto)).toThrow(/descuadre en retenido/)
  })
})

describe('los dos descuadres que ninguna otra prueba distinguia', () => {
  // Los dos los pidio el arnes de mutacion despues de una auditoria, y los dos son
  // la misma leccion: cuando dos comprobaciones se superponen, la que se rompe
  // primero tapa a la otra. Para que cada una tenga oraculo hay que construir el
  // estado que SOLO ella rechaza.

  const bolsa = (tipo: 'disponible' | 'ganancia_creador' | 'retenido', monto: number, origen = 'x') => ({
    tipo,
    monto: guaranies(monto),
    vence_en: null,
    origen,
    restringida_a: null,
  })

  it('una bolsa de un tipo que NUNCA tuvo asiento tambien tiene que descuadrar', () => {
    // El invariante 2 recorria `estado.totales`, o sea solo los tipos con historia
    // en el ledger. Una bolsa de un tipo ausente era invisible: plata inventada que
    // el oraculo del camino caliente aprobaba. Medido por una auditoria, con estos
    // numeros exactos.
    const estado: EstadoBilletera = {
      billetera_id: 'b1',
      bolsas: [bolsa('ganancia_creador', 999_999)],
      totales: new Map([['disponible', 0]]),
      reservas: new Map(),
      aplicadas: new Map(),
    }

    expect(() => verificarInvariantes(estado)).toThrow(/descuadre en ganancia_creador/)
  })

  it('el retenido descuadra aunque el ledger cuadre con las bolsas', () => {
    // ESTE es el estado que solo el invariante 3 puede rechazar: el acumulado del
    // ledger y las bolsas dicen lo mismo —50.000 en retenido— y sin embargo no hay
    // ninguna reserva abierta que reclame esa plata.
    //
    // Es la forma que toma una reserva que se pierde del mapa, o algo que toca
    // `retenido` por fuera de reservar/consumir/liberar. Sin esta prueba, la
    // mutacion que le saca el `throw` al invariante 3 sobrevivia: las otras la
    // mataban por el invariante 2, que en ese estado no tiene nada que decir.
    const estado: EstadoBilletera = {
      billetera_id: 'b1',
      bolsas: [bolsa('retenido', 50_000, 'promo-1')],
      totales: new Map([['retenido', 50_000]]),
      reservas: new Map(),
      aplicadas: new Map(),
    }

    expect(() => verificarInvariantes(estado)).toThrow(/descuadre en retenido/)

    // Control positivo: con la reserva en su lugar, el MISMO estado pasa. Sin esto,
    // la prueba de arriba la cumpliria un oraculo que rechaza todo.
    const conLaReserva: EstadoBilletera = {
      ...estado,
      reservas: new Map([
        [
          'promo-1',
          {
            reserva_id: 'promo-1',
            tomas: [{ bolsa: bolsa('disponible', 50_000), monto: guaranies(50_000) }],
            consumido: guaranies(0),
            vence_en: '2026-12-31T00:00:00.000Z',
            estado: 'abierta' as const,
          },
        ],
      ]),
    }
    expect(() => verificarInvariantes(conLaReserva)).not.toThrow()

    // Y con la reserva consumida a medias, el retenido tiene que valer lo que NO se
    // gasto. Con 20.000 consumidos y 50.000 todavia en la bolsa, descuadra.
    const consumidaAMedias: EstadoBilletera = {
      ...conLaReserva,
      reservas: new Map([
        ['promo-1', { ...conLaReserva.reservas.get('promo-1')!, consumido: guaranies(20_000) }],
      ]),
    }
    expect(() => verificarInvariantes(consumidaAMedias)).toThrow(/descuadre en retenido/)
  })
})

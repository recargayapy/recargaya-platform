/**
 * reservar() / liberarReserva() — la implementacion real de la ley 11.
 *
 * Hasta esta prueba, ninguna de las dos corria bajo ningun test: la ley 11 se
 * probaba solo contra `devolver()` aislada (tests/bolsas.test.ts), nunca por
 * el camino real que pasa por el ledger y por `verificarInvariantes`.
 *
 * Escribir la segunda prueba de este archivo destapo un defecto real: el
 * oraculo sumaba de nuevo, en `enBolsas`, la plata retenida en una reserva
 * abierta — plata que `reservar()` ya habia descontado del ledger via un
 * `debitar()` real. El resultado era un descuadre fantasma en cualquier
 * estado sano con una reserva abierta. Se corrigio en nucleo.ts quitando esa
 * reconciliacion, que no correspondia con como reservar() esta escrito hoy.
 */

import { describe, it, expect } from 'vitest'
import { guaranies } from '../src/dinero/monto.js'
import {
  type EstadoBilletera,
  billeteraVacia,
  acreditar,
  reservar,
  liberarReserva,
  verificarInvariantes,
} from '../src/billetera/nucleo.js'

const AHORA = '2026-08-14T12:00:00Z'
const VENCE_CREDITO = '2026-12-31T00:00:00Z'
const VENCE_RESERVA = '2026-08-21T00:00:00Z'

function op(clave: string): { clave_idem: string; correlacion_id: string; momento: string } {
  return { clave_idem: clave, correlacion_id: 'c1', momento: AHORA }
}

function billeteraConDosBolsas(): EstadoBilletera {
  const conCredito = acreditar(billeteraVacia('b1'), op('semilla-credito'), {
    monto: guaranies(30_000),
    bolsa: 'credito_promocion',
    concepto: 'promo',
    origen: 'promo-agosto',
    vence_en: VENCE_CREDITO,
  }).estado

  return acreditar(conCredito, op('semilla-disponible'), {
    monto: guaranies(100_000),
    bolsa: 'disponible',
    concepto: 'seed',
    origen: 'semilla',
  }).estado
}

function conReservaAbierta(): EstadoBilletera {
  const inicial = billeteraConDosBolsas()
  return reservar(inicial, op('res-1'), {
    reserva_id: 'r1',
    monto: guaranies(50_000),
    vence_en: VENCE_RESERVA,
  }).estado
}

describe('reservar() toma de varias bolsas con precedencia distinta', () => {
  it('una reserva de 50.000 toma credito_promocion Y disponible a la vez', () => {
    const estado = conReservaAbierta()

    const reserva = estado.reservas.get('r1')
    expect(reserva?.estado).toBe('abierta')
    expect(reserva?.tomas).toHaveLength(2)
    expect(reserva?.tomas.find((t) => t.bolsa.tipo === 'credito_promocion')?.monto).toBe(30_000)
    expect(reserva?.tomas.find((t) => t.bolsa.tipo === 'disponible')?.monto).toBe(20_000)
  })

  it('el oraculo cuadra con la reserva ABIERTA', () => {
    const estado = conReservaAbierta()

    expect(estado.reservas.get('r1')?.estado).toBe('abierta')
    expect(() => verificarInvariantes(estado)).not.toThrow()
  })
})

describe('liberarReserva() — la regla anticajero por el camino real', () => {
  it('cada guarani vuelve a su bolsa de origen, con el vencimiento original', () => {
    const estado = conReservaAbierta()

    const { estado: liberado, valor } = liberarReserva(estado, op('lib-1'), { reserva_id: 'r1' })

    expect(valor.devuelto).toBe(50_000)
    expect(liberado.reservas.get('r1')?.estado).toBe('cancelada')

    const credito = liberado.bolsas.find((b) => b.tipo === 'credito_promocion' && b.origen === 'promo-agosto')
    expect(credito?.monto).toBe(30_000)
    expect(credito?.vence_en).toBe(VENCE_CREDITO) // no se renueva

    const disponible = liberado.bolsas
      .filter((b) => b.tipo === 'disponible' && b.origen === 'semilla')
      .reduce((a, b) => a + b.monto, 0)
    // 100.000 originales: se fueron 20.000 con la reserva, volvieron los mismos 20.000.
    expect(disponible).toBe(100_000)

    expect(() => verificarInvariantes(liberado)).not.toThrow()
  })

  it('liberar dos veces con la misma clave de idempotencia no devuelve doble', () => {
    const estado = conReservaAbierta()
    const opLiberar = op('lib-1')

    const primera = liberarReserva(estado, opLiberar, { reserva_id: 'r1' })
    const segunda = liberarReserva(primera.estado, opLiberar, { reserva_id: 'r1' })

    expect(segunda.repetida).toBe(true)
    expect(segunda.valor.devuelto).toBe(primera.valor.devuelto)

    const totalBolsas = (e: EstadoBilletera): number => e.bolsas.reduce((a, b) => a + b.monto, 0)
    expect(totalBolsas(segunda.estado)).toBe(totalBolsas(primera.estado))
    expect(() => verificarInvariantes(segunda.estado)).not.toThrow()
  })
})

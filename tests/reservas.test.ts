/**
 * reservar() / liberarReserva() — la implementacion real de la ley 11.
 *
 * El defecto medido (issue "la plata reservada tiene que ser visible para el
 * oraculo"): `reservar()` debitaba la plata con un `debitar()` real y la
 * dejaba viviendo SOLO dentro del Map de reservas, sin bolsa propia. Dos
 * llamadas legitimas con el mismo `reserva_id` (dos claves de idempotencia
 * distintas, no un reintento) pisaban la primera entrada del Map: esa plata
 * quedaba huerfana — salida de su bolsa, asentada en el ledger, sin nada que
 * la reclame — y el oraculo no tenia con que notarlo, porque ledger y bolsas
 * cuadraban igual.
 *
 * El arreglo: la reserva mueve la plata a una bolsa `retenido` de verdad
 * (bolsas.ts), y `reservar()` rechaza de entrada un `reserva_id` que ya
 * tenga una reserva abierta — el pisado del Map ya no puede ocurrir.
 */

import { describe, it, expect } from 'vitest'
import { guaranies } from '../src/dinero/monto.js'
import { saldoRetirable } from '../src/dinero/bolsas.js'
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

  it('la plata reservada vive en la bolsa retenido, no desaparece de las bolsas', () => {
    const estado = conReservaAbierta()

    // Nada se debita "contra la nada": lo que sale de credito_promocion y de
    // disponible aparece, entero, como retenido.
    const retenido = estado.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)
    expect(retenido).toBe(50_000)

    // Cada toma llega a retenido con el reserva_id como origen (paso 1 del
    // arreglo) y con su vencimiento original intacto, para poder devolverse
    // tal cual en liberarReserva().
    const retenidoDelCredito = estado.bolsas.find((b) => b.tipo === 'retenido' && b.vence_en === VENCE_CREDITO)
    expect(retenidoDelCredito?.monto).toBe(30_000)
    expect(retenidoDelCredito?.origen).toBe('r1')

    // retenido no aparece como disponible ni como credito: la bolsa de origen
    // efectivamente perdio esa plata.
    const disponible = estado.bolsas
      .filter((b) => b.tipo === 'disponible')
      .reduce((a, b) => a + b.monto, 0)
    expect(disponible).toBe(100_000 - 20_000)
    expect(estado.bolsas.some((b) => b.tipo === 'credito_promocion')).toBe(false)
  })

  it('retenido no cuenta para el saldo retirable', () => {
    const estado = conReservaAbierta()
    expect(saldoRetirable(estado.bolsas, AHORA)).toBe(100_000 - 20_000)
  })
})

describe('reservar() rechaza un reserva_id con reserva abierta existente', () => {
  it('caso medido del issue: dos reservas legitimas con el mismo reserva_id no pisan la primera', () => {
    const inicial = acreditar(billeteraVacia('b1'), op('semilla'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'seed',
      origen: 'semilla',
    }).estado

    const conR1 = reservar(inicial, op('res-1'), {
      reserva_id: 'R1',
      monto: guaranies(30_000),
      vence_en: VENCE_RESERVA,
    }).estado

    // Sin el arreglo, esta segunda llamada pisaba la entrada de R1 en el Map
    // y los 30.000 de la primera reserva quedaban huerfanos.
    expect(() =>
      reservar(conR1, op('res-2'), { reserva_id: 'R1', monto: guaranies(20_000), vence_en: VENCE_RESERVA }),
    ).toThrow(/ya existe una reserva abierta/)

    // La primera reserva sigue entera: nada se perdio.
    expect(conR1.reservas.get('R1')?.tomas.reduce((a, t) => a + t.monto, 0)).toBe(30_000)
    const retenido = conR1.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)
    expect(retenido).toBe(30_000)
    expect(() => verificarInvariantes(conR1)).not.toThrow()

    // liberar despues del intento fallido devuelve exactamente lo reservado,
    // ni un guarani de mas ni de menos.
    const { valor } = liberarReserva(conR1, op('lib-1'), { reserva_id: 'R1' })
    expect(valor.devuelto).toBe(30_000)
  })

  it('un reintento real (misma clave de idempotencia) no choca con el rechazo', () => {
    const inicial = acreditar(billeteraVacia('b1'), op('semilla'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'seed',
      origen: 'semilla',
    }).estado

    const opReserva = op('res-1')
    const primera = reservar(inicial, opReserva, { reserva_id: 'R1', monto: guaranies(30_000), vence_en: VENCE_RESERVA })
    const segunda = reservar(primera.estado, opReserva, {
      reserva_id: 'R1',
      monto: guaranies(30_000),
      vence_en: VENCE_RESERVA,
    })

    expect(segunda.repetida).toBe(true)
    expect(segunda.valor).toEqual(primera.valor)
  })

  it('un reserva_id ya liberado se puede volver a usar', () => {
    const inicial = acreditar(billeteraVacia('b1'), op('semilla'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'seed',
      origen: 'semilla',
    }).estado

    const conR1 = reservar(inicial, op('res-1'), { reserva_id: 'R1', monto: guaranies(30_000), vence_en: VENCE_RESERVA }).estado
    const liberado = liberarReserva(conR1, op('lib-1'), { reserva_id: 'R1' }).estado

    expect(() =>
      reservar(liberado, op('res-2'), { reserva_id: 'R1', monto: guaranies(10_000), vence_en: VENCE_RESERVA }),
    ).not.toThrow()
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

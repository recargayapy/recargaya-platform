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

const OP = { clave_idem: 'k1', correlacion_id: 'c1', momento: '2026-08-14T12:00:00Z' }

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

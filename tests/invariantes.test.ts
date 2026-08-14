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

  it('grita si un asiento aparece dos veces', () => {
    const sano = conSaldo(100_000)
    const roto: EstadoBilletera = {
      ...sano,
      // El asiento duplicado tambien duplica el monto del ledger, asi que
      // compensamos la bolsa para que el UNICO defecto sea la duplicacion.
      // Sin esto, la prueba pasaria por el descuadre y no probaria lo suyo.
      asientos: [...sano.asientos, ...sano.asientos],
      bolsas: [{ ...sano.bolsas[0]!, monto: guaranies(200_000) }],
    }
    expect(() => verificarInvariantes(roto)).toThrow(/duplicado/)
  })
})

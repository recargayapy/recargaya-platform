import { describe, it, expect } from 'vitest'
import { guaranies, repartirExacto, MontoInvalido } from '../src/dinero/monto.js'

describe('el guarani es entero', () => {
  it('rechaza decimales', () => {
    expect(() => guaranies(100.5)).toThrow(MontoInvalido)
  })
  it('rechaza NaN e infinito', () => {
    expect(() => guaranies(Number.NaN)).toThrow(MontoInvalido)
    expect(() => guaranies(Number.POSITIVE_INFINITY)).toThrow(MontoInvalido)
  })
  it('acepta el cero y los negativos (un debito es negativo)', () => {
    expect(guaranies(0)).toBe(0)
    expect(guaranies(-500)).toBe(-500)
  })
})

describe('reparto exacto', () => {
  it('la suma es siempre el total, para cualquier monto', () => {
    const pesos = [70, 10, 20]
    for (let monto = 1; monto <= 3000; monto++) {
      const partes = repartirExacto(guaranies(monto), pesos)
      const suma = partes.reduce((a, b) => a + b, 0)
      // Esta es la prueba que un reparto ingenuo con Math.round no pasa.
      expect(suma, `fallo con monto ${monto}`).toBe(monto)
    }
  })

  it('el remanente va a la parte de mayor resto, de forma reproducible', () => {
    const a = repartirExacto(guaranies(100_001), [70, 10, 20])
    const b = repartirExacto(guaranies(100_001), [70, 10, 20])
    expect(a).toEqual(b)
    expect(a.reduce((x, y) => x + y, 0)).toBe(100_001)
  })

  it('con pesos que suman cero, falla ruidosamente', () => {
    expect(() => repartirExacto(guaranies(1000), [0, 0])).toThrow(MontoInvalido)
  })

  it('un monto de 1 guarani no se pierde: alguien lo recibe', () => {
    const partes = repartirExacto(guaranies(1), [70, 10, 20])
    expect(partes.reduce((a, b) => a + b, 0)).toBe(1)
  })
})

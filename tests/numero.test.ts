/**
 * El numero de pedido: la forma, y que se acepta como año.
 *
 * Estas pruebas viven en el nucleo y no en el runtime a proposito, y el motivo esta
 * medido en el encabezado de `src/pedidos/numero.ts`: la validacion vivia adentro
 * del metodo de `SecuenciaDO`, y probarla desde ahi dejaba el oraculo del runtime en
 * rojo por «unhandled errors» aunque todas las pruebas pasaran.
 */

import { describe, it, expect } from 'vitest'
import {
  ANCHO_DEL_CORRELATIVO,
  ANIO_MAXIMO,
  ANIO_MINIMO,
  AnioInvalido,
  PEDIDO_VALIDO,
  exigirAnio,
  numeroDePedido,
  pedidoIdValido,
} from '../src/pedidos/numero.js'

describe('el año de la secuencia', () => {
  it('acepta los años que existen', () => {
    expect(exigirAnio(2026)).toBe(2026)
    expect(exigirAnio(ANIO_MINIMO)).toBe(ANIO_MINIMO)
    expect(exigirAnio(ANIO_MAXIMO)).toBe(ANIO_MAXIMO)
  })

  it('rechaza lo que no es un año, porque termina EN EL TEXTO del numero', () => {
    // Sin el guarda salen `RY-2026.5-000001` y `RY--1-000001`, y los dos pasan por
    // la columna sin quejarse porque `pedidos.id` es TEXT.
    for (const malo of [2026.5, -1, 0, 1999, 10_000, 12_345, NaN, Infinity]) {
      expect(() => exigirAnio(malo), String(malo)).toThrow(AnioInvalido)
    }
  })

  it('el error dice que se esperaba', () => {
    try {
      exigirAnio(2026.5)
      throw new Error('no tiro')
    } catch (e) {
      expect(e).toBeInstanceOf(AnioInvalido)
      expect((e as AnioInvalido).message).toContain(String(ANIO_MINIMO))
      expect((e as AnioInvalido).anio).toBe(2026.5)
    }
  })
})

describe('la forma del numero', () => {
  it('rellena a seis digitos', () => {
    expect(numeroDePedido(2026, 1)).toBe('RY-2026-000001')
    expect(numeroDePedido(2026, 999_999)).toBe('RY-2026-999999')
    expect(ANCHO_DEL_CORRELATIVO).toBe(6)
  })

  it('el pedido un millon desborda el ancho, y eso esta declarado', () => {
    // No se rellena a la fuerza ni se trunca: el numero crece. Sigue siendo unico y
    // deja de ordenar bien como texto, que es lo que el encabezado dice.
    expect(numeroDePedido(2026, 1_000_000)).toBe('RY-2026-1000000')
    // Y sigue pasando el guarda de forma, que es lo que impide que ese pedido sea
    // un apagon.
    expect(pedidoIdValido('RY-2026-1000000')).toBe(true)
  })

  it('valida el año tambien acá, no solo en la secuencia', () => {
    expect(() => numeroDePedido(2026.5, 1)).toThrow(AnioInvalido)
  })

  it('un correlativo que no es un correlativo no entra', () => {
    expect(() => numeroDePedido(2026, 0)).toThrow()
    expect(() => numeroDePedido(2026, -3)).toThrow()
    expect(() => numeroDePedido(2026, 1.5)).toThrow()
  })
})

describe('lo que se acepta como pedido_id', () => {
  it('lo que la plataforma emite', () => {
    expect(pedidoIdValido('RY-2026-000001')).toBe(true)
    expect(pedidoIdValido(numeroDePedido(2026, 42))).toBe(true)
  })

  it('y nada mas', () => {
    for (const malo of [
      '',
      'RY-2026-1',
      'RY-26-000001',
      'ry-2026-000001',
      'RY-2026-000001 ',
      'RY-2026-000001; DROP TABLE pedidos',
      '../pedidos/RY-2026-000001',
      'x'.repeat(500),
      null,
      undefined,
      42,
    ]) {
      expect(pedidoIdValido(malo), String(malo)).toBe(false)
    }
  })

  it('el patron esta anclado de los dos lados', () => {
    // Sin las anclas, `basura RY-2026-000001 basura` entra.
    expect(PEDIDO_VALIDO.source.startsWith('^')).toBe(true)
    expect(PEDIDO_VALIDO.source.endsWith('$')).toBe(true)
  })
})

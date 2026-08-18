/**
 * El `correlacion_id`: lo unico que despues ata cinco filas en cinco tablas.
 *
 * Se prueba aparte del enrutador porque es la parte pura, y porque el criterio
 * —una correlacion invalida NO es un error— es una decision que conviene tener
 * escrita en una prueba y no solo en un comentario.
 */

import { describe, it, expect } from 'vitest'
import { correlacionDe, correlacionValida } from '../src/api/rutas.js'

const pedir = (encabezados: Record<string, string> = {}) =>
  new Request('https://ejemplo.test/billetera/acreditar', { method: 'POST', headers: encabezados })

describe('que se acepta como correlacion', () => {
  it('lo razonable', () => {
    expect(correlacionValida('abc-123')).toBe(true)
    expect(correlacionValida('pedido:RY-2026-000001')).toBe(true)
    expect(correlacionValida('a'.repeat(64))).toBe(true)
  })

  it('nada, no', () => {
    expect(correlacionValida('')).toBe(false)
    expect(correlacionValida(null)).toBe(false)
    expect(correlacionValida(undefined)).toBe(false)
  })

  it('mas largo que el tope, no', () => {
    // Sin tope, cada fila de bitacora puede llevar diez kilobytes puestos por el
    // llamador.
    expect(correlacionValida('a'.repeat(65))).toBe(false)
  })

  it('un salto de linea, no', () => {
    // Es lo que parte el log en dos y hace que una linea inventada parezca un
    // registro.
    expect(correlacionValida('abc\ndef')).toBe(false)
    expect(correlacionValida('abc def')).toBe(false)
    expect(correlacionValida('abc/def')).toBe(false)
  })
})

describe('de donde sale la correlacion de una peticion', () => {
  it('la que trae el llamador, si sirve', () => {
    expect(correlacionDe(pedir({ 'x-correlacion-id': 'pedido:42' }), () => 'nueva')).toBe('pedido:42')
  })

  it('una nueva si no trae ninguna', () => {
    expect(correlacionDe(pedir(), () => 'nueva')).toBe('nueva')
  })

  it('una nueva si la que trae no sirve — NO un error', () => {
    // Rechazar una acreditacion legitima por un encabezado mal escrito es cambiar
    // un problema de trazas por un problema de plata.
    expect(correlacionDe(pedir({ 'x-correlacion-id': 'a b c' }), () => 'nueva')).toBe('nueva')
    expect(correlacionDe(pedir({ 'x-correlacion-id': 'x'.repeat(200) }), () => 'nueva')).toBe('nueva')
  })
})

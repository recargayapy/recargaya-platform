/**
 * Pruebas de la ley 9 en la bitacora: ningun dato personal en el detalle.
 *
 * El guarda es una lista de claves, y una lista de claves NO garantiza la ley —
 * eso lo dice el propio archivo. Lo que estas pruebas fijan es que atrape el caso
 * real (alguien mete el objeto de la persona entero) y que lo haga a cualquier
 * profundidad, que es donde una version ingenua falla.
 */

import { describe, it, expect } from 'vitest'
import { DatoPersonalEnBitacora, revisarDetalle } from '../src/bitacora/bitacora.js'

describe('el detalle de la bitacora', () => {
  it('deja pasar identificadores y montos', () => {
    expect(() =>
      revisarDetalle({ persona_id: 'p1', billetera_id: 'billetera:p1', monto: 100_000 }),
    ).not.toThrow()
  })

  it('deja pasar null y objetos vacios', () => {
    expect(() => revisarDetalle(null)).not.toThrow()
    expect(() => revisarDetalle({})).not.toThrow()
  })

  it('rechaza el correo en el primer nivel', () => {
    expect(() => revisarDetalle({ email: 'quien@sea.com' })).toThrow(DatoPersonalEnBitacora)
  })

  it('rechaza el dato personal ANIDADO', () => {
    // Es la forma que toma en cuanto alguien mete un objeto adentro de otro, que
    // es siempre. Una version que mirara solo el primer nivel pasa la prueba de
    // arriba y falla acá.
    expect(() => revisarDetalle({ persona: { nombre: 'Fulano' } })).toThrow(DatoPersonalEnBitacora)
  })

  it('rechaza el dato personal adentro de una lista', () => {
    expect(() => revisarDetalle({ afectados: [{ persona_id: 'p1' }, { cedula: '1234567' }] })).toThrow(
      DatoPersonalEnBitacora,
    )
  })

  it('no se escapa por mayusculas', () => {
    expect(() => revisarDetalle({ Email: 'quien@sea.com' })).toThrow(DatoPersonalEnBitacora)
    expect(() => revisarDetalle({ TELEFONO: '0981' })).toThrow(DatoPersonalEnBitacora)
  })

  it('el error dice cual fue la clave', () => {
    // Sin el nombre, el que lo recibe tiene que adivinar cual de los quince campos
    // del detalle fue.
    try {
      revisarDetalle({ datos: { ruc: '80012345-6' } })
      throw new Error('no tiro')
    } catch (e) {
      expect(e).toBeInstanceOf(DatoPersonalEnBitacora)
      expect((e as DatoPersonalEnBitacora).clave).toBe('ruc')
    }
  })

  it('tambien atrapa lo que no es un dato de la persona pero no puede quedar escrito', () => {
    // Un token o una contraseña en el detalle es tan grave como un nombre: queda
    // en una tabla append-only que nadie puede borrar.
    expect(() => revisarDetalle({ token: 'v1.abc.def' })).toThrow(DatoPersonalEnBitacora)
    expect(() => revisarDetalle({ password: 'x' })).toThrow(DatoPersonalEnBitacora)
  })
})

/**
 * Pruebas de la funcion pura que contesta "¿esta persona puede hacer esto?".
 *
 * Lo que se prueba acá NO es que la funcion devuelva true cuando corresponde —eso
 * lo diria cualquier prueba—. Es lo otro: que la respuesta no dependa del orden de
 * las filas (ley 4), que los bordes de la ventana esten donde dicen estar, y que
 * el estado de la cuenta gane sobre la capacidad.
 */

import { describe, it, expect } from 'vitest'
import {
  CAPACIDADES,
  type Capacidad,
  type Otorgamiento,
  type Persona,
  capacidadesVigentes,
  esCapacidad,
  otorgamiento,
  puede,
  vigente,
} from '../src/identidad/capacidades.js'
import { instante } from '../src/dinero/momento.js'

const T = (texto: string) => instante(texto)

const ENERO = T('2026-01-01T00:00:00.000Z')
const MARZO = T('2026-03-01T00:00:00.000Z')
const JULIO = T('2026-07-01T00:00:00.000Z')
const SEPTIEMBRE = T('2026-09-01T00:00:00.000Z')
const DICIEMBRE = T('2026-12-01T00:00:00.000Z')

function persona(otorgamientos: readonly Otorgamiento[], estado: Persona['estado'] = 'activa'): Persona {
  return {
    persona_id: 'p1',
    estado,
    billetera_id: 'billetera:p1',
    creada_en: ENERO,
    otorgamientos,
  }
}

const ventana = (capacidad: Capacidad, desde: string, hasta: string | null): Otorgamiento =>
  otorgamiento({ capacidad, otorgada_en: desde, hasta })

describe('las cuatro capacidades', () => {
  // SON CUATRO. Esta prueba existe porque en la conversacion del 18/08 se
  // enumeraron tres, dos veces seguidas, y lo noto el dueño. La prosa no tiene
  // arnes; esto si.
  it('son exactamente cuatro, y el distribuidor esta', () => {
    expect([...CAPACIDADES]).toEqual(['cliente', 'vendedor', 'creador', 'distribuidor'])
    expect(CAPACIDADES).toHaveLength(4)
    expect(CAPACIDADES).toContain('distribuidor')
  })

  it('la lista de runtime no deja pasar lo que el tipo no admite', () => {
    expect(esCapacidad('vendedor')).toBe(true)
    expect(esCapacidad('afiliado')).toBe(false)
    expect(esCapacidad('')).toBe(false)
    expect(esCapacidad(null)).toBe(false)
    expect(esCapacidad(7)).toBe(false)
  })
})

describe('los bordes de la ventana', () => {
  it('en su propio instante de otorgamiento ya vale', () => {
    expect(vigente(ventana('cliente', MARZO, null), MARZO)).toBe(true)
  })

  it('un instante antes de otorgarla, no', () => {
    expect(vigente(ventana('cliente', MARZO, null), ENERO)).toBe(false)
  })

  it('en el instante exacto del hasta ya NO vale', () => {
    // Exclusive, y a proposito: es el mismo criterio que usa `bolsas.ts` para el
    // vencimiento (`vence_en <= momento` ⇒ vencida). Si los dos difirieran habria
    // un instante en el que una bolsa esta vencida y una capacidad no.
    expect(vigente(ventana('vendedor', MARZO, JULIO), JULIO)).toBe(false)
  })

  it('un milisegundo antes del hasta todavia vale', () => {
    expect(vigente(ventana('vendedor', MARZO, JULIO), T('2026-06-30T23:59:59.999Z'))).toBe(true)
  })

  it('sin hasta, vale para siempre hacia adelante', () => {
    expect(vigente(ventana('creador', MARZO, null), T('2099-01-01T00:00:00.000Z'))).toBe(true)
  })
})

describe('el estado de la cuenta gana sobre la capacidad', () => {
  const conVentanaAbierta = (estado: Persona['estado']) =>
    persona([ventana('cliente', ENERO, null)], estado)

  it('una cuenta suspendida no puede, aunque la capacidad este vigente', () => {
    expect(puede(conVentanaAbierta('suspendida'), 'cliente', MARZO)).toEqual({
      puede: false,
      motivo: 'persona_suspendida',
    })
  })

  it('una cuenta cerrada tampoco', () => {
    expect(puede(conVentanaAbierta('cerrada'), 'cliente', MARZO)).toEqual({
      puede: false,
      motivo: 'persona_cerrada',
    })
  })

  it('una cuenta activa con la ventana abierta, si', () => {
    expect(puede(conVentanaAbierta('activa'), 'cliente', MARZO)).toEqual({ puede: true })
  })
})

describe('ventanas superpuestas — el caso que la ley 4 nombra', () => {
  // Fue vendedora de marzo a julio, no lo fue de julio a septiembre, y volvio a
  // serlo de septiembre en adelante. Sin ventanas, esta historia no se puede
  // contar: o se pierde el primer tramo o se miente sobre el del medio.
  const conHistoria = persona([
    ventana('vendedor', MARZO, JULIO),
    ventana('vendedor', SEPTIEMBRE, null),
  ])

  it('vale adentro del primer tramo', () => {
    expect(puede(conHistoria, 'vendedor', T('2026-05-01T00:00:00.000Z')).puede).toBe(true)
  })

  it('NO vale en el hueco del medio', () => {
    expect(puede(conHistoria, 'vendedor', T('2026-08-01T00:00:00.000Z')).puede).toBe(false)
  })

  it('vuelve a valer en el segundo tramo', () => {
    expect(puede(conHistoria, 'vendedor', DICIEMBRE).puede).toBe(true)
  })

  it('dos ventanas que se pisan de verdad no cambian la respuesta', () => {
    // Marzo–diciembre y julio–septiembre, encimadas. La respuesta es una union,
    // no un maximo ni una ultima: en agosto vale por las dos.
    const encimadas = persona([
      ventana('creador', MARZO, DICIEMBRE),
      ventana('creador', JULIO, SEPTIEMBRE),
    ])
    expect(puede(encimadas, 'creador', T('2026-08-01T00:00:00.000Z')).puede).toBe(true)
    expect(puede(encimadas, 'creador', T('2026-11-01T00:00:00.000Z')).puede).toBe(true)
  })
})

describe('la respuesta NO depende del orden de las filas', () => {
  // ESTA es la prueba que hace cumplir la ley 4. Una implementacion que mire "la
  // primera fila" o "la ultima" muere acá — y tambien en el bloque de ventanas
  // superpuestas, que la mata por otro lado. (La version anterior decia que pasaba
  // todas las de arriba; una auditoria lo midio y son cuatro las que mueren.)
  const vencida = ventana('vendedor', ENERO, MARZO)
  const abierta = ventana('vendedor', JULIO, null)

  it('vigente sale igual con las filas en cualquier orden', () => {
    expect(puede(persona([vencida, abierta]), 'vendedor', DICIEMBRE)).toEqual({ puede: true })
    expect(puede(persona([abierta, vencida]), 'vendedor', DICIEMBRE)).toEqual({ puede: true })
  })

  it('y el MOTIVO del no tambien', () => {
    // Una vencida y una futura sobre la misma capacidad. El motivo esta declarado
    // —vencida gana— y no puede salir de cual fila vino primero de la base.
    const futura = ventana('creador', DICIEMBRE, null)
    const yaVencida = ventana('creador', ENERO, MARZO)
    const enJulio = JULIO

    expect(puede(persona([yaVencida, futura]), 'creador', enJulio)).toEqual({
      puede: false,
      motivo: 'capacidad_vencida',
    })
    expect(puede(persona([futura, yaVencida]), 'creador', enJulio)).toEqual({
      puede: false,
      motivo: 'capacidad_vencida',
    })
  })
})

describe('los motivos del no', () => {
  it('sin ninguna ventana de esa capacidad', () => {
    expect(puede(persona([ventana('cliente', ENERO, null)]), 'distribuidor', MARZO)).toEqual({
      puede: false,
      motivo: 'sin_capacidad',
    })
  })

  it('la tuvo y la perdio', () => {
    expect(puede(persona([ventana('vendedor', ENERO, MARZO)]), 'vendedor', JULIO)).toEqual({
      puede: false,
      motivo: 'capacidad_vencida',
    })
  })

  it('todavia no empezo', () => {
    expect(puede(persona([ventana('vendedor', DICIEMBRE, null)]), 'vendedor', JULIO)).toEqual({
      puede: false,
      motivo: 'capacidad_futura',
    })
  })

  it('una ventana de OTRA capacidad no contamina el motivo de esta', () => {
    // Las ventanas de OTRA capacidad no pueden producir un motivo. Sin el filtro
    // por capacidad, tener `cliente` vencida haria que preguntar por `creador`
    // contestara "capacidad_vencida" en vez de "sin_capacidad".
    expect(puede(persona([ventana('cliente', ENERO, MARZO)]), 'creador', JULIO)).toEqual({
      puede: false,
      motivo: 'sin_capacidad',
    })
  })
})

describe('capacidadesVigentes', () => {
  it('devuelve solo las vigentes en ese momento', () => {
    const p = persona([
      ventana('cliente', ENERO, null),
      ventana('vendedor', ENERO, MARZO),
      ventana('creador', DICIEMBRE, null),
    ])
    expect(capacidadesVigentes(p, JULIO)).toEqual(['cliente'])
  })

  it('sale en el orden declarado, no en el de las filas', () => {
    const p = persona([
      ventana('distribuidor', ENERO, null),
      ventana('cliente', ENERO, null),
      ventana('creador', ENERO, null),
    ])
    expect(capacidadesVigentes(p, JULIO)).toEqual(['cliente', 'creador', 'distribuidor'])
  })

  it('una cuenta suspendida no tiene ninguna vigente', () => {
    const p = persona([ventana('cliente', ENERO, null)], 'suspendida')
    expect(capacidadesVigentes(p, JULIO)).toEqual([])
  })
})

describe('la puerta de entrada de un otorgamiento', () => {
  it('rechaza una capacidad que no existe', () => {
    expect(() =>
      otorgamiento({ capacidad: 'afiliado', otorgada_en: ENERO, hasta: null }),
    ).toThrow(/capacidad desconocida/)
  })

  it('rechaza un instante mal escrito, con huso en vez de Z', () => {
    // Es la leccion de `momento.ts`: dos instantes con anchos u husos distintos
    // comparan al reves de como corren los relojes, y estas dos columnas se
    // comparan como texto.
    expect(() =>
      otorgamiento({ capacidad: 'cliente', otorgada_en: '2026-03-01T00:00:00.000-03:00', hasta: null }),
    ).toThrow(/instante invalido/)
  })

  it('rechaza un hasta mal escrito', () => {
    expect(() =>
      otorgamiento({ capacidad: 'cliente', otorgada_en: ENERO, hasta: '2026-03-01' }),
    ).toThrow(/instante invalido/)
  })

  it('rechaza una ventana que termina antes de empezar', () => {
    expect(() => otorgamiento({ capacidad: 'cliente', otorgada_en: JULIO, hasta: MARZO })).toThrow(
      /es anterior/,
    )
  })

  it('ACEPTA una ventana de duracion cero, y nunca esta vigente', () => {
    // Otorgar y revocar en el mismo milisegundo es legitimo. La primera version la
    // rechazaba, y una auditoria midio el resultado: revocar en el mismo
    // milisegundo del otorgamiento salia como 500 y la capacidad quedaba abierta —
    // peor que la ventana vacia que se queria evitar.
    const cero = otorgamiento({ capacidad: 'cliente', otorgada_en: JULIO, hasta: JULIO })
    expect(cero.hasta).toBe(JULIO)
    expect(vigente(cero, JULIO)).toBe(false)
    expect(vigente(cero, MARZO)).toBe(false)
    expect(vigente(cero, DICIEMBRE)).toBe(false)
  })

  it('acepta la ventana abierta', () => {
    expect(otorgamiento({ capacidad: 'cliente', otorgada_en: ENERO, hasta: null })).toEqual({
      capacidad: 'cliente',
      desde: ENERO,
      hasta: null,
    })
  })
})

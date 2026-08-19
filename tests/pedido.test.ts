/**
 * La maquina de estados del pedido.
 *
 * Lo que estas pruebas fijan NO es «que las transiciones declaradas funcionen»
 * —eso lo prueba cualquier cosa— sino las tres propiedades que hacen que la tabla
 * no pueda mentir:
 *
 *   · que cada transicion declarada tenga el efecto CORRECTO sobre la plata, y que
 *     ese efecto salga de `RETIENEN_PLATA` y no de una segunda tabla
 *   · que los terminales sean terminales, derivados de la tabla y no listados
 *   · que las dos copias de la lista de estados —el tipo y el array de runtime—
 *     digan lo mismo
 */

import { describe, it, expect } from 'vitest'
import {
  type EstadoPedido,
  ESTADOS_DE_PEDIDO,
  RETENCION_INCIERTA,
  RETIENEN_PLATA,
  TRANSICIONES,
  TransicionInvalida,
  efectoSobreLaReserva,
  esEstadoDePedido,
  esTerminal,
  puedeTransicionar,
  transicionar,
} from '../src/pedidos/pedido.js'

describe('la lista de estados', () => {
  it('el array de runtime y el tipo dicen lo mismo', () => {
    // No se puede comparar contra el tipo en runtime, asi que se compara contra la
    // OTRA copia que existe: las claves de `TRANSICIONES`. Si alguien agrega un
    // estado al tipo y al array y se olvida de la tabla, o al reves, esto muere.
    expect([...ESTADOS_DE_PEDIDO].sort()).toEqual([...TRANSICIONES.keys()].sort())
  })

  it('reconoce los cinco y nada mas', () => {
    for (const e of ESTADOS_DE_PEDIDO) expect(esEstadoDePedido(e)).toBe(true)
    expect(esEstadoDePedido('reembolsado')).toBe(false)
    expect(esEstadoDePedido('')).toBe(false)
    expect(esEstadoDePedido(null)).toBe(false)
    expect(esEstadoDePedido(0)).toBe(false)
  })

  it('todo destino declarado es un estado que existe', () => {
    // Una transicion hacia un estado inventado compila —es un `EstadoPedido`— pero
    // si el destino no esta en la tabla, `esTerminal` de ese destino explota.
    for (const [desde, hacia] of TRANSICIONES) {
      for (const h of hacia) {
        expect(TRANSICIONES.has(h), `${desde} -> ${h}: ${h} no esta en la tabla`).toBe(true)
      }
    }
  })
})

describe('los caminos declarados', () => {
  it('los seis que existen', () => {
    expect(puedeTransicionar('creado', 'reservado').puede).toBe(true)
    expect(puedeTransicionar('creado', 'cancelado').puede).toBe(true)
    expect(puedeTransicionar('reservado', 'pagado').puede).toBe(true)
    expect(puedeTransicionar('reservado', 'cancelado').puede).toBe(true)
    expect(puedeTransicionar('pagado', 'repartido').puede).toBe(true)
  })

  it('cobrar sin haber reservado, NO', () => {
    // Es la ausencia mecanica: un pedido en `creado` no tiene ninguna reserva que
    // consumir, asi que declararla dejaria el pedido cobrado sin que se moviera un
    // guarani.
    const v = puedeTransicionar('creado', 'pagado')
    expect(v.puede).toBe(false)
    expect(v.puede === false && v.motivo).toBe('transicion_no_declarada')
  })

  it('cancelar un pedido ya cobrado, NO', () => {
    // La ausencia de negocio: deshacer un cobro es un asiento de compensacion, no
    // un cambio de estado. Ver el encabezado de `pedido.ts`.
    const v = puedeTransicionar('pagado', 'cancelado')
    expect(v.puede).toBe(false)
    expect(v.puede === false && v.motivo).toBe('transicion_no_declarada')
  })

  it('volver para atras, NO', () => {
    expect(puedeTransicionar('reservado', 'creado').puede).toBe(false)
    expect(puedeTransicionar('pagado', 'reservado').puede).toBe(false)
    expect(puedeTransicionar('repartido', 'pagado').puede).toBe(false)
  })
})

describe('los terminales', () => {
  it('son los dos, y salen de la tabla', () => {
    expect(esTerminal('repartido')).toBe(true)
    expect(esTerminal('cancelado')).toBe(true)
    expect(esTerminal('creado')).toBe(false)
    expect(esTerminal('reservado')).toBe(false)
    expect(esTerminal('pagado')).toBe(false)
  })

  it('de un terminal no sale NINGUN destino, y el motivo lo dice', () => {
    // Se prueban TODOS los destinos y no uno de muestra: la diferencia entre
    // «este camino no esta» y «de acá no sale ninguno» es justamente esa.
    for (const terminal of ESTADOS_DE_PEDIDO.filter(esTerminal)) {
      for (const destino of ESTADOS_DE_PEDIDO) {
        if (destino === terminal) continue
        const v = puedeTransicionar(terminal, destino)
        expect(v.puede, `${terminal} -> ${destino}`).toBe(false)
        expect(v.puede === false && v.motivo).toBe('estado_terminal')
      }
    }
  })
})

describe('el mismo estado', () => {
  it('gana sobre todo, incluso desde un terminal', () => {
    // Precedencia declarada. Un reintento de una transicion ya aplicada tiene que
    // distinguirse de un camino inexistente: de eso depende si el llamador escribe
    // un renglon de bitacora diciendo que paso algo.
    for (const e of ESTADOS_DE_PEDIDO) {
      const v = puedeTransicionar(e, e)
      expect(v.puede).toBe(false)
      expect(v.puede === false && v.motivo, e).toBe('mismo_estado')
    }
  })
})

describe('transicionar', () => {
  it('devuelve el estado nuevo cuando el camino existe', () => {
    expect(transicionar('creado', 'reservado')).toBe('reservado')
  })

  it('tira, con el motivo adentro, cuando no', () => {
    try {
      transicionar('cancelado', 'pagado')
      throw new Error('no tiro')
    } catch (e) {
      expect(e).toBeInstanceOf(TransicionInvalida)
      expect((e as TransicionInvalida).motivo).toBe('estado_terminal')
      expect((e as TransicionInvalida).desde).toBe('cancelado')
      expect((e as TransicionInvalida).hacia).toBe('pagado')
    }
  })
})

describe('el efecto sobre la plata', () => {
  it('entrar a un estado que retiene, reserva', () => {
    expect(efectoSobreLaReserva('creado', 'reservado')).toBe('reservar')
  })

  it('salir hacia cancelado devuelve; salir hacia cualquier otro lado cobra', () => {
    expect(efectoSobreLaReserva('reservado', 'cancelado')).toBe('liberar')
    expect(efectoSobreLaReserva('reservado', 'pagado')).toBe('consumir')
  })

  it('entre dos estados que no retienen, la plata no se mueve', () => {
    expect(efectoSobreLaReserva('pagado', 'repartido')).toBe('ninguno')
  })

  it('IR A CANCELADO SIEMPRE LIBERA, aunque el estado diga que no hay nada retenido', () => {
    // La correccion mas cara de la 1.3, medida por las dos vueltas de auditoria:
    // `creado` con la reserva viva es alcanzable —el orquestador reserva y despues
    // anota— y con `ninguno` quedaban 45.000 Gs. retenidos en un pedido TERMINAL,
    // sin ningun camino de codigo que los soltara.
    expect(efectoSobreLaReserva('creado', 'cancelado')).toBe('liberar')
    expect(efectoSobreLaReserva('reservado', 'cancelado')).toBe('liberar')
  })

  /**
   * LA PRUEBA QUE IMPORTA. Recorre TODAS las transiciones declaradas y comprueba
   * que el efecto sea consistente con `RETIENEN_PLATA`, sin nombrar ninguna.
   *
   * Es la que agarra la transicion nueva que alguien agrega sin pensar en la plata:
   * si aparece `en_disputa` en `RETIENEN_PLATA` y un camino `pagado -> en_disputa`,
   * esta prueba exige que el efecto sea `reservar` — y `pagado` ya no tiene plata
   * en la billetera para reservar. La contradiccion aparece acá y no en produccion.
   */
  it('ninguna transicion declarada puede dejar plata retenida sin dueño', () => {
    for (const [desde, destinos] of TRANSICIONES) {
      for (const hacia of destinos) {
        const efecto = efectoSobreLaReserva(desde, hacia)
        const antes = RETIENEN_PLATA.has(desde)
        const despues = RETIENEN_PLATA.has(hacia)

        // Ir a `cancelado` manda sobre todo: se suelta lo que haya. Se comprueba
        // primero porque es la regla que gobierna, igual que en la funcion.
        if (hacia === 'cancelado') {
          expect(efecto, `${desde} -> ${hacia}`).toBe('liberar')
        } else if (antes && !despues) {
          expect(efecto, `${desde} -> ${hacia}`).toBe('consumir')
        } else if (!antes && despues) {
          expect(efecto, `${desde} -> ${hacia}`).toBe('reservar')
        } else {
          expect(efecto, `${desde} -> ${hacia}`).toBe('ninguno')
        }
      }
    }
  })

  it('ningun estado terminal tiene retencion incierta', () => {
    // Si un terminal pudiera tener plata retenida sin saberlo, no habria transicion
    // que la soltara: de un terminal no sale ninguna.
    for (const e of ESTADOS_DE_PEDIDO.filter(esTerminal)) {
      expect(RETENCION_INCIERTA.has(e), `${e} es terminal y su retencion es incierta`).toBe(false)
    }
  })

  it('todo estado terminal deja la plata afuera de la billetera o devuelta', () => {
    // Un terminal que retuviera plata seria plata congelada para siempre: no hay
    // ninguna transicion que salga de ahi para soltarla.
    for (const e of ESTADOS_DE_PEDIDO.filter(esTerminal)) {
      expect(RETIENEN_PLATA.has(e), `${e} es terminal y retiene plata`).toBe(false)
    }
  })

  it('no se llega a un terminal dejando plata que nadie va a soltar', () => {
    // El lado que la version anterior no cubria, y que costo el defecto mas caro de
    // la entrega: no alcanza con que el estado terminal no retenga —eso lo dice la
    // prueba de arriba— hace falta que la TRANSICION que lleva ahi haga algo con la
    // plata QUE PUDIERA HABER, aunque el estado de origen diga que no hay.
    //
    // De un terminal no sale ningun camino, asi que lo que quede retenido al entrar
    // queda retenido para siempre.
    for (const [desde, destinos] of TRANSICIONES) {
      const puedeHaber = RETIENEN_PLATA.has(desde) || RETENCION_INCIERTA.has(desde)
      if (!puedeHaber) continue
      for (const hacia of destinos.filter(esTerminal)) {
        expect(efectoSobreLaReserva(desde, hacia), `${desde} -> ${hacia}`).not.toBe('ninguno')
      }
    }
  })

  it('todo estado que retiene plata tiene por donde soltarla', () => {
    // El lado espejo: si un estado retiene, tiene que existir al menos un camino
    // hacia `cancelado` —que devuelve— o el pedido queda con la plata adentro.
    for (const e of ESTADOS_DE_PEDIDO.filter((x: EstadoPedido) => RETIENEN_PLATA.has(x))) {
      const salidas = TRANSICIONES.get(e) ?? []
      expect(salidas, `${e} retiene plata y no tiene salida`).toContain('cancelado')
    }
  })
})

/**
 * El reparto de una venta entre cuatro billeteras.
 *
 * ESTE ES EL SPIKE DE LA FASE 0. Es lo primero que hay que probar porque es
 * lo unico que puede cambiar el modelo de datos entero.
 *
 * El problema: una venta de Creador Digital toca cuatro saldos —cliente,
 * creador, vendedor y plataforma— y en Cloudflare cada billetera es un Durable
 * Object distinto. NO HAY TRANSACCION QUE LOS ABARQUE. Si el Worker muere
 * entre el paso 2 y el 3, el cliente ya pago y el creador todavia no cobro.
 *
 * La respuesta del plan maestro: un Workflow con pasos idempotentes. Cada paso
 * llama a una billetera con una clave de idempotencia; la billetera rechaza el
 * duplicado. El Workflow persiste su estado entre pasos y reintenta EL PASO
 * QUE FALLO, no el proceso entero.
 *
 * Este archivo modela el Workflow sin depender del runtime de Cloudflare, para
 * que el arnes de pruebas pueda matarlo en cualquier punto. La version que
 * corre sobre Workflows es una cascara sobre estos mismos pasos.
 */

import { type Guaranies, guaranies, repartirExacto } from '../dinero/monto.js'

export interface Venta {
  readonly pedido_id: string
  readonly correlacion_id: string
  readonly momento: string
  readonly monto: Guaranies
  readonly comprador_id: string
  readonly creador_id: string
  /** Puede no haber vendedor: la venta directa no reparte comision de venta. */
  readonly vendedor_id: string | null
}

/**
 * Los pesos del reparto viajan como SNAPSHOT dentro de la venta, no se leen
 * de la configuracion al momento de repartir.
 *
 * Si se leyeran, cambiar una comision reescribiria retroactivamente lo que se
 * le debe a un creador por ventas de la semana pasada. El plan comercial se
 * congela al crear el pedido; esto es la misma regla aplicada al reparto.
 */
export interface PesosReparto {
  readonly creador: number
  readonly vendedor: number
  readonly plataforma: number
}

export interface Tajada {
  readonly billetera_id: string
  readonly papel: 'creador' | 'vendedor' | 'plataforma'
  readonly monto: Guaranies
  readonly concepto: string
  readonly bolsa: 'disponible' | 'ganancia_creador'
}

export const BILLETERA_PLATAFORMA = 'plataforma'

/**
 * Calcula el reparto. Funcion pura: mismos datos, mismo resultado, siempre.
 *
 * La suma de las tajadas es EXACTAMENTE el monto de la venta. Ni un guarani
 * de mas ni de menos — ver `repartirExacto`.
 */
export function calcularReparto(venta: Venta, pesos: PesosReparto): Tajada[] {
  if (venta.monto <= 0) throw new Error('no se reparte una venta de monto cero o negativo')

  const conVendedor = venta.vendedor_id !== null

  // Sin vendedor, su peso NO se descarta: se suma al de la plataforma. Si se
  // descartara, el reparto sumaria menos que la venta y el descuadre seria
  // silencioso.
  const partes: readonly number[] = conVendedor
    ? [pesos.creador, pesos.vendedor, pesos.plataforma]
    : [pesos.creador, pesos.vendedor + pesos.plataforma]

  const montos = repartirExacto(venta.monto, partes)

  const tajadas: Tajada[] = [
    {
      billetera_id: venta.creador_id,
      papel: 'creador',
      monto: montos[0] ?? guaranies(0),
      concepto: 'creator_earning',
      // No entra como disponible: entra como ganancia sujeta a la ventana de
      // retencion. Sin esto, un reembolso posterior a la liquidacion es un
      // procedimiento manual en vez de una regla.
      bolsa: 'ganancia_creador',
    },
  ]

  if (conVendedor && venta.vendedor_id !== null) {
    tajadas.push({
      billetera_id: venta.vendedor_id,
      papel: 'vendedor',
      monto: montos[1] ?? guaranies(0),
      concepto: 'sale_commission',
      bolsa: 'ganancia_creador',
    })
    tajadas.push({
      billetera_id: BILLETERA_PLATAFORMA,
      papel: 'plataforma',
      monto: montos[2] ?? guaranies(0),
      concepto: 'platform_revenue',
      bolsa: 'disponible',
    })
  } else {
    tajadas.push({
      billetera_id: BILLETERA_PLATAFORMA,
      papel: 'plataforma',
      monto: montos[1] ?? guaranies(0),
      concepto: 'platform_revenue',
      bolsa: 'disponible',
    })
  }

  const suma = tajadas.reduce((a, t) => a + t.monto, 0)
  if (suma !== venta.monto) {
    // Esto no deberia poder pasar. Que falle ruidosamente y no en produccion
    // dentro de tres meses.
    throw new Error(`el reparto no cuadra: ${suma} repartido de una venta de ${venta.monto}`)
  }

  return tajadas
}

// ---------------------------------------------------------------------------
// Los pasos del Workflow
// ---------------------------------------------------------------------------

export type NombrePaso = 'debitar_comprador' | 'acreditar_creador' | 'acreditar_vendedor' | 'acreditar_plataforma' | 'marcar_repartido'

/**
 * DEUDA DECLARADA DE LA ENTREGA 1.2, y la encontro una auditoria.
 *
 * Los `billetera_id` de este modulo son textos que decide el llamador, y hoy
 * `planificar()` recibe ids de persona pelados (`vendedor-9`). Desde la 1.2, el
 * nombre de una billetera lo decide `identidad/personas.ts:derivarBilleteraId`, que
 * antepone `billetera:`. Medido: `idFromName('p-9')` e `idFromName('billetera:p-9')`
 * son objetos DISTINTOS.
 *
 * O sea que el dia que el reparto se cablee de verdad, un `acreditar_vendedor` caeria
 * sobre un Durable Object fantasma mientras `GET /billetera/vendedor-9/saldo` muestra
 * cero — sin un solo error, porque acreditar sobre una billetera vacia funciona. El
 * `debitar` fallaria ruidoso; la direccion que falla en silencio es la que suma.
 *
 * Nada de esto se rompe hoy: `reparto.ts` no lo importa `index.ts`, solo las pruebas.
 * Se arregla en la entrega que cablee el reparto, y son DOS decisiones, no una:
 *
 *   · los `billetera_id` de personas salen de `derivarBilleteraId` y de ningun otro
 *     lado;
 *   · la billetera de la PLATAFORMA no puede salir de ahi, porque la plataforma no
 *     es una persona —es la decision declarada en `identidad/actor.ts`—. Hoy es el
 *     literal `BILLETERA_PLATAFORMA = 'plataforma'` de este archivo, y ese mismo
 *     texto es ademas el que `actorId()` emite y el que `RESERVADOS` prohibe como
 *     `persona_id`: tres significados sobre la misma cadena. Necesita su propia
 *     constante con prefijo, decidida en el mismo lugar que la otra.
 *
 * La version anterior de esta nota decia «se arregla en UN lugar» y dejaba afuera
 * justo la billetera que cobra la comision de la plataforma. Lo midio la segunda
 * vuelta de auditoria.
 */
export interface Paso {
  readonly nombre: NombrePaso
  readonly billetera_id: string
  /**
   * La clave de idempotencia. Identifica LA INTENCION: este pedido, este paso.
   * No incluye el momento ni el numero de intento — si los incluyera, cada
   * reintento seria una operacion nueva y se pagaria dos veces.
   */
  readonly clave_idem: string
  readonly ejecutar: (llamar: LlamarBilletera) => Promise<void>
}

export type LlamarBilletera = (
  billetera_id: string,
  operacion: 'debitar' | 'acreditar',
  carga: {
    readonly clave_idem: string
    readonly correlacion_id: string
    readonly momento: string
    readonly monto: Guaranies
    readonly concepto: string
    readonly bolsa?: 'disponible' | 'ganancia_creador'
    readonly origen?: string
  },
) => Promise<void>

/**
 * Arma la lista ordenada de pasos de un reparto.
 *
 * El orden importa: primero se debita al comprador. Si se acreditara primero,
 * una caida despues de acreditar y antes de debitar regalaria plata — y a
 * diferencia del caso contrario, ese error se descubre tarde y con la plata
 * ya retirada.
 *
 * El caso contrario (debitar y caer antes de acreditar) deja plata retenida
 * por el sistema, que es recuperable: el reintento la entrega. Entre dos
 * fallas, se elige la reversible.
 */
export function planificar(venta: Venta, pesos: PesosReparto): Paso[] {
  const tajadas = calcularReparto(venta, pesos)
  const pasos: Paso[] = []

  pasos.push({
    nombre: 'debitar_comprador',
    billetera_id: venta.comprador_id,
    clave_idem: `${venta.pedido_id}:debitar_comprador`,
    ejecutar: (llamar) =>
      llamar(venta.comprador_id, 'debitar', {
        clave_idem: `${venta.pedido_id}:debitar_comprador`,
        correlacion_id: venta.correlacion_id,
        momento: venta.momento,
        monto: venta.monto,
        concepto: 'purchase',
      }),
  })

  for (const t of tajadas) {
    const nombre: NombrePaso =
      t.papel === 'creador' ? 'acreditar_creador'
      : t.papel === 'vendedor' ? 'acreditar_vendedor'
      : 'acreditar_plataforma'

    const clave = `${venta.pedido_id}:${nombre}`
    pasos.push({
      nombre,
      billetera_id: t.billetera_id,
      clave_idem: clave,
      ejecutar: (llamar) =>
        llamar(t.billetera_id, 'acreditar', {
          clave_idem: clave,
          correlacion_id: venta.correlacion_id,
          momento: venta.momento,
          monto: t.monto,
          concepto: t.concepto,
          bolsa: t.bolsa,
          origen: `venta:${venta.pedido_id}`,
        }),
    })
  }

  return pasos
}

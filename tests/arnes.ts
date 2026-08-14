/**
 * El arnes del spike.
 *
 * Aviso deliberado: **un doble mas debil, mas fuerte o mas permisivo que el
 * original prueba el doble, no el codigo.** Este banco de billeteras usa
 * EXACTAMENTE las funciones de `src/billetera/nucleo.ts` — no reimplementa la
 * logica del dinero. Lo unico que simula es la persistencia y la caida.
 *
 * Lo que el arnes SI simula, y que el nucleo no puede simular solo:
 *   - que una llamada entre Durable Objects se corte a la mitad
 *   - que el corte ocurra DESPUES de que el destinatario aplico el cambio
 *     (el caso peligroso: el llamador cree que fallo, pero se hizo)
 *   - que el Workflow reintente el paso que fallo
 */

import {
  type EstadoBilletera,
  billeteraVacia,
  acreditar,
  debitar,
  verificarInvariantes,
} from '../src/billetera/nucleo.js'
import { type Guaranies } from '../src/dinero/monto.js'
import { type LlamarBilletera, type Paso } from '../src/reparto/reparto.js'

export class CaidaInyectada extends Error {
  constructor(readonly cuando: 'antes' | 'despues', readonly paso: string) {
    super(`caida inyectada ${cuando} del paso ${paso}`)
    this.name = 'CaidaInyectada'
  }
}

export interface PlanDeCaida {
  /** Indice del paso (base 0) en el que cae. */
  readonly enPaso: number
  /**
   * 'antes'  — cae antes de que la billetera aplique nada.
   * 'despues'— cae DESPUES de aplicar, antes de que el Workflow lo registre.
   *            Este es el caso que rompe los sistemas mal disenados.
   */
  readonly cuando: 'antes' | 'despues'
  /** Cuantas veces cae en ese paso antes de dejarlo pasar. */
  readonly veces: number
}

export class BancoDeBilleteras {
  private estados = new Map<string, EstadoBilletera>()
  /** Cuantas llamadas efectivas recibio cada billetera. Detecta el pago doble. */
  readonly llamadas: string[] = []

  obtener(id: string): EstadoBilletera {
    return this.estados.get(id) ?? billeteraVacia(id)
  }

  sembrar(id: string, monto: Guaranies, bolsa: 'disponible' | 'ganancia_creador' = 'disponible'): void {
    const r = acreditar(this.obtener(id), {
      clave_idem: `semilla:${id}:${bolsa}`,
      correlacion_id: 'semilla',
      momento: '2026-01-01T00:00:00Z',
    }, { monto, bolsa, concepto: 'seed', origen: 'semilla' })
    this.estados.set(id, r.estado)
  }

  /** Suma de todas las bolsas de todas las billeteras. Debe ser constante. */
  totalDelSistema(): number {
    let total = 0
    for (const e of this.estados.values()) {
      for (const b of e.bolsas) total += b.monto
    }
    return total
  }

  verificarTodas(): void {
    for (const e of this.estados.values()) verificarInvariantes(e)
  }

  llamar: LlamarBilletera = async (billetera_id, operacion, carga) => {
    this.llamadas.push(`${billetera_id}:${operacion}:${carga.clave_idem}`)
    const antes = this.obtener(billetera_id)
    const op = {
      clave_idem: carga.clave_idem,
      correlacion_id: carga.correlacion_id,
      momento: carga.momento,
    }

    const r =
      operacion === 'debitar'
        ? debitar(antes, op, { monto: carga.monto, concepto: carga.concepto })
        : acreditar(antes, op, {
            monto: carga.monto,
            bolsa: carga.bolsa ?? 'disponible',
            concepto: carga.concepto,
            origen: carga.origen ?? 'desconocido',
          })

    this.estados.set(billetera_id, r.estado)
    // Invariante despues de CADA escritura, no solo al final. Un descuadre
    // intermedio que se corrige solo sigue siendo un descuadre.
    verificarInvariantes(r.estado)
  }
}

/**
 * Corre los pasos como los correria un Workflow: estado persistido entre
 * pasos, y al reintentar arranca DESDE EL PASO QUE FALLO, no desde cero.
 *
 * `completados` es el estado que Cloudflare Workflows persiste por nosotros.
 * Se pasa por referencia a proposito: sobrevive a la excepcion, igual que
 * sobrevive a la muerte del Worker.
 */
export async function correrWorkflow(
  pasos: readonly Paso[],
  banco: BancoDeBilleteras,
  completados: Set<string>,
  caida: PlanDeCaida | null,
  contador: { restantes: number },
): Promise<void> {
  for (let i = 0; i < pasos.length; i++) {
    const paso = pasos[i]
    if (paso === undefined) continue
    if (completados.has(paso.nombre)) continue

    const toca = caida !== null && caida.enPaso === i && contador.restantes > 0

    if (toca && caida.cuando === 'antes') {
      contador.restantes -= 1
      throw new CaidaInyectada('antes', paso.nombre)
    }

    await paso.ejecutar(banco.llamar)

    if (toca && caida.cuando === 'despues') {
      contador.restantes -= 1
      // La billetera YA aplico el cambio. El Workflow muere sin registrarlo.
      // Al reintentar, va a volver a llamar — y solo la idempotencia impide
      // que se pague dos veces.
      throw new CaidaInyectada('despues', paso.nombre)
    }

    completados.add(paso.nombre)
  }
}

/** Reintenta hasta que termine, como haria el Workflow con backoff. */
export async function correrHastaTerminar(
  pasos: readonly Paso[],
  banco: BancoDeBilleteras,
  caida: PlanDeCaida | null,
  maxIntentos = 20,
): Promise<number> {
  const completados = new Set<string>()
  const contador = { restantes: caida?.veces ?? 0 }

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      await correrWorkflow(pasos, banco, completados, caida, contador)
      return intento
    } catch (e) {
      if (!(e instanceof CaidaInyectada)) throw e
      // El invariante tiene que valer TAMBIEN despues de la caida, con el
      // reparto a medio hacer. Si solo valiera al final, no probaria nada.
      banco.verificarTodas()
    }
  }
  throw new Error(`el workflow no termino en ${maxIntentos} intentos`)
}

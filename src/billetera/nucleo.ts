/**
 * El nucleo de la billetera. Puro, sin Cloudflare adentro.
 *
 * Esta separacion es deliberada y es lo que hace posible el spike: la logica
 * del dinero se prueba sin desplegar nada, y el Durable Object queda como una
 * cascara delgada que persiste. Si la logica viviera dentro del DO, cada
 * prueba necesitaria un runtime y la mutacion seria impracticable.
 *
 * Ley 2: un asiento nunca se edita. Se compensa con otro asiento.
 * Ley 3: solo la billetera escribe asientos.
 */

import { type Guaranies, guaranies, CERO } from '../dinero/monto.js'
import { type Bolsa, type Toma, decidirConsumo, devolver, saldoRetirable } from '../dinero/bolsas.js'

export interface Asiento {
  readonly asiento_id: string
  readonly concepto: string
  readonly monto: Guaranies // positivo credito, negativo debito
  readonly bolsa: Bolsa['tipo']
  readonly clave_idem: string
  readonly correlacion_id: string
  readonly asentado_en: string
}

export interface Reserva {
  readonly reserva_id: string
  readonly tomas: readonly Toma[]
  /**
   * Cuanto de la reserva se gasto de verdad. Lo incrementa `consumirReserva()`.
   *
   * Estuvo declarado desde la Fase 0 sin nada que lo incrementara y sin nada que
   * lo acotara — «se podia consumir mas de lo reservado» era un defecto latente,
   * no una hipotesis. Hoy lo acota un trigger de la base
   * (`reservas_consumido_acotado`), que es donde no se puede esquivar, y esta
   * funcion es la unica que lo mueve.
   */
  readonly consumido: Guaranies
  readonly vence_en: string
  readonly estado: 'abierta' | 'cerrada' | 'cancelada'
}

/**
 * Un evento del outbox (ley 5). Se escribe en la MISMA transaccion que el cambio.
 *
 * Ley 9: nada de datos personales acá adentro. Identificadores y montos, que es
 * lo que un consumidor necesita para reaccionar; quien quiera el nombre de la
 * persona lo pide donde vive.
 */
export interface Evento {
  readonly tipo: string
  /** JSON. */
  readonly cuerpo: string
  readonly correlacion_id: string
  readonly creado_en: string
}

/**
 * El estado de la billetera, ANGOSTO a proposito.
 *
 * Antes tenia `asientos: readonly Asiento[]` — el historial entero, en memoria,
 * en cada operacion. Eso obligaba a que el Durable Object cargara todos los
 * asientos para acreditar un guarani, y a reescribirlos todos para guardarlo.
 * Medido sobre la version anterior: 244 bytes por asiento contra un tope de
 * 128 KiB por valor, o sea una billetera inescribible a los ~534 movimientos.
 *
 * En su lugar va `totales`: el acumulado del ledger por tipo de bolsa. Es lo
 * unico que el invariante 2 necesita —«el ledger cuadra con las bolsas»— y se
 * mantiene en O(1). Los asientos ya no vuelven: salen del resultado como DELTA y
 * el que persiste los agrega.
 *
 * Que se pierde con esto, dicho sin vueltas: la comprobacion «ningun asiento_id
 * repetido» ya no puede mirar la historia, porque la historia no esta acá. La
 * hace cumplir la PRIMARY KEY de la tabla `asientos`, que es mas fuerte que un
 * `Set` en memoria — no depende de que alguien se acuerde de llamarla. Lo que
 * queda acá es la comprobacion sobre el delta, que agarra el caso de una
 * operacion que se duplica a si misma.
 */
export interface EstadoBilletera {
  readonly billetera_id: string
  readonly bolsas: readonly Bolsa[]
  /** tipo de bolsa → acumulado de todos los asientos de ese tipo */
  readonly totales: ReadonlyMap<Bolsa['tipo'], number>
  readonly reservas: ReadonlyMap<string, Reserva>
  /** clave de idempotencia → resultado ya producido */
  readonly aplicadas: ReadonlyMap<string, string>
}

export function billeteraVacia(billetera_id: string): EstadoBilletera {
  return {
    billetera_id,
    bolsas: [],
    totales: new Map(),
    reservas: new Map(),
    aplicadas: new Map(),
  }
}

/** Suma los asientos nuevos al acumulado por tipo de bolsa. */
function acumular(
  totales: ReadonlyMap<Bolsa['tipo'], number>,
  asientos: readonly Asiento[],
): ReadonlyMap<Bolsa['tipo'], number> {
  const m = new Map(totales)
  for (const a of asientos) m.set(a.bolsa, (m.get(a.bolsa) ?? 0) + a.monto)
  return m
}

export interface Operacion {
  readonly clave_idem: string
  readonly correlacion_id: string
  readonly momento: string
}

export interface Resultado<T> {
  readonly estado: EstadoBilletera
  /**
   * Los asientos que ESTA operacion produce. No el historial: el delta.
   *
   * Quien persiste los inserta en la misma transaccion que las bolsas y los
   * eventos. Cuando `repetida` es true va vacio, porque una operacion repetida
   * no vuelve a asentar nada — ese es todo el punto de la idempotencia.
   */
  readonly asientos: readonly Asiento[]
  /** Los eventos del outbox de esta operacion. Ley 5: van en la misma transaccion. */
  readonly eventos: readonly Evento[]
  readonly valor: T
  /** true cuando la operacion ya se habia aplicado y se devolvio lo de antes. */
  readonly repetida: boolean
}

/**
 * La clave de idempotencia identifica la INTENCION, no el momento.
 *
 * Este es el defecto que en el sistema anterior bloqueo toda renovacion en
 * silencio: la clave incluia algo que cambiaba entre intentos legitimos. Acá
 * la clave la arma quien llama, y la billetera solo se acuerda de haberla
 * visto. Es responsabilidad del llamador que dos intentos del MISMO acto
 * compartan clave, y que dos actos distintos no la compartan.
 */
function yaAplicada<T>(estado: EstadoBilletera, op: Operacion): Resultado<T> | null {
  const previo = estado.aplicadas.get(op.clave_idem)
  if (previo === undefined) return null
  return { estado, asientos: [], eventos: [], valor: JSON.parse(previo) as T, repetida: true }
}

function marcarAplicada<T>(estado: EstadoBilletera, op: Operacion, valor: T): ReadonlyMap<string, string> {
  const m = new Map(estado.aplicadas)
  m.set(op.clave_idem, JSON.stringify(valor))
  return m
}

/** Arma el evento del outbox de una operacion. Ley 9: sin datos personales. */
function evento(op: Operacion, tipo: string, cuerpo: Record<string, unknown>): Evento {
  return {
    tipo,
    cuerpo: JSON.stringify(cuerpo),
    correlacion_id: op.correlacion_id,
    creado_en: op.momento,
  }
}

function asentar(
  op: Operacion,
  concepto: string,
  monto: Guaranies,
  bolsa: Bolsa['tipo'],
  sufijo: string,
): Asiento {
  return {
    asiento_id: `${op.clave_idem}:${sufijo}`,
    concepto,
    monto,
    bolsa,
    clave_idem: op.clave_idem,
    correlacion_id: op.correlacion_id,
    asentado_en: op.momento,
  }
}

// ---------------------------------------------------------------------------
// Acreditar
// ---------------------------------------------------------------------------

export function acreditar(
  estado: EstadoBilletera,
  op: Operacion,
  entrada: {
    readonly monto: Guaranies
    readonly bolsa: Bolsa['tipo']
    readonly concepto: string
    readonly origen: string
    readonly vence_en?: string | null
    readonly restringida_a?: string | null
  },
): Resultado<{ saldo_retirable: Guaranies }> {
  const previo = yaAplicada<{ saldo_retirable: Guaranies }>(estado, op)
  if (previo !== null) return previo

  if (entrada.monto <= 0) throw new Error('acreditar exige un monto positivo')

  // Ley 11: el credito de promocion nace con vencimiento. Sin el, seria plata
  // regalada eterna, y eterna se parece demasiado a retirable.
  if (entrada.bolsa === 'credito_promocion' && (entrada.vence_en ?? null) === null) {
    throw new Error('el credito de promocion no existe sin vencimiento')
  }

  // A retenido solo se entra por reservar(), que mueve plata que ya paso por
  // esta misma validacion en su bolsa de origen. Sin esta guarda, el unico
  // freno era el invariante 4 notando el descuadre despues de persistir — una
  // guarda reactiva, no una regla declarada como la de credito_promocion.
  if (entrada.bolsa === 'retenido') {
    throw new Error('retenido no se acredita directo: solo reservar() mueve plata ahi')
  }

  const nueva: Bolsa = {
    tipo: entrada.bolsa,
    monto: entrada.monto,
    vence_en: entrada.vence_en ?? null,
    origen: entrada.origen,
    restringida_a: entrada.restringida_a ?? null,
  }

  const bolsas = [...estado.bolsas, nueva]
  const asientos = [asentar(op, entrada.concepto, entrada.monto, entrada.bolsa, 'cr')]
  const valor = { saldo_retirable: saldoRetirable(bolsas, op.momento) }

  return {
    estado: {
      ...estado,
      bolsas,
      totales: acumular(estado.totales, asientos),
      aplicadas: marcarAplicada(estado, op, valor),
    },
    asientos,
    eventos: [
      evento(op, 'billetera.acreditada', {
        billetera_id: estado.billetera_id,
        monto: entrada.monto,
        bolsa: entrada.bolsa,
        concepto: entrada.concepto,
        clave_idem: op.clave_idem,
      }),
    ],
    valor,
    repetida: false,
  }
}

// ---------------------------------------------------------------------------
// Debitar
// ---------------------------------------------------------------------------

export class SaldoInsuficiente extends Error {
  constructor(readonly faltante: Guaranies) {
    super(`saldo insuficiente: faltan ${faltante}`)
    this.name = 'SaldoInsuficiente'
  }
}

/** Resta de las bolsas las tomas indicadas, dejando el resto intacto. */
function aplicarTomas(bolsas: readonly Bolsa[], tomas: readonly Toma[]): Bolsa[] {
  const pendiente = new Map<Bolsa, number>()
  for (const t of tomas) pendiente.set(t.bolsa, (pendiente.get(t.bolsa) ?? 0) + t.monto)

  const salida: Bolsa[] = []
  for (const b of bolsas) {
    const quita = pendiente.get(b) ?? 0
    const queda = b.monto - quita
    if (queda > 0) salida.push({ ...b, monto: guaranies(queda) })
  }
  return salida
}

export function debitar(
  estado: EstadoBilletera,
  op: Operacion,
  entrada: {
    readonly monto: Guaranies
    readonly concepto: string
    readonly proposito?: string
    readonly omitirDisponible?: boolean
  },
): Resultado<{ tomas: readonly Toma[]; faltante: Guaranies }> {
  const previo = yaAplicada<{ tomas: readonly Toma[]; faltante: Guaranies }>(estado, op)
  if (previo !== null) return previo

  if (entrada.monto <= 0) throw new Error('debitar exige un monto positivo')

  const consumo = decidirConsumo(estado.bolsas, entrada.monto, op.momento, {
    ...(entrada.omitirDisponible === undefined ? {} : { omitirDisponible: entrada.omitirDisponible }),
    ...(entrada.proposito === undefined ? {} : { proposito: entrada.proposito }),
  })

  if (consumo.faltante > 0) throw new SaldoInsuficiente(consumo.faltante)

  const bolsas = aplicarTomas(estado.bolsas, consumo.tomas)
  const asientos: Asiento[] = []
  consumo.tomas.forEach((t, i) => {
    asientos.push(asentar(op, entrada.concepto, guaranies(-t.monto), t.bolsa.tipo, `db${i}`))
  })

  const valor = { tomas: consumo.tomas, faltante: CERO }
  return {
    estado: {
      ...estado,
      bolsas,
      totales: acumular(estado.totales, asientos),
      aplicadas: marcarAplicada(estado, op, valor),
    },
    asientos,
    eventos: [
      evento(op, 'billetera.debitada', {
        billetera_id: estado.billetera_id,
        monto: entrada.monto,
        concepto: entrada.concepto,
        clave_idem: op.clave_idem,
      }),
    ],
    valor,
    repetida: false,
  }
}

// ---------------------------------------------------------------------------
// Reservar / consumir / liberar
// ---------------------------------------------------------------------------

export function reservar(
  estado: EstadoBilletera,
  op: Operacion,
  entrada: { readonly reserva_id: string; readonly monto: Guaranies; readonly vence_en: string },
): Resultado<{ reserva_id: string }> {
  const previo = yaAplicada<{ reserva_id: string }>(estado, op)
  if (previo !== null) return previo

  // Dos reservas legitimas con el mismo reserva_id (dos claves de idempotencia
  // distintas, no un reintento) pisarian la entrada anterior en el Map: la
  // plata de la primera saldria de su bolsa y quedaria sin ningun rastro que
  // la reclame. Es un error del llamador — reusar un identificador que
  // todavia esta abierto — no un caso que reservar() deba absorber.
  if (estado.reservas.get(entrada.reserva_id)?.estado === 'abierta') {
    throw new Error(`ya existe una reserva abierta con reserva_id: ${entrada.reserva_id}`)
  }

  const consumo = decidirConsumo(estado.bolsas, entrada.monto, op.momento, {})
  if (consumo.faltante > 0) throw new SaldoInsuficiente(consumo.faltante)

  // La reserva mueve plata de la bolsa de origen a RETENIDO — no la debita
  // contra la nada. Sigue viva en una bolsa, visible para `verificarInvariantes`,
  // y la unica salida es `liberarReserva()`. Cada toma conserva su vencimiento
  // y restriccion originales para poder devolverse tal cual (ley 11); el tipo
  // original de cada toma queda en `reserva.tomas`, no en la bolsa retenida.
  const bolsasSinTomas = aplicarTomas(estado.bolsas, consumo.tomas)
  const retenidas: Bolsa[] = consumo.tomas.map((t) => ({
    tipo: 'retenido',
    monto: t.monto,
    vence_en: t.bolsa.vence_en,
    origen: entrada.reserva_id,
    restringida_a: t.bolsa.restringida_a,
  }))
  const bolsas = [...bolsasSinTomas, ...retenidas]

  const asientos: Asiento[] = []
  consumo.tomas.forEach((t, i) => {
    asientos.push(asentar(op, 'reserva_promocion', guaranies(-t.monto), t.bolsa.tipo, `rsv${i}db`))
    asientos.push(asentar(op, 'reserva_promocion', t.monto, 'retenido', `rsv${i}cr`))
  })

  const reservas = new Map(estado.reservas)
  reservas.set(entrada.reserva_id, {
    reserva_id: entrada.reserva_id,
    tomas: consumo.tomas,
    consumido: CERO,
    vence_en: entrada.vence_en,
    estado: 'abierta',
  })

  const valor = { reserva_id: entrada.reserva_id }
  return {
    estado: {
      ...estado,
      bolsas,
      totales: acumular(estado.totales, asientos),
      reservas,
      aplicadas: marcarAplicada(estado, op, valor),
    },
    asientos,
    eventos: [
      evento(op, 'billetera.reservada', {
        billetera_id: estado.billetera_id,
        reserva_id: entrada.reserva_id,
        monto: entrada.monto,
        vence_en: entrada.vence_en,
        clave_idem: op.clave_idem,
      }),
    ],
    valor,
    repetida: false,
  }
}

/**
 * Gasta parte —o todo— de lo que una reserva tiene retenido.
 *
 * Es lo que pasa cuando la campaña efectivamente entrega el premio: esa plata sale
 * de la billetera. No vuelve a ninguna bolsa, se va.
 *
 * QUE ORDEN SE CONSUME, y por que importa
 *
 * Se consume desde la PRIMERA toma hacia adelante, o sea en el mismo orden en que
 * `decidirConsumo` las eligio: primero el credito de promocion, primero el que
 * vence antes. Y `devolver()` entrega el remanente en orden INVERSO, desde la
 * ultima toma hacia atras.
 *
 * Los dos ordenes son el mismo criterio visto de los dos lados: lo que vence antes
 * se gasta y lo que vence despues vuelve. Al usuario no se le devuelve un credito
 * a punto de morir.
 */
export function consumirReserva(
  estado: EstadoBilletera,
  op: Operacion,
  entrada: { readonly reserva_id: string; readonly monto: Guaranies },
): Resultado<{ consumido: Guaranies; disponible: Guaranies }> {
  const previo = yaAplicada<{ consumido: Guaranies; disponible: Guaranies }>(estado, op)
  if (previo !== null) return previo

  if (entrada.monto <= 0) throw new Error('consumirReserva exige un monto positivo')

  const r = estado.reservas.get(entrada.reserva_id)
  if (r === undefined) throw new Error(`reserva desconocida: ${entrada.reserva_id}`)
  if (r.estado !== 'abierta') {
    throw new Error(`la reserva ${entrada.reserva_id} no esta abierta: ${r.estado}`)
  }

  // LA COTA. Sin ella el remanente que vuelve al usuario sale negativo, y una
  // bolsa en negativo es plata inventada. La base tambien la hace cumplir; acá
  // falla antes de escribir y con un mensaje que dice cuanto quedaba.
  const total = r.tomas.reduce((a, t) => a + t.monto, 0)
  const disponible = total - r.consumido
  if (entrada.monto > disponible) {
    throw new Error(
      `no se puede consumir ${entrada.monto} de la reserva ${entrada.reserva_id}: quedan ${disponible}`,
    )
  }

  // Sale de `retenido`, tomando de las bolsas de ESTA reserva y en el orden en que
  // se retuvieron. `aplicarTomas` no sirve acá porque compara por identidad de
  // objeto, y estas bolsas se cargaron de la base.
  const retenidasDeLaReserva = estado.bolsas.filter(
    (b) => b.tipo === 'retenido' && b.origen === entrada.reserva_id,
  )
  const resto = estado.bolsas.filter(
    (b) => !(b.tipo === 'retenido' && b.origen === entrada.reserva_id),
  )

  let porConsumir: number = entrada.monto
  const quedan: Bolsa[] = []
  for (const b of retenidasDeLaReserva) {
    if (porConsumir <= 0) {
      quedan.push(b)
      continue
    }
    const saca = Math.min(porConsumir, b.monto)
    porConsumir -= saca
    if (b.monto - saca > 0) quedan.push({ ...b, monto: guaranies(b.monto - saca) })
  }

  const bolsas = [...resto, ...quedan]
  const asientos = [
    asentar(op, 'consumo_promocion', guaranies(-entrada.monto), 'retenido', 'cns'),
  ]

  const reservas = new Map(estado.reservas)
  reservas.set(r.reserva_id, { ...r, consumido: guaranies(r.consumido + entrada.monto) })

  const valor = {
    consumido: guaranies(r.consumido + entrada.monto),
    disponible: guaranies(disponible - entrada.monto),
  }

  return {
    estado: {
      ...estado,
      bolsas,
      totales: acumular(estado.totales, asientos),
      reservas,
      aplicadas: marcarAplicada(estado, op, valor),
    },
    asientos,
    eventos: [
      evento(op, 'billetera.reserva_consumida', {
        billetera_id: estado.billetera_id,
        reserva_id: r.reserva_id,
        monto: entrada.monto,
        consumido: valor.consumido,
        clave_idem: op.clave_idem,
      }),
    ],
    valor,
    repetida: false,
  }
}

/**
 * Cancela una reserva y devuelve el remanente A LA BOLSA DE LA QUE SALIO.
 * Esta es la regla anticajero hecha codigo.
 */
export function liberarReserva(
  estado: EstadoBilletera,
  op: Operacion,
  entrada: { readonly reserva_id: string },
): Resultado<{ devuelto: Guaranies }> {
  const previo = yaAplicada<{ devuelto: Guaranies }>(estado, op)
  if (previo !== null) return previo

  const r = estado.reservas.get(entrada.reserva_id)
  if (r === undefined) throw new Error(`reserva desconocida: ${entrada.reserva_id}`)
  if (r.estado !== 'abierta') {
    const valor = { devuelto: CERO }
    return { estado, asientos: [], eventos: [], valor, repetida: true }
  }

  const total = r.tomas.reduce((a, t) => a + t.monto, 0)
  const remanente = guaranies(total - r.consumido)
  const vueltas = devolver(r.tomas, remanente)

  // Saca de RETENIDO exactamente lo que esta reserva puso ahi: `reservar()`
  // marco cada bolsa retenida con el reserva_id en su `origen`. Como el
  // consumo parcial no existe todavia (fuera de alcance), `remanente` es
  // siempre el total y esto vacia el retenido de esta reserva por completo.
  const bolsasSinRetenido = estado.bolsas.filter(
    (b) => !(b.tipo === 'retenido' && b.origen === r.reserva_id),
  )
  const bolsas = [...bolsasSinRetenido, ...vueltas]

  const asientos: Asiento[] = []
  if (remanente > 0) {
    asientos.push(asentar(op, 'promotion_refund', guaranies(-remanente), 'retenido', 'rf-ret'))
  }
  vueltas.forEach((b, i) => {
    asientos.push(asentar(op, 'promotion_refund', b.monto, b.tipo, `rf${i}`))
  })

  const reservas = new Map(estado.reservas)
  reservas.set(r.reserva_id, { ...r, estado: 'cancelada' })

  const valor = { devuelto: remanente }
  return {
    estado: {
      ...estado,
      bolsas,
      totales: acumular(estado.totales, asientos),
      reservas,
      aplicadas: marcarAplicada(estado, op, valor),
    },
    asientos,
    eventos: [
      evento(op, 'billetera.reserva_liberada', {
        billetera_id: estado.billetera_id,
        reserva_id: r.reserva_id,
        devuelto: remanente,
        clave_idem: op.clave_idem,
      }),
    ],
    valor,
    repetida: false,
  }
}

// ---------------------------------------------------------------------------
// Invariantes — lo que tiene que ser cierto SIEMPRE
// ---------------------------------------------------------------------------

/**
 * Estas comprobaciones no son pruebas: son el oraculo que las pruebas usan.
 * Se corren despues de cada paso del spike, incluida cada caida y cada
 * reintento. Si alguna se rompe, el spike fallo aunque el resultado final
 * "parezca" correcto.
 */
export function verificarInvariantes(estado: EstadoBilletera): void {
  // 1. Ninguna bolsa en negativo. El saldo negativo es plata inventada.
  for (const b of estado.bolsas) {
    if (b.monto < 0) throw new Error(`bolsa en negativo: ${b.tipo} ${b.monto}`)
  }

  // 2. El ledger cuadra con las bolsas. Esta es LA comprobacion: si los
  //    asientos y los saldos se separan, el sistema esta mintiendo.
  //
  //    Compara contra `totales`, el acumulado que cada operacion actualiza a
  //    partir de los asientos que produce. Antes sumaba el historial entero en
  //    memoria; el resultado es el mismo y el costo pasa de O(n) a O(1).
  //
  //    Lo que esto SI agarra: una operacion que escribe bolsas sin los asientos
  //    que le corresponden, o al reves — que es la forma que toma un pago doble
  //    mal absorbido. Lo que NO agarra: que `totales` se corrompa por su cuenta,
  //    porque ahi el acumulado y las bolsas podrian mentir igual. Para eso esta
  //    la reconciliacion contra la suma exhaustiva de la tabla `asientos`, que
  //    corre fuera del camino caliente.
  const porBolsa = estado.totales

  const enBolsas = new Map<string, number>()
  for (const b of estado.bolsas) enBolsas.set(b.tipo, (enBolsas.get(b.tipo) ?? 0) + b.monto)

  for (const [tipo, delLedger] of porBolsa) {
    const enBolsa = enBolsas.get(tipo) ?? 0
    if (delLedger !== enBolsa) {
      throw new Error(`descuadre en ${tipo}: ledger ${delLedger} vs bolsas ${enBolsa}`)
    }
  }

  // 3. RETENIDO tiene que sumar exactamente lo que las reservas abiertas todavia
  //    tienen sin gastar. `reservar()` mueve plata a esta bolsa en vez de
  //    debitarla contra la nada (ver bolsas.ts); si una reserva pisara a otra
  //    en el Map, o si algo tocara `retenido` por fuera de reservar/consumir/
  //    liberar, esta comparacion es la unica que lo nota — la del punto 2 no
  //    alcanza, porque compara el ledger contra si mismo y los dos pueden mentir
  //    igual.
  //
  //    Es `total(tomas) - consumido` y no `total(tomas)` a secas. Antes era lo
  //    segundo, y era correcto SOLO porque el consumo parcial no existia: nada
  //    incrementaba `consumido`, asi que siempre valia cero. En cuanto
  //    `consumirReserva()` empezo a moverlo, esa version pasaba a acusar de
  //    descuadre a toda reserva consumida a medias.
  const retenidoEnBolsas = enBolsas.get('retenido') ?? 0
  const retenidoEnReservas = [...estado.reservas.values()]
    .filter((r) => r.estado === 'abierta')
    .reduce((total, r) => total + r.tomas.reduce((s, t) => s + t.monto, 0) - r.consumido, 0)
  if (retenidoEnBolsas !== retenidoEnReservas) {
    throw new Error(
      `descuadre en retenido: bolsas ${retenidoEnBolsas} vs reservas abiertas ${retenidoEnReservas}`,
    )
  }
}

/**
 * Ningun asiento_id repetido DENTRO de una operacion.
 *
 * Antes esta comprobacion recorria el historial completo, y dejo de poder
 * hacerlo cuando el estado se angosto: los asientos ya no vuelven, salen como
 * delta. No se perdio la garantia, cambio de lugar y se hizo mas fuerte:
 *
 *   · Entre operaciones, la PRIMARY KEY de la tabla `asientos` lo hace
 *     imposible. Una restriccion de la base no depende de que alguien se
 *     acuerde de llamar a una funcion.
 *   · Adentro de una operacion, esta funcion. Es el caso que la base tambien
 *     agarraria, pero acá falla ANTES de escribir y con un mensaje que dice cual
 *     es el asiento repetido, en vez de un error de restriccion.
 *
 * Un asiento_id duplicado es un pago doble: por eso vale tenerlo dos veces.
 */
export function verificarDelta(asientos: readonly Asiento[]): void {
  const vistos = new Set<string>()
  for (const a of asientos) {
    if (vistos.has(a.asiento_id)) throw new Error(`asiento duplicado: ${a.asiento_id}`)
    vistos.add(a.asiento_id)
  }
}

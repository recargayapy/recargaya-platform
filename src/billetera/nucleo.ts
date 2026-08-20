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
import { instante, instanteOpcional } from '../dinero/momento.js'
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
 * La puerta de entrada de TODA operacion. Hace dos cosas y las dos tienen que
 * pasar antes que cualquier otra: revisa la operacion, y contesta si ya se aplico.
 *
 * LA CLAVE DE IDEMPOTENCIA IDENTIFICA LA INTENCION, NO EL MOMENTO.
 *
 * Este es el defecto que en el sistema anterior bloqueo toda renovacion en
 * silencio: la clave incluia algo que cambiaba entre intentos legitimos. Acá la
 * clave la arma quien llama, y la billetera solo se acuerda de haberla visto. Es
 * responsabilidad del llamador que dos intentos del MISMO acto compartan clave, y
 * que dos actos distintos no la compartan.
 *
 * Que la revision del instante viva ACA y no en cada funcion es a proposito. Las
 * cinco operaciones llaman a esto como primera linea, asi que es el unico lugar
 * por el que pasan todas — y una revision repetida en cinco lugares es una
 * revision que la sexta operacion se va a olvidar de copiar.
 *
 * Revisa incluso cuando la operacion resulta repetida: un `momento` mal escrito
 * es un error del llamador aunque esta vez no se escriba nada.
 */
/**
 * Las cinco operaciones que mueven plata, nombradas.
 *
 * El nombre no es decorativo: forma parte de la CLAVE de idempotencia. Ver
 * `claveAplicada`.
 */
export type NombreDeOperacion = 'acreditar' | 'debitar' | 'reservar' | 'consumir' | 'liberar'

/**
 * LA CLAVE CON LA QUE LA BILLETERA SE ACUERDA DE UNA OPERACION.
 *
 * ---------------------------------------------------------------------------
 * EL DEFECTO QUE ESTO CIERRA, medido por las dos vueltas de auditoria de la 1.3
 *
 * Hasta la 1.3 la clave era el `clave_idem` PELADO, o sea que las cinco
 * operaciones compartian un solo espacio de nombres. Y el `clave_idem` lo elige
 * el llamador, con un alfabeto que acepta `:` y `-`.
 *
 * La 1.3 agrego claves DERIVADAS —`pedido:<id>:reserva` y `pedido:<id>:liberacion`,
 * ver `pedidos/pedidos.ts`— y el numero de pedido es correlativo, o sea predecible.
 * Con un solo espacio de nombres, eso se envenena de las dos direcciones, y las dos
 * se midieron de punta a punta sobre workerd:
 *
 *   · Alguien acredita 1 Gs. con `clave_idem = "pedido:RY-2026-000002:reserva"`.
 *     El pedido siguiente «reserva» por la puerta de idempotencia: contesta 201,
 *     `estado: reservado`, y NO retiene un guarani. El comprador se gasta la plata
 *     que el pedido dice tener. Medido: 50.000 Gs.
 *   · Al reves: despues de que un pedido reservo, una acreditacion de 500.000 Gs.
 *     con esa misma clave sale 200 con `repetida: true` y NO entra al ledger.
 *     Medido: la respuesta ni siquiera trae `saldo_retirable`, porque el valor
 *     guardado era el de `reservar` (`{reserva_id}`).
 *
 * No hace falta un atacante: el propio comentario de `CLAVE_IDEM_VALIDA` sugiere
 * claves de la forma `carga:<pedido>:<paso>`, y las pruebas de esta entrega mandan
 * `pedido:ped-1:1`. Alcanza con un integrador ordenado.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EL NOMBRE DE LA OPERACION Y NO UN PREFIJO EN LA PUERTA
 *
 * Se podia prefijar en `api/rutas.ts` lo que trae el llamador (`ext:<clave>`) y
 * listo. Eso cierra el caso y deja la categoria abierta: `acreditar` y `debitar`
 * seguirian compartiendo espacio, y la sexta operacion tambien.
 *
 * La idempotencia identifica LA INTENCION —lo dice el encabezado de
 * `puertaDeEntrada` desde la Fase 0— y «acreditar 500.000» y «reservar para el
 * pedido X» son dos intenciones distintas. El nombre de la operacion es parte de
 * la intencion, asi que es parte de la clave. Entra por parametro obligatorio para
 * que la sexta operacion no se lo pueda olvidar.
 *
 * El separador es `\u0001`, que `CLAVE_IDEM_VALIDA` no acepta: asi ninguna clave
 * de afuera puede fabricar el prefijo de otra operacion.
 *
 * ---------------------------------------------------------------------------
 * QUE PASA CON LO YA ESCRITO, dicho
 *
 * Las filas de `aplicadas` que existan en billeteras ya desplegadas quedan con la
 * clave vieja y dejan de encontrarse. O sea: una operacion cortada JUSTO durante el
 * despliegue, reintentada despues, se aplica de nuevo. `core-produccion` esta vacia
 * y `core-staging` no tiene plata real, asi que hoy la ventana es teorica — pero es
 * la clase de cosa que hay que decir antes y no despues.
 *
 * `asiento_id` NO cambia: lo sigue armando `asentar()` con `op.clave_idem` pelado,
 * asi que las claves primarias de `ledger_copia` quedan donde estaban.
 */
export function claveAplicada(operacion: NombreDeOperacion, clave_idem: string): string {
  return `${operacion}\u0001${clave_idem}`
}

function puertaDeEntrada<T>(
  estado: EstadoBilletera,
  op: Operacion,
  operacion: NombreDeOperacion,
): Resultado<T> | null {
  // El instante ordena plata: `decidirConsumo` compara `vence_en <= momento` como
  // TEXTO. Con un huso distinto de `Z`, ese `<=` deja de coincidir con el reloj y
  // una bolsa vencida se consume, o una vigente se descarta. Ver `dinero/momento.ts`.
  instante(op.momento)

  const previo = estado.aplicadas.get(claveAplicada(operacion, op.clave_idem))
  if (previo === undefined) return null
  return { estado, asientos: [], eventos: [], valor: JSON.parse(previo) as T, repetida: true }
}

function marcarAplicada<T>(
  estado: EstadoBilletera,
  op: Operacion,
  valor: T,
  operacion: NombreDeOperacion,
): ReadonlyMap<string, string> {
  const m = new Map(estado.aplicadas)
  m.set(claveAplicada(operacion, op.clave_idem), JSON.stringify(valor))
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
  const previo = puertaDeEntrada<{ saldo_retirable: Guaranies }>(estado, op, 'acreditar')
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
    // Uno de los dos unicos lugares por los que un vencimiento entra desde afuera
    // (el otro es `reservar`). De acá para adentro todo `vence_en` sale de una
    // bolsa que ya paso por esta linea, o de la base, donde entro por esta linea.
    vence_en: instanteOpcional(entrada.vence_en),
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
      aplicadas: marcarAplicada(estado, op, valor, 'acreditar'),
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

/**
 * El texto con el que empieza el mensaje, exportado. NO es cosmetica.
 *
 * Un llamador que esta del otro lado de una frontera de Durable Object no recibe la
 * clase: el RPC de workerd serializa el error, asi que `instanceof SaldoInsuficiente`
 * es siempre falso ahi. Lo unico que cruza es el texto, y `pedidos/pedidos.ts` lo
 * necesita para distinguir «no hay plata» —que es un 409 con explicacion, y ademas
 * cancela el pedido— de «se rompio algo» —que es un 500.
 *
 * Con la constante exportada, el que compara y el que escribe salen del mismo lugar.
 * Sin ella serian dos literales en dos archivos, y el dia que alguien reescriba este
 * mensaje «para que se entienda mejor», un pedido sin saldo pasa a salir como fallo
 * interno y a quedar colgado en `creado`.
 */
export const SALDO_INSUFICIENTE = 'saldo insuficiente'

/**
 * Los textos que cruzan la frontera del Durable Object, exportados.
 *
 * Mismo motivo que `SALDO_INSUFICIENTE`: el RPC de workerd serializa el error, asi
 * que del otro lado `instanceof` es siempre falso y lo unico que llega es el
 * mensaje. Quien tenga que distinguir estos casos —`pedidos/pedidos.ts`— compara
 * contra estas constantes, no contra un literal propio.
 */
export const RESERVA_DESCONOCIDA = 'reserva desconocida'
export const RESERVA_YA_NO_ESTA_ABIERTA = 'la reserva ya no esta abierta'
export const RESERVA_NACE_VENCIDA = 'la reserva naceria vencida'

export class ReservaYaNoEstaAbierta extends Error {
  constructor(
    readonly reserva_id: string,
    readonly estadoDeLaReserva: string,
  ) {
    super(`${RESERVA_YA_NO_ESTA_ABIERTA}: ${reserva_id} quedo ${estadoDeLaReserva}`)
    this.name = 'ReservaYaNoEstaAbierta'
  }
}

export class ReservaNaceVencida extends Error {
  constructor(
    readonly reserva_id: string,
    readonly vence_en: string,
    readonly momento: string,
  ) {
    super(`${RESERVA_NACE_VENCIDA}: ${reserva_id} vence ${vence_en} y ya son las ${momento}`)
    this.name = 'ReservaNaceVencida'
  }
}

export class SaldoInsuficiente extends Error {
  constructor(readonly faltante: Guaranies) {
    super(`${SALDO_INSUFICIENTE}: faltan ${faltante}`)
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
  const previo = puertaDeEntrada<{ tomas: readonly Toma[]; faltante: Guaranies }>(estado, op, 'debitar')
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
      aplicadas: marcarAplicada(estado, op, valor, 'debitar'),
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
  const previo = puertaDeEntrada<{ reserva_id: string }>(estado, op, 'reservar')
  if (previo !== null) {
    // LA PUERTA DICE «ESTO YA SE APLICO». NO DICE «LA RESERVA SIGUE VIVA», y la
    // diferencia es plata. Lo midio la primera vuelta de auditoria de la 1.3:
    //
    // el Worker muere despues de que la billetera confirmo la reserva y antes de que
    // D1 anote `reservado`. Pasan treinta minutos, la alarma libera la reserva
    // vencida y devuelve la plata. Recien ahi llega el reintento del llamador con la
    // misma clave: la puerta contesta `repetida: true`, el orquestador anota
    // `reservado` en D1, y queda un pedido que dice retener 30.000 Gs. sobre una
    // billetera que no retiene nada. El dia que ese pedido se cobre,
    // `consumirReserva` va a contestar «la reserva no esta abierta» con la
    // mercaderia ya entregada.
    //
    // `cargarReservas` trae SIEMPRE la reserva nombrada, aunque este cerrada,
    // justamente para que esta linea pueda verla.
    const viva = estado.reservas.get(entrada.reserva_id)
    if (viva === undefined || viva.estado !== 'abierta') {
      throw new ReservaYaNoEstaAbierta(entrada.reserva_id, viva?.estado ?? 'inexistente')
    }
    return previo
  }

  // UN reserva_id se usa UNA vez. No «una vez a la vez»: una vez y nunca mas.
  //
  // La version anterior rechazaba solo si la reserva estaba ABIERTA, y una
  // auditoria adversarial la volteo midiendo tres daños distintos del mismo
  // reuso, todos sobre workerd:
  //
  //   · Las tomas quedan viejas. `tomas` tiene PK `(reserva_id, orden)` y se
  //     escribe con `INSERT OR IGNORE` —porque describen de que bolsa salio cada
  //     parte y eso no cambia nunca—. Con el id reusado, las tomas de la reserva
  //     NUEVA se descartan en silencio y quedan las de la vieja. Medido: retenido
  //     50.000 en bolsas contra 20.000 en reservas, y a partir de ahi TODA
  //     operacion sobre esa billetera tira por el invariante 3, incluida
  //     `liberarReserva`. La plata queda adentro sin camino de salida.
  //   · El vencimiento queda viejo. El upsert de `reservas` no toca `vence_en`.
  //   · La alarma entra en bucle. La clave del vencimiento es
  //     `vencimiento:<reserva_id>`, derivada del id: la segunda expiracion sale
  //     por `aplicadas` como repetida y no libera nada, mientras
  //     `reprogramarAlarma` sigue viendo algo vencido y vuelve a poner la alarma
  //     para ahora.
  //
  // Se podria arreglar cada uno de los tres. Se arregla la categoria: el
  // reserva_id ES la identidad del ciclo de vida, y `cargarReservas` carga
  // siempre la reserva nombrada aunque este cerrada justamente para que esta
  // linea pueda verla. Un llamador que necesite reservar de nuevo usa un id
  // nuevo — que es lo que tiene que hacer, porque es otra reserva.
  // El otro lugar por el que entra un vencimiento de afuera — y desde la 1.3 con el
  // MISMO guarda que la otra puerta, no solo con la comprobacion de forma.
  //
  // `acreditar` tiene desde la 1.2 el rechazo `vence_en_ya_vencido`, agregado por una
  // auditoria con este argumento: plata que entra al ledger, cuenta en los totales,
  // pasa los invariantes, y es inconsumible para siempre. `reservar` era la otra
  // puerta por la que entra un vencimiento y no lo tenia — dos de dos, una arreglada,
  // que es la forma mas facil de creer que se arreglo la categoria.
  //
  // Medido en la 1.3: con un `vence_en` en el pasado, `reservar()` contestaba bien y
  // la alarma devolvia la plata en milisegundos. El llamador recibia 200 con
  // `estado: reservado` sobre una reserva que ya no existia.
  instante(entrada.vence_en)
  if (entrada.vence_en <= op.momento) {
    throw new ReservaNaceVencida(entrada.reserva_id, entrada.vence_en, op.momento)
  }

  if (estado.reservas.has(entrada.reserva_id)) {
    const previa = estado.reservas.get(entrada.reserva_id)
    throw new Error(
      `el reserva_id ${entrada.reserva_id} ya se uso (quedo ${previa?.estado}): un reserva_id no se reusa`,
    )
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
      aplicadas: marcarAplicada(estado, op, valor, 'reservar'),
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
  const previo = puertaDeEntrada<{ consumido: Guaranies; disponible: Guaranies }>(estado, op, 'consumir')
  if (previo !== null) return previo

  if (entrada.monto <= 0) throw new Error('consumirReserva exige un monto positivo')

  const r = estado.reservas.get(entrada.reserva_id)
  // El texto sale de una constante exportada porque lo compara `pedidos/pedidos.ts`
  // del otro lado de la frontera del Durable Object, donde `instanceof` no vale.
  if (r === undefined) throw new Error(`${RESERVA_DESCONOCIDA}: ${entrada.reserva_id}`)
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
      aplicadas: marcarAplicada(estado, op, valor, 'consumir'),
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
  const previo = puertaDeEntrada<{ devuelto: Guaranies }>(estado, op, 'liberar')
  if (previo !== null) return previo

  const r = estado.reservas.get(entrada.reserva_id)
  // La constante, y no el literal. Es el UNICO texto de error que alguien compara del
  // otro lado de la frontera del Durable Object (`cancelarPedido` lo tolera para poder
  // pedir «solta lo que haya» a ciegas), y la primera version lo tenia escrito a mano
  // acá mientras `consumirReserva` —a la que nadie compara— usaba la constante. Dos de
  // dos, la que no importaba arreglada: lo midio la segunda vuelta.
  //
  // Si este texto y el de `pedidos.ts` divergen, cancelar cualquier pedido que nunca
  // reservo pasa a ser un 500, y como `cancelarPedido` es el unico camino del
  // conciliador, el barrido de vencidos se cae entero.
  if (r === undefined) throw new Error(`${RESERVA_DESCONOCIDA}: ${entrada.reserva_id}`)
  if (r.estado !== 'abierta') {
    const valor = { devuelto: CERO }
    return { estado, asientos: [], eventos: [], valor, repetida: true }
  }

  const total = r.tomas.reduce((a, t) => a + t.monto, 0)
  const remanente = guaranies(total - r.consumido)
  const vueltas = devolver(r.tomas, remanente)

  // Saca de RETENIDO exactamente lo que esta reserva puso ahi: `reservar()`
  // marco cada bolsa retenida con el reserva_id en su `origen`. Se vacia ENTERO
  // —no solo el remanente— porque lo que ya se consumio salio de la billetera al
  // consumirse, no acá.
  //
  // (El comentario anterior decia «como el consumo parcial no existe todavia,
  // `remanente` es siempre el total». Lo escribio la entrega que lo agrego, dos
  // funciones mas arriba. Un comentario que promete lo que el codigo no hace es
  // la causa raiz declarada del proyecto, y este invitaba a simplificar la resta
  // de `r.consumido` que es justamente la que hace falta.)
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
      aplicadas: marcarAplicada(estado, op, valor, 'liberar'),
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
  //    Se recorre la UNION de los dos lados y no solo los tipos que tienen fila
  //    en `totales`. La version anterior iteraba `estado.totales`, y una auditoria
  //    adversarial la volteo con el caso mas simple posible: una bolsa de un tipo
  //    que NUNCA tuvo un asiento es invisible para ese bucle. Medido — con
  //    `totales = {disponible: 0}` y una bolsa de `ganancia_creador` por 999.999,
  //    esta funcion no decia nada. O sea que el caso que el parrafo de arriba
  //    promete agarrar —bolsas escritas sin sus asientos— quedaba cubierto solo
  //    cuando el tipo ya venia con historia.
  //
  //    El patron correcto ya estaba escrito en la funcion de al lado:
  //    `reconciliar()` recorre `new Set([...sumado.keys(), ...cache.keys()])`.
  //    Un lugar arreglado y el otro no es como se pierde una categoria.
  const enBolsas = new Map<string, number>()
  for (const b of estado.bolsas) enBolsas.set(b.tipo, (enBolsas.get(b.tipo) ?? 0) + b.monto)

  for (const tipo of new Set([...estado.totales.keys(), ...enBolsas.keys()])) {
    const delLedger = estado.totales.get(tipo as Bolsa['tipo']) ?? 0
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

/**
 * El primer endpoint. La puerta.
 *
 * ---------------------------------------------------------------------------
 * POR QUE HTTP EN ESTE WORKER, Y NO UN SERVICE BINDING
 *
 * El plan maestro dice que los servicios se hablan por Service Bindings con RPC,
 * no por HTTP interno. Sigue valiendo. Lo que hoy no existe es el segundo
 * servicio: hay UN Worker. Un Service Binding de un Worker a si mismo no comunica
 * nada; construirlo pediria crear el Worker `edge` ahora, y eso es alcance nuevo
 * en una entrega abierta — la misma regla que hizo que la 1.1 llegara a 125/125
 * en vez de a la mitad de cinco cosas.
 *
 * Lo que si se hace es dejarlo listo: la decision de cada ruta vive en funciones
 * de este archivo que reciben datos y devuelven datos. `fetch` es una cascara que
 * traduce Request → argumentos y resultado → Response. El dia que aparezca el
 * `edge`, esas funciones se llaman por RPC y este archivo pierde la cascara. Es
 * recableado, no reescritura.
 *
 * ---------------------------------------------------------------------------
 * EL `correlacion_id` ATRAVIESA TODO, DESDE ACA
 *
 * Nace en esta funcion —o lo trae el llamador— y baja sin cambiar a la bitacora,
 * a la operacion de la billetera, al asiento del ledger y al evento del outbox.
 * Es lo que permite preguntar "¿que paso con esta llamada?" y recibir las cinco
 * filas que la componen, en cinco tablas distintas.
 *
 * Nace acá y no mas adentro a proposito: si lo generara el Durable Object, dos
 * llamadas de la misma peticion tendrian correlaciones distintas y no habria como
 * saber que fueron la misma cosa.
 */

import {
  type Capacidad,
  type Persona,
  capacidadesVigentes,
  esCapacidad,
  puede,
} from '../identidad/capacidades.js'
import {
  type Actor,
  LARGO_MINIMO_DEL_SECRETO,
  RESERVADOS,
  TokenInvalido,
  actorDeLaPeticion,
  actorId,
} from '../identidad/actor.js'
import {
  CapacidadYaVigente,
  PersonaNoExiste,
  PersonaYaExiste,
  VentanaYaOcupada,
  cargarPersona,
  crearPersona,
  otorgarCapacidad,
  revocarCapacidad,
} from '../identidad/personas.js'
import { registrarIntencion } from '../bitacora/bitacora.js'
import { type Instante, instante, instanteOpcional } from '../dinero/momento.js'
import { type Guaranies, guaranies } from '../dinero/monto.js'
import type { BilleteraDO } from '../index.js'

/**
 * Lo que se acepta como `correlacion_id` de afuera.
 *
 * Acotado a proposito: este texto se escribe en cinco tablas y despues alguien lo
 * pega en una consulta. Sin tope, un llamador puede mandar diez kilobytes en cada
 * fila de bitacora; sin alfabeto, puede mandar saltos de linea que parten el log
 * en dos y hacen que una linea inventada parezca un registro.
 */
const CORRELACION_VALIDA = /^[A-Za-z0-9:_-]{1,64}$/

/** La clave de idempotencia. Mismo criterio, mas largo: la arman los llamadores
 *  concatenando identificadores (`carga:<pedido>:<paso>`) y 128 les sobra. */
const CLAVE_IDEM_VALIDA = /^[A-Za-z0-9:._-]{1,128}$/

export function correlacionValida(valor: unknown): valor is string {
  return typeof valor === 'string' && CORRELACION_VALIDA.test(valor)
}

/**
 * La correlacion de esta peticion: la que trajo el llamador si sirve, una nueva
 * si no.
 *
 * Se la deja traer para que un sistema que ya tiene su propia trazabilidad pueda
 * atar las dos puntas. Una invalida NO es un error: se descarta y se genera una,
 * porque rechazar una acreditacion legitima por un encabezado mal escrito es
 * cambiar un problema de trazas por un problema de plata.
 */
export function correlacionDe(peticion: Request, generar: () => string): string {
  const traida = peticion.headers.get('x-correlacion-id')
  return correlacionValida(traida) ? traida : generar()
}

/**
 * Lo que se acepta como `persona_id`.
 *
 * Es el mismo criterio que el de la correlacion, y por los mismos motivos —el
 * razonamiento estaba escrito arriba y aplicado a una sola de las dos entradas,
 * que es la forma mas facil de creer que se arreglo—. Un `persona_id` termina en
 * `personas.id`, en `bitacora.objetivo`, adentro del `detalle` JSON y, via
 * `derivarBilleteraId`, en el NOMBRE de un Durable Object.
 *
 * Lo que una auditoria midio sin esto: `POST /personas` con `"ana bonita"`, `"a/b"`
 * o `".."` creaba la persona con 201 y despues `GET /personas/ana%20bonita` daba
 * 404 para siempre, porque el enrutador parte `url.pathname` sin decodificar. La
 * cuenta queda inalcanzable, con su `billetera_id` ya quemado en el indice unico y
 * sin ninguna ruta para borrarla. Y un id con un byte NUL adentro entraba, y al
 * releerlo se presentaba como el duplicado exacto de otra persona.
 *
 * Los identificadores que genera la plataforma (`crypto.randomUUID`) entran en este
 * alfabeto sin tocarlos.
 *
 * SIN DOS PUNTOS, y eso lo corrigio la segunda vuelta. `derivarBilleteraId` dice
 * que «el prefijo es lo unico que impide» que algo que use `idFromName` sobre un id
 * de persona caiga sobre su billetera. Con `:` en el alfabeto, la persona
 * `billetera:p1` era creable —medido, 201 y 200 al releerla— y su nombre derivado
 * es `billetera:billetera:p1`, pero cualquier modulo futuro que hiciera
 * `idFromName(persona_id)` sobre ella aterrizaria EXACTAMENTE en la billetera de
 * `p1`. El prefijo no protege contra un id que puede contener el prefijo.
 */
const PERSONA_VALIDA = /^[A-Za-z0-9_-]{1,64}$/

/**
 * `plataforma` es como `actorId()` escribe a la plataforma en la bitacora. Una
 * persona con ese id haria que la fila que dice quien pidio mover plata deje de ser
 * decidible. No da acceso a nada —`exigirPlataforma` mira `actor.tipo`, no el id—
 * pero el registro es el entregable, y lo encontro una auditoria.
 */
const IDS_RESERVADOS = RESERVADOS

export function personaIdValido(valor: unknown): valor is string {
  return (
    typeof valor === 'string' &&
    PERSONA_VALIDA.test(valor) &&
    !IDS_RESERVADOS.includes(valor.toLowerCase())
  )
}

/** Un fallo con su codigo HTTP ya decidido, para que las rutas no lo repitan. */
export class Problema extends Error {
  constructor(
    readonly codigo: number,
    readonly clave: string,
    readonly detalle?: Record<string, unknown>,
  ) {
    super(clave)
    this.name = 'Problema'
  }
}

const json = (cuerpo: unknown, estado: number, correlacion_id: string): Response =>
  Response.json(cuerpo, {
    status: estado,
    // El llamador se lleva la correlacion aunque no la haya mandado: sin esto,
    // el unico que puede atar su llamada con lo que quedo escrito es quien tenga
    // acceso a la base.
    headers: { 'x-correlacion-id': correlacion_id },
  })

/** Tope para los textos libres que viajan al ledger. Un `concepto` de cien mil
 *  caracteres llegaba intacto al asiento: medido. */
const LARGO_MAXIMO_DE_TEXTO = 200

function acotar(valor: string): string {
  if (valor.length > LARGO_MAXIMO_DE_TEXTO) throw new Problema(400, 'texto_demasiado_largo')
  return valor
}

/** Un texto con valor por defecto. Ausente y `null` caen los dos en el defecto. */
function texto(valor: unknown, porDefecto: string): string {
  if (valor === undefined || valor === null) return porDefecto
  if (typeof valor !== 'string') throw new Problema(400, 'texto_invalido')
  return acotar(valor)
}

/**
 * Un texto que puede NO estar, y cuya ausencia es `null` — no cadena vacia.
 *
 * EXISTE POR UN DEFECTO QUE NACIO DEL ARREGLO ANTERIOR, y lo midieron dos
 * auditores por separado en la segunda vuelta. `restringida_a` se leia con
 * `texto(valor, '')`, asi que un `null` explicito en el JSON —la forma en que
 * cualquier cliente serializa un opcional ausente— llegaba a la bolsa como `''`.
 *
 * Y `''` NO es `null` para `dinero/bolsas.ts`: la bolsa queda restringida a un
 * proposito que nadie pide nunca, o sea inconsumible para siempre. Pero SI cuenta
 * en `saldoRetirable`, que no mira `restringida_a`. Medido de punta a punta:
 * `200 OK` con `saldo_retirable: 50000`, y el `debitar` siguiente contestando
 * «saldo insuficiente: faltan 10000».
 *
 * Es exactamente la categoria que el guarda de `vence_en_ya_vencido` se agrego a
 * cerrar cinco lineas mas arriba —plata que entra al ledger, cuenta en los
 * totales, pasa los invariantes, y no se puede mover— reabierta por el campo de al
 * lado en el mismo bloque. Arreglar el caso y no la categoria, otra vez.
 */
function textoOpcional(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null
  if (typeof valor !== 'string') throw new Problema(400, 'texto_invalido')
  if (valor.length === 0) return null
  return acotar(valor)
}

async function cuerpoJson(peticion: Request): Promise<Record<string, unknown>> {
  let leido: unknown
  try {
    leido = await peticion.json()
  } catch {
    throw new Problema(400, 'cuerpo_no_es_json')
  }
  if (typeof leido !== 'object' || leido === null || Array.isArray(leido)) {
    throw new Problema(400, 'cuerpo_no_es_un_objeto')
  }
  return leido as Record<string, unknown>
}

/**
 * Solo la plataforma. Se usa en todo lo que administra cuentas ajenas.
 *
 * Es una funcion y no un `if` repetido en cada ruta porque la version con el `if`
 * repetido es la que un dia tiene catorce lugares bien y uno mal, y el que esta
 * mal es el que crea personas.
 */
function exigirPlataforma(actor: Actor): void {
  if (actor.tipo !== 'plataforma') throw new Problema(403, 'solo_la_plataforma')
}

/** La plataforma, o la propia persona sobre si misma. Nadie mas. */
function exigirPlataformaOElMismo(actor: Actor, persona_id: string): void {
  if (actor.tipo === 'plataforma') return
  if (actor.persona_id === persona_id) return
  throw new Problema(403, 'no_es_tuyo')
}

function exigirCapacidadEnCuerpo(cuerpo: Record<string, unknown>): Capacidad {
  const c = cuerpo['capacidad']
  if (!esCapacidad(c)) throw new Problema(400, 'capacidad_desconocida')
  return c
}

/** Como sale una persona por la API. Sin un solo dato personal — hoy porque no
 *  hay ninguno guardado, y manaña porque esta funcion es el unico lugar que
 *  decide que se muestra. */
function personaAJson(persona: Persona, momento: Instante) {
  return {
    persona_id: persona.persona_id,
    estado: persona.estado,
    billetera_id: persona.billetera_id,
    creada_en: persona.creada_en,
    capacidades_vigentes: capacidadesVigentes(persona, momento),
    ventanas: persona.otorgamientos.map((o) => ({
      capacidad: o.capacidad,
      desde: o.desde,
      hasta: o.hasta,
    })),
  }
}

/**
 * Lo que estas rutas necesitan del entorno, y nada mas.
 *
 * No es `Entorno`: `SECUENCIA` y `ZONA_HORARIA` existen y acá no se usan, y una
 * dependencia declarada que no se usa es una dependencia que un dia alguien usa
 * sin darse cuenta de que la agrego. Es la misma razon por la que `EstadoBilletera`
 * es angosto.
 *
 * `BilleteraDO` entra como TIPO —`import type`— y no como valor. Es a proposito:
 * `index.ts` importa `atender` de este archivo, asi que un import de valor cerraria
 * un ciclo en tiempo de ejecucion. Un `import type` se borra al compilar y no
 * queda ciclo ninguno. La alternativa era describir la forma del Durable Object
 * acá a mano, y eso es un doble del que nadie compara: exactamente el defecto que
 * `check-entorno.mjs` existe para cerrar, en otra frontera.
 */
export interface Dependencias {
  readonly CORE: D1Database
  readonly BILLETERA: DurableObjectNamespace<BilleteraDO>
  readonly SECRETO_SERVICIO?: string
  /** Para que un token de staging no valga en produccion. Ver `actor.ts`. */
  readonly ENTORNO: string
}

/**
 * La ruta que abre la billetera desde afuera. LA de esta entrega.
 *
 * ORDEN DE LAS COSAS, que es lo unico que importa acá:
 *
 *   1. se identifica al actor
 *   2. se comprueba que el destinatario exista y pueda recibir — `puede()`, la
 *      funcion pura, en el camino de verdad y no solo en las pruebas
 *   3. se ESCRIBE la bitacora
 *   4. recien entonces se mueve la plata
 *
 * El 3 antes que el 4 es la decision. Al reves, un Worker que muere en el medio
 * deja plata movida sin registro de quien la pidio; asi, lo peor que puede quedar
 * es un pedido anotado que no llego a ejecutarse. Sobra informacion en vez de
 * faltar, que es el unico lado por el que un registro de auditoria puede errar.
 */
async function acreditar(
  dep: Dependencias,
  actor: Actor,
  correlacion_id: string,
  momento: Instante,
  cuerpo: Record<string, unknown>,
): Promise<Response> {
  exigirPlataforma(actor)

  const persona_id = cuerpo['persona_id']
  if (typeof persona_id !== 'string' || persona_id.length === 0) {
    throw new Problema(400, 'falta_persona_id')
  }

  // La clave de idempotencia la pone el LLAMADOR y es obligatoria. Generarla acá
  // seria generar una distinta en cada reintento, o sea acreditar dos veces
  // cuando la primera respuesta se pierde. Es la unica proteccion real contra que
  // un token repetido dentro de su ventana mueva plata dos veces.
  // El MISMO alfabeto y el mismo tope que la correlacion, y esta vez por la razon
  // mas fuerte de las tres: `clave_idem` no es decorativa. `nucleo.ts` arma el
  // `asiento_id` como `${clave_idem}:${sufijo}`, y ese texto es la mitad de la
  // clave primaria de `ledger_copia`. Ademas viaja al `detalle` de la bitacora,
  // que desde 0003 no se puede editar ni borrar.
  //
  // La primera version acoto `concepto`, `origen` y `restringida_a` —los tres
  // decorativos— y dejo justo este afuera. Medido por una auditoria: una
  // `clave_idem` de cien mil caracteres entraba, y quedaba una fila de auditoria de
  // 200 KB que nadie puede borrar, con un `asiento_id` de cien mil caracteres en la
  // clave primaria del read model. Tres de cuatro no es la categoria.
  const clave_idem = cuerpo['clave_idem']
  if (typeof clave_idem !== 'string' || clave_idem.length === 0) {
    throw new Problema(400, 'falta_clave_idem')
  }
  if (!CLAVE_IDEM_VALIDA.test(clave_idem)) throw new Problema(400, 'clave_idem_invalida')

  // `guaranies()` es la puerta del dinero y exige un numero: un `"100000"` de
  // texto ni siquiera llega a la validacion de decimales. Se comprueba el tipo
  // antes para que un cuerpo mal armado salga como 400 y no como 500.
  const crudo = cuerpo['monto']
  if (typeof crudo !== 'number') throw new Problema(400, 'monto_invalido')
  let monto: Guaranies
  try {
    monto = guaranies(crudo)
  } catch {
    throw new Problema(400, 'monto_invalido')
  }
  if (monto <= 0) throw new Problema(400, 'monto_invalido')

  const bolsa = cuerpo['bolsa']
  if (bolsa !== 'disponible' && bolsa !== 'ganancia_creador' && bolsa !== 'credito_promocion') {
    // `retenido` no esta, y no por olvido: a esa bolsa solo se entra reservando.
    // El nucleo tambien lo rechaza; acá se rechaza antes para que el mensaje diga
    // algo util en vez de salir como un 500.
    throw new Problema(400, 'bolsa_invalida')
  }

  // LO QUE SIGUE SE VALIDA ACA Y NO ADENTRO DEL DURABLE OBJECT, y esto es un
  // arreglo de categoria: el `monto` y la `bolsa` ya se validaban en la puerta «para
  // que un cuerpo mal armado salga como 400 y no como 500», y los otros cuatro
  // campos pasaban en crudo. Una auditoria midio tres cuerpos —`vence_en` sin
  // milisegundos, `vence_en` con huso, y `credito_promocion` sin vencimiento— que
  // salian 500 DESPUES de haber escrito la intencion en la bitacora.
  let vence_en: string | null
  try {
    vence_en = instanteOpcional(cuerpo['vence_en'])
  } catch {
    throw new Problema(400, 'vence_en_invalido')
  }

  // Ley 11: el credito de promocion nace con vencimiento. El nucleo tambien lo
  // exige; acá se exige antes para que el llamador reciba el motivo.
  if (bolsa === 'credito_promocion' && vence_en === null) {
    throw new Problema(400, 'el_credito_de_promocion_necesita_vencimiento')
  }

  // Una acreditacion que nace vencida entra al ledger, cuenta en los totales, pasa
  // los invariantes — y es inconsumible para siempre. El panel, leyendo el read
  // model como manda la ley 1, muestra plata que la billetera no tiene, y no hay
  // ninguna ruta que la compense. Medido por una auditoria: 200 OK con
  // `saldo_retirable: 0`.
  if (vence_en !== null && vence_en <= momento) {
    throw new Problema(400, 'vence_en_ya_vencido')
  }

  const concepto = texto(cuerpo['concepto'], 'acreditacion')
  const origen = texto(cuerpo['origen'], 'plataforma')
  const restringida_a = textoOpcional(cuerpo['restringida_a'])

  const persona = await cargarPersona(dep.CORE, persona_id)
  if (persona === null) throw new Problema(404, 'no_existe_la_persona')

  // Ley 4 en el camino de verdad: la pregunta lleva momento.
  const veredicto = puede(persona, 'cliente', momento)
  if (!veredicto.puede) throw new Problema(403, 'no_puede', { motivo: veredicto.motivo })

  await registrarIntencion(dep.CORE, {
    actor_id: actorId(actor),
    accion: 'billetera.acreditacion.pedida',
    objetivo: persona.billetera_id,
    detalle: { persona_id, monto, bolsa, clave_idem },
    correlacion_id,
    ocurrido_en: momento,
  })

  const billetera = dep.BILLETERA.get(dep.BILLETERA.idFromName(persona.billetera_id))
  const r = await billetera.acreditar(
    { clave_idem, correlacion_id, momento },
    { monto, bolsa, concepto, origen, vence_en, restringida_a },
  )

  return json(
    {
      billetera_id: persona.billetera_id,
      saldo_retirable: r.valor.saldo_retirable,
      repetida: r.repetida,
      correlacion_id,
    },
    200,
    correlacion_id,
  )
}

/**
 * El enrutador. Explicito, sin expresiones regulares sobre el path y sin tabla de
 * rutas generada: son seis, se leen de arriba abajo, y cada una dice que metodo y
 * que forma acepta.
 */
export async function enrutar(
  peticion: Request,
  dep: Dependencias,
  momento: Instante,
  correlacion_id: string,
  nuevoId: () => string,
): Promise<Response> {
  const url = new URL(peticion.url)
  const partes = url.pathname.split('/').filter((p) => p.length > 0)

  const actor = await actorDeLaPeticion(peticion, dep, momento)

  // POST /personas
  if (partes.length === 1 && partes[0] === 'personas' && peticion.method === 'POST') {
    exigirPlataforma(actor)
    const cuerpo = await cuerpoJson(peticion)
    const pedido = cuerpo['persona_id']
    if (pedido !== undefined && !personaIdValido(pedido)) {
      throw new Problema(400, 'persona_id_invalido')
    }
    const persona_id = pedido === undefined ? nuevoId() : (pedido as string)
    try {
      const persona = await crearPersona(dep.CORE, { actor, correlacion_id, momento }, persona_id)
      return json(personaAJson(persona, momento), 201, correlacion_id)
    } catch (e) {
      if (e instanceof PersonaYaExiste) throw new Problema(409, 'ya_existe_la_persona')
      throw e
    }
  }

  // GET /personas/:id
  if (partes.length === 2 && partes[0] === 'personas' && peticion.method === 'GET') {
    const persona_id = partes[1] as string
    exigirPlataformaOElMismo(actor, persona_id)
    const persona = await cargarPersona(dep.CORE, persona_id)
    if (persona === null) throw new Problema(404, 'no_existe_la_persona')
    return json(personaAJson(persona, momento), 200, correlacion_id)
  }

  // POST /personas/:id/capacidades
  if (
    partes.length === 3 &&
    partes[0] === 'personas' &&
    partes[2] === 'capacidades' &&
    peticion.method === 'POST'
  ) {
    exigirPlataforma(actor)
    const persona_id = partes[1] as string
    const capacidad = exigirCapacidadEnCuerpo(await cuerpoJson(peticion))
    try {
      await otorgarCapacidad(dep.CORE, { actor, correlacion_id, momento }, persona_id, capacidad)
    } catch (e) {
      if (e instanceof PersonaNoExiste) throw new Problema(404, 'no_existe_la_persona')
      if (e instanceof CapacidadYaVigente) throw new Problema(409, 'capacidad_ya_vigente')
      if (e instanceof VentanaYaOcupada) throw new Problema(409, 'ventana_ya_ocupada')
      throw e
    }
    return json({ persona_id, capacidad, desde: momento, correlacion_id }, 201, correlacion_id)
  }

  // DELETE /personas/:id/capacidades/:capacidad
  if (
    partes.length === 4 &&
    partes[0] === 'personas' &&
    partes[2] === 'capacidades' &&
    peticion.method === 'DELETE'
  ) {
    exigirPlataforma(actor)
    const persona_id = partes[1] as string
    const capacidad = partes[3]
    if (!esCapacidad(capacidad)) throw new Problema(400, 'capacidad_desconocida')
    let revocada: boolean
    try {
      revocada = await revocarCapacidad(
        dep.CORE,
        { actor, correlacion_id, momento },
        persona_id,
        capacidad,
      )
    } catch (e) {
      if (e instanceof PersonaNoExiste) throw new Problema(404, 'no_existe_la_persona')
      throw e
    }
    // 200 con `revocada: false` y no un 404: que no hubiera ventana abierta no es
    // un error del llamador, y un reintento de una revocacion ya aplicada tiene
    // que ser inofensivo.
    return json({ persona_id, capacidad, revocada, hasta: momento, correlacion_id }, 200, correlacion_id)
  }

  // POST /billetera/acreditar
  if (
    partes.length === 2 &&
    partes[0] === 'billetera' &&
    partes[1] === 'acreditar' &&
    peticion.method === 'POST'
  ) {
    // El guarda ANTES de leer el cuerpo. Era la unica de las seis rutas con el
    // orden al reves —el `await cuerpoJson(...)` se evaluaba antes de la llamada,
    // asi que `exigirPlataforma` corria despues— y lo midio una auditoria: con un
    // token de persona valido se obligaba al Worker a materializar y parsear un
    // cuerpo de 8 MB antes de rechazarlo con 403. La autorizacion no se podia
    // saltar; el orden si estaba mal, y justo en la ruta que crea dinero.
    exigirPlataforma(actor)
    return acreditar(dep, actor, correlacion_id, momento, await cuerpoJson(peticion))
  }

  // GET /billetera/:persona_id/saldo
  //
  // LEE EL DURABLE OBJECT, NO EL READ MODEL, y eso hay que decirlo porque roza la
  // ley 1. La ley dice que «el panel nunca consulta el almacen transaccional»: esta
  // ruta no es el panel, es la consulta operativa de la plataforma sobre UNA
  // billetera, y necesita el saldo exacto de este instante, no el que ya llego por
  // outbox. El panel —cuando exista— tiene que leer `ledger_copia`, que desde esta
  // entrega se puede unir con `personas` por `billetera_id`.
  //
  // El precio, dicho: cada llamada despierta la billetera y toma la misma compuerta
  // de entrada que el movimiento de plata. Encuestar el saldo de muchas cuentas por
  // acá haria cola detras del camino transaccional. Si eso aparece, la respuesta no
  // es optimizar esta ruta: es que el que encuesta lea el read model.
  if (
    partes.length === 3 &&
    partes[0] === 'billetera' &&
    partes[2] === 'saldo' &&
    peticion.method === 'GET'
  ) {
    const persona_id = partes[1] as string
    exigirPlataformaOElMismo(actor, persona_id)
    const persona = await cargarPersona(dep.CORE, persona_id)
    if (persona === null) throw new Problema(404, 'no_existe_la_persona')
    const billetera = dep.BILLETERA.get(dep.BILLETERA.idFromName(persona.billetera_id))
    const saldo = await billetera.saldo()
    return json({ billetera_id: persona.billetera_id, ...saldo, correlacion_id }, 200, correlacion_id)
  }

  throw new Problema(404, 'no_encontrado')
}

/**
 * La cascara: momento, correlacion, y la traduccion de los fallos a HTTP.
 *
 * UN TOKEN RECHAZADO SALE SIEMPRE IGUAL, sin decir por que. El motivo se conoce
 * —lo lleva `TokenInvalido`— y va al log, no a la respuesta. Contestarle a quien
 * golpea la puerta si lo que fallo fue la firma o la fecha le dice cuanto le
 * falta: con "firma invalida" ya sabe que la forma del token es correcta.
 *
 * `sin_secreto` es la excepcion en el log, no en la respuesta: sale como 401
 * igual que todo lo demas, pero se registra como error porque no es alguien
 * probando la puerta — es un despliegue al que le falta el secreto, y el que
 * opera necesita verlo.
 */
export async function atender(
  peticion: Request,
  dep: Dependencias,
  ahora: () => string,
  nuevoId: () => string,
): Promise<Response> {
  const correlacion_id = correlacionDe(peticion, nuevoId)
  const momento = instante(ahora())

  try {
    return await enrutar(peticion, dep, momento, correlacion_id, nuevoId)
  } catch (e) {
    if (e instanceof TokenInvalido) {
      if (e.motivo === 'sin_secreto') {
        console.error(
          `SECRETO_SERVICIO no esta configurado: la puerta rechaza a todos (correlacion ${correlacion_id})`,
        )
      } else if (e.motivo === 'secreto_debil') {
        // Motivo propio, y no es cosmetico: con un solo motivo, el operador que puso
        // un secreto de 24 caracteres leia «no esta configurado» y salia a buscar el
        // `wrangler secret put` que ya habia hecho. Lo midio la segunda vuelta.
        console.error(
          `SECRETO_SERVICIO es mas corto que el minimo de ${LARGO_MINIMO_DEL_SECRETO} caracteres: la puerta rechaza a todos (correlacion ${correlacion_id})`,
        )
      } else {
        console.log(`token rechazado (${e.motivo}) correlacion ${correlacion_id}`)
      }
      return json({ error: 'no_autorizado', correlacion_id }, 401, correlacion_id)
    }
    if (e instanceof Problema) {
      return json({ error: e.clave, ...(e.detalle ?? {}), correlacion_id }, e.codigo, correlacion_id)
    }

    // Lo que no se previo sale como 500. El `correlacion_id` va en el CUERPO —para
    // que el que reporta el problema tenga algo que decir— y tambien en el LOG, que
    // es lo unico que despues permite encontrar esa peticion. Son dos cosas
    // distintas y la primera version las mezclaba en una sola frase.
    //
    // El mensaje del error NO sale por la respuesta: puede llevar adentro un
    // fragmento de SQL o un identificador ajeno.
    console.error(
      `fallo no previsto en ${peticion.method} ${new URL(peticion.url).pathname} correlacion ${correlacion_id}`,
      e,
    )
    return json({ error: 'fallo_interno', correlacion_id }, 500, correlacion_id)
  }
}

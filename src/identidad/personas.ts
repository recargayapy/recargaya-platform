/**
 * Las personas, en D1. Crear, otorgar, revocar, leer.
 *
 * Este archivo traduce entre las filas de la base y los tipos de
 * `capacidades.ts`. La decision de quien puede que NO vive acá: vive alla, en una
 * funcion pura. Acá solo se leen y se escriben filas.
 *
 * Esa separacion es la misma que hay entre `billetera/nucleo.ts` y
 * `billetera/repositorio.ts`, y esta por la misma razon: la regla se prueba sin
 * base, y la traduccion se prueba contra una base de verdad.
 *
 * ---------------------------------------------------------------------------
 * TODO LO QUE ESCRIBE ACA LLEVA SU RENGLON DE BITACORA EN EL MISMO `batch()`
 *
 * Un `batch()` de D1 es una transaccion. O entran el cambio y su registro, o no
 * entra ninguno de los dos. Es la ley 5 aplicada al lado de D1, y es la razon por
 * la que ninguna de estas funciones recibe "si querés, registralo": el registro
 * es parte de la operacion, no una opcion.
 */

import {
  type Capacidad,
  type Persona,
  esEstadoDePersona,
  otorgamiento,
} from './capacidades.js'
import { type Instante, instante } from '../dinero/momento.js'
import { sentenciaDeBitacora, sentenciaDeBitacoraSi } from '../bitacora/bitacora.js'
import { actorId, type Actor } from './actor.js'

/**
 * De persona a billetera, en un solo lugar.
 *
 * El valor se calcula acá y se GUARDA en la columna `personas.billetera_id` — no
 * se recalcula en cada lectura. La diferencia importa el dia que haya que fusionar
 * dos cuentas de la misma persona: con la columna se puede apuntar una a la
 * billetera de la otra, con la derivacion habria que mover plata entre dos Durable
 * Objects. El encabezado de la migracion 0003 lo cuenta entero.
 *
 * El prefijo existe para que el nombre del Durable Object no sea nunca un
 * identificador pelado. `idFromName('abc')` y `idFromName('billetera:abc')` son
 * objetos distintos, y el dia que algo mas del sistema use `idFromName` sobre un
 * id de persona —una preferencia, un borrador— el prefijo es lo unico que impide
 * que caiga sobre la billetera.
 */
/**
 * Todo lo que este archivo escribe pasa por acá.
 *
 * Existe por dos razones y las dos importan. La primera es de diseño: «el cambio y
 * su registro entran juntos o no entra ninguno» es un invariante del archivo, no de
 * cada funcion, y un invariante del archivo tiene que tener UN lugar donde vive.
 *
 * La segunda la pidio el arnes de mutacion: con `d1.batch(...)` escrito en tres
 * lugares, la mutacion que rompe la atomicidad tiene que romper los tres, y una
 * mutacion que muta a medias muere o sobrevive por un motivo distinto al que
 * declara. Acá se rompe uno.
 */
function enUnLote(d1: D1Database, sentencias: D1PreparedStatement[]): Promise<D1Result[]> {
  return d1.batch(sentencias)
}

export function derivarBilleteraId(persona_id: string): string {
  return `billetera:${persona_id}`
}

export class PersonaNoExiste extends Error {
  constructor(readonly persona_id: string) {
    super(`no existe la persona ${persona_id}`)
    this.name = 'PersonaNoExiste'
  }
}

export class PersonaYaExiste extends Error {
  constructor(readonly persona_id: string) {
    super(`ya existe la persona ${persona_id}`)
    this.name = 'PersonaYaExiste'
  }
}

/**
 * Ya hay una ventana de esa capacidad que EMPIEZA en este mismo instante.
 *
 * Nacio de un arreglo: desde que una ventana de duracion cero es legitima, otorgar →
 * revocar → volver a otorgar dentro del mismo milisegundo choca contra la clave
 * primaria `(persona_id, capacidad, otorgada_en)`, porque la ventana `[T, T)` ya la
 * ocupa. Antes ese camino no existia —la revocacion moria con 500 y la capacidad
 * quedaba abierta, que era peor— y la segunda vuelta de auditoria lo midio saliendo
 * como `fallo_interno` opaco.
 *
 * En Workers el reloj esta congelado hasta la primera E/S de cada peticion, asi que
 * esto no es exotico. Se contesta 409 con un motivo que se entiende, y el reintento
 * un milisegundo despues funciona.
 */
export class VentanaYaOcupada extends Error {
  constructor(
    readonly persona_id: string,
    readonly capacidad: Capacidad,
    readonly momento: string,
  ) {
    super(`${persona_id} ya tiene una ventana de ${capacidad} que empieza en ${momento}`)
    this.name = 'VentanaYaOcupada'
  }
}

export class CapacidadYaVigente extends Error {
  constructor(
    readonly persona_id: string,
    readonly capacidad: Capacidad,
  ) {
    super(`${persona_id} ya tiene abierta la capacidad ${capacidad}`)
    this.name = 'CapacidadYaVigente'
  }
}

interface FilaPersona {
  id: string
  creada_en: string
  estado: string
  billetera_id: string
}

interface FilaCapacidad {
  capacidad: string
  otorgada_en: string
  hasta: string | null
}

/**
 * Arma la persona desde sus filas, validando lo que llega de la base.
 *
 * Se valida aunque los datos salgan de nuestra propia tabla, y no es paranoia:
 * `estado` tiene un CHECK en SQL, pero el CHECK lo aplica la base que corre HOY.
 * Una fila escrita por una version anterior del esquema, o por una consulta a
 * mano, entra igual. Y un `estado` que no se reconoce no puede caer en un `else`
 * que lo trate como activa — seria una cuenta suspendida atendiendo pedidos.
 */
function armarPersona(fila: FilaPersona, capacidades: readonly FilaCapacidad[]): Persona {
  if (!esEstadoDePersona(fila.estado)) {
    throw new Error(`estado desconocido en la persona ${fila.id}: ${fila.estado}`)
  }
  return {
    persona_id: fila.id,
    estado: fila.estado,
    billetera_id: fila.billetera_id,
    creada_en: instante(fila.creada_en),
    otorgamientos: capacidades.map((c) =>
      otorgamiento({ capacidad: c.capacidad, otorgada_en: c.otorgada_en, hasta: c.hasta }),
    ),
  }
}

export async function cargarPersona(d1: D1Database, persona_id: string): Promise<Persona | null> {
  // Las dos consultas en un `batch` y no en dos `await` sueltos: es un solo viaje
  // a D1, y las dos ven el mismo estado. Con dos idas, una capacidad otorgada en
  // el medio produce una persona que nunca existio en ningun instante.
  const [personas, capacidades] = await d1.batch<FilaPersona | FilaCapacidad>([
    d1.prepare('SELECT id, creada_en, estado, billetera_id FROM personas WHERE id = ?').bind(persona_id),
    d1
      .prepare('SELECT capacidad, otorgada_en, hasta FROM capacidades WHERE persona_id = ?')
      .bind(persona_id),
  ])

  const fila = personas?.results?.[0] as FilaPersona | undefined
  if (fila === undefined) return null

  return armarPersona(fila, (capacidades?.results ?? []) as FilaCapacidad[])
}

export interface Contexto {
  readonly actor: Actor
  readonly correlacion_id: string
  readonly momento: Instante
}

/**
 * Crea la persona y su billetera, con el renglon de bitacora en la misma
 * transaccion.
 *
 * `persona_id` lo puede traer el llamador, y eso es lo que le da una forma de
 * reintentar: un POST que se corto sin respuesta se repite con el MISMO id y la
 * segunda vez contesta "ya existe" en vez de crear una segunda cuenta con una
 * segunda billetera. Sin eso, una respuesta perdida se convierte en dos personas
 * y ninguna forma de saber cual es la buena.
 */
export async function crearPersona(
  d1: D1Database,
  ctx: Contexto,
  persona_id: string,
): Promise<Persona> {
  const billetera_id = derivarBilleteraId(persona_id)

  const ya = await d1.prepare('SELECT 1 FROM personas WHERE id = ?').bind(persona_id).first()
  if (ya !== null) throw new PersonaYaExiste(persona_id)

  await enUnLote(d1, [
    d1
      .prepare('INSERT INTO personas (id, creada_en, estado, billetera_id) VALUES (?, ?, ?, ?)')
      .bind(persona_id, ctx.momento, 'activa', billetera_id),
    sentenciaDeBitacora(d1, {
      actor_id: actorId(ctx.actor),
      accion: 'persona.creada',
      objetivo: persona_id,
      // Ley 9: identificadores, nunca el nombre de nadie. `revisarDetalle` lo
      // hace cumplir, no este comentario.
      detalle: { billetera_id },
      correlacion_id: ctx.correlacion_id,
      ocurrido_en: ctx.momento,
    }),
  ])

  return {
    persona_id,
    estado: 'activa',
    billetera_id,
    creada_en: ctx.momento,
    otorgamientos: [],
  }
}

/**
 * Abre una ventana de capacidad.
 *
 * La comprobacion previa da un error legible; el indice unico parcial de 0003 es
 * lo que lo hace IMPOSIBLE. Los dos hacen falta y no es redundancia: entre la
 * lectura y la escritura cabe otra peticion, y ahi el que decide es el indice.
 * Si algun dia esta lectura se borra "porque el indice ya lo cubre", lo que se
 * pierde es el mensaje, no la garantia.
 */
export async function otorgarCapacidad(
  d1: D1Database,
  ctx: Contexto,
  persona_id: string,
  capacidad: Capacidad,
): Promise<void> {
  const persona = await cargarPersona(d1, persona_id)
  if (persona === null) throw new PersonaNoExiste(persona_id)

  const abierta = persona.otorgamientos.some((o) => o.capacidad === capacidad && o.hasta === null)
  if (abierta) throw new CapacidadYaVigente(persona_id, capacidad)

  // Y la clave primaria, que la comprobacion de arriba no cubre: una ventana ya
  // CERRADA que empiece en este mismo instante ocupa `(persona_id, capacidad,
  // otorgada_en)`. Sin esto, el INSERT choca y sale un 500 sin motivo de dominio.
  const ocupada = persona.otorgamientos.some(
    (o) => o.capacidad === capacidad && o.desde === ctx.momento,
  )
  if (ocupada) throw new VentanaYaOcupada(persona_id, capacidad, ctx.momento)

  await enUnLote(d1, [
    d1
      .prepare('INSERT INTO capacidades (persona_id, capacidad, otorgada_en, hasta) VALUES (?, ?, ?, NULL)')
      .bind(persona_id, capacidad, ctx.momento),
    sentenciaDeBitacora(d1, {
      actor_id: actorId(ctx.actor),
      accion: 'capacidad.otorgada',
      objetivo: persona_id,
      detalle: { capacidad, desde: ctx.momento },
      correlacion_id: ctx.correlacion_id,
      ocurrido_en: ctx.momento,
    }),
  ])
}

/**
 * Cierra la ventana abierta poniendole fecha. NO borra la fila: perder que fulano
 * fue vendedor entre marzo y julio es perder la unica respuesta posible a "¿por
 * que ese reparto de marzo pago comision de vendedor?".
 *
 * Devuelve si revoco algo. El renglon de bitacora va CONDICIONADO a lo mismo que
 * el UPDATE y en la misma transaccion, asi que no puede quedar un "se revoco"
 * escrito sobre una revocacion que no ocurrio. Ver `sentenciaDeBitacoraSi`.
 */
export async function revocarCapacidad(
  d1: D1Database,
  ctx: Contexto,
  persona_id: string,
  capacidad: Capacidad,
): Promise<boolean> {
  const persona = await cargarPersona(d1, persona_id)
  if (persona === null) throw new PersonaNoExiste(persona_id)

  // EL ORDEN DE ESTAS DOS SENTENCIAS ES EL ARREGLO, y vale contar de que.
  //
  // La primera version ponia el UPDATE primero y condicionaba la bitacora a
  // `hasta = <momento>`, con un comentario que decia que eso era «cierto
  // exactamente cuando el UPDATE toco una fila». No lo es: es cierto cuando existe
  // ALGUNA ventana cerrada en ese instante, la haya cerrado esta peticion o la de
  // al lado. Una auditoria lo midio — dos revocaciones en el mismo milisegundo
  // dejaban dos renglones, uno de ellos afirmando una revocacion que no ocurrio.
  //
  // Ahora las dos sentencias preguntan LO MISMO —«¿hay una ventana abierta?»— y la
  // bitacora va PRIMERO, con el estado todavia sin tocar. Adentro de una
  // transaccion nada puede cambiar entre las dos, asi que o entran las dos o no
  // entra ninguna. Y de paso queda en el mismo orden que la acreditacion: el
  // registro antes del cambio.
  const [, cambio] = await enUnLote(d1, [
    sentenciaDeBitacoraSi(
      d1,
      {
        actor_id: actorId(ctx.actor),
        accion: 'capacidad.revocada',
        objetivo: persona_id,
        detalle: { capacidad, hasta: ctx.momento },
        correlacion_id: ctx.correlacion_id,
        ocurrido_en: ctx.momento,
      },
      {
        sql: 'SELECT 1 FROM capacidades WHERE persona_id = ? AND capacidad = ? AND hasta IS NULL',
        valores: [persona_id, capacidad],
      },
    ),
    d1
      .prepare('UPDATE capacidades SET hasta = ? WHERE persona_id = ? AND capacidad = ? AND hasta IS NULL')
      .bind(ctx.momento, persona_id, capacidad),
  ])

  return (cambio?.meta?.changes ?? 0) > 0
}

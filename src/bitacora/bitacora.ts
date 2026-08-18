/**
 * La bitacora de auditoria. Quien pidio que, con `correlacion_id`, desde el
 * primer endpoint.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NACE CON LA PUERTA Y NO DESPUES
 *
 * La tabla existe desde 0001, sin uso, y su comentario dice el motivo: ponerla
 * despues significa no poder reconstruir que paso durante los primeros meses. El
 * plan maestro lo pide textual —«outbox, Queues, DLQ, correlation_id y audit log
 * EN EL PRIMER ENDPOINT»— y esta escrito asi para que la trazabilidad nazca con
 * la primera puerta, cuando todavia no hay movimientos sin rastro que explicar.
 *
 * ---------------------------------------------------------------------------
 * DONDE SE ESCRIBE CADA COSA. La decision, tomada el 18/08/2026
 *
 * La bitacora vive en D1. Los cambios de plata viven adentro del Durable Object.
 * No hay una transaccion que abarque a los dos, asi que "todo en la misma
 * transaccion" es imposible y habia que elegir con los ojos abiertos.
 *
 * Se eligio segun DONDE NACE EL HECHO, y son dos caminos declarados:
 *
 *   · Lo que cambia en D1 —crear una persona, otorgar o revocar una capacidad—
 *     se asienta EN EL MISMO `batch()` que el cambio. Un `batch` de D1 es una
 *     transaccion: o entran el cambio y su registro, o no entra ninguno. Esto es
 *     la ley 5 al pie de la letra, y es la razon por la que este modulo devuelve
 *     una sentencia preparada en vez de escribir por su cuenta. Quien quiera
 *     saltearse el registro tiene que salirse del camino a proposito.
 *
 *   · Lo que nace adentro de la billetera se registra ANTES de tocar la plata.
 *     El detalle esta en `api/rutas.ts`, y el resumen es: la bitacora anota la
 *     INTENCION («el actor X pidio acreditar, correlacion C») y el evento del
 *     outbox anota el HECHO, los une el `correlacion_id`. Con ese orden, plata
 *     movida sin registro de quien la pidio es estructuralmente imposible: si el
 *     registro no entra, la plata no se toca. Al reves —anotar despues— alcanza
 *     con que el Worker muera en el medio.
 *
 * Lo que ese orden cuesta, dicho: pueden quedar intenciones sin hecho. Un pedido
 * anotado cuya operacion despues fallo. Eso es correcto para un registro de
 * auditoria —un intento tambien es algo que paso— y es exactamente el error que
 * se prefiere: sobra informacion, no falta.
 */

import type { Instante } from '../dinero/momento.js'

/**
 * Las acciones que se registran, enumeradas.
 *
 * Un texto libre acá termina, sin falta, en `'capacidad_otorgada'` y
 * `'capacidad.otorgada'` conviviendo en la misma tabla, y en una consulta de
 * auditoria que devuelve la mitad de lo que hubo. No lleva CHECK en SQL a
 * proposito: la tabla es append-only y de escritor unico —este archivo— asi que
 * el tipo alcanza, y un CHECK obligaria a una migracion por cada accion nueva.
 */
export type Accion =
  | 'persona.creada'
  | 'capacidad.otorgada'
  | 'capacidad.revocada'
  | 'billetera.acreditacion.pedida'

export interface EntradaDeBitacora {
  /** Quien. `null` solo para lo que ocurre sin actor; hoy nada. */
  readonly actor_id: string | null
  readonly accion: Accion
  /** Sobre que. Un `persona_id`, un `billetera_id`. */
  readonly objetivo: string | null
  /** JSON. Ley 9: SIN datos personales. */
  readonly detalle: Record<string, unknown> | null
  readonly correlacion_id: string
  readonly ocurrido_en: Instante
}

/**
 * Las claves que no pueden entrar al `detalle` (ley 9).
 *
 * QUE ATRAPA Y QUE NO, sin adornos. Atrapa el caso real —alguien mete el objeto
 * de la persona entero en el detalle «para que se entienda mejor»— que es como
 * los datos personales llegan a los registros en todos los sistemas donde
 * llegaron. NO atrapa un dato personal escondido en un campo con otro nombre, ni
 * un nombre y apellido dentro de un texto libre. Eso no lo puede ver ninguna
 * lista.
 *
 * Se escribe la limitacion acá porque una lista de bloqueo con un comentario que
 * diga «garantiza la ley 9» seria exactamente el defecto que este proyecto
 * declara como su causa raiz: un comentario que promete lo que el codigo no hace.
 */
const CLAVES_PERSONALES: readonly string[] = [
  'nombre',
  'apellido',
  'email',
  'correo',
  'telefono',
  'celular',
  'documento',
  'cedula',
  'ruc',
  'direccion',
  'clave',
  'contrasena',
  'password',
  'token',
]

export class DatoPersonalEnBitacora extends Error {
  constructor(readonly clave: string) {
    super(
      `ley 9: "${clave}" no puede entrar al detalle de la bitacora. ` +
        'Guarda el identificador y que el que necesite el dato lo pida donde vive.',
    )
    this.name = 'DatoPersonalEnBitacora'
  }
}

/**
 * Recorre el detalle ENTERO, no solo el primer nivel: `{ persona: { email } }` es
 * la forma que toma en cuanto alguien anida un objeto, que es siempre.
 */
export function revisarDetalle(detalle: unknown): void {
  // Las listas NO llevan una rama propia, y eso lo decidio el arnes de mutacion:
  // se escribio una, y sacarla SOBREVIVIO. El motivo es que `Object.entries` sobre
  // un array devuelve sus indices como claves —`'0'`, `'1'`— y ninguna de esas
  // esta en la lista de bloqueo, asi que la recursion baja igual a los elementos.
  // La rama era codigo muerto con cara de hacer algo, que es peor que no tenerlo.
  // La prueba que la cubria se queda: lo que importa es que el dato personal
  // adentro de una lista se atrape, no por que camino.
  if (typeof detalle !== 'object' || detalle === null) return

  for (const [clave, valor] of Object.entries(detalle)) {
    if (CLAVES_PERSONALES.includes(clave.toLowerCase())) throw new DatoPersonalEnBitacora(clave)
    revisarDetalle(valor)
  }
}

/**
 * Las columnas, en UN solo lugar.
 *
 * Hay dos formas de insertar —incondicional y condicionada— y la unica manera de
 * que no diverjan el dia que la tabla gane una columna es que las dos salgan de
 * acá. Un segundo `INSERT INTO bitacora (...)` escrito a mano en otro archivo es
 * como se llega a una auditoria con la mitad de los campos en blanco.
 */
const COLUMNAS = 'actor_id, accion, objetivo, detalle, correlacion_id, ocurrido_en'
const HUECOS = '?, ?, ?, ?, ?, ?'

function valores(e: EntradaDeBitacora): unknown[] {
  revisarDetalle(e.detalle)
  return [
    e.actor_id,
    e.accion,
    e.objetivo,
    e.detalle === null ? null : JSON.stringify(e.detalle),
    e.correlacion_id,
    e.ocurrido_en,
  ]
}

/**
 * La sentencia, para meterla en el MISMO `batch()` que el cambio que registra.
 *
 * Devuelve una sentencia en lugar de escribir, y esa es toda la decision de
 * diseño de este modulo: si expusiera un `registrar(d1, entrada)` que escribe por
 * su cuenta, el registro quedaria en una transaccion distinta de la del cambio y
 * la ley 5 seria una intencion. Asi, la unica forma de usarlo es junto al cambio.
 */
export function sentenciaDeBitacora(d1: D1Database, e: EntradaDeBitacora): D1PreparedStatement {
  return d1
    .prepare(`INSERT INTO bitacora (${COLUMNAS}) VALUES (${HUECOS})`)
    .bind(...valores(e))
}

/**
 * Igual, pero el registro entra SOLO si la condicion se cumple dentro de la misma
 * transaccion.
 *
 * EL PROBLEMA QUE RESUELVE, con nombre y apellido: revocar una capacidad es un
 * `UPDATE ... WHERE hasta IS NULL`, y ese UPDATE puede tocar cero filas —porque
 * ya la habian revocado un instante antes—. Con un INSERT incondicional al lado,
 * la bitacora afirmaria «se revoco» cuando no se revoco nada. Un registro de
 * auditoria que dice algo que no paso es peor que no tener registro: al segundo
 * se le busca la vuelta, al primero se le cree.
 *
 * Se podria haber resuelto leyendo antes y decidiendo en TypeScript. No alcanza:
 * entre la lectura y la escritura hay otra peticion posible, y volveriamos al
 * mismo renglon falso, solo que mas dificil de reproducir.
 *
 * COMO SE USA, Y ESTO NO ES OPCIONAL: la condicion tiene que ser el MISMO
 * predicado que decide el cambio, y esta sentencia tiene que ir ANTES del cambio
 * en el `batch`. La primera version de la entrega 1.2 la ponia despues y
 * condicionaba sobre el valor recien escrito (`hasta = <momento>`), que NO es lo
 * mismo que «el UPDATE toco una fila»: una auditoria midio dos revocaciones en el
 * mismo milisegundo escribiendo dos renglones, con esta funcion puesta y con el
 * comentario de arriba diciendo que era imposible. Ver `revocarCapacidad`.
 */
export function sentenciaDeBitacoraSi(
  d1: D1Database,
  e: EntradaDeBitacora,
  condicion: { readonly sql: string; readonly valores: readonly unknown[] },
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO bitacora (${COLUMNAS}) SELECT ${HUECOS} WHERE EXISTS (${condicion.sql})`,
    )
    .bind(...valores(e), ...condicion.valores)
}

/**
 * El unico caso que escribe sola: la intencion, ANTES de tocar el Durable Object.
 *
 * No tiene con quien compartir transaccion —el cambio va a ocurrir del otro lado
 * de una frontera de Durable Object— y por eso existe aparte, con este parrafo
 * arriba en vez de escondida como una sobrecarga del anterior. Que se vea que es
 * la excepcion, y por que.
 */
export async function registrarIntencion(d1: D1Database, e: EntradaDeBitacora): Promise<void> {
  await sentenciaDeBitacora(d1, e).run()
}

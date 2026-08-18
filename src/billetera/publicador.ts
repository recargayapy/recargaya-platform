/**
 * El publicador del outbox: lo que decide QUE se copia a D1 y CON QUE SQL.
 *
 * Todo lo de este archivo es puro. No toca la base, no lee el reloj, no llama a
 * Cloudflare: recibe filas del outbox y devuelve sentencias. El Durable Object es
 * el que las ejecuta.
 *
 * Esa separacion no es estetica. Las pruebas de `tests/` corren en Node en
 * milisegundos y son las que la mutacion ataca decenas de veces; si la decision de
 * "a que tabla va cada fila" viviera adentro del DO, cada mutacion sobre ella
 * pagaria el arranque de workerd.
 *
 * ---------------------------------------------------------------------------
 * QUE PROBLEMA CIERRA ESTE ARCHIVO
 *
 * La ley 5 estaba a medias. El evento se escribia en la misma transaccion que el
 * cambio —eso ya funcionaba— y ahi se quedaba. El outbox del BilleteraDO crecia y
 * D1 no se enteraba de nada: `ledger_copia`, que 0001 declara como "la copia que
 * llega por outbox", estaba vacia porque no habia outbox que la llenara.
 *
 * ---------------------------------------------------------------------------
 * LEY 6, Y POR QUE NO ES UNA PROMESA
 *
 * El publicador entrega doble POR CONSTRUCCION: escribe en D1 y despues marca la
 * fila como publicada en el DO. Entre esas dos cosas hay una ventana, y si el
 * objeto se cae ahi, la proxima pasada manda lo mismo de nuevo.
 *
 * No se intenta cerrar esa ventana —no se puede, son dos sistemas— se hace que no
 * importe. Cada destino tiene una clave primaria natural que absorbe el duplicado:
 *
 *   · `ledger_copia`      → `asiento_id`, que ya venia de 0001
 *   · `eventos_billetera` → `(billetera_id, evento_id)`, donde `evento_id` es el
 *     `id` del outbox del DO: un AUTOINCREMENT, monotono y estable
 *
 * Y las dos escrituras van con `INSERT OR IGNORE`. La idempotencia deja de
 * depender de que el publicador se porte bien.
 *
 * OJO: `OR IGNORE`, nunca `OR REPLACE`. Un REPLACE borra la fila vieja antes de
 * poner la nueva, y las dos tablas tienen un trigger `BEFORE DELETE` que aborta.
 * Es a proposito: el que escriba REPLACE se entera con un error.
 */

/**
 * El tipo con el que viaja un asiento por el outbox.
 *
 * El asiento tambien sale por el outbox, y eso es una decision con consecuencia:
 * `repositorio.ts` escribe esta fila EN EL MISMO LUGAR donde inserta el asiento, no
 * como un evento que el nucleo tenga que acordarse de emitir. Asi ninguna operacion
 * futura puede escribir un asiento y dejarlo sin copia — no hay nada que recordar.
 *
 * La alternativa era una segunda cola: marcar en `asientos` cual ya se copio. No
 * sirve, y por una razon que ya estaba escrita: la ley 2 prohibe el UPDATE sobre
 * esa tabla, y hay dos triggers que lo hacen cumplir. Una columna `copiado_en` ahi
 * seria una columna que nadie puede mover.
 */
export const TIPO_ASIENTO = 'ledger.asiento'

/** Cuantas filas del outbox entran en una pasada. D1 acepta lotes bastante mas
 *  grandes; el numero es chico a proposito porque cada pasada es una transaccion
 *  de D1 entera que se reintenta completa si falla. */
export const LOTE = 50

/** Cuantas pasadas hace el publicador antes de devolver el control. Es un tope de
 *  cortesia y no una limitacion: lo que quede pendiente reprograma la alarma. Sin
 *  el, una billetera con miles de eventos atrasados tendria el objeto tomado hasta
 *  vaciarlos, y toda operacion de plata esperando detras. */
export const PASADAS_MAXIMAS = 20

/** El techo del retraso entre reintentos. Cinco minutos: lo bastante como para no
 *  martillar una D1 caida, lo bastante poco como para que la copia no se atrase un
 *  turno entero cuando vuelve. */
export const RETRASO_MAXIMO_MS = 5 * 60 * 1000

/** Una fila pendiente del outbox del Durable Object. */
export interface FilaDelOutbox {
  readonly id: number
  readonly tipo: string
  readonly cuerpo: string
  readonly correlacion_id: string
  readonly creado_en: string
}

/** Una sentencia lista para D1: el SQL y sus valores, por separado. Nunca
 *  interpolados — el cuerpo de un evento es texto que viene de afuera. */
export interface Sentencia {
  readonly sql: string
  readonly valores: readonly unknown[]
}

const INSERTAR_ASIENTO =
  'INSERT OR IGNORE INTO ledger_copia (asiento_id, billetera_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en, copiado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'

const INSERTAR_EVENTO =
  'INSERT OR IGNORE INTO eventos_billetera (billetera_id, evento_id, tipo, cuerpo, correlacion_id, creado_en, copiado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'

/**
 * A que tabla de D1 va una fila del outbox.
 *
 * Es una funcion y no un `if` adentro del armador para que la mutacion tenga un
 * solo lugar donde romperla, y para que la regla se lea de un vistazo: el asiento
 * va al ledger, todo lo demas va al registro de eventos.
 */
export function destino(tipo: string): 'ledger_copia' | 'eventos_billetera' {
  return tipo === TIPO_ASIENTO ? 'ledger_copia' : 'eventos_billetera'
}

/** El cuerpo con el que viaja un asiento. Se valida al leerlo y no se confia en
 *  que este bien formado: un `JSON.parse` sin comprobar deja entrar `undefined`
 *  en una columna NOT NULL y el error sale a kilometros del origen. */
interface CuerpoDeAsiento {
  readonly asiento_id: string
  readonly concepto: string
  readonly monto: number
  readonly bolsa: string
  readonly clave_idem: string
  readonly correlacion_id: string
  readonly asentado_en: string
}

function leerAsiento(fila: FilaDelOutbox): CuerpoDeAsiento {
  let d: unknown
  try {
    d = JSON.parse(fila.cuerpo)
  } catch {
    throw new Error(`la fila ${fila.id} del outbox dice ser un asiento y su cuerpo no es JSON`)
  }

  const c = d as Partial<CuerpoDeAsiento>
  const falta =
    typeof c.asiento_id !== 'string' ||
    typeof c.concepto !== 'string' ||
    typeof c.monto !== 'number' ||
    typeof c.bolsa !== 'string' ||
    typeof c.clave_idem !== 'string' ||
    typeof c.correlacion_id !== 'string' ||
    typeof c.asentado_en !== 'string'

  if (falta) {
    throw new Error(`la fila ${fila.id} del outbox dice ser un asiento y no tiene forma de asiento`)
  }
  return c as CuerpoDeAsiento
}

/**
 * Las sentencias que hay que correr en D1 para publicar este lote.
 *
 * Salen en el mismo orden que las filas: el `id` del outbox es monotono, asi que
 * publicar en ese orden es publicar en el orden en que la plata se movio.
 *
 * `billetera_id` entra por parametro y no viaja adentro de cada fila del outbox a
 * proposito. Todas las filas de una pasada salen del MISMO Durable Object —el que
 * las esta publicando— asi que repetirlo en cada cuerpo seria guardar el mismo
 * texto una vez por asiento adentro del objeto que ya se llama asi.
 */
export function sentencias(
  billetera_id: string,
  filas: readonly FilaDelOutbox[],
  momento: string,
): Sentencia[] {
  return filas.map((f) => {
    if (destino(f.tipo) === 'ledger_copia') {
      const a = leerAsiento(f)
      return {
        sql: INSERTAR_ASIENTO,
        valores: [
          a.asiento_id,
          billetera_id,
          a.concepto,
          a.monto,
          a.bolsa,
          a.clave_idem,
          a.correlacion_id,
          a.asentado_en,
          momento,
        ],
      }
    }

    return {
      sql: INSERTAR_EVENTO,
      valores: [
        billetera_id,
        f.id,
        f.tipo,
        f.cuerpo,
        f.correlacion_id,
        f.creado_en,
        momento,
      ],
    }
  })
}

/**
 * Cuanto esperar antes del proximo intento, segun cuantas veces ya fallo.
 *
 * Cero intentos fallidos → CERO. Eso no es un detalle: es lo que hace que la copia
 * a D1 llegue en milisegundos despues de la operacion, sin que el que movio la
 * plata pague la latencia de D1 en su propia llamada. La alarma se programa para
 * "ahora" y publica ni bien la operacion suelta el objeto.
 *
 * A partir del primer fallo se duplica: 1s, 2s, 4s… con techo. Sin el techo, diez
 * fallos serian ocho minutos y medio (512 s) y veinte serian seis dias (524.288 s).
 *
 * (Decia «doce dias», y lo corrigio la segunda vuelta de auditoria contando. Lo que
 * hace que valga la pena anotarlo: la primera vuelta habia auditado los numeros de
 * esta misma funcion y corregido los de las pruebas, dejando el del encabezado. Se
 * arreglo el caso y no la categoria, adentro del arreglo que trataba de esto.)
 *
 * SOBRE EL DESBORDE, porque la version anterior de este comentario mentia:
 *
 * `2 ** 1024` es `Infinity`, y `setAlarm(Infinity)` no es una espera larga, es un
 * error. La primera version tenia una guarda aparte —`if (intentos > 20) return
 * RETRASO_MAXIMO_MS`— con un parrafo explicando que hacia falta para evitar eso.
 * No hacia falta: `Math.min(Infinity, 300_000)` ya devuelve `300_000`. Era codigo
 * muerto con un comentario prometiendo lo que otra linea ya hacia, que es la causa
 * raiz declarada del proyecto puesta adentro del arreglo. Se saco la guarda y quedo
 * la prueba, que es lo que sostiene que `Math.min` lo absorbe.
 */
export function retrasoPorIntentos(intentos: number): number {
  if (intentos <= 0) return 0
  return Math.min(2 ** (intentos - 1) * 1000, RETRASO_MAXIMO_MS)
}

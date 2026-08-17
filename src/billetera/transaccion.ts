/**
 * La transaccion de storage del Durable Object, en un solo lugar.
 *
 * Ley 5: todo evento se escribe EN LA MISMA TRANSACCION que el cambio. Esa ley no
 * tenia oraculo. Una auditoria de la entrega anterior lo midio sin ambiguedad:
 *
 *   Si el DO escribiera el asiento y el evento del outbox en dos `exec` sueltos,
 *   sin transaccion, las catorce pruebas del runtime pasaban igual.
 *
 * Las pruebas comprobaban que `ctx.storage.transaction()` deshace — o sea, que
 * Cloudflare implementa transacciones. Nadie comprobaba que nuestro codigo las use.
 *
 * Esta funcion existe para que haya UNA linea que romper. La prueba de rollback
 * llama a este helper, y hay una mutacion que le saca la transaccion y tiene que
 * morir. Sin un lugar unico, no hay nada que mutar.
 *
 * ---------------------------------------------------------------------------
 * POR QUE LA VERSION SINCRONA
 *
 * Estan las dos, y las dos deshacen — medido en la entrega anterior, justamente
 * porque el arnes fijaba una sin haberlo verificado. La eleccion es `transactionSync`
 * y el motivo es lo que NO deja hacer:
 *
 *   `transactionSync` no puede envolver un `await`.
 *
 * Eso, que suena a limitacion, es la garantia. Una transaccion que abarca I/O
 * externo —una llamada a un proveedor, un fetch— queda abierta mientras espera, con
 * el input gate del objeto cerrado: la billetera entera se bloquea a la velocidad
 * de la red de un tercero. Con la version sincrona eso no se puede escribir aunque
 * alguien quiera.
 *
 * La regla que queda, y es corta: adentro de `enUnaTransaccion` va SQL y nada mas.
 * Lo que necesite `await` se resuelve antes o despues, nunca adentro.
 */

/** Lo minimo que este helper necesita del contexto del Durable Object. Se declara
 *  asi y no como `DurableObjectState` entero para que las pruebas puedan pasarle
 *  un contexto real sin arrastrar el objeto completo. */
export interface ConTransaccion {
  readonly storage: {
    transactionSync<T>(cierre: () => T): T
  }
}

/**
 * Corre `cambios` adentro de una transaccion de storage.
 *
 * Todo lo que escriba adentro se confirma junto o no se confirma nada. Si `cambios`
 * tira, la transaccion se deshace y el error sale para arriba sin tocar.
 *
 * El valor que devuelve `cambios` se devuelve tal cual, para que quien llama pueda
 * sacar de la transaccion lo que calculo adentro sin volver a consultar.
 */
export function enUnaTransaccion<T>(ctx: ConTransaccion, cambios: () => T): T {
  return ctx.storage.transactionSync(cambios)
}

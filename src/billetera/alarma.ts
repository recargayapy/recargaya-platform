/**
 * Cuando tiene que despertar el Durable Object. Una decision pura, en un archivo.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTO ES UNA FUNCION Y NO CUATRO `if` ADENTRO DEL DURABLE OBJECT
 *
 * Lo pidio el arnes de mutacion, y la historia vale escribirla porque es la
 * segunda vez que este proyecto llega a la misma conclusion por el mismo camino.
 *
 * Con la logica adentro del DO, la mutacion que le sacaba la rama de «hay reservas
 * YA vencidas» SOBREVIVIO. No porque la rama sobrara: porque en todo escenario que
 * las pruebas podian armar, el outbox tambien tenia algo pendiente y programaba la
 * alarma para el mismo instante. La rama solo manda cuando el outbox esta vacio Y
 * hay algo vencido, y ese estado, desde afuera del objeto, solo se puede provocar
 * y despues observar ganandole a una alarma que se dispara sola. Una prueba asi es
 * una carrera, y una prueba que es una carrera no es un oraculo.
 *
 * Con la decision acá, el estado se arma en una linea y se afirma sobre el numero
 * que devuelve. Sin runtime, sin reloj, sin carrera.
 *
 * ---------------------------------------------------------------------------
 * LOS DOS MOTIVOS TIENEN LA MISMA FORMA
 *
 * Una reserva vencida y una fila del outbox sin publicar piden lo mismo: «hay algo
 * que hacer YA, y si al hacerlo falla, hay que volver a intentar mas tarde». Los
 * dos usan `retrasoPorIntentos`, y por eso ninguno de los dos puede convertirse en
 * un bucle: con cero fracasos el retraso es cero, y de ahi crece con techo.
 *
 * La primera version tenia el outbox con contador y el vencimiento con un booleano.
 * Esa asimetria es la que produjo el bucle de 185 disparos por segundo que la
 * segunda vuelta de auditoria midio.
 *
 * ---------------------------------------------------------------------------
 * POR QUE LA RAMA DE LO YA VENCIDO NO SOBRA
 *
 * `reservasVencidas` devuelve como «proximo vencimiento» solo lo que vence MAS
 * ADELANTE. Una reserva que ya vencio no aparece ahi. Asi que sin esa rama, el
 * estado «una reserva vencida y el outbox vacio» no produce ningun motivo, la
 * alarma se borra, y esa plata queda retenida para siempre.
 *
 * Y ese estado no es raro: es exactamente donde termina `alarm()`. Publica —lo que
 * vacia el outbox— y despues reprograma. Si una reserva vencio entre la liberacion
 * y esa linea, no queda nadie que la vaya a mirar.
 */

import { retrasoPorIntentos } from './publicador.js'

export interface MotivosParaDespertar {
  /** El instante desde el que se cuenta. Entra por parametro y no se lee acá: el
   *  reloj es del que llama, para que esto se pueda probar sin esperar. */
  readonly ahora: number
  /**
   * Cuantas veces seguidas fallo la liberacion de las reservas ya vencidas, o
   * `null` si no hay ninguna vencida. Cero es «hay vencidas y nunca fallaron».
   *
   * ES UN NUMERO Y NO UN `hayVencidas: boolean`, y eso lo corrigio la segunda
   * vuelta de auditoria midiendo el desastre que causaba el booleano:
   *
   * La entrega anterior habia envuelto la liberacion en un `try/catch` para que una
   * reserva descuadrada no se llevara puesto al publicador. Correcto en su
   * intencion, y abrio otra cosa: el `catch` sigue de largo, `reprogramarAlarma`
   * vuelve a ver la reserva vencida y abierta, y programa la alarma para AHORA. Se
   * dispara, vuelve a fallar, se vuelve a programar.
   *
   * Medido sobre workerd, con una sola invocacion de `alarm()` y sin tocar el
   * objeto despues: ~185 disparos por segundo, sostenidos, sin señal de frenar. Un
   * Durable Object despierto al 100 % para siempre —que se factura por duracion—
   * martillando D1 en cada vuelta, y sin un solo error visible, porque `alarm()` ya
   * no tira. El control con la liberacion sana daba dos disparos en 1,8 segundos.
   *
   * O sea: el arreglo cerro «la alarma entra en bucle» por una causa y lo abrio por
   * otra. La forma correcta es la que el outbox ya usaba — contar los fracasos y
   * esperar mas cada vez— y aplicarla a los dos motivos, no a uno.
   */
  readonly intentosDeLasVencidas: number | null
  /** El proximo vencimiento PENDIENTE, en ISO-8601, o `null` si no hay. */
  readonly proximoVencimiento: string | null
  /** Los intentos fallidos de la fila mas vieja sin publicar, o `null` si el
   *  outbox esta vacio. Con cero intentos el retraso es cero: se publica ya. */
  readonly intentosDeLaCabeza: number | null
}

/**
 * El instante de la proxima alarma, o `null` para borrarla.
 *
 * Hay UNA alarma por Durable Object, no una cola: programar la de un motivo pisa
 * la del otro. Por eso esto no elige "el motivo importante" sino EL MAS CERCANO, y
 * `alarm()` atiende todos los motivos en cada disparo sin fijarse cual lo desperto.
 * Esas dos cosas juntas son lo que hace que compartir la alarma sea seguro.
 */
export function cuandoDespertar(m: MotivosParaDespertar): number | null {
  const motivos: number[] = []

  // Lo ya vencido va para lo antes posible — mientras liberarlo funcione. Ver el
  // encabezado de `intentosDeLasVencidas`: esta rama es la unica que cubre el
  // estado «vencido y con el outbox vacio», y el retraso es lo unico que impide
  // que una reserva que NO se puede liberar deje al objeto girando para siempre.
  if (m.intentosDeLasVencidas !== null) {
    motivos.push(m.ahora + retrasoPorIntentos(m.intentosDeLasVencidas))
  } else if (m.proximoVencimiento !== null) {
    motivos.push(Date.parse(m.proximoVencimiento))
  }

  if (m.intentosDeLaCabeza !== null) {
    motivos.push(m.ahora + retrasoPorIntentos(m.intentosDeLaCabeza))
  }

  if (motivos.length === 0) return null
  return Math.min(...motivos)
}

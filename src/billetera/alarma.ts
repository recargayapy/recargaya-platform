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
  /** Si hay reservas abiertas que YA vencieron. Hay que devolver esa plata ya. */
  readonly hayVencidas: boolean
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

  // Lo ya vencido va para lo antes posible. Ver el encabezado: esta rama es la
  // unica que cubre el estado «vencido y con el outbox vacio».
  if (m.hayVencidas) motivos.push(m.ahora)
  else if (m.proximoVencimiento !== null) motivos.push(Date.parse(m.proximoVencimiento))

  if (m.intentosDeLaCabeza !== null) {
    motivos.push(m.ahora + retrasoPorIntentos(m.intentosDeLaCabeza))
  }

  if (motivos.length === 0) return null
  return Math.min(...motivos)
}

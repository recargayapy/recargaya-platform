/**
 * El numero de pedido: como se arma y que se acepta como año.
 *
 * Sin un solo import. Es a proposito y tiene dos motivos.
 *
 * El primero es de ciclos: lo usan `index.ts` —adentro de `SecuenciaDO`— y
 * `pedidos/pedidos.ts`, y `pedidos.ts` ya importa tipos de `index.ts`. Un modulo
 * hoja no puede cerrar ningun ciclo.
 *
 * El segundo lo pidio una medicion. La validacion del año vivia adentro del metodo
 * del Durable Object, y la unica forma de probarla era llamar al objeto y esperar
 * que rechazara. Eso funciona —el rechazo llega— pero el rechazo de un metodo RPC
 * que tira antes de su primer `await` sube ADEMAS como «unhandled error» del
 * runtime, y vitest cuenta esos errores aunque las 158 pruebas pasen: la corrida
 * termina en verde con `Errors 3` y codigo de salida distinto de cero. O sea que un
 * guarda razonable dejaba el oraculo del runtime en rojo, y con el oraculo en rojo
 * el arnes de mutacion no vale nada («sobre un arbol en rojo, toda mutacion se
 * reporta muerta»).
 *
 * La salida no es sacar el guarda ni aflojar el oraculo: es que la regla sea PURA y
 * el Durable Object la llame. Se prueba en Node, en milisegundos, y la mutacion la
 * puede atacar sin levantar workerd.
 */

/**
 * Los seis digitos del correlativo.
 *
 * Un año con mas de 999.999 pedidos desborda el ancho y el numero pasa a tener
 * siete: `RY-2026-1000000`. Sigue siendo unico —el correlativo no se repite— y
 * sigue ordenando mal como TEXTO, que es un problema de listados y no de identidad.
 * Cuando eso deje de ser una hipotesis se cambia el ancho, y ese dia hay que mirar
 * los indices que ordenan por `id`.
 */
export const ANCHO_DEL_CORRELATIVO = 6

/** El primer año que este sistema puede numerar, y el ultimo que entra en cuatro
 *  digitos. Los dos bordes existen porque el año termina EN EL TEXTO del numero. */
export const ANIO_MINIMO = 2000
export const ANIO_MAXIMO = 9999

export class AnioInvalido extends Error {
  constructor(readonly anio: unknown) {
    super(
      `año invalido para la secuencia: ${String(anio)} (se espera un entero entre ${ANIO_MINIMO} y ${ANIO_MAXIMO})`,
    )
    this.name = 'AnioInvalido'
  }
}

/**
 * Comprueba el año antes de que llegue al texto del numero.
 *
 * Sin esto, un año fraccionario o negativo produce `RY-2026.5-000001` o
 * `RY--1-000001`, y los dos pasan por la columna sin quejarse porque `pedidos.id`
 * es TEXT. Un identificador con la forma rota no rompe nada hoy: rompe el dia que
 * alguien lo parsee.
 */
export function exigirAnio(anio: number): number {
  if (!Number.isInteger(anio) || anio < ANIO_MINIMO || anio > ANIO_MAXIMO) {
    throw new AnioInvalido(anio)
  }
  return anio
}

/** `RY-2026-000001`. El unico lugar que arma la forma. */
export function numeroDePedido(anio: number, correlativo: number): string {
  exigirAnio(anio)
  if (!Number.isInteger(correlativo) || correlativo < 1) {
    throw new Error(`correlativo invalido: ${String(correlativo)}`)
  }
  return `RY-${anio}-${String(correlativo).padStart(ANCHO_DEL_CORRELATIVO, '0')}`
}

/**
 * La forma del numero, para validar lo que llega por la URL.
 *
 * Los seis digitos son un MINIMO y no un exacto: ver `ANCHO_DEL_CORRELATIVO`. Una
 * expresion regular que rechazara el pedido un millon convertiria ese pedido en un
 * apagon.
 */
export const PEDIDO_VALIDO = /^RY-\d{4}-\d{6,12}$/

export function pedidoIdValido(valor: unknown): valor is string {
  return typeof valor === 'string' && PEDIDO_VALIDO.test(valor)
}

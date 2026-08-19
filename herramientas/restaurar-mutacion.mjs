#!/usr/bin/env node
/**
 * Lo PRIMERO que corre `npm run verificar`: si una corrida de mutacion murio con un
 * archivo mutado, lo deja como estaba.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NO ALCANZA CON EL SEGURO QUE VIVE ADENTRO DE `mutar.mjs`
 *
 * `mutar` es el OCTAVO paso de los ocho de `verificar`. La segunda vuelta de auditoria
 * de la entrega 1.3 lo midio: con una mutacion viva en el arbol, `verificar` muere en
 * el TERCER paso —las pruebas del nucleo, que es justamente lo que la mutacion rompe—
 * y la restauracion que vive adentro de `mutar` no corre nunca.
 *
 *     FAIL  tests/pedido.test.ts > ninguna transicion declarada puede dejar plata …
 *     --- nota sigue? ---
 *     herramientas/.mutacion-en-vuelo.json
 *     103:export const RETIENEN_PLATA: … = new Set<EstadoPedido>([])
 *
 * O sea que el seguro se disparaba justo en el caso que NO lo necesitaba —la mutacion
 * no la ve nadie porque `verificar` llega hasta el final— y no en el que si: el
 * desarrollador se pasa media hora buscando un defecto que dejo escrito una corrida
 * muerta.
 *
 * La logica no se duplica: vive en `mutacion-en-vuelo.mjs` y la usan los dos.
 *
 * Uso: node herramientas/restaurar-mutacion.mjs
 */

import { restaurarLoQueQuedoDeAntes } from './mutacion-en-vuelo.mjs'
import { invocadoDirecto } from './invocado-directo.mjs'

if (invocadoDirecto(import.meta)) {
  // Sale con 0 haya restaurado o no: no es un oraculo, es una limpieza. El unico
  // camino que sale con 1 es el de «el archivo cambio por otra razon», y ese lo decide
  // `restaurarLoQueQuedoDeAntes`, que sale ahi mismo.
  const restauro = restaurarLoQueQuedoDeAntes()
  if (!restauro) console.log('  restaurar-mutacion: nada que restaurar')
}

/**
 * El arnes compartido de las pruebas del runtime: migraciones, tokens, llamadas
 * HTTP y personas de prueba.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE, Y POR QUE RECIEN AHORA
 *
 * `api.test.ts` y `auditoria.test.ts` tenian estas mismas ochenta lineas copiadas,
 * palabra por palabra. Con dos copias todavia se puede argumentar que es el precio
 * de que cada archivo se lea solo. La entrega 1.3 traia la TERCERA, y tres copias
 * de un arnes no es una decision de legibilidad: es la garantia de que un dia dos
 * de ellas no van a probar lo mismo.
 *
 * El caso concreto que esto cierra: `llamar()` decide como se manda el token. El
 * dia que el encabezado cambie —o que aparezca un segundo mecanismo— hay que
 * tocarlo en tres lugares, y el archivo que quede sin tocar sigue en verde
 * probando la puerta vieja. Es exactamente el defecto que `check-entorno.mjs` y
 * `check-esquema.mjs` existen para cerrar en otras fronteras: un doble que nadie
 * compara.
 *
 * ---------------------------------------------------------------------------
 * LO QUE ESTE ARCHIVO NO HACE
 *
 * No arma dobles de nada. `env`, `SELF` y `applyD1Migrations` son los de
 * `cloudflare:test`, o sea D1 y workerd de verdad; acá solo se junta el pegamento.
 * Un arnes que simulara la base probaria el arnes, que es lo que este proyecto ya
 * rechazo una vez con la «tabla de juguete».
 */

import { env, SELF, applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { expect } from 'vitest'
import { emitirToken } from '../src/identidad/actor.js'

/** Ver el encabezado del binding en `vitest.runtime.config.ts`: es un valor de
 *  juguete, y que no sirva para nada afuera es la razon por la que puede estar
 *  escrito. */
export const SECRETO = (env as unknown as { SECRETO_SERVICIO: string }).SECRETO_SERVICIO

/** Las migraciones de VERDAD, leidas de la misma carpeta que despliega wrangler. */
export const MIGRACIONES = (env as unknown as { MIGRACIONES: D1Migration[] }).MIGRACIONES

/**
 * Aplica las migraciones y comprueba que haya alguna.
 *
 * La comprobacion no es decorativa: `readD1Migrations` sobre un directorio
 * equivocado devuelve una lista VACIA sin quejarse, y todas las pruebas de esquema
 * pasarian contra una base sin tablas — fallando por «no such table», que se lee
 * como un problema de la prueba y no del arnes.
 */
export async function aplicarMigraciones(): Promise<void> {
  expect(Array.isArray(MIGRACIONES)).toBe(true)
  expect(MIGRACIONES.length).toBeGreaterThan(0)
  await applyD1Migrations(env.CORE, MIGRACIONES)
}

export const ahora = (): string => new Date().toISOString()

export const tokenDePlataforma = (): Promise<string> =>
  emitirToken(
    { actor: { tipo: 'plataforma' }, emitido_en: ahora() as never, entorno: env.ENTORNO },
    SECRETO,
  )

export const tokenDePersona = (persona_id: string): Promise<string> =>
  emitirToken(
    { actor: { tipo: 'persona', persona_id }, emitido_en: ahora() as never, entorno: env.ENTORNO },
    SECRETO,
  )

export interface Opciones {
  token?: string
  cuerpo?: unknown
  correlacion?: string
}

export async function llamar(metodo: string, ruta: string, o: Opciones = {}): Promise<Response> {
  const encabezados: Record<string, string> = {}
  if (o.token !== undefined) encabezados['authorization'] = `Bearer ${o.token}`
  if (o.correlacion !== undefined) encabezados['x-correlacion-id'] = o.correlacion
  if (o.cuerpo !== undefined) encabezados['content-type'] = 'application/json'

  // El cuerpo se agrega solo si lo hay: con `exactOptionalPropertyTypes`, pasar
  // `undefined` explicito no es lo mismo que no pasar la clave, y el tipo de
  // `RequestInit` no admite el primero.
  return SELF.fetch(`https://prueba.test${ruta}`, {
    method: metodo,
    headers: encabezados,
    ...(o.cuerpo === undefined ? {} : { body: JSON.stringify(o.cuerpo) }),
  })
}

/**
 * Los ayudantes del pedido y de la plata. Viven acá desde que la entrega 1.3 sumo un
 * segundo archivo de pruebas del runtime que los necesitaba: es el mismo criterio
 * que hizo nacer este arnes, aplicado en cuanto aparecio la segunda copia y no
 * despues de la tercera.
 */

/** Acredita plata a una persona, para que tenga con que pedir. */
export async function acreditar(persona_id: string, monto: number, clave: string): Promise<void> {
  const token = await tokenDePlataforma()
  const r = await llamar('POST', '/billetera/acreditar', {
    token,
    cuerpo: { persona_id, monto, bolsa: 'disponible', clave_idem: clave },
  })
  expect(r.status).toBe(200)
}

export interface Bolsa {
  tipo: string
  monto: number
  origen?: string
  vence_en?: string | null
}

export async function bolsas(persona_id: string): Promise<Bolsa[]> {
  const token = await tokenDePlataforma()
  const r = await llamar('GET', `/billetera/${persona_id}/saldo`, { token })
  expect(r.status).toBe(200)
  return ((await r.json()) as { bolsas: Bolsa[] }).bolsas
}

export const sumar = (b: Bolsa[], tipo: string): number =>
  b.filter((x) => x.tipo === tipo).reduce((a, x) => a + x.monto, 0)

export async function pedir(
  persona_id: string,
  monto: number,
  clave_idem: string,
  token?: string,
): Promise<Response> {
  return llamar('POST', '/pedidos', {
    token: token ?? (await tokenDePlataforma()),
    cuerpo: { comprador_id: persona_id, monto, clave_idem },
  })
}

/** Cuantos renglones de esa accion quedaron escritos sobre ese objetivo. */
export async function renglones(objetivo: string, accion: string): Promise<number> {
  const r = await env.CORE.prepare(
    'SELECT COUNT(*) AS n FROM bitacora WHERE objetivo = ? AND accion = ?',
  )
    .bind(objetivo, accion)
    .first<{ n: number }>()
  return r?.n ?? 0
}

/** El numero que la secuencia va a entregar despues del que se le pase. Sirve para
 *  reproducir el envenenamiento de una clave derivada, que es predecible justamente
 *  porque el numero es correlativo. */
export function elQueSigue(pedido_id: string): string {
  const m = /^RY-(\d{4})-(\d{6})$/.exec(pedido_id)
  if (m === null) throw new Error(`no parece un numero de pedido: ${pedido_id}`)
  return `RY-${m[1]}-${String(Number(m[2]) + 1).padStart(6, '0')}`
}

/** Crea una persona con las capacidades pedidas y devuelve su id. Cada prueba usa
 *  el suyo: D1 se comparte entre pruebas del mismo archivo. */
export async function personaCon(id: string, capacidades: readonly string[]): Promise<string> {
  const token = await tokenDePlataforma()
  const r = await llamar('POST', '/personas', { token, cuerpo: { persona_id: id } })
  expect(r.status).toBe(201)
  for (const capacidad of capacidades) {
    const c = await llamar('POST', `/personas/${id}/capacidades`, { token, cuerpo: { capacidad } })
    expect(c.status).toBe(201)
  }
  return id
}

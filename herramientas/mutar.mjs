#!/usr/bin/env node
/**
 * Pruebas con mutacion.
 *
 * El metodo del proyecto lo dice sin ambiguedad: "Toda prueba nueva se valida
 * rompiendo el codigo a proposito: si la prueba no muere, no prueba nada."
 *
 * Esta herramienta rompe el codigo de verdad —una mutacion por vez, en un
 * archivo real, en disco— corre la suite entera, y exige que FALLE. Una
 * mutacion que sobrevive es un agujero en las pruebas, y se reporta como error.
 *
 * "Mutar tambien el arnes": las ultimas mutaciones de la lista atacan el arnes
 * de pruebas, no el codigo de produccion. Un arnes que no puede fallar hace que
 * todo pase.
 *
 * Uso:  node herramientas/mutar.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  ORACULO_NUCLEO,
  ORACULO_RUNTIME,
  ORACULO_TIPOS,
  entornoParaOraculo,
} from './binarios.mjs'

/** Un oraculo de Node plano: el MISMO Node que ya corre, no el que este en el
 *  PATH. Ver `binarios.mjs` — un comando por nombre depende del sistema. */
const conNode = (archivo) => [process.execPath, archivo]

// La raiz sale de la ubicacion de este archivo y no del cwd. Corrido desde
// `herramientas/` moria con un ENOENT y un stack pelado. Los tres oraculos ya lo
// resolvian asi; este quedo atras — la categoria se arreglo en tres de cuatro
// lugares, que es la forma mas facil de creer que se arreglo.
const RAIZ = fileURLToPath(new URL('..', import.meta.url))
const rutaDe = (archivo) => join(RAIZ, archivo)

/**
 * Cada mutacion nombra el invariante que ataca. Si alguna sobrevive, el nombre
 * te dice exactamente que dejaste sin probar.
 */
const MUTACIONES = [
  {
    // Nota de la primera pasada de mutacion: quitar SOLO esta linea sobrevivia,
    // porque `isSafeInteger` tambien rechaza los decimales y el codigo seguia
    // tirando `MontoInvalido` por otro camino. `toThrow(MontoInvalido)` no
    // distinguia los dos mensajes. El arreglo no es fusionar la mutacion —eso
    // perderia la granularidad de un invariante por linea— es que
    // `tests/monto.test.ts` verifique el mensaje especifico de ESTA linea.
    invariante: 'el guarani no acepta decimales (mensaje especifico)',
    archivo: 'src/dinero/monto.ts',
    de: "  if (!Number.isInteger(valor)) throw new MontoInvalido(valor, 'el guarani no tiene decimales')\n",
    a: '',
  },
  {
    invariante: 'el reparto no pierde el remanente',
    archivo: 'src/dinero/monto.ts',
    de: '    truncados[i] = (truncados[i] ?? 0) + 1\n    remanente -= 1',
    a: '    remanente -= 1',
  },
  {
    invariante: 'el desempate del reparto es estable',
    archivo: 'src/dinero/monto.ts',
    de: '.sort((a, b) => (b.resto - a.resto) || (a.i - b.i))',
    a: '.sort((a, b) => (a.resto - b.resto) || (a.i - b.i))',
  },
  {
    invariante: 'el credito de promocion se gasta antes que el disponible',
    archivo: 'src/dinero/bolsas.ts',
    de: "const PRECEDENCIA: readonly TipoBolsa[] = ['credito_promocion', 'ganancia_creador', 'disponible']",
    a: "const PRECEDENCIA: readonly TipoBolsa[] = ['disponible', 'ganancia_creador', 'credito_promocion']",
  },
  {
    invariante: 'primero vence, primero se gasta',
    archivo: 'src/dinero/bolsas.ts',
    de: 'if (va !== vb) return va < vb ? -1 : 1',
    a: 'if (va !== vb) return va < vb ? 1 : -1',
  },
  {
    invariante: 'una bolsa vencida no se consume',
    archivo: 'src/dinero/bolsas.ts',
    de: 'if (bolsa.vence_en !== null && bolsa.vence_en <= momento) continue',
    a: '',
  },
  {
    invariante: 'el credito restringido no sirve para otro proposito',
    archivo: 'src/dinero/bolsas.ts',
    de: 'if (bolsa.restringida_a !== null && bolsa.restringida_a !== opciones.proposito) continue',
    a: '',
  },
  {
    invariante: 'la regla anticajero: el credito vuelve con su vencimiento original',
    archivo: 'src/dinero/bolsas.ts',
    de: 'devueltas.push({ ...t.bolsa, monto: guaranies(monto) })',
    a: "devueltas.push({ ...t.bolsa, tipo: 'disponible', vence_en: null, monto: guaranies(monto) })",
  },
  {
    invariante: 'la devolucion es en orden inverso al consumo',
    archivo: 'src/dinero/bolsas.ts',
    de: 'for (let i = tomas.length - 1; i >= 0 && restante > 0; i--) {',
    a: 'for (let i = 0; i < tomas.length && restante > 0; i++) {',
  },
  {
    invariante: 'no se devuelve mas de lo consumido',
    archivo: 'src/dinero/bolsas.ts',
    de: 'if (aDevolver > consumido) {',
    a: 'if (false) {',
  },
  {
    invariante: 'la idempotencia impide el pago doble',
    archivo: 'src/billetera/nucleo.ts',
    de: '  if (previo === undefined) return null',
    a: '  if (previo === undefined || true) return null',
  },
  {
    invariante: 'el ledger cuadra con las bolsas',
    archivo: 'src/billetera/nucleo.ts',
    de: "      throw new Error(`descuadre en ${tipo}: ledger ${delLedger} vs bolsas ${enBolsa}`)",
    a: '',
  },
  {
    // La comprobacion se mudo de `verificarInvariantes` a `verificarDelta` cuando
    // el estado se angosto: los asientos ya no vuelven del nucleo, salen como
    // delta. Entre operaciones lo hace cumplir la PRIMARY KEY de la tabla, que
    // tiene su propia prueba en el runtime.
    invariante: 'ningun asiento se duplica dentro de una operacion',
    archivo: 'src/billetera/nucleo.ts',
    de: '    if (vistos.has(a.asiento_id)) throw new Error(`asiento duplicado: ${a.asiento_id}`)',
    a: '',
  },
  {
    invariante: 'reservar() registra de que bolsas salio la reserva',
    archivo: 'src/billetera/nucleo.ts',
    de: '    tomas: consumo.tomas,',
    a: '    tomas: [],',
  },
  {
    invariante: 'liberarReserva() devuelve el remanente real, no cero',
    archivo: 'src/billetera/nucleo.ts',
    de: 'const vueltas = devolver(r.tomas, remanente)',
    a: 'const vueltas = devolver(r.tomas, CERO)',
  },
  {
    invariante: 'retenido no se consume en decidirConsumo',
    archivo: 'src/dinero/bolsas.ts',
    de: "const disponiblesParaConsumo = bolsas.filter((b) => b.tipo !== 'retenido')",
    a: 'const disponiblesParaConsumo = bolsas',
  },
  {
    invariante: 'reservar() mueve la plata a retenido, no la debita contra la nada',
    archivo: 'src/billetera/nucleo.ts',
    de: '  const bolsas = [...bolsasSinTomas, ...retenidas]',
    a: '  const bolsas = bolsasSinTomas',
  },
  {
    invariante: 'reservar() rechaza un reserva_id con reserva abierta existente',
    archivo: 'src/billetera/nucleo.ts',
    de: "  if (estado.reservas.get(entrada.reserva_id)?.estado === 'abierta') {\n    throw new Error(`ya existe una reserva abierta con reserva_id: ${entrada.reserva_id}`)\n  }",
    a: '',
  },
  {
    invariante: 'liberarReserva() vacia retenido de la reserva que libera',
    archivo: 'src/billetera/nucleo.ts',
    de: '  const bolsas = [...bolsasSinRetenido, ...vueltas]',
    a: '  const bolsas = [...estado.bolsas, ...vueltas]',
  },
  {
    invariante: 'retenido cuadra con las reservas abiertas',
    archivo: 'src/billetera/nucleo.ts',
    de: '    throw new Error(\n      `descuadre en retenido: bolsas ${retenidoEnBolsas} vs reservas abiertas ${retenidoEnReservas}`,\n    )',
    a: '',
  },
  {
    invariante: 'sin vendedor, su peso no se descarta',
    archivo: 'src/reparto/reparto.ts',
    de: '    : [pesos.creador, pesos.vendedor + pesos.plataforma]',
    a: '    : [pesos.creador, pesos.plataforma]',
  },
  {
    invariante: 'la ganancia del creador no es retirable de inmediato',
    archivo: 'src/reparto/reparto.ts',
    de: "      bolsa: 'ganancia_creador',\n    },\n  ]",
    a: "      bolsa: 'disponible',\n    },\n  ]",
  },
  {
    invariante: 'la clave de idempotencia no incluye el intento',
    archivo: 'src/reparto/reparto.ts',
    de: 'const clave = `${venta.pedido_id}:${nombre}`',
    a: 'const clave = `${venta.pedido_id}:${nombre}:${Math.random()}`',
  },
  {
    // El oraculo de esta mutacion NO es vitest: vitest corre sobre
    // TypeScript, y el CHECK vive en SQL, del otro lado de esa frontera. Es
    // justo la frontera donde se escondio el defecto de la auditoria — el
    // agujero que `check-esquema.mjs` existe para cerrar.
    invariante: 'el CHECK de ledger_copia incluye retenido',
    archivo: 'migraciones/core/0001_cimientos.sql',
    de: "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion', 'retenido'))",
    a: "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion'))",
    oraculo: conNode('herramientas/check-esquema.mjs'),
  },
  {
    invariante: 'check-esquema.mjs detecta un tipo de bolsa que le falta al CHECK',
    archivo: 'herramientas/check-esquema.mjs',
    de: 'return { ok: faltantes.length === 0 && sobrantes.length === 0, faltantes, sobrantes }',
    a: 'return { ok: true, faltantes, sobrantes }',
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: 'acreditar() rechaza bolsa retenido: solo reservar() entra ahi',
    archivo: 'src/billetera/nucleo.ts',
    de: "  if (entrada.bolsa === 'retenido') {\n    throw new Error('retenido no se acredita directo: solo reservar() mueve plata ahi')\n  }",
    a: '',
  },

  // --- Los oraculos nuevos ------------------------------------------------
  // Un oraculo sin jueces fue el defecto n.º 1 de la Fase 0: se rompio la
  // deteccion de descuadre y ninguna prueba se dio cuenta. Las de este bloque
  // atacan a los oraculos y a los modulos que comparten, y su oraculo son las
  // pruebas propias de cada herramienta. (No lleva un numero a proposito: la
  // version anterior decia «estas siete» cuando eran ocho.)
  {
    // EL caso que check-runtime existe para agarrar: sin fecha declarada,
    // miniflare pone la del reloj del sistema. Si el oraculo inventara una, el
    // agujero queda abierto y encima con un OK arriba.
    invariante: 'check-runtime no inventa una fecha cuando no hay ninguna declarada',
    archivo: 'herramientas/check-runtime.mjs',
    de: '  return { fecha: null, origen: null }\n}',
    a: "  return { fecha: '2026-08-01', origen: 'inventada' }\n}",
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // La fecha de `env.<entorno>` gana sobre la de la raiz, porque es la que usa
    // wrangler. La version anterior de esta herramienta declaraba el caso un
    // conflicto irresoluble y fallaba.
    invariante: 'check-runtime resuelve la fecha del entorno por sobre la de la raiz',
    archivo: 'herramientas/check-runtime.mjs',
    de: "  if (typeof delEntorno === 'string') return { fecha: delEntorno, origen: `env.${entorno}` }",
    a: '',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // Un entorno que `wrangler.jsonc` no declara resolveria contra la nada. Antes
    // se caia a la fecha de la raiz y salia OK: un veredicto sobre un entorno
    // inexistente, con la palabra OK arriba.
    invariante: 'check-runtime exige que el entorno de pruebas exista en wrangler.jsonc',
    archivo: 'herramientas/check-runtime.mjs',
    de: '    if (config?.env?.[entorno] === undefined) {',
    a: '    if (false) {',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // El bloque `miniflare: {}` del pool es laxo y TypeScript no lo revisa. Un
    // `compatibilityDate` ahi gana sobre todo lo que el oraculo resuelve, y
    // quedaria imprimiendo OK sobre una fecha que no es la efectiva.
    invariante: 'check-runtime prohibe que el arnes imponga la fecha por su cuenta',
    archivo: 'herramientas/check-runtime.mjs',
    de: "  const m = /^[^\\n]*?\\b(compatibilityDate|compatibility_date)\\s*:/m.exec(texto)",
    a: '  const m = null',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // El guard compartido de los tres oraculos. Con un guard por nombre de
    // archivo, invocar un oraculo por un symlink lo neutralizaba: importaba el
    // modulo, no verificaba nada y salia con 0.
    invariante: 'el guard distingue invocado de importado',
    archivo: 'herramientas/invocado-directo.mjs',
    de: "  if (typeof meta.main === 'boolean') return meta.main",
    a: '',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // El respaldo por comparacion de rutas, para un Node anterior a la 22.18. Las
    // pruebas le pasan un `meta` sin `main` justamente para ejercitarlo.
    invariante: 'el respaldo del guard compara la ruta real del modulo',
    archivo: 'herramientas/invocado-directo.mjs',
    de: '    return realpathSync(arrancado) === realpathSync(fileURLToPath(meta.url))',
    a: '    return true',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // El `catch` tiene que responder `false`. Devolvia `true` —«ante la duda,
    // corre»— y con eso importar `check-entorno.mjs` desde `generar-tipos.mjs`
    // ejecutaba `main()` del oraculo adentro del import: cuando los tipos no
    // coincidian, hacia `process.exit(1)` antes de generar y el generador quedaba
    // incapaz de arreglar al oraculo.
    invariante: 'el guard no arranca un oraculo cuando no sabe de donde viene',
    archivo: 'herramientas/invocado-directo.mjs',
    de: '  } catch {\n    return false\n  }',
    a: '  } catch {\n    return true\n  }',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // El configPath del arnes tiene que ser el wrangler.jsonc del proyecto. Era el
    // agujero grande de esta familia: apuntado a otra configuracion, los oraculos
    // aprobaban un archivo que las pruebas no leian.
    invariante: 'el arnes no puede leer otra configuracion que la del proyecto',
    archivo: 'herramientas/arnes-del-runtime.mjs',
    de: '  if (d.configPath !== CONFIG_ESPERADO) {',
    a: '  if (false) {',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    invariante: 'el arnes declara un environment que es texto',
    archivo: 'herramientas/arnes-del-runtime.mjs',
    de: "  if (typeof d.environment !== 'string' || d.environment === '') {",
    a: '  if (false) {',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // Y que `check-esquema.mjs` use el guard compartido. La primera version de
    // este arreglo lo cambio solo en `check-runtime.mjs` y dejo este con el guard
    // por nombre: se arreglo el caso y no la categoria, en el mismo commit que
    // presumia de arreglar categorias.
    invariante: 'check-esquema corre de verdad cuando se lo invoca',
    archivo: 'herramientas/check-esquema.mjs',
    de: 'if (invocadoDirecto(import.meta)) main()',
    a: 'if (false) main()',
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    // Un comentario de bloque con una fecha vieja adentro no es una fecha. El
    // extractor anterior —lineas que arrancan con `//`— la tomaba como valida.
    invariante: 'check-runtime no toma como fecha la que vive en un comentario de bloque',
    archivo: 'herramientas/check-runtime.mjs',
    de: "    if (c === '/' && d === '*') {",
    a: '    if (false) {',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // Una barra doble adentro de una cadena no abre un comentario. Sin esta
    // rama, una URL en la configuracion se come el resto de la linea.
    invariante: 'check-runtime sabe cuando esta adentro de una cadena',
    archivo: 'herramientas/check-runtime.mjs',
    de: "    if (c === '\"') {\n      enCadena = true",
    a: '    if (false) {\n      enCadena = true',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // `2026-02-30` no existe y JavaScript la corre en silencio a 2026-03-02.
    invariante: 'check-runtime rechaza una fecha que no existe',
    archivo: 'herramientas/check-runtime.mjs',
    de: "  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(fecha)",
    a: '  return true',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    // El guard del CLI, ahora compartido. Las pruebas de punta a punta lo cubren.
    invariante: 'check-runtime corre de verdad cuando se lo invoca',
    archivo: 'herramientas/check-runtime.mjs',
    de: 'if (invocadoDirecto(import.meta)) main()',
    a: 'if (false) main()',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    invariante: 'check-entorno detecta que los tipos generados no coinciden',
    archivo: 'herramientas/check-entorno.mjs',
    de: "  if (a === b) return { ok: true, lineaDistinta: null, esperada: null, encontrada: null }",
    a: '  return { ok: true, lineaDistinta: null, esperada: null, encontrada: null }',
    oraculo: conNode('herramientas/check-entorno.pruebas.mjs'),
  },
  {
    // La normalizacion del encabezado tiene que sacar UNA linea, no todos los
    // comentarios: si sacara cualquier `//`, una edicion a mano al final de una
    // linea de codigo pasaria inadvertida, que es justo el caso que
    // `wrangler types --check` no agarra y por el que existe esta herramienta.
    invariante: 'check-entorno normaliza solo el encabezado, no todo comentario',
    archivo: 'herramientas/check-entorno.mjs',
    de: "      .replace(/^\\/\\/ Generated by Wrangler by running .*$/m, '// (encabezado de wrangler)')",
    a: "      .replace(/\\/\\/.*$/gm, '// (encabezado de wrangler)')",
    oraculo: conNode('herramientas/check-entorno.pruebas.mjs'),
  },

  // --- Las pruebas del Durable Object -------------------------------------
  // Su oraculo NO es vitest a secas: las pruebas del runtime viven en otra
  // configuracion porque levantan workerd, y no tiene sentido pagar ese arranque
  // en cada una de las mutaciones de arriba.
  //
  // Decir lo que falta: de las catorce pruebas de `pruebas-runtime/`, solo las dos
  // de `el Worker desplegado` estan ancladas a codigo de `src/`. El reparto exacto
  // —y que tiene que hacer la entrega siguiente para cerrarlo— vive en el
  // encabezado de `pruebas-runtime/runtime.test.ts`, en un solo lugar, porque este
  // comentario ya quedo viejo dos veces.
  {
    invariante: 'la prueba de /salud lee los vars del entorno de verdad',
    archivo: 'src/index.ts',
    de: '        entorno: entorno.ENTORNO,',
    a: "        entorno: 'produccion',",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'una ruta desconocida da 404 y no otra cosa',
    archivo: 'src/index.ts',
    de: "    return new Response('no encontrado', { status: 404 })",
    a: "    return new Response('no encontrado', { status: 500 })",
    oraculo: ORACULO_RUNTIME,
  },

  // --- El publicador del outbox --------------------------------------------
  // La otra mitad de la ley 5. El evento ya se escribia en la misma transaccion
  // que el cambio; lo que faltaba era sacarlo de ahi. Es el unico camino por el
  // que la plata llega a los reportes, y es el que menos ruido hace cuando se
  // rompe: `saldo()` y `reconciliar()` siguen dando bien, porque la plata esta.
  // Lo unico que esta mal es que nadie afuera se entera.
  {
    invariante: 'el asiento va al ledger y no al registro de eventos',
    archivo: 'src/billetera/publicador.ts',
    de: "  return tipo === TIPO_ASIENTO ? 'ledger_copia' : 'eventos_billetera'",
    a: "  return 'eventos_billetera'",
    oraculo: ORACULO_NUCLEO,
  },
  {
    // El id del outbox es lo que hace que la segunda entrega no duplique: es un
    // AUTOINCREMENT, o sea estable entre reintentos. Con una constante, la primera
    // fila se queda con la clave y el `OR IGNORE` descarta todas las demas — plata
    // acreditada que los reportes nunca ven.
    invariante: 'el evento se identifica por el id del outbox',
    archivo: 'src/billetera/publicador.ts',
    de: '        billetera_id,\n        f.id,',
    a: '        billetera_id,\n        0,',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'sin fallos previos, la copia a D1 no espera nada',
    archivo: 'src/billetera/publicador.ts',
    de: '  if (intentos <= 0) return 0',
    a: '',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // Sin techo, veinte fallos son doce dias de espera. Y con `2 ** 1024` de por
    // medio, `Infinity`: `setAlarm(Infinity)` no es una espera larga, es un error.
    invariante: 'la espera entre reintentos tiene techo',
    archivo: 'src/billetera/publicador.ts',
    de: '  return Math.min(2 ** (intentos - 1) * 1000, RETRASO_MAXIMO_MS)',
    a: '  return 2 ** (intentos - 1) * 1000',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // Un lote de cero filas es un publicador que lee cero para siempre, con el
    // outbox creciendo y todo en verde.
    invariante: 'el lote del publicador no puede ser cero',
    archivo: 'src/billetera/publicador.ts',
    de: 'export const LOTE = 50',
    a: 'export const LOTE = 0',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // LEY 6, y el oraculo es la prueba que reproduce la caida entre la escritura en
    // D1 y la marca en el Durable Object. Sin `OR IGNORE` el lote entero falla por
    // la clave primaria, el publicador lo atrapa, y las filas quedan pendientes
    // para siempre: el outbox se traba sin un solo error visible.
    invariante: 'la segunda entrega del mismo asiento no rompe ni duplica',
    archivo: 'src/billetera/publicador.ts',
    de: "  'INSERT OR IGNORE INTO ledger_copia",
    a: "  'INSERT INTO ledger_copia",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'la segunda entrega del mismo evento no rompe ni duplica',
    archivo: 'src/billetera/publicador.ts',
    de: "  'INSERT OR IGNORE INTO eventos_billetera",
    a: "  'INSERT INTO eventos_billetera",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El asiento sale por el outbox y se escribe donde se inserta el asiento, no
    // como un evento que el nucleo tenga que acordarse de emitir. Sin esta linea,
    // `ledger_copia` queda vacia para siempre y el panel muestra una billetera sin
    // movimientos mientras la plata se mueve adentro del Durable Object.
    invariante: 'el asiento tambien sale por el outbox',
    archivo: 'src/billetera/repositorio.ts',
    de: '  for (const a of asientos) {\n    sql.exec(\n      \'INSERT INTO outbox (tipo, cuerpo, correlacion_id, creado_en) VALUES (?, ?, ?, ?)\',\n      TIPO_ASIENTO,',
    a: '  for (const a of asientos.slice(0, 0)) {\n    sql.exec(\n      \'INSERT INTO outbox (tipo, cuerpo, correlacion_id, creado_en) VALUES (?, ?, ?, ?)\',\n      TIPO_ASIENTO,',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Si lo publicado no se marca, se republica en cada pasada para siempre. D1 lo
    // absorbe —las claves primarias estan— asi que no se rompe nada: simplemente el
    // objeto no para nunca, y la cola nunca se vacia.
    invariante: 'lo publicado se marca como publicado',
    archivo: 'src/billetera/repositorio.ts',
    de: 'export function marcarPublicadas(sql: Sql, ids: readonly number[], momento: string): void {\n  for (const id of ids) {',
    a: 'export function marcarPublicadas(sql: Sql, ids: readonly number[], momento: string): void {\n  for (const id of ids.slice(0, 0)) {',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Sin contar los intentos, la espera nunca crece: el objeto despierta en bucle
    // contra una D1 que no contesta, y el diagnostico no tiene nada que mostrar.
    invariante: 'un intento fallido se cuenta',
    archivo: 'src/index.ts',
    de: '        enUnaTransaccion(this.ctx, () => contarIntento(this.sql, ids))',
    a: '',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // ESTA es la linea que hace que el publicador arranque solo. Sin ella los
    // eventos esperan a que alguien vuelva a tocar la billetera —podrian ser
    // meses— y no falla nada: `saldo()` y `reconciliar()` siguen dando bien.
    invariante: 'el outbox pendiente programa la alarma',
    archivo: 'src/index.ts',
    de: '      intentosDeLaCabeza: cabeza === null ? null : cabeza.intentos,',
    a: '      intentosDeLaCabeza: null,',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Y que el vencimiento no pierda su alarma cuando el outbox tambien pide una:
    // gana el mas cercano, no el mas lejano.
    invariante: 'la alarma que decidio alarma.ts es la que se programa',
    archivo: 'src/index.ts',
    de: '    else await this.ctx.storage.setAlarm(cuando)',
    a: '    else await this.ctx.storage.setAlarm(cuando + 60 * 60 * 1000)',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Toda operacion reprograma, no solo las que tocan reservas. La version
    // anterior lo dejaba a criterio de cada metodo y `acreditar` no lo hacia.
    invariante: 'toda operacion reprograma la alarma',
    archivo: 'src/index.ts',
    de: '    const r = this.aplicar(op, reserva_id, operar)\n    await this.reprogramarAlarma()',
    a: '    const r = this.aplicar(op, reserva_id, operar)',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'la alarma publica lo que quedo pendiente',
    archivo: 'src/index.ts',
    de: '    await this.publicar()\n\n    await this.reprogramarAlarma()',
    a: '    await this.reprogramarAlarma()',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El oraculo de la carpeta de migraciones. La version anterior de
    // `check-esquema.mjs` leia SOLO `0001_cimientos.sql` con la ruta escrita a
    // mano, y 0002 reconstruye `ledger_copia`: el oraculo habria seguido aprobando
    // la definicion de una tabla que ya no existe.
    invariante: 'check-esquema mira TODAS las migraciones, no la primera',
    archivo: 'herramientas/check-esquema.mjs',
    de: '  for (const { archivo, check } of enSql) {',
    a: '  for (const { archivo, check } of enSql.slice(0, 1)) {',
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    // Y que una lista vacia no pase por OK. Es la forma que tomaria un cambio en
    // como se escribe la columna: la expresion regular deja de encontrarla y un
    // bucle sobre cero elementos no se queja de nada.
    invariante: 'check-esquema falla si no encuentra ningun CHECK que comparar',
    archivo: 'herramientas/check-esquema.mjs',
    de: '  if (enSql.length === 0) {',
    a: '  if (false) {',
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    // Y la deriva entre lo que el arnes migra y lo que wrangler despliega. Sin
    // esto, las pruebas del publicador pueden aprobar un esquema de D1 que nadie
    // va a tener nunca, con todo en verde.
    invariante: 'el arnes no puede migrar una carpeta distinta de la que se despliega',
    archivo: 'herramientas/check-runtime.mjs',
    de: '    if (deWrangler !== declarado.migrationsDir) {',
    a: '    if (false) {',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },
  {
    invariante: 'el arnes declara un migrationsDir que es texto',
    archivo: 'herramientas/arnes-del-runtime.mjs',
    de: "  if (typeof d.migrationsDir !== 'string' || d.migrationsDir === '') {",
    a: '  if (false) {',
    oraculo: conNode('herramientas/check-runtime.pruebas.mjs'),
  },

  // --- La frontera con el sistema operativo --------------------------------
  // Un comando lanzado por nombre anda en Linux, anda en el CI, y muere en la
  // maquina del dueño: en Windows `npx` es `npx.cmd`, y desde Node 20.12 un `.cmd`
  // no se lanza sin shell. El proyecto ya tenia anotado el cable y la entrega lo
  // piso igual — un limite conocido sin oraculo es un limite que se vuelve a cruzar.
  {
    invariante: 'check-portabilidad detecta un comando lanzado por nombre',
    archivo: 'herramientas/check-portabilidad.mjs',
    de: "    const m = /\\b(?:spawnSync|spawn|execFileSync|execFile)\\s*\\(\\s*'([^']+)'/.exec(linea)",
    a: '    const m = null',
    oraculo: conNode('herramientas/check-portabilidad.pruebas.mjs'),
  },
  {
    // Y que un comentario NO cuente. Es como una auditoria volteo la version
    // anterior de otra regla de este proyecto: el oraculo se ponia en rojo
    // acusando al archivo de hacer lo que el comentario decia no hacer.
    invariante: 'un comentario no cuenta como comando lanzado',
    archivo: 'herramientas/check-portabilidad.mjs',
    de: "    if (/^\\s*(\\/\\/|\\*|\\/\\*)/.test(linea)) return",
    a: '',
    oraculo: conNode('herramientas/check-portabilidad.pruebas.mjs'),
  },
  {
    invariante: 'binarios.mjs nota si un punto de entrada se movio de lugar',
    archivo: 'herramientas/binarios.mjs',
    de: '    .filter(([, ruta]) => !existe(join(raiz, ruta)))',
    a: '    .filter(() => false)',
    oraculo: conNode('herramientas/check-portabilidad.pruebas.mjs'),
  },
  {
    // El enlace a `node_modules` de las pruebas de check-entorno. Un symlink de
    // directorio necesita permiso de administrador en Windows; una junction no.
    // Lo encontro el dueño corriendo la entrega en su maquina, con un EPERM — que
    // es exactamente para lo que existe ese paso.
    invariante: 'el enlace a node_modules se crea de una forma que anda en Windows',
    archivo: 'herramientas/check-entorno.pruebas.mjs',
    de: "    symlinkSync(join(RAIZ, 'node_modules'), join(dir, 'node_modules'), 'junction')",
    a: "    symlinkSync(join(RAIZ, 'node_modules'), join(dir, 'node_modules'))",
    // El oraculo es el BARRIDO, no sus pruebas: la mutacion rompe OTRO archivo, y
    // las pruebas de `check-portabilidad` verifican la funcion sobre texto
    // inventado — no miran el arbol. La primera version de esta mutacion las
    // usaba y sobrevivio. Una mutacion con el oraculo equivocado no prueba nada,
    // y el arnes lo dijo.
    oraculo: conNode('herramientas/check-portabilidad.mjs'),
  },
  {
    invariante: 'el comando siempre arranca con el Node que ya esta corriendo',
    archivo: 'herramientas/binarios.mjs',
    de: '  return [process.execPath, ruta, ...args]',
    a: "  return ['node', ruta, ...args]",
    oraculo: conNode('herramientas/check-portabilidad.pruebas.mjs'),
  },

  // --- El esquema del Durable Object y la transaccion ----------------------
  // Estas son las que la entrega 1.0 dejo anotadas como obligatorias: hasta que el
  // DDL y la transaccion salieran de las pruebas y entraran a `src/`, no habia
  // linea de produccion que romper y las sondas del runtime no probaban nada
  // nuestro. Ahora si.
  {
    invariante: 'el esquema del DO aplica STRICT en las bolsas',
    archivo: 'src/billetera/esquema.ts',
    de: '    restringida_a TEXT\n  ) STRICT`,',
    a: '    restringida_a TEXT\n  )`,',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'el esquema del DO restringe los tipos de bolsa',
    archivo: 'src/billetera/esquema.ts',
    de: "const CHECK_TIPO_BOLSA = `IN ('${TIPOS_DE_BOLSA.join(\"', '\")}')`",
    a: "const CHECK_TIPO_BOLSA = `IN ('${TIPOS_DE_BOLSA.join(\"', '\")}', 'inventada')`",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Una bolsa en cero no es una bolsa: es una fila que ensucia la precedencia.
    invariante: 'una bolsa no puede quedar en cero ni en negativo',
    archivo: 'src/billetera/esquema.ts',
    de: '    monto         INTEGER NOT NULL CHECK (monto > 0),\n    vence_en      TEXT,\n    origen        TEXT NOT NULL,\n    restringida_a TEXT\n  ) STRICT`,',
    a: '    monto         INTEGER NOT NULL,\n    vence_en      TEXT,\n    origen        TEXT NOT NULL,\n    restringida_a TEXT\n  ) STRICT`,',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Ley 2, hecha cumplir y no prometida.
    invariante: 'un asiento no se puede editar',
    archivo: 'src/billetera/esquema.ts',
    de: "     SELECT RAISE(ABORT, 'un asiento no se edita: se compensa con otro asiento');",
    a: '     SELECT 1;',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'un asiento no se puede borrar',
    archivo: 'src/billetera/esquema.ts',
    de: "     SELECT RAISE(ABORT, 'un asiento no se borra: se compensa con otro asiento');",
    a: '     SELECT 1;',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // LA COTA que el plan maestro pedia y que no existia en ningun lado:
    // `Reserva.consumido` estaba declarado y nada lo acotaba.
    invariante: 'consumido no puede superar el total de las tomas',
    archivo: 'src/billetera/esquema.ts',
    de: '   WHEN NEW.consumido > (SELECT COALESCE(SUM(monto), 0) FROM tomas WHERE reserva_id = NEW.reserva_id)',
    a: '   WHEN 0',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // LA LEY 5. Hasta esta entrega no tenia oraculo: si el DO escribia el asiento y
    // el evento en dos `exec` sueltos, las catorce pruebas del runtime pasaban
    // igual. Con la transaccion en un helper, hay una linea que romper.
    invariante: 'el asiento y el evento del outbox van en la MISMA transaccion',
    archivo: 'src/billetera/transaccion.ts',
    de: '  return ctx.storage.transactionSync(cambios)',
    a: '  return cambios()',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'la transaccion devuelve lo que se calculo adentro',
    archivo: 'src/billetera/transaccion.ts',
    de: 'export function enUnaTransaccion<T>(ctx: ConTransaccion, cambios: () => T): T {\n  return ctx.storage.transactionSync(cambios)',
    a: 'export function enUnaTransaccion<T>(ctx: ConTransaccion, cambios: () => T): T {\n  ctx.storage.transactionSync(cambios)\n  return undefined as T',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'check-esquema compara tambien el esquema del Durable Object',
    archivo: 'herramientas/check-esquema.mjs',
    de: '  const contraDO = compararEsquemas(tipos, delDO)\n  if (!contraDO.ok) {',
    a: '  const contraDO = compararEsquemas(tipos, delDO)\n  if (false) {',
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: 'check-esquema nota el orden distinto entre TypeScript y el DO',
    archivo: 'herramientas/check-esquema.mjs',
    de: "  return { ok: tipos.join('|') === delDO.join('|'), tipos, delDO }",
    a: '  return { ok: true, tipos, delDO }',
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },

  // --- El Durable Object sobre SQL ----------------------------------------
  // Estas atacan la cascara: la traduccion a tablas y el camino que recorre toda
  // operacion de plata. Su oraculo son las pruebas del runtime, que llaman al
  // METODO PUBLICO del DO — no a las piezas por separado.
  {
    // LA LEY 5, contra el metodo publico. Sin la transaccion, un debito que falla
    // deja el asiento escrito y el evento no, o al reves.
    invariante: 'el metodo publico del DO escribe todo en UNA transaccion',
    archivo: 'src/index.ts',
    de: '    return enUnaTransaccion(this.ctx, () => {',
    a: '    return ((f) => f())(() => {',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'el evento del outbox se escribe con el asiento',
    archivo: 'src/billetera/repositorio.ts',
    de: '  for (const e of eventos) {',
    a: '  for (const e of []) {',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Sin marcar la clave, la idempotencia no existe: el reintento vuelve a pagar.
    invariante: 'la clave de idempotencia queda marcada al aplicar',
    archivo: 'src/billetera/repositorio.ts',
    de: "  sql.exec(\n    'INSERT INTO aplicadas (clave_idem, valor, aplicada_en) VALUES (?, ?, ?)',",
    a: "  if (false) sql.exec(\n    'INSERT INTO aplicadas (clave_idem, valor, aplicada_en) VALUES (?, ?, ?)',",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El acumulado que `verificarInvariantes` compara contra las bolsas. Si no se
    // persiste, la billetera se descuadra en la operacion siguiente.
    invariante: 'los totales del ledger se persisten con el asiento',
    archivo: 'src/billetera/repositorio.ts',
    de: '  for (const [bolsa, total] of estado.totales) {',
    a: '  for (const [bolsa, total] of []) {',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El estado tiene que salir del SQLite, no de una propiedad de la clase.
    invariante: 'el estado se carga de la base en cada operacion',
    archivo: 'src/billetera/repositorio.ts',
    de: "      'SELECT tipo, monto, vence_en, origen, restringida_a FROM bolsas ORDER BY id',",
    a: "      'SELECT tipo, monto, vence_en, origen, restringida_a FROM bolsas WHERE 0 ORDER BY id',",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El esquema se crea antes de atender nada. Sin esto, la primera operacion
    // corre contra tablas que no existen.
    invariante: 'el DO crea su esquema antes de atender',
    archivo: 'src/index.ts',
    de: '      for (const sentencia of ESQUEMA) ctx.storage.sql.exec(sentencia)',
    a: '',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // La reconciliacion exhaustiva es lo unico que puede notar que el acumulado
    // se corrompio por su cuenta. Si siempre dijera que si, no serviria de nada.
    invariante: 'la reconciliacion compara de verdad',
    archivo: 'src/billetera/repositorio.ts',
    de: '    if (a !== b) diferencias.push(`${bolsa}: asientos ${a} vs totales_ledger ${b}`)',
    a: '',
    oraculo: ORACULO_RUNTIME,
  },

  {
    // El resumen de un job exitoso no puede parecer un desastre. Ver
    // `entornoParaOraculo` en binarios.mjs.
    invariante: 'las corridas de mutacion no escriben en el resumen del CI',
    archivo: 'herramientas/binarios.mjs',
    de: '  delete copia.GITHUB_ACTIONS',
    a: '',
    oraculo: conNode('herramientas/check-portabilidad.pruebas.mjs'),
  },
  {
    invariante: 'el entorno del oraculo conserva todo lo demas',
    archivo: 'herramientas/binarios.mjs',
    de: '  const copia = { ...entorno }',
    a: '  const copia = {}',
    oraculo: conNode('herramientas/check-portabilidad.pruebas.mjs'),
  },

  // --- Las reservas, el consumo parcial y la alarma -------------------------
  {
    // LA COTA que estuvo declarada desde la Fase 0 sin nada que la hiciera
    // cumplir. Sin ella el remanente que vuelve al usuario sale negativo.
    invariante: 'no se puede consumir mas de lo que la reserva tiene',
    archivo: 'src/billetera/nucleo.ts',
    de: '  if (entrada.monto > disponible) {',
    a: '  if (false) {',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'consumirReserva incrementa consumido de verdad',
    archivo: 'src/billetera/nucleo.ts',
    de: '  reservas.set(r.reserva_id, { ...r, consumido: guaranies(r.consumido + entrada.monto) })',
    a: '  reservas.set(r.reserva_id, { ...r, consumido: r.consumido })',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El invariante 4 tuvo que aprender a restar `consumido`. Con la version
    // anterior, toda reserva consumida a medias quedaba acusada de descuadre.
    invariante: 'retenido cuadra con lo que las reservas abiertas NO gastaron',
    archivo: 'src/billetera/nucleo.ts',
    de: '    .reduce((total, r) => total + r.tomas.reduce((s, t) => s + t.monto, 0) - r.consumido, 0)',
    a: '    .reduce((total, r) => total + r.tomas.reduce((s, t) => s + t.monto, 0), 0)',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Una reserva que nace vencida —reloj corrido, reintento demorado, campaña de
    // un minuto— dejaba el objeto sin alarma y la plata retenida para siempre.
    // Lo encontro una prueba, no una auditoria.
    // Las cuatro ramas de la decision viven en `billetera/alarma.ts`, puras, y por
    // eso su oraculo es el nucleo y no el runtime. Estaban adentro del Durable
    // Object y ESTA mutacion sobrevivio a cuarenta y ocho pruebas del runtime: el
    // estado donde la rama manda —algo vencido Y el outbox vacio— solo se observa
    // desde afuera del objeto ganandole una carrera a la alarma que se dispara
    // sola. Se movio la decision, no se agrego una prueba mas.
    invariante: 'una reserva ya vencida igual queda con alarma',
    archivo: 'src/billetera/alarma.ts',
    de: '  if (m.hayVencidas) motivos.push(m.ahora)',
    a: '  if (false) motivos.push(m.ahora)',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'la alarma queda programada para el vencimiento de la reserva',
    archivo: 'src/billetera/alarma.ts',
    de: '  else if (m.proximoVencimiento !== null) motivos.push(Date.parse(m.proximoVencimiento))',
    a: '',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'el outbox pendiente es un motivo para despertar',
    archivo: 'src/billetera/alarma.ts',
    de: '  if (m.intentosDeLaCabeza !== null) {',
    a: '  if (false) {',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'sin ningun motivo no queda alarma',
    archivo: 'src/billetera/alarma.ts',
    de: '  if (motivos.length === 0) return null',
    a: '  if (motivos.length === 0) return m.ahora',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'entre los motivos de la alarma gana el mas cercano (decision pura)',
    archivo: 'src/billetera/alarma.ts',
    de: '  return Math.min(...motivos)',
    a: '  return Math.max(...motivos)',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // Una alarma que sobrevive a la reserva que la justificaba despierta el objeto
    // para nada, para siempre.
    invariante: 'sin reservas abiertas la alarma se borra',
    archivo: 'src/index.ts',
    de: '    if (cuando === null) await this.ctx.storage.deleteAlarm()',
    a: '    if (false) await this.ctx.storage.deleteAlarm()',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Si la alarma liberara todo lo que encuentra, una campaña en curso se
    // cancelaria sola. Es el defecto mas caro que puede tener este mecanismo.
    invariante: 'la alarma solo libera lo que YA vencio',
    archivo: 'src/billetera/repositorio.ts',
    de: '  const vencidas = abiertas.filter((r) => r.vence_en <= momento).map((r) => r.reserva_id)',
    a: '  const vencidas = abiertas.map((r) => r.reserva_id)',
    oraculo: ORACULO_RUNTIME,
  },
  // --- Mutar tambien el arnes ---------------------------------------------
  // Un arnes que no puede fallar hace que todo pase. Si estas sobreviven, las
  // pruebas no estan probando la caida: estan probando nada.
  {
    invariante: 'el arnes inyecta la caida de verdad',
    archivo: 'tests/arnes.ts',
    de: "      throw new CaidaInyectada('despues', paso.nombre)",
    a: '',
  },
  {
    invariante: 'el arnes reanuda desde el paso que fallo, no desde cero',
    archivo: 'tests/arnes.ts',
    de: '    if (completados.has(paso.nombre)) continue',
    a: '',
  },
  {
    // El arnes dice leer el entorno `staging` del wrangler.jsonc de verdad; si eso
    // fuera decorativo, las pruebas correrian contra una configuracion inventada y
    // nadie se enteraria. Muta el archivo de datos, que es de donde sale el
    // nombre desde que se dejo de parsear el TypeScript del arnes.
    invariante: 'el arnes del runtime lee el entorno que dice leer',
    archivo: 'pruebas-runtime/arnes-del-runtime.json',
    de: '"environment": "staging"',
    a: '"environment": "produccion"',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El arnes tiene que poder apagarse ruidosamente. Hoy un `include` que no
    // machea sale con 1 ("No test files found"); el dia que alguien agregue
    // `passWithNoTests: true` para callar un ruido, esta mutacion SOBREVIVE y
    // avisa que `verificar` esta saliendo verde con cero pruebas del runtime.
    invariante: 'el arnes del runtime falla si no encuentra pruebas',
    archivo: 'vitest.runtime.config.ts',
    de: "    include: ['pruebas-runtime/**/*.test.ts'],",
    a: "    include: ['pruebas-runtime/**/*.no-existe.ts'],",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El aislamiento entre pruebas del runtime es una convencion: cada prueba usa
    // su propio nombre de Durable Object. Medido: en esta version del pool el
    // storage NO se resetea entre pruebas del mismo archivo, y no hay opcion que
    // lo haga. Una convencion sin oraculo se rompe sola.
    invariante: 'el aislamiento entre pruebas del runtime lo da el nombre del DO',
    archivo: 'pruebas-runtime/runtime.test.ts',
    de: '  return env.BILLETERA.get(env.BILLETERA.idFromName(prueba.fullName))',
    a: "  return env.BILLETERA.get(env.BILLETERA.idFromName('una-sola'))",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Y que el nombre sea el CAMINO COMPLETO y no solo el texto del `it`.
    // `task.name` no incluye el `describe`: dos pruebas con el mismo texto en dos
    // grupos distintos daban el mismo Durable Object, con un comentario diciendo
    // que no. Dos `describe` de runtime.test.ts tienen una prueba con el mismo
    // texto para que esta mutacion tenga donde morir, y son simetricos para que no
    // dependa de cual corre primero.
    //
    // Nota de la pasada de mutacion: la primera version de esta mutacion cambiaba
    // `billetera(task.fullName)` en el sitio de LLAMADA y sobrevivia, porque
    // `String.replace` con un texto reemplaza solo la primera aparicion y de las
    // doce llamadas quedaban once sin mutar. (Ahora la herramienta rechaza de plano
    // una mutacion cuyo fragmento aparece mas de una vez.) El arreglo no es escribir la mutacion con mas cuidado: es
    // que `billetera()` reciba la prueba entera, para que la decision viva en un
    // solo lugar. Una mutacion dificil de escribir suele estar señalando un
    // diseño con la decision repartida.
    invariante: 'el aislamiento usa el camino completo de la prueba, no solo su texto',
    archivo: 'pruebas-runtime/runtime.test.ts',
    de: 'return env.BILLETERA.get(env.BILLETERA.idFromName(prueba.fullName))',
    a: 'return env.BILLETERA.get(env.BILLETERA.idFromName(prueba.name))',
    oraculo: ORACULO_RUNTIME,
  },

  // --- La deriva de tipos entre Entorno y wrangler.jsonc -------------------
  // Estas dos mutan `src/index.ts` y su oraculo es el compilador. Prueban las dos
  // lineas de `pruebas-runtime/runtime.test.ts` que comparan `Entorno` contra el
  // `Cloudflare.Env` generado. Mutar la linea de comprobacion en si no servia: la
  // volvia una tautologia que compila, y una mutacion que no puede fallar no
  // prueba nada. Hay que romper lo que la comprobacion custodia.
  {
    invariante: 'Entorno no puede prometer un binding que wrangler.jsonc no declara',
    archivo: 'src/index.ts',
    de: '  readonly CORE: D1Database',
    a: '  readonly CORE: D1Database\n  readonly PASARELA_INVENTADA: string',
    oraculo: ORACULO_TIPOS,
  },
  {
    invariante: 'Entorno tampoco puede prometer de menos que wrangler.jsonc',
    archivo: 'src/index.ts',
    de: '  readonly SECUENCIA: DurableObjectNamespace<SecuenciaDO>\n',
    a: '',
    oraculo: ORACULO_TIPOS,
  },
  {
    // `any` es asignable en las dos direcciones, asi que se colaba por las dos
    // comprobaciones de arriba — y el final era el mismo que el defecto original:
    // `env.CORE.loQueSea()` compila y explota en runtime sin un solo ruido.
    invariante: 'ningun binding de Entorno puede declararse como any',
    archivo: 'src/index.ts',
    de: '  readonly CORE: D1Database\n',
    a: '  readonly CORE: any\n',
    oraculo: ORACULO_TIPOS,
  },
]

const ORACULO_POR_DEFECTO = ORACULO_NUCLEO

/**
 * El arbol tiene que estar SANO antes de empezar.
 *
 * `execFileSync` cuenta como "mutacion muerta" cualquier salida distinta de 0 del
 * oraculo, sin haber comprobado nunca que el oraculo pase con el codigo intacto.
 * Sobre un arbol ya en rojo por otra causa, las 49 se reportan muertas y el
 * titular dice "Todas murieron. Las pruebas prueban algo." Medido: una mutacion
 * INOCUA —agregar un comentario— se reportaba muerta.
 *
 * Se corre cada oraculo distinto una vez, antes de tocar nada. Cuesta unos
 * segundos y convierte el veredicto en un veredicto.
 */
function comprobarLineaBase() {
  const oraculos = new Map()
  for (const m of MUTACIONES) {
    const cmd = m.oraculo ?? ORACULO_POR_DEFECTO
    oraculos.set(cmd.join(' '), cmd)
  }

  console.log(`  Linea de base — ${oraculos.size} oraculos sobre el arbol intacto\n`)

  for (const [nombre, cmd] of oraculos) {
    const [ejecutable, ...args] = cmd
    try {
      execFileSync(ejecutable, args, { stdio: 'pipe', cwd: RAIZ, env: entornoParaOraculo(process.env) })
      console.log(`  ✓  ${nombre}`)
    } catch {
      console.log(`  ✗  ${nombre}`)
      console.log('')
      console.log('     ESTE ORACULO YA FALLA SIN MUTACIONES.')
      console.log('     Sobre un arbol en rojo, toda mutacion se reporta muerta y el')
      console.log('     veredicto de abajo no vale nada. Arreglalo antes de mutar.')
      console.log('')
      process.exit(1)
    }
  }
  console.log('')
}

/** Sello de los archivos que las mutaciones tocan, para comprobar al final que el
 *  arbol quedo como estaba. Sin esto, "restaura en un finally" es una intencion. */
function sellar() {
  const h = createHash('sha256')
  for (const archivo of [...new Set(MUTACIONES.map((m) => m.archivo))].sort()) {
    h.update(archivo)
    h.update(readFileSync(rutaDe(archivo)))
  }
  return h.digest('hex')
}

let sobrevivientes = []
let muertas = 0

/** El archivo mutado en este instante, para poder restaurarlo si nos matan. */
let enVuelo = null

// Un Ctrl-C dejaba el arbol con un invariante roto A PROPOSITO en el codigo del
// dinero, porque el `finally` no corre con una señal. Y peor: el SIGINT mataba al
// hijo, `execFileSync` tiraba, la mutacion se contaba como muerta y la corrida
// seguia hasta imprimir "49/49 — Todas murieron". Un veredicto verde con un
// oraculo que nunca corrio.
for (const señal of ['SIGINT', 'SIGTERM']) {
  process.on(señal, () => {
    if (enVuelo !== null) {
      writeFileSync(rutaDe(enVuelo.archivo), enVuelo.original)
      console.log(`\n\n  ${señal} — restaurado ${enVuelo.archivo}`)
    }
    console.log('  INTERRUMPIDA. El veredicto no vale: no se corrieron todas.\n')
    process.exit(130)
  })
}

comprobarLineaBase()
const selloInicial = sellar()

console.log(`  Mutacion — ${MUTACIONES.length} invariantes bajo ataque\n`)

for (const m of MUTACIONES) {
  const original = readFileSync(rutaDe(m.archivo), 'utf8')

  if (!original.includes(m.de)) {
    console.log(`  ?  ${m.invariante}`)
    console.log(`     LA MUTACION NO APLICA — el fragmento ya no existe en ${m.archivo}.`)
    console.log(`     Una mutacion que no muta no prueba nada. Actualizala.\n`)
    sobrevivientes.push(`${m.invariante} (fragmento inexistente)`)
    continue
  }

  // `String.replace` con un texto reemplaza SOLO la primera aparicion. Una
  // mutacion cuyo fragmento aparece dos veces muta a medias, y muere o sobrevive
  // por un motivo distinto al que declara. Ya paso una vez.
  const apariciones = original.split(m.de).length - 1
  if (apariciones > 1) {
    console.log(`  ?  ${m.invariante}`)
    console.log(`     EL FRAGMENTO APARECE ${apariciones} VECES en ${m.archivo}.`)
    console.log(`     String.replace muta solo la primera: la mutacion es ambigua.\n`)
    sobrevivientes.push(`${m.invariante} (fragmento ambiguo)`)
    continue
  }

  enVuelo = { archivo: m.archivo, original }
  writeFileSync(rutaDe(m.archivo), original.replace(m.de, m.a))

  // El oraculo por defecto es vitest. Algunas mutaciones atacan un lugar que
  // vitest no ve — el CHECK de una migracion SQL, o una herramienta de node
  // plano — y declaran su propio oraculo en vez de fingir que vitest las
  // cubre.
  const [cmd, ...args] = m.oraculo ?? ORACULO_POR_DEFECTO

  let murio = false
  try {
    // `timeout` porque un oraculo del runtime que se cuelgue dejaba el arbol
    // mutado indefinidamente, con el codigo del dinero escrito en disco.
    execFileSync(cmd, args, {
      stdio: 'pipe',
      cwd: RAIZ,
      timeout: 300_000,
      env: entornoParaOraculo(process.env),
    })
  } catch {
    murio = true // el oraculo fallo: la mutacion murio, que es lo que queremos
  } finally {
    writeFileSync(rutaDe(m.archivo), original)
    enVuelo = null
  }

  if (murio) {
    muertas += 1
    console.log(`  ✓  ${m.invariante}`)
  } else {
    sobrevivientes.push(m.invariante)
    console.log(`  ✗  ${m.invariante}`)
    console.log(`     SOBREVIVIO — rompimos esto a proposito y ninguna prueba se dio cuenta.\n`)
  }
}

console.log(`\n  ${muertas}/${MUTACIONES.length} mutaciones muertas`)

// El arbol tiene que haber vuelto exactamente a donde estaba. "Se restaura en un
// finally" era una intencion; esto es la comprobacion.
const selloFinal = sellar()
if (selloFinal !== selloInicial) {
  console.log('')
  console.log('  EL ARBOL NO QUEDO COMO ESTABA. Algun archivo mutado no se restauro.')
  console.log('  Corré `git status` y `git diff` antes de seguir.')
  console.log('')
  process.exit(1)
}

if (sobrevivientes.length > 0) {
  console.log(`\n  ${sobrevivientes.length} sobrevivieron. Cada una es un agujero en las pruebas:\n`)
  for (const s of sobrevivientes) console.log(`    · ${s}`)
  console.log('')
  process.exit(1)
}

console.log('  Todas murieron. Las pruebas prueban algo.\n')

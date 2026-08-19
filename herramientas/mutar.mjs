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
import { anotarEnVuelo, borrarLaNota, restaurarLoQueQuedoDeAntes } from './mutacion-en-vuelo.mjs'
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
    //
    // APUNTA A 0002 Y NO A 0001, y eso cambio en la ronda de arreglos de la 1.2.
    // 0002 reconstruye `ledger_copia`, asi que su CHECK es el que gobierna; el
    // oraculo pasa a comparar solo ese —comparar tambien los historicos obligaba a
    // editar migraciones ya aplicadas para poder agregar un valor—. Con la mutacion
    // sobre 0001 SOBREVIVIA, y sobrevivia con razon: perturbar la definicion de una
    // tabla que 0002 vuelve a crear no cambia el esquema que la base termina
    // teniendo. La mutacion sigue al invariante, no al archivo.
    invariante: 'el CHECK de ledger_copia incluye retenido',
    archivo: 'migraciones/core/0002_eventos_de_la_billetera.sql',
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
    // La entrega 1.2 movio el 404 de `index.ts` al enrutador, que es donde ahora
    // viven todas las rutas. La mutacion lo sigue: una que apunta a un fragmento
    // inexistente no muta nada, y `mutar.mjs` la reporta como sobreviviente.
    invariante: 'una ruta desconocida da 404 y no otra cosa',
    archivo: 'src/api/rutas.ts',
    de: "  throw new Problema(404, 'no_encontrado')",
    a: "  throw new Problema(500, 'no_encontrado')",
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
    de: '    const r = this.aplicar(operacion, op, reserva_id, operar)\n    await this.reprogramarAlarma()',
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
    // Una sola publicacion por vez. El `await` a D1 ABRE la compuerta de entrada
    // del objeto —input gates protegen solo durante storage— asi que la alarma
    // puede dispararse mientras un `publicar()` por RPC espera a D1.
    invariante: 'dos publicaciones no se solapan',
    archivo: 'src/index.ts',
    de: '    if (this.publicando) return { publicados: 0, pendientes: resumenDelOutbox(this.sql).pendientes }',
    a: '',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Una reserva descuadrada no puede tapar el outbox: si `alarm()` tirara,
    // Cloudflare reintenta unas veces y despues deja de hacerlo, con el outbox
    // pendiente y sin nadie que lo despierte.
    invariante: 'una liberacion que falla no arrastra al publicador',
    archivo: 'src/index.ts',
    de: "      try {\n        this.aplicar('liberar', op, reserva_id, (e) => liberarReserva(e, op, { reserva_id }))\n        this.liberacionesFallidas.delete(reserva_id)\n      } catch (e) {",
    a: "      this.aplicar('liberar', op, reserva_id, (e) => liberarReserva(e, op, { reserva_id }))\n      this.liberacionesFallidas.delete(reserva_id)\n      try {\n      } catch (e) {",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El oraculo de la carpeta de migraciones. La version anterior de
    // `check-esquema.mjs` leia SOLO `0001_cimientos.sql` con la ruta escrita a
    // mano, y 0002 reconstruye `ledger_copia`: el oraculo habria seguido aprobando
    // la definicion de una tabla que ya no existe.
    // Cambio de la ronda de arreglos de la 1.2: el oraculo ya no compara TODAS las
    // declaraciones historicas —eso obligaba a editar una migracion ya aplicada para
    // poder agregar un valor— sino la ULTIMA, que es la que gobierna. La mutacion
    // sigue al invariante: mirar la primera es mirar la definicion que la base ya no
    // tiene.
    invariante: 'check-esquema compara la ULTIMA declaracion, que es la que gobierna',
    archivo: 'herramientas/check-esquema.mjs',
    de: '  return enSql[enSql.length - 1]',
    a: '  return enSql[0]',
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
    de: '    if (deWrangler[0] !== declarado.migrationsDir) {',
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
    de: '    monto         INTEGER NOT NULL CHECK (monto > 0),\n    vence_en      TEXT ${CHECK_VENCE_EN},\n    origen        TEXT NOT NULL,\n    restringida_a TEXT\n  ) STRICT`,',
    a: '    monto         INTEGER NOT NULL,\n    vence_en      TEXT ${CHECK_VENCE_EN},\n    origen        TEXT NOT NULL,\n    restringida_a TEXT\n  ) STRICT`,',
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
    de: '  const contraDO = compararEsquemas(tiposDeBolsa, delDO)\n  if (!contraDO.ok) {',
    a: '  const contraDO = compararEsquemas(tiposDeBolsa, delDO)\n  if (false) {',
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

  // --- El instante, la otra magnitud que ordena plata -----------------------
  {
    // LA FORMA UNICA. La primera version aceptaba los milisegundos como opcionales
    // y afirmaba que las dos formas «ordenan igual entre si». No ordenan igual:
    // `.` es 0x2E y `Z` es 0x5A, asi que dentro del mismo segundo la larga va
    // antes que la corta — al reves que el reloj. Medido de punta a punta: la
    // alarma decia YA y el filtro que la justifica decia TODAVIA NO.
    invariante: 'el instante tiene UNA sola forma, con milisegundos',
    archivo: 'src/dinero/momento.ts',
    de: 'const FORMA = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/',
    a: 'const FORMA = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$/',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // Y que la revision corra TAMBIEN cuando la operacion resulta repetida. Es el
    // orden de dos lineas, y una auditoria midio que nada lo sostenia.
    invariante: 'el momento se revisa aunque la operacion sea repetida',
    archivo: 'src/billetera/nucleo.ts',
    de: '  instante(op.momento)\n\n  const previo = estado.aplicadas.get(claveAplicada(operacion, op.clave_idem))\n  if (previo === undefined) return null',
    a: '  const previo = estado.aplicadas.get(claveAplicada(operacion, op.clave_idem))\n  if (previo === undefined) {\n    instante(op.momento)\n    return null\n  }',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // El CHECK del lado de adentro de la base. La puerta de TypeScript no cubre lo
    // que ya esta guardado ni lo que entre por otro camino.
    invariante: 'un vencimiento mal escrito no entra en la base',
    archivo: 'src/billetera/esquema.ts',
    de: "  `${col} LIKE '${FORMA_INSTANTE}' AND NOT ${col} GLOB '${ALFABETO_INSTANTE}'`",
    a: '  `${col} IS NOT NULL`',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Y que el CHECK mire el ALFABETO y no solo el ancho: sin la clase negada,
    // `abcd-ef-ghTij:kl:mn.opqZ` entra.
    invariante: 'el CHECK del instante mira tambien que sean digitos',
    archivo: 'src/billetera/esquema.ts',
    de: "const ALFABETO_INSTANTE = '*[^0-9.:TZ-]*'",
    a: "const ALFABETO_INSTANTE = '*[^ -~]*'",
    oraculo: ORACULO_RUNTIME,
  },

  // El vencimiento compara TEXTO (`vence_en <= momento`) y la alarma compara
  // RELOJ (`Date.parse`). Con un huso distinto de `Z` los dos dejan de coincidir,
  // y nada falla: la plata se cuenta mal. Lo encontro una auditoria adversarial.
  {
    invariante: 'un instante con otro huso no entra',
    archivo: 'src/dinero/momento.ts',
    de: '  if (!FORMA.test(valor)) {',
    a: '  if (false) {',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // `2026-02-30` pasa la expresion regular y JavaScript la corre en silencio a
    // `2026-03-02`. Una fecha corrida dos dias es peor que un error.
    invariante: 'un instante con forma valida y fecha inexistente no entra',
    archivo: 'src/dinero/momento.ts',
    de: '  if (d.toISOString() !== valor) {',
    a: '  if (false) {',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // Una bolsa sin vencimiento es legitima; una con un vencimiento mal escrito no.
    invariante: 'instanteOpcional no deja pasar cualquier cosa por ser opcional',
    archivo: 'src/dinero/momento.ts',
    de: '  return instante(valor)',
    a: '  return valor as Instante',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // La revision vive en la puerta por la que pasan las cinco operaciones. Un
    // lugar, no cinco — la sexta no se lo puede olvidar.
    invariante: 'ninguna operacion entra con un momento mal escrito',
    archivo: 'src/billetera/nucleo.ts',
    de: '  instante(op.momento)',
    a: '',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'el vencimiento de una acreditacion se revisa al entrar',
    archivo: 'src/billetera/nucleo.ts',
    de: '    vence_en: instanteOpcional(entrada.vence_en),',
    a: '    vence_en: (entrada.vence_en ?? null) as string | null,',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'el vencimiento de una reserva se revisa al entrar',
    archivo: 'src/billetera/nucleo.ts',
    de: '  instante(entrada.vence_en)\n',
    a: '',
    oraculo: ORACULO_NUCLEO,
  },

  // --- Las reservas, el consumo parcial y la alarma -------------------------
  {
    // EL DEFECTO NACIDO DEL ARREGLO, y es el peor de la segunda vuelta. El
    // try/catch que impide que una reserva rota se lleve puesto al publicador dejo
    // a la alarma sin freno: la reserva sigue vencida y abierta, `reprogramarAlarma`
    // la vuelve a ver, y programa para AHORA. Medido: ~185 disparos por segundo,
    // sostenidos, sin un solo error visible. Con el contador, la espera crece.
    invariante: 'una liberacion que falla no deja la alarma girando',
    archivo: 'src/index.ts',
    de: '        this.liberacionesFallidas.set(reserva_id, previos + 1)',
    a: '',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Y la otra mitad: que el exito lo limpie. Sin esto, una reserva que fallo una
    // vez arrastra su backoff para siempre y las siguientes llegan tarde.
    invariante: 'una liberacion que funciona limpia su contador',
    archivo: 'src/index.ts',
    de: '        this.liberacionesFallidas.delete(reserva_id)',
    a: '',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'el vencimiento vuelve a intentarse mas tarde, no en bucle',
    archivo: 'src/billetera/alarma.ts',
    de: '    motivos.push(m.ahora + retrasoPorIntentos(m.intentosDeLasVencidas))',
    a: '    motivos.push(m.ahora)',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // El estado cerrado tiene que LLEGAR al nucleo, si no el rechazo del reuso no
    // tiene que mirar. Las dos lineas de las que cuelga, una por mutacion.
    invariante: 'el DO le pasa al nucleo la reserva que la operacion nombra',
    archivo: 'src/index.ts',
    de: "    return this.operar('reservar', op, entrada.reserva_id, (e) => reservar(e, op, entrada))",
    a: '    return this.operar(op, undefined, (e) => reservar(e, op, entrada))',
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: 'se carga la reserva nombrada aunque este cerrada',
    archivo: 'src/billetera/repositorio.ts',
    de: '        : "SELECT reserva_id, consumido, vence_en, estado FROM reservas WHERE estado = \'abierta\' OR reserva_id = ?",',
    a: '        : "SELECT reserva_id, consumido, vence_en, estado FROM reservas WHERE estado = \'abierta\' OR (reserva_id = ? AND 0)",',
    oraculo: ORACULO_RUNTIME,
  },
  {
    // EL BUCLE QUE NADIE PROBABA. Una auditoria lo midio: con esta mutacion, las
    // 73 pruebas del nucleo y las 48 del runtime pasaban enteras, porque todas
    // consumian un monto que entraba en la PRIMERA toma. Si el bucle se corta,
    // `consumido` dice que se gasto X y las bolsas retenidas todavia tienen parte
    // de X: la misma plata contada dos veces.
    invariante: 'el consumo que cruza una toma sigue en la siguiente',
    archivo: 'src/billetera/nucleo.ts',
    de: '    porConsumir -= saca',
    a: '    porConsumir = 0',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'el consumo no saca mas de lo que la bolsa tiene',
    archivo: 'src/billetera/nucleo.ts',
    de: '    const saca = Math.min(porConsumir, b.monto)',
    a: '    const saca = porConsumir',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // Un reserva_id se usa UNA vez. La version anterior rechazaba solo si estaba
    // ABIERTA, y el reuso de un id ya cerrado dejaba las tomas viejas (PK
    // `(reserva_id, orden)` con `INSERT OR IGNORE`), el vencimiento viejo, y la
    // alarma en bucle con la clave `vencimiento:<reserva_id>` ya marcada.
    invariante: 'un reserva_id no se reusa, ni siquiera despues de cerrado',
    archivo: 'src/billetera/nucleo.ts',
    de: '  if (estado.reservas.has(entrada.reserva_id)) {',
    a: "  if (estado.reservas.get(entrada.reserva_id)?.estado === 'abierta') {",
    oraculo: ORACULO_NUCLEO,
  },
  {
    // El invariante 2 recorre la UNION de los dos lados. Iterando solo `totales`,
    // una bolsa de un tipo que nunca tuvo asiento es invisible: plata inventada
    // que el oraculo del camino caliente aprueba.
    invariante: 'el invariante del ledger mira tambien las bolsas sin historia',
    archivo: 'src/billetera/nucleo.ts',
    de: '  for (const tipo of new Set([...estado.totales.keys(), ...enBolsas.keys()])) {',
    a: '  for (const tipo of estado.totales.keys()) {',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // LA COTA que estuvo declarada desde la Fase 0 sin nada que la hiciera
    // cumplir. Sin ella el remanente que vuelve al usuario sale negativo.
    invariante: 'no se puede consumir mas de lo que la reserva tiene',
    archivo: 'src/billetera/nucleo.ts',
    de: '  if (entrada.monto > disponible) {',
    a: '  if (false) {',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'consumirReserva incrementa consumido de verdad',
    archivo: 'src/billetera/nucleo.ts',
    de: '  reservas.set(r.reserva_id, { ...r, consumido: guaranies(r.consumido + entrada.monto) })',
    a: '  reservas.set(r.reserva_id, { ...r, consumido: r.consumido })',
    oraculo: ORACULO_NUCLEO,
  },
  {
    // El invariante 4 tuvo que aprender a restar `consumido`. Con la version
    // anterior, toda reserva consumida a medias quedaba acusada de descuadre.
    // Las tres de acá arriba atacan codigo PURO y estaban declaradas con el
    // oraculo del runtime, que es el caro. Lo noto una auditoria: `consumirReserva`
    // no depende de Cloudflare, asi que su lugar es `tests/`, que es lo que la
    // mutacion corre decenas de veces.
    invariante: 'retenido cuadra con lo que las reservas abiertas NO gastaron',
    archivo: 'src/billetera/nucleo.ts',
    de: '    .reduce((total, r) => total + r.tomas.reduce((s, t) => s + t.monto, 0) - r.consumido, 0)',
    a: '    .reduce((total, r) => total + r.tomas.reduce((s, t) => s + t.monto, 0), 0)',
    oraculo: ORACULO_NUCLEO,
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
    de: '  if (m.intentosDeLasVencidas !== null) {',
    a: '  if (false) {',
    oraculo: ORACULO_NUCLEO,
  },
  {
    invariante: 'la alarma queda programada para el vencimiento de la reserva',
    archivo: 'src/billetera/alarma.ts',
    de: '  } else if (m.proximoVencimiento !== null) {\n    motivos.push(Date.parse(m.proximoVencimiento))',
    a: '  } else if (false) {\n    motivos.push(Date.parse(m.proximoVencimiento))',
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
  {
    // --- La entrega 1.2: identidad, capacidades y el primer endpoint ---------
  // Las de este bloque atacan lo que la 1.2 trajo. Las que nombran una ley la
  // nombran a proposito: si sobreviven, la ley no esta probada, esta escrita.
    invariante: "una cuenta cerrada no puede nada, aunque tenga la capacidad vigente",
    archivo: "src/identidad/capacidades.ts",
    de: "  if (persona.estado === 'cerrada') return no('persona_cerrada')\n",
    a: "",
  },
  {
    invariante: "una cuenta suspendida tampoco",
    archivo: "src/identidad/capacidades.ts",
    de: "  if (persona.estado === 'suspendida') return no('persona_suspendida')\n",
    a: "",
  },
  {
    invariante: "una capacidad no vale antes de que la otorguen",
    archivo: "src/identidad/capacidades.ts",
    de: "  if (o.desde > momento) return false\n",
    a: "",
  },
  {
    invariante: "el hasta es EXCLUSIVE: en su propio instante la capacidad ya no vale",
    archivo: "src/identidad/capacidades.ts",
    de: "  if (o.hasta !== null && o.hasta <= momento) return false",
    a: "  if (o.hasta !== null && o.hasta < momento) return false",
  },
  {
    // LEY 4. La vigencia es una union de ventanas y no puede depender del orden de
  // las filas. Esta mutacion es literalmente "mira la primera": si sobrevive, la
  // ley esta escrita en un comentario y no en el codigo.
    invariante: "la vigencia no depende del orden de las filas (ley 4)",
    archivo: "src/identidad/capacidades.ts",
    de: "  if (suyas.some((o) => vigente(o, momento))) return SI",
    a: "  if (suyas.length > 0 && vigente(suyas[0], momento)) return SI",
  },
  {
    invariante: "entre una vencida y una futura, el motivo declarado es vencida",
    archivo: "src/identidad/capacidades.ts",
    de: "  if (suyas.some((o) => o.hasta !== null && o.hasta <= momento)) return no('capacidad_vencida')\n  if (suyas.some((o) => o.desde > momento)) return no('capacidad_futura')",
    a: "  if (suyas.some((o) => o.desde > momento)) return no('capacidad_futura')\n  if (suyas.some((o) => o.hasta !== null && o.hasta <= momento)) return no('capacidad_vencida')",
  },
  {
    invariante: "las ventanas de OTRA capacidad no contestan por esta",
    archivo: "src/identidad/capacidades.ts",
    de: "  const suyas = persona.otorgamientos.filter((o) => o.capacidad === capacidad)",
    a: "  const suyas = [...persona.otorgamientos]",
  },
  {
    invariante: "las capacidades vigentes salen en el orden declarado, no en el de las filas",
    archivo: "src/identidad/capacidades.ts",
    de: "  return CAPACIDADES.filter((c) => puede(persona, c, momento).puede)",
    a: "  return [...new Set(persona.otorgamientos.map((o) => o.capacidad))].filter(\n    (c) => puede(persona, c, momento).puede,\n  )",
  },
  {
    invariante: "una ventana no puede terminar antes de empezar",
    archivo: "src/identidad/capacidades.ts",
    de: "  if (hasta !== null && hasta < desde) {",
    a: "  if (false) {",
  },
  {
    invariante: "un otorgamiento no entra con una capacidad inventada",
    archivo: "src/identidad/capacidades.ts",
    de: "  if (!esCapacidad(fila.capacidad)) {",
    a: "  if (false) {",
  },
  {
    invariante: "la ventana del token vence cuando la alcanza, no despues",
    archivo: "src/identidad/actor.ts",
    de: "  if (edad >= ventana_ms) return 'vencido'",
    a: "  if (edad > ventana_ms) return 'vencido'",
  },
  {
    invariante: "un reloj apenas adelantado se perdona, uno que miente no",
    archivo: "src/identidad/actor.ts",
    de: "  if (-edad > margen_ms) return 'del_futuro'",
    a: "  if (-edad >= margen_ms) return 'del_futuro'",
  },
  {
    invariante: "una firma que no verifica no entra",
    archivo: "src/identidad/actor.ts",
    de: "  if (!valida) throw new TokenInvalido('firma_invalida')\n",
    a: "",
  },
  {
    // Si la version quedara fuera de lo firmado, cambiar `v1` por `v2` no
  // invalidaria nada — y el dia que exista un v2 con otras reglas, eso seria una
  // forma de elegir cual se aplica.
    invariante: "una version de token que no conocemos se rechaza, no se interpreta",
    archivo: "src/identidad/actor.ts",
    de: "  if (version !== PREFIJO) throw new TokenInvalido('version_desconocida')\n",
    a: "",
  },
  {
    invariante: "un token de persona sin id no se completa con un valor por defecto",
    archivo: "src/identidad/actor.ts",
    de: "    if (typeof persona_id !== 'string' || persona_id.length === 0) {",
    a: "    if (false) {",
  },
  {
    // La forma exacta en que esto se rompe en la vida real: alguien pone un valor
  // por defecto "para que no explote". La puerta queda abierta con un secreto que
  // conoce cualquiera que lea el codigo.
    invariante: "sin secreto la puerta se cierra, no se inventa uno",
    archivo: "src/identidad/actor.ts",
    de: "  if (s.length < LARGO_MINIMO_DEL_SECRETO) throw new TokenInvalido('secreto_debil')",
    a: "",
  },
  {
    invariante: "la ley 9 se revisa a cualquier profundidad",
    archivo: "src/bitacora/bitacora.ts",
    de: "    revisarDetalle(valor)\n",
    a: "",
  },
  {
    invariante: "la lista de claves personales no se escapa por mayusculas",
    archivo: "src/bitacora/bitacora.ts",
    de: "    if (CLAVES_PERSONALES.includes(clave.toLowerCase())) throw new DatoPersonalEnBitacora(clave)",
    a: "    if (CLAVES_PERSONALES.includes(clave)) throw new DatoPersonalEnBitacora(clave)",
  },
  {
    invariante: "la correlacion que entra de afuera esta acotada en largo y alfabeto",
    archivo: "src/api/rutas.ts",
    de: "const CORRELACION_VALIDA = /^[A-Za-z0-9:_-]{1,64}$/",
    a: "const CORRELACION_VALIDA = /^[^]*$/",
  },
  {
    invariante: "administrar cuentas ajenas es solo de la plataforma",
    archivo: "src/api/rutas.ts",
    de: "  if (actor.tipo !== 'plataforma') throw new Problema(403, 'solo_la_plataforma')",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "nadie mira la billetera de otro",
    archivo: "src/api/rutas.ts",
    de: "  throw new Problema(403, 'no_es_tuyo')",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // EL ORDEN, que es toda la decision de donde se escribe la bitacora. Sin este
  // await, la plata se mueve y el renglon que dice quien la pidio puede no llegar
  // nunca. El oraculo es la prueba que le esconde la tabla a proposito.
    invariante: "no se acredita sin haber escrito antes la intencion",
    archivo: "src/api/rutas.ts",
    de: "  await registrarIntencion(dep.CORE, {\n    actor_id: actorId(actor),\n    accion: 'billetera.acreditacion.pedida',\n    objetivo: persona.billetera_id,\n    detalle: { persona_id, monto, bolsa, clave_idem },\n    correlacion_id,\n    ocurrido_en: momento,\n  })\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el motivo del rechazo no sale por la respuesta",
    archivo: "src/api/rutas.ts",
    de: "      return json({ error: 'no_autorizado', correlacion_id }, 401, correlacion_id)",
    a: "      return json({ error: 'no_autorizado', motivo: e.motivo, correlacion_id }, 401, correlacion_id)",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Una revocacion que no ocurrio no puede quedar escrita como si hubiera
  // ocurrido. Un registro de auditoria que dice algo que no paso es peor que no
  // tener registro: al segundo se le busca la vuelta, al primero se le cree.
    invariante: "una revocacion que no ocurrio no se escribe en la bitacora",
    archivo: "src/identidad/personas.ts",
    de: "    sentenciaDeBitacoraSi(\n      d1,",
    a: "    sentenciaDeBitacora(\n      d1,",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "no puede haber dos ventanas abiertas de la misma capacidad",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "CREATE UNIQUE INDEX IF NOT EXISTS idx_capacidad_abierta_unica",
    a: "CREATE INDEX IF NOT EXISTS idx_capacidad_abierta_unica",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "la base tampoco acepta una ventana que termina antes de empezar",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "  CHECK (hasta IS NULL OR hasta >= otorgada_en),\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "dos personas no pueden compartir billetera",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_billetera",
    a: "CREATE INDEX IF NOT EXISTS idx_personas_billetera",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el instante entra a capacidades con una sola forma escrita",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "  CHECK (otorgada_en LIKE '____-__-__T__:__:__.___Z' AND NOT otorgada_en GLOB '*[^0-9.:TZ-]*'),\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El CHECK vive del otro lado de la frontera de TypeScript: ni los tipos, ni
  // vitest, ni la mutacion del nucleo lo miran. Solo este oraculo.
    invariante: "el CHECK de capacidades incluye distribuidor",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "CHECK (capacidad IN ('cliente', 'vendedor', 'creador', 'distribuidor'))",
    a: "CHECK (capacidad IN ('cliente', 'vendedor', 'creador'))",
    oraculo: conNode('herramientas/check-esquema.mjs'),
  },
  {
    invariante: "check-esquema mira TODAS las fronteras declaradas, no la primera",
    archivo: "herramientas/check-esquema.mjs",
    de: "  for (const frontera of FRONTERAS) {",
    a: "  for (const frontera of FRONTERAS.slice(0, 1)) {",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: "check-esquema sigue el renombre de una tabla reconstruida",
    archivo: "herramientas/check-esquema.mjs",
    de: "    const siguiente = renombres.find(\n      (r) => r.de === actual && (r.posicion === undefined || r.posicion > posicion),\n    )",
    a: "    const siguiente = undefined",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: "check-esquema falla si una frontera no tiene ningun CHECK que mirar",
    archivo: "herramientas/check-esquema.mjs",
    de: "    if (enSql.length === 0) {",
    a: "    if (false) {",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: "la billetera se nombra con su NOMBRE, no con su hash",
    archivo: "src/index.ts",
    de: "    const nombre = this.ctx.id.name\n",
    a: "    const nombre = this.ctx.id.toString()\n",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "una persona no puede quedar sin billetera_id",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "CREATE TRIGGER IF NOT EXISTS personas_exigen_billetera_al_insertar\nBEFORE INSERT ON personas\nWHEN NEW.billetera_id IS NULL\nBEGIN\n  SELECT RAISE(ABORT, 'una persona sin billetera_id no es una persona');\nEND;\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "un registro de auditoria no se edita",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "CREATE TRIGGER IF NOT EXISTS bitacora_sin_update\nBEFORE UPDATE ON bitacora\nBEGIN\n  SELECT RAISE(ABORT, 'un registro de auditoria no se edita');\nEND;\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "un registro de auditoria no se borra",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "CREATE TRIGGER IF NOT EXISTS bitacora_sin_delete\nBEFORE DELETE ON bitacora\nBEGIN\n  SELECT RAISE(ABORT, 'un registro de auditoria no se borra');\nEND;\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Con el mismo secreto en los dos entornos —el movimiento natural de quien lo pone
  // a mano dos veces— esto es lo unico que impide que un token de staging acredite
  // guaranies de verdad.
    invariante: "un token de otro entorno no entra",
    archivo: "src/identidad/actor.ts",
    de: "  if (interpretado.entorno !== entorno) throw new TokenInvalido('entorno_ajeno')\n",
    a: "",
  },
  {
    invariante: "el persona_id que entra de afuera tiene alfabeto",
    archivo: "src/api/rutas.ts",
    de: "    if (pedido !== undefined && !personaIdValido(pedido)) {",
    a: "    if (false) {",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "nadie puede llamarse como se llama la plataforma en la bitacora",
    archivo: "src/api/rutas.ts",
    de: "    !IDS_RESERVADOS.includes(valor.toLowerCase())",
    a: "    true",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El guarda va ANTES de leer el cuerpo. `acreditar()` igual lo repite adentro, asi
  // que sacarlo de acá no abre la puerta: lo que cambia es que el Worker parsea el
  // cuerpo entero de alguien que no tenia por que llegar hasta ahi.
    invariante: "en la ruta que crea dinero, el guarda corre antes que el cuerpo",
    archivo: "src/api/rutas.ts",
    de: "    exigirPlataforma(actor)\n    return acreditar(dep, actor, correlacion_id, momento, await cuerpoJson(peticion))",
    a: "    return acreditar(dep, actor, correlacion_id, momento, await cuerpoJson(peticion))",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "un vence_en mal escrito se rechaza en la puerta, no adentro del DO",
    archivo: "src/api/rutas.ts",
    de: "  let vence_en: string | null\n  try {\n    vence_en = instanteOpcional(cuerpo['vence_en'])\n  } catch {\n    throw new Problema(400, 'vence_en_invalido')\n  }",
    a: "  const vence_en = (cuerpo['vence_en'] ?? null) as string | null",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "no se acredita plata que nace vencida",
    archivo: "src/api/rutas.ts",
    de: "  if (vence_en !== null && vence_en <= momento) {",
    a: "  if (false) {",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el credito de promocion no entra sin vencimiento (ley 11), en la puerta",
    archivo: "src/api/rutas.ts",
    de: "  if (bolsa === 'credito_promocion' && vence_en === null) {",
    a: "  if (false) {",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "los textos libres que van al ledger estan acotados",
    archivo: "src/api/rutas.ts",
    de: "  if (valor.length > LARGO_MAXIMO_DE_TEXTO) throw new Problema(400, 'texto_demasiado_largo')\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // La condicion de la bitacora tiene que ser el MISMO predicado que decide el
  // cambio. Esta mutacion la vuelve a la que tenia la primera version —el valor
  // recien escrito— que con la sentencia ahora PRIMERO no encuentra nada y deja la
  // revocacion sin registro. Antes dejaba un registro de mas; ahora dejaria uno de
  // menos. Las dos son mentiras distintas del mismo error.
    invariante: "la bitacora de la revocacion pregunta lo mismo que el UPDATE",
    archivo: "src/identidad/personas.ts",
    de: "        sql: 'SELECT 1 FROM capacidades WHERE persona_id = ? AND capacidad = ? AND hasta IS NULL',\n        valores: [persona_id, capacidad],",
    a: "        sql: 'SELECT 1 FROM capacidades WHERE persona_id = ? AND capacidad = ? AND hasta = ?',\n        valores: [persona_id, capacidad, ctx.momento],",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "ninguna tabla del nucleo se declara sin STRICT",
    archivo: "herramientas/check-esquema.mjs",
    de: "      if (!t.estricta) salida.push({ archivo, tabla: t.tabla })",
    a: "      if (false) salida.push({ archivo, tabla: t.tabla })",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: "check-esquema distingue una tabla STRICT de una que no lo es",
    archivo: "herramientas/check-esquema.mjs",
    de: "estricta: /\\bSTRICT\\b/i.test(m[3])",
    a: "estricta: true",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    // SEGUNDA VUELTA DE AUDITORIA: los defectos que nacieron de los arreglos de la
  // primera. Cada uno tenia consecuencia medida, y varios eran de plata.
    invariante: "restringida_a ausente es null, no cadena vacia",
    archivo: "src/api/rutas.ts",
    de: "function textoOpcional(valor: unknown): string | null {\n  if (valor === undefined || valor === null) return null\n  if (typeof valor !== 'string') throw new Problema(400, 'texto_invalido')\n  if (valor.length === 0) return null\n  return acotar(valor)\n}",
    a: "function textoOpcional(valor: unknown): string | null {\n  if (valor === undefined) return null\n  if (typeof valor !== 'string') throw new Problema(400, 'texto_invalido')\n  return acotar(valor)\n}",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "la clave de idempotencia esta acotada",
    archivo: "src/api/rutas.ts",
    de: "  if (!CLAVE_IDEM_VALIDA.test(clave_idem)) throw new Problema(400, 'clave_idem_invalida')\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "un persona_id no puede llevar los dos puntos del prefijo de la billetera",
    archivo: "src/api/rutas.ts",
    de: "const PERSONA_VALIDA = /^[A-Za-z0-9_-]{1,64}$/",
    a: "const PERSONA_VALIDA = /^[A-Za-z0-9:_-]{1,64}$/",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "una ventana ya ocupada da 409 y no un 500 opaco",
    archivo: "src/identidad/personas.ts",
    de: "  const ocupada = persona.otorgamientos.some(\n    (o) => o.capacidad === capacidad && o.desde === ctx.momento,\n  )\n  if (ocupada) throw new VentanaYaOcupada(persona_id, capacidad, ctx.momento)\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "un registro de auditoria no se pisa con un REPLACE",
    archivo: "migraciones/core/0003_identidad.sql",
    de: "CREATE TRIGGER IF NOT EXISTS bitacora_sin_pisar\nBEFORE INSERT ON bitacora\nWHEN EXISTS (SELECT 1 FROM bitacora WHERE id = NEW.id)\nBEGIN\n  SELECT RAISE(ABORT, 'un registro de auditoria no se pisa');\nEND;\n",
    a: "",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El cambio y su registro entran juntos o no entra ninguno. La mutacion los
  // convierte en dos escrituras sueltas: con la bitacora resuelta aparte, un INSERT
  // de persona que falla deja el renglon huerfano.
    invariante: "el cambio y su registro entran en la MISMA transaccion",
    archivo: "src/identidad/personas.ts",
    de: "  return d1.batch(sentencias)",
    a: "  return Promise.all(sentencias.map((x) => x.run()))",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el SQL que esta adentro de un comentario no es SQL",
    archivo: "herramientas/check-esquema.mjs",
    de: "  return sql.replace(/--[^\\n]*/g, '')",
    a: "  return sql",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: "el oraculo ordena las migraciones como las aplica wrangler",
    archivo: "herramientas/check-esquema.mjs",
    de: "    if (Number.isNaN(na) || Number.isNaN(nb) || na === nb) return a < b ? -1 : a > b ? 1 : 0\n    return na - nb",
    a: "    return a < b ? -1 : a > b ? 1 : 0",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: "un renombre solo alcanza a lo declarado antes que el",
    archivo: "herramientas/check-esquema.mjs",
    de: "      (r) => r.de === actual && (r.posicion === undefined || r.posicion > posicion),",
    a: "      (r) => r.de === actual,",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    invariante: "el secreto debil tiene su propio motivo",
    archivo: "src/identidad/actor.ts",
    de: "  if (s.length < LARGO_MINIMO_DEL_SECRETO) throw new TokenInvalido('secreto_debil')",
    a: "  if (s.length < LARGO_MINIMO_DEL_SECRETO) throw new TokenInvalido('sin_secreto')",
  },
  {
    invariante: "una firma ilegible dice que la firma es ilegible",
    archivo: "src/identidad/actor.ts",
    de: "    throw new TokenInvalido('firma_ilegible')",
    a: "    throw new TokenInvalido('cuerpo_ilegible')",
  },
  {
    invariante: "un token de persona no puede llamarse como la plataforma",
    archivo: "src/identidad/actor.ts",
    de: "    if (RESERVADOS.includes(persona_id.toLowerCase())) throw new TokenInvalido('cuerpo_invalido')\n",
    a: "",
  },
  {
    // La herramienta que emite tokens. Su oraculo es que el token que emite lo
  // VERIFIQUE la puerta — o sea el mismo codigo que corre en el Worker. Es lo unico
  // que hace que «no se duplica la logica de firma» sea un hecho.
    invariante: "el token se emite para un entorno declarado, nunca por defecto",
    archivo: "herramientas/emitir-token.mjs",
    de: "  if (opciones.entorno === null) {",
    a: "  if (false) {",
    oraculo: conNode('herramientas/emitir-token.pruebas.mjs'),
  },
  {
    invariante: "--persona sin valor no cae en la plataforma",
    archivo: "herramientas/emitir-token.mjs",
    de: "      if (valor === undefined || valor.startsWith('--')) throw new Error(`${arg} necesita un valor`)",
    a: "      if (valor === undefined) throw new Error(`${arg} necesita un valor`)",
    oraculo: conNode('herramientas/emitir-token.pruebas.mjs'),
  },
  {
    invariante: "un argumento desconocido se rechaza en vez de ignorarse",
    archivo: "herramientas/emitir-token.mjs",
    de: "    else throw new Error(`argumento desconocido: ${arg}`)",
    a: "    else i += 0",
    oraculo: conNode('herramientas/emitir-token.pruebas.mjs'),
  },
  {
    invariante: "el secreto explicito gana sobre el guardado",
    archivo: "herramientas/emitir-token.mjs",
    de: "  if (typeof delArgumento === 'string' && delArgumento.length > 0) return delArgumento\n",
    a: "",
    oraculo: conNode('herramientas/emitir-token.pruebas.mjs'),
  },
  {
    invariante: "una cadena vacia no es un secreto",
    archivo: "herramientas/emitir-token.mjs",
    de: "  if (typeof delEntorno === 'string' && delEntorno.length > 0) return delEntorno",
    a: "  if (typeof delEntorno === 'string') return delEntorno",
    oraculo: conNode('herramientas/emitir-token.pruebas.mjs'),
  },
  {
    // Sin `bundle`, el import del modulo real muere resolviendo `momento.js` — que es
  // exactamente el motivo por el que esta herramienta bundlea en vez de copiar la
  // firma. Si esto sobreviviera, seria que las pruebas no cargan el codigo de verdad.
    invariante: "la herramienta carga el modulo de verdad, no un cascaron",
    archivo: "herramientas/emitir-token.mjs",
    de: "      bundle: true,",
    a: "      bundle: false,",
    oraculo: conNode('herramientas/emitir-token.pruebas.mjs'),
  },
  {
    // LO ENCONTRO EL DUEÑO EN SU MAQUINA, con la entrega ya mergeada. En Linux
  // `import('/tmp/x.mjs')` funciona; en Windows, `import('C:\\...\\x.mjs')` muere
  // porque Node lee `C:` como el esquema de una URL. Ninguna prueba que CORRA el
  // import puede ver la diferencia acá, asi que lo que se prueba es la FORMA.
    invariante: "un modulo se importa por su ruta como URL file://, no como ruta pelada",
    archivo: "herramientas/emitir-token.mjs",
    de: "  return pathToFileURL(ruta).href",
    a: "  return ruta",
    oraculo: conNode('herramientas/emitir-token.pruebas.mjs'),
  },
  {
    // La tercera regla del oraculo de portabilidad. Sin ella, el defecto de arriba
  // vuelve en la proxima herramienta que importe una ruta calculada — que es
  // exactamente como volvio dos veces antes en esta misma frontera.
    invariante: "check-portabilidad marca un import() de una ruta calculada",
    archivo: "herramientas/check-portabilidad.mjs",
    de: "    const im = /\\bimport\\s*\\(\\s*([A-Za-z_$][\\w$.]*)\\s*\\)/.exec(linea)",
    a: "    const im = null",
    oraculo: conNode('herramientas/check-portabilidad.pruebas.mjs'),
  },
  {
    invariante: "check-portabilidad no marca un import() de un paquete",
    archivo: "herramientas/check-portabilidad.mjs",
    de: "    if (im !== null && !/pathToFileURL/.test(linea)) {",
    a: "    if (im !== null) {",
    oraculo: conNode('herramientas/check-portabilidad.pruebas.mjs'),
  },
  // -------------------------------------------------------------------------
  // ENTREGA 1.3 · el pedido
  // -------------------------------------------------------------------------
  {
    // La derivacion del efecto sobre la plata sale de ESTE conjunto. Vaciarlo hace
    // que ninguna transicion mueva un guarani, y el pedido reservado no reserve.
    invariante: "el estado `reservado` retiene plata",
    archivo: "src/pedidos/pedido.ts",
    de: "export const RETIENEN_PLATA: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>(['reservado'])",
    a: "export const RETIENEN_PLATA: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([])",
  },
  {
    // Es la linea que separa «se cobro» de «se devolvio». Con `consumir` siempre, la
    // cancelacion se lleva la plata del comprador en vez de devolversela.
    invariante: "salir de una reserva hacia cancelado DEVUELVE, no cobra",
    archivo: "src/pedidos/pedido.ts",
    de: "    return hacia === 'cancelado' ? 'liberar' : 'consumir'",
    a: "    return 'consumir'",
  },
  {
    invariante: "un estado terminal se deriva de no tener salidas",
    archivo: "src/pedidos/pedido.ts",
    de: "  return (TRANSICIONES.get(estado) ?? []).length === 0",
    a: "  return (TRANSICIONES.get(estado) ?? []).length === 99",
  },
  {
    // Precedencia declarada: reintentar una transicion ya aplicada tiene que
    // distinguirse de un camino inexistente, incluso desde un terminal.
    invariante: "`mismo_estado` gana sobre `estado_terminal`",
    archivo: "src/pedidos/pedido.ts",
    de: "  if (desde === hacia) return no('mismo_estado')\n  if (esTerminal(desde)) return no('estado_terminal')",
    a: "  if (esTerminal(desde)) return no('estado_terminal')\n  if (desde === hacia) return no('mismo_estado')",
  },
  {
    invariante: "transicionar() tira cuando el camino no existe",
    archivo: "src/pedidos/pedido.ts",
    de: "  if (!v.puede) throw new TransicionInvalida(desde, hacia, v.motivo)",
    a: "  if (false) throw new TransicionInvalida(desde, hacia, v.motivo)",
  },
  {
    // Cancelar un pedido ya cobrado es un asiento de compensacion, no un cambio de
    // estado. Declarar el camino deja que alguien cancele un pedido cobrado y que el
    // sistema conteste 200 sin devolver un guarani.
    invariante: "un pedido pagado NO se cancela",
    archivo: "src/pedidos/pedido.ts",
    de: "  ['pagado', ['repartido']],",
    a: "  ['pagado', ['repartido', 'cancelado']],",
  },
  {
    invariante: "el año del numero de pedido sale de la zona, no de UTC",
    archivo: "src/dinero/momento.ts",
    de: "    timeZone: zona,",
    a: "    timeZone: 'UTC',",
  },
  {
    // El CHECK de la columna y el tipo de TypeScript dicen lo mismo, y el oraculo
    // del esquema es quien lo compara.
    invariante: "`reservado` esta en el CHECK de pedidos.estado",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "  estado         TEXT NOT NULL CHECK (estado IN ('creado', 'reservado', 'pagado', 'repartido', 'cancelado')),",
    a: "  estado         TEXT NOT NULL CHECK (estado IN ('creado', 'pagado', 'repartido', 'cancelado')),",
    oraculo: conNode('herramientas/check-esquema.mjs'),
  },
  {
    // Es lo unico que impide que un reintento cree un segundo pedido y reserve la
    // plata dos veces. La comprobacion previa en TypeScript da el mensaje; esto lo
    // hace imposible.
    invariante: "la clave_idem del pedido es UNICA del lado de la base",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_clave_idem ON pedidos (clave_idem);",
    a: "CREATE INDEX IF NOT EXISTS idx_pedidos_clave_idem ON pedidos (clave_idem);",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "un pedido repartido o cancelado no vuelve a otro estado",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "WHEN OLD.estado IN ('repartido', 'cancelado') AND NEW.estado <> OLD.estado",
    a: "WHEN OLD.estado IN ('creado') AND NEW.estado <> OLD.estado",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Sin esto, un `UPDATE` que solo toca `actualizado_en` de un pedido terminal
    // abortaria. El trigger tiene que mirar el CAMBIO, no la fila.
    invariante: "el trigger de los terminales mira el cambio de estado, no cualquier UPDATE",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "BEFORE UPDATE OF estado ON pedidos\nWHEN OLD.estado IN ('repartido', 'cancelado') AND NEW.estado <> OLD.estado",
    a: "BEFORE UPDATE ON pedidos\nWHEN OLD.estado IN ('repartido', 'cancelado')",
    oraculo: ORACULO_RUNTIME,
  },
  // LA MUTACION «reservar y liberar no comparten clave de idempotencia» SE SACO, y
  // hay que decir por que en vez de borrarla en silencio.
  //
  // Existia porque con un solo espacio de nombres, darle a la liberacion la clave de
  // la reserva hacia que saliera por la puerta de idempotencia como «repetida» y no
  // soltara un guarani. Desde que la clave lleva el nombre de la operacion adentro
  // (`claveAplicada`), `reservar\u0001pedido:X:reserva` y `liberar\u0001pedido:X:reserva`
  // son claves distintas: la colision que esa mutacion vigilaba es ESTRUCTURALMENTE
  // imposible, y por eso la mutacion sobrevivia — no porque faltara una prueba.
  //
  // Los dos nombres siguen siendo distintos por higiene, y eso ya no es un invariante
  // que se pueda defender con una prueba. La que lo reemplaza es «cada operacion tiene
  // su propio espacio de claves de idempotencia», mas abajo, que ataca la causa.
  {
    invariante: "cancelar un pedido reservado libera la plata",
    archivo: "src/pedidos/pedidos.ts",
    de: "    if (!(e instanceof Error) || !e.message.includes(RESERVA_DESCONOCIDA)) throw e",
    a: "    if (true) throw e",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Dejarla escrita hace que el barrido de reservas vencidas encuentre este pedido
    // para siempre, y que el read model muestre una retencion que ya no existe.
    invariante: "al cancelar, reserva_vence_en vuelve a NULL",
    archivo: "src/pedidos/pedidos.ts",
    de: "      'UPDATE pedidos SET estado = ?, reserva_vence_en = NULL, actualizado_en = ? WHERE id = ? AND estado = ?',",
    a: "      'UPDATE pedidos SET estado = ?, reserva_vence_en = reserva_vence_en, actualizado_en = ? WHERE id = ? AND estado = ?',",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // La misma clave con otro contenido no puede devolver el pedido del otro.
    invariante: "una clave_idem repetida con otro contenido es un 409, no el pedido ajeno",
    archivo: "src/pedidos/pedidos.ts",
    de: "    if (ya.comprador_id !== comprador.persona_id || ya.monto !== entrada.monto) {",
    a: "    if (false) {",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Sin esto, un pedido sin saldo sale como 500 y queda colgado en `creado`, con
    // un numero ocupado y sin plata.
    invariante: "el saldo insuficiente se reconoce del otro lado del Durable Object",
    archivo: "src/pedidos/pedidos.ts",
    de: "    if (mensaje.includes(SALDO_INSUFICIENTE)) {",
    a: "    if (false) {",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El reintento tiene que reservar hasta el MISMO instante que el intento
    // original. Derivado del reloj de cada intento, un llamador que reintenta cada
    // minuto mantiene la plata retenida para siempre.
    invariante: "la ventana de reserva se deriva del creado_en del pedido",
    archivo: "src/pedidos/pedidos.ts",
    de: "  return instante(new Date(Date.parse(pedido.creado_en) + VENTANA_DE_RESERVA_MS).toISOString())",
    a: "  return instante(new Date(Date.parse(pedido.creado_en) + 1).toISOString())",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // «El pedido y su renglon de bitacora entran juntos o no entra ninguno.» Con dos
    // `.run()` sueltos, un INSERT que choca deja el renglon escrito igual.
    invariante: "el pedido y su bitacora entran en la MISMA transaccion",
    archivo: "src/pedidos/pedidos.ts",
    de: "function enUnLote(d1: D1Database, sentencias: D1PreparedStatement[]): Promise<D1Result[]> {\n  return d1.batch(sentencias)\n}",
    a: "async function enUnLote(d1: D1Database, sentencias: D1PreparedStatement[]): Promise<D1Result[]> {\n  const r: D1Result[] = []\n  for (const s of sentencias) r.push(await s.run())\n  return r\n}",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "un pedido_id sin la forma no llega a la base",
    archivo: "src/pedidos/numero.ts",
    de: "export const PEDIDO_VALIDO = /^RY-\\d{4}-\\d{6,12}$/",
    a: "export const PEDIDO_VALIDO = /^.*$/",
  },
  {
    invariante: "el patron del pedido_id esta anclado",
    archivo: "src/pedidos/numero.ts",
    de: "export const PEDIDO_VALIDO = /^RY-\\d{4}-\\d{6,12}$/",
    a: "export const PEDIDO_VALIDO = /RY-\\d{4}-\\d{6,12}/",
  },
  {
    // El año termina EN EL TEXTO del numero. Sin guarda salen `RY-2026.5-000001` y
    // `RY--1-000001`, y los dos pasan por la columna porque `pedidos.id` es TEXT.
    invariante: "la secuencia rechaza un año que no es un año",
    archivo: "src/pedidos/numero.ts",
    de: "  if (!Number.isInteger(anio) || anio < ANIO_MINIMO || anio > ANIO_MAXIMO) {",
    a: "  if (false) {",
  },
  {
    invariante: "el correlativo se rellena a seis digitos",
    archivo: "src/pedidos/numero.ts",
    de: "  return `RY-${anio}-${String(correlativo).padStart(ANCHO_DEL_CORRELATIVO, '0')}`",
    a: "  return `RY-${anio}-${String(correlativo)}`",
  },
  {
    invariante: "el numero de pedido avanza de a uno",
    archivo: "src/index.ts",
    de: "    const proximo = actual + 1",
    a: "    const proximo = actual",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "nadie pide un pedido a nombre de otro",
    archivo: "src/api/rutas.ts",
    de: "  exigirPlataformaOElMismo(actor, comprador_id)\n\n  const clave_idem = exigirClaveIdem(cuerpo)",
    a: "  const clave_idem = exigirClaveIdem(cuerpo)",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "nadie lee ni cancela el pedido ajeno",
    archivo: "src/api/rutas.ts",
    de: "    exigirPlataformaOElMismo(actor, pedido.comprador_id)\n    return json({ ...pedidoAJson(pedido), correlacion_id }, 200, correlacion_id)",
    a: "    return json({ ...pedidoAJson(pedido), correlacion_id }, 200, correlacion_id)",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Ley 4 en el camino de verdad: sin la capacidad de cliente no se pide.
    invariante: "pedir exige la capacidad de cliente VIGENTE",
    archivo: "src/api/rutas.ts",
    de: "  const veredicto = puede(comprador, 'cliente', momento)\n  if (!veredicto.puede) throw new Problema(403, 'no_puede', { motivo: veredicto.motivo })",
    a: "  const veredicto = puede(comprador, 'cliente', momento)\n  if (false) throw new Problema(403, 'no_puede', { motivo: veredicto.motivo })",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Mutar tambien el arnes. Uno que no puede fallar hace que todo pase: sin el
    // encabezado, TODAS las llamadas salen 401 y ninguna prueba prueba nada.
    invariante: "el arnes del runtime manda el token de verdad",
    archivo: "pruebas-runtime/arnes.ts",
    de: "  if (o.token !== undefined) encabezados['authorization'] = `Bearer ${o.token}`",
    a: "  if (false) encabezados['authorization'] = `Bearer ${String(o.token)}`",
    oraculo: ORACULO_RUNTIME,
  },
  // -------------------------------------------------------------------------
  // ENTREGA 1.3 · lo que arreglaron las dos vueltas de auditoria
  // -------------------------------------------------------------------------
  {
    // El hallazgo mas caro: con el `clave_idem` pelado, las cinco operaciones
    // compartian un espacio de nombres y una acreditacion podia hacerse pasar por la
    // reserva de un pedido. Medido de punta a punta, en las dos direcciones.
    invariante: "cada operacion tiene su propio espacio de claves de idempotencia",
    archivo: "src/billetera/nucleo.ts",
    de: "  return `${operacion}\\u0001${clave_idem}`",
    a: "  return clave_idem",
  },
  {
    // La puerta dice «esto ya se aplico», que NO es «la reserva sigue viva». Sin este
    // guarda, un reintento posterior al vencimiento anotaba `reservado` sobre una
    // reserva muerta.
    invariante: "un reintento no confirma una reserva que ya no esta abierta",
    archivo: "src/billetera/nucleo.ts",
    de: "    if (viva === undefined || viva.estado !== 'abierta') {",
    a: "    if (false) {",
  },
  {
    // `acreditar` tenia este guarda desde la 1.2 y `reservar` no: dos de dos, una
    // arreglada. La reserva nacia y la alarma la deshacia en milisegundos.
    invariante: "reservar() no crea una reserva que naceria vencida",
    archivo: "src/billetera/nucleo.ts",
    de: "  if (entrada.vence_en <= op.momento) {",
    a: "  if (false) {",
  },
  {
    // El CHECK `actualizado_en >= creado_en` explotaba DESPUES de que la plata ya se
    // habia movido: 500 permanente, pedido huerfano y `clave_idem` quemada.
    invariante: "un cambio se sella con un instante que no es anterior al nacimiento de la fila",
    archivo: "src/pedidos/pedidos.ts",
    de: "  return ctx.momento < pedido.actualizado_en ? pedido.actualizado_en : ctx.momento",
    a: "  return ctx.momento",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Un pedido cuya ventana ya paso no se puede completar. Sin esto contestaba 200
    // con `estado: reservado` sobre una reserva que la alarma deshacia enseguida.
    invariante: "una ventana de reserva vencida no se anota como reservada",
    archivo: "src/pedidos/pedidos.ts",
    de: "  if (vence_en <= ctx.momento) {",
    a: "  if (false) {",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El pedido esta muerto: `reserva_id = pedido_id` no se reusa. Sin este bloque
    // quedaba colgado en `creado` esperando un reintento que no existe.
    invariante: "un pedido cuya reserva murio se cierra en vez de quedar colgado",
    archivo: "src/pedidos/pedidos.ts",
    de: "    if (mensaje.includes(RESERVA_YA_NO_ESTA_ABIERTA) || mensaje.includes(RESERVA_NACE_VENCIDA)) {",
    a: "    if (false) {",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // `cancelado` es TERMINAL: lo que quede retenido al entrar queda retenido para
    // siempre. Medido: 45.000 Gs. en un pedido cancelado, sin ningun camino de codigo
    // que los soltara.
    invariante: "ir a cancelado SIEMPRE libera, mire lo que mire el estado",
    archivo: "src/pedidos/pedido.ts",
    de: "  if (puedeHaberRetencion && !retieneDespues) {",
    a: "  if (RETIENEN_PLATA.has(desde) && !retieneDespues) {",
  },
  {
    invariante: "el estado `creado` tiene retencion INCIERTA, no cero",
    archivo: "src/pedidos/pedido.ts",
    de: "export const RETENCION_INCIERTA: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>(['creado'])",
    a: "export const RETENCION_INCIERTA: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([])",
  },
  {
    // «El UPDATE toco una fila» no es lo mismo que «la fila esta asi». Con dos
    // cancelaciones en el mismo milisegundo, las dos contestaban `cancelado: true`.
    invariante: "`cancelado` sale de si ESTE UPDATE toco una fila",
    archivo: "src/pedidos/pedidos.ts",
    de: "  return { pedido: releido, cancelado: (cambio?.meta?.changes ?? 0) > 0 }",
    a: "  return { pedido: releido, cancelado: releido.estado === 'cancelado' }",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // La columna `reserva_vence_en` se escribia y no la comparaba contra el reloj
    // NADIE, con tres comentarios prometiendo el barrido.
    invariante: "el conciliador busca las ventanas ya vencidas, no las vigentes",
    archivo: "src/pedidos/pedidos.ts",
    de: "AND reserva_vence_en IS NOT NULL AND reserva_vence_en <= ?\"",
    a: "AND reserva_vence_en IS NOT NULL AND reserva_vence_en > ?\"",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el conciliador solo toca los pedidos que dicen retener plata",
    archivo: "src/pedidos/pedidos.ts",
    de: "    \"FROM pedidos WHERE estado = 'reservado' AND reserva_vence_en",
    a: "    \"FROM pedidos WHERE estado <> 'nada' AND reserva_vence_en",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el monto de un pedido no se reescribe",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "WHEN NEW.monto <> OLD.monto",
    a: "WHEN NEW.monto <> OLD.monto AND 0",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el comprador de un pedido no se reescribe",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "WHEN NEW.comprador_id <> OLD.comprador_id",
    a: "WHEN NEW.comprador_id <> OLD.comprador_id AND 0",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // Mutar tambien el arnes, segunda parte: si el ayudante que lee las bolsas
    // devolviera cualquier cosa, todas las mediciones de plata de la 1.3 serian humo.
    invariante: "el arnes lee las bolsas de la billetera de verdad",
    archivo: "pruebas-runtime/arnes.ts",
    de: "  return ((await r.json()) as { bolsas: Bolsa[] }).bolsas",
    a: "  return []",
    oraculo: ORACULO_RUNTIME,
  },
  // -------------------------------------------------------------------------
  // ENTREGA 1.3 · lo que arreglo la SEGUNDA vuelta (defectos nacidos de los arreglos)
  // -------------------------------------------------------------------------
  {
    // EL DEFECTO NACIDO DEL ARREGLO: el guarda de «la ventana ya vencio» cancelaba por
    // un atajo que no le preguntaba nada a la billetera, y `cancelado` es TERMINAL.
    // Medido: 45.000 Gs. retenidos, sin ninguna ruta que los soltara.
    invariante: "el pedido con la ventana vencida se cierra SOLTANDO la plata",
    archivo: "src/pedidos/pedidos.ts",
    de: "    await cancelarPedido(p, ctx, comprador, pedido, 'ventana_vencida')",
    a: "    await enUnLote(p.CORE, [p.CORE.prepare('UPDATE pedidos SET estado = ?, actualizado_en = ? WHERE id = ? AND estado = ?').bind('cancelado', selloDe(ctx, pedido), pedido.id, 'creado')])",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El sello comparaba contra `creado_en` y no contra `actualizado_en`, asi que la
    // columna podia retroceder respecto de su propio valor anterior.
    invariante: "el sello no deja retroceder a `actualizado_en`",
    archivo: "src/pedidos/pedidos.ts",
    de: "  return ctx.momento < pedido.actualizado_en ? pedido.actualizado_en : ctx.momento",
    a: "  return ctx.momento < pedido.creado_en ? pedido.creado_en : ctx.momento",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // `quedan` era un booleano disfrazado de contador, con el encabezado prometiendo un
    // conteo. Medido: 57 vencidos, tope 50, la respuesta decia 1.
    invariante: "`quedan` es un conteo, no un booleano",
    archivo: "src/pedidos/pedidos.ts",
    de: "  const quedan = Math.max(0, total - aRevisar.length)",
    a: "  const quedan = total > aRevisar.length ? 1 : 0",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El texto que cruza la frontera del Durable Object salia de un literal escrito a
    // mano justo en la unica funcion a la que alguien compara.
    invariante: "el texto de `reserva desconocida` sale de la constante compartida",
    archivo: "src/billetera/nucleo.ts",
    de: "  if (r === undefined) throw new Error(`${RESERVA_DESCONOCIDA}: ${entrada.reserva_id}`)\n  if (r.estado !== 'abierta') {\n    const valor = { devuelto: CERO }",
    a: "  if (r === undefined) throw new Error(`no conozco esa reserva: ${entrada.reserva_id}`)\n  if (r.estado !== 'abierta') {\n    const valor = { devuelto: CERO }",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "una fila no se puede modificar antes de existir",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "  CHECK (actualizado_en >= creado_en)",
    a: "  CHECK (actualizado_en >= '0000')",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el `creado_en` de un pedido lleva la forma de ancho fijo",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "  CHECK (creado_en LIKE '____-__-__T__:__:__.___Z' AND NOT creado_en GLOB '*[^0-9.:TZ-]*'),",
    a: "  CHECK (creado_en LIKE '%'),",
    oraculo: ORACULO_RUNTIME,
  },
  {
    invariante: "el numero de pedido no se reescribe",
    archivo: "migraciones/core/0004_pedidos.sql",
    de: "WHEN NEW.id <> OLD.id",
    a: "WHEN NEW.id <> OLD.id AND 0",
    oraculo: ORACULO_RUNTIME,
  },
  {
    // El oraculo del esquema comparaba la ultima declaracion LEGIBLE, no la ultima
    // declaracion: con un CHECK escrito a nivel de tabla firmaba en verde contra una
    // definicion vieja. Tercera vez que esta herramienta tiene el mismo defecto.
    invariante: "check-esquema exige que la ultima declaracion sea la que comparo",
    archivo: "herramientas/check-esquema.mjs",
    de: "    if (ultimaDeclaracion !== undefined && ultimaDeclaracion.archivo !== ultima.archivo) {",
    a: "    if (false) {",
    oraculo: conNode('herramientas/check-esquema.pruebas.mjs'),
  },
  {
    // El seguro en disco de la mutacion restauraba SIEMPRE, asi que con una nota vieja
    // sobreviviente borraba trabajo real en silencio.
    invariante: "el seguro de la mutacion no pisa un archivo que cambio por otra razon",
    archivo: "herramientas/mutacion-en-vuelo.mjs",
    de: "  if (enDisco !== nota.mutado) {",
    a: "  if (false) {",
    oraculo: conNode('herramientas/mutacion-en-vuelo.pruebas.mjs'),
  },
  {
    invariante: "el seguro de la mutacion limpia la nota de una corrida ya restaurada",
    archivo: "herramientas/mutacion-en-vuelo.mjs",
    de: "  if (enDisco === nota.original) {\n    borrarLaNota()\n    return false\n  }",
    a: "  if (enDisco === nota.original) {\n    return false\n  }",
    oraculo: conNode('herramientas/mutacion-en-vuelo.pruebas.mjs'),
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

/**
 * EL MISMO SEGURO, PERO EN DISCO — para lo que una señal no puede atrapar.
 *
 * El manejador de `SIGINT`/`SIGTERM` de mas abajo cubre el Ctrl-C. No cubre `SIGKILL`,
 * ni que se caiga el contenedor, ni que se corte la luz. La nota en disco si, y vive
 * en `mutacion-en-vuelo.mjs` porque la usa tambien `restaurar-mutacion.mjs`, que es lo
 * primero que corre `npm run verificar`. El porque de las dos cosas esta entero alla.
 */

// Un Ctrl-C dejaba el arbol con un invariante roto A PROPOSITO en el codigo del
// dinero, porque el `finally` no corre con una señal. Y peor: el SIGINT mataba al
// hijo, `execFileSync` tiraba, la mutacion se contaba como muerta y la corrida
// seguia hasta imprimir "49/49 — Todas murieron". Un veredicto verde con un
// oraculo que nunca corrio.
for (const señal of ['SIGINT', 'SIGTERM']) {
  process.on(señal, () => {
    if (enVuelo !== null) {
      writeFileSync(rutaDe(enVuelo.archivo), enVuelo.original)
      borrarLaNota()
      console.log(`\n\n  ${señal} — restaurado ${enVuelo.archivo}`)
    }
    console.log('  INTERRUMPIDA. El veredicto no vale: no se corrieron todas.\n')
    process.exit(130)
  })
}

// ANTES de la linea de base, y no despues: si quedo una mutacion de una corrida que
// murio, el arbol esta en rojo por eso y el mensaje diria «este oraculo ya falla sin
// mutaciones», que manda a buscar el defecto al lugar equivocado.
//
// Y `npm run verificar` la corre ademas en su PRIMER paso —`restaurar-mutacion.mjs`—
// porque `mutar` es el octavo de ocho: con una mutacion viva, `verificar` muere en el
// tercero y esta linea no llega a correr nunca. Lo midio la segunda vuelta.
restaurarLoQueQuedoDeAntes()

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

  const mutado = original.replace(m.de, m.a)
  enVuelo = { archivo: m.archivo, original }
  anotarEnVuelo(m.archivo, original, mutado)
  writeFileSync(rutaDe(m.archivo), mutado)

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
    borrarLaNota()
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

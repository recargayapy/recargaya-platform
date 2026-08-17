/**
 * El esquema del SQLite que vive DENTRO del BilleteraDO.
 *
 * Por que existe este archivo, y por que no esta escrito adentro de las pruebas:
 * la entrega anterior tenia pruebas que creaban tablas de juguete para comprobar
 * que `STRICT` y los `CHECK` se aplican. Eso demostraba que Cloudflare funciona,
 * no que nuestro esquema los use. Una auditoria lo midio: si el DDL real hubiera
 * salido sin `STRICT`, esas pruebas seguian verdes.
 *
 * Con el DDL acá, exportado, las pruebas ejecutan ESTA cadena, y hay mutaciones
 * que le sacan `STRICT` y los `CHECK` y tienen que morir.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EL ESTADO PASA DE UN BLOB JSON A TABLAS
 *
 * El DO guardaba todo el estado como un unico JSON en la clave `estado`. Medido:
 * 244 bytes por asiento, y el valor de un Durable Object topa en 128 KiB, asi que
 * una billetera quedaba INESCRIBIBLE a los ~534 movimientos. Ademas reescribia el
 * historial entero en cada operacion, y `aplicadas` crece para siempre.
 *
 * Y el plan maestro ya lo pedia por otro motivo: el asiento se escribe en el
 * SQLite del propio Wallet DO, atomicamente con el saldo. El outbox de la ley 5
 * necesita esa misma transaccion. Las dos cosas quieren la misma tabla.
 *
 * ---------------------------------------------------------------------------
 * LAS DECISIONES DE MODELADO, Y LO QUE CADA UNA IMPIDE
 *
 * `STRICT` en todas las tablas. Los guaranies viven en columnas INTEGER, y sin
 * STRICT un '100000' de TEXTO entra y ordena como texto: '9' > '100000'. La
 * restriccion tiene que estar del lado de adentro de la unica puerta al dinero,
 * no en el TypeScript que la llama.
 *
 * `CHECK (monto > 0)` en las bolsas. Una bolsa en cero no es una bolsa: es una
 * fila que ensucia el calculo de precedencia. El nucleo ya las descarta al
 * aplicar tomas; el CHECK lo vuelve imposible en vez de disciplinado.
 *
 * Los asientos NO se editan ni se borran, y eso lo hacen cumplir dos triggers, no
 * un comentario (ley 2). Es la misma decision que en `ledger_copia` de D1, y por
 * la misma razon: un comentario que promete lo que el codigo no hace es peor que
 * el defecto que describe.
 *
 * `totales_ledger` es el acumulado del ledger por tipo de bolsa, mantenido en la
 * MISMA transaccion que el asiento. Existe para que el invariante 2 —«el ledger
 * cuadra con las bolsas»— se pueda comprobar en O(1) en cada escritura, en vez de
 * sumar todos los asientos. La suma exhaustiva sigue existiendo, pero como
 * reconciliacion periodica y en las pruebas, no en el camino caliente.
 *
 *   Ojo con lo que esto es y lo que no: `totales_ledger` es un cache, y comparar
 *   un cache contra las bolsas es mas debil que comparar los asientos contra las
 *   bolsas. Lo que sigue agarrando es la clase de defecto que importa —una
 *   operacion que escribe bolsas sin los asientos que le corresponden, o al
 *   reves— porque el total se actualiza SOLO a partir de los asientos que se
 *   insertan. Lo que NO agarra es una corrupcion del propio cache; para eso esta
 *   la reconciliacion exhaustiva.
 *
 * La cota `consumido <= total(tomas)` es un TRIGGER y no un CHECK, porque SQLite
 * no deja que un CHECK mire otra tabla. Esta es la pieza que el plan maestro pedia
 * y que no existia en ningun lado: `Reserva.consumido` estaba declarado y nada lo
 * acotaba.
 */

/** Los tipos de bolsa, en el orden en que se declaran en `dinero/bolsas.ts`.
 *  `check-esquema.mjs` compara esta lista contra la de TypeScript y contra el
 *  CHECK de la migracion de D1: los tres tienen que decir lo mismo. */
export const TIPOS_DE_BOLSA = [
  'disponible',
  'ganancia_creador',
  'credito_promocion',
  'retenido',
] as const

const CHECK_TIPO_BOLSA = `IN ('${TIPOS_DE_BOLSA.join("', '")}')`

/**
 * El DDL completo, en el orden en que hay que ejecutarlo.
 *
 * Va como lista de sentencias y no como una cadena con `;` adentro porque
 * `ctx.storage.sql.exec()` acepta varias sentencias pero informa el error de la
 * primera que falla sin decir cual era: una lista deja el fallo ubicado.
 */
export const ESQUEMA: readonly string[] = [
  // -------------------------------------------------------------------------
  // Bolsas
  // -------------------------------------------------------------------------
  // El saldo NO es un numero: es un conjunto de bolsas distinguibles con reglas
  // distintas (ley 4 y 11). Cada una lleva origen, vencimiento y restriccion.
  `CREATE TABLE IF NOT EXISTS bolsas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo          TEXT NOT NULL CHECK (tipo ${CHECK_TIPO_BOLSA}),
    monto         INTEGER NOT NULL CHECK (monto > 0),
    vence_en      TEXT,
    origen        TEXT NOT NULL,
    restringida_a TEXT
  ) STRICT`,

  // La precedencia de consumo se decide en `dinero/bolsas.ts`, que es una funcion
  // pura (ley 4). Este indice no la implementa: solo evita recorrer la tabla
  // entera para cargarla. Si algun dia alguien escribe un ORDER BY para decidir
  // que se consume, esta linea NO es la excusa.
  `CREATE INDEX IF NOT EXISTS idx_bolsas_tipo_vence ON bolsas (tipo, vence_en)`,

  // -------------------------------------------------------------------------
  // Asientos — la fuente de verdad del dinero
  // -------------------------------------------------------------------------
  // LA COPIA EN D1 NO ES LA FUENTE. Esta lo es. D1 recibe una copia por outbox,
  // y esa separacion es lo que hace que la ley 1 se cumpla sola: una consulta de
  // reportes es estructuralmente incapaz de tocar esta tabla.
  `CREATE TABLE IF NOT EXISTS asientos (
    asiento_id     TEXT PRIMARY KEY,
    concepto       TEXT NOT NULL,
    monto          INTEGER NOT NULL,
    bolsa          TEXT NOT NULL CHECK (bolsa ${CHECK_TIPO_BOLSA}),
    clave_idem     TEXT NOT NULL,
    correlacion_id TEXT NOT NULL,
    asentado_en    TEXT NOT NULL
  ) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_asientos_fecha ON asientos (asentado_en)`,
  `CREATE INDEX IF NOT EXISTS idx_asientos_correlacion ON asientos (correlacion_id)`,

  // Ley 2, hecha cumplir y no prometida.
  `CREATE TRIGGER IF NOT EXISTS asientos_sin_update
   BEFORE UPDATE ON asientos
   BEGIN
     SELECT RAISE(ABORT, 'un asiento no se edita: se compensa con otro asiento');
   END`,

  `CREATE TRIGGER IF NOT EXISTS asientos_sin_delete
   BEFORE DELETE ON asientos
   BEGIN
     SELECT RAISE(ABORT, 'un asiento no se borra: se compensa con otro asiento');
   END`,

  // -------------------------------------------------------------------------
  // Totales del ledger
  // -------------------------------------------------------------------------
  // El acumulado por tipo de bolsa, actualizado en la misma transaccion que el
  // asiento. Ver el encabezado: es un cache deliberado, con su reconciliacion.
  `CREATE TABLE IF NOT EXISTS totales_ledger (
    bolsa TEXT PRIMARY KEY CHECK (bolsa ${CHECK_TIPO_BOLSA}),
    total INTEGER NOT NULL
  ) STRICT`,

  // -------------------------------------------------------------------------
  // Reservas
  // -------------------------------------------------------------------------
  // Una campaña de promocion no debita: RETIENE. La reserva mueve plata de su
  // bolsa de origen a `retenido`, se consume parcialmente mientras corre, y el
  // remanente vuelve A LA BOLSA DE LA QUE SALIO (ley 11).
  `CREATE TABLE IF NOT EXISTS reservas (
    reserva_id TEXT PRIMARY KEY,
    consumido  INTEGER NOT NULL DEFAULT 0 CHECK (consumido >= 0),
    vence_en   TEXT NOT NULL,
    estado     TEXT NOT NULL CHECK (estado IN ('abierta', 'cerrada', 'cancelada'))
  ) STRICT`,

  // Las reservas abiertas se cargan en cada operacion (el invariante 4 las
  // necesita) y las cerradas no. Parcial, para que la historia no pese.
  `CREATE INDEX IF NOT EXISTS idx_reservas_abiertas
   ON reservas (vence_en) WHERE estado = 'abierta'`,

  // De que bolsa salio cada parte de la reserva. Guarda la bolsa ENTERA y no solo
  // el monto: es lo que hace posible la regla anticajero, devolver el credito como
  // credito y con su vencimiento original.
  `CREATE TABLE IF NOT EXISTS tomas (
    reserva_id    TEXT NOT NULL REFERENCES reservas(reserva_id),
    orden         INTEGER NOT NULL,
    tipo          TEXT NOT NULL CHECK (tipo ${CHECK_TIPO_BOLSA}),
    monto         INTEGER NOT NULL CHECK (monto > 0),
    vence_en      TEXT,
    origen        TEXT NOT NULL,
    restringida_a TEXT,
    PRIMARY KEY (reserva_id, orden)
  ) STRICT`,

  // LA COTA. `Reserva.consumido` existia declarado y NADA lo acotaba: se podia
  // consumir mas de lo reservado, y el remanente que vuelve al usuario habria
  // salido negativo.
  //
  // Va como trigger y no como CHECK porque un CHECK de SQLite no puede mirar otra
  // tabla. Y va en la base y no solo en el nucleo porque es la clase de invariante
  // que tiene que ser imposible de violar, no dificil.
  `CREATE TRIGGER IF NOT EXISTS reservas_consumido_acotado
   BEFORE UPDATE OF consumido ON reservas
   WHEN NEW.consumido > (SELECT COALESCE(SUM(monto), 0) FROM tomas WHERE reserva_id = NEW.reserva_id)
   BEGIN
     SELECT RAISE(ABORT, 'consumido no puede superar el total de las tomas de la reserva');
   END`,

  // -------------------------------------------------------------------------
  // Idempotencia
  // -------------------------------------------------------------------------
  // La clave identifica la INTENCION, no el momento: `{pedido_id}:{paso}`. Esta
  // tabla solo se acuerda de haberla visto y de que devolvio.
  `CREATE TABLE IF NOT EXISTS aplicadas (
    clave_idem  TEXT PRIMARY KEY,
    valor       TEXT NOT NULL,
    aplicada_en TEXT NOT NULL
  ) STRICT`,

  // -------------------------------------------------------------------------
  // Outbox — ley 5
  // -------------------------------------------------------------------------
  // Todo evento se escribe en la MISMA transaccion que el cambio. Esta tabla vive
  // acá adentro y no en D1 justamente por eso: en D1 seria otra transaccion, o sea
  // ninguna garantia. La copia a D1 la hace el publicador, despues, y por eso todo
  // consumidor es idempotente (ley 6).
  `CREATE TABLE IF NOT EXISTS outbox (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo           TEXT NOT NULL,
    cuerpo         TEXT NOT NULL,
    correlacion_id TEXT NOT NULL,
    creado_en      TEXT NOT NULL,
    publicado_en   TEXT,
    intentos       INTEGER NOT NULL DEFAULT 0
  ) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_outbox_pendiente
   ON outbox (id) WHERE publicado_en IS NULL`,
]

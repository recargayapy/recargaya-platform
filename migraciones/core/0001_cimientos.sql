-- 0001 · Cimientos del nucleo transaccional
--
-- Lo minimo que necesita el spike del reparto, y nada mas. La regla del plan
-- maestro es "se prepara el hueco, no se construye el relleno": una columna
-- es barata hoy e imposible manana, pero una tabla sin caso de uso es peso.
--
-- Guaranies: enteros. Sin decimales. No existe el centimo de guarani.
-- Momentos: texto ISO-8601 en UTC. La presentacion en America/Asuncion es
-- responsabilidad de la capa de vista, nunca del almacenamiento.

-- ---------------------------------------------------------------------------
-- Personas y capacidades
-- ---------------------------------------------------------------------------
-- Una cuenta, varias capacidades. Cliente + Vendedor + Creador + Distribuidor
-- conviven sobre la misma persona desde el dia uno (Fase 1 del plan). Modelarlo
-- como un campo "rol" seria la decision irreversible mas cara del proyecto.

CREATE TABLE personas (
  id            TEXT PRIMARY KEY,
  creada_en     TEXT NOT NULL,
  estado        TEXT NOT NULL CHECK (estado IN ('activa', 'suspendida', 'cerrada'))
) STRICT;

CREATE TABLE capacidades (
  persona_id    TEXT NOT NULL REFERENCES personas(id),
  capacidad     TEXT NOT NULL CHECK (capacidad IN ('cliente', 'vendedor', 'creador', 'distribuidor')),
  otorgada_en   TEXT NOT NULL,
  PRIMARY KEY (persona_id, capacidad)
) STRICT;

-- ---------------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------------
-- El pedido NO es un Durable Object: no tiene contencion. Vive en D1.
-- La numeracion si necesita un solo escritor, y esa es SecuenciaDO.

CREATE TABLE pedidos (
  id             TEXT PRIMARY KEY,          -- RY-2026-000001
  comprador_id   TEXT NOT NULL REFERENCES personas(id),
  monto          INTEGER NOT NULL CHECK (monto > 0),
  estado         TEXT NOT NULL CHECK (estado IN ('creado', 'pagado', 'repartido', 'cancelado')),
  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
) STRICT;

-- El indice va sobre la columna SELECTIVA primero. Un indice que arranca por
-- "estado" (cuatro valores posibles) no es un indice: es un escaneo con pasos
-- extra. Este defecto recurrio tres veces en el plugin anterior.
CREATE INDEX idx_pedidos_comprador_creado ON pedidos (comprador_id, creado_en DESC);
CREATE INDEX idx_pedidos_creado_estado    ON pedidos (creado_en DESC, estado);

-- ---------------------------------------------------------------------------
-- Copia del ledger
-- ---------------------------------------------------------------------------
-- LA FUENTE DE VERDAD DEL DINERO NO ESTA ACA.
--
-- El asiento se escribe en el SQLite del propio BilleteraDO, atomicamente con
-- el saldo. Esta tabla es una COPIA que llega por outbox, para consulta y
-- reportes. Esa separacion es lo que hace que la ley 1 se cumpla sola: una
-- consulta de reportes es estructuralmente incapaz de tocar la fuente de
-- verdad del dinero.
--
-- Sin UPDATE ni DELETE, nunca. Un asiento no se edita: se compensa con otro
-- asiento (ley 2). El trigger de mas abajo lo hace imposible, no solo
-- prohibido — un comentario que promete lo que el codigo no hace es peor que
-- el defecto que describe.

CREATE TABLE ledger_copia (
  asiento_id     TEXT PRIMARY KEY,
  billetera_id   TEXT NOT NULL,
  concepto       TEXT NOT NULL,
  monto          INTEGER NOT NULL,          -- positivo credito, negativo debito
  bolsa          TEXT NOT NULL CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion')),
  clave_idem     TEXT NOT NULL,
  correlacion_id TEXT NOT NULL,
  asentado_en    TEXT NOT NULL,
  copiado_en     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_ledger_billetera_fecha ON ledger_copia (billetera_id, asentado_en DESC);
CREATE INDEX idx_ledger_correlacion     ON ledger_copia (correlacion_id);

CREATE TRIGGER ledger_copia_sin_update
BEFORE UPDATE ON ledger_copia
BEGIN
  SELECT RAISE(ABORT, 'un asiento no se edita: se compensa con otro asiento');
END;

CREATE TRIGGER ledger_copia_sin_delete
BEFORE DELETE ON ledger_copia
BEGIN
  SELECT RAISE(ABORT, 'un asiento no se borra: se compensa con otro asiento');
END;

-- ---------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------
-- Ley 5: todo evento se escribe en la MISMA transaccion que el cambio.
-- Ley 6: todo consumidor es idempotente, porque el publicador entrega doble.

CREATE TABLE outbox (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo           TEXT NOT NULL,
  cuerpo         TEXT NOT NULL,             -- JSON
  correlacion_id TEXT NOT NULL,
  creado_en      TEXT NOT NULL,
  publicado_en   TEXT,                      -- NULL = pendiente
  intentos       INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Parcial: el indice solo cubre lo pendiente, que es lo unico que se consulta
-- en caliente. Lo ya publicado es historia y no ensucia el arbol.
CREATE INDEX idx_outbox_pendiente ON outbox (creado_en) WHERE publicado_en IS NULL;

-- ---------------------------------------------------------------------------
-- Bitacora de auditoria
-- ---------------------------------------------------------------------------
-- Con correlacion_id desde el primer endpoint (Fase 1). Poner esto despues
-- significa no poder reconstruir que paso durante los primeros meses.

CREATE TABLE bitacora (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id       TEXT,
  accion         TEXT NOT NULL,
  objetivo       TEXT,
  detalle        TEXT,                      -- JSON, SIN datos personales
  correlacion_id TEXT NOT NULL,
  ocurrido_en    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_bitacora_ocurrido ON bitacora (ocurrido_en DESC);
CREATE INDEX idx_bitacora_actor    ON bitacora (actor_id, ocurrido_en DESC);

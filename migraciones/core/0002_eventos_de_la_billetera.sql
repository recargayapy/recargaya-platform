-- 0002 · Donde aterrizan los eventos que salen del Wallet DO
--
-- POR QUE HACE FALTA UNA TABLA NUEVA, y por que no sirve la que ya hay.
--
-- La ley 5 estaba a medias. El evento se escribe en la MISMA transaccion que el
-- cambio —eso ya funciona, vive en el `outbox` del SQLite del propio BilleteraDO—
-- pero nadie lo sacaba de ahi. Un outbox que nadie vacia es una tabla que crece.
--
-- La tabla `outbox` de 0001 NO es el destino: es el outbox DE D1, para los eventos
-- que nacen acá (un pedido, un reparto). Meter en la misma tabla lo que entra y lo
-- que sale deja un ciclo esperando a que alguien lo escriba.
--
-- LA LEY 6 LA HACE CUMPLIR LA CLAVE PRIMARIA, no la disciplina del publicador.
--
-- El publicador entrega doble por construccion: escribe en D1, y despues marca la
-- fila como publicada en el Durable Object. Si el objeto se cae entre esas dos
-- cosas, la proxima pasada vuelve a mandar lo mismo. Eso no es una hipotesis ni un
-- caso raro: es el precio de tener la escritura del evento adentro de la
-- transaccion del dinero, que es lo que la ley 5 compra.
--
-- Por eso la clave es `(billetera_id, evento_id)`:
--
--   · `evento_id` es el `id` del outbox del DO — un AUTOINCREMENT, o sea monotono
--     y estable DENTRO de esa billetera.
--   · `billetera_id` lo hace unico entre billeteras.
--
-- Con esa clave, la segunda entrega del mismo evento es un `INSERT OR IGNORE` que
-- no hace nada. La idempotencia deja de depender de que el publicador se porte
-- bien: es imposible duplicar, no dificil.
--
-- OJO CON `INSERT OR REPLACE`: un REPLACE borra la fila anterior y eso dispara el
-- trigger de DELETE de mas abajo, que aborta. Es a proposito — el que escriba
-- REPLACE acá se entera con un error y no con una fila pisada en silencio.
--
-- Los asientos NO vienen a esta tabla: van a `ledger_copia`, que existe desde 0001
-- y cuya clave primaria cumple exactamente el mismo papel — despues de que la
-- segunda mitad de esta migracion se la arregle, porque venia mal. El ledger es el
-- ledger y los eventos son los eventos.

CREATE TABLE IF NOT EXISTS eventos_billetera (
  billetera_id   TEXT NOT NULL,
  evento_id      INTEGER NOT NULL,          -- el id del outbox del DO de origen
  tipo           TEXT NOT NULL,
  cuerpo         TEXT NOT NULL,             -- JSON, SIN datos personales (ley 9)
  correlacion_id TEXT NOT NULL,
  creado_en      TEXT NOT NULL,             -- cuando ocurrio, en la billetera
  copiado_en     TEXT NOT NULL,             -- cuando llego acá
  PRIMARY KEY (billetera_id, evento_id)
) STRICT;

-- Lo que un consumidor pregunta de verdad: "que paso desde tal momento" y "que
-- paso con tal pedido". El indice por billetera ya lo da la clave primaria.
CREATE INDEX IF NOT EXISTS idx_eventos_billetera_creado      ON eventos_billetera (creado_en);
CREATE INDEX IF NOT EXISTS idx_eventos_billetera_correlacion ON eventos_billetera (correlacion_id);

-- Un registro de lo que paso que se puede editar despues no es un registro de lo
-- que paso. Misma decision que en `ledger_copia` y por la misma razon: el trigger
-- lo hace imposible, no prohibido.
CREATE TRIGGER IF NOT EXISTS eventos_billetera_sin_update
BEFORE UPDATE ON eventos_billetera
BEGIN
  SELECT RAISE(ABORT, 'un evento ya ocurrido no se edita');
END;

CREATE TRIGGER IF NOT EXISTS eventos_billetera_sin_delete
BEFORE DELETE ON eventos_billetera
BEGIN
  SELECT RAISE(ABORT, 'un evento ya ocurrido no se borra');
END;

-- ---------------------------------------------------------------------------
-- Y la clave primaria de `ledger_copia`, que estaba mal desde 0001
-- ---------------------------------------------------------------------------
-- ESTE ES UN DEFECTO REAL Y LO ENCONTRO EL ARNES, no una lectura. Vale contar
-- como, porque la forma se repite: la primera corrida de las pruebas del
-- publicador dejo `ledger_copia` VACIA en cuatro pruebas y con una sola fila en
-- otra, sin un solo error.
--
-- El asiento se identifica con `${clave_idem}:${sufijo}` — lo arma
-- `nucleo.ts`. Adentro del Durable Object esa clave es unica y alcanza: la
-- PRIMARY KEY de `asientos` es por billetera, porque cada billetera tiene su
-- propio SQLite.
--
-- En D1 no. Acá conviven TODAS las billeteras, y 0001 declaro
-- `asiento_id TEXT PRIMARY KEY` a secas. O sea que dos billeteras distintas con
-- la misma clave de idempotencia chocan.
--
-- Y eso no es un caso raro que haya que forzar: es EL caso del reparto, que es
-- la Fase 1 del plan. Un pago se reparte entre el vendedor, el creador y la
-- plataforma; los tres movimientos son el mismo acto, con la misma clave
-- `{pedido_id}:{paso}`, sobre tres billeteras. Con la clave vieja, el ledger de
-- reportes se quedaba con UNO de los tres.
--
-- Como termina, segun como este escrito el publicador:
--
--   · con `INSERT OR IGNORE` (lo que hace) — los otros dos asientos se descartan
--     en silencio y el panel muestra menos plata de la que se movio
--   · sin `OR IGNORE` — el lote falla por la clave, el outbox no avanza nunca y
--     se traba tambien todo lo que venia atras
--
-- Las dos son peores que un error. La correcta es que la clave diga lo que el
-- dato es: un asiento pertenece a UNA billetera, asi que la identidad es el par.
--
-- SQLite no puede cambiar una clave primaria con un ALTER: hay que reconstruir la
-- tabla. Se copian las filas igual aunque hoy este vacia en los dos entornos —
-- nunca se publico nada, esta entrega crea al publicador— porque una migracion
-- que borra datos cuando se la corre en un entorno que no se previo es una
-- migracion que un dia borra datos.
--
-- Los triggers se sacan primero: un `DROP TABLE` no dispara el de DELETE, pero
-- dejarlos apuntando a una tabla que esta por desaparecer es confiar en ese
-- detalle. Se recrean al final, sobre la tabla nueva.
--
-- CASI TODAS LAS SENTENCIAS LLEVAN `IF EXISTS` / `IF NOT EXISTS`, y no es adorno.
-- D1 no soporta transacciones explicitas: una migracion que falla en el medio deja
-- la base a mitad de camino Y sin registrar como aplicada. Sin las guardas, el
-- reintento moria en la primera linea (`DROP TRIGGER` sobre un trigger que ya no
-- esta) y la unica salida era manual, en produccion, a mano.
--
-- Las dos que NO las llevan son las dos que no pueden: el `INSERT … SELECT FROM
-- ledger_copia` y el `ALTER … RENAME`. SQLite no tiene «si la tabla existe» para
-- ninguna de las dos. (El encabezado decia «CADA SENTENCIA», y era falso por esas
-- dos: lo corrigio la segunda vuelta de auditoria.)
--
-- Lo pidio una auditoria adversarial y tenia razon en el argumento: este mismo
-- encabezado se toma tres parrafos para justificar copiar filas de una tabla vacia
-- «porque una migracion que borra datos cuando se la corre en un entorno que no se
-- previo es una migracion que un dia borra datos», y despues no aplicaba el mismo
-- razonamiento al reintento.
--
-- LO QUE SIGUE SIN SER REANUDABLE, dicho entero: si el corte cae DESPUES del
-- `DROP TABLE ledger_copia` y ANTES del `RENAME`, el reintento encuentra
-- `ledger_copia_nueva` con los datos y `ledger_copia` inexistente. El
-- `INSERT ... SELECT FROM ledger_copia` no puede saltearse solo —SQLite no tiene
-- «si la tabla existe»— asi que ese tramo pide una mano. Es una ventana de dos
-- sentencias sobre una tabla que hoy esta vacia en los dos entornos, y queda
-- escrito acá en vez de descubrirse en el medio.

DROP TRIGGER IF EXISTS ledger_copia_sin_update;
DROP TRIGGER IF EXISTS ledger_copia_sin_delete;

CREATE TABLE IF NOT EXISTS ledger_copia_nueva (
  billetera_id   TEXT NOT NULL,
  asiento_id     TEXT NOT NULL,
  concepto       TEXT NOT NULL,
  monto          INTEGER NOT NULL,          -- positivo credito, negativo debito
  bolsa          TEXT NOT NULL CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion', 'retenido')),
  clave_idem     TEXT NOT NULL,
  correlacion_id TEXT NOT NULL,
  asentado_en    TEXT NOT NULL,
  copiado_en     TEXT NOT NULL,
  PRIMARY KEY (billetera_id, asiento_id)
) STRICT;

INSERT OR IGNORE INTO ledger_copia_nueva (billetera_id, asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en, copiado_en)
SELECT billetera_id, asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en, copiado_en
FROM ledger_copia;

DROP TABLE IF EXISTS ledger_copia;

ALTER TABLE ledger_copia_nueva RENAME TO ledger_copia;

-- El indice por fecha sigue haciendo falta: la clave primaria ordena por
-- `asiento_id` adentro de cada billetera, y `asiento_id` no tiene orden temporal
-- —arranca con la clave de idempotencia, que es `{pedido_id}:{paso}`—. "El
-- extracto de esta billetera, del mas nuevo al mas viejo" lo contesta este.
CREATE INDEX IF NOT EXISTS idx_ledger_billetera_fecha ON ledger_copia (billetera_id, asentado_en DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_correlacion     ON ledger_copia (correlacion_id);

CREATE TRIGGER IF NOT EXISTS ledger_copia_sin_update
BEFORE UPDATE ON ledger_copia
BEGIN
  SELECT RAISE(ABORT, 'un asiento no se edita: se compensa con otro asiento');
END;

CREATE TRIGGER IF NOT EXISTS ledger_copia_sin_delete
BEFORE DELETE ON ledger_copia
BEGIN
  SELECT RAISE(ABORT, 'un asiento no se borra: se compensa con otro asiento');
END;

-- 0003 · Identidad: la billetera de una persona, y la capacidad con historia
--
-- Tres cambios, y los tres son irreversibles una vez que haya plata adentro. Por
-- eso van ANTES del primer endpoint y no despues.
--
-- ---------------------------------------------------------------------------
-- 1 · `personas.billetera_id`: se GUARDA, no se deriva
-- ---------------------------------------------------------------------------
-- Hasta hoy el `billetera_id` era lo que el llamador pasara. Con identidad de
-- verdad tiene que salir de la persona, y hay dos formas: derivarlo en cada
-- lectura, o calcularlo una vez y guardarlo. Se guarda, porque derivarlo talla la
-- correspondencia en piedra y el dia que aparezcan dos cuentas de la misma
-- persona —pasa— fusionarlas exige poder apuntar una a la billetera de la otra.
--
-- QUE GUARDA EXACTAMENTE: el NOMBRE del Durable Object (`billetera:<persona_id>`),
-- que es lo mismo que `ledger_copia.billetera_id` y `eventos_billetera.billetera_id`
-- guardan desde que `BilleteraDO` usa `ctx.id.name`. Que las tres columnas hablen
-- del mismo espacio de identificadores es lo que permite ir de una persona a sus
-- asientos con un JOIN, que es lo que la ley 1 le pide al read model. La primera
-- version de esta entrega guardaba el nombre acá y el id hexadecimal en el ledger:
-- las dos columnas se llamaban igual, ninguna consulta las unia, y nada fallaba.
--
-- ---------------------------------------------------------------------------
-- 2 · `capacidades.hasta`: una capacidad tiene VENTANAS, no un estado
-- ---------------------------------------------------------------------------
-- 0001 declaro `PRIMARY KEY (persona_id, capacidad)`: una sola fila por par, o
-- sea una sola ventana, o sea que revocar solo puede hacerse borrando la fila o
-- pisandola. Las dos pierden la historia, y la historia es lo unico que contesta
-- por que un reparto de marzo pago comision de vendedor a alguien que hoy no lo es.
--
-- La clave pasa a `(persona_id, capacidad, otorgada_en)` y aparece `hasta`. Con
-- eso «¿esta persona puede hacer esto?» se vuelve una pregunta CON MOMENTO —ley 4,
-- la misma que gobierna las bolsas del saldo— y la contesta una funcion pura en
-- `identidad/capacidades.ts`, no un ORDER BY.
--
-- Lo que la clave nueva NO impide es que existan dos ventanas ABIERTAS a la vez
-- para la misma capacidad. Eso no es historia, es un estado sin sentido —¿cual se
-- revoca?— y lo prohibe un indice unico PARCIAL, del lado de la base.
--
-- ---------------------------------------------------------------------------
-- 3 · La bitacora pasa a ser append-only DE VERDAD
-- ---------------------------------------------------------------------------
-- `ledger_copia` (0001) y `eventos_billetera` (0002) tienen triggers que hacen
-- imposible editarlos, y 0001 escribe el criterio: «el trigger lo hace imposible,
-- no solo prohibido — un comentario que promete lo que el codigo no hace es peor
-- que el defecto que describe». `bitacora` no los tenia, y esta entrega —que es la
-- que la empieza a usar— la describia como append-only. Medido: el UPDATE y el
-- DELETE pasaban. Se cierra acá.
--
-- ---------------------------------------------------------------------------
-- POR QUE `personas` SE ALTERA Y `capacidades` SE RECONSTRUYE
-- ---------------------------------------------------------------------------
-- La primera version de esta migracion reconstruia las dos, como hizo 0002 con
-- `ledger_copia`, apoyandose en `PRAGMA defer_foreign_keys`. UNA AUDITORIA LO
-- MIDIO Y NO FUNCIONA: `capacidades` y `pedidos` referencian `personas(id)`, y con
-- una sola fila hija el `DROP TABLE personas` falla con FOREIGN KEY constraint,
-- con el PRAGMA puesto y todo. Dos motivos, los dos medidos sobre SQLite y sobre
-- el motor de D1:
--
--   · el PRAGMA se apaga en cada COMMIT, asi que fuera de una transaccion explicita
--     —que es como D1 corre las migraciones— ya no rige cuando llega el DROP. Este
--     motivo solo alcanza, y es el que decide.
--   · y aun DENTRO de una transaccion, la receta crear-copiar-dropear-RENOMBRAR
--     tampoco cierra: el `RENAME` no decrementa el contador de violaciones
--     diferidas que dejo el DROP del padre, y el COMMIT falla.
--
-- La segunda vuelta de auditoria corrigio la version anterior de esta viñeta, que
-- decia que «un DROP+CREATE incrementa el contador y volver a crear la tabla no lo
-- decrementa». Medido: DROP + CREATE + INSERT de las mismas filas, dentro de una
-- transaccion con el PRAGMA puesto, COMMITEA sin problema. Lo que no cierra es el
-- RENAME. La conclusion no cambia; la explicacion estaba mal, y una explicacion mal
-- escrita es lo que hace que el proximo la aplique donde no corresponde.
--
-- La receta de SQLite para reconstruir una tabla con hijos es `PRAGMA
-- foreign_keys = OFF`, y D1 no deja apagarlo desde una migracion.
--
-- Asi que `personas` NO se dropea. Se le agrega la columna con un ALTER, y lo que
-- un `NOT NULL` habria hecho cumplir lo hacen dos triggers. Es mas codigo y es
-- estrictamente mejor: no hay problema de claves foraneas, no hay ventana entre un
-- DROP y un RENAME, y la migracion no depende de que las tablas esten vacias.
--
-- `capacidades` si se reconstruye, porque su clave primaria cambia y SQLite no
-- puede cambiarla con un ALTER. Eso es seguro: `capacidades` no tiene hijos.
--
-- ---------------------------------------------------------------------------
-- CORRERLA DOS VECES FALLA RUIDOSAMENTE, Y ESO ES LO QUE SE QUIERE
-- ---------------------------------------------------------------------------
-- La version anterior llevaba `IF NOT EXISTS` en todo y copiaba con
-- `INSERT OR IGNORE`. Una auditoria midio a donde llevaba eso: reaplicada entera
-- sobre una base ya migrada, re-derivaba `billetera_id` —borrando justo la fusion
-- de cuentas que es la unica razon de existir de la columna— y copiaba `hasta` como
-- NULL, reabriendo todas las ventanas cerradas. O sea: destruia en silencio las dos
-- cosas que la migracion existe para crear.
--
-- Ahora las dos primeras sentencias son `ALTER TABLE … ADD COLUMN`. Sobre una base
-- ya migrada fallan con «duplicate column name» ANTES de tocar un solo dato. Una
-- migracion que no se puede correr dos veces es mejor que una que se puede correr
-- dos veces y la segunda miente.
--
-- Y las copias van sin `OR IGNORE`: si una fila vieja no pasa el CHECK del instante
-- —`2026-03-01T00:00:00Z` sin milisegundos, por ejemplo— la migracion FALLA en vez
-- de descartarla en silencio y dropear el original. Es el mismo argumento que 0002
-- usa para copiar filas de una tabla vacia, aplicado a la otra mitad.
--
-- ESTA MIGRACION NO ES REANUDABLE EN NINGUN PUNTO, y hay que decirlo asi.
--
-- La version anterior de este parrafo decia «es una ventana de dos sentencias», como
-- 0002. Era falso, y lo midio la segunda vuelta de auditoria simulando el corte
-- despues de cada una de las catorce sentencias: el reintento SIEMPRE muere en la
-- primera, con «duplicate column name: billetera_id». Los `IF NOT EXISTS` que 0002
-- usaba para ser reanudable acá no estan —se sacaron a proposito, para que una
-- reaplicacion no destruya— y ese es el precio.
--
-- Lo que importa de esa medicion no es que falle, sino COMO se lee el fallo: un
-- corte despues del `CREATE UNIQUE INDEX` deja la base sin el indice unico parcial,
-- y el reintento contesta «duplicate column name», que cualquiera lee como «ya
-- estaba aplicada». Ese es el peor estado alcanzable: dos ventanas abiertas de la
-- misma capacidad dejan de ser imposibles, `puede()` contesta que si sobre una
-- capacidad revocada, y no hay un solo error a la vista.
--
-- QUE TAN ALCANZABLE ES, medido: sobre el motor LOCAL de D1 la migracion es
-- atomica. Una migracion que falla se revierte entera —incluido el DDL— y no queda
-- registrada en `d1_migrations`, asi que por el camino de `wrangler d1 migrations
-- apply` la ventana no existe. Sobre D1 REMOTO no se pudo medir. Y por aplicacion a
-- mano (`wrangler d1 execute --file`, una recuperacion, un Time Travel) si se
-- alcanza. Si esto hay que reanudarlo, se reanuda a mano y mirando: no hay atajo.
--
-- 0002 se tomo siete lineas para escribir su propia ventana. Esta se toma estas
-- porque el hueco es mas grande, no mas chico.
--
-- Estado de las bases al escribir esto, medido el 18/08/2026 contra `core-staging`,
-- no supuesto: personas 0 · capacidades 0 · pedidos 0 · ledger_copia 0 · bitacora 0.
-- `core-produccion` no tiene ni `d1_migrations`.

-- ---------------------------------------------------------------------------
-- personas
-- ---------------------------------------------------------------------------

-- LAS DOS PRIMERAS SENTENCIAS DEL ARCHIVO SON LOS DOS `ALTER … ADD COLUMN`, y van
-- juntas acá a proposito. El encabezado promete que una reaplicacion falla antes de
-- tocar un dato; con la de `capacidades` a mitad del archivo esa promesa se sostenia
-- por accidente —abortaba la primera y la segunda nunca corria— y una auditoria la
-- midio: eran la sentencia 1 y la 5, con un UPDATE de datos, un indice y dos
-- triggers en el medio. Ahora la promesa la sostiene el orden.
--
-- La de `capacidades` ademas es lo que hace que la copia de mas abajo pueda decir
-- `SELECT … hasta` en lugar de `SELECT … NULL`: asi una reaplicacion no puede
-- reabrir las ventanas cerradas, porque no llega.

ALTER TABLE personas ADD COLUMN billetera_id TEXT;
ALTER TABLE capacidades ADD COLUMN hasta TEXT;

-- Las filas que ya existieran. Hoy no hay ninguna; se deriva igual, y con la MISMA
-- forma que `identidad/personas.ts` (`billetera:` + id), para que si esto llega a
-- correr sobre una base que no se previo la fila apunte a la billetera correcta en
-- vez de a una inventada. Es la unica linea del archivo que duplica una decision
-- que vive en TypeScript, y queda dicho para que se la encuentre.
UPDATE personas SET billetera_id = 'billetera:' || id WHERE billetera_id IS NULL;

-- Dos personas compartiendo billetera es plata de uno contada como del otro. Es la
-- clase de defecto que no da error: da un saldo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_billetera ON personas (billetera_id);

-- Lo que un `NOT NULL` habria hecho, y que un ALTER no puede agregar sobre una
-- tabla que ya existe. Van los dos —INSERT y UPDATE— porque con uno solo la
-- prohibicion se esquiva escribiendo la fila bien y borrandole la columna despues.
CREATE TRIGGER IF NOT EXISTS personas_exigen_billetera_al_insertar
BEFORE INSERT ON personas
WHEN NEW.billetera_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'una persona sin billetera_id no es una persona');
END;

CREATE TRIGGER IF NOT EXISTS personas_exigen_billetera_al_actualizar
BEFORE UPDATE ON personas
WHEN NEW.billetera_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'una persona sin billetera_id no es una persona');
END;

-- ---------------------------------------------------------------------------
-- capacidades
-- ---------------------------------------------------------------------------

CREATE TABLE capacidades_nueva (
  persona_id    TEXT NOT NULL REFERENCES personas(id),
  capacidad     TEXT NOT NULL CHECK (capacidad IN ('cliente', 'vendedor', 'creador', 'distribuidor')),

  -- Desde cuando, INCLUSIVE. Y hasta cuando, EXCLUSIVE — los dos bordes estan
  -- declarados y probados en `identidad/capacidades.ts`, que es el unico lugar
  -- que los interpreta.
  otorgada_en   TEXT NOT NULL,
  hasta         TEXT,

  -- La forma del instante, del lado de adentro de la base. Es la misma decision
  -- que `billetera/esquema.ts` tomo para los `vence_en`, y por la misma razon:
  -- estas dos columnas se COMPARAN como texto, y dos instantes con anchos
  -- distintos comparan al reves de como corren los relojes. `creada_en` de
  -- `personas` no lo lleva porque no se compara: se lee y se muestra.
  --
  -- QUE ATRAPA Y QUE NO, medido y no supuesto: fija el ancho y la posicion de cada
  -- separador, que es lo que protege el orden. NO atrapa `9999-99-99T99:99:99.999Z`
  -- ni `ZZZZ-ZZ-ZZTZZ:ZZ:ZZ.ZZZZ`, porque `T` y `Z` estan en el alfabeto permitido.
  -- El patron exacto —veinte clases de caracteres— existe y SQLite lo acepta al
  -- crear la tabla y despues revienta en el INSERT con «LIKE or GLOB pattern too
  -- complex», o sea que se desplegaria en verde y fallaria con la primera fila.
  -- La puerta de TypeScript (`instante()`) es la que rechaza esos valores; esto es
  -- defensa en profundidad contra un SQL escrito a mano, no un cierre.
  CHECK (otorgada_en LIKE '____-__-__T__:__:__.___Z' AND NOT otorgada_en GLOB '*[^0-9.:TZ-]*'),
  CHECK (hasta IS NULL OR (hasta LIKE '____-__-__T__:__:__.___Z' AND NOT hasta GLOB '*[^0-9.:TZ-]*')),

  -- `>=` y no `>`. Una ventana que termina antes de empezar es imposible; una de
  -- duracion CERO —otorgar y revocar en el mismo milisegundo— es legitima y no
  -- vale nunca, porque `vigente()` pide `momento < hasta`. Con el `>` estricto que
  -- tenia la primera version, una revocacion en el mismo milisegundo del
  -- otorgamiento salia como 500 y la capacidad quedaba abierta. Lo midio una
  -- auditoria.
  CHECK (hasta IS NULL OR hasta >= otorgada_en),

  PRIMARY KEY (persona_id, capacidad, otorgada_en)
) STRICT;

-- Sin `OR IGNORE`: una fila que el CHECK nuevo rechace tiene que hacer fallar la
-- migracion, no desaparecer un instante antes de que se dropee el original.
INSERT INTO capacidades_nueva (persona_id, capacidad, otorgada_en, hasta)
SELECT persona_id, capacidad, otorgada_en, hasta
FROM capacidades;

DROP TABLE capacidades;

ALTER TABLE capacidades_nueva RENAME TO capacidades;

-- UNA sola ventana abierta por capacidad. Parcial a proposito: las ventanas ya
-- cerradas pueden ser tantas como haya habido, que es todo el punto de guardar la
-- historia.
CREATE UNIQUE INDEX IF NOT EXISTS idx_capacidad_abierta_unica
  ON capacidades (persona_id, capacidad) WHERE hasta IS NULL;

-- Las consultas que existen sobre esta tabla son cuatro, y este indice sirve a UNA:
-- la lectura general `WHERE persona_id = ?` de `cargarPersona`, que no filtra por
-- ventana ni ordena —no puede: la ley 4 prohibe decidir vigencia por orden, y el
-- filtrado por momento lo hace `capacidades.ts` en memoria—. Es mas angosto que la
-- clave primaria y el planificador lo prefiere; eso es todo lo que hace.
--
-- Las otras tres son el INSERT de `otorgarCapacidad` y las dos de
-- `revocarCapacidad`, que si llevan `capacidad = ? AND hasta IS NULL` y las sirve
-- `idx_capacidad_abierta_unica`. (La version anterior de este comentario decia que
-- la consulta era una sola; la segunda vuelta de auditoria conto cuatro, y dos de
-- ellas son el arreglo hermano de esta misma ronda.)
CREATE INDEX IF NOT EXISTS idx_capacidades_persona
  ON capacidades (persona_id);

-- ---------------------------------------------------------------------------
-- bitacora: append-only, como ledger_copia y eventos_billetera
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS bitacora_sin_update
BEFORE UPDATE ON bitacora
BEGIN
  SELECT RAISE(ABORT, 'un registro de auditoria no se edita');
END;

CREATE TRIGGER IF NOT EXISTS bitacora_sin_delete
BEFORE DELETE ON bitacora
BEGIN
  SELECT RAISE(ABORT, 'un registro de auditoria no se borra');
END;

-- Y EL TERCERO, QUE LOS OTROS DOS NO CUBREN.
--
-- `INSERT OR REPLACE` borra la fila en conflicto SIN disparar el trigger de DELETE,
-- salvo que `recursive_triggers` este en ON. Medido sobre D1: el PRAGMA vale 0 —el
-- default— y D1 no lo expone. O sea que un REPLACE pisa una fila de auditoria en
-- silencio, con los dos triggers de arriba puestos.
--
-- Vale decir de donde sale esto: el encabezado de 0002 afirma, sobre
-- `eventos_billetera`, que «un REPLACE borra la fila anterior y eso dispara el
-- trigger de DELETE de mas abajo, que aborta». Es falso, y lo midio la segunda
-- vuelta de auditoria de esta entrega. 0002 ya esta aplicada y su texto queda como
-- historia; lo que corresponde es no repetir el error acá y dejar la correccion
-- escrita donde se la va a encontrar.
--
-- Este trigger cierra el hueco por el unico camino que un REPLACE puede tomar sobre
-- esta tabla: chocar contra la clave primaria `id`. `ledger_copia` y
-- `eventos_billetera` quedan con la misma grieta —hoy inofensiva, porque ningun
-- codigo escribe REPLACE contra ellas— y eso es deuda declarada de esta entrega,
-- no algo que se arregle de paso en una migracion de identidad.
CREATE TRIGGER IF NOT EXISTS bitacora_sin_pisar
BEFORE INSERT ON bitacora
WHEN EXISTS (SELECT 1 FROM bitacora WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'un registro de auditoria no se pisa');
END;

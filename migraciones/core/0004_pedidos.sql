-- 0004 · El pedido: estado nuevo, clave de idempotencia y vencimiento de la reserva
--
-- La tabla `pedidos` existe desde 0001 y nunca se escribio una fila. Esta entrega
-- es la que la empieza a usar, y le faltan tres cosas — las tres irreversibles una
-- vez que haya pedidos con plata reservada adentro.
--
-- ---------------------------------------------------------------------------
-- 1 · `reservado` entra al CHECK de `estado`
-- ---------------------------------------------------------------------------
-- 0001 declaro cuatro estados: creado, pagado, repartido, cancelado. Falta el que
-- separa «el pedido existe» de «la plata del comprador esta retenida», que son dos
-- situaciones completamente distintas y hoy caerian las dos en `creado`.
--
-- La diferencia no es semantica: un pedido en `creado` tiene la plata suelta en las
-- bolsas del comprador, gastable por cualquier otra cosa; uno en `reservado` la
-- tiene en la bolsa `retenido` de su billetera, atada a una reserva con el nombre
-- del pedido. Sin el estado nuevo no hay forma de distinguir un pedido que quedo a
-- medio nacer —porque el Worker murio entre el INSERT y la reserva— de uno que
-- reservo bien. El primero hay que barrerlo; el segundo no se toca.
--
-- Los cinco viven ademas en `EstadoPedido` (`src/pedidos/pedido.ts`), y desde esta
-- entrega `check-esquema.mjs` compara las dos listas: agregar un estado en
-- TypeScript y olvidarlo acá hace fallar `npm run verificar` en vez de fallar en
-- runtime con el pedido ya creado. Esa linea de `FRONTERAS` es la que el encabezado
-- de la herramienta dejo anotada como pendiente en la entrega 1.2 — «cuando
-- `EstadoPedido` se escriba, se agrega la linea acá». Se escribio, se agrega.
--
-- ---------------------------------------------------------------------------
-- 2 · `clave_idem`, UNICA
-- ---------------------------------------------------------------------------
-- Un POST que se corta sin respuesta se reintenta. Sin clave de idempotencia, el
-- reintento crea un SEGUNDO pedido, con su segundo numero, y reserva la plata otra
-- vez: el comprador ve el doble retenido y ninguna de las dos reservas se puede
-- soltar sola.
--
-- `personas` resuelve lo mismo dejando que el llamador elija el `persona_id` y
-- chocando contra la PK. Acá no se puede: el id del pedido lo genera la plataforma
-- (`RY-2026-000001`) justamente para que sea legible y correlativo, asi que el
-- llamador no tiene ningun identificador propio que repetir. Por eso la clave es
-- una columna aparte, y por eso es UNICA del lado de la base: la comprobacion
-- previa en TypeScript da un mensaje entendible, el indice unico es lo que lo hace
-- IMPOSIBLE. Entre la lectura y el INSERT cabe otra peticion — es exactamente el
-- mismo par de guardas que 0003 puso sobre las ventanas de capacidad.
--
-- ---------------------------------------------------------------------------
-- 3 · `reserva_vence_en`
-- ---------------------------------------------------------------------------
-- La reserva de la billetera nace con vencimiento —`reservar()` lo exige— y la
-- alarma del Durable Object la libera sola cuando pasa. Si el pedido no guarda ese
-- instante, D1 no tiene forma de saber que la plata que el pedido dice tener
-- retenida ya volvio a las bolsas: el pedido queda en `reservado` para siempre,
-- mostrando una retencion que no existe.
--
-- Guardarlo acá NO es la fuente de verdad —esa esta adentro de la billetera, como
-- toda la plata— es la copia que le permite al read model contestar «este pedido
-- vence a tal hora» sin despertar el Durable Object. La ley 1 en su forma de
-- siempre.
--
-- Y GUARDARLO NO ALCANZA: hay que LEERLO. La primera version de esta entrega
-- escribia esta columna en dos lugares y no la comparaba contra el reloj en ninguno,
-- con este mismo parrafo prometiendo lo contrario. Las dos vueltas de auditoria lo
-- midieron con el mismo `grep`, y el indice parcial de mas abajo estaba creado para
-- un barrido que no existia. Hoy existe: `conciliarReservasVencidas` en
-- `src/pedidos/pedidos.ts`, que es lo que ese indice sirve.
--
-- ---------------------------------------------------------------------------
-- POR QUE `pedidos` SE RECONSTRUYE Y `personas` NO SE PODIA
-- ---------------------------------------------------------------------------
-- 0003 conto, medido, que `personas` no se puede dropear: `capacidades` y `pedidos`
-- la referencian, y con una sola fila hija el DROP falla con FOREIGN KEY constraint
-- aunque `PRAGMA defer_foreign_keys` este puesto.
--
-- `pedidos` esta del otro lado de esa relacion: es HIJA de `personas` y no tiene
-- hijos propios — ninguna tabla la referencia. Dropear una hija no viola nada.
-- Es la misma situacion en la que estaba `capacidades` en 0003, y por eso acá se
-- puede usar la receta completa crear-copiar-dropear-renombrar, que es la unica
-- forma de cambiar un CHECK y de agregar un UNIQUE en SQLite.
--
-- ---------------------------------------------------------------------------
-- CORRERLA DOS VECES FALLA RUIDOSAMENTE, Y ESO ES LO QUE SE QUIERE
-- ---------------------------------------------------------------------------
-- Misma decision que 0003 y por el mismo motivo. LAS DOS PRIMERAS SENTENCIAS DEL
-- ARCHIVO SON LOS DOS `ALTER … ADD COLUMN`: sobre una base ya migrada fallan con
-- «duplicate column name» ANTES de tocar un solo dato.
--
-- Acá los ALTER hacen ademas un trabajo de verdad, y no solo de guarda: sin ellos,
-- el `INSERT … SELECT` de mas abajo tendria que inventar los valores de las dos
-- columnas nuevas para las filas que ya existieran. Con los ALTER puestos primero,
-- el UPDATE que las rellena es una sentencia visible que dice exactamente que
-- valor le pone a cada fila vieja, y la copia despues las lleva tal cual.
--
-- ESTA MIGRACION NO ES REANUDABLE, y vale lo mismo que 0003 escribio: sobre el
-- motor local de D1 una migracion que falla se revierte entera y no queda
-- registrada, asi que por el camino de `wrangler d1 migrations apply` la ventana no
-- existe. Aplicada a mano si se alcanza, y ahi se reanuda mirando.
--
-- Estado de las bases al escribir esto, medido contra `core-staging` el 18/08/2026:
-- pedidos 0 filas. La derivacion de `clave_idem` para filas viejas de mas abajo no
-- va a correr sobre ninguna fila hoy; se escribe igual porque una migracion que
-- depende de que la tabla este vacia es una migracion que funciona una sola vez.

-- ---------------------------------------------------------------------------
-- Las dos columnas nuevas. PRIMERO, y ver el encabezado.
-- ---------------------------------------------------------------------------

ALTER TABLE pedidos ADD COLUMN clave_idem TEXT;
ALTER TABLE pedidos ADD COLUMN reserva_vence_en TEXT;

-- Las filas que ya existieran. Hoy no hay ninguna.
--
-- `clave_idem` es NOT NULL UNIQUE en la tabla nueva, asi que una fila vieja
-- necesita un valor y tiene que ser distinto para cada una. Se deriva del `id`, que
-- es la clave primaria y por lo tanto ya es unico. El prefijo `legado:` dice de
-- donde salio.
--
-- LO QUE ESTO PUEDE CHOCAR, dicho: `legado:RY-2026-000001` es una clave que un
-- llamador podria mandar —el alfabeto de `CLAVE_IDEM_VALIDA` acepta `:` y `-`— y en
-- ese caso el INSERT del pedido nuevo choca contra el indice unico y sale como 409
-- «clave repetida». Es ruidoso y correcto: nadie pierde plata, el llamador cambia
-- la clave. La alternativa —un prefijo imposible de escribir— pediria sacar
-- caracteres del alfabeto de las claves reales, y eso rompe a los llamadores de
-- verdad para protegerse de cero filas.
UPDATE pedidos SET clave_idem = 'legado:' || id WHERE clave_idem IS NULL;

-- ---------------------------------------------------------------------------
-- La tabla nueva
-- ---------------------------------------------------------------------------

CREATE TABLE pedidos_nueva (
  id             TEXT PRIMARY KEY,          -- RY-2026-000001
  comprador_id   TEXT NOT NULL REFERENCES personas(id),
  monto          INTEGER NOT NULL CHECK (monto > 0),

  -- Los cinco. `reservado` es el que agrega esta migracion; ver el encabezado.
  estado         TEXT NOT NULL CHECK (estado IN ('creado', 'reservado', 'pagado', 'repartido', 'cancelado')),

  -- La clave que el LLAMADOR pone para poder reintentar. NOT NULL: un pedido sin
  -- clave de idempotencia es un pedido que no se puede reintentar sin duplicar, y
  -- dejarla opcional significa que el primer llamador apurado no la manda.
  clave_idem     TEXT NOT NULL,

  -- Cuando vence la retencion en la billetera. NULL mientras el pedido no reservo
  -- —o despues de que la reserva se consumio o se libero— y eso es informacion, no
  -- ausencia de dato: dice que hoy este pedido no tiene plata retenida.
  reserva_vence_en TEXT,

  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,

  -- La forma del instante, del lado de adentro de la base. Mismo criterio que
  -- `capacidades.otorgada_en` en 0003, y por la misma razon: `reserva_vence_en` se
  -- COMPARA como texto contra el momento, y dos instantes con anchos distintos
  -- comparan al reves de como corren los relojes.
  --
  -- `creado_en` y `actualizado_en` lo llevan tambien, y acá si se comparan: el
  -- indice de 0001 ordena por `creado_en DESC`, o sea que una fila escrita con otra
  -- forma sale en la posicion equivocada de cualquier listado.
  --
  -- Que atrapa y que no: fija el ancho y la posicion de cada separador. NO atrapa
  -- `9999-99-99T99:99:99.999Z`. La puerta de TypeScript (`instante()`) es la que
  -- rechaza eso; esto es defensa en profundidad contra un SQL escrito a mano. El
  -- patron exacto revienta en el INSERT con «LIKE or GLOB pattern too complex» —
  -- medido en 0003 — asi que se desplegaria en verde y fallaria con la primera fila.
  CHECK (creado_en LIKE '____-__-__T__:__:__.___Z' AND NOT creado_en GLOB '*[^0-9.:TZ-]*'),
  CHECK (actualizado_en LIKE '____-__-__T__:__:__.___Z' AND NOT actualizado_en GLOB '*[^0-9.:TZ-]*'),
  CHECK (reserva_vence_en IS NULL OR (reserva_vence_en LIKE '____-__-__T__:__:__.___Z' AND NOT reserva_vence_en GLOB '*[^0-9.:TZ-]*')),

  -- Un pedido no se puede actualizar a un instante anterior a su creacion. Es
  -- barato y atrapa el reloj corrido hacia atras, que es la forma en que una fila
  -- termina diciendo que se modifico antes de existir.
  CHECK (actualizado_en >= creado_en)
) STRICT;

-- Sin `OR IGNORE`: una fila vieja que no pase alguno de los CHECK nuevos tiene que
-- hacer FALLAR la migracion, no desaparecer un instante antes de que se dropee el
-- original. Mismo argumento que 0002 y 0003.
INSERT INTO pedidos_nueva (id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en)
SELECT id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en
FROM pedidos;

DROP TABLE pedidos;

ALTER TABLE pedidos_nueva RENAME TO pedidos;

-- ---------------------------------------------------------------------------
-- Indices
-- ---------------------------------------------------------------------------
-- Los dos de 0001 se van con el DROP y hay que volver a crearlos. Van tal cual
-- estaban, con el mismo comentario que 0001 les puso: el indice arranca por la
-- columna SELECTIVA, porque uno que arranca por `estado` (cinco valores posibles)
-- no es un indice, es un escaneo con pasos extra.

CREATE INDEX IF NOT EXISTS idx_pedidos_comprador_creado ON pedidos (comprador_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_creado_estado    ON pedidos (creado_en DESC, estado);

-- LA CLAVE DE IDEMPOTENCIA, unica. Es lo unico que impide que un reintento
-- duplique un pedido y reserve la plata dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_clave_idem ON pedidos (clave_idem);

-- Para el barrido de pedidos cuya reserva ya vencio: la consulta de
-- `conciliarReservasVencidas`, que filtra por `estado = 'reservado'` y
-- `reserva_vence_en <= ?` y ordena por esa misma columna. Parcial: solo las filas que
-- dicen tener algo retenido, que son las unicas que se consultan en caliente. Lo
-- demas es historia y no ensucia el arbol. (Mismo criterio que
-- `idx_outbox_pendiente`.)
CREATE INDEX IF NOT EXISTS idx_pedidos_reserva_vence
  ON pedidos (reserva_vence_en) WHERE reserva_vence_en IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Un estado terminal es TERMINAL
-- ---------------------------------------------------------------------------
-- 0001 escribio el criterio de este proyecto: «el trigger lo hace imposible, no
-- solo prohibido — un comentario que promete lo que el codigo no hace es peor que
-- el defecto que describe».
--
-- La maquina de estados vive en `src/pedidos/pedido.ts` y es la que gobierna. Este
-- trigger NO la duplica: hace cumplir UNA sola de sus consecuencias, la mas cara y
-- la mas simple de escribir en SQL — de `repartido` y de `cancelado` no sale ningun
-- camino. Sin esto, un `UPDATE pedidos SET estado = 'creado'` sobre un pedido ya
-- repartido pasa sin una queja, y ese pedido vuelve a ser reservable y cobrable por
-- segunda vez.
--
-- LO QUE ESTE TRIGGER NO CUBRE, y queda como deuda declarada de esta entrega: el
-- resto del grafo. `creado -> pagado` —cobrar sin haber reservado nunca— la base lo
-- acepta; lo impide `transicionar()`, del lado de TypeScript, que es el unico
-- camino por el que este sistema escribe. Poner el grafo entero en un trigger
-- significaria una segunda copia de la tabla de transiciones, en otro lenguaje,
-- que nadie compara — y esa es la categoria de defecto que `check-esquema.mjs`
-- existe para cerrar, no para crear.
--
-- Y LA DERIVA QUE ESTO SI PUEDE TENER, dicha entera: la lista de abajo son los
-- terminales de HOY. Si algun dia `TRANSICIONES` gana un estado terminal nuevo
-- —`reembolsado`, por ejemplo— y nadie toca este trigger, la base deja de proteger
-- ese estado. Es degradacion, no corrupcion: TypeScript lo sigue impidiendo. Queda
-- escrito acá porque la unica forma de que no pase es que alguien lea esto.
CREATE TRIGGER IF NOT EXISTS pedidos_terminal_es_terminal
BEFORE UPDATE OF estado ON pedidos
WHEN OLD.estado IN ('repartido', 'cancelado') AND NEW.estado <> OLD.estado
BEGIN
  SELECT RAISE(ABORT, 'un pedido repartido o cancelado no cambia de estado');
END;

-- ---------------------------------------------------------------------------
-- LAS TRES COLUMNAS QUE ATAN EL PEDIDO A SU PLATA
-- ---------------------------------------------------------------------------
-- El numero de pedido no se reescribe. Es lo que el comprador tiene anotado, lo que
-- va a aparecer en una factura, y lo que nombra la reserva de plata adentro de la
-- billetera (`reserva_id = pedido_id`). Cambiarlo desata la reserva del pedido sin
-- que nada falle.
--
-- Y el mismo argumento vale para las OTRAS DOS columnas que atan el pedido a su
-- plata. La primera version de esta migracion blindo una de las tres, y lo midio la
-- primera vuelta de auditoria:
--
--   · con el `monto` reescrito de 30.000 a 90.000, el pedido dice 90.000 y la
--     billetera retiene 30.000. El cobro va a pedir consumir 90.000 de una reserva
--     de 30.000 y el pedido queda clavado; para el otro lado quedan 60.000
--     retenidos que nadie reclama.
--   · con el `comprador_id` reescrito, cancelar sale 500 —«reserva desconocida»,
--     porque busca en la billetera equivocada— y la plata queda retenida en la
--     billetera vieja.
--
-- Que hoy ninguna ruta escriba esas columnas no salva: este trigger existe
-- exactamente contra un UPDATE a mano, una migracion futura o una correccion de
-- soporte, que es de donde vienen los tres casos de arriba.

CREATE TRIGGER IF NOT EXISTS pedidos_id_no_se_reescribe
BEFORE UPDATE OF id ON pedidos
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'el numero de pedido no se reescribe');
END;

CREATE TRIGGER IF NOT EXISTS pedidos_monto_no_se_reescribe
BEFORE UPDATE OF monto ON pedidos
WHEN NEW.monto <> OLD.monto
BEGIN
  SELECT RAISE(ABORT, 'el monto de un pedido no se reescribe: es lo que su reserva retiene');
END;

CREATE TRIGGER IF NOT EXISTS pedidos_comprador_no_se_reescribe
BEFORE UPDATE OF comprador_id ON pedidos
WHEN NEW.comprador_id <> OLD.comprador_id
BEGIN
  SELECT RAISE(ABORT, 'el comprador de un pedido no se reescribe: su billetera es la que retiene');
END;

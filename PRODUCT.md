# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Una sola persona: la dueña de la memoria, desarrolladora que trabaja con agentes de código (Claude Code y otros). Abre la web a diario, sobre todo para validar lo que los agentes guardaron (aprobar o rechazar pendientes); buscar, corregir y mantener entradas es secundario. También la usa desde el celular y quiere operarla solo con teclado.

## Product Purpose

agent-memory es la memoria local de los agentes de código: lecciones, decisiones, convenciones, referencias, preferencias y proyectos en SQLite en la máquina de la persona, con búsqueda por texto y por significado (embeddings locales), servida a los agentes por un servicio local, un servidor MCP y la integración con Claude Code. La web es el lugar donde la persona gobierna esa memoria: decide qué entra (validación), qué sigue vigente (revisión), corrige, fusiona, exporta y controla quién la lee desde otras máquinas. Éxito: la memoria que leen los agentes es confiable porque la persona la revisó sin fricción.

## Positioning

La memoria la escriben agentes pero la valida una persona: nada entra como validado ni vence solo sin una decisión humana. Todo corre local; los resultados remotos se marcan como dato externo.

## Operating Context

- Web servida por el servicio local en `127.0.0.1`, abierta con `agent-memory open`; sesión por cookie HttpOnly.
- Flujo diario: los agentes crean entradas pendientes → la persona las aprueba o rechaza (con motivo), una a una o en lote.
- Revisión periódica: entradas sin uso o sin verificar pasado un umbral de días; se confirman vigentes, se caducan o se editan.
- Acceso remoto: otra máquina se enlaza con un código de 10 minutos y lee con alcance elegido por dispositivo; cada lectura y rechazo queda registrado.

## Capabilities and Constraints

- Pantallas: Buscar, Pendientes (bandeja), Revisión, Detalle (editar, cambiar ámbito, caducar, revertir, relaciones, revisiones con restaurar), Fusionar, Exportar, Acceso remoto.
- Vocabulario: tipo (leccion, decision, convencion, referencia, preferencia, proyecto); ámbito (global, proyecto, repo) con referencia; validación (pendiente, validada, rechazada, o trabajo); vida (activa, reemplazada); vigencia/caducidad.
- La web funciona sin red: sin fuentes ni recursos externos.
- Tema claro y oscuro según el sistema.
- Usable en celular.
- Operable solo con teclado.
- La interfaz y sus mensajes están en español (voseo rioplatense en el copy actual).
- Stack: React + Vite + TypeScript, CSS propio sin framework (`web/`).

## Brand Commitments

- Nombre en minúsculas: `agent-memory`.
- Copy sobrio y literal; los mensajes nombran lo que pasó y qué hacer.

## Evidence on Hand

- Datos reales de la memoria de la persona (títulos de entradas, ámbitos de proyectos). No hay métricas de uso, testimonios ni capturas oficiales.

## Product Principles

1. La persona decide: validar, caducar y revertir son decisiones explícitas, nunca automáticas.
2. El contenido se lee sin entrar al detalle: validar exige ver qué dice la entrada.
3. Densidad antes que aire: muchas entradas por pantalla, escaneables.
4. El estado se comunica con precisión; nada decorativo que no informe estado.
5. Local y sin red: la web no depende de nada externo.

## Accessibility & Inclusion

- Operación completa con teclado (atajos para aprobar, rechazar y navegar).
- Contraste suficiente en claro y oscuro.

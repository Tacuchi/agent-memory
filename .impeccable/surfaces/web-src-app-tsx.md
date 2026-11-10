---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: ["web/src/pantallas","web/src/estilos.css"]
---

# Surface: web de agent-memory (todas las pantallas)

Mode: Operate. Audiencia: la dueña de la memoria, a diario, validando lo que guardaron los agentes; también celular y solo teclado. Entrada: Resumen. Restricciones: sin red, claro y oscuro, celular, teclado. Evitar: perder densidad, SaaS genérico, decoración, esconder el contenido.

## Direction contract

THESIS: la memoria se opera como una consola de paneles persistentes: estado, cola y vista previa a la vez; la vista previa muestra el contenido completo de la entrada enfocada. Rechaza el dashboard de tarjetas con métricas y la lista que obliga a entrar al detalle.

OWN-WORLD: fondo grafito, paneles divididos por costuras de 1 px sin sombras, un escalón de elevación. Acentos tomados de la sintaxis solo para estado: amarillo pendiente, verde validada, rojo rechazada, violeta para revisar, azul enlaces/foco. Sans del sistema compacta, cifras tabulares, encabezados de panel en versalitas. Modo claro con el mismo sistema en grises claros.

STORY: al abrir, la persona ve cuántas esperan, lee la primera completa y la aprueba o rechaza sin salir; j/k recorre, a aprueba, r rechaza con motivo.

FIRST VIEWPORT: barra superior 48 px (marca, pestañas con conteos, atajos). Debajo tres paneles: Estado (≈280 px: conteos por estado, servicio, remoto), Cola de pendientes (lista densa, fila enfocada marcada con costura azul), Vista previa (título, estado, contenido completo, Aprobar; Rechazar aislado abajo con su motivo).

FORM: challenger digital-design-canon-dark-first-developer-console (elegido por la persona sobre la dirección asignada); seed:4f4c980784e18073.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

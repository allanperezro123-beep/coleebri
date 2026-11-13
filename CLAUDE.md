# Coleebri — Guía de Arquitectura para Claude & Desarrollo Móvil

**Coleebri** es una biblioteca académica digital abierta conectada con SciELO, OpenAlex y Crossref, desplegada en **Cloudflare Pages + Pages Functions + D1**. Su identidad visual honra al colibrí emblemático de la **Universidad Pedagógica Nacional de Colombia** (UPN).

## Stack
- **Frontend:** React 19 + Vite 8 + Tailwind CSS v4 + Lucide Icons (`src/`)
- **Lector PDF:** `pdfjs-dist` (`PdfReaderModal.tsx`) con ajuste móvil automático, lectura nocturna y proxy CORS/Cache en el borde (`functions/api/pdf-proxy.ts`)
- **Edge API (Cloudflare Pages Functions):** `functions/api/*`
- **Base de datos Edge:** Cloudflare D1 (`coleebri-db`, binding `DB` en `wrangler.toml`)

## Mapa rápido de archivos
- `src/components/ColeebriLogo.tsx` — Logo vectorial del colibrí estilo UPN Colombia + micro-animación reactiva al hover.
- `src/components/Header.tsx` — Barra superior, buscador instantáneo con autocompletado y acceso rápido a estanterías.
- `src/components/QuickFilterBar.tsx` — Filtros rápidos sin fricción (Idioma, País, Año/Fecha, Texto completo).
- `src/components/FacetSidebar.tsx` — Panel lateral / cajón móvil con filtros por País, Idioma, Fecha, Área OCDE/UNESCO y Tipo.
- `src/components/CatalogGrid.tsx` & `BookCard.tsx` — Vistas en cuadrícula / lista, paginación progresiva y tarjetas editoriales.
- `src/components/PreviewDrawer.tsx` — Ficha del libro, resumen completo y citación en 1 clic (APA 7, IEEE, BibTeX).
- `src/components/PdfReaderModal.tsx` — Lector móvil y de escritorio con carga progresiva por rangos de bytes (`Content-Disposition: inline`).
- `src/hooks/useCatalog.ts` — Carga paginada desde `/api/catalog`, búsqueda en vivo `/api/search` y estadísticas facetadas.
- `functions/api/catalog.ts` — CRUD y consultas SQL facetadas sobre D1 (`country`, `language`, `publication_year`, `oecd_area`, `doc_type`).
- `functions/api/pdf-proxy.ts` — Proxy seguro para SciELO/OpenAccess con Cloudflare Cache API (`caches.open('scielo-pdf-v1')`) y eliminación de `X-Frame-Options` / descargas forzadas.
- `functions/api/scielo-sync.ts` — Sincronización regional OAI-PMH, OpenAlex y Crossref `10.7476`.
- `migrations/0001_init.sql` & `migrations/0002_seed.sql` — Esquema y semilla inicial en D1.

## Reglas de diseño y código al editar con Claude
1. **Paleta rota (sin `#000` ni `#FFF` puros):** usa las variables CSS en `src/index.css` (`--bg-page`, `--bg-surface`, `--accent-upn`, `--accent-gold`, `--accent-jade`).
2. **Cero fricción:** no pedir registro ni login; priorizar lectura inmediata dentro del navegador y en móviles.
3. **Verificación antes de hacer push:**
   ```bash
   npm run typecheck
   npm run build
   ```
4. **Despliegue automático:** cada push a `main` dispara despliegue automático en Cloudflare Pages (via integración Git de Cloudflare Pages o `.github/workflows/deploy.yml`).

## Tareas pendientes para Claude (lo que pidió el usuario)

Cuando el usuario continúe trabajando este repositorio con Claude desde el celular, priorizar estas mejoras pendientes:

1. **Cargar TODOS los libros (cosecha masiva real en D1):**
   - Actualmente `coleebri-db` tiene ~187 registros iniciales (`migrations/0002_seed.sql` + primera sincronización regional).
   - Ampliar `scripts/sync-scielo.ts` para recorrer **todas las páginas OAI-PMH** usando `<resumptionToken>` (`https://oai.books.scielo.org/oai-pmh?verb=ListRecords&metadataPrefix=oai_dc`), más colecciones regionales (especialmente **Colombia `scielo.org.co`**, UPN / universidades colombianas, Brasil, México, Argentina, Chile, Perú) y OpenAlex paginado por cursor (`cursor=*`), filtrando registros con texto completo real y regenerando el seed/D1 sin tope artificial.
2. **Garantizar textos completos y cero descargas forzadas en TODOS los libros:**
   - Hay libros cuyo enlace viene desde Crossref/DOI o páginas puente HTML que todavía no resuelven un PDF directo o carecen de texto completo.
   - Mejorar `functions/api/pdf-proxy.ts` y `src/components/PdfReaderModal.tsx` para:
     1) Agregar un endpoint `/api/book-text?url=...` que extraiga el **texto completo HTML limpio (capítulos/secciones)** de SciELO Books y artículos SciELO cuando el PDF falle o para ofrecer un **Modo Lectura Fluida / Texto Reflowable** ideal en celulares (tamaño de fuente ajustable sin hacer zoom horizontal).
     2) Resolver redirecciones `doi.org` → `books.scielo.org/id/...` o `scielo.org.*` guardando el `pdf_url` real en D1 (`lazy cache` al abrir) y ocultar o marcar claramente cualquier ficha sin texto completo accesible.
3. **Refinar país (`country`) e idioma por editorial/colección:**
   - Reclasificar los registros que aún aparecen como `Internacional` en D1 ampliando `inferCountry()` en `src/lib/taxonomy.ts` (por editorial, ISSN/ISBN prefijo `978-958` → Colombia, `978-65`/`978-85` → Brasil, `978-607`/`978-968` → México, etc.).
4. **Pulido móvil y rendimiento:**
   - Paginación / carga infinita automática con `IntersectionObserver` al final de `CatalogGrid.tsx` y caché offline ligero (PWA / Service Worker opcional) para seguir leyendo capítulos abiertos desde el celular.


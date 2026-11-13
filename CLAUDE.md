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

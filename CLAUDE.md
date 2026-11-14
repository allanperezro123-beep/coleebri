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

## Modelo de seguridad (NO romper)

Coleebri no tiene cuentas de usuario por diseño. La seguridad se apoya en estas reglas:

1. **Nadie anónimo escribe el catálogo.** `POST /api/catalog` y `POST /api/scielo-sync` exigen `Authorization: Bearer <ADMIN_TOKEN>` (secreto de ≥ 24 caracteres: `npx wrangler pages secret put ADMIN_TOKEN --project-name=coleebri`). El "caché perezoso" de búsquedas lo hace el **servidor** (`search.ts` vía `waitUntil`) con datos que él mismo obtuvo, nunca datos enviados por el cliente.
2. **Estanterías privadas por dispositivo.** El navegador genera una llave aleatoria (`coleebri:owner-key:v1`) y la envía en `X-Coleebri-Owner`; D1 guarda solo su SHA-256 (`owner_shelves`, `owner_shelf_items`, migración `0003`). Toda consulta lleva `WHERE owner_hash = ?`.
3. **Solo mismo origen.** No existe CORS `*`. `functions/api/_middleware.ts` rechaza POST/DELETE de otro origen (CSRF), limita la tasa por IP, aplica cabeceras de seguridad y responde errores genéricos (nunca `err.message` de SQL/upstream).
4. **Proxy PDF cerrado.** `pdf-proxy.ts` solo acepta hosts académicos de la allowlist (`functions/security.ts → TRUSTED_CONTENT_HOST`), revalida **cada redirección**, solo devuelve `application/pdf` o imágenes ráster (nunca HTML/SVG/JS), con timeouts y tope de bytes aun sin `Content-Length`.
5. **Toda URL del catálogo es no confiable**: en el servidor pasa por `safeUrlString`, en el cliente por `src/lib/safeUrl.ts` antes de usarla en `href`/`src`.
6. **CSP estricta** en `public/_headers` (`script-src 'self'`, sin `eval`, sin scripts inline). pdf.js usa `isEvalSupported: false`. Si agregas un origen externo, agrégalo a la CSP a propósito.
7. **Consultas D1 acotadas**: LIKE siempre con `escapeLike` + `ESCAPE '\\'`, patrones ≤ 50 bytes, ≤ ~100 parámetros por sentencia, listas de filtros ≤ 10 valores.
8. Para límites de tasa "duros" (más allá del limitador por isolate), conecta un dominio propio a Cloudflare y crea una regla WAF de rate limiting sobre `/api/*`.

Variables opcionales: `CONTACT_EMAIL` (polite pool de OpenAlex/Crossref; nunca en el código), `OPENALEX_API_KEY` / `HARVEST_CONTACT_EMAIL` para el cosechador local.

## Estado del backlog (v2.1, 2026-11-14)

1. **Cosecha masiva — HECHO.** `npm run harvest -- --types=book` (`scripts/harvest/*`, reanudable desde `scripts/.harvest-cache/`). OpenAlex + Crossref + páginas de SciELO Books → 2.277 libros únicos, 1.478 con PDF de texto completo. Salida en `migrations/seed/seed_NNN.sql` (lotes ≤ 200 filas, UPSERT idempotente). `oai.books.scielo.org` y `opds.livros.scielo.org` tienen el certificado TLS vencido: se omiten, **nunca** se desactiva la verificación TLS. `scielo.org.co` (OAI) no responde.
2. **Texto completo sin descargas forzadas — HECHO.** "Lectura fluida" se extrae en el navegador con pdf.js (`src/lib/reflow.ts`): SciELO Books no publica texto HTML (solo PDF/EPUB), y un endpoint que descargue HTML de terceros añadiría superficie de ataque. El proxy resuelve DOI/landing → PDF y lo recuerda en D1 (`pdf_url`, solo si estaba vacío). Las obras sin PDF muestran "Ver ficha" y el filtro "Solo texto completo" viene activo.
3. **País e idioma — HECHO.** `inferCountry()` usa ISBN (incl. bloques nuevos 978-628 Colombia, 978-631 Argentina), dominio regional y editorial antes del respaldo débil `books.scielo.org → Brasil`. `npm run db:reindex:<local|remote>` reclasifica filas existentes y llena `search_text`.
4. **Móvil y rendimiento — HECHO.** Carga infinita con `IntersectionObserver`, pdf.js diferido, PWA (`public/sw.js`): el lector pide guardar el libro abierto para releerlo sin conexión (máx. 12 PDFs ≤ 25 MB).

### Pendientes / ideas
- Íconos PNG 192/512 para que la PWA sea instalable en todos los navegadores (hoy solo SVG).
- Purga programada (cron Worker) de estanterías anónimas sin actividad en N días.
- Pasada opcional de capítulos (`--types=book,chapter`, ~9.600 con PDF) y artículos regionales.
- Dominio propio + regla WAF de rate limiting sobre `/api/*`.

## Puesta en producción (en este orden)

```bash
npx wrangler pages secret put ADMIN_TOKEN --project-name=coleebri   # >= 24 caracteres aleatorios
npm run db:migrate:003:remote     # estanterías privadas
npm run db:migrate:005:remote     # columna search_text (ANTES de desplegar: la API la usa)
npm run db:backfill:remote        # país de los 117 registros del seed original
npm run db:seed:chunks:remote     # 2.277 libros cosechados
npm run db:reindex:remote         # search_text + reclasificación de países
npm run deploy                    # o push a main con los secretos de CI configurados
```

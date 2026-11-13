# Coleebri · Biblioteca Académica Abierta

**Coleebri** es una biblioteca científica digital de acceso abierto conectada con **SciELO Books**, **OpenAlex** y **Crossref**, desplegada en **Cloudflare Pages + Pages Functions + D1**, con una identidad editorial inspirada en el colibrí emblemático de la **Universidad Pedagógica Nacional de Colombia** (UPN).

## Características principales

- **Identidad Colibrí UPN Colombia:** Logo SVG de autor con micro-animación reactiva, paleta editorial marfil roto y azul cobalto UPN (`#1758C4`), y modo archivo nocturno.
- **Descubrimiento sin fricción ni registro:** Buscador instantáneo con autocompletado O(1), barra rápida de filtros (**Idioma**, **País**, **Año/Fecha** y **Solo lectura directa**) y cajón lateral opcional de áreas OCDE/UNESCO.
- **Lectura en cualquier dispositivo (sin descargas forzadas):** Visor integrado con `pdfjs-dist` adaptado a móviles (autoajuste de ancho, barra inferior táctil, gestos swipe, búsqueda interna y modo noche). El proxy Edge `/api/pdf-proxy` fuerza `Content-Disposition: inline`, elimina bloqueos `X-Frame-Options`, cachea con Cloudflare Cache API y resuelve páginas puente/DOI de SciELO.
- **Listo para evolucionar con Claude desde el celular:** Incluye [`CLAUDE.md`](./CLAUDE.md) y flujo CI/CD [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml).

## Estructura del proyecto

- `src/components/` — `ColeebriLogo.tsx`, `Header.tsx`, `QuickFilterBar.tsx`, `FacetSidebar.tsx`, `CatalogGrid.tsx`, `BookCard.tsx`, `PreviewDrawer.tsx`, `PdfReaderModal.tsx`, `ShelvesModal.tsx`, `SyncStatusModal.tsx`
- `src/hooks/` — `useCatalog.ts`, `useShelves.ts`
- `functions/api/` — `catalog.ts`, `search.ts`, `scielo-sync.ts`, `shelves.ts`, `pdf-proxy.ts`
- `migrations/` — `0001_init.sql` (esquema D1 con columna `country`), `0002_seed.sql`
- `scripts/sync-scielo.ts` — Script Node de cosecha OAI-PMH / OPDS / OpenAlex

## Desarrollo local

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

## Conexión GitHub ↔ Cloudflare Pages (para editar con Claude desde el celular)

Existen **dos formas** de mantener despliegue automático al editar el repositorio desde Claude en el celular:

1. **Integración Git nativa de Cloudflare Pages (recomendada — sin tokens manuales):**
   - Entra a **Cloudflare Dashboard → Workers & Pages → `coleebri` → Settings → Builds & deployments → Connect to Git**.
   - Selecciona el repositorio `allanperezro123-beep/coleebri`, rama `main`, build command `npm run build` y directorio `dist`.
2. **GitHub Actions (incluido en `.github/workflows/deploy.yml`):**
   - Agrega los secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` en GitHub → Settings → Secrets and variables → Actions.

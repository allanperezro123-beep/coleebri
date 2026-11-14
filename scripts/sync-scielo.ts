/**
 * Deprecated entry point, kept so `npm run sync:scielo` keeps working.
 * The old OAI-PMH script depended on oai.books.scielo.org (expired TLS cert, bypassed with
 * rejectUnauthorized:false) and rewrote src/data/seedCatalog.json + 0002_seed.sql in place.
 * It is replaced by the resumable pipeline in scripts/harvest/ (same CLI flags): see `npm run harvest`.
 */
import './harvest/index';

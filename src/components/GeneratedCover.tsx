import type { CSSProperties } from 'react';
import { areaFillColor, areaTextColor, formatAuthors, langAttr } from '../lib/publication';
import { sourceInfo } from '../lib/sources';
import type { Publication } from '../types/publication';

const MOTIFS = ['lines', 'grid', 'arcs', 'hatch'] as const;

/** Stable small hash so a work always gets the same motif. */
function hashOf(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** Words that keep their capitals when an ALL CAPS title is set in sentence case (best effort). */
const KEEP_CAPS: Record<string, string> = Object.fromEntries(
  [
    'Colombia', 'Bogotá', 'Medellín', 'Cali', 'América', 'Latina', 'Latinoamérica', 'Iberoamérica', 'Brasil',
    'México', 'Argentina', 'Chile', 'Perú', 'Ecuador', 'Venezuela', 'Bolivia', 'Paraguay', 'Uruguay', 'Cuba',
    'España', 'Europa', 'África', 'Asia', 'Caribe', 'Andes', 'Amazonía', 'Unesco', 'UPN', 'OCDE', 'ONU', 'OMS',
    'COVID', 'COVID-19', 'TIC', 'IA'
  ].map((word) => [word.toLocaleLowerCase('es'), word])
);

/** Repositories often store titles in ALL CAPS: set them in sentence case, as a publisher would. */
function tidyTitle(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  const letters = text.replace(/[^\p{L}]/gu, '');
  const upper = text.replace(/[^\p{Lu}]/gu, '');
  if (letters.length > 8 && upper.length / letters.length > 0.8) {
    text = text
      .toLocaleLowerCase('es')
      .replace(/[\p{L}\p{N}-]+/gu, (word) => KEEP_CAPS[word] ?? word);
    text = text.replace(/(^|[:¿¡?!]\s+)(\p{L})/gu, (_m, lead: string, ch: string) => lead + ch.toLocaleUpperCase('es'));
    text = text.charAt(0).toLocaleUpperCase('es') + text.slice(1);
  }
  return text;
}

/** "Título: subtítulo" is set as a title plus a quieter second line, like a printed cover. */
function splitTitle(title: string): { main: string; sub?: string } {
  const match = /^(.{12,}?)(?::\s+|\s+[—–]\s+)(.{8,})$/u.exec(title);
  if (!match) return { main: title };
  const sub = match[2].trim();
  return { main: match[1].trim(), sub: sub.charAt(0).toLocaleUpperCase('es') + sub.slice(1) };
}

interface GeneratedCoverProps {
  publication: Publication;
}

/**
 * Editorial cover for works that have no image (most articles, many books). Pure React + CSS:
 * every measure is in container-query units (`cqw`) of the cover frame, so the same artwork
 * scales from the 56 px list thumbnail to the 240 px preview without being re-laid out.
 */
export function GeneratedCover({ publication }: GeneratedCoverProps) {
  const { main, sub } = splitTitle(tidyTitle(publication.title));
  const source = sourceInfo(publication.collectionCode, publication.collection);
  const motif = MOTIFS[hashOf(publication.id) % MOTIFS.length];
  const hasAuthors = publication.authors.length > 0;

  const style = {
    '--gc-hue': areaFillColor(publication.oecdArea),
    '--gc-ink': areaTextColor(publication.oecdArea)
  } as CSSProperties;

  return (
    <div className="gcover" data-motif={motif} style={style} lang={langAttr(publication) ?? 'es'} aria-hidden="true">
      <div className="gcover-motif" />
      <div className="gcover-body">
        <p className="gcover-title">{main}</p>
        {sub ? <p className="gcover-sub">{sub}</p> : null}
        <p className="gcover-author">{hasAuthors ? formatAuthors(publication, 2) : publication.publisher}</p>
      </div>
      <div className="gcover-foot">
        <span className="gcover-source">{source.short}</span>
        {publication.year ? <span className="gcover-year">{publication.year}</span> : null}
      </div>
    </div>
  );
}

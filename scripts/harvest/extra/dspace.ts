/**
 * DSpace `xoai` metadata parser (shared by OAPEN and the UPN repository: both are DSpace and speak the same dialect).
 * xoai nests `<element name="dc"><element name="title"><element name="none"><field name="value">…` and lists the
 * files in `<bundles>`, so unlike oai_dc it tells us the real bitstream (PDF) and thumbnail URLs.
 */
import { plain } from './common';

export interface Bitstream {
  bundle: string;
  name: string;
  format: string;
  size: number;
  url: string;
}

export interface XoaiRecord {
  handle?: string;
  fields: Map<string, string[]>;
  bitstreams: Bitstream[];
}

const QUALIFIER_LANG = /^(none|[a-z]{2}(?:_[A-Z]{2})?)$/;

export function parseXoai(recordXml: string): XoaiRecord {
  const fields = new Map<string, string[]>();
  const stack: string[] = [];
  const tokenRe = /<element name="([^"]*)">|<\/element>|<field name="value">([\s\S]*?)<\/field>/g;
  let m: RegExpExecArray | null;
  const metaEnd = recordXml.indexOf('<element name="bundles">');
  const meta = metaEnd > 0 ? recordXml.slice(0, metaEnd) : recordXml;
  while ((m = tokenRe.exec(meta))) {
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[2] === undefined) stack.pop();
    else {
      const path = stack.filter((s, i) => !(i === stack.length - 1 && QUALIFIER_LANG.test(s))).join('.');
      const value = plain(m[2]);
      if (!value) continue;
      const list = fields.get(path) ?? [];
      list.push(value);
      fields.set(path, list);
    }
  }

  const bitstreams: Bitstream[] = [];
  const bundlesAt = recordXml.indexOf('<element name="bundles">');
  const chunks = bundlesAt >= 0 ? recordXml.slice(bundlesAt).split('<element name="bundle">').slice(1) : [];
  for (const chunk of chunks) {
    const bundle = /<field name="name">([A-Z_]+)<\/field>/.exec(chunk)?.[1] ?? '';
    const bsRe = /<element name="bitstream">([\s\S]*?)<\/element>/g;
    let b: RegExpExecArray | null;
    while ((b = bsRe.exec(chunk))) {
      const body = b[1];
      const get = (n: string) => new RegExp(`<field name="${n}">([^<]*)</field>`).exec(body)?.[1]?.trim() ?? '';
      const url = get('url');
      if (url) bitstreams.push({ bundle, name: get('name'), format: get('format'), size: Number(get('size')) || 0, url });
    }
  }
  const handle = /<field name="handle">([^<]+)<\/field>/.exec(recordXml)?.[1]?.trim();
  return { handle, fields, bitstreams };
}

export function first(rec: XoaiRecord, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec.fields.get(k)?.[0];
    if (v) return v;
  }
  return undefined;
}

export function all(rec: XoaiRecord, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) for (const v of rec.fields.get(k) ?? []) if (!out.includes(v)) out.push(v);
  return out;
}

/** Fields whose key starts with a prefix (e.g. every `dc.contributor.*`). */
export function allPrefix(rec: XoaiRecord, prefix: string): string[] {
  const out: string[] = [];
  for (const [k, vs] of rec.fields) if (k === prefix || k.startsWith(`${prefix}.`)) for (const v of vs) if (!out.includes(v)) out.push(v);
  return out;
}

export function endsWithKey(rec: XoaiRecord, suffix: string): string | undefined {
  for (const [k, vs] of rec.fields) if (k.endsWith(suffix) && vs[0]) return vs[0];
  return undefined;
}

/** Best full-text PDF of an item: ORIGINAL bundle, application/pdf, biggest file (cover/cut-down PDFs are smaller). */
export function bestPdf(rec: XoaiRecord): Bitstream | undefined {
  const pdfs = rec.bitstreams.filter((b) => b.bundle === 'ORIGINAL' && (/pdf/i.test(b.format) || /\.pdf$/i.test(b.name)));
  return pdfs.sort((a, b) => b.size - a.size)[0];
}

export function thumbnail(rec: XoaiRecord): Bitstream | undefined {
  return rec.bitstreams.find((b) => b.bundle === 'THUMBNAIL' && /image\//i.test(b.format));
}

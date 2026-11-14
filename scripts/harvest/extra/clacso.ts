/**
 * CLACSO Biblioteca Virtual / repositorio.
 *
 * Findings (2026-11): biblioteca-repositorio.clacso.edu.ar and biblioteca.clacso.edu.ar answer every automated
 * request (OAI included) with a Cloudflare "Just a moment..." challenge (HTTP 403); repositorio.clacso.org is 404 and
 * bibliotecavirtual.clacso.org.ar is 403. Solving or evading a bot challenge is not something this pipeline does, so the
 * source is reported as blocked. The module re-probes on every run: if CLACSO ever exposes OAI without the challenge it
 * is reported (a DSpace xoai harvest like upn.ts would then be the natural next step).
 */
import { identify } from './oai';
import type { SourceReport, SourceResult } from './common';

const CANDIDATES = [
  'https://biblioteca-repositorio.clacso.edu.ar/oai/request',
  'https://repositorio.clacso.org/oai/request',
  'https://biblioteca.clacso.edu.ar/oai/request'
];

export async function harvestClacso(): Promise<SourceResult> {
  const report: SourceReport = { source: 'CLACSO', endpoint: CANDIDATES[0], status: 'blocked', note: '', harvested: 0 };
  const attempts: string[] = [];
  for (const c of CANDIDATES) {
    const r = await identify(c);
    attempts.push(`${new URL(c).hostname} → ${r.detail}`);
    if (r.ok) {
      report.status = 'skipped';
      report.endpoint = c;
      report.note = `OAI answered (${r.name}) but no CLACSO harvester is implemented for this layout yet.`;
      return { report, records: [], allow: /^$/ };
    }
  }
  report.note = `No usable endpoint: ${attempts.join(' | ')}. Cloudflare challenge not bypassed.`;
  return { report, records: [], allow: /^$/ };
}

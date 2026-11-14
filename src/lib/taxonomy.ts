import type { OecdAreaDefinition, OecdAreaId } from '../types/publication';

export const OECD_AREAS: OecdAreaDefinition[] = [
  {
    id: 'natural-sciences',
    code: '1',
    label: 'Ciencias Naturales y Exactas',
    unescoLabel: 'UNESCO 11-25 · Ciencias Exactas y Biológicas',
    accent: '#46545B',
    description: 'Matemáticas, física, química, biología, ecología y ciencias de la tierra.'
  },
  {
    id: 'engineering-tech',
    code: '2',
    label: 'Ingeniería y Tecnología',
    unescoLabel: 'UNESCO 33 · Ciencias Tecnológicas',
    accent: '#3B6E8C',
    description: 'Computación, arquitectura, ingeniería civil, materiales y energía.'
  },
  {
    id: 'medical-health',
    code: '3',
    label: 'Ciencias Médicas y de la Salud',
    unescoLabel: 'UNESCO 32 · Ciencias Médicas',
    accent: '#9E2A2B',
    description: 'Salud colectiva, epidemiología, medicina clínica, psicología y enfermería.'
  },
  {
    id: 'agricultural-sciences',
    code: '4',
    label: 'Ciencias Agrícolas y Veterinaria',
    unescoLabel: 'UNESCO 31 · Ciencias Agrarias',
    accent: '#4D6B53',
    description: 'Agronomía, silvicultura, zootecnia, biotecnología agroalimentaria y suelos.'
  },
  {
    id: 'social-sciences',
    code: '5',
    label: 'Ciencias Sociales y Educación',
    unescoLabel: 'UNESCO 52-59 · Ciencias Sociales, Derecho y Pedagogía',
    accent: '#B8863B',
    description: 'Sociología, educación, economía, derecho, ciencia política y comunicación.'
  },
  {
    id: 'humanities',
    code: '6',
    label: 'Humanidades y Artes',
    unescoLabel: 'UNESCO 55, 61-72 · Historia, Filosofía y Letras',
    accent: '#7D4E57',
    description: 'Historia, literatura, lingüística, filosofía, antropología cultural y artes.'
  }
];

export const OECD_AREA_MAP: Record<OecdAreaId, OecdAreaDefinition> = OECD_AREAS.reduce(
  (acc, item) => {
    acc[item.id] = item;
    return acc;
  },
  {} as Record<OecdAreaId, OecdAreaDefinition>
);

const AREA_KEYWORDS: Record<OecdAreaId, RegExp> = {
  'medical-health':
    /\b(saúde|salud|health|medicin|clínic|clinica|epidemiolog|enferm|psiquiatr|psicolog|depress|sus\b|fiocruz|hospital|covid|pandemia|vacin|vacun|sanitár|sanitar|doença|enfermedad|nutri|dieta|envelhecimento|bioétic|farmac|odontolog|toxicolog)/i,
  'agricultural-sciences':
    /\b(agríc|agric|agronom|agroecolog|soja|solo|suelo|florest|bosque|zootecni|veterinár|veterinar|pecuár|pecuar|cultivo|semente|semilla|cerrado|botânic|botanic|jbrj|pesca|alimento|rural|safra)/i,
  'engineering-tech':
    /\b(engenhari|ingenier|tecnolog|computa|software|algoritm|robótic|robotic|arquitetur|arquitectur|urbano|elétric|electr|energ|material|tv digital|telecom|automação|automatiz|construç|sistema|dados|datos|informátic)/i,
  'natural-sciences':
    /\b(matemátic|matematic|físic|fisic|químic|quimic|biolog|ecolog|zoolog|biodivers|oceano|marinh|marino|genétic|genetic|estatístic|estadistic|sbmac|clima|ambient|geolog|geograf|astron|botân|microbi)/i,
  humanities:
    /\b(históri|histori|filos[oó]f|l[oó]gic|epistemolog|ontolog|literatur|lingüíst|linguist|letras|arte|músic|music|memóri|memori|patrimôn|patrimon|ética|etica|religi|estétic|estetic|poes|romance|narrativ|cultura|arquivo|archivo|teatro|cinema)/i,
  'social-sciences':
    /\b(educa|ensino|enseñanza|pedagog|social|sociolog|polític|politic|econom|direito|derecho|administra|gestão|gestion|estado|públic|public|comunica|indígen|indigen|demograf|trabalho|trabajo|gênero|genero|antirracis|justiça|justicia|cidadania|ciudadan|fgv|unesp|unicamp|rosario)/i
};

const OPENALEX_DOMAIN_TO_OECD: Record<string, OecdAreaId> = {
  'https://openalex.org/domains/1': 'natural-sciences', // Life Sciences -> check medical/agri too
  'https://openalex.org/domains/2': 'social-sciences',
  'https://openalex.org/domains/3': 'natural-sciences',
  'https://openalex.org/domains/4': 'medical-health'
};

export function classifyOecdArea(input: {
  title?: string;
  abstract?: string;
  keywords?: string[];
  publisher?: string;
  setSpec?: string;
  openAlexDomainId?: string;
  openAlexFieldName?: string;
}): { area: OecdAreaId; label: string; subarea?: string } {
  const combined = [
    input.title || '',
    input.abstract || '',
    (input.keywords || []).join(' '),
    input.publisher || '',
    input.setSpec || '',
    input.openAlexFieldName || ''
  ].join(' ');

  if (input.openAlexFieldName) {
    const f = input.openAlexFieldName.toLowerCase();
    if (f.includes('medicine') || f.includes('nursing') || f.includes('health') || f.includes('psychology') || f.includes('pharmacology')) {
      return { area: 'medical-health', label: OECD_AREA_MAP['medical-health'].label, subarea: input.openAlexFieldName };
    }
    if (f.includes('agricultural') || f.includes('veterinary')) {
      return { area: 'agricultural-sciences', label: OECD_AREA_MAP['agricultural-sciences'].label, subarea: input.openAlexFieldName };
    }
    if (f.includes('engineering') || f.includes('computer') || f.includes('energy') || f.includes('materials')) {
      return { area: 'engineering-tech', label: OECD_AREA_MAP['engineering-tech'].label, subarea: input.openAlexFieldName };
    }
    if (f.includes('arts') || f.includes('humanities')) {
      return { area: 'humanities', label: OECD_AREA_MAP.humanities.label, subarea: input.openAlexFieldName };
    }
    if (f.includes('social') || f.includes('economics') || f.includes('business') || f.includes('decision')) {
      return { area: 'social-sciences', label: OECD_AREA_MAP['social-sciences'].label, subarea: input.openAlexFieldName };
    }
    if (f.includes('biochemistry') || f.includes('environmental') || f.includes('mathematics') || f.includes('physics') || f.includes('chemistry') || f.includes('earth')) {
      return { area: 'natural-sciences', label: OECD_AREA_MAP['natural-sciences'].label, subarea: input.openAlexFieldName };
    }
  }

  // Publisher & setSpec strong priors for SciELO Books
  const set = (input.setSpec || '').toLowerCase();
  const pub = (input.publisher || '').toLowerCase();
  if (set.includes('fiocruz') || pub.includes('fiocruz') || set.includes('saude')) {
    if (!AREA_KEYWORDS['social-sciences'].test(input.title || '')) {
      return { area: 'medical-health', label: OECD_AREA_MAP['medical-health'].label, subarea: 'Salud Colectiva' };
    }
  }
  if (set.includes('sbmac')) {
    return { area: 'natural-sciences', label: OECD_AREA_MAP['natural-sciences'].label, subarea: 'Matemática Aplicada' };
  }
  if (set.includes('zoologia') || set.includes('jbrj') || set.includes('rebentos')) {
    return { area: 'natural-sciences', label: OECD_AREA_MAP['natural-sciences'].label, subarea: 'Biodiversidad y Ecología' };
  }
  if (set.includes('fgv-direito')) {
    return { area: 'social-sciences', label: OECD_AREA_MAP['social-sciences'].label, subarea: 'Derecho y Gobernanza' };
  }

  // Score keyword matches
  const scores: Record<OecdAreaId, number> = {
    'natural-sciences': 0,
    'engineering-tech': 0,
    'medical-health': 0,
    'agricultural-sciences': 0,
    'social-sciences': 0,
    humanities: 0
  };

  for (const area of Object.keys(AREA_KEYWORDS) as OecdAreaId[]) {
    const regex = new RegExp(AREA_KEYWORDS[area].source, 'gi');
    const titleMatches = (input.title || '').match(regex)?.length ?? 0;
    const bodyMatches = combined.match(regex)?.length ?? 0;
    scores[area] = titleMatches * 3 + bodyMatches;
  }

  let bestArea: OecdAreaId = input.openAlexDomainId ? (OPENALEX_DOMAIN_TO_OECD[input.openAlexDomainId] ?? 'social-sciences') : 'social-sciences';
  let bestScore = 0;
  for (const area of Object.keys(scores) as OecdAreaId[]) {
    if (scores[area] > bestScore) {
      bestScore = scores[area];
      bestArea = area;
    }
  }

  return {
    area: bestArea,
    label: OECD_AREA_MAP[bestArea].label,
    subarea: input.openAlexFieldName
  };
}

const COUNTRY_ISO_MAP: Record<string, string> = {
  CO: 'Colombia',
  BR: 'Brasil',
  MX: 'México',
  AR: 'Argentina',
  CL: 'Chile',
  PE: 'Perú',
  CU: 'Cuba',
  CR: 'Costa Rica',
  ES: 'España',
  EC: 'Ecuador',
  UY: 'Uruguay',
  VE: 'Venezuela',
  PY: 'Paraguay',
  BO: 'Bolivia',
  PT: 'Portugal'
};

/**
 * ISBN registration groups (after the 978/979 prefix) → country. Longest prefix wins.
 * Source: International ISBN Agency group ranges for Ibero-America.
 */
const ISBN_GROUP_COUNTRY: Array<[string, string]> = [
  ['9972', 'Perú'],
  ['9974', 'Uruguay'],
  ['9978', 'Ecuador'],
  ['9942', 'Ecuador'],
  ['9968', 'Costa Rica'],
  ['9977', 'Costa Rica'],
  ['9930', 'Costa Rica'],
  ['99905', 'Bolivia'],
  ['99954', 'Bolivia'],
  ['99974', 'Bolivia'],
  ['99925', 'Paraguay'],
  ['99953', 'Paraguay'],
  ['99967', 'Paraguay'],
  ['958', 'Colombia'],
  ['628', 'Colombia'], // newer Colombian block (2021+)
  ['607', 'México'],
  ['968', 'México'],
  ['970', 'México'],
  ['950', 'Argentina'],
  ['987', 'Argentina'],
  ['631', 'Argentina'], // newer Argentine block
  ['956', 'Chile'],
  ['612', 'Perú'],
  ['959', 'Cuba'],
  ['980', 'Venezuela'],
  ['972', 'Portugal'],
  ['989', 'Portugal'],
  ['65', 'Brasil'],
  ['85', 'Brasil'],
  ['84', 'España']
].sort((x, y) => y[0].length - x[0].length) as Array<[string, string]>;

export function countryFromIsbn(isbn?: string | null): string | null {
  if (!isbn) return null;
  for (const candidate of String(isbn).split(/[;,\s]+/)) {
    const digits = candidate.replace(/[^0-9Xx]/g, '');
    if (digits.length !== 13 || !/^97[89]/.test(digits)) continue;
    const rest = digits.slice(3);
    for (const [group, country] of ISBN_GROUP_COUNTRY) {
      if (rest.startsWith(group)) return country;
    }
  }
  return null;
}

/** Publisher / imprint keywords → country (checked in order; most specific first). */
const PUBLISHER_COUNTRY: Array<[RegExp, string]> = [
  [/universidad nacional de rosario|unr editora/i, 'Argentina'],
  [/universidad del rosario|pedag[oó]gica nacional|javeriana|universidad de antioquia|universidad del valle|santiago de cali|universidad nacional de colombia|universidad de los andes|uniandes|externado|universidad del norte|industrial de santander|eafit|universidad de caldas|universidad de cartagena|universidad del cauca|universidad de nari[ñn]o|uptc|tecnol[oó]gica de pereira|bogot[aá]|medell[ií]n|\bcolombia/i, 'Colombia'],
  [/\bunam\b|colegio de m[eé]xico|colmex|universidad de guadalajara|ciesas|universidad veracruzana|universidad aut[oó]noma metropolitana|\bm[eé]xico\b/i, 'México'],
  [/clacso|eudeba|universidad de buenos aires|universidad nacional de la plata|edulp|eduvim|universidad nacional de c[oó]rdoba|buenos aires|\bargentina/i, 'Argentina'],
  [/universidad de chile|cat[oó]lica de chile|ediciones uc\b|universidad de concepci[oó]n|\bchile\b/i, 'Chile'],
  [/pucp|cat[oó]lica del per[uú]|universidad de lima|instituto de estudios peruanos|san marcos|\bper[uú]\b/i, 'Perú'],
  [/universidad de la rep[uú]blica|\buruguay/i, 'Uruguay'],
  [/universidad de costa rica|\bcosta rica/i, 'Costa Rica'],
  [/universidad de la habana|\bcuba\b/i, 'Cuba'],
  [/universidad de murcia|anales de psicolog|\bcsic\b|universidad complutense|\bespa[ñn]a\b/i, 'España'],
  [/universidade de coimbra|universidade de lisboa|\bportugal/i, 'Portugal'],
  [/fiocruz|edufba|unesp|eduem|unicamp|\bfgv\b|eduff|ufrgs|edufscar|eduerj|editora unb|edusp|ufmg|edufpb|eduepb|edufrn|edufu|ufsc|edufes|edufal|eduel|edunioeste|editora da |editora ufpr|\beditora\b|\bbrasil\b/i, 'Brasil']
];

export function countryFromPublisher(publisher?: string | null): string | null {
  if (!publisher) return null;
  for (const [pattern, country] of PUBLISHER_COUNTRY) {
    if (pattern.test(publisher)) return country;
  }
  return null;
}

const REGIONAL_HOST_COUNTRY: Array<[string, string]> = [
  ['scielo.org.co', 'Colombia'],
  ['scielo.org.mx', 'México'],
  ['scielo.org.ar', 'Argentina'],
  ['scielo.cl', 'Chile'],
  ['scielo.org.pe', 'Perú'],
  ['scielo.sld.cu', 'Cuba'],
  ['scielo.sa.cr', 'Costa Rica'],
  ['scielo.isciii.es', 'España'],
  ['scielo.edu.uy', 'Uruguay'],
  ['scielo.org.ve', 'Venezuela'],
  ['scielo.org.bo', 'Bolivia'],
  ['scielo.org.ec', 'Ecuador'],
  ['scielo.iics.una.py', 'Paraguay'],
  ['scielo.org.py', 'Paraguay'],
  ['scielo.pt', 'Portugal'],
  ['scielo.br', 'Brasil']
];

/**
 * Country from STRONG evidence only (ISBN group, regional SciELO host, publisher), or null.
 * Used to re-classify stored rows without trusting weak fallbacks.
 */
export function strongCountrySignal(input: {
  isbn?: string | null;
  scieloUrl?: string | null;
  pdfUrl?: string | null;
  publisher?: string | null;
}): string | null {
  const byIsbn = countryFromIsbn(input.isbn);
  if (byIsbn) return byIsbn;
  const urls = `${input.scieloUrl || ''} ${input.pdfUrl || ''}`.toLowerCase();
  for (const [host, country] of REGIONAL_HOST_COUNTRY) {
    if (urls.includes(host)) return country;
  }
  return countryFromPublisher(input.publisher);
}

/**
 * Infers the publication country. Strong signals (OpenAlex ISO code, ISBN group, regional
 * SciELO host, publisher) win over a previously stored value; the weak "books.scielo.org"
 * fallback (SciELO Books is hosted in Brazil but publishes all Ibero-America) is last.
 */
export function inferCountry(input: {
  country?: string | null;
  countryCode?: string | null;
  collectionCode?: string | null;
  collection?: string | null;
  scieloUrl?: string | null;
  pdfUrl?: string | null;
  publisher?: string | null;
  isbn?: string | null;
}): string {
  const iso = (input.countryCode || '').toUpperCase();
  if (iso && COUNTRY_ISO_MAP[iso]) return COUNTRY_ISO_MAP[iso];

  const byIsbn = countryFromIsbn(input.isbn);
  if (byIsbn) return byIsbn;

  const urls = `${input.scieloUrl || ''} ${input.pdfUrl || ''}`.toLowerCase();
  for (const [host, country] of REGIONAL_HOST_COUNTRY) {
    if (urls.includes(host)) return country;
  }

  const byPublisher = countryFromPublisher(input.publisher);
  if (byPublisher) return byPublisher;

  if (input.country && input.country !== 'Internacional') return input.country;

  const col = `${input.collectionCode || ''} ${input.collection || ''}`.toLowerCase();
  const byCollection = countryFromPublisher(col.replace(/\bbooks\b/g, ''));
  if (byCollection && byCollection !== 'Brasil') return byCollection;

  if (urls.includes('books.scielo.org') || col.includes('brasil') || /\bscielo\b/i.test(input.publisher || '')) {
    return 'Brasil';
  }
  return 'Internacional';
}

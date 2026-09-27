import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import PDFDocument from 'pdfkit';
import type { ActivationResult, Lead } from './types';

// Executive PDF brief of a pipeline run: headline metrics, an outcome table, and a profile
// per qualified prospect (score, evidence, buyer, outreach draft).
//
// buildReportModel() is pure and holds every number and label that appears in the PDF, so
// tests check content without parsing PDFs. writeExecutiveReport() only does layout.
// Uses pdfkit's built-in Helvetica (no font files to ship); text is mapped to its WinAnsi
// character set so unsupported glyphs never render as boxes.

export interface ReportLeadResult {
  lead: Lead;
  activation: ActivationResult;
}

export interface ExperimentSummary {
  winner: string | null;
  basis: string;
  sends: number;
  enoughData: boolean;
}

export interface ReportInput {
  generatedAt: Date;
  // 'demo' adds a banner: synthetic leads and mock providers must never read as real results.
  dataSource: 'demo' | 'live';
  results: ReportLeadResult[];
  experiment: ExperimentSummary | null;
  // Detailed profiles shown (highest scores first) to keep the brief to 1-2 pages. Every
  // lead still appears in the outcome table. Default 2.
  maxProfiles?: number;
}

export interface ProspectProfile {
  companyName: string;
  domain: string;
  score: number;
  status: 'Pass';
  scoredBy: string;
  evidence: string[];
  buyer: { name: string; title: string; email: string | null; emailStatus: string } | null;
  draft: { to: string | null; subject: string; body: string; variantId: string; reviewNotes: string[] } | null;
}

export interface ReportModel {
  title: string;
  generatedAt: Date;
  dataSource: ReportInput['dataSource'];
  metrics: {
    leadsProcessed: number;
    passed: number;
    passRatePct: number;
    enrichmentCents: number;
    contactCents: number;
    winner: { value: string; note: string };
  };
  outcomes: { company: string; domain: string; decision: string; score: number | null; outcome: string }[];
  prospects: ProspectProfile[];
  // Qualified prospects not profiled because of maxProfiles.
  omittedProspects: number;
}

export const REPORT_TITLE = 'GTM Pipeline Execution Brief';

function companyName(lead: Lead): string {
  for (const signal of lead.signals) {
    const name = signal.rawData.companyName;
    if (typeof name === 'string' && name.trim() && name.length <= 80) return name.trim();
  }
  const label = lead.companyDomain.split('.')[0] ?? lead.companyDomain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const VARIANT_LABELS: Record<string, string> = {
  variant_a_pain: 'A: pain point',
  variant_b_social_proof: 'B: social proof',
};

export function buildReportModel(input: ReportInput): ReportModel {
  const { results } = input;
  const passing = results
    .filter(r => r.lead.qualification?.decision === 'pass')
    .sort((a, b) => b.lead.qualification!.score - a.lead.qualification!.score);
  const maxProfiles = input.maxProfiles ?? 2;
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

  const exp = input.experiment;
  const winner =
    exp && exp.winner
      ? { value: VARIANT_LABELS[exp.winner] ?? exp.winner, note: exp.enoughData ? exp.basis : `Directional only: ${exp.sends} sends so far` }
      : { value: 'Pending', note: exp && exp.sends > 0 ? 'No clear leader yet' : 'No sends or replies yet' };

  return {
    title: REPORT_TITLE,
    generatedAt: input.generatedAt,
    dataSource: input.dataSource,
    metrics: {
      leadsProcessed: results.length,
      passed: passing.length,
      passRatePct: results.length ? Math.round((passing.length / results.length) * 1000) / 10 : 0,
      enrichmentCents: sum(results.flatMap(r => r.lead.enrichment.map(e => e.costInCents))),
      contactCents: sum(results.flatMap(r => r.lead.contact?.steps.map(s => s.costInCents) ?? [])),
      winner,
    },
    outcomes: results.map(({ lead, activation }) => ({
      company: companyName(lead),
      domain: lead.companyDomain,
      decision: lead.qualification?.decision ?? 'unqualified',
      score: lead.qualification?.score ?? null,
      outcome: activation.outcome.replace('_', ' '),
    })),
    omittedProspects: Math.max(0, passing.length - maxProfiles),
    prospects: passing.slice(0, maxProfiles).map(({ lead, activation }) => {
      const q = lead.qualification!;
      const scoredByClaude = q.evidence[0]?.startsWith('Scored by ') ?? false;
      const c = lead.contact;
      const d = activation.draft;
      return {
        companyName: companyName(lead),
        domain: lead.companyDomain,
        score: q.score,
        status: 'Pass' as const,
        scoredBy: scoredByClaude ? q.evidence[0]!.replace(/^Scored by /, 'Claude (').replace(/ against rubric .*$/, ')') : 'Offline rubric scorer',
        // The reasoning lines; the scorer label and bookkeeping totals are shown elsewhere.
        evidence: q.evidence.filter(line => !/^(Scored by |Rubric score:|Passed:)/.test(line)),
        buyer: c?.person
          ? { name: c.person.fullName, title: c.person.title, email: c.email, emailStatus: c.status === 'verified' ? 'verified' : `not verified (${c.emailStatus ?? 'no email'})` }
          : null,
        draft: d ? { to: d.to, subject: d.subject, body: d.body, variantId: d.variantId, reviewNotes: d.reviewNotes } : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Text safety for the built-in fonts
// ---------------------------------------------------------------------------

// Windows-1252 additions beyond Latin-1 that the standard PDF fonts can draw.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const REPLACEMENTS: Record<string, string> = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '≠': '!=', '✓': 'v', '✔': 'v', '✗': 'x', ' ': ' ' };

export function pdfSafe(text: string): string {
  return [...text.normalize('NFC')]
    .map(ch => {
      if (REPLACEMENTS[ch] !== undefined) return REPLACEMENTS[ch];
      const code = ch.codePointAt(0)!;
      if (ch === '\n' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) return ch;
      return '?';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const COLOR = {
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  inkMuted: '#6f6e69',
  accent: '#2a78d6',
  tile: '#f3f3f1',
  rule: '#dddcd7',
  previewFill: '#f7f7f5',
  passText: '#006300',
  passFill: '#e3f2e3',
  bannerFill: '#fff4d6',
};
const PAGE_MARGIN = 48;
const FOOTER_SPACE = 36;

const formatUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const formatTimestamp = (d: Date) =>
  `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}, ${d.toISOString().slice(11, 16)} UTC`;

export interface WriteReportOptions {
  // Uncompressed content streams make the PDF text greppable (used by tests).
  compress?: boolean;
}

export async function writeExecutiveReport(input: ReportInput, outPath: string, options: WriteReportOptions = {}): Promise<{ path: string; pages: number; model: ReportModel }> {
  const model = buildReportModel(input);
  mkdirSync(dirname(outPath), { recursive: true });

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN + FOOTER_SPACE, left: PAGE_MARGIN, right: PAGE_MARGIN },
    bufferPages: true,
    compress: options.compress ?? true,
    info: { Title: model.title, Author: 'GTM Engineering Lab', Subject: 'Pipeline run summary', CreationDate: model.generatedAt },
  });
  const done = new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outPath);
    stream.on('finish', resolve).on('error', reject);
    doc.pipe(stream);
  });

  const left = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;
  const bottomLimit = () => doc.page.height - PAGE_MARGIN - FOOTER_SPACE;
  const text = (value: string) => pdfSafe(value);
  const ensureSpace = (height: number) => {
    if (doc.y + height > bottomLimit()) doc.addPage();
  };
  const sectionTitle = (title: string) => {
    ensureSpace(40);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor(COLOR.ink).text(text(title), left, doc.y, { width });
    doc.moveTo(left, doc.y + 3).lineTo(left + width, doc.y + 3).lineWidth(0.75).strokeColor(COLOR.rule).stroke();
    doc.y += 10;
  };

  // Header
  doc.rect(0, 0, doc.page.width, 6).fill(COLOR.accent);
  doc.font('Helvetica-Bold').fontSize(22).fillColor(COLOR.ink).text(text(model.title), left, PAGE_MARGIN, { width });
  const source = model.dataSource === 'demo' ? 'Demo run: synthetic leads, mock providers' : 'Live run';
  doc.moveDown(0.2).font('Helvetica').fontSize(10).fillColor(COLOR.inkSecondary).text(text(`Generated ${formatTimestamp(model.generatedAt)}  |  ${source}`), { width });

  if (model.dataSource === 'demo') {
    const note = 'Demo data. Companies, people and costs come from synthetic fixtures and mock providers. The figures show how the pipeline behaves, not real results.';
    doc.font('Helvetica').fontSize(8.5);
    const h = doc.heightOfString(text(note), { width: width - 20 }) + 14;
    const y = doc.y + 10;
    doc.roundedRect(left, y, width, h, 4).fill(COLOR.bannerFill);
    doc.fillColor(COLOR.ink).text(text(note), left + 10, y + 7, { width: width - 20 });
    doc.y = y + h;
  }

  // Metric tiles
  const m = model.metrics;
  const tiles = [
    { label: 'Leads processed', value: String(m.leadsProcessed), note: `${m.passed} qualified` },
    { label: 'Pass rate', value: `${m.passRatePct % 1 === 0 ? m.passRatePct.toFixed(0) : m.passRatePct.toFixed(1)}%`, note: `${m.passed} of ${m.leadsProcessed} passed the ICP` },
    { label: 'Enrichment cost', value: formatUsd(m.enrichmentCents), note: `+ ${formatUsd(m.contactCents)} contact lookup` },
    { label: 'Winning A/B variant', value: m.winner.value, note: m.winner.note },
  ];
  const gap = 10;
  const tileW = (width - gap * 3) / 4;
  const tileH = 74;
  const tileY = doc.y + 16;
  tiles.forEach((tile, i) => {
    const x = left + i * (tileW + gap);
    doc.roundedRect(x, tileY, tileW, tileH, 6).fill(COLOR.tile);
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.inkSecondary).text(text(tile.label), x + 10, tileY + 10, { width: tileW - 20 });
    doc.font('Helvetica-Bold').fontSize(tile.value.length > 10 ? 13 : 20).fillColor(COLOR.ink).text(text(tile.value), x + 10, tileY + 24, { width: tileW - 20, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.inkMuted).text(text(tile.note), x + 10, tileY + 50, { width: tileW - 20, height: 20, ellipsis: true });
  });
  doc.y = tileY + tileH + 8;

  // Outcome table
  sectionTitle('Pipeline outcomes');
  const cols = [
    { label: 'Company', w: width * 0.44 },
    { label: 'Decision', w: width * 0.18 },
    { label: 'ICP score', w: width * 0.14 },
    { label: 'Outcome', w: width * 0.24 },
  ];
  const row = (cells: string[], bold: boolean, color: string) => {
    ensureSpace(18);
    const y = doc.y;
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color);
    cells.forEach((cell, i) => {
      doc.text(text(cell), x, y, { width: cols[i]!.w - 6, lineBreak: false, ellipsis: true });
      x += cols[i]!.w;
    });
    doc.y = y + 16;
  };
  row(cols.map(c => c.label), true, COLOR.inkSecondary);
  for (const o of model.outcomes) row([`${o.company} (${o.domain})`, o.decision, o.score === null ? '-' : String(o.score), o.outcome], false, COLOR.ink);

  // Qualified prospects
  const qualified = model.prospects.length + model.omittedProspects;
  sectionTitle(model.omittedProspects ? `Top qualified prospects (${model.prospects.length} of ${qualified})` : `Qualified prospects (${qualified})`);
  if (qualified === 0) {
    doc.font('Helvetica').fontSize(10).fillColor(COLOR.inkSecondary).text('No leads passed qualification in this run.', left, doc.y, { width });
  } else if (model.omittedProspects) {
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.inkMuted)
      .text(text(`Showing the ${model.prospects.length} highest-scoring. The other ${model.omittedProspects} are in the outcome table above.`), left, doc.y, { width });
  }

  for (const p of model.prospects) {
    // Keep the company header, evidence and buyer together; the draft box moves as a unit.
    doc.font('Helvetica').fontSize(9);
    const evidenceH = p.evidence.reduce((h, line) => h + doc.heightOfString(text(line), { width: width - 14 }) + 2, 0);
    ensureSpace(60 + evidenceH + 40);

    const top = doc.y + 4;
    doc.font('Helvetica-Bold').fontSize(14).fillColor(COLOR.ink).text(text(p.companyName), left, top, { width: width - 150 });
    doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.inkSecondary).text(text(p.domain), left, doc.y, { width: width - 150 });
    // Score and status, right-aligned. Status always carries its label, never color alone.
    doc.font('Helvetica-Bold').fontSize(16).fillColor(COLOR.ink).text(`${p.score}/100`, left + width - 140, top, { width: 80, align: 'right' });
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.inkSecondary).text('ICP score', left + width - 140, top + 19, { width: 80, align: 'right' });
    doc.roundedRect(left + width - 50, top + 2, 50, 18, 9).fill(COLOR.passFill);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.passText).text('PASS', left + width - 50, top + 7, { width: 50, align: 'center' });
    doc.y = Math.max(doc.y, top + 34) + 6;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.inkSecondary).text(text(`Reasoning and evidence  |  ${p.scoredBy}`), left, doc.y, { width });
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.ink);
    for (const line of p.evidence) {
      const y = doc.y;
      doc.circle(left + 3, y + 4.5, 1.4).fill(COLOR.inkSecondary);
      doc.fillColor(COLOR.ink).text(text(line), left + 12, y, { width: width - 14 });
      doc.y += 2;
    }

    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(9).fillColor(COLOR.inkSecondary).text('Buyer', left, doc.y, { width });
    doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.ink);
    if (p.buyer) {
      doc.text(text(`${p.buyer.name}, ${p.buyer.title}`), left, doc.y, { width });
      doc.fillColor(COLOR.inkSecondary).text(text(`${p.buyer.email ?? 'no email'} (${p.buyer.emailStatus})`), { width });
    } else {
      doc.fillColor(COLOR.inkSecondary).text('No buyer identified yet.', left, doc.y, { width });
    }

    if (p.draft) {
      const pad = 12;
      const innerW = width - pad * 2;
      const meta = `To: ${p.draft.to ?? 'no verified recipient'}\nSubject: ${p.draft.subject}`;
      const status = `Status: DRAFT, awaiting approval  |  Variant ${VARIANT_LABELS[p.draft.variantId] ?? p.draft.variantId}${p.draft.reviewNotes.length ? `  |  ${p.draft.reviewNotes.length} review note(s)` : ''}`;
      doc.font('Helvetica').fontSize(9);
      const metaH = doc.heightOfString(text(meta), { width: innerW });
      doc.font('Helvetica').fontSize(9.5);
      const bodyH = doc.heightOfString(text(p.draft.body), { width: innerW, lineGap: 1.5 });
      doc.font('Helvetica').fontSize(7.5);
      const statusH = doc.heightOfString(text(status), { width: innerW });
      const boxH = pad + metaH + 10 + bodyH + 10 + statusH + pad;

      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(9).fillColor(COLOR.inkSecondary);
      ensureSpace(boxH + 18);
      doc.text('Outreach draft', left, doc.y, { width });
      const y = doc.y + 4;
      doc.roundedRect(left, y, width, boxH, 6).lineWidth(0.75).fillAndStroke(COLOR.previewFill, COLOR.rule);
      doc.font('Helvetica').fontSize(9).fillColor(COLOR.inkSecondary).text(text(meta), left + pad, y + pad, { width: innerW });
      const bodyY = y + pad + metaH + 10;
      doc.moveTo(left + pad, bodyY - 5).lineTo(left + width - pad, bodyY - 5).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
      doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.ink).text(text(p.draft.body), left + pad, bodyY, { width: innerW, lineGap: 1.5 });
      doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.inkMuted).text(text(status), left + pad, bodyY + bodyH + 10, { width: innerW });
      doc.y = y + boxH + 14;
    }
  }

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits inside the bottom margin; lift the margin so pdfkit doesn't add a page.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - PAGE_MARGIN - 12;
    doc.moveTo(left, y - 8).lineTo(left + width, y - 8).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.inkMuted);
    doc.text(text(`GTM Engineering Lab  |  ${model.title}`), left, y, { width: width / 2, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
  }

  doc.end();
  await done;
  return { path: outPath, pages: range.count, model };
}

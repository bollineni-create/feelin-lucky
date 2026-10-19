import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } from "docx";
import { marked, type Token, type Tokens } from "marked";
import { DATA_DIR } from "./db";

/** Rendered files for one job live in data/applications/<job-id>/. */
export function applicationDir(jobId: number): string {
  const dir = path.join(DATA_DIR, "applications", String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

type Run = { text: string; bold?: boolean; italics?: boolean };
type Block =
  | { kind: "heading"; depth: number; runs: Run[] }
  | { kind: "para"; runs: Run[] }
  | { kind: "bullet"; runs: Run[]; ordered?: number }
  | { kind: "rule" }
  | { kind: "space" };

function inlineRuns(tokens: Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inlineRuns((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inlineRuns((t as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case "link":
        out.push(...inlineRuns((t as Tokens.Link).tokens, style));
        break;
      case "codespan":
        out.push({ text: (t as Tokens.Codespan).text, ...style });
        break;
      case "br":
        out.push({ text: "\n", ...style });
        break;
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineRuns(tt.tokens, style));
        else out.push({ text: decode(tt.text), ...style });
        break;
      }
      case "escape":
        out.push({ text: (t as Tokens.Escape).text, ...style });
        break;
      default:
        if ("text" in t && typeof t.text === "string") out.push({ text: decode(t.text), ...style });
    }
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** A deliberately small Markdown subset: headings, paragraphs, lists, bold/italic, rules. */
export function toBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  for (const t of marked.lexer(md)) {
    if (t.type === "heading") blocks.push({ kind: "heading", depth: t.depth, runs: inlineRuns(t.tokens) });
    else if (t.type === "paragraph") blocks.push({ kind: "para", runs: inlineRuns(t.tokens) });
    else if (t.type === "list") {
      const list = t as Tokens.List;
      list.items.forEach((item, i) => {
        const inner = item.tokens.flatMap((it) => ("tokens" in it && it.tokens ? it.tokens : [it]));
        blocks.push({ kind: "bullet", runs: inlineRuns(inner), ordered: list.ordered ? Number(list.start || 1) + i : undefined });
      });
    } else if (t.type === "hr") blocks.push({ kind: "rule" });
    else if (t.type === "space") blocks.push({ kind: "space" });
  }
  return blocks;
}

export function renderPdf(md: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 54, left: 60, right: 60 } });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);

    const write = (runs: Run[], size: number, opts: PDFKit.Mixins.TextOptions = {}) => {
      doc.fontSize(size);
      runs.forEach((r, i) => {
        doc.font(r.bold && r.italics ? "Helvetica-BoldOblique" : r.bold ? "Helvetica-Bold" : r.italics ? "Helvetica-Oblique" : "Helvetica");
        doc.text(r.text, { ...opts, continued: i < runs.length - 1 });
      });
      if (!runs.length) doc.text("", opts);
    };

    for (const b of toBlocks(md)) {
      if (b.kind === "heading") {
        doc.moveDown(b.depth === 1 ? 0 : 0.4);
        write(b.runs.map((r) => ({ ...r, bold: true })), b.depth === 1 ? 18 : b.depth === 2 ? 12.5 : 11);
        if (b.depth === 2) {
          const y = doc.y + 1;
          doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor("#999").stroke();
          doc.moveDown(0.3);
        }
      } else if (b.kind === "para") {
        write(b.runs, 10.5, { lineGap: 1.5 });
        doc.moveDown(0.45);
      } else if (b.kind === "bullet") {
        const prefix = b.ordered ? `${b.ordered}. ` : "•  ";
        write([{ text: prefix }, ...b.runs], 10.5, { indent: 10, lineGap: 1.5 });
        doc.moveDown(0.15);
      } else if (b.kind === "rule") {
        const y = doc.y + 3;
        doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor("#999").stroke();
        doc.moveDown(0.6);
      } else {
        doc.moveDown(0.3);
      }
    }
    doc.end();
  });
}

export async function renderDocx(md: string, file: string): Promise<void> {
  const runs = (rs: Run[], extra: { bold?: boolean; size?: number } = {}) =>
    rs.map((r) => new TextRun({ text: r.text, bold: r.bold || extra.bold, italics: r.italics, size: extra.size, font: "Calibri" }));
  const children: Paragraph[] = [];
  for (const b of toBlocks(md)) {
    if (b.kind === "heading") {
      children.push(
        new Paragraph({
          heading: b.depth === 1 ? HeadingLevel.HEADING_1 : b.depth === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          children: runs(b.runs, { bold: true }),
          border: b.depth === 2 ? { bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999", space: 1 } } : undefined,
        }),
      );
    } else if (b.kind === "para") {
      children.push(new Paragraph({ children: runs(b.runs, { size: 21 }), spacing: { after: 120 } }));
    } else if (b.kind === "bullet") {
      children.push(
        b.ordered
          ? new Paragraph({ children: runs([{ text: `${b.ordered}. ` }, ...b.runs], { size: 21 }), indent: { left: 360 } })
          : new Paragraph({ children: runs(b.runs, { size: 21 }), bullet: { level: 0 } }),
      );
    } else if (b.kind === "rule") {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999", space: 1 } }, alignment: AlignmentType.LEFT }));
    }
  }
  const doc = new Document({ sections: [{ properties: {}, children }] });
  fs.writeFileSync(file, await Packer.toBuffer(doc));
}

export type RenderedMaterials = { resumePath: string | null; coverLetterPath: string | null; files: string[] };

/** Writes Markdown sources plus PDF and DOCX renders into data/applications/<job-id>/. */
export async function renderMaterials(jobId: number, resumeMd: string | null, coverLetterMd: string | null, docLabel = "resume"): Promise<RenderedMaterials> {
  const dir = applicationDir(jobId);
  const files: string[] = [];
  let resumePath: string | null = null;
  let coverLetterPath: string | null = null;
  if (resumeMd) {
    const base = path.join(dir, docLabel === "cv" ? "cv" : "resume");
    fs.writeFileSync(`${base}.md`, resumeMd);
    await renderPdf(resumeMd, `${base}.pdf`);
    await renderDocx(resumeMd, `${base}.docx`);
    resumePath = `${base}.pdf`;
    files.push(`${base}.md`, `${base}.pdf`, `${base}.docx`);
  }
  if (coverLetterMd) {
    const base = path.join(dir, "cover-letter");
    fs.writeFileSync(`${base}.md`, coverLetterMd);
    await renderPdf(coverLetterMd, `${base}.pdf`);
    await renderDocx(coverLetterMd, `${base}.docx`);
    coverLetterPath = `${base}.pdf`;
    files.push(`${base}.md`, `${base}.pdf`, `${base}.docx`);
  }
  return { resumePath, coverLetterPath, files };
}

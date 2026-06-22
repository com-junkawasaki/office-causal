/**
 * 最小だが妥当な OOXML(pptx/xlsx/docx) を fflate で zip 生成する。
 * office-causal の自前パーサ (openPackage/buildStructuralGraph) で round-trip 可能。
 */
import { zipSync, strToU8 } from "fflate";

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const zip = (files) => {
  const entries = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries, { level: 6 });
};
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---------- PPTX ----------
// slides: [{ shapes: [{ text, x, y, w, h }] }]  (EMU)
export function buildPptx(slides) {
  const files = {};
  files["[Content_Types].xml"] = HEAD +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("") +
    `</Types>`;
  files["_rels/.rels"] = HEAD +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  files["ppt/presentation.xml"] = HEAD +
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<p:sldIdLst>` + slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("") + `</p:sldIdLst>` +
    `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`;
  files["ppt/_rels/presentation.xml.rels"] = HEAD +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("") +
    `</Relationships>`;
  slides.forEach((sl, i) => {
    const sp = sl.shapes.map((s, j) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${j + 2}" name="Shape ${j + 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${s.x}" y="${s.y}"/><a:ext cx="${s.w}" cy="${s.h}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${xmlEsc(s.text)}</a:t></a:r></a:p></p:txBody></p:sp>`).join("");
    files[`ppt/slides/slide${i + 1}.xml`] = HEAD +
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<p:cSld><p:spTree>${sp}</p:spTree></p:cSld></p:sld>`;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = HEAD +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  });
  return zip(files);
}

// ---------- XLSX ----------
// sheets: [{ name, cells: [{ ref, text?, formula?, value? }] }]
export function buildXlsx(sheets) {
  const files = {};
  files["[Content_Types].xml"] = HEAD +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `</Types>`;
  files["_rels/.rels"] = HEAD +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  files["xl/workbook.xml"] = HEAD +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` + sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + `</sheets></workbook>`;
  files["xl/_rels/workbook.xml.rels"] = HEAD +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `</Relationships>`;
  sheets.forEach((sh, i) => {
    // ref 行番号でグルーピング
    const rows = new Map();
    for (const c of sh.cells) { const r = c.ref.match(/\d+/)[0]; (rows.get(r) ?? rows.set(r, []).get(r)).push(c); }
    const rowXml = [...rows.entries()].map(([r, cells]) =>
      `<row r="${r}">` + cells.map((c) => {
        if (c.formula !== undefined) return `<c r="${c.ref}"><f>${xmlEsc(c.formula)}</f><v>${c.value ?? 0}</v></c>`;
        if (c.text !== undefined) return `<c r="${c.ref}" t="inlineStr"><is><t>${xmlEsc(c.text)}</t></is></c>`;
        return `<c r="${c.ref}"><v>${c.value ?? 0}</v></c>`;
      }).join("") + `</row>`).join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] = HEAD +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  });
  return zip(files);
}

// ---------- DOCX ----------
// pages: [[paragraphText, ...], ...]  (ページ間は改ページ)
export function buildDocx(pages) {
  const files = {};
  files["[Content_Types].xml"] = HEAD +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  files["_rels/.rels"] = HEAD +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const body = pages.map((paras, pi) => {
    const ps = paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`).join("");
    const brk = pi < pages.length - 1 ? `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` : "";
    return ps + brk;
  }).join("");
  files["word/document.xml"] = HEAD +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  files["word/_rels/document.xml.rels"] = HEAD +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  return zip(files);
}

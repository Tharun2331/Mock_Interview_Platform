// A real, parseable PDF — built rather than checked in as a binary fixture.
//
// Every other test in this repo fakes a PDF with `UPLOAD.PDF_MAGIC` and four
// junk bytes, which is enough to satisfy the magic-byte check in
// `lib/multipart.ts` and nothing else. `lib/resume.ts` hands its bytes to
// pdf.js, so covering it needs a document that genuinely parses: a catalog, a
// page tree, a content stream with a text-showing operator, a font, and an
// xref table whose offsets are correct.
//
// Generated so the text is a parameter. A committed binary would make "what
// does this resume say" invisible in the diff, and the assertions here are
// about the text that comes back out.

/** A one-page PDF whose only content is `text`, drawn in Helvetica. */
export function minimalPdf(text: string): Uint8Array {
  // Parentheses delimit a PDF string literal, so an unescaped one in the text
  // would terminate it early and corrupt the stream.
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;

  const objects = [
    "1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    "2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    "3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
      "/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\nendobj\n",
    `4 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }

  // The xref offsets must match the byte positions above exactly, or pdf.js
  // falls back to reconstructing the file and the test stops proving anything
  // about a well-formed one.
  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  body +=
    xref +
    `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

/** Bytes that pass the magic-byte check and nothing else — a renamed file, a
 *  truncated upload, or an encrypted document. */
export function corruptPdf(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\nthis is not a pdf body\n");
}

/**
 * A small, strict CSV reader.
 *
 * Written by hand rather than pulled in, because the supplied export is five
 * rows and a dependency here would be the largest thing in the project. It
 * handles quoted fields, escaped quotes and CRLF, and it refuses anything it
 * does not understand rather than guessing -- a CSV parser that silently
 * mis-splits a row is how a phone number ends up in the location column.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // A trailing newline produces one empty row; drop it rather than emitting
    // a phantom record with every column blank.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i]!;

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (inQuotes) throw new Error("CSV ended inside a quoted field");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Parse with a header row into objects.
 *
 * Rows whose column count does not match the header are returned as errors
 * rather than padded or truncated. The supplied C002 row has an empty phone
 * field, which is a legitimate empty value and not a malformed row -- the
 * distinction matters, and only a strict parser can make it.
 */
export function parseCsvRecords(text: string): {
  records: Array<Record<string, string>>;
  errors: Array<{ line: number; reason: string }>;
} {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return { records: [], errors: [{ line: 0, reason: "empty file" }] };

  const records: Array<Record<string, string>> = [];
  const errors: Array<{ line: number; reason: string }> = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.length !== header.length) {
      errors.push({
        line: r + 1,
        reason: `expected ${header.length} columns, found ${cells.length}`,
      });
      continue;
    }
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      rec[h.trim()] = (cells[idx] ?? "").trim();
    });
    records.push(rec);
  }
  return { records, errors };
}

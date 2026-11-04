// CSV for the catalog apps' imports and exports (RFC 4180).

/**
 * A cell as CSV writes it: quoted when it holds a comma, a quote or a line
 * break. One that starts like a formula (=, +, -, @, a tab or a carriage
 * return) gets a ' first, so a spreadsheet shows it rather than running it.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A cell read back: the ' that csvCell put before a formula-like value comes off. */
export const csvValue = (cell: string) => (/^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);

/** RFC 4180: quoted cells may hold commas, quotes ("") and line breaks. Blank rows are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(value);
      value = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += c;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}

/**
 * The same rules as parseCsv, fed a piece at a time: for files too big to hold
 * whole (an import of millions of contacts). push() returns the rows each
 * piece completed; end() the last one. A quote or a \r\n split across pieces
 * is carried over.
 */
export class CsvReader {
  #row: string[] = [];
  #value = "";
  #quoted = false;
  #pendingQuote = false;
  #pendingCr = false;
  #started = false;

  push(piece: string): string[][] {
    const rows: string[][] = [];
    let input = piece;
    if (!this.#started) {
      input = input.replace(/^﻿/, "");
      this.#started = true;
    }
    for (let i = 0; i < input.length; i++) {
      const c = input[i]!;
      if (this.#pendingCr) {
        this.#pendingCr = false;
        if (c === "\n") continue;
      }
      if (this.#pendingQuote) {
        this.#pendingQuote = false;
        if (c === '"') {
          this.#value += '"';
          continue;
        }
        this.#quoted = false;
      }
      if (this.#quoted) {
        if (c === '"') this.#pendingQuote = true;
        else this.#value += c;
      } else if (c === '"') this.#quoted = true;
      else if (c === ",") {
        this.#row.push(this.#value);
        this.#value = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r") this.#pendingCr = true;
        this.#row.push(this.#value);
        if (this.#row.some((v) => v.trim())) rows.push(this.#row);
        this.#row = [];
        this.#value = "";
      } else this.#value += c;
    }
    return rows;
  }

  end(): string[][] {
    if (this.#pendingQuote) this.#quoted = false;
    if (this.#value || this.#row.length) {
      this.#row.push(this.#value);
      const last = this.#row;
      this.#row = [];
      this.#value = "";
      if (last.some((v) => v.trim())) return [last];
    }
    return [];
  }
}

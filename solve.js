// A fast drop-in for csv-reader 1.0.0 (csv-reader-speed-01-run-20261121).
//
// It answers EXACTLY as the reference does on every input — the same
// {columns, rows, errors}, the same broken-row policy (BOM dropped, stray
// CRs, quote junk, unterminated quotes re-read as unquoted, CRLF/CR inside
// quotes read as LF, short/long rows padded and cut with their errors, in
// the order met) — but where the reference builds every field a character
// at a time, this reader scans with one tight charCodeAt loop per field
// and cuts each field out as a single slice (a few slices when stray CRs
// or doubled quotes intervene). Same answers, a fraction of the CPU.
//
// Pure: no clock, no randomness, no locale, nothing kept between calls.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const CH_COMMA = 44;
const CH_LF = 10;
const CH_CR = 13;
const CH_QUOTE = 34;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `initial` up to the next comma or line
  // break; a CR not followed by LF is dropped (stray_cr). Mirrors the
  // reference's readUnquoted, including its `added` count of kept chars.
  function readUnquoted(initial) {
    let parts = null;
    let added = 0;
    let segStart = pos;
    let i = pos;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === CH_COMMA || c === CH_LF) {
        let value;
        if (parts !== null) {
          parts.push(text.slice(segStart, i));
          value = parts.join('');
        } else {
          value = initial + text.slice(segStart, i);
        }
        added += i - segStart;
        pos = i + 1;
        if (c === CH_LF) line += 1;
        return { value, ended: c === CH_COMMA ? COMMA : LINE_BREAK, added };
      }
      if (c === CH_CR) {
        if (text.charCodeAt(i + 1) === CH_LF) {
          let value;
          if (parts !== null) {
            parts.push(text.slice(segStart, i));
            value = parts.join('');
          } else {
            value = initial + text.slice(segStart, i);
          }
          added += i - segStart;
          pos = i + 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        // A stray CR: bank the segment before it, record, drop the CR.
        if (parts === null) parts = [initial];
        parts.push(text.slice(segStart, i));
        added += i - segStart;
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    pos = len;
    if (parts !== null) {
      parts.push(text.slice(segStart, len));
      added += len - segStart;
      return { value: parts.join(''), ended: END, added };
    }
    added += len - segStart;
    return { value: initial + text.slice(segStart, len), ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const parts = [];
    let segStart = pos + 1;
    let i = segStart;
    let closed = false;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === CH_QUOTE) {
        if (text.charCodeAt(i + 1) === CH_QUOTE) {
          parts.push(text.slice(segStart, i), '"');
          i += 2;
          segStart = i;
          continue;
        }
        parts.push(text.slice(segStart, i));
        pos = i + 1;
        closed = true;
        break;
      }
      if (c === CH_LF) {
        line += 1;
        i += 1;
        continue;
      }
      if (c === CH_CR) {
        // CRLF and a lone CR inside quotes are each one LF.
        parts.push(text.slice(segStart, i), '\n');
        line += 1;
        i += text.charCodeAt(i + 1) === CH_LF ? 2 : 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const value = parts.join('');
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === CH_COMMA) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === CH_LF) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === CH_CR && text.charCodeAt(pos + 1) === CH_LF) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === CH_QUOTE;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

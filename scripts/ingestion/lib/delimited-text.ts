export interface DelimitedTextOptions {
  readonly delimiter?: string;
  readonly quote?: string;
}

export class DelimitedTextParseError extends Error {
  public readonly line: number;
  public readonly column: number;

  public constructor(message: string, line: number, column: number) {
    super(`${message} at line ${line}, column ${column}`);
    this.name = 'DelimitedTextParseError';
    this.line = line;
    this.column = column;
  }
}

function assertSingleCharacter(value: string, label: string): void {
  if ([...value].length !== 1) {
    throw new TypeError(`${label} must be exactly one Unicode character`);
  }
}

/**
 * Decodes the single-byte encoding used by the MSP Infotítulos export.
 *
 * WHATWG maps both the windows-1252 and iso-8859-1 labels to the Windows-1252
 * decoder. This is intentional: unlike UTF-8, it safely decodes every byte in
 * the current official export while retaining the raw bytes separately.
 */
export function decodeWindows1252(input: Uint8Array): string {
  return new TextDecoder('windows-1252').decode(input);
}

/**
 * Parses delimiter-separated text with RFC 4180-style quoting.
 *
 * It supports escaped quotes, delimiters and line breaks inside quoted fields,
 * CRLF/LF/CR records, an optional UTF BOM, and whitespace after a closing
 * quote. Malformed quoting fails closed instead of silently shifting columns.
 */
export function parseDelimitedText(input: string, options: DelimitedTextOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';

  assertSingleCharacter(delimiter, 'delimiter');
  assertSingleCharacter(quote, 'quote');

  if (delimiter === quote) {
    throw new TypeError('delimiter and quote must be different characters');
  }

  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterClosingQuote = false;
  let fieldStarted = false;
  let line = 1;
  let column = 1;

  const pushField = (): void => {
    record.push(field);
    field = '';
    fieldStarted = false;
    afterClosingQuote = false;
  };

  const pushRecord = (): void => {
    pushField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === undefined) {
      throw new DelimitedTextParseError('Unexpected end of input', line, column);
    }

    if (inQuotes) {
      if (character === quote) {
        if (text[index + 1] === quote) {
          field += quote;
          index += 1;
          column += 2;
          continue;
        }

        inQuotes = false;
        afterClosingQuote = true;
        column += 1;
        continue;
      }

      if (character === '\r') {
        if (text[index + 1] === '\n') {
          index += 1;
        }
        field += '\n';
        line += 1;
        column = 1;
        continue;
      }

      if (character === '\n') {
        field += '\n';
        line += 1;
        column = 1;
        continue;
      }

      field += character;
      column += 1;
      continue;
    }

    if (afterClosingQuote) {
      if (character === ' ' || character === '\t') {
        column += 1;
        continue;
      }

      if (character !== delimiter && character !== '\r' && character !== '\n') {
        throw new DelimitedTextParseError(
          'Unexpected character after a closing quote',
          line,
          column,
        );
      }
    }

    if (character === quote) {
      if (fieldStarted || field.length > 0) {
        throw new DelimitedTextParseError('A quoted field must start with a quote', line, column);
      }

      inQuotes = true;
      fieldStarted = true;
      column += 1;
      continue;
    }

    if (character === delimiter) {
      pushField();
      column += 1;
      continue;
    }

    if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      pushRecord();
      line += 1;
      column = 1;
      continue;
    }

    field += character;
    fieldStarted = true;
    column += 1;
  }

  if (inQuotes) {
    throw new DelimitedTextParseError('Unclosed quoted field', line, column);
  }

  if (fieldStarted || field.length > 0 || afterClosingQuote || record.length > 0) {
    pushRecord();
  }

  return records;
}

export function parseWindows1252DelimitedText(
  input: Uint8Array,
  options: DelimitedTextOptions = {},
): string[][] {
  return parseDelimitedText(decodeWindows1252(input), options);
}

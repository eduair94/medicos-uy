import { describe, expect, it } from 'vitest';

import {
  DelimitedTextParseError,
  decodeWindows1252,
  parseDelimitedText,
  parseWindows1252DelimitedText,
} from './delimited-text';

describe('delimited text parsing', () => {
  it('decodes the Windows-1252 bytes used by Infotítulos', () => {
    const encoded = Uint8Array.from([
      0x54, 0xed, 0x74, 0x75, 0x6c, 0x6f, 0x3b, 0x4e, 0xfa, 0x6d, 0x65, 0x72, 0x6f,
    ]);

    expect(decodeWindows1252(encoded)).toBe('Título;Número');
  });

  it('handles quoted delimiters, escaped quotes, embedded newlines and a BOM', () => {
    const input =
      '\uFEFFname;title;note\r\n' + '"PÉREZ, ANA";"CIRUGÍA; GENERAL";"línea 1\r\nlínea ""2"""\r\n';

    expect(parseDelimitedText(input, { delimiter: ';' })).toEqual([
      ['name', 'title', 'note'],
      ['PÉREZ, ANA', 'CIRUGÍA; GENERAL', 'línea 1\nlínea "2"'],
    ]);
  });

  it('keeps empty fields and does not invent a record after a trailing newline', () => {
    expect(parseDelimitedText('a;;c\n;d;\n', { delimiter: ';' })).toEqual([
      ['a', '', 'c'],
      ['', 'd', ''],
    ]);
  });

  it('parses a Windows-1252 encoded semicolon file', () => {
    const input = Uint8Array.from([
      0x54, 0xed, 0x74, 0x75, 0x6c, 0x6f, 0x3b, 0x45, 0x73, 0x74, 0x61, 0x64, 0x6f, 0x0d, 0x0a,
      0x43, 0x49, 0x52, 0x55, 0x47, 0xcd, 0x41, 0x3b, 0x48, 0x61, 0x62, 0x69, 0x6c, 0x69, 0x74,
      0x61, 0x64, 0x6f, 0x0d, 0x0a,
    ]);

    expect(parseWindows1252DelimitedText(input, { delimiter: ';' })).toEqual([
      ['Título', 'Estado'],
      ['CIRUGÍA', 'Habilitado'],
    ]);
  });

  it('fails closed on malformed quoted input', () => {
    expect(() => parseDelimitedText('a;"unclosed\n', { delimiter: ';' })).toThrow(
      DelimitedTextParseError,
    );
    expect(() => parseDelimitedText('a;"closed"x\n', { delimiter: ';' })).toThrow(
      /Unexpected character after a closing quote/,
    );
  });

  it('rejects ambiguous parser configuration', () => {
    expect(() => parseDelimitedText('a', { delimiter: ';;' })).toThrow(
      /exactly one Unicode character/,
    );
    expect(() => parseDelimitedText('a', { delimiter: '"', quote: '"' })).toThrow(
      /must be different/,
    );
  });
});

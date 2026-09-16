// Display-only normalization of common arXiv author-name TeX. Source text is retained.
export function academicName(source: string): string {
  const accents: Record<string, string> = {
    "'": '\u0301',
    '`': '\u0300',
    '^': '\u0302',
    '"': '\u0308',
    '~': '\u0303',
    '=': '\u0304',
    '.': '\u0307',
    v: '\u030c',
    u: '\u0306',
    H: '\u030b',
    c: '\u0327',
    k: '\u0328',
    r: '\u030a',
  };
  const letters: Record<string, string> = {
    aa: 'å',
    AA: 'Å',
    ae: 'æ',
    AE: 'Æ',
    oe: 'œ',
    OE: 'Œ',
    o: 'ø',
    O: 'Ø',
    l: 'ł',
    L: 'Ł',
    ss: 'ß',
    i: 'ı',
    j: 'ȷ',
  };
  return source
    .replace(/\\([aa-zA-Z]+)\{\}/g, (full, cmd: string) => letters[cmd] ?? full)
    .replace(
      /\\([aa-zA-Z]+)(?![a-zA-Z])/g,
      (full, cmd: string) => letters[cmd] ?? full,
    )
    .replace(
      /\\(['`^"~=.]|[vuHckr](?![a-zA-Z]))\s*(?:\{\s*([\p{L}])\s*\}|([\p{L}]))/gu,
      (_full, mark: string, wrapped: string, bare: string) => {
        const letter = wrapped ?? bare;
        return (
          (letter === 'ı' ? 'i' : letter === 'ȷ' ? 'j' : letter) + accents[mark]
        ).normalize('NFC');
      },
    )
    .replace(/\{([^{}\\]*)\}/g, '$1')
    .replace(/\\([&_%#])/g, '$1');
}

// Small helpers for the plain-text art on the desktop (DesktopArt.tsx).

// A box drawn with plain characters around some lines of text, padded to the widest line.
export function textBox(rows: string[]): string[] {
  const width = Math.max(...rows.map((r) => r.length)) + 4
  const edge = '-'.repeat(width)
  return [`.${edge}.`, ...rows.map((r) => `|  ${r.padEnd(width - 2)}|`), `'${edge}'`]
}

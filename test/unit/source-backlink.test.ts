import { describe, it, expect } from 'vitest';
import { removeTemplateBacklink } from '../../src/core/source-backlink.js';

describe('old template backlink migration', () => {
  const doc = '.metadata/docs/src/hello.go.wiki.md';
  const source = 'src/hello.go';
  const link = '[源文件：src/hello.go](../../../src/hello.go)';
  it('removes only the initial generated source link', () => {
    expect(removeTemplateBacklink(`# hello.go\n\n${link}\n\nNotes\n`, doc, source)).toBe('# hello.go\n\nNotes\n');
  });
  it('preserves authored links later in the body and other targets', () => {
    for (const text of [`# Title\n\nNotes\n\n${link}\n`, '# Title\n\n[源文件：src/hello.go](other.go)\n', `# Title\n\n${link}\n`]) {
      expect(removeTemplateBacklink(text, doc, null)).toBe(text);
    }
    const later = `# Title\n\nNotes\n\n${link}\n`;
    expect(removeTemplateBacklink(later, doc, source)).toBe(later);
    const other = '# Title\n\n[源文件：src/hello.go](other.go)\n';
    expect(removeTemplateBacklink(other, doc, source)).toBe(other);
  });
  it('preserves CRLF', () => {
    expect(removeTemplateBacklink(`# hello.go\r\n\r\n${link}\r\n\r\nNotes`, doc, source)).toBe('# hello.go\r\n\r\nNotes');
  });
});

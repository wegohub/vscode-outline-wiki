/**
 * prosemirror-view@1.18.1（库钉死的版本）不自带类型声明，而 @types/prosemirror-view
 * 的依赖链会和我们这边 1.25 的 prosemirror-model 类型打架。我们只用到
 * Decoration / DecorationSet 的一小组 API，因此在这里做最小声明。
 */
declare module 'prosemirror-view' {
  export class Decoration {
    static widget(pos: number, toDOM: Node, spec?: { side?: number; key?: string }): Decoration;
    static inline(from: number, to: number, attrs: Record<string, string>): Decoration;
  }
  export class DecorationSet {
    static create(doc: unknown, decorations: Decoration[]): DecorationSet;
    map(mapping: unknown, doc: unknown): DecorationSet;
    find(): Decoration[];
  }
}

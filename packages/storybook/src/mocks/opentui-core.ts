export class RGBA {
  constructor(public r: number, public g: number, public b: number, public a: number) {}
  static fromInts(r: number, g: number, b: number, a: number) {
    return new RGBA(r/255, g/255, b/255, a/255);
  }
}

export function parseColor(color: string): RGBA {
  // Minimal mock
  if (color === "transparent" || color === "none") return new RGBA(0, 0, 0, 0);
  return new RGBA(0.5, 0.5, 0.5, 1);
}

export const SyntaxStyle = {
  fromStyles: (styles: any) => styles, // Mock implementation
};

export const createCliRenderer = () => {};

export type ScrollBoxRenderable = any;
export type KeyEvent = any;

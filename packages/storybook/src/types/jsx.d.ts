import React from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      box: any;
      text: React.SVGProps<SVGTextElement> & { fg?: string; bg?: string; [key: string]: any };
      scrollbox: any;
      markdown: any;
    }
  }
}

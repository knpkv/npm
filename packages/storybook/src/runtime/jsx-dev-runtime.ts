import { jsxDEV as reactJsxDEV } from 'react/jsx-dev-runtime';
import { Box, Text, ScrollBox, Markdown } from '../adapter';

const map: Record<string, any> = {
  box: Box,
  text: Text,
  scrollbox: ScrollBox,
  markdown: Markdown,
};

export function jsxDEV(type: any, props: any, key: any, isStaticChildren: any, source: any, self: any) {
  if (typeof type === 'string' && map[type]) {
    return reactJsxDEV(map[type], props, key, isStaticChildren, source, self);
  }
  return reactJsxDEV(type, props, key, isStaticChildren, source, self);
}

export { Fragment } from 'react/jsx-dev-runtime';

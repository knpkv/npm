import { jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime';
import { Box, Text, ScrollBox, Markdown } from '../adapter';

const map: Record<string, any> = {
  box: Box,
  text: Text,
  scrollbox: ScrollBox,
  markdown: Markdown,
};

export function jsx(type: any, props: any, key: any) {
  if (typeof type === 'string' && map[type]) {
    return reactJsx(map[type], props, key);
  }
  return reactJsx(type, props, key);
}

export function jsxs(type: any, props: any, key: any) {
  if (typeof type === 'string' && map[type]) {
    return reactJsxs(map[type], props, key);
  }
  return reactJsxs(type, props, key);
}

export { Fragment } from 'react/jsx-runtime';

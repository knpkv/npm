export const readFile = () => {};
export const readFileSync = () => "";
export const access = (path: any, mode: any, callback: any) => { if (callback) callback(null); };
export const accessSync = () => {};
export const existsSync = () => false;
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1
};
export const promises = {
  readFile: async () => "",
  writeFile: async () => {},
  readdir: async () => [],
  stat: async () => ({ isDirectory: () => false }),
  access: async () => {},
};
export default { 
  readFile, 
  readFileSync, 
  access, 
  accessSync, 
  existsSync, 
  constants, 
  promises 
};

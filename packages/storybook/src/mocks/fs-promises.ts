export const readFile = async () => "";
export const writeFile = async () => {};
export const readdir = async () => [];
export const stat = async () => ({ isDirectory: () => false });
export const access = async () => {};
export default { readFile, writeFile, readdir, stat, access };

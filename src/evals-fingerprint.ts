import { basename, relative, sep } from "path";

export function logicalPath(root: string, path: string): string {
  return relative(root, path).split("\\").join("/") || basename(path);
}

export function withinDir(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

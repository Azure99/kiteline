export function isWithin(path: string, directory: string) {
  return path === directory || path.startsWith(directory + "/");
}
export function movedPath(path: string, from: string, to: string) {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}
export function parentPath(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}
export function childPath(parent: string, name: string) {
  return parent === "." ? name : `${parent}/${name}`;
}

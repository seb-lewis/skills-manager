export function validName(name: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9._ -]{0,254}$/.test(name);
}

export function sameName(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

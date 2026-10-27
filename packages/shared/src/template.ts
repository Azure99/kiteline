export function renderValues(template: string, values: Record<string, string>) {
  return template.replace(
    new RegExp(Object.keys(values).join("|"), "g"),
    (token) => values[token]!,
  );
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

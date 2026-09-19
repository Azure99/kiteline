type Command = (file: string, args: string[]) => Promise<string>;

export const toolRequirements = [
  { file: "git", major: 2, minor: 43 },
  { file: "rg", major: 14, minor: 0 },
] as const;

export async function checkToolVersion(
  { file, major, minor }: { file: string; major: number; minor: number },
  command: Command,
) {
  const line = (await command(file, ["--version"])).split("\n")[0]!;
  const version = /(\d+)\.(\d+)/.exec(line);
  if (
    !version ||
    Number(version[1]) < major ||
    (Number(version[1]) === major && Number(version[2]) < minor)
  )
    throw new Error(`Requires >= ${major}.${minor}; current: ${line}`);
  return line;
}

export async function checkFileHelper(path: string, command: Command) {
  try {
    await command(path, []);
  } catch (error) {
    if ((error as { code?: number }).code === 2) return "Loadable; usage exit code 2";
    throw error;
  }
  throw new Error("Helper did not return the expected usage status");
}

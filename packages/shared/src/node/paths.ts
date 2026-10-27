import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sharedDirectory = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(resolve(sharedDirectory, "package.json"), "utf8"));

export const resourceDirectory = resolve(sharedDirectory, manifest.kitelineResourceRoot);
export const nativeDirectory = resolve(resourceDirectory, "dist/native");

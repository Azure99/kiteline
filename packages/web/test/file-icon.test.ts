import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileIcon } from "../src/components/file-icon";
import docker from "../src/assets/file-icons/docker.svg";
import json from "../src/assets/file-icons/json.svg";
import npm from "../src/assets/file-icons/npm.svg";
import react from "../src/assets/file-icons/react.svg";
import typescript from "../src/assets/file-icons/typescript.svg";
import zip from "../src/assets/file-icons/zip.svg";

describe("file icons", () => {
  it.each([
    ["nested/PACKAGE.JSON", npm],
    ["nested/config.json", json],
    ["src/types.d.TS", typescript],
    ["src/App.tsx", react],
    ["release/archive.tar.gz", zip],
    ["Dockerfile", docker],
  ])("renders the type of %s as a decorative image", (path, icon) => {
    const markup = renderToStaticMarkup(createElement(FileIcon, { path, size: 14 }));
    const source = renderToStaticMarkup(createElement("img", { src: icon })).match(
      /src="[^"]*"/,
    )![0];
    expect(markup).toContain(source);
    expect(markup).toContain('alt=""');
    expect(markup).toContain('width="14" height="14"');
  });

  it.each(["unknown.xyz", "ts", "constructor"])("keeps a generic file for %s", (path) => {
    const markup = renderToStaticMarkup(createElement(FileIcon, { path }));
    expect(markup).toContain("<svg");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<img");
  });
});

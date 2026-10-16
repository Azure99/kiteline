import { File } from "lucide-react";
import audio from "../assets/file-icons/audio.svg";
import console from "../assets/file-icons/console.svg";
import css from "../assets/file-icons/css.svg";
import docker from "../assets/file-icons/docker.svg";
import git from "../assets/file-icons/git.svg";
import go from "../assets/file-icons/go.svg";
import html from "../assets/file-icons/html.svg";
import image from "../assets/file-icons/image.svg";
import javascript from "../assets/file-icons/javascript.svg";
import json from "../assets/file-icons/json.svg";
import license from "../assets/file-icons/license.svg";
import markdown from "../assets/file-icons/markdown.svg";
import npm from "../assets/file-icons/npm.svg";
import pdf from "../assets/file-icons/pdf.svg";
import python from "../assets/file-icons/python.svg";
import react from "../assets/file-icons/react.svg";
import rust from "../assets/file-icons/rust.svg";
import settings from "../assets/file-icons/settings.svg";
import svg from "../assets/file-icons/svg.svg";
import typescript from "../assets/file-icons/typescript.svg";
import video from "../assets/file-icons/video.svg";
import yaml from "../assets/file-icons/yaml.svg";
import zip from "../assets/file-icons/zip.svg";
import { cn } from "../lib/utils";

const filenames = new Map([
  ["dockerfile", docker],
  [".gitignore", git],
  [".gitattributes", git],
  [".gitmodules", git],
  ["package.json", npm],
  ["package-lock.json", npm],
  ["license", license],
]);

const extensions = new Map([
  ["ts", typescript],
  ["mts", typescript],
  ["cts", typescript],
  ["js", javascript],
  ["mjs", javascript],
  ["cjs", javascript],
  ["tsx", react],
  ["jsx", react],
  ["json", json],
  ["jsonc", json],
  ["md", markdown],
  ["markdown", markdown],
  ["html", html],
  ["htm", html],
  ["css", css],
  ["scss", css],
  ["less", css],
  ["py", python],
  ["go", go],
  ["rs", rust],
  ["png", image],
  ["jpg", image],
  ["jpeg", image],
  ["gif", image],
  ["webp", image],
  ["avif", image],
  ["ico", image],
  ["bmp", image],
  ["tif", image],
  ["tiff", image],
  ["svg", svg],
  ["pdf", pdf],
  ["mp3", audio],
  ["wav", audio],
  ["ogg", audio],
  ["flac", audio],
  ["m4a", audio],
  ["aac", audio],
  ["mp4", video],
  ["webm", video],
  ["mov", video],
  ["avi", video],
  ["mkv", video],
  ["zip", zip],
  ["tar", zip],
  ["gz", zip],
  ["tgz", zip],
  ["bz2", zip],
  ["xz", zip],
  ["7z", zip],
  ["rar", zip],
  ["yaml", yaml],
  ["yml", yaml],
  ["sh", console],
  ["bash", console],
  ["zsh", console],
  ["fish", console],
  ["ps1", console],
  ["bat", console],
  ["cmd", console],
  ["toml", settings],
  ["ini", settings],
  ["env", settings],
]);

export function FileIcon({
  path,
  size = 16,
  className,
}: {
  path: string;
  size?: number;
  className?: string;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const icon = filenames.get(name) ?? (dot < 0 ? undefined : extensions.get(name.slice(dot + 1)));
  return icon ? (
    <img src={icon} alt="" width={size} height={size} className={cn("shrink-0", className)} />
  ) : (
    <File
      size={size}
      aria-hidden="true"
      className={cn("shrink-0 text-muted-foreground", className)}
    />
  );
}

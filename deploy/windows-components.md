# Windows Agent Components

Build inputs are fixed in `agent-windows.json`, `release.json` and the existing
`agent-static.json` tmux source entry. No installed MSYS2 or rolling package
update is used. PowerShell 7 and native Git remain user-provided dependencies.

From the repository on Linux x64 (Node 24.20.0, Docker, curl, tar with zstd,
unzip, git and GNU objdump):

```sh
node scripts/build-windows-components.mjs prepare /var/tmp/kiteline-win-inputs
node scripts/build-windows-components.mjs addon /var/tmp/kiteline-win-inputs /var/tmp/kiteline-win-addon
```

Copy the complete prepared input directory to a Windows x64 build host. Use a
fresh local build path, not a network share. Run with native Node 24.20.0:

```powershell
node.exe C:\kiteline-build\inputs\scripts\build-windows-components.mjs tmux C:\kiteline-build\inputs C:\kiteline-build\tmux
```

Return the complete `tmux` output to Linux, then assemble and verify:

```sh
node scripts/build-windows-components.mjs assemble /var/tmp/kiteline-win-inputs /var/tmp/kiteline-win-tmux /var/tmp/kiteline-win-addon /var/tmp/kiteline-win-components
node scripts/build-windows-components.mjs verify /var/tmp/kiteline-win-components
```

Output directories must be new. Input downloads can be reused only after their
SHA256 matches. Build outputs include input and file identities; assembly rejects
changed recipes, missing files and mismatched hashes. Packaging must verify the
component output again against the current source. A successful cross-build is
not Windows runtime acceptance.

The private runtime contains only the listed executables/DLLs, the console
helper, and the two terminal entries used by the managed preset: xterm-256color
and the project's tmux-256color. It does not contain a package manager, compiler,
service manager or general-purpose MSYS2 installation.

`native/licenses` preserves component notices, including per-file script/PTY
notices and GCC/MinGW static runtime notices. Official Bash uses external
readline/history static inputs; its corresponding readline, ncurses, gettext
and libiconv materials are included. `native/sources` contains the exact official
MSYS2 source archives (source bodies, build recipes and patches), tmux source,
project patches and build recipes. The runtime source archive includes its
upstream Git objects; its PKGBUILD selects `cygwin-3.6.10` and applies the included
MSYS2 patches. These archives accompany the Windows distribution, not just URLs
or a source-offer placeholder. The package manager and toolchains are build-only.

# 构建交付物

使用[package.json](../package.json)固定的Node和pnpm。Linux构建机需要Docker BuildKit、binutils的readelf、libarchive-tools的bsdtar，以及Windows组包所需zip；可通过binfmt/QEMU执行另一架构的native构建。Node版本、tmux/libevent共同来源及Linux运行时、rg和Ubuntu镜像/证书包身份集中在[inputs.json](inputs.json)；平台专用输入由对应agent配方维护，Linux静态Node归档固定于[node-static.json](node-static.json)。用户运行发布包无需npm或编译器。

只构建Linux amd64及对应server的命令：

```sh
pnpm install --frozen-lockfile
pnpm package agent linux-amd64
pnpm package server amd64 --agent-target=linux-amd64
pnpm images amd64
```

`--agent-target`选择server携带的agent，可用逗号分隔多个目标；省略时携带全部五个目标。Windows先按[固定组件构建](windows-components.md)生成并验证组件；其ZIP不含符号链接，目标机无需Developer Mode。macOS构建步骤见下文。

包及对应`.sha256`位于`dist/releases/`；产品版本来自[version.json](../shared/src/version.json)，镜像名为`kiteline-server:<版本>-<amd64|arm64>`。跨机器可用`docker save/load`搬运镜像。构建从干净commit开始，结束时再次核HEAD和工作区/index；清单记录sourceCommit、sourceDirty=false、平台及组件身份。组装server和构建镜像时核对当前来源、版本和目标，来源不一致须重建相应包；原生组件仍按实际输入闭包复用。

`package agent linux-amd64`和`package agent linux-arm64`下载对应静态Node并构建/复用native；也可单独用`node scripts/build-linux-components.mjs amd64`或`arm64`输出到`dist/agent-linux-<架构>/`，省略架构时使用amd64，`KITELINE_LINUX_OUTPUT`指定其他输出目录。Node归档及SHA固定于[node-static.json](node-static.json)；Node版本与配方修订变更时，先在[node-static-builds](https://github.com/Azure99/node-static-builds)构建验证新组件，再更新本仓引用。tmux/libevent来源与SHA见[共同输入](inputs.json)，Linux专用库源、补丁和工具链见[agent-linux.json](agent-linux.json)，工具链包名见[agent-linux-packages.txt](agent-linux-packages.txt)，实际版本随输出记录。下载缓存位于`/var/tmp/kiteline-release-cache`并核验SHA，native编译沿Docker缓存复用。产物记录及静态边界见[运行基线](../deploy/README.md#平台要求)。

Linux组件输出包含rg及基础`native/identity.json`。输出根的`SHA256SUMS`和`build.json.files`记录Docker导出层；组包时补终端profile及应用依赖身份，并校验最终包的完整内容。

macOS原生组件使用[固定输入](agent-macos.json)及对应架构的macOS构建环境，需要 Command Line Tools 和 SDK，部署目标 14.0。分别对amd64、arm64执行以下步骤：先在源码目录准备输入，再将完整输入目录传至相应构建机；使用固定Node运行其中同一脚本，输出目录须不存在：

```sh
kiteline_arch=arm64 # Intel构建机使用amd64。
node scripts/build-macos-components.mjs prepare "$kiteline_arch" "/var/tmp/kiteline-mac-inputs-$kiteline_arch"
# 在匹配架构的macOS构建环境中，kiteline_arch设置同上：
node "/var/tmp/kiteline-mac-inputs-$kiteline_arch/scripts/build-macos-components.mjs" build "$kiteline_arch" \
  "/var/tmp/kiteline-mac-inputs-$kiteline_arch" "/var/tmp/kiteline-mac-components-$kiteline_arch"
# 将完整组件带回源码侧，核对当前输入与实际文件：
node scripts/build-macos-components.mjs verify "$kiteline_arch" "/var/tmp/kiteline-mac-components-$kiteline_arch"
# 在macOS构建源码目录安装开发依赖后组包：
pnpm package agent "macos-$kiteline_arch" --macos-components="/var/tmp/kiteline-mac-components-$kiteline_arch"
```

macOS组包使用固定Node/pnpm、Git及系统tar，组件输入和文件摘要在组包入口再次核验。构建入口依据实际执行源码的共同字段、平台配方及构建文件核对准备记录、来源归档和实际文件摘要；准备输入时传递完整九份源码文件。包名中的amd64对应Intel x86_64，arm64对应Apple Silicon。

完整交付从相同源码构建五个agent。将macOS两架构生成的包及`.sha256`放入Linux源码侧`dist/releases/`，然后依次组装两个server和镜像：

```sh
pnpm package agent linux-amd64
pnpm package agent linux-arm64
pnpm package agent windows-amd64 --windows-components=/var/tmp/kiteline-win-components
# 确认同源macOS两架构包及.sha256已放入dist/releases/。
pnpm package server amd64
pnpm package server arm64
pnpm images amd64
pnpm images arm64
```

各包根目录包含项目LICENSE；第三方许可位置见[随包材料](../deploy/README.md#随包材料)。构建后从各实际产物核对内容、来源、启动及受影响安装升级流程，区分原生、模拟和最低系统的验证结果。部署步骤见[安装与运行](../deploy/README.md)。

## 终端补丁维护

### xterm补丁再生成

使用项目固定Node/pnpm，在隔离维护目录安装`esbuild@0.28.0`。取得同版本未修补的npm包，保留其`lib/xterm.mjs`及map原件；先按以下参数重生成未修补包的副本，逐字比对ESM。一致后，在`pnpm patch @xterm/xterm@6.1.0-beta.304`给出的编辑目录修改TS并重生成，还原`lib/xterm.mjs.map`原件，最后用`pnpm patch-commit <编辑目录>`更新现有补丁。

将以下脚本放在安装esbuild的维护目录，以`node generate.mjs <生成目标目录> <未修补包目录>`执行；banner始终取自未修补原件。

```js
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2]);
const original = readFileSync(
  resolve(process.argv[3], "lib/xterm.mjs"),
  "utf8",
);
await build({
  absWorkingDir: root,
  entryPoints: ["src/browser/public/Terminal.ts"],
  outfile: "lib/xterm.mjs",
  bundle: true,
  format: "esm",
  target: "es2021",
  sourcemap: true,
  treeShaking: true,
  minify: true,
  legalComments: "none",
  banner: { js: original.slice(0, original.indexOf("var ")).trimEnd() },
  tsconfigRaw: {
    compilerOptions: { target: "es2021", experimentalDecorators: true },
  },
});
```

补丁保留可读TS修改和实际消费的ESM；升级后复核适配并执行受影响的类型和终端验证。生成工具仅用于隔离维护目录。

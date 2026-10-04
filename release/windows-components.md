# Windows Agent组件

构建输入固定于[agent-windows.json](agent-windows.json)和[共同输入](inputs.json)。构建使用准备目录内的固定MSYS2归档及软件包；Windows构建机提供原生Node、Git、PowerShell 7和安装在默认Program Files目录的7-Zip。7-Zip解开bootstrap的XZ压缩层，系统tar提取归档。

Linux x64构建机需要共同输入指定的Node版本，以及Docker、curl、支持zstd的tar、unzip、Git和GNU objdump。在仓库根目录执行：

```sh
node scripts/build-windows-components.mjs prepare /var/tmp/kiteline-win-inputs
node scripts/build-windows-components.mjs addon /var/tmp/kiteline-win-inputs /var/tmp/kiteline-win-addon
```

将完整准备目录复制到Windows x64构建机，使用新的本地构建目录及同版本原生Node执行：

```powershell
node.exe C:\kiteline-build\inputs\scripts\build-windows-components.mjs tmux C:\kiteline-build\inputs C:\kiteline-build\tmux
```

将完整tmux输出带回Linux，再组装组件：

```sh
node scripts/build-windows-components.mjs assemble /var/tmp/kiteline-win-inputs /var/tmp/kiteline-win-tmux /var/tmp/kiteline-win-addon /var/tmp/kiteline-win-components
node scripts/build-windows-components.mjs verify /var/tmp/kiteline-win-components
```

输出目录须为新目录；输入下载经SHA256核验后可复用。构建输出包含输入和文件身份，组装时核对当前配方、文件完整性及摘要，并将已核文件摘要写入组件身份。`verify OUTPUT`检查现有组件树，组包入口再次对照当前源码验证组件。完成后在Windows 11实际包中验证终端、文件及安装升级流程。

私有运行时包含清单中的可执行文件/DLL、console helper，以及托管preset使用的xterm-256color和本项目tmux-256color两个终端条目。

`native/licenses`保存组件许可；`native/sources`保存GPL/LGPL组件的官方MSYS2源归档，含其构建配方和补丁。

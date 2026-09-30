# Kiteline

单人自托管的远程工作台，受控设备支持 Linux 与 Windows，server 部署在 Linux。

正式包、前台运行及用户自管后台部署见 [安装与运行](deploy/README.md)。项目不注册或控制系统服务。

## 从源码开发

开发环境使用 [package.json](package.json) 指定的 Node 和 pnpm。Ubuntu 原生组件构建需要 `build-essential pkg-config libevent-dev libncurses-dev ncurses-term bison curl patch`，运行设备工具还需要 Git 2.23.0+ 和 Shell。amd64组件准备会取得固定rg到内部路径，不要求系统rg；Linux arm64 需要外部 rg 14+，运行基线为 Ubuntu 24.04。

```sh
pnpm install
pnpm native:build
pnpm build
KITELINE_DATA_DIR=/var/tmp/kiteline-dev/server pnpm dev
```

`dev` 编译并监听 TypeScript，启动 server 与 Vite，退出时关闭启动的进程。打开 http://localhost:5173，使用 server 控制台的初始化凭据设置密码。源码 dev 不含发布下载资源；在网页生成接入命令，从“已安装，仅绑定”命令中取得绑定码，在下方 bind 提示时输入：

```sh
export KITELINE_AGENT_HOME=/var/tmp/kiteline-dev/agent
pnpm agent bind --server http://localhost:5173
pnpm agent run
```

可选 HTTPS 开发：启动 `pnpm dev` 时增加 `KITELINE_TRUST_PROXY_PROTO=1`，再运行以下本地 Caddy fixture（不属于产品部署）：

```sh
docker run --rm --name kiteline-dev-caddy --network host \
  -v "$PWD/scripts/dev/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v /var/tmp/kiteline-dev/caddy:/data caddy:2.10.2
```

打开 https://localhost:8443 并信任本地开发证书。使用该入口绑定 agent 时，绑定地址改为 `https://localhost:8443`，并在运行 bind/run 的 Shell 中设置相同的测试根证书：

```sh
export NODE_EXTRA_CA_CERTS=/var/tmp/kiteline-dev/caddy/caddy/pki/authorities/local/root.crt
```

正式部署支持 HTTP 直连及已有 HTTPS 反代，见[安装与运行](deploy/README.md#server-部署)。密码恢复需先停止 server，再以相同 `KITELINE_DATA_DIR` 运行 `pnpm server reset-password`，完成后重新启动。原生组件及构建身份位于 `dist/native/`；临时编译目录和包缓存使用 `/var/tmp`。

## 访问设备上的开发服务

选定设备后，顶栏地球图标可输入端口，打开时读取一次监听端口建议。终端中的 `http://localhost:端口/` 链接可直接打开；手机选中完整链接后也有访问动作。服务需监听 agent 所在环境的 loopback 或 wildcard 地址。

默认入口剥离代理前缀。Vite 项目使用“保留路径”，具体 `base`、Host 和 HMR 配置见 [开发服务](deploy/README.md#开发服务)。

## 检查

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

真实文件/进程测试需要先构建原生组件。

## 终端适配

Web 与 recorder 共用固定 xterm 适配，普通屏幕顶部的 CSI S 滚动参考 [xterm PR6011](https://github.com/xtermjs/xterm.js/pull/6011)，依赖固定版本内部接口。tmux 的粘贴补丁读取原任务的 `wp->base.mode`，使本机 copy-mode 不改变任务的括号粘贴模式；任务未开启此模式时，正文中的回车可能直接执行命令。

重复与滚动次数分别受剩余列和滚动区高度限制，依据固定 tmux 3.4 的 [REP](https://github.com/tmux/tmux/blob/3.4/input.c#L1568) 和 [scrollup](https://github.com/tmux/tmux/blob/3.4/screen-write.c#L1456)。字形、宽度和换行仍由 xterm 处理。

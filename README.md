# Kiteline

单人自托管的 Linux 远程工作台。

正式包、原生服务和容器的运行方式见 [安装与运行](deploy/README.md)。

## 从源码开发

开发环境使用 Node 24.20.0 和 pnpm 11.25.0。Ubuntu 原生组件构建需要 `build-essential pkg-config libevent-dev libncurses-dev ncurses-term bison curl patch`，运行设备工具还需要 Git 2.43+、ripgrep 14+ 和 Shell。

```sh
pnpm install
pnpm native:build
pnpm build
KITELINE_DATA_DIR=/var/tmp/kiteline-dev/server KITELINE_PUBLIC_URL=https://localhost:8443 pnpm dev
```

`dev` 编译并监听 TypeScript，启动 server 与 Vite，退出时关闭启动的进程。浏览器登录要求同源 HTTPS，可接已有反代；下面是可选的本地 Caddy 开发 fixture，不属于产品部署：

```sh
docker run --rm --name kiteline-dev-caddy --network host \
  -v "$PWD/scripts/dev/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v /var/tmp/kiteline-dev/caddy:/data caddy:2.10.2
```

打开 https://localhost:8443，信任本地开发证书，使用 server 控制台的初始化凭据设置密码。源码 dev 不含发布下载资源；在网页生成接入命令，从“已安装，仅绑定”命令中取得绑定码，在下方 bind 提示时输入。设备端使用相同的测试根证书和独立状态目录：

```sh
export NODE_EXTRA_CA_CERTS=/var/tmp/kiteline-dev/caddy/caddy/pki/authorities/local/root.crt
export KITELINE_AGENT_HOME=/var/tmp/kiteline-dev/agent
pnpm agent bind --server https://localhost:8443
pnpm agent run
```

正式部署的 server 直接提供 HTTP，由用户反代提供最终 HTTPS，见[安装与运行](deploy/README.md#server-与已有-https-反代)。密码恢复需先停止 server，再以相同 `KITELINE_DATA_DIR` 运行 `pnpm server reset-password`，完成后重新启动。原生组件及构建身份位于 `dist/native/`；临时编译目录和包缓存使用 `/var/tmp`。

## 访问设备上的开发服务

选定设备后，顶栏地球图标可输入端口，打开时读取一次监听端口建议。终端中的 `http://localhost:端口/` 链接可直接打开；手机选中完整链接后也有访问动作。服务需监听 agent 所在环境的 loopback 或 wildcard 地址。

默认入口剥离代理前缀。Vite 项目使用“保留路径”，将项目 `base` 设置为复制地址中的 `/absproxy/<deviceId>/<port>/`，`server.allowedHosts` 加入工作台实际域名；默认 HMR 沿此地址使用 WSS。根相对 API、应用登录回调等仍需项目自身配置。

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

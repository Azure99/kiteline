# Kiteline

单人自托管的 Linux 远程工作台。

## 从源码开发

开发环境使用 Node 24.20.0 和 pnpm 11.25.0。Ubuntu 原生组件构建需要 `build-essential pkg-config libevent-dev libncurses-dev ncurses-term bison curl patch`，运行设备工具还需要 Git 2.43+、ripgrep 14+ 和 Shell。

```sh
pnpm install
pnpm native:build
pnpm build
KITELINE_DATA_DIR=/var/tmp/kiteline-dev/server KITELINE_PUBLIC_URL=https://localhost:8443 pnpm dev
```

`dev` 编译并监听 TypeScript，启动 server 与 Vite，退出时关闭启动的进程。浏览器登录要求同源 HTTPS；在另一个终端启动开发代理：

```sh
docker run --rm --name kiteline-dev-caddy --network host \
  -v "$PWD/deploy/Caddyfile.dev:/etc/caddy/Caddyfile:ro" \
  -v /var/tmp/kiteline-dev/caddy:/data caddy:2.10.2
```

打开 https://localhost:8443，信任本地开发证书，使用 server 控制台的初始化凭据设置密码。设备列表可生成绑定码；设备端使用相同的测试根证书和独立状态目录：

```sh
export NODE_EXTRA_CA_CERTS=/var/tmp/kiteline-dev/caddy/caddy/pki/authorities/local/root.crt
export KITELINE_AGENT_HOME=/var/tmp/kiteline-dev/agent
pnpm agent bind --server https://localhost:8443
pnpm agent run
```

正式公网部署使用真实 HTTPS 证书。密码恢复需先停止 server，再以相同 `KITELINE_DATA_DIR` 运行 `pnpm server reset-password`，完成后重新启动。原生组件及构建身份位于 `dist/native/`；临时编译目录和包缓存使用 `/var/tmp`。

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

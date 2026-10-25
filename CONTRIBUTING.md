# 贡献指南

提交改动前请先运行：

```sh
npm ci --ignore-scripts
npm test
npm run check
```

请保持服务端、连接程序和手机页面的协议兼容，并在涉及数据边界、设备权限或附件处理时补充测试。

不要提交 `.data/`、`.env`、`data/`、日志、真实会话、附件或任何设备令牌。

current_phase: 收尾·完成

已修复捕获脚本在缺少 crypto.randomUUID 的 frame 中初始化失败的问题。

- 根因：8222 的三星标签页内，一个第三方 iframe 加载失败并进入 chrome-error://chromewebdata/；该上下文没有 randomUUID，但有 getRandomValues。
- 变更：页面和元素标识统一在 randomUUID 不可用时用 getRandomValues 生成 UUID v4。
- 验证：修复前新增测试复现失败；修复后全部 28 项测试、前端构建通过；同一浏览器错误 frame 中直接注入、元素注册、重复注册和清理通过。
- 未运行 cargo run；Rust 内嵌脚本需重新编译并启动应用后生效。
